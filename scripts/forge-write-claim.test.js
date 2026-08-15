#!/usr/bin/env node
'use strict';

// forge-write-claim.test.js — the claim never lies about what it is.
//
// Properties this suite carries (mirroring forge-touch.test.js's structure,
// the direct precedent T01 composes on top of):
//
//   R1  a RunRecord written before `write_claim` existed reads as
//       `write_claim: null`, and the file's sha256 is UNCHANGED by the read
//       (additive by READ, no migration).
//   R2  `readClaim(recSemClaim) === null` and `readClaim(recComPathsVazio)`
//       is a distinct object — never collapsed.
//   R3  `code_dir` is a GIVEN fact: absent `--code-dir` -> `code_dir: null`,
//       never derived from root/branch/isolation_mode.
//   R4  `recordClaim` is the ONLY function that writes — `normalizeClaim`
//       and `readClaim` never touch disk, proved by sha256 before/after.
//   R5  paths are normalized via the IMPORTED `normalizePath` — `src\a.ts`
//       and `src/a.ts` land identical.
//   R6  `CLAIM_SOURCES` is a closed set, cross-checked in BOTH directions.
//   R7  the CLI is proved by SPAWN (never in-process call), exit 0 on the
//       success paths.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-write-claim.js');
const claimMod = require('./forge-write-claim.js');
const { normalizeClaim, recordClaim, readClaim, clearClaim, CLAIM_SOURCES } = claimMod;
const runs = require('./forge-runs.js');

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
    throw new Error(`${msg || 'mismatch'}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
  }
}

const tmps = [];
function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-claim-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Fixture wired the same shape as forge-touch.test.js's `makeFixture` —
 * `.gsd/forge/runs/<id>.json` under a synthetic workspace, no real HOME
 * touched.
 */
function makeFixture(runId, extraRun) {
  const tmp = mktmp();
  const wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(wsDir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');

  const runFile = path.join(wsDir, '.gsd', 'forge', 'runs', `${runId}.json`);
  writeJson(runFile, Object.assign({
    kind: 'milestone',
    id: runId,
    session_id: 'sess-fixture',
    active: true,
    started_at: 1785763253000,
    last_heartbeat: 1785763253000,
    worker: null,
    worker_started: null,
    isolation_mode: 'branch',
    milestone_dir: `.gsd/milestones/${runId}/`,
    cwd: wsDir,
  }, extraRun || {}));

  return { wsDir, runFile };
}

function runCli(args) {
  const res = spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// ── R1: legacy record reads as null, sha256 unchanged by the read ──────────
test('R1: legacy record (no write_claim) reads as null, sha256 unchanged by read', () => {
  const { wsDir, runFile } = makeFixture('M-20260813-legacy');
  const before = sha256(runFile);
  const rec = runs.get(wsDir, 'M-20260813-legacy');
  assertEqual(rec.write_claim, null, 'legacy record must default write_claim to null');
  const after = sha256(runFile);
  assertEqual(after, before, 'reading a legacy record must not rewrite it (sha256 must match)');
});

// ── R2: null (never claimed) vs { paths: [] } (claimed, empty) never collapse
test('R2: readClaim distinguishes null (never claimed) from claimed-empty', () => {
  const { wsDir } = makeFixture('M-20260813-r2');
  const recNever = runs.get(wsDir, 'M-20260813-r2');
  assertEqual(readClaim(recNever), null, 'never-claimed run must read as null');

  recordClaim(wsDir, 'M-20260813-r2', { unit: 'execute-task/T01', source: 'manual', paths: [] });
  const recClaimed = runs.get(wsDir, 'M-20260813-r2');
  const claim = readClaim(recClaimed);
  assert(claim !== null, 'claimed-empty run must not read as null');
  assert(Array.isArray(claim.paths) && claim.paths.length === 0, 'claimed-empty must carry paths: []');
});

// ── R3: code_dir is GIVEN, never derived ────────────────────────────────────
test('R3: code_dir absent from input -> null, never derived', () => {
  const { wsDir } = makeFixture('M-20260813-r3');
  const claim = recordClaim(wsDir, 'M-20260813-r3', { unit: 'execute-task/T01', source: 'manual' });
  assertEqual(claim.code_dir, null, 'code_dir must be null when not given, never derived from root/branch');
});

test('R3b: code_dir given is recorded verbatim', () => {
  const { wsDir } = makeFixture('M-20260813-r3b');
  const claim = recordClaim(wsDir, 'M-20260813-r3b', {
    unit: 'execute-task/T01', source: 'manual', code_dir: '/tmp/some/code-dir',
  });
  assertEqual(claim.code_dir, '/tmp/some/code-dir', 'code_dir must be recorded exactly as given');
});

// ── R4: recordClaim is the ONLY function that writes ────────────────────────
test('R4: normalizeClaim never touches disk', () => {
  const { runFile } = makeFixture('M-20260813-r4a');
  const before = sha256(runFile);
  normalizeClaim({ unit: 'execute-task/T01', source: 'manual', paths: ['a.js'] });
  const after = sha256(runFile);
  assertEqual(after, before, 'normalizeClaim must be pure — no disk writes');
});

test('R4: readClaim never touches disk', () => {
  const { wsDir, runFile } = makeFixture('M-20260813-r4b');
  recordClaim(wsDir, 'M-20260813-r4b', { unit: 'execute-task/T01', source: 'manual', paths: ['a.js'] });
  const before = sha256(runFile);
  const rec = runs.get(wsDir, 'M-20260813-r4b');
  readClaim(rec);
  readClaim(rec);
  const after = sha256(runFile);
  assertEqual(after, before, 'readClaim must never write');
});

// ── R5: paths normalized via imported normalizePath ─────────────────────────
test('R5: backslash and forward-slash paths normalize identically', () => {
  const { wsDir } = makeFixture('M-20260813-r5a');
  const claimA = recordClaim(wsDir, 'M-20260813-r5a', {
    unit: 'execute-task/T01', source: 'manual', paths: ['src\\a.ts'],
  });
  const { wsDir: wsDir2 } = makeFixture('M-20260813-r5b');
  const claimB = recordClaim(wsDir2, 'M-20260813-r5b', {
    unit: 'execute-task/T01', source: 'manual', paths: ['src/a.ts'],
  });
  assertEqual(claimA.paths[0], claimB.paths[0], 'src\\a.ts and src/a.ts must normalize to the same path');
  assertEqual(claimA.paths[0], 'src/a.ts');
});

// ── R6: CLAIM_SOURCES closed set, cross-checked both directions ────────────
const sourcesSeen = new Set();
test('R6a: every declared CLAIM_SOURCES entry is accepted by normalizeClaim', () => {
  for (const source of CLAIM_SOURCES) {
    const claim = normalizeClaim({ unit: 'execute-task/T01', source, paths: [] });
    assertEqual(claim.source, source, `source ${source} must round-trip through normalizeClaim`);
    sourcesSeen.add(source);
  }
});
test('R6b: an unknown source is rejected, never recorded', () => {
  let threw = false;
  let message = '';
  try {
    normalizeClaim({ unit: 'execute-task/T01', source: 'chute', paths: [] });
  } catch (e) {
    threw = true;
    message = e.message;
  }
  assert(threw, 'unknown source must throw');
  assert(message.includes('chute'), 'error message must name the rejected value');
});
test('R6c: CLAIM_SOURCES cross-check — every listed source was exercised above', () => {
  for (const source of CLAIM_SOURCES) {
    assert(sourcesSeen.has(source), `CLAIM_SOURCES entry ${source} was never exercised by a test`);
  }
  assertEqual(sourcesSeen.size, CLAIM_SOURCES.length, 'no test exercised a source outside CLAIM_SOURCES');
});

// ── clearClaim resets to null ───────────────────────────────────────────────
test('clearClaim resets a claimed run back to null', () => {
  const { wsDir } = makeFixture('M-20260813-clear');
  recordClaim(wsDir, 'M-20260813-clear', { unit: 'execute-task/T01', source: 'manual', paths: ['a.js'] });
  clearClaim(wsDir, 'M-20260813-clear');
  const rec = runs.get(wsDir, 'M-20260813-clear');
  assertEqual(readClaim(rec), null, 'clearClaim must reset write_claim to null');
});

// ── R7: CLI proved by SPAWN ──────────────────────────────────────────────
test('R7a: CLI --claim spawns, exits 0, --json parses', () => {
  const { wsDir } = makeFixture('M-20260813-cli-claim');
  const res = runCli(['--claim', 'M-20260813-cli-claim', '--unit', 'execute-task/T01',
    '--source', 'manual', '--paths', 'a.js,b.js', '--json', '--cwd', wsDir]);
  assertEqual(res.status, 0, `--claim must exit 0, stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assertEqual(parsed.unit, 'execute-task/T01');
  assert(Array.isArray(parsed.paths) && parsed.paths.length === 2, 'claim must carry the two paths given');
});

