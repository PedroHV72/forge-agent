#!/usr/bin/env node
// forge-evidence-path.test.js — standalone suite for forge-evidence-path.js (S01 T01)
//
// Covers: distinct composite keys → distinct names; adversarial round-trip
// (hyphens in both axes); the 9 real evidence-<milestone>-S## files
// classified as milestone-qualified (unit=S##), NOT slice-qualified —
// precision test against real names, not synthetic ones; the 4 forms each
// named; union across the legacy forms for one spread-out logical unit;
// census reconciliation; anti-silence floor (empty dir never reads clean);
// containment (a `..`/separator payload never escapes the name format).
//
// Run: node scripts/forge-evidence-path.test.js  (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  EVIDENCE_FORMS,
  buildEvidenceFileName,
  parseEvidenceFileName,
  resolveEvidenceFiles,
  censusEvidenceDir,
} = require('./forge-evidence-path.js');

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

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

function mkWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-evidence-path-test-'));
  fs.mkdirSync(path.join(root, '.gsd', 'forge'), { recursive: true });
  return root;
}

function touchEvidence(root, names) {
  for (const n of names) fs.writeFileSync(path.join(root, '.gsd', 'forge', n), '');
}

function registerMilestoneId(root, id) {
  fs.mkdirSync(path.join(root, '.gsd', 'milestones', id), { recursive: true });
}

console.log('\n=== forge-evidence-path.js — S01 T01 ===\n');

// ── Section 1: buildEvidenceFileName — distinct units → distinct files ───────
console.log('Section 1: buildEvidenceFileName\n');

test('two distinct logical units with the same bare unitId produce distinct file names', () => {
  const a = buildEvidenceFileName({ milestone: 'M-A', slice: 'S01', unit: 'T01' });
  const b = buildEvidenceFileName({ milestone: 'M-B', slice: 'S02', unit: 'T01' });
  assert(a !== b, `expected distinct names, got ${a} === ${b}`);
});

test('build is deterministic for the same input', () => {
  const a = buildEvidenceFileName({ milestone: 'M-A', slice: 'S01', unit: 'T01' });
  const b = buildEvidenceFileName({ milestone: 'M-A', slice: 'S01', unit: 'T01' });
  assertEq(a, b);
});

test('composite name uses the reserved delimiter and never a bare hyphen join', () => {
  const name = buildEvidenceFileName({ milestone: 'M-A', slice: 'S01', unit: 'T01' });
  assert(name.startsWith('evidence~'), `expected evidence~ prefix, got ${name}`);
});

test('an absent milestone/slice axis resolves to the named sentinel, never an empty splice', () => {
  const name = buildEvidenceFileName({ unit: 'T01' });
  assert(!name.includes('evidence~~'), `empty axis spliced in: ${name}`);
  const parsed = parseEvidenceFileName(name);
  assertEq(parsed.form, 'composite');
  assertEq(parsed.milestone, null);
  assertEq(parsed.slice, null);
  assertEq(parsed.unit, 'T01');
});

// ── Section 2: adversarial round-trip ─────────────────────────────────────────
console.log('\nSection 2: round-trip\n');

test('round-trips a composite name when milestone AND unit contain hyphens', () => {
  const milestone = 'M-20260813133328-lease-escrita-cross-run';
  const unit = 'T-20260812195458-gate-unmeasured';
  const name = buildEvidenceFileName({ milestone, slice: 'S01', unit });
  const parsed = parseEvidenceFileName(name);
  assertEq(parsed.form, 'composite');
  assertEq(parsed.milestone, milestone);
  assertEq(parsed.slice, 'S01');
  assertEq(parsed.unit, unit);
});

// ── Section 3: precision — the 9 real evidence-<milestone>-S## files ─────────
console.log('\nSection 3: milestone-qualified vs slice-qualified precision (real names)\n');

