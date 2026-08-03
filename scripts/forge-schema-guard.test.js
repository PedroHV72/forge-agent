#!/usr/bin/env node
// forge-schema-guard.test.js — standalone test suite for forge-schema-guard.js
//
// Covers the locked decision table (CONTEXT § S01 guard):
//   - absent/unreadable SCHEMA-VERSION → ok/ok, fail-open, no warning
//   - major(data) <= major(tooling)    → clean read + clean write
//   - major(data) >  major(tooling)    → read ok + partial + warning;
//                                         write refused (ok:false + message)
//   - guardRead never throws (missing cwd, binary/empty SCHEMA-VERSION)
//   - only MAJOR decides — minor/patch-only difference stays clean
//   - CLI: --check prints one-line JSON, exit 0; unknown args exit 2
//
// Run: node scripts/forge-schema-guard.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  parseSchemaSemver,
  cmpSemver,
  checkSchemaDirection,
  guardRead,
  assertWrite,
  formatSchemaWarning,
} = require('./forge-schema-guard.js');

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

// Temp dir for fixture repos
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-schema-guard-test-'));

// Helper: build a fixture repo dir with an optional .gsd/SCHEMA-VERSION content.
// content === undefined → no .gsd dir at all (truly absent).
// content === null → .gsd dir exists but no SCHEMA-VERSION file.
function makeRepo(name, content) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  if (content !== undefined) {
    const gsdDir = path.join(dir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    if (content !== null) {
      fs.writeFileSync(path.join(gsdDir, 'SCHEMA-VERSION'), content, 'utf8');
    }
  }
  return dir;
}

const TOOLING = 'fragment-store@1.0.0';

console.log('\n=== forge-schema-guard.js — directional schema guard ===\n');

// ── Section 1: absent SCHEMA-VERSION → fail-open ──────────────────────────────
console.log('Section 1: absent .gsd/SCHEMA-VERSION\n');

test('no .gsd dir at all: guardRead ok, partial false, no warning', () => {
  const dir = makeRepo('no-gsd-dir', undefined);
  const res = guardRead(dir, { toolingSchema: TOOLING });
  assert(res.ok === true, 'ok should be true');
  assert(res.partial === false, 'partial should be false');
  assert(res.warning === null, 'warning should be null');
});

test('no .gsd dir at all: assertWrite ok', () => {
  const dir = makeRepo('no-gsd-dir-write', undefined);
  const res = assertWrite(dir, { toolingSchema: TOOLING });
  assert(res.ok === true, 'ok should be true');
  assert(res.message === null, 'message should be null');
});

test('.gsd dir exists but no SCHEMA-VERSION file: guardRead/assertWrite ok', () => {
  const dir = makeRepo('no-file', null);
  const r = guardRead(dir, { toolingSchema: TOOLING });
  const w = assertWrite(dir, { toolingSchema: TOOLING });
  assert(r.ok === true && r.partial === false && r.warning === null, 'guardRead should be clean');
  assert(w.ok === true && w.message === null, 'assertWrite should be clean');
});

// ── Section 2: unreadable/garbage content → fail-open ─────────────────────────
console.log('\nSection 2: unreadable content\n');

test('garbage content "lixo": fail-open on both sides', () => {
  const dir = makeRepo('garbage', 'lixo');
  const r = guardRead(dir, { toolingSchema: TOOLING });
  const w = assertWrite(dir, { toolingSchema: TOOLING });
  assert(r.ok === true && r.partial === false && r.warning === null, 'guardRead should fail-open');
  assert(w.ok === true && w.message === null, 'assertWrite should fail-open');
});

test('empty string content: fail-open on both sides', () => {
  const dir = makeRepo('empty', '');
  const r = guardRead(dir, { toolingSchema: TOOLING });
  const w = assertWrite(dir, { toolingSchema: TOOLING });
  assert(r.ok === true && r.partial === false, 'guardRead should fail-open on empty content');
  assert(w.ok === true, 'assertWrite should fail-open on empty content');
});

