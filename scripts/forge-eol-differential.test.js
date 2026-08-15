#!/usr/bin/env node
'use strict';

/*
 * Paired, bite-proven coverage for forge-eol-differential.js.
 *
 * The EOL-sensitive files in this suite are deliberately created with byte
 * escapes at runtime.  A checked-in CRLF fixture would be normalized by a
 * checkout and would test the repository's EOL policy instead of the reader.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const differential = require('./forge-eol-differential');
const preload = require('./forge-eol-preload');
const { classify, parseSuiteOutput, reconcileBuckets } = differential._private;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-eol-differential-test-'));
const SCRIPT_DIR = __dirname;
const DIFFERENTIAL = path.join(SCRIPT_DIR, 'forge-eol-differential.js');
const PRELOAD = path.join(SCRIPT_DIR, 'forge-eol-preload.js');
const fixtureNames = [];
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error: error.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${error.message}`);
  }
}

function equal(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
}

function sanitizedEnv(extra) {
  const env = { ...process.env, ...extra };
  // This suite is also run as a child of the full-tree differential in T04.
  delete env.NODE_OPTIONS;
  delete env.FORGE_EOL_MODE;
  delete env.FORGE_EOL_TRACE_FILE;
  return env;
}

function writeFixture(name, content) {
  const filename = path.join(SCRIPT_DIR, name);
  fs.writeFileSync(filename, content, 'utf8');
  fixtureNames.push(filename);
  return filename;
}

function writeData(name, bytes) {
  const filename = path.join(SCRIPT_DIR, name);
  fs.writeFileSync(filename, Buffer.from(bytes));
  fixtureNames.push(filename);
  return filename;
}

function runNode(filename, args, extraEnv) {
  const result = spawnSync(process.execPath, [filename, ...(args || [])], {
    cwd: path.resolve(SCRIPT_DIR, '..'),
    env: sanitizedEnv(extraEnv),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function runDifferential(args) {
  const result = runNode(DIFFERENTIAL, args, {});
  let json;
  try {
    json = JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
  } catch (error) {
    throw new Error(`differential did not emit JSON: ${error.message}\n${result.stdout}\n${result.stderr}`);
  }
  return { ...result, json };
}

function makeFixtures() {
  const data = writeData('forge-eol-fixture-data.txt', Buffer.from('header\nbody\n', 'utf8'));
  const binary = writeData('forge-eol-fixture-binary.bin', [0x41, 0x0d, 0x0a, 0x00, 0xff, 0x0a]);
  const dataLiteral = JSON.stringify(data);
  const binaryLiteral = JSON.stringify(binary);

  const positive = writeFixture('forge-eol-fixture-positive.test.js', `
'use strict';
const fs = require('fs');
const data = fs.readFileSync(${dataLiteral}, 'utf8');
const ok = data.includes('header\\nbody\\n');
if (!ok) console.log('  ✗ LF-anchored-data-parse');
else console.log('  ✓ LF-anchored-data-parse');
console.log('1 passed, ' + (ok ? '0' : '1') + ' failed');
process.exitCode = ok ? 0 : 1;
`);

  const mixed = writeFixture('forge-eol-fixture-mixed.test.js', `
'use strict';
const fs = require('fs');
const data = fs.readFileSync(${dataLiteral}, 'utf8');
const flipped = data.includes('header\\nbody\\n');
const stable = false;
if (flipped) console.log('  ✓ D8-eol-assert'); else console.log('  ✗ D8-eol-assert');
if (stable) console.log('  ✓ D8-stable-assert'); else console.log('  ✗ D8-stable-assert');
console.log('0 passed, ' + (flipped ? '1' : '2') + ' failed');
process.exitCode = flipped ? 1 : 1;
`);

  const observed = writeFixture('forge-eol-fixture-observed.test.js', `
'use strict';
const fs = require('fs');
fs.promises.readFile(${dataLiteral}, 'utf8').then(value => {
  const ok = value.includes('header');
  if (ok) console.log('  ✓ B1-observed-read'); else console.log('  ✗ B1-observed-read');
  console.log('1 passed, ' + (ok ? '0' : '1') + ' failed');
  process.exitCode = ok ? 0 : 1;
});
`);

  // R1 bite: a harness that prints a failing assert and still exits 0.
  const falseClean = writeFixture('forge-eol-fixture-false-clean.test.js', `
'use strict';
console.log('  ✗ green-exit-with-failing-assert');
console.log('0 passed, 1 failed');
process.exitCode = 0;
`);

  // R4 bite: a suite that outlives the timeout under test.  The self-kill is a
  // safety net: if this file is ever orphaned by an interrupted run it must not
  // hang the tree's own runner forever.
  const hang = writeFixture('forge-eol-fixture-hang.test.js', `
'use strict';
const held = setInterval(() => {}, 1000);
setTimeout(() => clearInterval(held), 60000);
`);

  const binaryReader = writeFixture('forge-eol-fixture-binary-reader.js', `
'use strict';
const fs = require('fs');
process.stdout.write(fs.readFileSync(${binaryLiteral}).toString('base64') + '\\n');
`);
  return { data, binary, positive, mixed, observed, falseClean, hang, binaryReader };
}

const fixtures = makeFixtures();
const positiveMatch = path.basename(fixtures.positive, '.js');
const mixedMatch = path.basename(fixtures.mixed, '.js');
const observedMatch = path.basename(fixtures.observed, '.js');
const falseCleanMatch = path.basename(fixtures.falseClean, '.js');
const hangMatch = path.basename(fixtures.hang, '.js');

console.log('\n=== forge-eol-differential.js — paired bite suite ===\n');

console.log('D9 — parser and classifier');
test('D9-parse: stderr-only failures are extracted', () => {
  const parsed = parseSuiteOutput({ stdout: '', stderr: '  ✗ stderr-assert\n1 passed, 1 failed\n', exitCode: 1 });
  equal(parsed.parseOk, true);
  equal(parsed.failedAsserts, ['stderr-assert']);
});

test('D9-parse: duplicated recap is deduplicated and reconciled', () => {
  const parsed = parseSuiteOutput({
    stdout: '  ✗ duplicate: first error\n  ✗ other\n',
    stderr: '  ✗ duplicate: recap error\n0 passed, 2 failed\n',
    exitCode: 1,
  });
  equal(parsed.parseOk, true);
  equal(parsed.failedAsserts, ['duplicate', 'other']);
});

test('D9-parse: missing summary is output-not-parseable', () => {
  const parsed = parseSuiteOutput({ stdout: '  ✗ no-summary\n', stderr: '', exitCode: 1 });
  equal(parsed.parseOk, false);
  equal(parsed.reason, 'output-not-parseable');
});

test('D9-parse: summary mismatch is assert-parse-mismatch', () => {
  const parsed = parseSuiteOutput({ stdout: '  ✗ one\n0 passed, 2 failed\n', stderr: '', exitCode: 1 });
  equal(parsed.parseOk, false);
  equal(parsed.reason, 'assert-parse-mismatch');
});

test('D9-parse: red parse failure is unproven, never stable', () => {
  const verdict = classify({
    lf: { exit: 1, parse_ok: false, failed_asserts: [], reason: 'output-not-parseable' },
    crlf: { exit: 1, parse_ok: true, failed_asserts: ['x'] },
  }, null, []);
  equal(verdict.bucket, 'unproven');
  assert.notStrictEqual(verdict.bucket, 'stable');
});

console.log('\nR1 — a zero exit is not evidence of cleanliness');
test('R1-parse: green exit with a failing assert is exit-contradicts-asserts', () => {
  const parsed = parseSuiteOutput({ stdout: '  ✗ green-lie\n0 passed, 1 failed\n', stderr: '', exitCode: 0 });
  equal(parsed.parseOk, false);
  equal(parsed.reason, 'exit-contradicts-asserts');
});

test('R1-parse: green exit whose summary counts failures is contradictory too', () => {
  const parsed = parseSuiteOutput({ stdout: '3 passed, 2 failed\n', stderr: '', exitCode: 0 });
  equal(parsed.parseOk, false);
  equal(parsed.reason, 'exit-contradicts-asserts');
});

test('R1-classify: pass-pass may not reach stable while parse_ok is false', () => {
  const verdict = classify({
    lf: { exit: 0, parse_ok: false, failed_asserts: [], reason: 'exit-contradicts-asserts' },
    crlf: { exit: 0, parse_ok: false, failed_asserts: [], reason: 'exit-contradicts-asserts' },
  }, null, []);
  equal(verdict.bucket, 'unproven');
  equal(verdict.reason, 'exit-contradicts-asserts');
});

test('R1-end-to-end: a green suite printing ✗ is unproven, never stable', () => {
  const result = runDifferential(['--json', '--match', falseCleanMatch]);
  equal(result.status, 0);
  equal(result.json.stable, []);
  equal(result.json.confirmed, []);
  equal(result.json.unproven.length, 1);
  equal(result.json.unproven[0].reason, 'exit-contradicts-asserts');
});

console.log('\nR2 — a lone \\r is not a line terminator');
test('R2: a standalone \\r survives both arms unchanged', () => {
  const { transformedText } = preload._private;
  const spinner = 'progress 10%\rprogress 20%\nnext\n';
  equal(transformedText(spinner, 'lf'), 'progress 10%\rprogress 20%\nnext\n');
  equal(transformedText(spinner, 'crlf'), 'progress 10%\rprogress 20%\r\nnext\r\n');
  // Only the CRLF pair moves between the arms.
  equal(transformedText('a\r\nb\n', 'lf'), 'a\nb\n');
  equal(transformedText('a\r\nb\n', 'crlf'), 'a\r\nb\r\n');
});

console.log('\nR3 — containment holds across devices');
test('R3: a different drive/root is outside the repository', () => {
  const { isOutsideRepository } = differential._private;

  // Platform-independent half: a path under the repo is inside, and the real
  // temp directory — which is genuinely elsewhere on every platform — is not.
  assert.strictEqual(isOutsideRepository(path.join(SCRIPT_DIR, 'state.jsonl')), false);
  assert.strictEqual(isOutsideRepository(path.join(os.tmpdir(), 'state.jsonl')), true);

  // The drive-letter half is Windows-only, and the previous version asserted it
  // unconditionally on the claim that "the Windows-style path parses with a root
  // that differs from '/'" on POSIX. It does not: POSIX has exactly one root, so
  // `D:\forge-eol-temp\state.jsonl` is a perfectly legal RELATIVE filename and
  // path.resolve puts it INSIDE the repo. Answering "inside" there is correct,
  // not a containment hole — so the assert was demanding the wrong answer and
  // failed on macOS and ubuntu alike.
  if (process.platform === 'win32') {
    assert.strictEqual(isOutsideRepository('D:\\forge-eol-temp\\state.jsonl'), true);
  } else {
    assert.strictEqual(isOutsideRepository('D:\\forge-eol-temp\\state.jsonl'), false,
      'on POSIX this is a relative filename resolved inside the repo, not another drive');
  }
});

console.log('\nR4 — a suite that never finished was not proven clean');
test('R4: a hung suite is unproven with a named timeout reason', () => {
  const result = runDifferential(['--json', '--timeout', '1500', '--match', hangMatch]);
  equal(result.status, 0);
  equal(result.json.stable, []);
  equal(result.json.unproven.length, 1);
  assert(/^suite-timed-out:/.test(result.json.unproven[0].reason), `unexpected reason: ${result.json.unproven[0].reason}`);
  // The timeout reason reconciles with the bucket census like any other.
  assert.strictEqual(reconcileBuckets(result.json), true);
});

console.log('\nD8 — mixed cause and reproduction');
test('D8-mixed: one flipped assert plus one stable failure is confirmed', () => {
  const result = runDifferential(['--json', '--match', mixedMatch]);
  equal(result.status, 0);
  equal(result.json.confirmed.length, 1);
  equal(result.json.confirmed[0].asserts_flipped, ['D8-eol-assert']);
  equal(result.json.confirmed[0].asserts_stable_failing, ['D8-stable-assert']);
});

test('D8-mixed: exit-code-only classification is a red regression', () => {
  const pair = { lf: { exit: 1, parse_ok: true, failed_asserts: ['stable'] }, crlf: { exit: 1, parse_ok: true, failed_asserts: ['flip', 'stable'] } };
  const exitOnly = pair.lf.exit !== 0 && pair.crlf.exit !== 0 ? 'stable' : 'different';
  assert.strictEqual(exitOnly, 'stable');
  assert.notStrictEqual(exitOnly, 'confirmed', 'the intentionally weakened classifier loses D8');
});

console.log('\nB2 — binary invariant');
test('B2: Buffer reads are byte-identical in LF and CRLF modes', () => {
  const expected = fs.readFileSync(fixtures.binary).toString('base64');
  for (const mode of ['lf', 'crlf']) {
    const result = runNode(fixtures.binaryReader, [], {
      FORGE_EOL_MODE: mode,
      NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}`,
    });
    equal(result.status, 0);
    equal(result.stdout.trim(), expected);
  }
});

console.log('\nB1 — observed but not intercepted');
test('B1: an observed read API is unproven, never stable', () => {
  const result = runDifferential(['--json', '--match', observedMatch]);
  equal(result.status, 0);
  equal(result.json.confirmed.length, 0);
  equal(result.json.unproven[0].reason, 'read-api-not-intercepted:fs.promises.readFile');
  assert.strictEqual(result.json.stable.length, 0);
});

console.log('\nW3 and anti-silence floor');
test('W3: buckets are disjoint, exhaustive, and reconcile', () => {
  const value = {
    suites_executed: 3,
    confirmed: [{ suite: 'a' }],
    stable: [{ suite: 'b' }],
    unproven: [{ suite: 'c' }],
  };
  const suites = ['confirmed', 'stable', 'unproven'].flatMap(bucket => value[bucket].map(item => item.suite));
  equal(new Set(suites).size, value.suites_executed);
  equal(suites.sort(), ['a', 'b', 'c']);
  assert.strictEqual(reconcileBuckets(value), true);
  assert.strictEqual(reconcileBuckets({ ...value, stable: [{ suite: 'b' }, { suite: 'b' }] }), false);
  assert.strictEqual(reconcileBuckets({ ...value, unproven: [] }), false);
});

test('W3: duplicated result makes the CLI exit 1 with reconciliation-failed', () => {
  const result = runDifferential(['--json', '--match', positiveMatch, '--inject-reconciliation-failure']);
  equal(result.status, 1);
  equal(result.json.error, 'reconciliation-failed');
});

test('floor: impossible --match exits 1 with no-suites-executed', () => {
  const result = runDifferential(['--json', '--match', 'forge-eol-no-such-suite-9f4a']);
  equal(result.status, 1);
  equal(result.json.error, 'no-suites-executed');
});

console.log('\nW1 — positive fixture and negative control');
test('positive: LF-anchored fixture flips and is reproduced', () => {
  const result = runDifferential(['--json', '--match', positiveMatch]);
  equal(result.status, 0);
  equal(result.json.confirmed.length, 1);
  equal(result.json.confirmed[0].asserts_flipped, ['LF-anchored-data-parse']);
});

test('control: the same fixture has no confirmed finding without preload', () => {
  const result = runDifferential(['--json', '--control', '--match', positiveMatch]);
  equal(result.status, 0);
  equal(result.json.confirmed, []);
});

console.log('\npreload — mode invariance and API contract');
test('preload is inert without FORGE_EOL_MODE', () => {
  const result = runNode(fixtures.binaryReader, [], { NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}` });
  equal(result.status, 0);
  equal(result.stdout.trim(), fs.readFileSync(fixtures.binary).toString('base64'));
});

test('preload exposes the observed/intercepted API sets used by classifier', () => {
  assert(preload.INTERCEPTED_APIS.includes('fs.readFileSync'));
  assert(preload.OBSERVED_APIS.includes('fs.promises.readFile'));
});

// S01 R5: the fingerprint guard must not abort a sweep because an unrelated
// background build rewrote an ignored path — while keeping the stronger
// whole-tree invariant reachable behind an explicit opt-in.
function gitFixtureRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-eol-fingerprint-'));
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (git('init').status !== 0) return null;
  fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n', 'utf8');
  fs.mkdirSync(path.join(repo, 'build'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'build', 'artifact.bin'), 'first\n', 'utf8');
  return repo;
}

const fingerprintRepo = gitFixtureRepo();

test('fingerprint ignores .gitignored churn by default', () => {
  assert(fingerprintRepo, 'git could not initialise a fixture repository');
  const before = differential._private.fingerprint(fingerprintRepo);
  fs.writeFileSync(path.join(fingerprintRepo, 'build', 'artifact.bin'), 'rebuilt-by-a-background-build\n', 'utf8');
  assert.strictEqual(differential._private.fingerprint(fingerprintRepo), before,
    'an ignored artifact rewrite changed the default fingerprint');
});

test('fingerprint still sees tracked content by default', () => {
  assert(fingerprintRepo, 'git could not initialise a fixture repository');
  const before = differential._private.fingerprint(fingerprintRepo);
  fs.writeFileSync(path.join(fingerprintRepo, 'tracked.txt'), 'mutated\n', 'utf8');
  assert.notStrictEqual(differential._private.fingerprint(fingerprintRepo), before,
    'a tracked mutation went unnoticed by the default fingerprint');
});

test('--whole-tree keeps the stronger invariant reachable', () => {
  assert(fingerprintRepo, 'git could not initialise a fixture repository');
  const before = differential._private.fingerprint(fingerprintRepo, { wholeTree: true });
  fs.writeFileSync(path.join(fingerprintRepo, 'build', 'artifact.bin'), 'third\n', 'utf8');
  assert.notStrictEqual(differential._private.fingerprint(fingerprintRepo, { wholeTree: true }), before,
    'whole-tree mode failed to hash an ignored artifact');
});

test('--whole-tree is parsed and defaults to false', () => {
  assert.strictEqual(differential._private.parseArgs([]).wholeTree, false);
  assert.strictEqual(differential._private.parseArgs(['--whole-tree']).wholeTree, true);
});

try {
  if (fingerprintRepo) {
    try { fs.rmSync(fingerprintRepo, { recursive: true, force: true }); } catch (_) { /* best-effort temp cleanup */ }
  }
  for (const filename of fixtureNames) {
    try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* best-effort temp cleanup */ }
} catch (error) {
  console.error(`fixture cleanup failed: ${error.message}`);
  failed += 1;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.error(JSON.stringify(failures));
}
process.exitCode = failed === 0 ? 0 : 1;
