#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const memory = require('./forge-memory');
const { serializeGroup } = require('./forge-grouped-file');
const rewrite = require('./forge-memory-rewrite');

const { rewriteFragment, detectEol, applyEol, REWRITE_REFUSALS, _private } = rewrite;
const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function withTemp(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-rewrite-test-'));
  try {
    return fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function fragment(facts) {
  return {
    unit_id: 'T01',
    facts: facts || [
      fact('MEM001', 'first fact', { confidence: 0.8 }),
      fact('MEM002', 'second fact', { hits: 2 }),
    ],
    stats: [{ kind: 'seed', mem_id: 'MEM001', ts: '2026-08-01T00:00:00.000Z' }],
    body: 'A canonical body.',
  };
}

function fact(memId, text, extra) {
  return {
    mem_id: memId,
    category: 'pattern',
    text,
    created_at: '2026-08-01T00:00:00.000Z',
    source_unit: 'execute-task/T01',
    extra_metadata: JSON.stringify(extra || {}),
  };
}

function serialize(value) {
  return _private.serializedFragment(value);
}

function memoryPath(cwd, name) {
  const directory = path.join(cwd, '.gsd', 'memory');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, name || 'T01.md');
}

// Runtime-only fixtures deliberately live in the test's temporary store.  No
// CRLF fixture is checked into the repository, avoiding autocrlf interference.
function writeLoose(cwd, eol, value) {
  const file = memoryPath(cwd);
  fs.writeFileSync(file, applyEol(serialize(value || fragment()), eol), 'utf8');
  return file;
}

function bytes(file) {
  return fs.readFileSync(file);
}

function assertRefusal(result, reason, file, before) {
  assert.deepStrictEqual(result, { ok: false, reason, path: file || null });
  assert(REWRITE_REFUSALS.includes(result.reason), `${reason} must be a closed refusal`);
  if (before) assert(bytes(file).equals(before), `${reason} must not mutate the target`);
}

const PREVIOUS_MEMORY_EXPORTS = [
  'MEMORY_DIR', 'memoryDir', 'fragmentPath', 'qualifiedStorageKey',
  'parseStorageKey', 'parseFragment', 'writeFragment', 'readFragment',
  'readFragmentText', 'listFragments', 'validateUnitId', 'validateMilestoneId',
  'queryRelevant', 'ASK_ID_RE',
];

console.log('\n=== forge-memory-rewrite regression suite ===\n');

test('detectEol distinguishes LF, CRLF, mixed, and terminator-free input', () => {
  assert.strictEqual(detectEol('one\ntwo\n'), 'lf');
  assert.strictEqual(detectEol('one\r\ntwo\r\n'), 'crlf');
  assert.strictEqual(detectEol('one\r\ntwo\n'), 'mixed');
  assert.strictEqual(detectEol('one\rtwo'), 'mixed');
  assert.strictEqual(detectEol('one'), 'lf');
  assert.strictEqual(applyEol('one\r\ntwo\rthree', 'lf'), 'one\ntwo\nthree');
  assert.strictEqual(applyEol('one\ntwo', 'crlf'), 'one\r\ntwo');
});

test('exports serializeFrontmatter additively without removing forge-memory exports', () => {
  const exported = Object.keys(memory);
  for (const name of PREVIOUS_MEMORY_EXPORTS) assert(exported.includes(name), `${name} was removed`);
  assert.strictEqual(typeof memory.serializeFrontmatter, 'function');
});

test('the public rewrite surface remains explicit and the internals are namespaced', () => {
  assert.strictEqual(typeof rewriteFragment, 'function');
  assert.strictEqual(typeof detectEol, 'function');
  assert.strictEqual(typeof applyEol, 'function');
  assert.strictEqual(typeof rewrite._private.normalizeEol, 'function');
  assert.strictEqual(typeof rewrite._private.atomicWrite, 'function');
});

// Both spellings use the same canonical source.  This makes an EOL regression
// a behavioral difference, rather than an accidental fixture-format change.
// Runtime construction also prevents repository checkout EOL settings from
// changing the meaning of either specimen.
for (const eol of ['lf', 'crlf']) {
  test(`removes one addressed fact and preserves live ${eol.toUpperCase()} spelling`, () => withTemp(cwd => {
    const file = writeLoose(cwd, eol);
    const before = bytes(file);
    const result = rewriteFragment(cwd, { storageKey: 'T01', dropMemIds: ['MEM001'] });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.eol, eol);
    assert.deepStrictEqual(result.removed, ['MEM001']);
    assert.strictEqual(result.path, file);
    assert.strictEqual(detectEol(fs.readFileSync(file, 'utf8')), eol);
    assert(!bytes(file).equals(before), 'the requested deletion must change the file');
    const after = memory.parseFragment(fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n'));
    assert.deepStrictEqual(after.facts.map(item => item.mem_id), ['MEM002']);
    assert.strictEqual(result.bytes_before, before.length);
    assert.strictEqual(result.bytes_after, bytes(file).length);
  }));
}

test('refuses a mixed-EOL live fragment before parsing or mutation', () => withTemp(cwd => {
  const file = writeLoose(cwd, 'lf');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('\n', '\r\n'), 'utf8');
  const before = bytes(file);
  assertRefusal(rewriteFragment(cwd, { storageKey: 'T01', dropMemIds: ['MEM001'] }), 'mixed-eol', file, before);
}));

