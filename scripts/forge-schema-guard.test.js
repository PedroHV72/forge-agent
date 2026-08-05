#!/usr/bin/env node
// forge-schema-guard.test.js — standalone test suite for forge-schema-guard.js
//
// Covers the locked decision table (CONTEXT § S01 guard):
//   - ABSENT SCHEMA-VERSION            → ok/ok, fail-open, no warning
//   - GARBAGE but readable content     → ok/ok, fail-open, no warning
//     ("lixo", empty, whitespace — present and parseable-by-nobody, but READ)
//   - UNREADABLE stamp (a directory in its place, chmod 000 on POSIX)
//                                      → read fail-open; WRITE REFUSED, errno
//                                        named in the message (PR #70 dogfood)
//   - major(data) <= major(tooling)    → clean read + clean write
//   - major(data) >  major(tooling)    → read ok + partial + warning;
//                                         write refused (ok:false + message)
//   - guardRead never throws (missing cwd, binary/empty SCHEMA-VERSION)
//   - only MAJOR decides — minor/patch-only difference stays clean
//   - CLI: --check prints one-line JSON, exit 0; unknown args exit 2
//
// NOTE ON NAMING: Section 2 used to be titled "unreadable content" while every
// case in it was readable garbage. That name advertised coverage that did not
// exist and is precisely what hid the write-guard hole for a whole review
// cycle. "Unreadable" now means one thing in this file: the read syscall fails.
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
// content === undefined  → no .gsd dir at all (truly absent).
// content === null       → .gsd dir exists but no SCHEMA-VERSION file.
// content === AS_DIRECTORY → .gsd/SCHEMA-VERSION exists AS A DIRECTORY, so any
//   readFileSync on it fails with EISDIR. This is the cross-platform way to
//   produce a genuinely unreadable stamp: it works identically on win32 and
//   POSIX (chmod 000 does NOT — see Section 8), and it is the exact shape the
//   PR #70 dogfood hit in the wild.
// content === <string>   → that content, written as a file.
const AS_DIRECTORY = Symbol('as-directory');

function makeRepo(name, content) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  if (content !== undefined) {
    const gsdDir = path.join(dir, '.gsd');
    fs.mkdirSync(gsdDir, { recursive: true });
    if (content === AS_DIRECTORY) {
      fs.mkdirSync(path.join(gsdDir, 'SCHEMA-VERSION'), { recursive: true });
    } else if (content !== null) {
      fs.writeFileSync(path.join(gsdDir, 'SCHEMA-VERSION'), content, 'utf8');
    }
  }
  return dir;
}

const TOOLING = require('./forge-doctor').CURRENT_SCHEMA;
const schema = (major, minor, patch) => `fragment-store@${major}.${minor}.${patch}`;

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

// ── Section 2: garbage/unparseable BUT READABLE content → fail-open ───────────
// Every fixture here is a file the guard reads successfully and nobody can
// parse. That is a different state from "unreadable" (Section 8): here the
// write is ALLOWED, because a repo whose stamp we read and did not understand
// is indistinguishable from an old repo, and blocking it would break them.
console.log('\nSection 2: garbage/unparseable (readable) content\n');

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

test('equal schema: clean read + clean write', () => {
  const dir = makeRepo('equal', TOOLING);
  const r = guardRead(dir, { toolingSchema: TOOLING });
  const w = assertWrite(dir, { toolingSchema: TOOLING });
  assert(r.ok === true && r.partial === false && r.warning === null, 'guardRead should be clean on equal schema');
  assert(w.ok === true && w.message === null, 'assertWrite should be clean on equal schema');
});

test('older major: clean read + clean write', () => {
  const dir = makeRepo('older', schema(0, 9, 0));
  const r = guardRead(dir, { toolingSchema: TOOLING });
  const w = assertWrite(dir, { toolingSchema: TOOLING });
  assert(r.ok === true && r.partial === false && r.warning === null, 'guardRead should be clean on older major');
  assert(w.ok === true && w.message === null, 'assertWrite should be clean on older major');
});

// ── Section 4: major(data) > major(tooling) → partial read, refused write ─────
console.log('\nSection 4: major(data) > major(tooling)\n');

test('newer major: guardRead partial + warning', () => {
  const dir = makeRepo('newer', schema(99, 0, 0));
  const r = guardRead(dir, { toolingSchema: TOOLING });
  assert(r.ok === true, 'ok should still be true (read never blocked)');
  assert(r.partial === true, 'partial should be true');
  assert(typeof r.warning === 'string' && r.warning.length > 0, 'warning should be a non-empty string');
});

test('newer major: assertWrite refused', () => {
  const dir = makeRepo('newer-write', schema(99, 0, 0));
  const w = assertWrite(dir, { toolingSchema: TOOLING });
  assert(w.ok === false, 'ok should be false — write refused');
  assert(typeof w.message === 'string' && w.message.length > 0, 'message should be a non-empty string');
});

