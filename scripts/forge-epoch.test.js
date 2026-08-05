#!/usr/bin/env node
// Standalone contract suite for forge-epoch.js.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EPOCH_LABEL_RE,
  dateOfUnit,
  isWrapperDir,
  listWrapperDirs,
} = require('./forge-epoch.js');

const mod = require('./forge-epoch.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error: error.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEq(actual, expected, message) {
  const received = JSON.stringify(actual);
  const wanted = JSON.stringify(expected);
  if (received !== wanted) {
    throw new Error(`${message || 'mismatch'}\n     expected: ${wanted}\n     actual:   ${received}`);
  }
}

function sandbox(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-epoch-test-'));
  try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

console.log('\n=== forge-epoch.js — epoch contract suite ===\n');

console.log('Section 1: legacy quarter label recognition\n');
test('epoch label expression is strict', () => {
  assert(EPOCH_LABEL_RE.test('2026-Q1'), 'valid label should match');
  assert(!EPOCH_LABEL_RE.test('2026-Q5'), 'invalid quarter should not match');
  assert(!EPOCH_LABEL_RE.test('26-Q1'), 'short year should not match');
  assert(!EPOCH_LABEL_RE.test('2026-q1'), 'lowercase quarter should not match');
});
test('no label-generation function is exported anymore', () => {
  assertEq(typeof mod.epochOf, 'undefined');
  assertEq(typeof mod.compareEpochs, 'undefined');
  assertEq(typeof mod.sealedEpochs, 'undefined');
});

console.log('Section 2: unit date resolution chain\n');
test('timestamp ID wins and reports id source', () => {
  const result = dateOfUnit({ id: 'M-20260214112233-feature' });
  assertEq(result.source, 'id');
  assertEq(result.date.toISOString(), '2026-02-14T11:22:33.000Z');
});
test('legacy ID falls back to dateHint', () => {
  const result = dateOfUnit({ id: 'M005', dateHint: '2026-04-01T00:00:00Z' });
  assertEq(result.source, 'hint');
  assertEq(result.date.toISOString(), '2026-04-01T00:00:00.000Z');
});
test('mtime is consulted only after id and hint', () => sandbox(root => {
  const file = path.join(root, 'unit.md');
  fs.writeFileSync(file, 'unit');
  const stamp = new Date('2026-10-01T00:00:00Z');
  fs.utimesSync(file, stamp, stamp);
  const result = dateOfUnit({ id: 'TASK-001', path: file });
  assertEq(result.source, 'mtime');
  assertEq(result.date.toISOString(), '2026-10-01T00:00:00.000Z');
}));
test('unresolved unit reports null source', () =>
  assertEq(dateOfUnit({ id: 'TASK-001' }), { date: null, source: null }));

console.log('Section 4: wrapper directories\n');
test('one file and no subdirectory is a wrapper', () => sandbox(root => {
  const dir = path.join(root, 'one');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'unit.md'), 'unit');
  assertEq(isWrapperDir(dir), true);
}));
test('two files are not a wrapper', () => sandbox(root => {
  const dir = path.join(root, 'two');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a'), 'a');
  fs.writeFileSync(path.join(dir, 'b'), 'b');
  assertEq(isWrapperDir(dir), false);
}));
test('one file plus one subfolder is not a wrapper', () => sandbox(root => {
  const dir = path.join(root, 'nested');
  fs.mkdirSync(path.join(dir, 'child'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'unit.md'), 'unit');
  assertEq(isWrapperDir(dir), false);
}));
test('missing directory degrades to false and empty list', () => sandbox(root => {
  const missing = path.join(root, 'missing');
  assertEq(isWrapperDir(missing), false);
  assertEq(listWrapperDirs(missing), []);
}));
test('listWrapperDirs returns name, path, and file sorted by name', () => sandbox(root => {
  for (const name of ['zeta', 'alpha']) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'content'), name);
  }
  fs.mkdirSync(path.join(root, 'not-wrapper'));
  fs.writeFileSync(path.join(root, 'not-wrapper', 'a'), 'a');
  fs.writeFileSync(path.join(root, 'not-wrapper', 'b'), 'b');
  const listed = listWrapperDirs(root);
  assertEq(listed.map(item => item.name), ['alpha', 'zeta']);
  assertEq(listed.map(item => path.basename(item.file)), ['content', 'content']);
}));

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  ✗ ${failure.name}\n      ${failure.error}`);
}
process.exit(failed > 0 ? 1 : 0);