test('evidence-<milestone>-S##.jsonl classifies as milestone-qualified with unit=S##, never slice-qualified', () => {
  const milestone = 'M-20260813131121-varredura-classe-eol';
  const knownMilestoneIds = [milestone];
  const name = `evidence-${milestone}-S03.jsonl`;
  const parsed = parseEvidenceFileName(name, { knownMilestoneIds });
  assertEq(parsed.form, 'milestone-qualified', 'must resolve via known-ids, never the slice-token anchor');
  assertEq(parsed.milestone, milestone);
  assertEq(parsed.unit, 'S03');
  assertEq(parsed.slice, null, 'S## here is the UNIT axis, not the slice axis');
});

test('a real slice-qualified legacy name (S02-T02) still resolves as slice-qualified', () => {
  const parsed = parseEvidenceFileName('evidence-S02-T02.jsonl', { knownMilestoneIds: [] });
  assertEq(parsed.form, 'slice-qualified');
  assertEq(parsed.slice, 'S02');
  assertEq(parsed.unit, 'T02');
});

test('control: without the known-ids set, the milestone-S## file cannot be resolved as milestone-qualified (proves the ids set is load-bearing, not decorative)', () => {
  const name = 'evidence-M-20260813131121-varredura-classe-eol-S03.jsonl';
  const parsed = parseEvidenceFileName(name, { knownMilestoneIds: [] });
  assert(parsed.form !== 'unrecognized', 'should still classify as something');
  // Without the ids set the milestone axis is not resolvable, and the
  // remainder does not start with S\d{2}- (it starts with the milestone's
  // own `M-` prefix), so it falls all the way to `bare`. It never silently
  // becomes milestone-qualified without evidence — that's the point.
  assert(parsed.form !== 'milestone-qualified', 'must not resolve without the ids set that does the actual disambiguation');
  assertEq(parsed.form, 'bare');
});

// ── Section 4: the 4 forms, each named ────────────────────────────────────────
console.log('\nSection 4: the 4 live forms + unrecognized\n');

test('composite', () => {
  const name = buildEvidenceFileName({ milestone: 'M-X', slice: 'S01', unit: 'T01' });
  assertEq(parseEvidenceFileName(name).form, 'composite');
});

test('milestone-qualified', () => {
  const parsed = parseEvidenceFileName('evidence-M-X-T01.jsonl', { knownMilestoneIds: ['M-X'] });
  assertEq(parsed.form, 'milestone-qualified');
});

test('slice-qualified', () => {
  assertEq(parseEvidenceFileName('evidence-S01-T01.jsonl', { knownMilestoneIds: [] }).form, 'slice-qualified');
});

test('bare', () => {
  assertEq(parseEvidenceFileName('evidence-adhoc.jsonl', { knownMilestoneIds: [] }).form, 'bare');
  assertEq(parseEvidenceFileName('evidence-T04.jsonl', { knownMilestoneIds: [] }).form, 'bare');
});

test('vírgula-mutilated batch form still classifies (milestone-qualified, comma survives inside the unit axis)', () => {
  const parsed = parseEvidenceFileName('evidence-M-X-T01,execute-task.jsonl', { knownMilestoneIds: ['M-X'] });
  assertEq(parsed.form, 'milestone-qualified');
  assertEq(parsed.unit, 'T01,execute-task');
});

test('unrecognized: name that does not start with evidence or end with .jsonl', () => {
  assertEq(parseEvidenceFileName('not-evidence.jsonl').form, 'unrecognized');
  assertEq(parseEvidenceFileName('evidence-adhoc.txt').form, 'unrecognized');
});

test('unrecognized: malformed composite (wrong arity) never guessed as a legacy form', () => {
  assertEq(parseEvidenceFileName('evidence~only-one-axis.jsonl').form, 'unrecognized');
  assertEq(parseEvidenceFileName('evidence~a~b~c~d.jsonl').form, 'unrecognized');
});

