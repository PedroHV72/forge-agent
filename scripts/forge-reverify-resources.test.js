#!/usr/bin/env node
// forge-reverify-resources.test.js — standalone suite for the resource-clamp
// wiring in forge-reverify.js#runVerification (S04/T03).
//
// Scope: forge-reverify.js is a THIN consumer (D10) of forge-resources.js /
// forge-command-rewrite.js#planRewriteArgv — this suite proves the wiring
// (argv/env split, W5 release, composition with resolveVerifyCommand's
// pre-existing metacharacter refusal, byte-identity on the unrewritten
// path), not the sizing rules or the tokenizer/rewrite logic (those live in
// forge-resources.test.js / forge-command-rewrite.test.js).
//
// Run: node scripts/forge-reverify-resources.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runVerification, resolveVerifyCommand } = require('./forge-reverify.js');

// ── Test runner boilerplate (mirrors forge-verify-resources.test.js) ──────

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

// ── Fixture helpers ─────────────────────────────────────────────────────────

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A fake "vitest" binary, placed under `dir/bin/vitest` (POSIX-only — a
// shebang script), that dumps `process.env` + `process.argv` to `dumpFile`
// and exits with `exitCode` (default 0). `delayMs` lets the timeout case
// outlive the caller's `timeoutMs`.
function writeFakeVitest(binDir, dumpFile, { exitCode = 0, delayMs = 0 } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, 'vitest');
  const body = `#!/usr/bin/env node
const fs = require('fs');
function dump() {
  fs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify({ env: process.env, argv: process.argv }));
}
${delayMs > 0
    ? `dump(); setTimeout(() => { process.exit(${exitCode}); }, ${delayMs});`
    : `dump(); process.exit(${exitCode});`}
`;
  fs.writeFileSync(binPath, body, { mode: 0o755 });
  return binPath;
}

function poolCensus(poolDir) {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'forge-resource-pool.js'),
    '--status', '--json', '--pool-dir', poolDir,
  ], { encoding: 'utf-8' });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { ok: false, held: -1, ceiling: -1 };
  }
}

const isPosix = process.platform !== 'win32';

// ── Setup: isolated pool dir + fixed pressure level (deterministic admission) ──

let codeDir;
let poolDir;
let originalPath;
let originalPressure;
let originalNodeOptions;
let originalVitestMaxForks;
let originalVitestMaxThreads;

function setup() {
  codeDir = mkTmpDir('forge-reverify-resources-work-');
  fs.mkdirSync(path.join(codeDir, '.gsd', 'forge'), { recursive: true });
  poolDir = mkTmpDir('forge-reverify-resources-pool-');
  originalPath = process.env.PATH;
  originalPressure = process.env.FORGE_RESOURCES_PRESSURE;
  originalNodeOptions = process.env.NODE_OPTIONS;
  originalVitestMaxForks = process.env.VITEST_MAX_FORKS;
  originalVitestMaxThreads = process.env.VITEST_MAX_THREADS;
  process.env.FORGE_RESOURCE_POOL_DIR = poolDir;
  // Deterministic admission: level 1 (normal), admit:true, cross-platform
  // (honored regardless of process.platform — forge-resources.js#resolveResourceBudget).
  process.env.FORGE_RESOURCES_PRESSURE = '1';
  // Hermetic to inherited env (R3) — several tests assert ABSENCE of
  // NODE_OPTIONS/VITEST_MAX_FORKS/VITEST_MAX_THREADS on the clamp-OFF path,
  // or an exact clamp-ON regex match; an inherited value would make either
  // assert fail against otherwise-correct preservation/clamp behavior.
  delete process.env.NODE_OPTIONS;
  delete process.env.VITEST_MAX_FORKS;
  delete process.env.VITEST_MAX_THREADS;
}

