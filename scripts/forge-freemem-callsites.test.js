#!/usr/bin/env node
'use strict';

// forge-freemem-callsites.test.js — proves bidirectional bite of the
// os.freemem() ban (B3): a planted violation turns the outcome red naming
// file+line, a clean tree turns green, and an empty directory (zero files
// scanned) fails with the anti-silence reason — never confused with "0
// violations found". Also proves the destructured form is caught, and that
// the scanner never trips on its own source or test.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  SKIP_REASONS,
  VIOLATION_FORMS,
  classifyFile,
  scanFreemem,
} = require('./forge-freemem-callsites.js');

const CLI = path.join(__dirname, 'forge-freemem-callsites.js');

// ── Runner ──────────────────────────────────────────────────────────────────

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

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Fixture helpers — always under os.tmpdir(), never inside scripts/ ──────

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-freemem-callsites-'));
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

// Forbidden pattern text built by concatenation so THIS TEST FILE does not
// contain the literal call site it plants (mirrors the scanner's own
// self-exclusion discipline).
const OS_WORD = 'os';
const FREE = 'free' + 'mem';
const QUALIFIED_CALL = `${OS_WORD}.${FREE}();`;

// ═══════════════════════════════════════════════════════════════════════════
// classifyFile — pure, in-memory
// ═══════════════════════════════════════════════════════════════════════════

test('qualified os.freemem( call is flagged with correct line number', () => {
  const content = [
    '// header',
    'const x = 1;',
    QUALIFIED_CALL,
  ].join('\n');
  const result = classifyFile({ path: '/virtual/a.js', content });
  assertEqual(result.scanned, 1, 'scanned');
  assertEqual(result.violations.length, 1, 'violation count');
  assertEqual(result.violations[0].line, 3, 'line number');
  assertEqual(result.violations[0].form, VIOLATION_FORMS.QUALIFIED, 'form');
  assertEqual(result.violations[0].file, '/virtual/a.js', 'file');
});

test('destructured form ( const { freemem } = require("os") ... freemem() ) is flagged', () => {
  const content = [
    `const { ${FREE} } = require('${OS_WORD}');`,
    'function check() {',
    `  return ${FREE}();`,
    '}',
  ].join('\n');
  const result = classifyFile({ path: '/virtual/b.js', content });
  assertEqual(result.scanned, 1, 'scanned');
  assertEqual(result.violations.length, 1, 'violation count');
  assertEqual(result.violations[0].form, VIOLATION_FORMS.DESTRUCTURED, 'form');
  assertEqual(result.violations[0].line, 3, 'call line');
});

test('destructured form via node: prefix is also flagged', () => {
  const content = [
    `const { ${FREE} } = require('node:${OS_WORD}');`,
    `console.log(${FREE}());`,
  ].join('\n');
  const result = classifyFile({ path: '/virtual/c.js', content });
  assertEqual(result.violations.length, 1, 'violation count');
  assertEqual(result.violations[0].form, VIOLATION_FORMS.DESTRUCTURED, 'form');
});

test('os.totalmem() is NOT flagged — capacity is not banned, only freemem', () => {
  const content = `const cap = ${OS_WORD}.totalmem();`;
  const result = classifyFile({ path: '/virtual/d.js', content });
  assertEqual(result.violations.length, 0, 'no violations for totalmem');
});

test('destructuring freemem without ever calling it is NOT flagged', () => {
  const content = `const { ${FREE} } = require('${OS_WORD}');\n// never called`;
  const result = classifyFile({ path: '/virtual/e.js', content });
  assertEqual(result.violations.length, 0, 'destructure alone is not a call site');
});

test('qualified call inside a comment line is not flagged', () => {
  const content = `// example: ${QUALIFIED_CALL}`;
  const result = classifyFile({ path: '/virtual/f.js', content });
  assertEqual(result.violations.length, 0, 'comment line excluded');
});

// ═══════════════════════════════════════════════════════════════════════════
// R4/R5 — whitespace-evadable detection (reproduced by the advocate, then
// fixed by matching whole file content instead of line-by-line)
// ═══════════════════════════════════════════════════════════════════════════

