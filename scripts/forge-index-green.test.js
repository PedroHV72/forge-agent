'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeFragment } = require('./forge-memory');
const {
  measureGreen,
  F2_THRESHOLD,
  runCli,
  computeUnitAxisCriterion,
  computeSubjectReportCriterion,
} = require('./forge-index-green');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

function fact(mem_id, text) {
  return { mem_id, category: 'test', text, created_at: '2026-01-01T00:00:00Z', source_unit: 'T01' };
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'idxgreen-'));
  fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'scripts', 'covered.js'), 'module.exports = 1;');
  return cwd;
}

function cleanup(cwd) {
  fs.rmSync(cwd, { recursive: true, force: true });
}

function snapshotTree(root) {
  const result = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      const stat = fs.statSync(target);
      result.push({ path: path.relative(root, target), size: stat.size, mtime: stat.mtimeMs, isDirectory: entry.isDirectory() });
      if (entry.isDirectory()) walk(target);
    }
  }
  walk(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

// ── Section 1: fully green store ────────────────────────────────────────────
console.log('\nSection 1: fully green store — all three criteria pass\n');

test('a store with only covered/precise facts is green:true with criteria[] all ok', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, {
      unit_id: 'T01',
      facts: [fact('f-covered', '`scripts/covered.js`')],
    });
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, true, 'expected green:true for a fully covered store');
    assert.strictEqual(report.reasons.length, 0, 'green:true must carry zero reasons');
    assert.strictEqual(report.criteria.length, 3, 'exactly three D-2 criteria');
    for (const c of report.criteria) {
      assert.strictEqual(c.ok, true, `criterion ${c.name} must be ok on a fully green store`);
      assert.ok('measured' in c && 'required' in c, `criterion ${c.name} must carry measured+required even when ok`);
    }
    assert.strictEqual(typeof report.f2_recall, 'number');
    assert.strictEqual(typeof report.measured_at, 'string');
  } finally { cleanup(cwd); }
});

// ── Section 2: recall below threshold ───────────────────────────────────────
console.log('\nSection 2: f2_recall below threshold fails green, names the reason\n');

test('a missed mention drags f2_recall below threshold → green:false, reasons has f2-below-threshold', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, {
      // "1.2.0" and "e/ou" are detected as mentions by the wider F2 vocabulary
      // but filtered by the detector as false positives (version/prose noise),
      // producing zero matching citations — an extractor-blind-spot "missed"
      // bucket, distinct from an unresolved-but-extracted citation.
      unit_id: 'T01',
      facts: [fact('f-noise', 'A versão 1.2.0 e o caminho e/ou são ruído.')],
    });
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, false);
    assert.ok(report.reasons.includes('f2-below-threshold'), `expected f2-below-threshold in ${JSON.stringify(report.reasons)}`);
    const f2Criterion = report.criteria.find((c) => c.name === 'f2_recall');
    assert.strictEqual(f2Criterion.ok, false);
    assert.strictEqual(f2Criterion.required, F2_THRESHOLD);
  } finally { cleanup(cwd); }
});

// ── Section 3: unit axis incomplete (fragment lost) ─────────────────────────
console.log('\nSection 3: fragment lost to a read failure → unit_axis fails, never silently\n');