test('formatSchemaWarning cites dataSchema and toolingSchema', () => {
  const dataSchema = schema(99, 0, 0);
  const dir = makeRepo('newer-format', dataSchema);
  const res = checkSchemaDirection(dir, { toolingSchema: TOOLING });
  const msg = formatSchemaWarning(res);
  assert(msg.includes(dataSchema), 'warning should cite dataSchema');
  assert(msg.includes(TOOLING), 'warning should cite toolingSchema');
});

// ── Section 5: minor/patch-only difference stays clean (major-only decision) ──
console.log('\nSection 5: only major decides (regression)\n');

test('minor+patch above but same major: clean both sides', () => {
  const current = parseSchemaSemver(TOOLING);
  const dir = makeRepo('minor-patch', schema(current[0], 9, 9));
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
  const parsed = parseSchemaSemver(schema(1, 2, 3));
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
  const dir = makeRepo('malformed-tooling', schema(99, 0, 0));
  const res = guardRead(dir, { toolingSchema: 'not-a-schema-string' });
  assert(res.ok === true && res.partial === false, 'unparseable tooling schema should also fail-open');
});

// ── Section 7: CLI ─────────────────────────────────────────────────────────────
console.log('\nSection 7: CLI\n');

const CLI_PATH = path.join(__dirname, 'forge-schema-guard.js');

test('CLI --check prints one-line JSON and exits 0 (clean repo)', () => {
  const dir = makeRepo('cli-clean', TOOLING);
  const result = spawnSync(process.execPath, [CLI_PATH, '--check', '--cwd', dir], { encoding: 'utf8' });
  assert(result.status === 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  const lines = result.stdout.trim().split('\n');
  assert(lines.length === 1, 'stdout should be exactly one line of JSON');
  const parsed = JSON.parse(lines[0]);
  assert(parsed.ok === true, 'parsed JSON ok should be true');
  assert(parsed.ahead === false, 'parsed JSON ahead should be false for clean repo');
});

test('CLI --check exits 0 even when ahead:true (diagnostic, not a gate)', () => {
  const dir = makeRepo('cli-ahead', schema(99, 0, 0));
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

// R3/R5 (review-fix S01): the CLI contract in the file header promises exit 2 for
// every invalid invocation. Unknown flags alongside --check, and a valueless
// --cwd (which would silently inspect a different repo), must not exit 0.
test('CLI --check --bogus exits 2 (unknown flag is not ignored)', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, '--check', '--bogus'], { encoding: 'utf8' });
  assert(result.status === 2, `expected exit 2 for unknown flag, got ${result.status}`);
});

test('CLI --check --cwd (no value) exits 2 instead of falling back to process.cwd()', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, '--check', '--cwd'], { encoding: 'utf8' });
  assert(result.status === 2, `expected exit 2 for valueless --cwd, got ${result.status}`);
  assert(result.stdout.trim() === '', 'no success JSON should be printed for an invalid invocation');
});

test('CLI --check with a positional argument exits 2', () => {
  const dir = makeRepo('cli-positional', TOOLING);
  const result = spawnSync(process.execPath, [CLI_PATH, '--check', dir], { encoding: 'utf8' });
  assert(result.status === 2, `expected exit 2 for positional arg, got ${result.status}`);
});

test('CLI valid forms still exit 0 (--check alone, and --check --cwd <dir>)', () => {
  const dir = makeRepo('cli-valid-forms', TOOLING);
  const bare = spawnSync(process.execPath, [CLI_PATH, '--check'], { encoding: 'utf8' });
  assert(bare.status === 0, `expected exit 0 for --check alone, got ${bare.status}: ${bare.stderr}`);
  const withCwd = spawnSync(process.execPath, [CLI_PATH, '--check', '--cwd', dir], { encoding: 'utf8' });
  assert(withCwd.status === 0, `expected exit 0 for --check --cwd <dir>, got ${withCwd.status}`);
});

// ── Section 8: UNREADABLE stamp → read fail-open, write REFUSED ───────────────
// The regression this section locks (PR #70 dogfood): `.gsd/SCHEMA-VERSION`
// existing as a DIRECTORY made every write guard pass silently, because the
// EISDIR was swallowed into `null` by the reader and then converted into
// `ahead: false`. Refusing here is the D1 decision: a guard that could not read
// the stamp knows nothing about direction, and "could not measure" is not
// evidence of safety.
console.log('\nSection 8: unreadable stamp (real read failure)\n');

// Sibling of hasWarning() in forge-schema-guard-wiring.test.js — the refusal
// message for this case has its own header on purpose, so it does NOT match
// /schema do Forge à frente da tooling local/ (it would be a false claim about
// a direction nobody measured).
const UNREADABLE_HEADER = /não pôde ser lido/;

test('stamp as a DIRECTORY: assertWrite refuses and names the errno', () => {
  const dir = makeRepo('unreadable-dir-write', AS_DIRECTORY);
  const w = assertWrite(dir, { toolingSchema: TOOLING });
  assert(w.ok === false, 'assertWrite must REFUSE when the stamp cannot be read');
  assert(typeof w.message === 'string' && UNREADABLE_HEADER.test(w.message),
    `message should use the unreadable-stamp header, got: ${w.message}`);
  assert(/EISDIR/.test(w.message), `message should name the errno, got: ${w.message}`);
  assert(!/à frente da tooling/.test(w.message),
    'refusal must NOT claim the data is ahead — direction was never measured');
  assert(!/\(null\)/.test(w.message), 'refusal must not interpolate a null dataSchema');
});

