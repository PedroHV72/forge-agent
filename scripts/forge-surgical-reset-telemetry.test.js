#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'forge-surgical-reset.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reset-telemetry-'));
const stateFile = path.join(root, 'state.json');
const original = {
  attempt: 2,
  start_sha: '0123456789abcdef',
  pre_dirty: [{ path: 'kept.txt', hash: 'abc' }],
  reason: '',
  result_file: '',
  code_dir: root,
  transient_retry_count: 0,
};

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

try {
  test('state-update persists a safe per-call dispatch ID without dropping reset state', () => {
    fs.writeFileSync(stateFile, JSON.stringify(original), 'utf8');
    const result = run([
      '--state-update', '--state', stateFile,
      '--dispatch-id', 'xllm-execute-1720000000000-a1b2c3d4e5',
      '--transient-retry-count', '1',
    ]);
    assert.strictEqual(result.status, 0, result.stderr);
    const updated = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(updated.dispatch_id, 'xllm-execute-1720000000000-a1b2c3d4e5');
    assert.strictEqual(updated.transient_retry_count, 1);
    assert.strictEqual(updated.start_sha, original.start_sha);
    assert.deepStrictEqual(updated.pre_dirty, original.pre_dirty);
  });

  test('state-update rejects unsafe dispatch IDs and leaves state unchanged', () => {
    fs.writeFileSync(stateFile, JSON.stringify(original), 'utf8');
    const before = fs.readFileSync(stateFile, 'utf8');
    const result = run(['--state-update', '--state', stateFile, '--dispatch-id', '../escape']);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /dispatch-id must be/);
    assert.strictEqual(fs.readFileSync(stateFile, 'utf8'), before);
  });

  test('read-only state init serializes quoted and Windows-style paths atomically', () => {
    const codeDir = 'C:\\repo\\with "quotes"';
    const resultFile = 'C:\\Temp\\result "one".json';
    const contextFile = 'C:\\Temp\\context\\slice.md';
    const result = run([
      '--state-init-read-only', '--state', stateFile,
      '--cwd', codeDir,
      '--attempt', '3',
      '--result-file', resultFile,
      '--ctx-file', contextFile,
    ]);
    assert.strictEqual(result.status, 0, result.stderr);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepStrictEqual(state, {
      attempt: 3,
      reason: '',
      result_file: resultFile,
      code_dir: codeDir,
      ctx_file: contextFile,
      transient_retry_count: 0,
    });
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, 0 failed\n`);