test('whitespace-only content: fail-open on both sides', () => {
  const dir = makeRepo('whitespace', '   \n\t  ');
  const r = guardRead(dir, { toolingSchema: TOOLING });
  const w = assertWrite(dir, { toolingSchema: TOOLING });
  assert(r.ok === true && r.partial === false, 'guardRead should fail-open on whitespace content');
  assert(w.ok === true, 'assertWrite should fail-open on whitespace content');
});

// ── Section 3: major(data) <= major(tooling) → clean both sides ───────────────
console.log('\nSection 3: major(data) <= major(tooling)\n');

test('equal schema (fragment-store@1.0.0): clean read + clean write', () => {
  const dir = makeRepo('equal', 'fragment-store@1.0.0');
  const r = guardRead(dir, { toolingSchema: TOOLING });
  const w = assertWrite(dir, { toolingSchema: TOOLING });
  assert(r.ok === true && r.partial === false && r.warning === null, 'guardRead should be clean on equal schema');
  assert(w.ok === true && w.message === null, 'assertWrite should be clean on equal schema');
});

test('older major (fragment-store@0.9.0): clean read + clean write', () => {
  const dir = makeRepo('older', 'fragment-store@0.9.0');
  const r = guardRead(dir, { toolingSchema: TOOLING });
  const w = assertWrite(dir, { toolingSchema: TOOLING });
  assert(r.ok === true && r.partial === false && r.warning === null, 'guardRead should be clean on older major');
  assert(w.ok === true && w.message === null, 'assertWrite should be clean on older major');
});

// ── Section 4: major(data) > major(tooling) → partial read, refused write ─────
console.log('\nSection 4: major(data) > major(tooling)\n');

test('newer major (fragment-store@2.0.0): guardRead partial + warning', () => {
  const dir = makeRepo('newer', 'fragment-store@2.0.0');
  const r = guardRead(dir, { toolingSchema: TOOLING });
  assert(r.ok === true, 'ok should still be true (read never blocked)');
  assert(r.partial === true, 'partial should be true');
  assert(typeof r.warning === 'string' && r.warning.length > 0, 'warning should be a non-empty string');
});

test('newer major (fragment-store@2.0.0): assertWrite refused', () => {
  const dir = makeRepo('newer-write', 'fragment-store@2.0.0');
  const w = assertWrite(dir, { toolingSchema: TOOLING });
  assert(w.ok === false, 'ok should be false — write refused');
  assert(typeof w.message === 'string' && w.message.length > 0, 'message should be a non-empty string');
});

test('formatSchemaWarning cites dataSchema and toolingSchema', () => {
  const dir = makeRepo('newer-format', 'fragment-store@2.0.0');
  const res = checkSchemaDirection(dir, { toolingSchema: TOOLING });
  const msg = formatSchemaWarning(res);
  assert(msg.includes('fragment-store@2.0.0'), 'warning should cite dataSchema');
  assert(msg.includes(TOOLING), 'warning should cite toolingSchema');
});

// ── Section 5: minor/patch-only difference stays clean (major-only decision) ──
console.log('\nSection 5: only major decides (regression)\n');

test('minor+patch above but same major (fragment-store@1.9.9): clean both sides', () => {
  const dir = makeRepo('minor-patch', 'fragment-store@1.9.9');
  const r = guardRead(dir, { toolingSchema: TOOLING });
  const w = assertWrite(dir, { toolingSchema: TOOLING });
  assert(r.ok === true && r.partial === false && r.warning === null, 'guardRead must stay clean — same major');
  assert(w.ok === true && w.message === null, 'assertWrite must stay clean — same major');
});

test('cmpSemver still reports full-tuple comparison for reuse/compat', () => {
  assert(cmpSemver([1, 9, 9], [1, 0, 0]) === 1, 'cmpSemver should compare minor when major ties');
  assert(cmpSemver([1, 0, 0], [1, 0, 0]) === 0, 'cmpSemver should report equality');
  assert(cmpSemver([0, 9, 0], [1, 0, 0]) === -1, 'cmpSemver should compare major first');
});