test('refuses a non-canonical fragment before a requested deletion', () => withTemp(cwd => {
  const file = writeLoose(cwd, 'lf');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('category: pattern', 'category:    pattern'), 'utf8');
  const before = bytes(file);
  assertRefusal(rewriteFragment(cwd, { storageKey: 'T01', dropMemIds: ['MEM001'] }), 'non-canonical-fragment', file, before);
}));

test('refuses a grouped survivor and does not touch its physical container', () => withTemp(cwd => {
  const file = memoryPath(cwd, 'sweep-project-01.md');
  const group = serializeGroup({
    label: '2026-Q3',
    units: [{ id: 'T01', content: Buffer.from(serialize(fragment()), 'utf8') }],
  });
  assert.deepStrictEqual(group.skipped, []);
  fs.writeFileSync(file, group.buffer);
  const before = bytes(file);
  assertRefusal(rewriteFragment(cwd, { storageKey: 'T01', dropMemIds: ['MEM001'] }), 'grouped-survivor', file, before);
}));

test('compound addressing refuses a mem_id absent from this fragment', () => withTemp(cwd => {
  const file = writeLoose(cwd, 'lf');
  const before = bytes(file);
  assertRefusal(rewriteFragment(cwd, { storageKey: 'T01', dropMemIds: ['MEM999'] }), 'unknown-fact', file, before);
}));

test('refuses an attempt to empty the fragment', () => withTemp(cwd => {
  const file = writeLoose(cwd, 'lf');
  const before = bytes(file);
  assertRefusal(
    rewriteFragment(cwd, { storageKey: 'T01', dropMemIds: ['MEM001', 'MEM002'] }),
    'would-empty-fragment', file, before,
  );
}));

test('keeps every field of remaining facts deeply identical', () => withTemp(cwd => {
  const source = fragment([
    fact('MEM001', 'to remove', { nested: true }),
    { ...fact('MEM002', 'to keep', { stable: true }), custom_field: 'unchanged' },
    { ...fact('MEM003', 'also keep'), another_extra: 'also unchanged' },
  ]);
  const file = writeLoose(cwd, 'crlf', source);
  const expected = JSON.parse(JSON.stringify(source.facts.slice(1)));
  const result = rewriteFragment(cwd, { storageKey: 'T01', dropMemIds: ['MEM001'] });
  assert.strictEqual(result.ok, true);
  const persisted = memory.parseFragment(fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n'));
  assert.deepStrictEqual(persisted.facts, expected);
  const withoutRemoved = serialize({ ...source, facts: expected });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), applyEol(withoutRemoved, 'crlf'));
}));

test('a failed atomic rename returns a named refusal and retains original bytes', () => withTemp(cwd => {
  const file = writeLoose(cwd, 'lf');
  const before = bytes(file);
  const failingFs = { ...fs, renameSync() { throw new Error('simulated rename failure'); } };
  assertRefusal(
    rewriteFragment(cwd, { storageKey: 'T01', dropMemIds: ['MEM001'] }, { fs: failingFs }),
    'write-failed', file, before,
  );
}));

test('every observed refusal is in the exported closed set and includes a path', () => withTemp(cwd => {
  const missing = rewriteFragment(cwd, { storageKey: 'T01', dropMemIds: ['MEM001'] });
  assert.strictEqual(missing.path, null);
  assert(REWRITE_REFUSALS.includes(missing.reason));
  const file = writeLoose(cwd, 'lf');
  const invalid = rewriteFragment(cwd, { storageKey: 'T01', dropMemIds: [] });
  assert.strictEqual(invalid.path, file);
  assert(REWRITE_REFUSALS.includes(invalid.reason));
  assert.deepStrictEqual([...REWRITE_REFUSALS].sort(), [...new Set(REWRITE_REFUSALS)].sort());
}));

for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${error.stack || error.message}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
