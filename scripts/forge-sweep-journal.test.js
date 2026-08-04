#!/usr/bin/env node
// forge-sweep-journal.test.js — standalone test suite for forge-sweep-journal.js
//
// Covers:
//   - probe: clean fixture (ok:true, no line written) and blocked (.gsd/forge is a FILE)
//   - appendIntent + appendOutcome + listEntries round-trip, ids distinct, order preserved
//   - latestUndoable: skips entries with a missing container, falls back to older entry
//   - corrupted line tolerated with stderr warn, listing continues
//   - path-escape vector (../.. and absolute path) is rejected by latestUndoable
//   - anti-content (W3): journal never contains member/fragment bytes
//
// Run: node scripts/forge-sweep-journal.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  journalPath,
  probe,
  appendIntent,
  appendOutcome,
  listEntries,
  latestUndoable,
} = require('./forge-sweep-journal.js');

// ── Test runner boilerplate (mirrors forge-verifier.test.js) ──────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function freshFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-journal-test-'));
}

// Creates a fake "ledger" container inside cwd/.gsd/ledger/<id>.md — a real
// store dir that forge-epoch-group's STORE_TARGETS knows about, so
// latestUndoable's read-side validation accepts it.
function makeLedgerContainer(cwd, id, content) {
  const dir = path.join(cwd, '.gsd', 'ledger');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  fs.writeFileSync(file, content || '# fixture\n', 'utf-8');
  return path.relative(cwd, file).split(path.sep).join('/');
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== forge-sweep-journal.js — pointer-only undo journal ===\n');

// ── Section 1: probe ────────────────────────────────────────────────────────
console.log('Section 1: probe\n');

test('(a) probe on clean fixture → ok:true, journal file exists (empty)', () => {
  const ROOT = freshFixture();
  const result = probe(ROOT);
  assert(result.ok === true, 'probe should succeed on writable fixture');
  assert(fs.existsSync(journalPath(ROOT)), 'journal file should exist after probe');
  const raw = fs.readFileSync(journalPath(ROOT), 'utf-8');
  assert(raw === '', 'probe must not write any line, journal should stay empty');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('(b) probe blocked when .gsd/forge is a FILE → ok:false with error', () => {
  const ROOT = freshFixture();
  fs.mkdirSync(path.join(ROOT, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.gsd', 'forge'), 'not a directory', 'utf-8');
  const result = probe(ROOT);
  assert(result.ok === false, 'probe should fail when .gsd/forge is a file');
  assert(typeof result.error === 'string' && result.error.length > 0, 'error message required');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── Section 2: round-trip ───────────────────────────────────────────────────
console.log('\nSection 2: appendIntent + appendOutcome + listEntries round-trip\n');

test('(c) round-trip: ids distinct, order preserved', () => {
  const ROOT = freshFixture();
  const c1 = makeLedgerContainer(ROOT, 'M001');
  const intent1 = appendIntent(ROOT, { operation: 'group', containers: [c1] });
  assert(intent1.ok === true, 'appendIntent should succeed');
  assert(typeof intent1.id === 'string' && intent1.id.length > 0, 'appendIntent should return an id');

  const outcome1 = appendOutcome(ROOT, { id: intent1.id, phase: 'apply-done', written: [c1] });
  assert(outcome1.ok === true, 'appendOutcome should succeed');

  const c2 = makeLedgerContainer(ROOT, 'M002');
  const intent2 = appendIntent(ROOT, { operation: 'group', containers: [c2] });
  assert(intent2.id !== intent1.id, 'ids should be distinct across calls');

  const listed = listEntries(ROOT);
  assert(listed.ok === true, 'listEntries should succeed');
  assert(listed.entries.length === 3, `expected 3 entries, got ${listed.entries.length}`);
  assert(listed.entries[0].phase === 'apply-intent', 'first entry should be the first intent');
  assert(listed.entries[1].phase === 'apply-done', 'second entry should be the outcome');
  assert(listed.entries[2].id === intent2.id, 'order should be preserved (append-only)');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── Section 3: latestUndoable ───────────────────────────────────────────────
console.log('\nSection 3: latestUndoable\n');

test('(d) latestUndoable falls back to older entry when newest container is gone', () => {
  const ROOT = freshFixture();
  const cOld = makeLedgerContainer(ROOT, 'MOLD');
  const intentOld = appendIntent(ROOT, { operation: 'group', containers: [cOld] });
  appendOutcome(ROOT, { id: intentOld.id, phase: 'apply-done', written: [cOld] });

  const cNew = makeLedgerContainer(ROOT, 'MNEW');
  const intentNew = appendIntent(ROOT, { operation: 'group', containers: [cNew] });
  appendOutcome(ROOT, { id: intentNew.id, phase: 'apply-done', written: [cNew] });

  // Delete the newest container — latestUndoable should fall back to the older one.
  fs.rmSync(path.join(ROOT, cNew));
  const result = latestUndoable(ROOT);
  assert(result.ok === true, 'latestUndoable should succeed');
  assert(result.entry && result.entry.id === intentOld.id, 'should fall back to the older apply-done entry');

  // Delete the old container too — no undoable entry remains.
  fs.rmSync(path.join(ROOT, cOld));
  const result2 = latestUndoable(ROOT);
  assert(result2.ok === true, 'latestUndoable should still succeed');
  assert(result2.entry === null, 'entry should be null when no container survives');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('journal empty/absent → latestUndoable returns entry:null, ok:true', () => {
  const ROOT = freshFixture();
  const result = latestUndoable(ROOT);
  assert(result.ok === true, 'latestUndoable on absent journal should still be ok');
  assert(result.entry === null, 'entry should be null on empty/absent journal');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── Section 4: corrupted line tolerance ─────────────────────────────────────
console.log('\nSection 4: corrupted line tolerance\n');

test('(e) garbage line in the middle is skipped with stderr warn, listing continues', () => {
  const ROOT = freshFixture();
  const c1 = makeLedgerContainer(ROOT, 'MGOOD1');
  appendIntent(ROOT, { operation: 'group', containers: [c1] });

  fs.appendFileSync(journalPath(ROOT), 'not valid json at all {{{\n', 'utf-8');

  const c2 = makeLedgerContainer(ROOT, 'MGOOD2');
  appendIntent(ROOT, { operation: 'group', containers: [c2] });

  const originalWrite = process.stderr.write;
  let sawWarn = false;
  process.stderr.write = (chunk, ...rest) => {
    if (String(chunk).includes('forge-sweep-journal') && String(chunk).includes('corrupted')) sawWarn = true;
    return originalWrite.call(process.stderr, chunk, ...rest);
  };
  const listed = listEntries(ROOT);
  process.stderr.write = originalWrite;

  assert(listed.ok === true, 'listEntries should succeed despite corrupted line');
  assert(listed.entries.length === 2, `expected 2 valid entries, got ${listed.entries.length}`);
  assert(sawWarn === true, 'a stderr warning should have been emitted for the corrupted line');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── Section 5: path-escape vector (Security Checklist) ─────────────────────
console.log('\nSection 5: path-escape vector\n');

test('latestUndoable rejects a relative traversal path (../../evil.md)', () => {
  const ROOT = freshFixture();
  // Simulate a tampered journal line pointing outside any known store.
  const evilRel = '../../evil.md';
  const evilAbs = path.resolve(ROOT, evilRel);
  fs.mkdirSync(path.dirname(evilAbs), { recursive: true });
  fs.writeFileSync(evilAbs, 'not supposed to be reachable', 'utf-8');

  const intent = appendIntent(ROOT, { operation: 'group', containers: [] });
  // Hand-craft the outcome line directly to bypass write-side normalization,
  // simulating a journal that was tampered with or corrupted on disk.
  fs.appendFileSync(
    journalPath(ROOT),
    JSON.stringify({ id: intent.id, ts: '20260101000000', phase: 'apply-done', containers: [evilRel] }) + '\n',
    'utf-8'
  );

  const result = latestUndoable(ROOT);
  assert(result.ok === true, 'latestUndoable should still succeed');
  assert(result.entry === null, 'a traversal-path entry must be treated as unresolvable, never trusted');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('latestUndoable rejects an absolute path container', () => {
  const ROOT = freshFixture();
  const absoluteElsewhere = path.join(os.tmpdir(), 'forge-sweep-journal-absolute-target.md');
  fs.writeFileSync(absoluteElsewhere, 'reachable via absolute path?', 'utf-8');

  const intent = appendIntent(ROOT, { operation: 'group', containers: [] });
  fs.appendFileSync(
    journalPath(ROOT),
    JSON.stringify({ id: intent.id, ts: '20260101000000', phase: 'apply-done', containers: [absoluteElsewhere] }) + '\n',
    'utf-8'
  );

  const result = latestUndoable(ROOT);
  assert(result.ok === true, 'latestUndoable should still succeed');
  assert(result.entry === null, 'an absolute-path entry must never be trusted');

  fs.rmSync(absoluteElsewhere, { force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── Section 6: anti-content (W3) ────────────────────────────────────────────
console.log('\nSection 6: anti-content (W3)\n');

test('(f) journal never contains fragment/member bytes', () => {
  const ROOT = freshFixture();
  const sentinel = 'SENTINEL-UNIQUE-FRAGMENT-BYTES-9f3c7a';
  const c1 = makeLedgerContainer(ROOT, 'MSENTINEL', `# fixture\n\n${sentinel}\n`);

  const intent = appendIntent(ROOT, { operation: 'group', containers: [c1] });
  appendOutcome(ROOT, { id: intent.id, phase: 'apply-done', written: [c1] });

  const raw = fs.readFileSync(journalPath(ROOT), 'utf-8');
  assert(!raw.includes(sentinel), 'journal must never contain the sentinel fragment bytes');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── Cleanup and summary ─────────────────────────────────────────────────────

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`      ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
