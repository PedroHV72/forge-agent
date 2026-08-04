#!/usr/bin/env node
// forge-legacy-residue.test.js — standalone test suite for forge-legacy-residue.js
//
// Covers:
//   - IN-14: a SINGLE-SOURCE fact is never matched by the signature.  Written so
//     that it fails if the signature is ever loosened to match it (the inversion
//     was exercised once during development — see T01-SUMMARY).
//   - a multi-source VALUE matches, with the derived source count
//   - anti-naive-grep: a file whose raw lines end in a JSON delimiter comma
//     right after the source_unit value is matched by a line-level regex and
//     NOT matched by the detector.  This is the exact false-positive class the
//     gate exists to catch (a line grep returns 64 of them in the WDMA store).
//   - enumeration coverage: items.length === population.facts, no fact escapes
//     the report without a verdict
//   - read-only: file list + mtimes identical before and after scanStore, and
//     the module source contains no writer/exec require at all
//   - false_positives empty for a well-formed fixture; non-empty for a value
//     with a trailing separator (one source, signature present)
//   - unreadable fragments are counted and named, never silently dropped
//   - verdictOf: PASS / FAIL / NO-TARGET
//
// Run: node scripts/forge-legacy-residue.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  scanStore,
  classifyFact,
  verdictOf,
  formatReport,
  VERDICT_RESIDUE,
  VERDICT_SINGLE,
  VERDICT_NO_SIGNATURE,
  VERDICTS,
  _private,
} = require('./forge-legacy-residue.js');

const { splitSources, hasSignature } = _private;

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

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-legacy-residue-test-'));

// Builds a store fixture directory and returns its root.
function mkStore(name, files) {
  const root = path.join(ROOT, name);
  const mem = path.join(root, '.gsd', 'memory');
  fs.mkdirSync(mem, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(mem, filename), content, 'utf-8');
  }
  return root;
}

// A fragment with the given facts block body.
function fragment(unitId, factsBlock, body) {
  return `---\nunit_id: ${unitId}\nfacts:\n${factsBlock}---\n${body || 'corpo\n'}`;
}

function fact(memId, sourceUnit, text) {
  return [
    `  - mem_id: ${memId}`,
    '    category: pattern',
    `    text: ${text || 'fato de fixture'}`,
    '    created_at: 2026-01-01',
    `    source_unit: ${sourceUnit}`,
    '',
  ].join('\n');
}

// Snapshot of every file under a directory: relative path + size + mtime.
function snapshot(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const stat = fs.statSync(full);
      out.push(`${path.relative(dir, full)}|${stat.size}|${stat.mtimeMs}`);
    }
  };
  walk(dir);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== forge-legacy-residue.js — signature precision ===\n');

test('IN-14: single-source value is NOT matched by the signature', () => {
  // The load-bearing assertion of the whole gate.  It fails the moment the
  // signature is loosened to match a value without a separator.
  const result = classifyFact({ mem_id: 'MEM001', source_unit: 'execute-task/T02' });
  assert(result.verdict !== VERDICT_RESIDUE, 'single-source fact must never be flagged as residue');
  assertEq(result.verdict, VERDICT_SINGLE, 'verdict for a single source');
  assertEq(result.sourceCount, 1, 'source count for a single source');
  assertEq(hasSignature('execute-task/T02'), false, 'signature must not fire without a separator');
});

test('IN-14: single-source values across shapes stay untouched', () => {
  for (const value of ['execute-task/T02', 'plan-slice/S01', 'complete-slice/S07', 'ask-abc.123']) {
    const result = classifyFact({ source_unit: value });
    assert(result.verdict === VERDICT_SINGLE, `"${value}" must be untouched, got ${result.verdict}`);
  }
});

test('multi-source value matches and reports its source count', () => {
  const result = classifyFact({
    mem_id: 'MEM002',
    source_unit: 'complete-slice/S02, plan-slice/S03, execute-task/T04',
  });
  assertEq(result.verdict, VERDICT_RESIDUE, 'multi-source verdict');
  assertEq(result.sourceCount, 3, 'derived source count');
  assertEq(result.sources, ['complete-slice/S02', 'plan-slice/S03', 'execute-task/T04'], 'derived sources');
});

