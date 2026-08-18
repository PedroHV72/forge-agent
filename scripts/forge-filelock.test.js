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
// ── classifyHolder: absent vs illegible, and the lock consequence (review R2b) ─────────────────
//
// `runs.get` swallows its own parse failure into `null`, so "no record" and "record I could not
// read" arrive at `classifyHolder` byte-identical. They are NOT the same fact: absent is plausibly
// dead (the clock may reach it), illegible is a question that could not be asked (fail-closed, the
// lock is NOT stolen). The `record-unreadable` branch existed and NOTHING exercised it — a branch
// nobody bites is indistinguishable from a wrong branch. Both directions are asserted here, over
// the real registry layout, and the stale-lock consequence is asserted too — classifying without
// checking what the classification DOES would be an inert test.
function writeRunFile(cwd, id, content) {
  const dir = path.join(cwd, '.gsd', 'forge', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), content, 'utf8');
}
function testHolderAbsentVersusIllegible() {
  const cwd = temporary();
  try {
    // The export the safeguard depends on must actually be there (the objection claimed it was not).
    const runs = require('./forge-runs.js');
    assert.strictEqual(typeof runs.runFile, 'function', 'classifyHolder needs runs.runFile to tell absent from illegible');

    // (a) NO record on disk -> ended / run-not-registered. The clock may reach this holder.
    const absent = filelock.classifyHolder(cwd, 'run-fantasma');
    assert.strictEqual(absent.activity, 'ended');
    assert.strictEqual(absent.reason, 'run-not-registered');
    const staleGhost = filelock.acquireFileLock(cwd, 'alvo-a.json', 'run-fantasma', 's', { ttlMs: 10, now: () => 10 });
    assert.strictEqual(staleGhost.acquired, true);
    const steal = filelock.acquireFileLock(cwd, 'alvo-a.json', 'run-b', 's', { ttlMs: 10, now: () => 100000 });
    assert.strictEqual(steal.acquired, true, 'an unregistered holder is plausibly dead: the clock is allowed to reach it');
    assert.strictEqual(steal.stolen && steal.stolen.reason, 'expired', 'and the steal names the clock as its authorization');

    // (b) record PRESENT but truncated — exactly what a kill mid-write leaves behind.
    writeRunFile(cwd, 'run-truncada', '{"kind":"milestone","id":"run-trunc');
    const illegible = filelock.classifyHolder(cwd, 'run-truncada');
    assert.strictEqual(illegible.activity, 'unmeasured', 'a record that could not be read is never "dead"');
    assert.strictEqual(illegible.reason, 'record-unreadable');
    assert(filelock.HOLDER_ACTIVITY.includes(illegible.activity) && filelock.HOLDER_REASONS.includes(illegible.reason),
      'both come from the closed sets');

    // and the consequence: a STALE lock held by that run is NOT stolen (fail-closed).
    const held = filelock.acquireFileLock(cwd, 'alvo-b.json', 'run-truncada', 's', { ttlMs: 10, now: () => 10 });
    assert.strictEqual(held.acquired, true);
    const denied = filelock.acquireFileLock(cwd, 'alvo-b.json', 'run-c', 's', { ttlMs: 10, now: () => 100000 });
    assert.strictEqual(denied.acquired, false, 'stealing from an UNMEASURED holder is the over-reach this guard exists to refuse');
    assert.strictEqual(denied.reason, 'holder_unmeasured');
    assert.strictEqual(denied.holder.run_diagnostic, 'unmeasured', 'and the caller is told WHY, not just "no"');

    // (c) the same file, now legible and inactive -> ended, and the lock becomes takeable. Proves
    // (b) is about legibility, not about the id.
    writeRunFile(cwd, 'run-truncada', JSON.stringify({ kind: 'milestone', id: 'run-truncada', active: false }));
    assert.strictEqual(filelock.classifyHolder(cwd, 'run-truncada').reason, 'registry-inactive');
    const now = filelock.acquireFileLock(cwd, 'alvo-b.json', 'run-c', 's', { ttlMs: 10, now: () => 200000 });
    assert.strictEqual(now.acquired, true, 'measured-ended + stale is what the clock is FOR');
  } finally { remove(cwd); }
}
function main() {
  console.log(`forge-filelock tests on ${process.platform}`);
  testOwnerScopedLifecycle();
  testNonOwnerAndABA();
  testFreshOtherOwnerIsBusy();
  testCanonicalPathIdentity();
  testHolderAbsentVersusIllegible();
  console.log('forge-filelock tests passed');
}
try { main(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
