#!/usr/bin/env node
'use strict';

// forge-memory-set-guard.test.js — standalone coverage for the mem_id SET
// comparison instrument.
//
// Central fixture: equal-length before/after snapshots where the before
// snapshot's mem_id values are entirely absent from the after snapshot, and
// the after snapshot's equal length is filled by two newly observed
// identifiers repeated across its ten records. `before.length === after.length`
// holds throughout, so a length-only predicate reports success (proved as a
// local positive control) while the set instrument reports every one of the
// ten removed identifiers by name.
//
// This suite states only that facts disappeared from the before/after
// comparison. The sequence that produces such a pair was NOT determined.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-memory-set-guard.js');
const { checkMemIdSet } = require('./forge-memory-set-guard.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  FAIL - ${name}`);
    console.log(`      ${e.message}`);
  }
}

function factsWithIds(ids) {
  return ids.map((id) => ({ mem_id: id }));
}

// ── identical sets ──────────────────────────────────────────────────────
test('identical before/after mem_id sets return ok:true and removed:[]', () => {
  const before = factsWithIds(['A', 'B', 'C']);
  const after = factsWithIds(['A', 'B', 'C']);
  const result = checkMemIdSet(before, after);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.removed, []);
  assert.strictEqual(result.before_count, 3);
  assert.strictEqual(result.after_count, 3);
});

// ── additions only ──────────────────────────────────────────────────────
test('additions without removals remain ok:true', () => {
  const before = factsWithIds(['A', 'B']);
  const after = factsWithIds(['A', 'B', 'C', 'D']);
  const result = checkMemIdSet(before, after);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.removed, []);
  assert.strictEqual(result.after_count, 4);
});

// ── removal output exact names, deterministic order ─────────────────────
test('removal output contains exact names in deterministic sorted order', () => {
  const before = factsWithIds(['Z', 'A', 'M']);
  const after = factsWithIds(['A']);
  const result = checkMemIdSet(before, after);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.removed, ['M', 'Z']);
});

// ── duplicates do not distort counts or membership ──────────────────────
test('duplicate records do not change unique set counts or removal membership', () => {
  const before = factsWithIds(['A', 'A', 'B', 'B', 'B']);
  const after = factsWithIds(['A', 'A']);
  const result = checkMemIdSet(before, after);
  assert.strictEqual(result.before_count, 2);
  assert.strictEqual(result.after_count, 1);
  assert.deepStrictEqual(result.removed, ['B']);
});

// ── invalid API inputs rejected by name ──────────────────────────────────
test('non-array before is rejected by name', () => {
  assert.throws(() => checkMemIdSet({}, []), /before must be an array/);
});

test('non-array after is rejected by name', () => {
  assert.throws(() => checkMemIdSet([], 'nope'), /after must be an array/);
});

test('entry missing mem_id is rejected by name', () => {
  assert.throws(() => checkMemIdSet([{ notMemId: 'x' }], []), /before\[0\] must have a non-empty string mem_id/);
});

test('entry with empty-string mem_id is rejected by name', () => {
  assert.throws(() => checkMemIdSet([{ mem_id: '' }], []), /before\[0\] must have a non-empty string mem_id/);
});

// ── central bite fixture ─────────────────────────────────────────────────
test('equal-length snapshot: length-only predicate passes, set instrument reports all ten removed', () => {
  const before = factsWithIds(['MEM001', 'MEM002', 'MEM003', 'MEM004', 'MEM005',
    'MEM006', 'MEM007', 'MEM008', 'MEM009', 'MEM010']);

  // Same array length as before, populated only by two newly observed
  // identifiers repeated across its ten records.
  const afterIds = [];
  for (let i = 0; i < 10; i++) {
    afterIds.push(i % 2 === 0 ? 'MEM011' : 'MEM012');
  }
  const after = factsWithIds(afterIds);

  assert.strictEqual(before.length, after.length, 'fixture precondition: equal array lengths');

  // Local positive control: a length-only predicate, kept local to this test
  // — not part of the production module.
  function lengthOnlyPredicate(b, a) {
    return b.length === a.length;
  }
  assert.strictEqual(lengthOnlyPredicate(before, after), true,
    'positive control: the length-only predicate must report success on this fixture');

  const result = checkMemIdSet(before, after);
  assert.strictEqual(result.ok, false, 'set instrument must report a difference the length check missed');
  assert.strictEqual(result.removed.length, 10);
  assert.deepStrictEqual(result.removed, ['MEM001', 'MEM002', 'MEM003', 'MEM004', 'MEM005',
    'MEM006', 'MEM007', 'MEM008', 'MEM009', 'MEM010']);
  assert.ok(!result.removed.includes('MEM011'));
  assert.ok(!result.removed.includes('MEM012'));
});

// ── CLI: valid input ──────────────────────────────────────────────────────
test('CLI: valid input emits exactly one JSON line and exits 0 even with removals', () => {
  const payload = JSON.stringify({
    before: factsWithIds(['A', 'B', 'C']),
    after: factsWithIds(['A']),
  });
  const res = spawnSync(process.execPath, [MODULE], { input: payload, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`);
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, 'CLI must emit exactly one JSON line');
  const parsed = JSON.parse(lines[0]);
  assert.strictEqual(parsed.ok, false);
  assert.deepStrictEqual(parsed.removed, ['B', 'C']);
});

test('CLI: identical snapshots exit 0 with ok:true', () => {
  const payload = JSON.stringify({
    before: factsWithIds(['A']),
    after: factsWithIds(['A']),
  });
  const res = spawnSync(process.execPath, [MODULE], { input: payload, encoding: 'utf8' });
  assert.strictEqual(res.status, 0);
  const parsed = JSON.parse(res.stdout.trim());
  assert.strictEqual(parsed.ok, true);
});

// ── CLI: malformed input ───────────────────────────────────────────────────
test('CLI: malformed JSON on stdin exits 2 with no success envelope on stdout', () => {
  const res = spawnSync(process.execPath, [MODULE], { input: '{not valid json', encoding: 'utf8' });
  assert.strictEqual(res.status, 2);
  assert.strictEqual(res.stdout.trim(), '');
});

test('CLI: non-object envelope exits 2 with no success envelope on stdout', () => {
  const res = spawnSync(process.execPath, [MODULE], { input: '[1,2,3]', encoding: 'utf8' });
  assert.strictEqual(res.status, 2);
  assert.strictEqual(res.stdout.trim(), '');
});

test('CLI: malformed snapshot shape (non-array before) exits 2 with no success envelope', () => {
  const payload = JSON.stringify({ before: 'nope', after: [] });
  const res = spawnSync(process.execPath, [MODULE], { input: payload, encoding: 'utf8' });
  assert.strictEqual(res.status, 2);
  assert.strictEqual(res.stdout.trim(), '');
});

test('CLI: invalid mem_id entry exits 2 with no success envelope', () => {
  const payload = JSON.stringify({ before: [{ mem_id: '' }], after: [] });
  const res = spawnSync(process.execPath, [MODULE], { input: payload, encoding: 'utf8' });
  assert.strictEqual(res.status, 2);
  assert.strictEqual(res.stdout.trim(), '');
});

// ── summary ──────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
