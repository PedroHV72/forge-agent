#!/usr/bin/env node
// forge-resources-enforcement.test.js — the `resources.enforcement: off`
// toggle, proved to BITE in both directions, per consumer (S06/T03).
//
// The finding this suite exists to lock down: `shared/forge-prefs-reference.md`
// documents `enforcement: off` as "everything advisory/off — needed so S06 can
// measure with the control disabled", but before T03 the field travelled in the
// contract and NO consumer read it. `off` clamped exactly like `clamp`. Two of
// S06's four measurement cells would have claimed "control off" while the
// control was on — a wrong number that looks right.
//
// Method — the two rules that make this suite evidence rather than narration:
//
//   1. The lever is a REAL prefs file (`.gsd/forge-prefs.jsonc`) in an isolated
//      workspace, never a stubbed contract. What is proven is the operator's
//      toggle end-to-end, not that an if-statement exists.
//   2. Every assertion is made on the EFFECTIVE result — the child process's
//      own `process.env`/`process.argv` dump for the two CLI consumers, and the
//      hook's actual stdout payload for the third. Never by reading code.
//
// Both directions, per consumer. An `off`-only suite would let a regression
// that disables clamping EVERYWHERE pass green; the `clamp` cell is the
// positive control that forbids it.
//
// MEM012: every fixture lives in its own tmpdir with its own pool dir — this
// suite never writes to the repo's `.gsd/forge/events.jsonl` (T06's census
// reads that file).
//
// Run: node scripts/forge-resources-enforcement.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { runVerificationGate } = require('./forge-verify.js');
const { runVerification } = require('./forge-reverify.js');
const { REASON_CODES } = require('./forge-resources.js');

const HOOK_PATH = path.join(__dirname, 'forge-hook.js');
const POOL_PATH = path.join(__dirname, 'forge-resource-pool.js');

// The reason string the three consumers emit for this bypass. Named, never
// silent (D8). Kept as one constant so a rename in the producers cannot leave
// this suite asserting a string nobody emits any more.
const OFF_REASON = 'intact:enforcement-off';

// The reason the three consumers emit when the FORMULA refused admission
// (critical pressure → admit:false, workers:0). Taken from the owning enum,
// not re-typed: the producers and this suite must drift together or not at
// all (D8). Distinct from OFF_REASON — this one names pressure, not the
// operator's toggle.
const REFUSED_REASON = REASON_CODES.INTACT_ADMISSION_REFUSED_ADVISORY;

// ── Runner boilerplate (mirrors forge-verify-resources.test.js) ─────────────

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

// ── Fixtures ───────────────────────────────────────────────────────────────

const createdDirs = [];

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

/**
 * An isolated workspace owning its own `.gsd/` AND its own `resources.enforcement`
 * preference. `enforcement` is written to the project-local preference layer —
 * the same file an operator would edit to run S06's control-off cells.
 */