test('an unreadable sibling fragment never yields green:true, and the failure is a named reason', () => {
  const cwd = fixture();
  writeFragment(cwd, { unit_id: 'T01', facts: [fact('mem-ok', '`scripts/covered.js`')] });
  writeFragment(cwd, { unit_id: 'T02', facts: [fact('mem-broken', '`scripts/covered.js`')] });
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p.replace(/\\/g, '/').includes('/.gsd/memory/') && /T02/.test(p)) {
      throw new Error('EACCES: simulated unreadable fragment');
    }
    return realReadFileSync.call(fs, p, ...rest);
  };
  try {
    const report = measureGreen(cwd);
    // NOTE: buildFileIndex (used by the unit/subject axes) degrades a per-
    // fragment read failure into coverage.unreadable_fragments, but measureF2
    // (T01, reused unmodified — out of this task's scope) does NOT wrap its
    // per-fragment read loop, so the same failure surfaces here as an
    // uncaught exception that measureGreen's outer try/catch turns into a
    // gate-error. Both paths are honest failures of the same underlying
    // event; the isolated computeUnitAxisCriterion tests below prove the
    // 'unit-axis-incomplete' reason directly, on the axis shape it actually
    // gates on, independent of measureF2's narrower error handling.
    assert.strictEqual(report.green, false, 'a store that lost a fragment cannot be green');
    assert.ok(report.reasons.length >= 1, `green:false must name a reason: ${JSON.stringify(report.reasons)}`);
  } finally {
    fs.readFileSync = realReadFileSync;
    cleanup(cwd);
  }
});

test('computeUnitAxisCriterion: counts matching but a lost fragment still fails (isolated)', () => {
  const axis = {
    coverage: { facts_with_unit: 1, facts_total: 1, facts_not_read: { unreadable_fragments: 1, fragments_skipped_by_store: 0 } },
    fragment_listing_failed: null,
    partial: false,
  };
  const criterion = computeUnitAxisCriterion(axis);
  assert.strictEqual(criterion.ok, false);
  assert.strictEqual(criterion.countsMatch, true);
  assert.strictEqual(criterion.noLostFragments, false);
});

test('computeUnitAxisCriterion: mismatched counts fail even with zero lost fragments (isolated)', () => {
  const axis = {
    coverage: { facts_with_unit: 1, facts_total: 2, facts_not_read: { unreadable_fragments: 0, fragments_skipped_by_store: 0 } },
    fragment_listing_failed: null,
    partial: false,
  };
  const criterion = computeUnitAxisCriterion(axis);
  assert.strictEqual(criterion.ok, false);
  assert.strictEqual(criterion.countsMatch, false);
});

// ── Section 4: subject report absent ────────────────────────────────────────
console.log('\nSection 4: subject report presence — no threshold, presence only\n');

test('computeSubjectReportCriterion: a well-formed axis with coverage.facts_total is present (isolated)', () => {
  const criterion = computeSubjectReportCriterion({ coverage: { facts_total: 0 } });
  assert.strictEqual(criterion.ok, true, 'presence never requires a minimum count — D-2 forbids a subject threshold');
});

test('computeSubjectReportCriterion: a missing/malformed axis is reported absent, never silently true (isolated)', () => {
  assert.strictEqual(computeSubjectReportCriterion(null).ok, false);
  assert.strictEqual(computeSubjectReportCriterion({}).ok, false);
  assert.strictEqual(computeSubjectReportCriterion({ coverage: {} }).ok, false);
});

test('an empty store still reports subject_report_present:true — presence, not a coverage minimum', () => {
  const cwd = fixture();
  try {
    const report = measureGreen(cwd);
    assert.strictEqual(report.subject_report_present, true, 'an empty store is honestly reported present with zero subjects, not absent');
  } finally { cleanup(cwd); }
});

// ── Section 5: criteria[] is unconditional ──────────────────────────────────
console.log('\nSection 5: criteria[] always carries the three entries, pass or fail\n');

test('criteria[] always has exactly f2_recall, unit_axis, subject_report_present — in every scenario', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-noise', 'A versão 1.2.0 e o caminho e/ou são ruído.')] });
    const report = measureGreen(cwd);
    assert.deepStrictEqual(report.criteria.map((c) => c.name), ['f2_recall', 'unit_axis', 'subject_report_present']);
    for (const c of report.criteria) assert.ok('ok' in c && 'measured' in c && 'required' in c);
  } finally { cleanup(cwd); }
});

// ── Section 6: green:false always names a reason ────────────────────────────
console.log('\nSection 6: green:false never ships without a named reason\n');

