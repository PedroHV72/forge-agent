#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const filelock = require('./forge-filelock.js');

function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'forge file lock espaço-測試-')); }
function remove(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function testOwnerScopedLifecycle() {
  const cwd = temporary(); const target = 'dir com espaço/測試.json';
  try {
    const owner = filelock.acquireFileLock(cwd, target, 'run-a', 'session-a', { ttlMs: 5000 });
    assert(owner.acquired && owner.owner_token);
    assert.strictEqual(filelock.releaseFileLock(cwd, target, 'run-a'), false, 'run ID alone is diagnostic, not ownership');
    assert.deepStrictEqual(filelock.renewFileLock(cwd, target, 'wrong', owner.generation), { ok: false, reason: 'owner_mismatch' });
    const renewed = filelock.renewFileLock(cwd, target, owner.owner_token, owner.generation);
    assert.strictEqual(renewed.ok, true);
    assert.strictEqual(filelock.releaseFileLock(cwd, target, 'run-a', owner.owner_token, owner.generation), true);
    assert.strictEqual(filelock.checkFileLock(cwd, target).held, false);
  } finally { remove(cwd); }
}
function testNonOwnerAndABA() {
  const cwd = temporary(); const target = 'same.json';
  try {
    const one = filelock.acquireFileLock(cwd, target, 'one', 's', { ttlMs: 10, now: () => 10 });
    const two = filelock.acquireFileLock(cwd, target, 'two', 's', { ttlMs: 10, now: () => 100 });
    assert(two.acquired && two.stolen);
    assert.strictEqual(filelock.releaseFileLock(cwd, target, 'one', one.owner_token, one.generation), false);
    const publicCheck = filelock.checkFileLock(cwd, target);
    assert.strictEqual(publicCheck.holder.generation, undefined, 'status must not disclose generation');
    assert.strictEqual(publicCheck.holder.owner_token, undefined, 'status must not disclose owner token');
    const privateCheck = filelock.checkFileLock(cwd, target, { ownerToken: two.owner_token, generation: two.generation });
    assert.strictEqual(privateCheck.holder.generation, two.generation, 'owner-scoped proof remains available to the holder');
    assert.strictEqual(filelock.releaseFileLock(cwd, target, 'two', two.owner_token, two.generation), true);
  } finally { remove(cwd); }
}
function testCanonicalPathIdentity() {
  const cwd = temporary();
  try {
    const first = filelock.acquireFileLock(cwd, './src/foo.js', 'run-a', 's-a');
    const denied = filelock.acquireFileLock(cwd, 'src\\foo.js', 'run-b', 's-b');
    assert.strictEqual(denied.acquired, false, 'separator aliases must share one lock');
    assert.strictEqual(filelock.releaseFileLock(cwd, './src/foo.js', 'run-a', first.owner_token, first.generation), true);
  } finally { remove(cwd); }
}
function testFreshOtherOwnerIsBusy() {
  const cwd = temporary(); const target = 'fresh.json';
  try {
    const owner = filelock.acquireFileLock(cwd, target, 'run-a', 's', { ttlMs: 5000 });
    const denied = filelock.acquireFileLock(cwd, target, 'run-b', 's', { ttlMs: 5000 });
    assert.strictEqual(denied.acquired, false);
    assert.strictEqual(denied.reason, 'busy');
    assert.strictEqual(filelock.releaseFileLock(cwd, target, 'run-a', owner.owner_token, owner.generation), true);
  } finally { remove(cwd); }
}
function main() {
  console.log(`forge-filelock tests on ${process.platform}`);
  testOwnerScopedLifecycle();
  testNonOwnerAndABA();
  testFreshOtherOwnerIsBusy();
  testCanonicalPathIdentity();
  console.log('forge-filelock tests passed');
}
try { main(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
