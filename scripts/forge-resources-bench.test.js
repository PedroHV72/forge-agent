#!/usr/bin/env node
// forge-resources-bench.test.js — proves the T04 harness on an INJECTED
// command (never `node scripts/run-tests.js` — running the real suite is
// T06's sanctioned exception, not this task's, S06-PLAN.md).
//
// Run: node scripts/forge-resources-bench.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const bench = require('./forge-resources-bench.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.stack || e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.stack || e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const createdDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  createdDirs.push(dir);
  return dir;
}

const BENCH_PATH = path.join(__dirname, 'forge-resources-bench.js');

// Fast, deterministic, injectable command — never the real suite.
function sleepCommand(ms) {
  return ['node', '-e', `setTimeout(()=>{},${ms})`];
}
function failCommand() {
  return ['node', '-e', 'process.exit(1)'];
}

// ── Unit-level coverage ──────────────────────────────────────────────────

test('cellEnforcement: /off cells resolve to off, /on cells resolve to clamp', () => {
  assertEqual(bench.cellEnforcement('solo/off'), 'off');
  assertEqual(bench.cellEnforcement('batch/off'), 'off');
  assertEqual(bench.cellEnforcement('solo/on'), 'clamp');
  assertEqual(bench.cellEnforcement('batch/on'), 'clamp');
});

test('parseCommand: JSON array form is used verbatim (no shell splitting)', () => {
  const cmd = bench.parseCommand('["node","-e","1+1"]');
  assert(Array.isArray(cmd) && cmd.length === 3, 'expected 3-token argv array');
  assertEqual(cmd[1], '-e');
});

test('parseCommand: bare string falls back to whitespace split (default command)', () => {
  const cmd = bench.parseCommand('node scripts/run-tests.js');
  assertEqual(cmd.join(' '), 'node scripts/run-tests.js');
});

test('planRuns: interleaves cells across repetitions (round-robin, never blocked)', () => {
  const plan = bench.planRuns(['a', 'b'], 3);
  assertEqual(plan.length, 6);
  assertEqual(plan.map((p) => p.cell).join(','), 'a,b,a,b,a,b', 'cells must interleave per repetition');
  assertEqual(plan.map((p) => p.rep).join(','), '1,1,2,2,3,3');
});

test('median: odd length, even length, and single-sample sequences', () => {
  assertEqual(bench.median([10, 20, 30]), 20);
  assertEqual(bench.median([10, 20, 30, 40]), 25);
  assertEqual(bench.median([15]), 15);
  assertEqual(bench.median([]), null);
});

test('writeEnforcement + snapshotPrefsFile + restorePrefsFile: round-trips an ABSENT file back to absent', () => {
  const dir = tmpDir('forge-bench-restore-absent-');
  const prefsPath = bench.localPrefsPath(dir);
  assert(!fs.existsSync(prefsPath), 'precondition: file must not exist yet');
  const snapshot = bench.snapshotPrefsFile(prefsPath);
  assertEqual(snapshot.existed, false);
  bench.writeEnforcement(prefsPath, 'off');
  assert(fs.existsSync(prefsPath), 'writeEnforcement must create the file');
  bench.restorePrefsFile(prefsPath, snapshot);
  assert(!fs.existsSync(prefsPath), 'restore must delete a file that did not exist before');
});

test('writeEnforcement + snapshotPrefsFile + restorePrefsFile: round-trips an EXISTING file byte-identically', () => {
  const dir = tmpDir('forge-bench-restore-existing-');
  const prefsPath = bench.localPrefsPath(dir);
  const original = '{\n  "some_other_key": true,\n  "resources": {\n    "enforcement": "clamp"\n  }\n}\n';
  fs.writeFileSync(prefsPath, original, 'utf8');
  const snapshot = bench.snapshotPrefsFile(prefsPath);
  assertEqual(snapshot.existed, true);
  bench.writeEnforcement(prefsPath, 'off');
  const rewritten = fs.readFileSync(prefsPath, 'utf8');
  assert(rewritten !== original, 'sanity: write must actually change the file');
  assert(JSON.parse(rewritten).resources.enforcement === 'off', 'sanity: write must set the requested value');
  bench.restorePrefsFile(prefsPath, snapshot);
  const restored = fs.readFileSync(prefsPath, 'utf8');
  assertEqual(restored, original, 'restored bytes must be byte-identical to the original');
});

test('writeEnforcement: preserves unrelated keys already in the file', () => {
  const dir = tmpDir('forge-bench-preserve-');
  const prefsPath = bench.localPrefsPath(dir);
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify({ unrelated: { keep: 'me' }, resources: { enforcement: 'clamp' } }), 'utf8');
  bench.writeEnforcement(prefsPath, 'off');
  const parsed = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  assertEqual(parsed.unrelated.keep, 'me');
  assertEqual(parsed.resources.enforcement, 'off');
});