test('absent source_unit lands on the no-signature verdict, never undefined', () => {
  const result = classifyFact({ mem_id: 'MEM003' });
  assertEq(result.verdict, VERDICT_NO_SIGNATURE, 'missing source_unit verdict');
  assertEq(result.sourceUnit, '', 'missing source_unit renders as an empty string');
  assertEq(result.sourceCount, 0, 'missing source_unit has zero sources');
});

test('classifyFact is total: every verdict it returns is one of the three', () => {
  const inputs = [
    {}, { source_unit: '' }, { source_unit: 'a' }, { source_unit: 'a,b' },
    { source_unit: ',' }, { source_unit: 'a,' }, { source_unit: ['a', 'b'] },
    { source_unit: 42 }, { source_unit: null },
  ];
  for (const input of inputs) {
    const result = classifyFact(input);
    assert(VERDICTS.indexOf(result.verdict) !== -1, `unknown verdict ${result.verdict} for ${JSON.stringify(input)}`);
  }
});

console.log('\n=== forge-legacy-residue.js — anti-naive-grep ===\n');

test('a JSON end-of-line comma after the value is NOT a match (the 64-hit class)', () => {
  // The fragment body carries JSON-shaped lines where the comma is the record
  // delimiter, not part of the value.  A line-level grep sees a hit; the
  // detector, which reads the VALUE, must not.
  const body = [
    '```json',
    '{',
    '  "mem_id": "MEM900",',
    '  "source_unit": "execute-task/T02",',
    '  "text": "delimiter comma, not a multi-source value"',
    '}',
    '```',
    '',
  ].join('\n');
  const store = mkStore('anti-grep', {
    'M-20260101000000-antigrep.md': fragment(
      'M-20260101000000-antigrep',
      fact('MEM001', 'execute-task/T02'),
      body
    ),
  });

  const raw = fs.readFileSync(
    path.join(store, '.gsd', 'memory', 'M-20260101000000-antigrep.md'),
    'utf-8'
  );
  const naive = raw.match(/"source_unit"[^,]*,/g) || [];
  assert(naive.length > 0, 'the naive line-level grep must actually fire on this fixture');

  const scan = scanStore(store);
  assertEq(scan.counts.matched, 0, 'the detector must not match an end-of-line delimiter comma');
  assertEq(scan.false_positives.length, 0, 'no false positives on the anti-grep fixture');
  assertEq(scan.counts.single_source, 1, 'the real fact is still enumerated as single-source');
});

console.log('\n=== forge-legacy-residue.js — enumeration & population ===\n');

test('enumeration covers 100% of the facts evaluated', () => {
  const store = mkStore('coverage', {
    'M-20260101000000-a.md': fragment(
      'M-20260101000000-a',
      fact('MEM001', 'execute-task/T02') + fact('MEM002', 'complete-slice/S02, plan-slice/S03')
    ),
    'M-20260101000001-b.md': fragment(
      'M-20260101000001-b',
      fact('MEM003', 'plan-slice/S01') + fact('MEM004', 'execute-task/T09')
    ),
  });
  const scan = scanStore(store);
  assertEq(scan.items.length, scan.population.facts, 'every evaluated fact must appear in items[]');
  assertEq(scan.population.fragments, 2, 'fragment population');
  assertEq(scan.population.facts, 4, 'fact population');
  const summed = scan.counts.matched + scan.counts.single_source + scan.counts.no_signature;
  assertEq(summed, scan.items.length, 'the per-verdict counts must sum to the enumeration');
  for (const item of scan.items) {
    assert(VERDICTS.indexOf(item.verdict) !== -1, `item ${item.mem_id} has no valid verdict`);
  }
});

test('each matched item carries adjudicable evidence', () => {
  const store = mkStore('evidence', {
    'M-20260101000000-e.md': fragment(
      'M-20260101000000-e',
      fact('MEM077', 'a/S01, b/S02, c/S03')
    ),
  });
  const scan = scanStore(store);
  assertEq(scan.counts.matched, 1, 'one match expected');
  const item = scan.items.find(entry => entry.verdict === VERDICT_RESIDUE);
  assertEq(item.mem_id, 'MEM077', 'mem_id present');
  assertEq(item.fragment, 'M-20260101000000-e', 'origin fragment present');
  assertEq(item.source_unit, 'a/S01, b/S02, c/S03', 'literal source_unit value present');
  assertEq(item.sourceCount, 3, 'derived source count present');
});