function teardown() {
  process.env.PATH = originalPath;
  if (originalPressure === undefined) delete process.env.FORGE_RESOURCES_PRESSURE;
  else process.env.FORGE_RESOURCES_PRESSURE = originalPressure;
  if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = originalNodeOptions;
  if (originalVitestMaxForks === undefined) delete process.env.VITEST_MAX_FORKS;
  else process.env.VITEST_MAX_FORKS = originalVitestMaxForks;
  if (originalVitestMaxThreads === undefined) delete process.env.VITEST_MAX_THREADS;
  else process.env.VITEST_MAX_THREADS = originalVitestMaxThreads;
  delete process.env.FORGE_RESOURCE_POOL_DIR;
  try { fs.rmSync(codeDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(poolDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

setup();

// ── 1/2. Clamp ON vs OFF: child-observed dump — env carries the assignments,
//         never argv (the adversarial case this whole design exists for) ──

test('clamp ON: child dump shows NODE_OPTIONS + VITEST_MAX_FORKS in env — NEVER as an argv element', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const binDir = path.join(codeDir, 'bin-on');
  const dumpFile = path.join(codeDir, 'dump-on.json');
  writeFakeVitest(binDir, dumpFile);
  process.env.PATH = binDir + path.delimiter + originalPath;

  const outcome = runVerification({ argv: ['vitest'], codeDir, timeoutMs: 15000, gsdDir: path.join(codeDir, '.gsd') });

  assert(fs.existsSync(dumpFile), 'fixture did not run — no dump file written');
  const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf-8'));
  assert(typeof dump.env.NODE_OPTIONS === 'string', 'NODE_OPTIONS missing from child env');
  assert(/--max-old-space-size=\d+/.test(dump.env.NODE_OPTIONS), `NODE_OPTIONS malformed: ${dump.env.NODE_OPTIONS}`);
  assert(typeof dump.env.VITEST_MAX_FORKS === 'string' && dump.env.VITEST_MAX_FORKS.length > 0,
    'VITEST_MAX_FORKS (the worker clamp) missing from child env');
  // The adversarial case: a mishandled argv/env split would try to spawn
  // `VITEST_MAX_FORKS=5` (or similar) as the BINARY under shell:false. Prove
  // no such element ever reached argv — the split landed in env, not argv.
  assert(!dump.argv.some(a => /^[A-Za-z_]\w*=/.test(a)),
    `an env assignment leaked into child argv: ${JSON.stringify(dump.argv)}`);
  assertEqual(outcome.verdict, 'verified');
});

test('clamp OFF (same fixture body, non-runner binary name): argv untouched and worker clamp absent — but NODE_OPTIONS overlay still applies (T03-PLAN 2d: env is explicit on the intact path too)', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const binDir = path.join(codeDir, 'bin-off');
  const dumpFile = path.join(codeDir, 'dump-off.json');
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, 'not-a-real-runner');
  fs.writeFileSync(binPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify({ env: process.env, argv: process.argv }));
process.exit(0);
`, { mode: 0o755 });

  const outcome = runVerification({ argv: [binPath], codeDir, timeoutMs: 15000, gsdDir: path.join(codeDir, '.gsd') });

  assert(fs.existsSync(dumpFile), 'fixture did not run — no dump file written');
  const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf-8'));
  // Worker/runner-specific clamp never applies to a non-runner command.
  assert(dump.env.VITEST_MAX_FORKS === undefined, 'VITEST_MAX_FORKS should be absent when the argv is not a runner form');
  assert(dump.env.VITEST_MAX_THREADS === undefined, 'VITEST_MAX_THREADS should be absent when the argv is not a runner form');
  // T03-PLAN 2d (R4): the NODE_OPTIONS overlay is still explicit on the
  // intact path — proven directly against the CHILD dump, not just
  // asserted-by-title. Removing the overlay in acquireReverifyClamp's
  // intact branch must fail this assert.
  assert(typeof dump.env.NODE_OPTIONS === 'string' && /--max-old-space-size=\d+/.test(dump.env.NODE_OPTIONS),
    `NODE_OPTIONS overlay missing/malformed on the intact path: ${dump.env.NODE_OPTIONS}`);
  // The argv itself is byte-identical to what was passed in (no assignment/flag inserted).
  assertEqual(dump.argv[dump.argv.length - 1], binPath, 'argv must remain byte-identical on the intact path');
  assertEqual(outcome.verdict, 'verified');
});

// ── 3. ['make','test'] / ['go','test','./...'] → argv byte-identical to original ──

test("['make','test'] and ['go','test','./...'] spawn with byte-identical argv to before this wiring", () => {
  const cwdEcho = mkTmpDir('forge-reverify-resources-echo-');
  try {
    // Substitute an echo-argv shim under the names "make"/"go" so the real
    // binary need not exist on the host — dumps argv only (posix-only,
    // mirrors the shebang-fixture pattern used above).
    if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
    const binDir = path.join(cwdEcho, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    // Shebang scripts run as `node <scriptPath> <forwarded args>` — argv[0]
    // is the node executable, argv[1] is the script itself; only argv[2:]
    // are the args this process's caller actually forwarded.
    const dumpMake = path.join(cwdEcho, 'dump-make.json');
    fs.writeFileSync(path.join(binDir, 'make'), `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(dumpMake)}, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`, { mode: 0o755 });
    const dumpGo = path.join(cwdEcho, 'dump-go.json');
    fs.writeFileSync(path.join(binDir, 'go'), `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(dumpGo)}, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = binDir + path.delimiter + savedPath;

    runVerification({ argv: ['make', 'test'], codeDir: cwdEcho, timeoutMs: 5000 });
    const gotMake = JSON.parse(fs.readFileSync(dumpMake, 'utf-8'));
    assertEqual(JSON.stringify(gotMake), JSON.stringify(['test']), 'make test argv was mutated');

    runVerification({ argv: ['go', 'test', './...'], codeDir: cwdEcho, timeoutMs: 5000 });
    const gotGo = JSON.parse(fs.readFileSync(dumpGo, 'utf-8'));
    assertEqual(JSON.stringify(gotGo), JSON.stringify(['test', './...']), 'go test argv was mutated');

    process.env.PATH = savedPath;
  } finally {
    fs.rmSync(cwdEcho, { recursive: true, force: true });
  }
});