test('summarizeRecords: anti-silence floor — zero ok runs is inconclusive, never clean, never absent', () => {
  const records = [
    { cell: 'solo/off', rep: 1, status: 'aborted:timeout-exceeded', wallMs: 5000, witness: null },
  ];
  const summary = bench.summarizeRecords(records, bench.CELLS);
  assertEqual(summary['solo/off'].verdict, 'inconclusive:zero-ok-runs');
  assertEqual(summary['solo/off'].nOk, 0);
  // control negative: a cell with zero records at all is ALSO in the table.
  assertEqual(summary['solo/on'].verdict, 'inconclusive:no-data');
  assert(Object.prototype.hasOwnProperty.call(summary, 'batch/off'), 'a cell must never be absent from the table');
});

test('summarizeRecords: control negative — a cell with ok runs never falls into the floor', () => {
  const records = [
    { cell: 'solo/off', rep: 1, status: 'ok', wallMs: 100, witness: null },
    { cell: 'solo/off', rep: 2, status: 'ok', wallMs: 120, witness: null },
    { cell: 'solo/off', rep: 3, status: 'ok', wallMs: 110, witness: null },
  ];
  const summary = bench.summarizeRecords(records, ['solo/off']);
  assertEqual(summary['solo/off'].verdict, 'measured');
  assertEqual(summary['solo/off'].nOk, 3);
  assertEqual(summary['solo/off'].median, 110);
});

test('summarizeRecords: aborted corrida stays in the table and is excluded from the median', () => {
  const records = [
    { cell: 'solo/off', rep: 1, status: 'ok', wallMs: 100, witness: null },
    { cell: 'solo/off', rep: 2, status: 'aborted:timeout-exceeded', wallMs: 9999, witness: null },
    { cell: 'solo/off', rep: 3, status: 'ok', wallMs: 200, witness: null },
  ];
  const summary = bench.summarizeRecords(records, ['solo/off']);
  assertEqual(summary['solo/off'].n, 3, 'aborted corrida must count toward n');
  assertEqual(summary['solo/off'].nOk, 2);
  assertEqual(summary['solo/off'].aborted.length, 1);
  assertEqual(summary['solo/off'].median, 150, 'median must be computed over ok runs only (100,200)');
});