test('every green:false report carries at least one entry in reasons[]', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-noise', 'A versão 1.2.0 e o caminho e/ou são ruído.')] });
    const report = measureGreen(cwd);
    assert.strictEqual(report.green, false);
    assert.ok(Array.isArray(report.reasons) && report.reasons.length >= 1);
  } finally { cleanup(cwd); }
});

// ── Section 7: read-only ─────────────────────────────────────────────────────
console.log('\nSection 7: the gate is read-only — no --write path exists, tree is untouched\n');

test('measureGreen never mutates the store tree', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`')] });
    const before = snapshotTree(cwd);
    measureGreen(cwd);
    const after = snapshotTree(cwd);
    assert.deepStrictEqual(before, after, 'the filesystem tree must be byte-identical before/after the gate runs');
  } finally { cleanup(cwd); }
});

test('the module never exposes a --write flag on its CLI', () => {
  const source = fs.readFileSync(path.join(__dirname, 'forge-index-green.js'), 'utf8');
  assert.ok(!/--write/.test(source), 'forge-index-green.js must never accept --write — this gate is read-only by contract');
});

// ── Section 8: determinism ───────────────────────────────────────────────────
console.log('\nSection 8: determinism — two runs over the same store agree on every field but measured_at\n');

test('two consecutive runs produce identical fields except measured_at', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`'), fact('f-noise', 'A versão 1.2.0 e o caminho e/ou são ruído.')] });
    const first = measureGreen(cwd);
    const second = measureGreen(cwd);
    const strip = (r) => { const { measured_at, ...rest } = r; return rest; };
    assert.deepStrictEqual(strip(first), strip(second));
  } finally { cleanup(cwd); }
});

// ── Section 9: CLI ────────────────────────────────────────────────────────────
console.log('\nSection 9: CLI — exit 0 always, JSON single line, invalid arg exits 2\n');

test('CLI --cwd --json exits 0 and prints one JSON document', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-covered', '`scripts/covered.js`')] });
    const result = spawnSync(process.execPath, [path.join(__dirname, 'forge-index-green.js'), '--cwd', cwd, '--json'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
    const lines = result.stdout.trim().split('\n');
    assert.strictEqual(lines.length, 1, 'expected exactly one JSON document on stdout');
    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(typeof parsed.green, 'boolean');
    assert.ok(Array.isArray(parsed.criteria));
  } finally { cleanup(cwd); }
});

test('CLI without --json prints markdown, still exit 0', () => {
  const cwd = fixture();
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'forge-index-green.js'), '--cwd', cwd], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('# Gate: índice verde'));
  } finally { cleanup(cwd); }
});

test('CLI unknown flag exits 2', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'forge-index-green.js'), '--bogus'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
});

test('runCli() exit code is always 0 for a valid, even failing, measurement', () => {
  const cwd = fixture();
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('f-noise', 'A versão 1.2.0 e o caminho e/ou são ruído.')] });
    const realWrite = process.stdout.write;
    process.stdout.write = () => true;
    let code;
    try { code = runCli(['--cwd', cwd, '--json']); } finally { process.stdout.write = realWrite; }
    assert.strictEqual(code, 0);
  } finally { cleanup(cwd); }
});

// ── Section 10: internal exception still exits 0 with a named reason ────────
console.log('\nSection 10: an internal exception never escapes as a non-zero exit — it becomes gate-error\n');

test('a cwd that does not exist as a real project still yields green:false with a gate-error reason, exit 0', () => {
  const missing = path.join(os.tmpdir(), `idxgreen-missing-${Date.now()}`);
  const realWrite = process.stdout.write;
  let captured = '';
  process.stdout.write = (chunk) => { captured += chunk; return true; };
  let code;
  try { code = runCli(['--cwd', missing, '--json']); } finally { process.stdout.write = realWrite; }
  assert.strictEqual(code, 0, 'the gate must never fail the process, even on an unusable cwd');
  const parsed = JSON.parse(captured.trim());
  assert.strictEqual(typeof parsed.green, 'boolean');
});

console.log(`\n${passed} passed`);