test('R7b: CLI --show spawns, exits 0, --json parses the recorded claim', () => {
  const { wsDir } = makeFixture('M-20260813-cli-show');
  recordClaim(wsDir, 'M-20260813-cli-show', { unit: 'execute-task/T01', source: 'manual', paths: ['x.js'] });
  const res = runCli(['--show', 'M-20260813-cli-show', '--json', '--cwd', wsDir]);
  assertEqual(res.status, 0, `--show must exit 0, stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assertEqual(parsed.unit, 'execute-task/T01');
});

test('R7c: CLI --show spawns, exits 0, --json prints null for a never-claimed run', () => {
  const { wsDir } = makeFixture('M-20260813-cli-shownull');
  const res = runCli(['--show', 'M-20260813-cli-shownull', '--json', '--cwd', wsDir]);
  assertEqual(res.status, 0, `--show must exit 0, stderr=${res.stderr}`);
  assertEqual(JSON.parse(res.stdout), null, 'never-claimed run must print JSON null');
});

test('R7d: CLI --clear spawns, exits 0, resets the claim', () => {
  const { wsDir } = makeFixture('M-20260813-cli-clear');
  recordClaim(wsDir, 'M-20260813-cli-clear', { unit: 'execute-task/T01', source: 'manual', paths: ['x.js'] });
  const res = runCli(['--clear', 'M-20260813-cli-clear', '--json', '--cwd', wsDir]);
  assertEqual(res.status, 0, `--clear must exit 0, stderr=${res.stderr}`);
  const rec = runs.get(wsDir, 'M-20260813-cli-clear');
  assertEqual(readClaim(rec), null, 'after --clear the run must read as unclaimed');
});

test('R7e: CLI rejects an unknown source, non-zero exit, no write', () => {
  const { wsDir, runFile } = makeFixture('M-20260813-cli-badsource');
  const before = sha256(runFile);
  const res = runCli(['--claim', 'M-20260813-cli-badsource', '--unit', 'execute-task/T01',
    '--source', 'chute', '--cwd', wsDir]);
  assert(res.status !== 0, 'unknown source must produce a non-zero exit');
  const after = sha256(runFile);
  assertEqual(after, before, 'a rejected claim must never write to the run file');
});

// ── Mordida obrigatória (Step 6 of T01-PLAN) ────────────────────────────────
// Reverts withAddressDefaults' write_claim default in forge-runs.js, shows
// the assert that goes red nominally, restores. Uses a disposable sibling
// copy so the original module is never touched mid-suite.
test('mordida: withAddressDefaults default removed -> legacy read no longer null', () => {
  const runsSrcPath = path.join(__dirname, 'forge-runs.js');
  const src = fs.readFileSync(runsSrcPath, 'utf8');
  const marker = "write_claim: (rec.write_claim === undefined || rec.write_claim === '') ? null : rec.write_claim,";
  assert(src.includes(marker), 'expected write_claim default line not found in forge-runs.js — mordida cannot run');

  const baited = src.replace(marker, '');
  // Baited copy must live NEXT TO its relative deps (./forge-ids.js,
  // ./forge-lock.js, ./forge-runtime.js) to resolve — a disposable sibling
  // in scripts/, not an unrelated tmpdir.
  const baitPath = path.join(__dirname, `.forge-runs-bait-${process.pid}.js`);
  fs.writeFileSync(baitPath, baited, 'utf8');

  delete require.cache[require.resolve(baitPath)];
  const baitedRuns = require(baitPath);

  const { wsDir } = makeFixture('M-20260813-mordida');
  const rec = baitedRuns.get(wsDir, 'M-20260813-mordida');

  let biteFailed = false;
  try {
    assertEqual(rec.write_claim, null, 'baited module: legacy record should read write_claim as null');
  } catch (e) {
    biteFailed = true;
  }
  assert(biteFailed, 'mordida did not bite: removing the default should have made this assert fail');

  delete require.cache[require.resolve(baitPath)];
  try { fs.unlinkSync(baitPath); } catch { /* best effort */ }
});

// ── Suite close ──────────────────────────────────────────────────────────
cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
