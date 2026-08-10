#!/usr/bin/env node
'use strict';

const assert = require('assert');
const adapter = require('./forge-long-workflow-adapter.js');

function fakeOrchestrate() {
  const calls = [];
  return {
    calls,
    api: {
      run(operation, input) {
        calls.push({ operation, input: { ...input } });
        if (operation === 'status') return { outcome: 'completed', reason_code: 'status-ready' };
        return { outcome: 'completed', reason_code: 'unit-selected', unit: { type: 'execute-task', id: 'T01', key: 'execute-task/T01' } };
      },
    },
  };
}

for (const host of ['claude', 'codex']) for (const mode of ['auto', 'task']) {
  const fake = fakeOrchestrate();
  const result = adapter.invoke(host, mode, 'next', { workflow_id: `${host}-${mode}`, milestone: 'M1', session: 'private' }, null, { orchestrate: fake.api });
  assert.strictEqual(result.adapter_runtime, host);
  assert.strictEqual(result.result.host_runtime, host);
  assert.strictEqual(result.result.outcome, 'dispatch_required');
  assert.strictEqual(fake.calls.length, 1);
  assert.strictEqual(fake.calls[0].input.host_runtime, host);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.result.snapshot, 'session'), false);
  assert.strictEqual(JSON.stringify(result).includes('private'), false);
}

const fake = fakeOrchestrate();
const initial = adapter.invoke('claude', 'auto', 'next', { workflow_id: 'fixed-host', milestone: 'M1' }, null, { orchestrate: fake.api });
assert.throws(() => adapter.invoke('codex', 'auto', 'next', { workflow_id: 'fixed-host', milestone: 'M1' }, initial.result.snapshot, { orchestrate: fake.api }), (error) => error.code === 'host-runtime-mismatch');
assert.throws(() => adapter.invoke('other', 'auto', 'next', { workflow_id: 'bad' }, null, { orchestrate: fake.api }), (error) => error.code === 'invalid-host');

let stdout = ''; let stderr = '';
const exit = adapter.main(['--host', 'codex', '--mode', 'auto', '--command', 'status', '--json', '{"workflow_id":"cli","milestone":"M1"}'], (value) => { stdout += value; }, (value) => { stderr += value; });
assert.strictEqual(exit, 0, stderr);
assert.strictEqual(JSON.parse(stdout).adapter_runtime, 'codex');

const source = require('fs').readFileSync(require('path').join(__dirname, 'forge-long-workflow-adapter.js'), 'utf8');
assert.strictEqual(/child_process|\bspawn(?:Sync)?\s*\(/.test(source), false, 'adapter must not spawn');
const executableSource = source.replace(/^\s*\/\/.*$/gm, '');
assert.strictEqual(/modelFamily|worker_engine|forge-dispatch-resolve|forge-xllm/.test(executableSource), false, 'adapter must not choose fallback or worker');
for (const skill of ['forge-auto', 'forge-task']) {
  const content = require('fs').readFileSync(require('path').join(__dirname, '..', 'skills', skill, 'SKILL.md'), 'utf8');
  assert(content.includes('forge-long-workflow-adapter.js'));
  assert(content.includes('shared/forge-lifecycle.md'));
}
console.log('forge-long-workflow-adapter tests passed (Claude/Codex × auto/task)');