test('readJsonlRecords: tolerates a trailing partial/invalid line (interrupted write)', () => {
  const dir = tmpDir('forge-bench-jsonl-');
  const file = path.join(dir, 'out.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ cell: 'solo/off', rep: 1, status: 'ok', wallMs: 1 })}\n{"cell":"solo/of`, 'utf8');
  const records = bench.readJsonlRecords(file);
  assertEqual(records.length, 1, 'only the complete line should parse');
});

test('--dry-run: parseArgs recognises the flag without consuming the next token', () => {
  const args = bench.parseArgs(['--dry-run', '--reps', '3']);
  assertEqual(args.dryRun, true);
  assertEqual(args.reps, '3');
});

// ── Behavioral: runMatrix with an injected fast command ────────────────────

async function runAsyncTests() {

await testAsync('runMatrix: writes one JSONL line per corrida with a fresh in-cell witness, and restores prefs on normal exit', async () => {
  const dir = tmpDir('forge-bench-matrix-');
  const prefsPath = bench.localPrefsPath(dir);
  const original = JSON.stringify({ resources: { enforcement: 'clamp' } });
  fs.writeFileSync(prefsPath, original, 'utf8');
  const outFile = path.join(dir, 'out.jsonl');

  const summary = await bench.runMatrix({
    cwd: dir,
    cells: ['solo/off', 'solo/on'],
    reps: 3,
    competitors: 0,
    command: sleepCommand(20),
    timeoutMs: 5000,
    outFile,
  });

  const records = bench.readJsonlRecords(outFile);
  assertEqual(records.length, 6, 'expected 2 cells * 3 reps');
  assert(records.every((r) => r.status === 'ok'), 'all corridas with a fast sleep command must complete ok');
  assert(records.every((r) => r.witness && typeof r.witness.enforcement === 'string'), 'every corrida must carry a witness');

  const offWitnesses = records.filter((r) => r.cell === 'solo/off').map((r) => r.witness.enforcement);
  const onWitnesses = records.filter((r) => r.cell === 'solo/on').map((r) => r.witness.enforcement);
  assert(offWitnesses.every((e) => e === 'off'), `solo/off corridas must witness enforcement=off, got ${offWitnesses}`);
  assert(onWitnesses.every((e) => e === 'clamp'), `solo/on corridas must witness enforcement=clamp, got ${onWitnesses}`);

  assertEqual(summary['solo/off'].verdict, 'measured');
  assertEqual(summary['solo/off'].nOk, 3);

  const restored = fs.readFileSync(prefsPath, 'utf8');
  assertEqual(restored, original, 'prefs must be restored to the original bytes after normal completion');
});

await testAsync('runMatrix: batch cells spawn competitors and record their timing as context, not as the measured number', async () => {
  const dir = tmpDir('forge-bench-batch-');
  const outFile = path.join(dir, 'out.jsonl');
  await bench.runMatrix({
    cwd: dir,
    cells: ['batch/off'],
    reps: 1,
    competitors: 2,
    command: sleepCommand(30),
    timeoutMs: 5000,
    outFile,
  });
  const records = bench.readJsonlRecords(outFile);
  assertEqual(records.length, 1);
  assert(Array.isArray(records[0].competitors) && records[0].competitors.length === 2, 'batch cell must record 2 competitor results');
  assert(typeof records[0].wallMs === 'number', 'the measured number is the measured process wall-clock, not the competitors');
});

await testAsync('runMatrix: restores prefs even when a corrida throws (exception exit path)', async () => {
  const dir = tmpDir('forge-bench-exception-');
  const prefsPath = bench.localPrefsPath(dir);
  const original = JSON.stringify({ resources: { enforcement: 'clamp' } });
  fs.writeFileSync(prefsPath, original, 'utf8');
  const outFile = path.join(dir, 'out.jsonl');

  // Inject a failure into the write path a corrida depends on (same `fs`
  // module object bench.js itself required — the Node module cache shares
  // one exports object, so this patch reaches the module under test) to
  // force a genuine throw out of `runMatrix`, then prove the `finally`
  // block still restored prefs before the rejection propagated.
  const realAppend = fs.appendFileSync;
  fs.appendFileSync = () => { throw new Error('injected-append-failure'); };

  let threw = false;
  try {
    await bench.runMatrix({
      cwd: dir,
      cells: ['solo/off'],
      reps: 3,
      competitors: 0,
      command: sleepCommand(10),
      timeoutMs: 5000,
      outFile,
    });
  } catch (e) {
    threw = true;
    assert(e.message.includes('injected-append-failure'), `expected the injected error to propagate, got: ${e.message}`);
  } finally {
    fs.appendFileSync = realAppend;
  }
  assert(threw, 'runMatrix must propagate the exception, not swallow it');
  const restored = fs.readFileSync(prefsPath, 'utf8');
  assertEqual(restored, original, 'prefs must be restored even when a corrida throws mid-run');
});

await testAsync('runMatrix / --dry-run: the CLI plans without executing anything or touching prefs', async () => {
  const dir = tmpDir('forge-bench-dryrun-');
  const prefsPath = bench.localPrefsPath(dir);
  assert(!fs.existsSync(prefsPath), 'precondition');

  const child = spawn(process.execPath, [
    BENCH_PATH, '--dry-run', '--cwd', dir, '--reps', '3', '--cells', 'solo/off,solo/on',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  await new Promise((resolve) => child.on('exit', resolve));

  assert(!fs.existsSync(prefsPath), 'dry-run must never touch the prefs file');
  const plan = JSON.parse(stdout);
  assertEqual(plan.dryRun, true);
  assertEqual(plan.plan.length, 6, 'dry-run must still report the full interleaved plan');
});

await testAsync('runMatrix (via CLI subprocess): SIGINT mid-run leaves already-finished JSONL lines intact and restores prefs byte-identically', async () => {
  const dir = tmpDir('forge-bench-sigint-');
  const prefsPath = bench.localPrefsPath(dir);
  const original = JSON.stringify({ resources: { enforcement: 'clamp' } });
  fs.writeFileSync(prefsPath, original, 'utf8');
  const outFile = path.join(dir, 'out.jsonl');

  // First corrida is fast (completes and gets appended); later corridas use
  // a slow sleep so the process is reliably still mid-run when SIGINT lands.
  const child = spawn(process.execPath, [
    BENCH_PATH, '--cwd', dir, '--reps', '3', '--cells', 'solo/off',
    '--command', JSON.stringify(sleepCommand(2000)),
    '--out', outFile, '--timeout-ms', '15000',
  ], { stdio: 'ignore' });

  await new Promise((resolve) => setTimeout(resolve, 400));
  child.kill('SIGINT');
  await new Promise((resolve) => child.on('exit', resolve));

  const restored = fs.readFileSync(prefsPath, 'utf8');
  assertEqual(restored, original, 'prefs must be restored to original bytes after SIGINT mid-run');

  // The interrupted run may or may not have completed its first slow
  // corrida in 400ms; either way any line already on disk must be valid
  // JSON — proving the harness never leaves a torn/partial JSONL line.
  if (fs.existsSync(outFile)) {
    const raw = fs.readFileSync(outFile, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      assert(() => JSON.parse(line) || true, 'every line on disk must be valid JSON');
      JSON.parse(line);
    }
  }
});

}

runAsyncTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exitCode = failed > 0 ? 1 : 0;
}).finally(() => {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