// ── 4. resolveVerifyCommand's metacharacter refusal composes untouched (MEM004) ──

test('resolveVerifyCommand still refuses a CODING-STANDARDS test command with a shell metacharacter — no-command, unrelated to the clamp', () => {
  const cwdRefuse = mkTmpDir('forge-reverify-resources-refuse-');
  try {
    fs.mkdirSync(path.join(cwdRefuse, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(cwdRefuse, '.gsd', 'CODING-STANDARDS.md'),
      '## Lint & Format Commands\n\n- **Test:** `echo hi && echo bye`\n');
    const argv = resolveVerifyCommand(cwdRefuse, path.join(cwdRefuse, '.gsd'));
    assertEqual(argv, null, 'a command containing a shell metacharacter must resolve to null (no-command)');
  } finally {
    fs.rmSync(cwdRefuse, { recursive: true, force: true });
  }
});

// ── 5. Command that fails: verdict:'failed' + real exit code + pool census zeroed (W5) ──

test("W5: a failing command reports verdict:'failed' with the real exit code AND releases the lease", () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const binDir = path.join(codeDir, 'bin-fail');
  const dumpFile = path.join(codeDir, 'dump-fail.json');
  writeFakeVitest(binDir, dumpFile, { exitCode: 7 });
  process.env.PATH = binDir + path.delimiter + originalPath;

  const outcome = runVerification({ argv: ['vitest'], codeDir, timeoutMs: 15000, gsdDir: path.join(codeDir, '.gsd') });

  assertEqual(outcome.verdict, 'failed');
  assertEqual(outcome.exit_code, 7);

  const census = poolCensus(poolDir);
  assertEqual(census.ok, true, 'pool status call failed');
  assertEqual(census.held, 0, `lease leaked on the failure path — held=${census.held}`);
});

