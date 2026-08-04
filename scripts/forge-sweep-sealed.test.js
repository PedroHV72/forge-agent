'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadLedgerIds,
  owningUnitId,
  dateInId,
  isExtinctId,
  sealedBy,
  nextSweepNumber,
  containerName,
} = require('./forge-sweep-sealed');

const ledger = require('./forge-ledger');

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

function mkSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-sealed-'));
}

function rmSandbox(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

function writeLedgerEntry(cwd, id) {
  fs.mkdirSync(path.join(cwd, '.gsd', 'ledger'), { recursive: true });
  ledger.writeFragment(cwd, {
    id,
    title: `fixture ${id}`,
    completed_at: '2026-01-01T00:00:00Z',
    slices: [],
    key_files: [],
    key_decisions: [],
    body: 'fixture body.',
  });
}

// ── loadLedgerIds ────────────────────────────────────────────────────────────

test('loadLedgerIds: degrades to empty Set when .gsd/ledger is absent', () => {
  const cwd = mkSandbox();
  try {
    const ids = loadLedgerIds(cwd);
    assert.ok(ids instanceof Set);
    assert.strictEqual(ids.size, 0);
  } finally {
    rmSandbox(cwd);
  }
});

test('loadLedgerIds: reads real ledger fragment ids', () => {
  const cwd = mkSandbox();
  try {
    writeLedgerEntry(cwd, 'M-20260101000000-fixture');
    const ids = loadLedgerIds(cwd);
    assert.ok(ids.has('M-20260101000000-fixture'));
  } finally {
    rmSandbox(cwd);
  }
});

// ── owningUnitId ─────────────────────────────────────────────────────────────

test('owningUnitId: qualified memory key resolves to owning milestone', () => {
  assert.strictEqual(owningUnitId('M-20260101000000-fixture__S04'), 'M-20260101000000-fixture');
});

test('owningUnitId: top-level id passes through unchanged', () => {
  assert.strictEqual(owningUnitId('M-20260101000000-fixture'), 'M-20260101000000-fixture');
});

test('owningUnitId: unqualified local key passes through unchanged', () => {
  assert.strictEqual(owningUnitId('S02'), 'S02');
});

// ── dateInId ─────────────────────────────────────────────────────────────────

test('dateInId: compact timestamp id yields a Date', () => {
  const date = dateInId('M-20260315120000-fixture');
  assert.ok(date instanceof Date);
  assert.strictEqual(date.getUTCFullYear(), 2026);
  assert.strictEqual(date.getUTCMonth(), 2); // March, 0-indexed
  assert.strictEqual(date.getUTCDate(), 15);
});

test('dateInId: dashed timestamp id yields a Date', () => {
  const date = dateInId('M-20260315-120000-fixture');
  assert.ok(date instanceof Date);
  assert.strictEqual(date.getUTCFullYear(), 2026);
});

test('dateInId: ask-<YYYY-MM-DD> id yields a Date without a ledger entry', () => {
  const date = dateInId('ask-2026-02-14-conversa');
  assert.ok(date instanceof Date);
  assert.strictEqual(date.getUTCMonth(), 1);
  assert.strictEqual(date.getUTCDate(), 14);
});

test('dateInId: ask-<YYYYMMDD> compact form also yields a Date', () => {
  const date = dateInId('ask-20260214-conversa');
  assert.ok(date instanceof Date);
});

test('dateInId: rejects an out-of-range embedded date instead of rolling it over', () => {
  assert.strictEqual(dateInId('ask-9999-99-99-garbage'), null);
});

test('dateInId: plain legacy id with no embeddable date returns null', () => {
  assert.strictEqual(dateInId('S02'), null);
});

// ── isExtinctId (DS9-4, narrowed) ────────────────────────────────────────────

test('isExtinctId: hyphenated legacy key is refused by parseStorageKey → extinct', () => {
  assert.strictEqual(isExtinctId('S03-T02'), true);
});

test('isExtinctId: bare local key is NOT extinct — parseStorageKey accepts it (B1 narrowing)', () => {
  assert.strictEqual(isExtinctId('S02'), false);
});

test('isExtinctId: legacy-orphan sentinel is not treated as extinct by this helper', () => {
  // The legacy-orphan guard in sealedBy() runs before isExtinctId is ever
  // consulted; parseStorageKey() itself special-cases the literal and does
  // not refuse it, so this helper alone reports false. Behaviour of the
  // COMBINED sealedBy() for legacy-orphan is covered separately below.
  assert.strictEqual(isExtinctId('legacy-orphan'), false);
});

// ── sealedBy — the three proofs, in order ────────────────────────────────────

test('sealedBy: proof (a) ledger — entry exists for the owning unit', () => {
  const ledgerIds = new Set(['M-20260101000000-fixture']);
  const result = sealedBy({ id: 'M-20260101000000-fixture__S04' }, { ledgerIds });
  assert.strictEqual(result.groupable, true);
  assert.strictEqual(result.proof, 'ledger');
});

test('sealedBy: proof (b) id-date — ask-* with NO ledger entry (the ask-ask-* case)', () => {
  const result = sealedBy({ id: 'ask-2026-01-05-sem-ledger' }, { ledgerIds: new Set() });
  assert.strictEqual(result.groupable, true);
  assert.strictEqual(result.proof, 'id-date');
  assert.ok(result.date instanceof Date);
});

test('sealedBy: proof (c) extinct-id — hyphenated legacy key with no ledger, no date', () => {
  const result = sealedBy({ id: 'S03-T02' }, { ledgerIds: new Set() });
  assert.strictEqual(result.groupable, true);
  assert.strictEqual(result.proof, 'extinct-id');
});

test('sealedBy: ordering — ledger AND id-date both satisfied still reports "ledger" first', () => {
  const ledgerIds = new Set(['M-20260315120000-fixture']);
  const result = sealedBy({ id: 'M-20260315120000-fixture' }, { ledgerIds });
  assert.strictEqual(result.proof, 'ledger');
});

test('sealedBy: PRECISION — a live unit is refused with a reason, surrounded by eligible ones', () => {
  const ledgerIds = new Set(['M-20260101000000-closed']);
  const eligible1 = sealedBy({ id: 'M-20260101000000-closed' }, { ledgerIds });
  const live = sealedBy({ id: 'M-20260601000000-still-open' }, { ledgerIds });
  const eligible2 = sealedBy({ id: 'ask-2026-01-01-old' }, { ledgerIds });

  assert.strictEqual(eligible1.groupable, true);
  assert.strictEqual(live.groupable, false);
  assert.strictEqual(typeof live.reason, 'string');
  assert.ok(live.reason.length > 0);
  assert.strictEqual(eligible2.groupable, true);
});

test('sealedBy: bare local key (S02) is skipped with a reason, never grouped — B1 narrowing', () => {
  const result = sealedBy({ id: 'S02' }, { ledgerIds: new Set() });
  assert.strictEqual(result.groupable, false);
  assert.strictEqual(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

test('sealedBy: never throws and never returns undefined for a garbage id', () => {
  const result = sealedBy({ id: 'not-a-real-id-at-all-????' }, { ledgerIds: new Set() });
  assert.notStrictEqual(result, undefined);
  assert.strictEqual(typeof result.groupable, 'boolean');
});

test('sealedBy: missing ctx does not throw (empty ledgerIds default)', () => {
  const result = sealedBy({ id: 'S02' }, undefined);
  assert.strictEqual(result.groupable, false);
});

// ── legacy-orphan (DS9-6) — store-agnostic, across the three stores ─────────

test('legacy-orphan: refused, no store info, called the way the LEDGER store would', () => {
  const cwd = mkSandbox();
  try {
    const result = sealedBy({ id: 'legacy-orphan' }, { ledgerIds: loadLedgerIds(cwd) });
    assert.strictEqual(result.groupable, false);
    assert.strictEqual(result.reason, 'legacy-orphan não é agrupável');
  } finally {
    rmSandbox(cwd);
  }
});

test('legacy-orphan: refused, called the way the MEMORY store would', () => {
  const result = sealedBy({ id: 'legacy-orphan' }, { ledgerIds: new Set() });
  assert.strictEqual(result.groupable, false);
  assert.strictEqual(result.reason, 'legacy-orphan não é agrupável');
});

test('legacy-orphan: refused, called the way the DECISIONS store would (ledger has entries, still refused)', () => {
  const ledgerIds = new Set(['M-20260101000000-unrelated']);
  const result = sealedBy({ id: 'legacy-orphan' }, { ledgerIds });
  assert.strictEqual(result.groupable, false);
  assert.strictEqual(result.reason, 'legacy-orphan não é agrupável');
});

// ── nextSweepNumber / containerName ──────────────────────────────────────────

test('nextSweepNumber: empty directory → 1', () => {
  const cwd = mkSandbox();
  try {
    const dir = path.join(cwd, 'store');
    fs.mkdirSync(dir, { recursive: true });
    assert.strictEqual(nextSweepNumber([dir]), 1);
  } finally {
    rmSandbox(cwd);
  }
});

test('nextSweepNumber: missing directory → 1 (never throws)', () => {
  const cwd = mkSandbox();
  try {
    assert.strictEqual(nextSweepNumber([path.join(cwd, 'does-not-exist')]), 1);
  } finally {
    rmSandbox(cwd);
  }
});

test('nextSweepNumber: sweep-project-03 present → 4', () => {
  const cwd = mkSandbox();
  try {
    const dir = path.join(cwd, 'store');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sweep-project-03.md'), 'fixture');
    assert.strictEqual(nextSweepNumber([dir]), 4);
  } finally {
    rmSandbox(cwd);
  }
});

test('nextSweepNumber: legacy 2026-Q1.md container does NOT count toward the max', () => {
  const cwd = mkSandbox();
  try {
    const dir = path.join(cwd, 'store');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sweep-project-03.md'), 'fixture');
    fs.writeFileSync(path.join(dir, '2026-Q1.md'), 'fixture');
    assert.strictEqual(nextSweepNumber([dir]), 4);
  } finally {
    rmSandbox(cwd);
  }
});

test('nextSweepNumber: shared across MULTIPLE store directories (DS9-3) — max wins', () => {
  const cwd = mkSandbox();
  try {
    const dirA = path.join(cwd, 'ledger');
    const dirB = path.join(cwd, 'memory');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'sweep-project-02.md'), 'fixture');
    fs.writeFileSync(path.join(dirB, 'sweep-project-07.md'), 'fixture');
    assert.strictEqual(nextSweepNumber([dirA, dirB]), 8);
  } finally {
    rmSandbox(cwd);
  }
});

test('containerName: zero-pads to 2 digits', () => {
  assert.strictEqual(containerName(1), 'sweep-project-01');
  assert.strictEqual(containerName(99), 'sweep-project-99');
});

test('containerName: grows naturally past 99 without truncation', () => {
  assert.strictEqual(containerName(137), 'sweep-project-137');
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error}`);
  process.exitCode = 1;
} else {
  console.log(`\n${passed} test(s) passed`);
}