EVIDENCE_FORMS.forEach((f) => assert(typeof f === 'string', 'EVIDENCE_FORMS entries are strings'));
test('EVIDENCE_FORMS is the closed, exact 5-member vocabulary', () => {
  assertEq(EVIDENCE_FORMS.slice().sort(), ['bare', 'composite', 'milestone-qualified', 'slice-qualified', 'unrecognized'].sort());
});

// ── Section 5: resolveEvidenceFiles — union across legacy forms ──────────────
console.log('\nSection 5: resolveEvidenceFiles union\n');

test('one logical unit spread across all legacy forms resolves to ONE union, each entry naming its form', () => {
  const root = mkWorkspace();
  const milestone = 'M-union-test';
  registerMilestoneId(root, milestone);
  const composite = buildEvidenceFileName({ milestone, slice: 'S01', unit: 'T01' });
  touchEvidence(root, [
    composite,
    `evidence-${milestone}-T01.jsonl`, // milestone-qualified
    'evidence-S01-T01.jsonl',          // slice-qualified
    'evidence-T01.jsonl',              // bare
    'evidence-OTHER-T02.jsonl',        // unrelated — must NOT be pulled in
  ]);
  const result = resolveEvidenceFiles(root, { milestone, slice: 'S01', unit: 'T01' });
  assertEq(result.files.length, 4, `expected 4 union members, got ${JSON.stringify(result.files)}`);
  const forms = result.files.map((f) => f.form).sort();
  assertEq(forms, ['bare', 'composite', 'milestone-qualified', 'slice-qualified']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a mismatched unit is excluded from the union', () => {
  const root = mkWorkspace();
  touchEvidence(root, ['evidence-T99.jsonl']);
  const result = resolveEvidenceFiles(root, { unit: 'T01' });
  assertEq(result.files.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Section 6: censusEvidenceDir reconciliation ───────────────────────────────
console.log('\nSection 6: censusEvidenceDir reconciliation\n');

test('Σ by_form + Σ skipped === files_considered', () => {
  const root = mkWorkspace();
  touchEvidence(root, [
    buildEvidenceFileName({ milestone: 'M-A', slice: 'S01', unit: 'T01' }),
    'evidence-M-A-T02.jsonl',
    'evidence-S01-T03.jsonl',
    'evidence-adhoc.jsonl',
    'not-evidence.jsonl', // filtered before considering — not part of files_considered
    'evidence-.txt',      // filtered — wrong extension
  ]);
  fs.writeFileSync(path.join(root, '.gsd', 'forge', 'evidence~broken.jsonl'), ''); // malformed composite → unrecognized
  const census = censusEvidenceDir(root);
  const sumByForm = Object.values(census.by_form).reduce((a, b) => a + b, 0);
  const sumSkipped = census.skipped.length;
  assertEq(sumByForm + sumSkipped, census.files_considered, 'reconciliation invariant violated');
  assert(census.files_considered >= 4, 'sanity: real evidence files were considered');
  fs.rmSync(root, { recursive: true, force: true });
});

test('unqualified counts bare + slice-qualified only', () => {
  const root = mkWorkspace();
  registerMilestoneId(root, 'M-A');
  touchEvidence(root, [
    buildEvidenceFileName({ milestone: 'M-A', slice: 'S01', unit: 'T01' }), // composite — qualified
    'evidence-M-A-T02.jsonl', // milestone-qualified — qualified
    'evidence-S01-T03.jsonl', // slice-qualified — UNqualified
    'evidence-adhoc.jsonl',   // bare — UNqualified
  ]);
  const census = censusEvidenceDir(root);
  assertEq(census.unqualified, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Section 7: anti-silence floor ─────────────────────────────────────────────
console.log('\nSection 7: anti-silence floor\n');

test('empty dir → files_considered 0 with a NAMED reason, never a clean-looking census', () => {
  const root = mkWorkspace();
  const census = censusEvidenceDir(root);
  assertEq(census.files_considered, 0);
  assertEq(census.reason, 'empty-dir');
  assert(census.reason !== undefined, 'a 0-file census must never omit the reason');
  fs.rmSync(root, { recursive: true, force: true });
});

test('unreadable dir → files_considered 0 with reason dir-unreadable, never mistaken for empty-dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-evidence-path-test-'));
  // No .gsd/forge/ created at all — readdirSync throws ENOENT.
  const census = censusEvidenceDir(root);
  assertEq(census.files_considered, 0);
  assertEq(census.reason, 'dir-unreadable');
  fs.rmSync(root, { recursive: true, force: true });
});

test('mordida: files_considered === 0 is NEVER read as a clean/empty-but-fine result by a consuming assertion', () => {
  const root = mkWorkspace();
  const census = censusEvidenceDir(root);
  // A caller that treats "0 considered" as "0 problems found" would pass
  // this assertion; it must not be able to, because `reason` is always present
  // whenever files_considered is 0, forcing callers to branch on it.
  const readAsClean = census.files_considered === 0 && !census.reason;
  assert(readAsClean === false, 'a 0-file census read as clean is exactly the anti-silence failure mode');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Section 8: containment ────────────────────────────────────────────────────
console.log('\nSection 8: containment\n');

test('a traversal payload in an axis never escapes the assembled NAME (no separators survive)', () => {
  const name = buildEvidenceFileName({ milestone: '../../etc/passwd', slice: '..\\..\\win', unit: '../x' });
  assert(!name.includes('/'), `separator survived: ${name}`);
  assert(!name.includes('\\'), `separator survived: ${name}`);
  assert(!name.includes('..'), `traversal sequence survived: ${name}`);
});

test('parseEvidenceFileName never throws on hostile input, always returns a form from the closed set', () => {
  const hostiles = ['', null, undefined, '../../../evidence-x.jsonl', 'evidence' + '~'.repeat(50) + '.jsonl', 'evidence-' + '-'.repeat(50) + '.jsonl'];
  for (const h of hostiles) {
    const parsed = parseEvidenceFileName(h);
    assert(EVIDENCE_FORMS.includes(parsed.form), `form not in closed set for input ${JSON.stringify(h)}: ${parsed.form}`);
  }
});

// ── Section 9: CLI ────────────────────────────────────────────────────────────
console.log('\nSection 9: CLI\n');

test('CLI --census --json --cwd <empty-workspace> exits 0 with reason empty-dir', () => {
  const root = mkWorkspace();
  const res = spawnSync(process.execPath, [path.join(__dirname, 'forge-evidence-path.js'), '--census', '--json', '--cwd', root], { encoding: 'utf8' });
  assertEq(res.status, 0);
  const parsed = JSON.parse(res.stdout.trim());
  assertEq(parsed.files_considered, 0);
  assertEq(parsed.reason, 'empty-dir');
  fs.rmSync(root, { recursive: true, force: true });
});

test('CLI with no mode flag exits 2 (invalid args)', () => {
  const res = spawnSync(process.execPath, [path.join(__dirname, 'forge-evidence-path.js')], { encoding: 'utf8' });
  assertEq(res.status, 2);
});

test('CLI --resolve --json returns the union for a real fixture', () => {
  const root = mkWorkspace();
  touchEvidence(root, ['evidence-T01.jsonl']);
  const res = spawnSync(process.execPath, [
    path.join(__dirname, 'forge-evidence-path.js'), '--resolve', '--json', '--cwd', root, '--unit', 'T01',
  ], { encoding: 'utf8' });
  assertEq(res.status, 0);
  const parsed = JSON.parse(res.stdout.trim());
  assertEq(parsed.files.length, 1);
  assertEq(parsed.files[0].form, 'bare');
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Result ─────────────────────────────────────────────────────────────────────
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