test('parseSchemaSemver parses and rejects correctly', () => {
  const parsed = parseSchemaSemver('fragment-store@1.2.3');
  assert(Array.isArray(parsed) && parsed[0] === 1 && parsed[1] === 2 && parsed[2] === 3, 'should parse major/minor/patch');
  assert(parseSchemaSemver('lixo') === null, 'unparseable string should return null');
  assert(parseSchemaSemver('') === null, 'empty string should return null');
  assert(parseSchemaSemver(null) === null, 'null input should return null');
});

// ── Section 6: guardRead never throws ─────────────────────────────────────────
console.log('\nSection 6: guardRead never throws\n');

test('guardRead on nonexistent cwd does not throw', () => {
  const nonexistent = path.join(ROOT, 'does-not-exist-at-all', 'nested', 'deeper');
  let threw = false;
  let res;
  try {
    res = guardRead(nonexistent, { toolingSchema: TOOLING });
  } catch (_) {
    threw = true;
  }
  assert(threw === false, 'guardRead must not throw on a nonexistent cwd');
  assert(res && res.ok === true && res.partial === false, 'should degrade to a clean fail-open result');
});

test('assertWrite on nonexistent cwd does not throw', () => {
  const nonexistent = path.join(ROOT, 'also-missing', 'deep');
  let threw = false;
  let res;
  try {
    res = assertWrite(nonexistent, { toolingSchema: TOOLING });
  } catch (_) {
    threw = true;
  }
  assert(threw === false, 'assertWrite must not throw on a nonexistent cwd');
  assert(res && res.ok === true, 'should degrade to a clean fail-open result');
});

test('guardRead with malformed toolingSchema (garbage) still fail-opens', () => {
  const dir = makeRepo('malformed-tooling', 'fragment-store@2.0.0');
  const res = guardRead(dir, { toolingSchema: 'not-a-schema-string' });
  assert(res.ok === true && res.partial === false, 'unparseable tooling schema should also fail-open');
});

// ── Section 7: CLI ─────────────────────────────────────────────────────────────
console.log('\nSection 7: CLI\n');

const CLI_PATH = path.join(__dirname, 'forge-schema-guard.js');

test('CLI --check prints one-line JSON and exits 0 (clean repo)', () => {
  const dir = makeRepo('cli-clean', 'fragment-store@1.0.0');
  const result = spawnSync(process.execPath, [CLI_PATH, '--check', '--cwd', dir], { encoding: 'utf8' });
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  const lines = result.stdout.trim().split('\n');
  assert(lines.length === 1, 'stdout should be exactly one line of JSON');
  const parsed = JSON.parse(lines[0]);
  assert(parsed.ok === true, 'parsed JSON ok should be true');
  assert(parsed.ahead === false, 'parsed JSON ahead should be false for clean repo');
});

test('CLI --check exits 0 even when ahead:true (diagnostic, not a gate)', () => {
  const dir = makeRepo('cli-ahead', 'fragment-store@2.0.0');
  const result = spawnSync(process.execPath, [CLI_PATH, '--check', '--cwd', dir], { encoding: 'utf8' });
  assert(result.status === 0, `expected exit 0 even when ahead, got ${result.status}`);
  const parsed = JSON.parse(result.stdout.trim());
  assert(parsed.ahead === true, 'parsed JSON ahead should be true');
  assert(result.stderr.length > 0, 'warning should be written to stderr when ahead');
});

test('CLI with unknown arg exits 2', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, '--bogus'], { encoding: 'utf8' });
  assert(result.status === 2, `expected exit 2 for invalid args, got ${result.status}`);
});

test('CLI with no args exits 2', () => {
  const result = spawnSync(process.execPath, [CLI_PATH], { encoding: 'utf8' });
  assert(result.status === 2, `expected exit 2 when --check is missing, got ${result.status}`);
});

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}

fs.rmSync(ROOT, { recursive: true, force: true });