test('stamp as a DIRECTORY: guardRead stays fail-open (clean, no warning)', () => {
  const dir = makeRepo('unreadable-dir-read', AS_DIRECTORY);
  const r = guardRead(dir, { toolingSchema: TOOLING });
  assert(r.ok === true, 'guardRead ok should stay true');
  assert(r.partial === false, 'guardRead must not mark the read partial on an unreadable stamp');
  assert(r.warning === null, 'guardRead must stay silent — reading never breaks');
});

test('checkSchemaDirection reports unreadable + errno, and never claims ahead', () => {
  const dir = makeRepo('unreadable-dir-check', AS_DIRECTORY);
  const res = checkSchemaDirection(dir, { toolingSchema: TOOLING });
  assert(res.unreadable === true, 'unreadable should be true');
  assert(typeof res.errno === 'string' && res.errno.length > 0, 'errno should be a non-empty string');
  assert(res.ahead === false, 'ahead must stay false — direction was not measured');
  assert(res.dataSchema === null, 'dataSchema should be null when nothing could be read');
});

test('absent stamp is NOT unreadable — the write stays allowed (asymmetry pin)', () => {
  const absent = makeRepo('absent-not-unreadable', null);
  const res = checkSchemaDirection(absent, { toolingSchema: TOOLING });
  assert(res.unreadable === false, 'an absent stamp must never be reported as unreadable');
  assert(assertWrite(absent, { toolingSchema: TOOLING }).ok === true,
    'absence must keep writing — pre-stamp repos are legitimate');
  const garbage = makeRepo('garbage-not-unreadable', 'lixo');
  assert(checkSchemaDirection(garbage, { toolingSchema: TOOLING }).unreadable === false,
    'readable garbage must never be reported as unreadable');
  assert(assertWrite(garbage, { toolingSchema: TOOLING }).ok === true,
    'readable garbage must keep writing');
});

test('chmod 000 stamp: write refused (POSIX only — chmod is inert on win32)', () => {
  if (process.platform === 'win32') {
    console.log('      (skipped on win32: chmod 000 does not block reads there)');
    return;
  }
  const dir = makeRepo('unreadable-chmod', 'fragment-store@1.0.0');
  const stamp = path.join(dir, '.gsd', 'SCHEMA-VERSION');
  fs.chmodSync(stamp, 0o000);
  try {
    // Sanity: the fixture must actually make the read fail. Without this the
    // test would silently degrade into re-testing the happy path.
    let threw = false;
    try { fs.readFileSync(stamp, 'utf8'); } catch (_) { threw = true; }

    // Root reads a mode-000 file just fine, so under an elevated identity
    // (Linux containers, a dev running as root) the fixture cannot produce
    // EACCES at all — the precondition is unmeetable, not violated. Report
    // that out loud and stop, rather than failing on a fixture that this
    // environment is incapable of building. This is NOT a silent skip: the
    // line is printed, and the primary unreadable-stamp coverage is the
    // AS_DIRECTORY case above, which is cross-platform AND privilege-
    // independent. Raised as R2 by the codex challenger on the PR #70
    // dogfood, arbitrated by the operator.
    if (!threw) {
      console.log('      (skipped: chmod 000 is still readable — running as root, EACCES unreachable here)');
      return;
    }

    const w = assertWrite(dir, { toolingSchema: TOOLING });
    assert(w.ok === false, 'assertWrite must refuse on a permission-denied stamp');
    assert(UNREADABLE_HEADER.test(w.message), `expected the unreadable header, got: ${w.message}`);

    const r = guardRead(dir, { toolingSchema: TOOLING });
    assert(r.ok === true && r.partial === false && r.warning === null,
      'guardRead must stay fail-open on a permission-denied stamp');
  } finally {
    fs.chmodSync(stamp, 0o644);
  }
});

test('CLI --check reports unreadable:true with the errno, still exit 0 (diagnostic)', () => {
  const dir = makeRepo('cli-unreadable', AS_DIRECTORY);
  const result = spawnSync(process.execPath, [CLI_PATH, '--check', '--cwd', dir], { encoding: 'utf8' });
  assert(result.status === 0, `--check is diagnostic, expected exit 0, got ${result.status}`);
  const parsed = JSON.parse(result.stdout.trim());
  assert(parsed.unreadable === true, 'CLI JSON should expose unreadable:true');
  assert(typeof parsed.errno === 'string' && parsed.errno.length > 0, 'CLI JSON should expose the errno');
  assert(parsed.ahead === false, 'CLI JSON ahead should stay false');
  assert(UNREADABLE_HEADER.test(result.stderr), `expected the refusal text on stderr, got: ${result.stderr}`);
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
