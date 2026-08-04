#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const headless = require('./forge-headless.js');

const fake = path.join(__dirname, 'fixtures', 'hooks-headless', 'fake-jsonl-cli.js');
let passed = 0;
async function test(name, fn) { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function base(root, runtime, scenario = 'success') {
  return { runtime, dispatchId: `dispatch-${runtime}`, workspaceRoot: root, cwd: root, sandbox: 'workspace-write', approval: 'never', binary: { command: process.execPath, args: [fake, scenario] }, prompt: 'PROMPT_SENTINEL', env: { ...process.env, SECRET_TOKEN: 'ENV_SENTINEL' }, timeoutMs: 1500 };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-headless Ω-'));
  try {
    for (const platform of ['win32', 'darwin', 'linux']) {
      await test(`${platform} invocation is argv-only, sandboxed and offline`, async () => {
        const invocation = headless.buildInvocation({ ...base(root, 'codex'), platform, claudeHome: path.join(root, 'absent-claude'), codexHome: path.join(root, 'absent-codex') });
        assert.strictEqual(invocation.command, process.execPath);
        assert.strictEqual(invocation.shell, false);
        assert(invocation.args.includes('--sandbox') && invocation.args.includes('workspace-write'));
        assert(invocation.args.includes('--ask-for-approval') && invocation.args.includes('never'));
        assert(!invocation.args.includes('PROMPT_SENTINEL'));
        assert.strictEqual(invocation.env.SECRET_TOKEN, undefined);
      });
    }
    for (const runtime of ['claude', 'codex']) {
      await test(`${runtime} JSONL success has one normalized terminal`, async () => {
        const result = await headless.run(base(root, runtime));
        assert.strictEqual(result.status, 'succeeded');
        assert.strictEqual(result.events.filter((event) => event.type === 'terminal').length, 1);
        assert(!JSON.stringify(result.events).includes('PROMPT_SENTINEL'));
      });
      await test(`${runtime} malformed and truncated JSONL fail closed`, async () => {
        for (const scenario of ['malformed', 'truncated']) {
          const result = await headless.run(base(root, runtime, scenario));
          assert.strictEqual(result.reason_code, 'output-invalid');
        }
      });
      await test(`${runtime} timeout terminates only the owned child`, async () => {
        const result = await headless.run({ ...base(root, runtime, 'timeout'), timeoutMs: 60 });
        assert.strictEqual(result.reason_code, `${runtime}-timeout`);
      });
      await test(`${runtime} orphan has a terminal S06-style reason`, async () => {
        const result = await headless.run(base(root, runtime, 'orphan'));
        assert.strictEqual(result.reason_code, `${runtime}-orphan`);
      });
      await test(`${runtime} credential sentinel is redacted from result and telemetry`, async () => {
        const result = await headless.run({ ...base(root, runtime, 'secret'), redactValues: ['TOKEN_SENTINEL'] });
        assert(!JSON.stringify(result).includes('TOKEN_SENTINEL'));
        assert(result.output.includes('[REDACTED]'));
      });
    }
    await test('resume and partial usage preserve identity/counters without duplicate events', async () => {
      const resume = await headless.run(base(root, 'codex', 'resume'));
      assert.strictEqual(resume.resume, 'thread-resume');
      const partial = await headless.run(base(root, 'codex', 'partial'));
      assert.deepStrictEqual(partial.usage, { input_tokens: 5, output_tokens: 5, cached_tokens: 0 });
      const parser = new headless.JsonlParser({ runtime: 'codex', dispatchId: 'd' });
      const start = JSON.stringify({ type: 'thread.started', event_id: 'same' });
      parser.push(`${start}\n${start}\n${JSON.stringify({ type: 'turn.completed' })}\n`);
      assert.strictEqual(parser.finish().events.length, 2);
    });
    await test('dispatch/protocol mismatch is output-invalid', async () => {
      const parser = new headless.JsonlParser({ runtime: 'codex', dispatchId: 'expected' });
      assert.throws(() => parser.push(`${JSON.stringify({ protocol_version: '9', dispatch_id: 'other', type: 'start' })}\n`), (error) => error.reason_code === 'output-invalid');
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  process.stdout.write(`\n${passed} passed, 0 failed\n`);
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