// ── 6. Command that times out: verdict:'no-command' (ETIMEDOUT semantics preserved) + released ──

test("W5: a timing-out command keeps verdict:'no-command' (ETIMEDOUT) AND releases the lease", () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const binDir = path.join(codeDir, 'bin-timeout');
  const dumpFile = path.join(codeDir, 'dump-timeout.json');
  writeFakeVitest(binDir, dumpFile, { delayMs: 5000 });
  process.env.PATH = binDir + path.delimiter + originalPath;

  const outcome = runVerification({ argv: ['vitest'], codeDir, timeoutMs: 300, gsdDir: path.join(codeDir, '.gsd') });

  assertEqual(outcome.verdict, 'no-command', 'timeout must preserve the pre-existing ETIMEDOUT->no-command semantics');

  const census = poolCensus(poolDir);
  assertEqual(census.ok, true, 'pool status call failed');
  assertEqual(census.held, 0, `lease leaked on the timeout path — held=${census.held}`);
});

// ── 7. Fail-open: resources module forced to fail → argv/verdict identical to baseline ──

test('fail-open: forced-throwing resources module runs the ORIGINAL argv, verdict unchanged', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const binDir = path.join(codeDir, 'bin-failopen');
  const dumpFile = path.join(codeDir, 'dump-failopen.json');
  writeFakeVitest(binDir, dumpFile);
  process.env.PATH = binDir + path.delimiter + originalPath;

  const outcome = runVerification({
    argv: ['vitest'], codeDir, timeoutMs: 15000, gsdDir: path.join(codeDir, '.gsd'),
    requireResources: () => { throw new Error('forced: resources module broken'); },
  });

  assertEqual(outcome.verdict, 'verified');
  const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf-8'));
  // No args were forwarded beyond argv[1] (the resolved fake-vitest script
  // path itself) — proving nothing was appended/rewritten on this argv.
  assertEqual(dump.argv.length, 2, `argv must be byte-identical to baseline, got ${JSON.stringify(dump.argv)}`);
  assert(dump.env.NODE_OPTIONS === undefined, 'fail-open must not apply the NODE_OPTIONS overlay');
  assert(dump.env.VITEST_MAX_FORKS === undefined, 'fail-open must not apply the worker clamp');
});

test('fail-open: forced-throwing command-rewrite module runs the ORIGINAL argv, verdict unchanged', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const binDir = path.join(codeDir, 'bin-failopen2');
  const dumpFile = path.join(codeDir, 'dump-failopen2.json');
  writeFakeVitest(binDir, dumpFile);
  process.env.PATH = binDir + path.delimiter + originalPath;

  const outcome = runVerification({
    argv: ['vitest'], codeDir, timeoutMs: 15000, gsdDir: path.join(codeDir, '.gsd'),
    requireCommandRewrite: () => { throw new Error('forced: command-rewrite module broken'); },
  });

  assertEqual(outcome.verdict, 'verified');
  const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf-8'));
  assert(dump.env.NODE_OPTIONS === undefined, 'fail-open must not apply the NODE_OPTIONS overlay');
});

// ── 8. Verdict table holds byte-for-byte with clamp ON and OFF ─────────────

