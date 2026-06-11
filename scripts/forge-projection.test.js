#!/usr/bin/env node
// forge-projection.test.js — regression suite for projection rendering.
//
//   Bug: renderLedger emitted fragments in lexicographic id order. With mixed
//   legacy `M###` and timestamp `M-<ts>-<slug>` ids, '-' (0x2D) < '0' (0x30)
//   puts every legacy id after every timestamp id, so a long-completed legacy
//   milestone (e.g. M013) landed as the LAST block of the projected LEDGER.md.
//   forge-dashboard readLedgerTail takes the file tail as "most recent" and
//   showed the stale milestone as "Last completed" no matter how many
//   timestamp milestones closed after it.
//
// Run: node scripts/forge-projection.test.js  (exit 0 = all pass, 1 = fail)

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const projection = require('./forge-projection');
const dashboard  = require('./forge-dashboard');

// ── Harness ───────────────────────────────────────────────────────────────────
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

// ── Fixtures ────────────────────────────────────────────────────────────────────
function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-projection-'));
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

function seedFragment(cwd, id, completedAt, title) {
  const dir = path.join(cwd, '.gsd', 'ledger');
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    ...(completedAt ? [`completed_at: ${completedAt}`] : []),
    `id: ${id}`,
    'slices: [S01]',
    `title: ${title}`,
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, `${id}.md`), fm, 'utf8');
}

function headerOrder(rendered) {
  return rendered.split('\n')
    .map(l => l.match(/^##\s+(\S+)/))
    .filter(Boolean)
    .map(m => m[1]);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== forge-projection — regression suite ===\n');

console.log('renderLedger — chronological ordering with mixed id formats');

test('legacy M### completed first does not sort after timestamp ids', () => {
  const tmp = mkTmp();
  try {
    seedFragment(tmp, 'M013',                        '2025-11-30', 'Legacy milestone');
    seedFragment(tmp, 'M-20260522101500-pagamentos', '2026-05-22', 'Pagamentos');
    seedFragment(tmp, 'M-20260527131143-fix',        '2026-05-27', 'Fix feedback');

    const order = headerOrder(projection.renderLedger(tmp));
    assert(order.length === 3, `expected 3 blocks, got ${order.length}`);
    assert(order[0] === 'M013', `expected M013 first (oldest), got ${order[0]}`);
    assert(order[2] === 'M-20260527131143-fix',
      `expected M-20260527131143-fix last (newest), got ${order[2]}`);
  } finally { rmrf(tmp); }
});

test('fragment without completed_at sorts first (treated as oldest)', () => {
  const tmp = mkTmp();
  try {
    seedFragment(tmp, 'M-20260522101500-pagamentos', '2026-05-22', 'Pagamentos');
    seedFragment(tmp, 'M099', null, 'Sem data');

    const order = headerOrder(projection.renderLedger(tmp));
    assert(order[0] === 'M099', `expected dateless fragment first, got ${order[0]}`);
  } finally { rmrf(tmp); }
});

test('same completed_at falls back to id tiebreaker (deterministic)', () => {
  const tmp = mkTmp();
  try {
    seedFragment(tmp, 'M-20260522101500-b', '2026-05-22', 'B');
    seedFragment(tmp, 'M-20260522093000-a', '2026-05-22', 'A');

    const order = headerOrder(projection.renderLedger(tmp));
    assert(order.join(',') === 'M-20260522093000-a,M-20260522101500-b',
      `unexpected tiebreak order: ${order.join(',')}`);
  } finally { rmrf(tmp); }
});

console.log('\nforge-dashboard — "Last completed" reads newest milestone');

test('dashboard shows newest timestamp milestone, not stale legacy id', () => {
  const tmp = mkTmp();
  try {
    seedFragment(tmp, 'M013',                        '2025-11-30', 'Legacy milestone');
    seedFragment(tmp, 'M-20260527131143-fix',        '2026-05-27', 'Fix feedback');

    fs.writeFileSync(path.join(tmp, '.gsd', 'LEDGER.md'), projection.renderLedger(tmp), 'utf8');

    const rendered = dashboard.render(tmp);
    assert(/Last completed: M-20260527131143-fix/.test(rendered),
      `expected "Last completed: M-20260527131143-fix", got:\n${rendered}`);
    assert(!/Last completed: M013/.test(rendered), 'stale M013 still reported as last completed');
  } finally { rmrf(tmp); }
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL: ${f.name} — ${f.error}`);
  process.exit(1);
}