test('an unreadable fragment is counted AND named, and the sweep continues', () => {
  const store = mkStore('degraded', {
    'M-20260101000000-ok.md': fragment('M-20260101000000-ok', fact('MEM001', 'execute-task/T02')),
    'M-20260101000001-bad.md': fragment('M-20260101000001-bad', fact('MEM002', 'a/S01, b/S02')),
  });
  assertEq(scanStore(store).population.facts, 2, 'both fragments readable by default');

  // The failure is injected through the documented `readText` seam: a listed
  // fragment that cannot be read is not reproducible cheaply on this platform,
  // and an unexercised degradation path proves nothing.
  const stderrWrite = process.stderr.write;
  const warned = [];
  process.stderr.write = (chunk) => { warned.push(String(chunk)); return true; };
  let scan;
  try {
    scan = scanStore(store, {
      readText: (cwd, entry) => {
        if (entry.storageKey === 'M-20260101000001-bad') throw new Error('fragmento ilegível de fixture');
        return fs.readFileSync(entry.path, 'utf-8');
      },
    });
  } finally {
    process.stderr.write = stderrWrite;
  }

  assertEq(scan.population.fragments, 2, 'the unreadable fragment stays in the population');
  assertEq(scan.population.fragments_unreadable.length, 1, 'the unreadable fragment is counted');
  assertEq(scan.population.fragments_unreadable[0].storageKey, 'M-20260101000001-bad', 'and named');
  assertEq(scan.population.facts, 1, 'the readable fragment was still swept');
  assert(warned.some(line => line.indexOf('M-20260101000001-bad') !== -1), 'and it is announced on stderr');
});

test('the default reader is the real store reader, not a seam', () => {
  const source = fs.readFileSync(path.join(__dirname, 'forge-legacy-residue.js'), 'utf-8');
  assert(
    /options\.readText\s*\|\|\s*readFragmentText/.test(source),
    'scanStore must fall back to readFragmentText when no seam is supplied'
  );
});

console.log('\n=== forge-legacy-residue.js — read-only by construction ===\n');

test('scanStore leaves the store byte-identical (file list + size + mtime)', () => {
  const store = mkStore('readonly', {
    'M-20260101000000-r.md': fragment(
      'M-20260101000000-r',
      fact('MEM001', 'execute-task/T02') + fact('MEM002', 'a/S01, b/S02')
    ),
  });
  const before = snapshot(store);
  scanStore(store);
  scanStore(store);
  const after = snapshot(store);
  assertEq(after, before, 'scanStore must not touch a single byte of the store');
});