test('verdict table (no-command empty argv / no-command spawnPlan-null / verified / failed) holds with clamp ON and OFF', () => {
  // no-command: empty argv (guard #1) — clamp never even attempted.
  const emptyOn = runVerification({ argv: [], codeDir, timeoutMs: 5000 });
  const emptyOff = runVerification({
    argv: [], codeDir, timeoutMs: 5000,
    requireCommandRewrite: () => { throw new Error('off'); },
  });
  assertEqual(emptyOn.verdict, 'no-command');
  assertEqual(emptyOff.verdict, 'no-command');

  // no-command: spawnPlan-null (guard #2). POSIX spawnPlan() never returns
  // null, so this leg is only reachable on win32 in production — the R5
  // fix (S04 review) injects a fake spawnPlanFn via the test-only seam
  // added to runVerification, proving the guard bites on ANY host without
  // asserting more than what's exercised.
  const nullPlanOn = runVerification({ argv: ['whatever'], codeDir, timeoutMs: 5000, spawnPlanFn: () => null });
  const nullPlanOff = runVerification({
    argv: ['whatever'], codeDir, timeoutMs: 5000, spawnPlanFn: () => null,
    requireCommandRewrite: () => { throw new Error('off'); },
  });
  assertEqual(nullPlanOn.verdict, 'no-command');
  assertEqual(nullPlanOff.verdict, 'no-command');

  // Project's own exit code, via a plain non-runner command.
  const cwdExit = mkTmpDir('forge-reverify-resources-exit-');
  try {
    const exitArgv = [process.execPath, '-e', 'process.exit(3)'];
    const exOn = runVerification({ argv: exitArgv, codeDir: cwdExit, timeoutMs: 5000 });
    const exOff = runVerification({
      argv: exitArgv, codeDir: cwdExit, timeoutMs: 5000,
      requireCommandRewrite: () => { throw new Error('off'); },
    });
    assertEqual(exOn.verdict, 'failed');
    assertEqual(exOff.verdict, 'failed');
    assertEqual(exOn.exit_code, 3);
    assertEqual(exOff.exit_code, 3);
  } finally {
    fs.rmSync(cwdExit, { recursive: true, force: true });
  }

  // verified: exit 0, clamp ON vs OFF. Covered jointly by tests 1/2 (whose
  // fixtures assert env/argv shape) — this leg only needs the verdict.
  if (isPosix) {
    const cwdOk = mkTmpDir('forge-reverify-resources-ok-');
    try {
      const okArgv = [process.execPath, '-e', 'process.exit(0)'];
      const okOn = runVerification({ argv: okArgv, codeDir: cwdOk, timeoutMs: 5000 });
      const okOff = runVerification({
        argv: okArgv, codeDir: cwdOk, timeoutMs: 5000,
        requireCommandRewrite: () => { throw new Error('off'); },
      });
      assertEqual(okOn.verdict, 'verified');
      assertEqual(okOff.verdict, 'verified');
    } finally {
      fs.rmSync(cwdOk, { recursive: true, force: true });
    }
  }
});

// ── 9. D5: no signal/kill/suspension anywhere in the new source ────────────

test('D5: no process.kill / child.kill / SIGSTOP / SIGTERM appears anywhere in forge-reverify.js', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-reverify.js'), 'utf-8');
  assert(!/\.kill\s*\(/.test(src), 'found a .kill( call in forge-reverify.js');
  assert(!/process\.kill/.test(src), 'found process.kill in forge-reverify.js');
  assert(!/SIGSTOP|SIGTERM|SIGKILL/.test(src), 'found a signal name in forge-reverify.js');
});

// ── 10. D10: no sizing math (Math.min/Math.max/heap arithmetic) in the new wiring ──

test('D10: forge-reverify.js contains zero worker/heap sizing arithmetic — only pass-through', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-reverify.js'), 'utf-8');
  const wiringStart = src.indexOf('// ── Resource wiring (S04/T03) ');
  assert(wiringStart !== -1, 'could not locate the resource-wiring section marker');
  const wiringSrc = src.slice(wiringStart);
  assert(!/Math\.(min|max|floor|ceil|round)\s*\(/.test(wiringSrc),
    'found sizing arithmetic inside the resource-wiring section — D10 violation');
});

teardown();

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
