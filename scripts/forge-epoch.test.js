#!/usr/bin/env node
// Standalone contract suite for forge-epoch.js.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EPOCH_LABEL_RE,
  epochOf,
  compareEpochs,
  sealedEpochs,
  epochOfUnit,
  isWrapperDir,
  listWrapperDirs,
} = require('./forge-epoch.js');

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

console.log('Section 1: epoch labels and quarter boundaries\n');
test('31 March is Q1 in UTC', () =>
  assertEq(epochOf('2026-03-31T23:59:59.000Z'), '2026-Q1'));
test('1 April is Q2 in UTC', () =>
  assertEq(epochOf('2026-04-01T00:00:00.000Z'), '2026-Q2'));
test('31 December is Q4', () =>
  assertEq(epochOf('2026-12-31T23:00:00.000Z'), '2026-Q4'));
test('Date and compact timestamp use UTC', () => {
  assertEq(epochOf(new Date('2026-01-01T00:00:00.000Z')), '2026-Q1');
  assertEq(epochOf('20260101000000'), '2026-Q1');
});
test('invalid date input returns null', () => {
  assertEq(epochOf('not-a-date'), null);
  assertEq(epochOf(new Date('invalid')), null);
});
test('epoch label expression is strict', () => {
  assert(EPOCH_LABEL_RE.test('2026-Q1'), 'valid label should match');
  assert(!EPOCH_LABEL_RE.test('2026-Q5'), 'invalid quarter should not match');
  assert(!EPOCH_LABEL_RE.test('26-Q1'), 'short year should not match');
  assert(!EPOCH_LABEL_RE.test('2026-q1'), 'lowercase quarter should not match');
});
test('epoch comparison follows chronological labels', () => {
  assertEq(compareEpochs('2025-Q4', '2026-Q1'), -1);
  assertEq(compareEpochs('2026-Q1', '2026-Q1'), 0);
  assertEq(compareEpochs('2026-Q2', '2026-Q1'), 1);
});

console.log('Section 2: derived sealing\n');
test('current is the greatest received epoch and earlier epochs seal', () => {
  assertEq(sealedEpochs(['2025-Q4', '2026-Q1', '2026-Q2']), {
    current: '2026-Q2', sealed: ['2025-Q4', '2026-Q1'],
  });
});
test('a single current epoch seals nothing (IN-03)', () => {
  assertEq(sealedEpochs(['2026-Q2']), { current: '2026-Q2', sealed: [] });
});
test('empty and duplicate input remain deterministic', () => {
  assertEq(sealedEpochs([]), { current: null, sealed: [] });
  assertEq(sealedEpochs(['2026-Q1', '2026-Q1']), { current: '2026-Q1', sealed: [] });
});

console.log('Section 3: unit date resolution chain\n');
test('timestamp ID wins and reports id source', () => {
  assertEq(epochOfUnit({ id: 'M-20260214112233-feature' }), {
    epoch: '2026-Q1', source: 'id',
  });
});
test('legacy ID falls back to dateHint', () => {
  assertEq(epochOfUnit({ id: 'M005', dateHint: '2026-04-01T00:00:00Z' }), {
    epoch: '2026-Q2', source: 'hint',
  });
});
test('mtime is consulted only after id and hint', () => sandbox(root => {
  const file = path.join(root, 'unit.md');
  fs.writeFileSync(file, 'unit');
  const stamp = new Date('2026-10-01T00:00:00Z');
  fs.utimesSync(file, stamp, stamp);
  assertEq(epochOfUnit({ id: 'TASK-001', path: file }), {
    epoch: '2026-Q4', source: 'mtime',
  });
}));
test('unresolved unit reports null source', () =>
  assertEq(epochOfUnit({ id: 'TASK-001' }), { epoch: null, source: null }));

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