function workspaceWith(enforcement) {
  const dir = tmpDir(`forge-enf-${enforcement}-`);
  fs.mkdirSync(path.join(dir, '.gsd', 'forge'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.gsd', 'forge-prefs.jsonc'),
    JSON.stringify({ resources: { enforcement } }, null, 2) + '\n',
    'utf8',
  );
  return dir;
}

// POSIX-only shebang fixture: a fake `vitest` that dumps its own env+argv.
// This is what makes "byte-identical" a CHILD-OBSERVED fact.
function writeFakeVitest(binDir, dumpFile) {
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, 'vitest');
  fs.writeFileSync(binPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify({ env: process.env, argv: process.argv }));
process.exit(0);
`, { mode: 0o755 });
  return binPath;
}

function poolCensus(poolDir) {
  const result = spawnSync(process.execPath, [POOL_PATH, '--status', '--json', '--pool-dir', poolDir], { encoding: 'utf-8' });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { ok: false, held: -1 };
  }
}

function readEvents(cwd) {
  try {
    return fs.readFileSync(path.join(cwd, '.gsd', 'forge', 'events.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// Producers spread their payload at the top level, but the event NAME lives
// under `kind` for the two CLIs and `event` for the hook. Match on either so
// this helper never silently finds nothing because it looked at one key.
function findEvent(events, name, reason) {
  return events.find((e) => (e.kind === name || e.event === name) &&
    (reason === undefined || e.reason === reason));
}

// `pressure` defaults to '1' (normal — admission granted); '4' forces the
// critical level where the formula returns admit:false / workers:0.
function runPreHook(command, { cwd, poolDir, pressure }) {
  const payload = { session_id: crypto.randomUUID(), cwd, tool_name: 'Bash', tool_input: { command } };
  const result = spawnSync(process.execPath, [HOOK_PATH, 'pre'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd,
    env: Object.assign({}, process.env, {
      FORGE_RESOURCE_POOL_DIR: poolDir,
      FORGE_RESOURCES_PRESSURE: pressure || '1',
      NODE_OPTIONS: '',
    }),
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

const isPosix = process.platform !== 'win32';

// ── Global env hygiene ─────────────────────────────────────────────────────
//
// A NODE_OPTIONS inherited from the outer shell/CI would suppress the clamp's
// own overlay (a human's value always wins — S04 R3/R4), making the `clamp`
// positive controls below fail against otherwise-correct behavior. Pressure is
// pinned so admission is deterministic and platform-independent.
const saved = {
  PATH: process.env.PATH,
  NODE_OPTIONS: process.env.NODE_OPTIONS,
  PRESSURE: process.env.FORGE_RESOURCES_PRESSURE,
  POOL: process.env.FORGE_RESOURCE_POOL_DIR,
};

function setup() {
  delete process.env.NODE_OPTIONS;
  process.env.FORGE_RESOURCES_PRESSURE = '1';
}

function teardown() {
  process.env.PATH = saved.PATH;
  if (saved.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = saved.NODE_OPTIONS;
  if (saved.PRESSURE === undefined) delete process.env.FORGE_RESOURCES_PRESSURE;
  else process.env.FORGE_RESOURCES_PRESSURE = saved.PRESSURE;
  if (saved.POOL === undefined) delete process.env.FORGE_RESOURCE_POOL_DIR;
  else process.env.FORGE_RESOURCE_POOL_DIR = saved.POOL;
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

setup();

// ═══════════════════════════════════════════════════════════════════════════
// 1. forge-verify.js — the same command under both enforcement values
// ═══════════════════════════════════════════════════════════════════════════

function runVerifyCell(enforcement) {
  const cwd = workspaceWith(enforcement);
  const poolDir = tmpDir(`forge-enf-pool-${enforcement}-`);
  const dumpFile = path.join(cwd, 'dump.json');
  writeFakeVitest(path.join(cwd, 'bin'), dumpFile);
  process.env.PATH = path.join(cwd, 'bin') + path.delimiter + saved.PATH;
  process.env.FORGE_RESOURCE_POOL_DIR = poolDir;
  try {
    runVerificationGate({
      cwd,
      taskPlanVerify: 'vitest',
      commandTimeoutMs: 20000,
      gsdDir: path.join(cwd, '.gsd'),
    });
  } finally {
    process.env.PATH = saved.PATH;
  }
  assert(fs.existsSync(dumpFile), `fixture never ran under enforcement:${enforcement}`);
  return { cwd, poolDir, dump: JSON.parse(fs.readFileSync(dumpFile, 'utf-8')) };
}

test('forge-verify: enforcement:off spawns the command byte-identical — no clamp env, no heap NODE_OPTIONS (child-observed)', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const { cwd, poolDir, dump } = runVerifyCell('off');

  assertEqual(dump.env.VITEST_MAX_FORKS, undefined, 'worker clamp reached the child under enforcement:off');
  assertEqual(dump.env.VITEST_MAX_THREADS, undefined, 'worker clamp reached the child under enforcement:off');
  assert(dump.env.NODE_OPTIONS === undefined || dump.env.NODE_OPTIONS === '',
    `heap NODE_OPTIONS was injected under enforcement:off: ${dump.env.NODE_OPTIONS}`);
  assert(!dump.argv.some((a) => /^[A-Za-z_]\w*=/.test(a)),
    `an env assignment leaked into child argv: ${JSON.stringify(dump.argv)}`);

  // D8: named, never silent. The reason identifies the toggle as the cause —
  // distinct from `intact:admission-refused-advisory`, which names pressure.
  const skipped = findEvent(readEvents(cwd), 'resource-clamp-skipped', OFF_REASON);
  assert(skipped, `no resource-clamp-skipped event with reason ${OFF_REASON}: ${JSON.stringify(readEvents(cwd))}`);
  assert(!findEvent(readEvents(cwd), 'resource-clamp-applied'), 'a clamp was applied under enforcement:off');

  // W5: the bypass releases its slot like every other exit path.
  const census = poolCensus(poolDir);
  assertEqual(census.held, 0, `lease leaked on the enforcement:off bypass — held=${census.held}`);
});

test('forge-verify: enforcement:clamp still rewrites exactly as before (positive control — an always-on bypass fails here)', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const { cwd, poolDir, dump } = runVerifyCell('clamp');

  assert(typeof dump.env.VITEST_MAX_FORKS === 'string' && dump.env.VITEST_MAX_FORKS.length > 0,
    'VITEST_MAX_FORKS missing under enforcement:clamp — the control was silently disabled');
  assert(typeof dump.env.NODE_OPTIONS === 'string' && /--max-old-space-size=\d+/.test(dump.env.NODE_OPTIONS),
    `heap NODE_OPTIONS missing/malformed under enforcement:clamp: ${dump.env.NODE_OPTIONS}`);

  assert(findEvent(readEvents(cwd), 'resource-clamp-applied'), 'no resource-clamp-applied event under enforcement:clamp');
  assert(!findEvent(readEvents(cwd), 'resource-clamp-skipped', OFF_REASON),
    `${OFF_REASON} emitted under enforcement:clamp`);

  assertEqual(poolCensus(poolDir).held, 0, 'lease leaked on the clamped path');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. forge-reverify.js — same two cells, argv consumer (shell:false)
// ═══════════════════════════════════════════════════════════════════════════

function runReverifyCell(enforcement) {
  const codeDir = workspaceWith(enforcement);
  const poolDir = tmpDir(`forge-enf-rpool-${enforcement}-`);
  const dumpFile = path.join(codeDir, 'dump.json');
  writeFakeVitest(path.join(codeDir, 'bin'), dumpFile);
  process.env.PATH = path.join(codeDir, 'bin') + path.delimiter + saved.PATH;
  process.env.FORGE_RESOURCE_POOL_DIR = poolDir;
  try {
    runVerification({ argv: ['vitest'], codeDir, timeoutMs: 20000, gsdDir: path.join(codeDir, '.gsd') });
  } finally {
    process.env.PATH = saved.PATH;
  }
  assert(fs.existsSync(dumpFile), `fixture never ran under enforcement:${enforcement}`);
  return { codeDir, poolDir, dump: JSON.parse(fs.readFileSync(dumpFile, 'utf-8')) };
}

test('forge-reverify: enforcement:off spawns argv byte-identical — no clamp env, no heap NODE_OPTIONS (child-observed)', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const { codeDir, poolDir, dump } = runReverifyCell('off');

  assertEqual(dump.env.VITEST_MAX_FORKS, undefined, 'worker clamp reached the child under enforcement:off');
  assert(dump.env.NODE_OPTIONS === undefined || dump.env.NODE_OPTIONS === '',
    `heap NODE_OPTIONS was injected under enforcement:off: ${dump.env.NODE_OPTIONS}`);
  // The `off` bypass is stronger than the ordinary intact path: that one still
  // carries the NODE_OPTIONS overlay by design (S04 T03-PLAN 2d). "Off" means
  // off — argv AND env untouched.
  assert(!dump.argv.some((a) => /^[A-Za-z_]\w*=/.test(a)),
    `an env assignment leaked into child argv: ${JSON.stringify(dump.argv)}`);

  assert(findEvent(readEvents(codeDir), 'resource-clamp-skipped', OFF_REASON),
    `no resource-clamp-skipped event with reason ${OFF_REASON}`);
  assert(!findEvent(readEvents(codeDir), 'resource-clamp-applied'), 'a clamp was applied under enforcement:off');

  assertEqual(poolCensus(poolDir).held, 0, 'lease leaked on the enforcement:off bypass');
});

test('forge-reverify: enforcement:clamp still rewrites exactly as before (positive control)', () => {
  if (!isPosix) { console.log('    (skipped: posix-only shebang fixture)'); return; }
  const { codeDir, poolDir, dump } = runReverifyCell('clamp');

  assert(typeof dump.env.VITEST_MAX_FORKS === 'string' && dump.env.VITEST_MAX_FORKS.length > 0,
    'VITEST_MAX_FORKS missing under enforcement:clamp — the control was silently disabled');
  assert(typeof dump.env.NODE_OPTIONS === 'string' && /--max-old-space-size=\d+/.test(dump.env.NODE_OPTIONS),
    `heap NODE_OPTIONS missing/malformed under enforcement:clamp: ${dump.env.NODE_OPTIONS}`);

  assert(findEvent(readEvents(codeDir), 'resource-clamp-applied'), 'no resource-clamp-applied event under enforcement:clamp');
  assertEqual(poolCensus(poolDir).held, 0, 'lease leaked on the clamped path');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. forge-hook.js — PreToolUse rewrite branch, same two cells
// ═══════════════════════════════════════════════════════════════════════════

test('forge-hook PreToolUse: enforcement:off emits NO updatedInput — the executor command passes through intact', () => {
  const cwd = workspaceWith('off');
  const poolDir = tmpDir('forge-enf-hpool-off-');
  const res = runPreHook('vitest run', { cwd, poolDir });

  assertEqual(res.status, 0, 'hook must never block (MEM008/B2)');
  assertEqual(res.stdout.trim(), '', `stdout must be empty under enforcement:off, got: ${res.stdout}`);

  const events = readEvents(cwd);
  assert(findEvent(events, 'rewrite-skipped', OFF_REASON),
    `no rewrite-skipped event with reason ${OFF_REASON}: ${JSON.stringify(events)}`);
  assert(!findEvent(events, 'rewrite-applied'), 'a rewrite was applied under enforcement:off');

  assertEqual(poolCensus(poolDir).held, 0, 'lease leaked on the enforcement:off bypass');
});

test('forge-hook PreToolUse: enforcement:clamp still emits updatedInput with the rewritten command (positive control)', () => {
  const cwd = workspaceWith('clamp');
  const poolDir = tmpDir('forge-enf-hpool-clamp-');
  const res = runPreHook('vitest run', { cwd, poolDir });

  assertEqual(res.status, 0, 'hook must never block');
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  assertEqual(lines.length, 1, `single-stdout invariant broken: ${res.stdout}`);
  const parsed = JSON.parse(lines[0]);
  assert(parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedInput &&
    parsed.hookSpecificOutput.updatedInput.command,
    'updatedInput.command missing under enforcement:clamp — the control was silently disabled');
  assert(parsed.hookSpecificOutput.updatedInput.command !== 'vitest run',
    'the emitted command is not the rewritten one');

  assert(findEvent(readEvents(cwd), 'rewrite-applied'), 'no rewrite-applied event under enforcement:clamp');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Fail-safe: an unknown pref value must NOT disable the control
// ═══════════════════════════════════════════════════════════════════════════
//
// The asymmetry that decides this: a typo (`Off`, `false`, `disabled`) that
// silently switched the control off would produce an unmeasured, unclamped
// machine while the operator believed the default was in force. Anything that
// is not exactly `off` leaves the control ON.

test('fail-safe: an unknown enforcement value leaves the control ON (only the exact string `off` bypasses)', () => {
  const cwd = workspaceWith('OFF');   // wrong case — deliberately not `off`
  const poolDir = tmpDir('forge-enf-hpool-typo-');
  const res = runPreHook('vitest run', { cwd, poolDir });

  assertEqual(res.status, 0, 'hook must never block');
  const events = readEvents(cwd);
  assert(!findEvent(events, 'rewrite-skipped', OFF_REASON),
    'an unknown enforcement value took the enforcement:off bypass — fail-safe violated');
  assert(findEvent(events, 'rewrite-applied'),
    `the control did not act under an unknown enforcement value: ${JSON.stringify(events)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. forge-hook.js — admit:false guard (critical pressure), parity with
//    forge-verify.js / forge-reverify.js
// ═══════════════════════════════════════════════════════════════════════════
//
// The defect this section locks down: under critical pressure the formula
// returns `admit:false, workers:0`, and `--maxWorkers=0` / `VITEST_MAX_FORKS=0`
// are FALSY to the runners — a rewrite emitted from that contract announces a
// cap that does not exist (full parallelism), and playwright's `--workers=0`
// can break the command outright. verify/reverify already skip the rewrite on
// this path; before this guard the hook rewrote anyway and logged
// `rewrite-applied` — telemetry claiming control at the exact moment there was
// none. Revert the guard and every assert in the first test below fails: the
// hook emits `updatedInput` with a zero-worker command and a `rewrite-applied`
// event, and no `rewrite-skipped` with REFUSED_REASON is written.

test('forge-hook PreToolUse: admit:false (pressão crítica) emits NO updatedInput — command passes through byte-identical', () => {
  const cwd = workspaceWith('clamp');   // control ON — the bypass under test is pressure, not the toggle
  const poolDir = tmpDir('forge-adm-hpool-refused-');
  const res = runPreHook('vitest run', { cwd, poolDir, pressure: '4' });

  assertEqual(res.status, 0, 'hook must never block (MEM008/B2), even under critical pressure');
  assertEqual(res.stdout.trim(), '', `stdout must be empty under admit:false — a rewrite here announces a cap that does not exist: ${res.stdout}`);

  const events = readEvents(cwd);
  // D8: named, never silent — and named with the SAME reason the other two
  // consumers emit, taken from the owning enum.
  assert(findEvent(events, 'rewrite-skipped', REFUSED_REASON),
    `no rewrite-skipped event with reason ${REFUSED_REASON}: ${JSON.stringify(events)}`);
  // The core lie the guard removes: `rewrite-applied` must NEVER be claimed
  // on a refused admission.
  assert(!findEvent(events, 'rewrite-applied'),
    `rewrite-applied emitted under admit:false — telemetry claims a cap that does not exist: ${JSON.stringify(events)}`);
  // The two bypasses stay distinguishable: pressure never masquerades as the
  // operator's toggle.
  assert(!findEvent(events, 'rewrite-skipped', OFF_REASON),
    'admission refusal emitted the enforcement-off reason — the two causes collapsed');

  // W5: no lease leaks through the refused path (admit:false holds no slots
  // today, but a leak here would be invisible without this census).
  assertEqual(poolCensus(poolDir).held, 0, 'lease leaked on the admission-refused bypass');
});

test('forge-hook PreToolUse: admission granted (positive control) — the same command IS rewritten under normal pressure', () => {
  // Guards the guard: an over-broad predicate that skips the rewrite for
  // admitted contracts too would pass the test above and fail here.
  const cwd = workspaceWith('clamp');
  const poolDir = tmpDir('forge-adm-hpool-granted-');
  const res = runPreHook('vitest run', { cwd, poolDir, pressure: '1' });

  assertEqual(res.status, 0, 'hook must never block');
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  assertEqual(lines.length, 1, `single-stdout invariant broken: ${res.stdout}`);
  const parsed = JSON.parse(lines[0]);
  assert(parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedInput &&
    parsed.hookSpecificOutput.updatedInput.command !== 'vitest run',
    'the admitted command was not rewritten — the admit guard swallowed the granted path');
  assert(!findEvent(readEvents(cwd), 'rewrite-skipped', REFUSED_REASON),
    `${REFUSED_REASON} emitted for an admitted contract`);
});

test('forge-hook PreToolUse: enforcement:off + critical pressure — the toggle reason wins (ordering parity with forge-verify.js)', () => {
  // verify/reverify check `enforcement === 'off'` BEFORE `admit === false` so
  // the emitted reason names the operator's toggle, not the pressure that
  // happened to coincide with it. The hook must keep the same order.
  const cwd = workspaceWith('off');
  const poolDir = tmpDir('forge-adm-hpool-off-crit-');
  const res = runPreHook('vitest run', { cwd, poolDir, pressure: '4' });

  assertEqual(res.status, 0, 'hook must never block');
  assertEqual(res.stdout.trim(), '', 'stdout must be empty when both bypasses apply');
  const events = readEvents(cwd);
  assert(findEvent(events, 'rewrite-skipped', OFF_REASON),
    `toggle reason missing when off+critical coincide: ${JSON.stringify(events)}`);
  assert(!findEvent(events, 'rewrite-skipped', REFUSED_REASON),
    'pressure reason emitted although the operator toggle takes precedence');
});

// ── Report ─────────────────────────────────────────────────────────────────

teardown();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