test('the module source has no writer and no exec require at all', () => {
  const source = fs.readFileSync(path.join(__dirname, 'forge-legacy-residue.js'), 'utf-8');
  // An absent require is checkable; an unused one is only a promise.
  assert(!/require\(\s*['"]child_process['"]\s*\)/.test(source), 'must not require child_process');
  assert(!/require\(\s*['"]fs['"]\s*\)/.test(source), 'must not require fs');
  for (const writer of ['writeFileSync', 'appendFileSync', 'rmSync', 'renameSync', 'mkdirSync', 'unlinkSync']) {
    assert(source.indexOf(writer) === -1, `must not reference ${writer}`);
  }
  for (const exec of ['execSync', 'spawnSync', 'execFileSync']) {
    assert(source.indexOf(exec) === -1, `must not reference ${exec}`);
  }
});

console.log('\n=== forge-legacy-residue.js — false positives & verdict ===\n');

test('false_positives is empty for a well-formed single + multi fixture', () => {
  const store = mkStore('wellformed', {
    'M-20260101000000-w.md': fragment(
      'M-20260101000000-w',
      fact('MEM001', 'execute-task/T02') + fact('MEM002', 'a/S01, b/S02, c/S03')
    ),
  });
  const scan = scanStore(store);
  assertEq(scan.false_positives.length, 0, 'no false positives expected');
  assertEq(scan.counts.matched, 1, 'exactly one match');
  assertEq(verdictOf(scan), 'PASS', 'one adjudicable match and no false positive → PASS');
});

test('a matched value with only one real source IS reported as a false positive → FAIL', () => {
  // A trailing separator carries the signature but only one source.  It must
  // surface as a false positive rather than be counted as residue.
  const store = mkStore('trailing', {
    'M-20260101000000-t.md': fragment('M-20260101000000-t', fact('MEM001', '"execute-task/T02,"')),
  });
  const scan = scanStore(store);
  assertEq(scan.counts.matched, 1, 'the signature fires on the trailing separator');
  assertEq(scan.false_positives.length, 1, 'and it is caught as a false positive');
  assertEq(scan.false_positives[0].sourceCount, 1, 'because it resolves to a single source');
  assertEq(verdictOf(scan), 'FAIL', 'any false positive → FAIL');
});

test('a store with zero matches yields NO-TARGET', () => {
  const store = mkStore('notarget', {
    'M-20260101000000-n.md': fragment(
      'M-20260101000000-n',
      fact('MEM001', 'execute-task/T02') + fact('MEM002', 'plan-slice/S01')
    ),
  });
  const scan = scanStore(store);
  assertEq(scan.counts.matched, 0, 'no matches');
  assertEq(verdictOf(scan), 'NO-TARGET', 'zero matches → NO-TARGET');
});

test('a store with no memory directory reports a zero population, not a clean one', () => {
  const empty = path.join(ROOT, 'nostore');
  fs.mkdirSync(empty, { recursive: true });
  const scan = scanStore(empty);
  assertEq(scan.population.fragments, 0, 'zero fragments');
  assertEq(scan.population.facts, 0, 'zero facts');
  assertEq(verdictOf(scan), 'NO-TARGET', 'nothing to match');
});

test('an unreadable store yields ERROR, never NO-TARGET, and says so in the report', () => {
  // The store exists and is well-formed; the SCAN is what fails.  An invalid
  // milestone filter makes the real `listFragments` throw, which is the same
  // code path an unreachable store takes — so this exercises the degradation
  // end to end rather than hand-building a scan object.
  const store = mkStore('storeerror', {
    'M-20260101000000-e.md': fragment('M-20260101000000-e', fact('MEM001', 'a/S01, b/S02')),
  });
  const scan = scanStore(store, { memoryOpts: { milestoneId: 'not-a-milestone-id' } });
  assert(Boolean(scan.population.store_error), 'the failure is recorded on the population');
  assertEq(scan.population.facts, 0, 'nothing was measured');
  assertEq(verdictOf(scan), 'ERROR', 'a scanner failure must not be certified as NO-TARGET');
  const text = formatReport(scan);
  assert(text.indexOf('store_error:') !== -1, 'the human report names the failure');
  assert(text.indexOf('verdict: ERROR') !== -1, 'and closes with the non-verdict');
});

test('formatReport states the population and the verdict', () => {
  const store = mkStore('report', {
    'M-20260101000000-p.md': fragment(
      'M-20260101000000-p',
      fact('MEM001', 'execute-task/T02') + fact('MEM002', 'a/S01, b/S02')
    ),
  });
  const text = formatReport(scanStore(store));
  assert(text.indexOf('fragments returned') !== -1, 'declares the fragment population');
  assert(text.indexOf('facts evaluated') !== -1, 'declares the fact population');
  assert(text.indexOf('MEM002') !== -1, 'enumerates the matched item');
  assert(/verdict: (PASS|FAIL|NO-TARGET)/.test(text), 'closes with a verdict');
});

test('splitSources drops empty segments so a trailing separator counts one source', () => {
  assertEq(splitSources('a, b, c'), ['a', 'b', 'c'], 'three sources');
  assertEq(splitSources('a,'), ['a'], 'trailing separator yields one source');
  assertEq(splitSources(''), [], 'empty value yields no sources');
});

test('exports surface (regression)', () => {
  const mod = require('./forge-legacy-residue.js');
  assert(typeof mod.scanStore === 'function', 'scanStore exported');
  assert(typeof mod.classifyFact === 'function', 'classifyFact exported');
  assert(typeof mod.verdictOf === 'function', 'verdictOf exported');
  assert(Array.isArray(mod.VERDICTS) && mod.VERDICTS.length === 3, 'exactly three verdicts');
});

// ── Cleanup and summary ───────────────────────────────────────────────────────
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}

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
