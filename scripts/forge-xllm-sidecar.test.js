#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { invokeCodexDetached } = require('./forge-xllm.js');

const fixtureDir = path.join(__dirname, 'fixtures', 'dispatch-security');
const fakeWorker = path.join(fixtureDir, 'fake-sidecar-worker.js');
const vectors = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'sidecar-vectors.json'), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sidecar-e2e Ω '));
const original = {};
const touchedEnv = ['FORGE_XLLM_CODEX_BIN', ...vectors.forbidden_env];
for (const key of touchedEnv) original[key] = process.env[key];

function restoreEnv() {
  for (const key of touchedEnv) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(pid);
}

async function main() {
  try {
    process.env.FORGE_XLLM_CODEX_BIN = fakeWorker;
    for (const key of vectors.forbidden_env) process.env[key] = `secret-${key}`;

    for (const token of vectors.tokens) {
      const request = { mode: 'success', token };
      const raw = await invokeCodexDetached({
        prompt: JSON.stringify(request), schema: { type: 'object' }, cwd: root,
        model: token, timeoutSecs: 5, sandbox: 'read-only', envPolicy: 'minimal',
      });
      const observed = JSON.parse(raw);
      assert.deepStrictEqual(JSON.parse(observed.input), request);
      assert.strictEqual(observed.args[observed.args.indexOf('-m') + 1], token);
      assert.strictEqual(observed.args[observed.args.indexOf('-C') + 1], root);
      assert.strictEqual(observed.args.includes('--sandbox'), true);
      assert.strictEqual(observed.args[observed.args.indexOf('--sandbox') + 1], 'read-only');
      assert.deepStrictEqual(observed.env, { FORGE_XLLM_CODEX_BIN: fakeWorker });
    }

    const pidFile = path.join(root, 'descendant.pid');
    await assert.rejects(invokeCodexDetached({
      prompt: JSON.stringify({ mode: 'timeout', pid_file: pidFile }),
      schema: { type: 'object' }, cwd: root, timeoutSecs: 0.2,
      sandbox: 'read-only', envPolicy: 'minimal',
    }), (error) => error.code === 'process-timeout');
    assert.strictEqual(fs.existsSync(pidFile), true, 'fake worker must expose its descendant pid');
    const descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.strictEqual(await waitForExit(descendantPid), true, `descendant ${descendantPid} survived timeout`);

    console.log(`forge-xllm sidecar e2e passed (${vectors.platforms.join(', ')} vectors; timeout tree cleaned)`);
  } finally {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  restoreEnv();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