test('R4: qualified call split across whitespace within one line ("os . freemem()") is flagged', () => {
  const content = `${OS_WORD} . ${FREE}();`;
  const result = classifyFile({ path: '/virtual/r4a.js', content });
  assertEqual(result.violations.length, 1, 'whitespace-separated qualified call is caught');
  assertEqual(result.violations[0].form, VIOLATION_FORMS.QUALIFIED, 'form');
});

test('R4: qualified call split across a line break ("os\\n  .freemem()") is flagged', () => {
  const content = [
    'function check() {',
    `  return ${OS_WORD}`,
    `    .${FREE}();`,
    '}',
  ].join('\n');
  const result = classifyFile({ path: '/virtual/r4b.js', content });
  assertEqual(result.violations.length, 1, 'call split across a newline is caught');
  assertEqual(result.violations[0].form, VIOLATION_FORMS.QUALIFIED, 'form');
});

test('R5: multiline destructuring ("const {\\n freemem\\n} = require(\'os\')") followed by a call is flagged', () => {
  const content = [
    'const {',
    `  ${FREE}`,
    `} = require('${OS_WORD}');`,
    `console.log(${FREE}());`,
  ].join('\n');
  const result = classifyFile({ path: '/virtual/r5.js', content });
  assertEqual(result.violations.length, 1, 'multiline destructuring is still caught');
  assertEqual(result.violations[0].form, VIOLATION_FORMS.DESTRUCTURED, 'form');
  assertEqual(result.violations[0].line, 4, 'call line');
});

// ═══════════════════════════════════════════════════════════════════════════
// R8 — string literal / comment regions must not produce false positives,
// verified WITHOUT weakening R4/R5 (the operator's tie-break: false-negative
// safety wins over false-positive noise; the critical assert below proves
// both properties hold simultaneously, not one traded for the other).
// ═══════════════════════════════════════════════════════════════════════════

test('R8: a call site mentioned inside a string literal is not flagged', () => {
  const content = `const msg = "call ${OS_WORD}.${FREE}() and it lies under swap pressure";`;
  const result = classifyFile({ path: '/virtual/r8a.js', content });
  assertEqual(result.violations.length, 0, 'string-literal mention is not a call site');
});

test('R8: a call site mentioned inside a block comment is not flagged', () => {
  const content = `/* do not call ${OS_WORD}.${FREE}() here, it lies under swap */\nconst x = 1;`;
  const result = classifyFile({ path: '/virtual/r8b.js', content });
  assertEqual(result.violations.length, 0, 'block-comment mention is not a call site');
});

test('R8: an inline trailing comment mentioning the call is not flagged', () => {
  const content = `const x = 1; // never call ${OS_WORD}.${FREE}() here`;
  const result = classifyFile({ path: '/virtual/r8c.js', content });
  assertEqual(result.violations.length, 0, 'inline trailing comment mention is not a call site');
});

test('CRITICAL (R4/R5 vs R8 tie-break): a genuine call adjacent to, and on the same line as, a string and a comment containing the same text is still caught', () => {
  // Same line carries: a string literal mentioning the banned call, a real
  // call site, and a trailing comment also mentioning the banned call. Only
  // the real call site (unquoted, uncommented) may produce a violation.
  const content = `const msg = "${OS_WORD}.${FREE}() in a string"; ${OS_WORD}.${FREE}(); // also ${OS_WORD}.${FREE}() in a comment`;
  const result = classifyFile({ path: '/virtual/r8-critical.js', content });
  assertEqual(result.violations.length, 1, 'exactly one real call site is caught, string/comment mentions are not');
  assertEqual(result.violations[0].line, 1, 'violation reported on the correct line');
});

// ═══════════════════════════════════════════════════════════════════════════
// R7 — fixtures dirs and every SKIP_DIRS hit are recorded with a closed
// named reason in the census, never silently dropped
// ═══════════════════════════════════════════════════════════════════════════

