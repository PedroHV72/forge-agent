#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const reset = require('./forge-surgical-reset');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reset-boundary Ω '));
function git(cwd, args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false }); assert.strictEqual(result.status, 0, result.stderr); }
function repo(name) {
  const cwd = path.join(root, name); fs.mkdirSync(cwd, { recursive: true }); git(cwd, ['init']); git(cwd, ['config', 'user.email', 'forge@example.invalid']); git(cwd, ['config', 'user.name', 'Forge Test']);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'base\n'); git(cwd, ['add', 'tracked.txt']); git(cwd, ['commit', '-m', 'base']); return cwd;
}
try {
  const cwd = repo('repo safe'); const stateFile = path.join(root, 'attempt-safe.json');
  fs.writeFileSync(path.join(cwd, 'operator.txt'), 'operator dirty\n');
  const state = reset.initState(stateFile, { cwd, attempt: 'dispatch-1' });
  assert.strictEqual(state.start_sha.length > 6, true); assert(Array.isArray(state.pre_dirty));
  fs.writeFileSync(path.join(cwd, 'sidecar.txt'), 'untrusted\n');
  const refusedRead = reset.resetFailedAttempt(stateFile, { mode: 'plan', failed: true, codeDir: cwd, repoRoots: [cwd] });
  assert.strictEqual(refusedRead.reason_code, 'reset-refused-read-only'); assert(fs.existsSync(path.join(cwd, 'sidecar.txt')));
  const done = reset.resetFailedAttempt(stateFile, { mode: 'execute', failed: true, codeDir: cwd, repoRoots: [cwd] });
  assert.strictEqual(done.reason_code, 'reset-verified'); assert.strictEqual(fs.existsSync(path.join(cwd, 'sidecar.txt')), false); assert.strictEqual(fs.readFileSync(path.join(cwd, 'operator.txt'), 'utf8'), 'operator dirty\n');

  const overlapRepo = repo('repo overlap'); const overlapState = path.join(root, 'attempt-overlap.json');
  fs.writeFileSync(path.join(overlapRepo, 'operator.txt'), 'before\n'); reset.initState(overlapState, { cwd: overlapRepo, attempt: 'dispatch-2' });
  fs.writeFileSync(path.join(overlapRepo, 'operator.txt'), 'sidecar overlap\n'); fs.writeFileSync(path.join(overlapRepo, 'sidecar.txt'), 'keep on abort\n');
  const overlap = reset.resetFailedAttempt(overlapState, { mode: 'execute', failed: true, codeDir: overlapRepo, repoRoots: [overlapRepo] });
  assert.strictEqual(overlap.reason_code, 'reset-overlap'); assert.strictEqual(fs.existsSync(path.join(overlapRepo, 'sidecar.txt')), true); assert.strictEqual(fs.readFileSync(path.join(overlapRepo, 'operator.txt'), 'utf8'), 'sidecar overlap\n');
  assert.strictEqual(reset.resetFailedAttempt(overlapState, { mode: 'execute', failed: true, codeDir: overlapRepo, repoRoots: [overlapRepo, cwd] }).reason_code, 'reset-refused-multirepo');
  assert.strictEqual(reset.resetFailedAttempt(overlapState, { mode: 'execute', failed: false, codeDir: overlapRepo, repoRoots: [overlapRepo] }).reason_code, 'reset-refused-not-failed');
  console.log('forge-surgical-reset boundary tests passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