test('R7: a fixtures/ directory with real .js files is recorded in skipped[] with a distinct named reason', () => {
  const dir = mkTmpDir();
  writeFile(dir, 'fixtures/planted.js', `${QUALIFIED_CALL}\n`);
  writeFile(dir, 'ok.js', 'const x = 1;\n');
  const result = scanFreemem([dir]);
  const fixtureSkips = result.skipped.filter((s) => s.reason === SKIP_REASONS.FIXTURES_DIR_EXCLUDED);
  assert(fixtureSkips.length >= 1, 'fixtures dir recorded with its own named reason', JSON.stringify(result.skipped));
  assertEqual(result.violations.length, 0, 'files inside fixtures/ are not scanned (exemption is explicit, not silent)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R7: node_modules is recorded in skipped[] with a named reason (never a silent drop)', () => {
  const dir = mkTmpDir();
  writeFile(dir, 'node_modules/pkg/index.js', 'const x = 1;\n');
  writeFile(dir, 'ok.js', 'const x = 1;\n');
  const result = scanFreemem([dir]);
  const nmSkips = result.skipped.filter((s) => s.reason === SKIP_REASONS.VCS_OR_DEPENDENCY_DIR_EXCLUDED);
  assert(nmSkips.length >= 1, 'node_modules dir recorded with a named reason', JSON.stringify(result.skipped));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// R6 — self-referential-assertion exclusion narrowed to an EXACT path, not
// any file sharing the basename
// ═══════════════════════════════════════════════════════════════════════════

test('R6: a file sharing the basename "forge-resources.test.js" but NOT under scripts/ is NOT exempted', () => {
  const dir = mkTmpDir();
  writeFile(dir, 'not-scripts/forge-resources.test.js', `${QUALIFIED_CALL}\n`);
  const result = scanFreemem([dir]);
  assertEqual(result.outcome, 'violations', 'a same-basename file outside scripts/ is scanned, not exempted');
  const exemptSkips = result.skipped.filter((s) => s.reason === SKIP_REASONS.SELF_REFERENTIAL_ASSERTION);
  assertEqual(exemptSkips.length, 0, 'no self-referential-assertion exemption recorded for the wrong directory');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unreadable file returns scanned:0, unreadable:true', () => {
  const result = classifyFile('/definitely/does/not/exist/xyz.js');
  assertEqual(result.scanned, 0, 'scanned');
  assertEqual(result.unreadable, true, 'unreadable flag');
});

// ═══════════════════════════════════════════════════════════════════════════
// scanFreemem — in-memory records
// ═══════════════════════════════════════════════════════════════════════════

test('in-memory scan: planted violation -> outcome violations, names file+line', () => {
  const records = [
    { path: '/virtual/clean.js', content: 'const x = 1;' },
    { path: '/virtual/dirty.js', content: `function f() {\n  ${QUALIFIED_CALL}\n}` },
  ];
  const result = scanFreemem(records, { inMemory: true });
  assertEqual(result.outcome, 'violations', 'outcome');
  assertEqual(result.scanned, 2, 'scanned');
  assertEqual(result.violations.length, 1, 'violation count');
  assertEqual(result.violations[0].file, '/virtual/dirty.js', 'violating file');
  assertEqual(result.violations[0].line, 2, 'violating line');
  assert(typeof result.reason === 'string' && result.reason.length > 0, 'reason present');
});

test('in-memory scan: clean tree -> outcome clean, scanned > 0', () => {
  const records = [
    { path: '/virtual/a.js', content: 'const x = 1;' },
    { path: '/virtual/b.js', content: `const cap = ${OS_WORD}.totalmem();` },
  ];
  const result = scanFreemem(records, { inMemory: true });
  assertEqual(result.outcome, 'clean', 'outcome');
  assert(result.scanned > 0, 'scanned > 0');
  assertEqual(result.violations.length, 0, 'no violations');
  assertEqual(result.reason, null, 'no reason on clean');
});

test('in-memory scan: empty record set -> anti-silence, distinct reason', () => {
  const result = scanFreemem([], { inMemory: true });
  assertEqual(result.outcome, 'anti-silence', 'outcome must be anti-silence, not clean');
  assertEqual(result.scanned, 0, 'scanned');
  assert(/anti-silence/.test(result.reason), 'reason names anti-silence explicitly');
  assert(result.reason !== 'clean', 'anti-silence reason distinct from clean state');
});

// ═══════════════════════════════════════════════════════════════════════════
// scanFreemem — real filesystem walk via os.tmpdir() fixtures
// ═══════════════════════════════════════════════════════════════════════════

test('fs walk: directory with a planted violation file -> red, exact file+line', () => {
  const dir = mkTmpDir();
  const f = writeFile(dir, 'bad.js', `'use strict';\n\nfunction check() {\n  return ${QUALIFIED_CALL}\n}\n`);
  const result = scanFreemem([dir]);
  assertEqual(result.outcome, 'violations', 'outcome');
  assertEqual(result.violations.length, 1, 'violation count');
  assertEqual(path.resolve(result.violations[0].file), path.resolve(f), 'file path matches fixture');
  assertEqual(result.violations[0].line, 4, 'line number');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fs walk: destructured form fixture -> red', () => {
  const dir = mkTmpDir();
  writeFile(dir, 'bad2.js', [
    `const { ${FREE} } = require('${OS_WORD}');`,
    'function pressure() {',
    `  return ${FREE}() < 1000;`,
    '}',
  ].join('\n'));
  const result = scanFreemem([dir]);
  assertEqual(result.outcome, 'violations', 'outcome');
  assertEqual(result.violations.length, 1, 'violation count');
  assertEqual(result.violations[0].form, VIOLATION_FORMS.DESTRUCTURED, 'form');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fs walk: clean tree -> green, scanned > 0', () => {
  const dir = mkTmpDir();
  writeFile(dir, 'ok.js', `const cap = ${OS_WORD}.totalmem();\nmodule.exports = { cap };\n`);
  writeFile(dir, 'nested/also-ok.js', 'const y = 2;\n');
  const result = scanFreemem([dir]);
  assertEqual(result.outcome, 'clean', 'outcome');
  assert(result.scanned >= 2, 'scanned both files');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fs walk: empty directory -> anti-silence, exit-code-worthy reason', () => {
  const dir = mkTmpDir();
  const result = scanFreemem([dir]);
  assertEqual(result.outcome, 'anti-silence', 'outcome must be anti-silence for empty dir');
  assertEqual(result.scanned, 0, 'scanned is 0');
  assert(/anti-silence/.test(result.reason), 'reason names anti-silence');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fs walk: non-existent root -> anti-silence (root-not-found is not a clean pass)', () => {
  const result = scanFreemem(['/this/path/does/not/exist/ever']);
  assertEqual(result.outcome, 'anti-silence', 'nonexistent root must not read as clean');
  assertEqual(result.skipped.length, 1, 'one skip recorded');
  assertEqual(result.skipped[0].reason, SKIP_REASONS.ROOT_NOT_FOUND, 'skip reason');
});

test('fs walk: scanner does not trip on its own source or its own test', () => {
  // These are the real, on-disk files — not fixtures. Both are excluded by
  // basename, so scanning __dirname directly must find zero violations
  // attributable to them, and both must appear in skipped[] as self-fixture.
  const result = scanFreemem([__dirname === path.dirname(CLI) ? path.dirname(CLI) : __dirname]);
  const selfHits = result.violations.filter((v) => {
    const base = path.basename(v.file);
    return base === 'forge-freemem-callsites.js' || base === 'forge-freemem-callsites.test.js';
  });
  assertEqual(selfHits.length, 0, 'no self-attributed violations');
  const selfSkips = result.skipped.filter((s) => s.reason === SKIP_REASONS.SELF_FIXTURE);
  assert(selfSkips.length >= 2, 'both self files recorded as self-fixture skips (enumerated, not invisible)');
});

// ═══════════════════════════════════════════════════════════════════════════
// The live repository tree — measured state today: os.freemem has ZERO
// occurrences in scripts/, so `clean` with scanned > 0 IS the healthy state.
// ═══════════════════════════════════════════════════════════════════════════

// NOTE (deliberate — do not "fix" by weakening the scanner): T03 runs
// concurrently with T01 (writes scripts/forge-resources.js +
// scripts/forge-resources.test.js) in this same working tree. The scanner
// is fail-closed on raw lines by design (mirrors forge-exec-callsites.js's
// documented posture: a string literal is NOT prose) — a sibling test file
// asserting "forge-resources.js never calls os.freemem()" in an English
// message legitimately trips the qualified-form regex. That is the scanner
// doing its job on real content it was never told to trust, not a defect in
// it. The anti-silence invariant (scanned > 0) is the property THIS task
// owns and is asserted unconditionally below; a `violations` outcome here
// is transient census information about concurrent work, not a suite
// failure — T04 (later, after all of S01 lands) ties the scanner to smoke
// against the settled tree.
test('real scripts/ tree scan: anti-silence holds (scanned > 0); outcome reported, not hard-asserted (concurrent-task tolerant)', () => {
  const scriptsRoot = path.resolve(__dirname);
  const result = scanFreemem([scriptsRoot]);
  assert(result.scanned > 0, 'live scan must have scanned files (anti-silence would trip otherwise)');
  assert(result.outcome === 'clean' || result.outcome === 'violations', 'outcome must not be anti-silence on a populated real tree');
  if (result.outcome === 'violations') {
    console.log(`      (info) live tree reported ${result.violations.length} violation(s) — see concurrent-task note above:`);
    for (const v of result.violations) console.log(`        ${v.file}:${v.line}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CLI — real process spawn, real exit codes (not asserted, measured)
// ═══════════════════════════════════════════════════════════════════════════

test('CLI: --check with no args scans real scripts/ (default root), exits 0 or 1 (never anti-silence exit 2)', () => {
  const res = spawnSync(process.execPath, [CLI, '--check', '--cwd', path.resolve(__dirname, '..')], { encoding: 'utf8' });
  assert(res.status === 0 || res.status === 1, `CLI exit code on live tree must be 0 (clean) or 1 (violations), never anti-silence (2); got ${res.status}`);
  assert(/scanned: \d+, outcome: (clean|violations)/.test(res.stdout), 'stdout reports a real outcome, not anti-silence');
});

test('CLI: missing --check flag exits 2 (usage error)', () => {
  const res = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assertEqual(res.status, 2, 'exit code for missing --check');
});

test('CLI: --root pointed at a planted-violation fixture dir exits non-zero (1)', () => {
  const dir = mkTmpDir();
  writeFile(dir, 'bad.js', `${QUALIFIED_CALL}\n`);
  const res = spawnSync(process.execPath, [CLI, '--check', '--root', dir], { encoding: 'utf8' });
  assertEqual(res.status, 1, 'CLI exit code on violation');
  assert(res.stdout.includes('VIOLATION'), 'stdout names the violation');
  assert(res.stdout.includes(path.basename(dir)) || res.stdout.includes('bad.js'), 'stdout names the file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: --root pointed at a clean fixture dir exits 0', () => {
  const dir = mkTmpDir();
  writeFile(dir, 'ok.js', 'const x = 1;\n');
  const res = spawnSync(process.execPath, [CLI, '--check', '--root', dir], { encoding: 'utf8' });
  assertEqual(res.status, 0, 'CLI exit code on clean fixture');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: --root pointed at an empty dir exits 2 (anti-silence, NOT 0)', () => {
  const dir = mkTmpDir();
  const res = spawnSync(process.execPath, [CLI, '--check', '--root', dir], { encoding: 'utf8' });
  assertEqual(res.status, 2, 'CLI exit code for anti-silence must not be 0 (would be indistinguishable from clean)');
  assert(res.stdout.includes('anti-silence'), 'stdout names anti-silence explicitly');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: --json flag emits parseable JSON with outcome/scanned/violations/skipped keys', () => {
  const dir = mkTmpDir();
  writeFile(dir, 'ok.js', 'const x = 1;\n');
  const res = spawnSync(process.execPath, [CLI, '--check', '--root', dir, '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(res.stdout);
  assert('outcome' in parsed, 'has outcome');
  assert('scanned' in parsed, 'has scanned');
  assert('violations' in parsed, 'has violations');
  assert('skipped' in parsed, 'has skipped');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exitCode = 1;
}
