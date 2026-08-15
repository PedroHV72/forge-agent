#!/usr/bin/env node
'use strict';

// forge-run-address.test.js — the address, and the one property that matters.
//
// R1 is the contract: the SAME run resolves to a BYTE-IDENTICAL address from
// the project root, from a nested subdirectory, and from a tmpdir entirely
// outside the tree. The pre-S06 form derived the answer from `process.cwd()`,
// which is correct from the project root and wrong everywhere the incidents
// actually happen (isolation `worktree` puts the orchestrator's cwd outside
// the workspace tree — the TASK-021 shape).
//
// R2 exists because a test never seen failing is not coverage. It reverts the
// resolver ON DISK to that pre-S06 form, re-runs R1 in a child process,
// REQUIRES it to go red, then restores and proves the restore byte-identical.
// If R2 ever passes without R1 having gone red, R1 is decoration.
//
// Every fixture lives in a tmpdir with a SYNTHETIC $HOME. R5 asserts, against
// the operator's REAL home (read via os.userInfo(), which ignores the HOME
// override run-tests.js applies), that this suite never touched
// `~/.claude/forge-gate-workspaces.json` — the live file that lost two rows
// during S05.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const addr = require('./forge-run-address.js');
const { resolveRunAddress, formatAddress, REASONS } = addr;

const MODULE = path.join(__dirname, 'forge-run-address.js');
const CLI    = MODULE;

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-run-address-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── R5 (opening half): the operator's live registry, before anything runs ───
// Read through os.userInfo(), NOT os.homedir(): run-tests.js overrides $HOME
// for child suites, and os.homedir() honours that override. Guarding the
// synthetic home would be a guard that cannot fail — the exact vacuous-green
// shape this milestone keeps paying for.
const REAL_HOME = os.userInfo().homedir;
const LIVE_REGISTRY = path.join(REAL_HOME, '.claude', 'forge-gate-workspaces.json');

function liveRegistryStamp() {
  try {
    const st = fs.statSync(LIVE_REGISTRY);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'absent';
  }
}
const LIVE_BEFORE = liveRegistryStamp();

// ── Fixture ─────────────────────────────────────────────────────────────────
//
//   <tmp>/home/.claude/forge-gate-workspaces.json
//   <tmp>/home/Development/            <- declared root '~/Development'
//     ws/                              <- project + workspace, owns the run
//       .gsd/PROJECT.md                <- the signal that makes it a project
//       .gsd/forge/runs/<id>.json
//       nested/deep/                   <- the second cwd
//       repo-a/
//       sub/repo-b/
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function makeFixture(opts) {
  opts = opts || {};
  const tmp  = mktmp();
  const home = path.join(tmp, 'home');
  const dev  = path.join(home, 'Development');
  const wsDir = path.join(dev, 'ws');

  fs.mkdirSync(path.join(wsDir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.gsd', 'PROJECT.md'), '# fixture project\n', 'utf8');
  fs.mkdirSync(path.join(wsDir, 'nested', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'repo-a'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'sub', 'repo-b'), { recursive: true });

  const runId = opts.runId || 'M-20260803120000-fixture';
  writeJson(path.join(wsDir, '.gsd', 'forge', 'runs', `${runId}.json`), Object.assign({
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
  }, opts.record || {}));

  writeJson(path.join(home, '.claude', 'forge-gate-workspaces.json'), {
    version: 1,
    roots: opts.roots || [{ path: '~/Development', primary: true }],
    entries: opts.entries || [
      { path: 'ws', root: '~/Development', kind: 'workspace', repos: ['repo-a', 'sub/repo-b'] },
    ],
    quarantine: [],
  });

  return { tmp, home, dev, wsDir, runId, outside: mktmp('forge-run-address-outside-') };
}

/** The address minus the one audit-only field, as a comparable string. */
function identity(a) {
  const copy = Object.assign({}, a);
  delete copy.resolved_from;
  return JSON.stringify(copy);
}

/**
 * Resolve in a CHILD process with its process.cwd() set to `cwd`.
 *
 * The child matters: the mutation R2 installs reads `process.cwd()`, and an
 * in-process call could never distinguish it from the real thing (this suite's
 * own cwd never changes). Running the resolver where its cwd genuinely differs
 * is what gives the mutation something to get wrong.
 */
function resolveInChild(cwd, home, runId) {
  const res = spawnSync(process.execPath, ['-e', `
    const { resolveRunAddress } = require(${JSON.stringify(MODULE)});
    const a = resolveRunAddress(process.argv[1], process.argv[2], { home: process.argv[3] });
    delete a.resolved_from;
    process.stdout.write(JSON.stringify(a));
  `, cwd, runId, home], {
    cwd,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }),
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

console.log('\n=== forge-run-address.js — address resolution suite ===\n');

// ── R1 — cwd-invariance (the contract) ──────────────────────────────────────

test('R1: the same run resolves byte-identically from project root, nested subdir and outside tmpdir', () => {
  const fx = makeFixture();
  const cwds = [fx.wsDir, path.join(fx.wsDir, 'nested', 'deep'), fx.outside];

  const answers = cwds.map(c => {
    const r = resolveInChild(c, fx.home, fx.runId);
    assertEqual(r.status, 0, `resolver exited non-zero from ${c}: ${r.stderr}`);
    return r.stdout;
  });

  assertEqual(answers[1], answers[0], 'nested subdirectory must give the identical address');
  assertEqual(answers[2], answers[0], 'a tmpdir OUTSIDE the tree must give the identical address');

  const a = JSON.parse(answers[0]);
  assertEqual(a.project.path, fx.wsDir, 'project leg');
  assertEqual(a.root.path, fx.dev, 'root leg');
  assertEqual(a.repos.map(r => r.name).join(','), 'repo-a,repo-b', 'repo leg from the workspace index');
});

test('R1b: resolved_from is the ONLY field that varies with cwd', () => {
  const fx = makeFixture();
  const fromRoot = resolveRunAddress(fx.wsDir, fx.runId, { home: fx.home });
  const fromOut  = resolveRunAddress(fx.outside, fx.runId, { home: fx.home });
  assertEqual(identity(fromOut), identity(fromRoot), 'identity must not move');
  assert(fromRoot.resolved_from !== fromOut.resolved_from, 'resolved_from MUST differ — it is the audit field');
  assertEqual(fromOut.resolved_from, fx.outside, 'resolved_from echoes the cwd it was given');
});

// ── R2 — mutation: prove R1 bites ───────────────────────────────────────────

test('R2: reverting the resolver to derive from process.cwd() turns R1 RED (and the restore is byte-identical)', () => {
  const fx = makeFixture();
  const pristine = fs.readFileSync(MODULE);
  const source = pristine.toString('utf8');

  const ORIGINAL = 'const owner = ws.resolveOwner(rec.cwd, opts.stopAt ? { stopAt: opts.stopAt } : {});';
  const REVERTED = 'const owner = ws.resolveOwner(process.cwd(), opts.stopAt ? { stopAt: opts.stopAt } : {});';
  const occurrences = source.split(ORIGINAL).length - 1;
  assertEqual(occurrences, 1, 'the record-anchored derivation must appear exactly once (mutation target)');

  let sawRed = false;
  let redDetail = '';
  try {
    fs.writeFileSync(MODULE, source.replace(ORIGINAL, REVERTED), 'utf8');

    const fromRoot = resolveInChild(fx.wsDir, fx.home, fx.runId);
    const fromOut  = resolveInChild(fx.outside, fx.home, fx.runId);

    // The pre-S06 form either answers differently or cannot answer at all from
    // outside the tree. Both are RED; neither is "byte-identical".
    if (fromOut.status !== 0) {
      sawRed = true;
      redDetail = `outside cwd failed outright: ${fromOut.stderr.trim().split('\n')[0]}`;
    } else if (fromOut.stdout !== fromRoot.stdout) {
      sawRed = true;
      redDetail = 'outside cwd produced a DIFFERENT address';
    }
  } finally {
    fs.writeFileSync(MODULE, pristine);
  }

  assert(sawRed,
    'MUTATION SURVIVED: the cwd-derived resolver still produced an identical address from outside the tree — R1 is not testing what it claims');
  assert(fs.readFileSync(MODULE).equals(pristine), 'restored file must be byte-identical to the pristine source');
  console.log(`      (mutation observed red — ${redDetail})`);
});

// ── R3 — precedence: a recorded field beats derivation ──────────────────────

// Resolved through the same lens the resolver applies to declared fields
// (path.resolve at forge-run-address.js — project leg and resolveRootPath):
// on Windows `path.resolve('/declared/root')` anchors on the current drive
// (`D:\declared\root` on the CI runner), so the byte-for-byte comparison
// below must use the resolved spelling. On POSIX this is the identity.
const DECLARED_ROOT    = path.resolve('/declared/root');
const DECLARED_PROJECT = path.resolve('/declared/project');

test('R3: a run that DECLARES root/project uses the declared values, not the derivation', () => {
  const declaredRoot    = DECLARED_ROOT;
  const declaredProject = DECLARED_PROJECT;
  const fx = makeFixture({ record: { root: declaredRoot, project: declaredProject } });

  const a = resolveRunAddress(fx.wsDir, fx.runId, { home: fx.home });
  assertEqual(a.project.path, declaredProject, 'declared project wins over resolveOwner');
  assertEqual(a.project.source, 'record', 'project source');
  assertEqual(a.root.path, declaredRoot, 'declared root wins over findContainingRoot');
  assertEqual(a.root.source, 'record', 'root source');
});

test('R3b: the derivation the declaration overrode points somewhere else (precedence is load-bearing)', () => {
  const fx = makeFixture();          // same fixture shape, nothing declared
  const derived = resolveRunAddress(fx.wsDir, fx.runId, { home: fx.home });
  assertEqual(derived.project.source, 'derived', 'undeclared → derived');
  // Compared against the same resolved constants R3 declared — the guard is
  // true on both platforms either way, but only this spelling can ever match.
  assert(derived.project.path !== DECLARED_PROJECT, 'derivation differs from the declaration used in R3');
  assert(derived.root.path !== DECLARED_ROOT, 'derivation differs from the declaration used in R3');
});

// ── R4 — named degradation ──────────────────────────────────────────────────

test('R4a: a project under NO declared root reports root:null with a reason, never a path and never a throw', () => {
  const outsideProject = mktmp('forge-run-address-lonely-');
  fs.mkdirSync(path.join(outsideProject, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(outsideProject, '.gsd', 'PROJECT.md'), '#\n', 'utf8');

  const fx = makeFixture({
    entries: [{ path: outsideProject, root: null, kind: 'project', repos: [] }],
  });
  // Re-home the run into the lonely project.
  const runFile = path.join(fx.wsDir, '.gsd', 'forge', 'runs', `${fx.runId}.json`);
  const rec = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  rec.cwd = outsideProject;
  writeJson(path.join(outsideProject, '.gsd', 'forge', 'runs', `${fx.runId}.json`), rec);
  fs.rmSync(runFile);

  const a = resolveRunAddress(outsideProject, fx.runId, { home: fx.home });
  assertEqual(a.project.path, outsideProject, 'project still resolves');
  assertEqual(a.root.path, null, 'root.path is null, not an invented path');
  assertEqual(a.root.source, null, 'root.source is null');
  assertEqual(a.root.reason, 'no-containing-root', 'root.reason names the case');
  assert(REASONS.root.includes(a.root.reason), 'reason is one of the enumerated reachable values');
  assertEqual(a.repos.length, 0, 'a non-workspace has no repos');
});

test('R4b: registry ABSENT and registry UNREADABLE give DIFFERENT reasons (never collapsed)', () => {
  const fx = makeFixture();
  const registryFile = path.join(fx.home, '.claude', 'forge-gate-workspaces.json');

  fs.rmSync(registryFile);
  const absent = resolveRunAddress(fx.wsDir, fx.runId, { home: fx.home });
  assertEqual(absent.root.reason, 'no-registry', 'absent registry');

  fs.writeFileSync(registryFile, '{ this is not json', 'utf8');
  const unreadable = resolveRunAddress(fx.wsDir, fx.runId, { home: fx.home });
  assertEqual(unreadable.root.reason, 'registry-unreadable', 'unreadable registry');

  assert(absent.root.reason !== unreadable.root.reason,
    'absent and unreadable are different facts and must not collapse to one reason');
  // Both still resolve the project — degradation is per-leg, not total.
  assertEqual(absent.project.path, fx.wsDir, 'project leg survives an absent registry');
  assertEqual(unreadable.project.path, fx.wsDir, 'project leg survives an unreadable registry');
});

test('R4c: a registry with zero declared roots says so, distinctly from "roots exist but none contains"', () => {
  const fx = makeFixture({
    roots: [],
    entries: [{ path: path.join(mktmp('forge-run-address-noroots-'), '..', 'x'), root: null, kind: 'project', repos: [] }],
  });
  const a = resolveRunAddress(fx.wsDir, fx.runId, { home: fx.home });
  assertEqual(a.root.reason, 'no-roots-declared', 'empty roots[] has its own reason');
  assert(a.root.reason !== 'no-containing-root', 'must not collapse into the containment miss');
});

test('R4d: an unknown run id throws an error naming the id — it does not return an empty address', () => {
  const fx = makeFixture();
  let threw = null;
  try { resolveRunAddress(fx.wsDir, 'M-does-not-exist', { home: fx.home }); }
  catch (e) { threw = e; }
  assert(threw, 'expected a throw');
  assert(/M-does-not-exist/.test(threw.message), `error names the id: ${threw && threw.message}`);
});

test('R4e: every reason a leg can emit is enumerated in REASONS (comment matches reachable cases)', () => {
  const source = fs.readFileSync(MODULE, 'utf8');
  const emitted = new Set();
  for (const m of source.matchAll(/reason:\s*'([a-z-]+)'/g)) emitted.add(m[1]);
  const enumerated = new Set([...REASONS.project, ...REASONS.root].filter(Boolean));
  for (const r of emitted) {
    assert(enumerated.has(r), `reason '${r}' is emitted by the code but absent from REASONS`);
  }
  assert(REASONS.root.includes(null) && REASONS.project.includes(null),
    'null must be listed — the reachable case a prose enumeration silently omits');
});

// ── Composition contract ────────────────────────────────────────────────────

test('the resolver COMPOSES the four relations and re-implements none of them', () => {
  const source = fs.readFileSync(MODULE, 'utf8');
  for (const fn of ['findContainingRoot', 'resolveOwner', 'resolveRole', 'buildRepoIndex']) {
    assert(new RegExp(`\\.${fn}\\(`).test(source), `must call ${fn}`);
  }
  // The shapes a fourth implementation would have: a containment walk, a
  // `.gsd/` existence probe, or a name→path map built here.
  assert(!/isStrictlyUnder\s*\(/.test(source), 'containment must come from findContainingRoot, not a local copy');
  assert(!/'\.gsd'/.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')),
    'project detection must come from resolveOwner, not a local .gsd/ probe');
});

test('CLI: --address resolves, --json emits the object, --help exits 0, no --address exits 2', () => {
  const fx = makeFixture();
  const env = Object.assign({}, process.env, { HOME: fx.home, USERPROFILE: fx.home });

  const human = spawnSync(process.execPath, [CLI, '--address', fx.runId, '--cwd', fx.wsDir], { encoding: 'utf8', env });
  assertEqual(human.status, 0, `human form exit: ${human.stderr}`);
  assert(human.stdout.includes(fx.runId), 'human form names the run');

  const json = spawnSync(process.execPath, [CLI, '--address', fx.runId, '--cwd', fx.wsDir, '--json'], { encoding: 'utf8', env });
  assertEqual(json.status, 0, `json form exit: ${json.stderr}`);
  const parsed = JSON.parse(json.stdout);
  assertEqual(parsed.project.path, fx.wsDir, 'json project leg');

  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', env });
  assertEqual(help.status, 0, 'help exit');

  const bare = spawnSync(process.execPath, [CLI, '--json'], { encoding: 'utf8', env });
  assertEqual(bare.status, 2, '--address is required');
});

test('CLI honours --cwd: it does NOT silently fall back to process.cwd() (the S05/R3 bug)', () => {
  const fx = makeFixture();
  const env = Object.assign({}, process.env, { HOME: fx.home, USERPROFILE: fx.home });
  // Run FROM the outside tmpdir, pointing --cwd at the project.
  const res = spawnSync(process.execPath, [CLI, '--address', fx.runId, '--cwd', fx.wsDir, '--json'],
    { cwd: fx.outside, encoding: 'utf8', env });
  assertEqual(res.status, 0, `exit: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assertEqual(parsed.resolved_from, fx.wsDir, '--cwd is what is echoed, not the shell cwd');
});

test('formatAddress renders a degraded leg by its reason, not as a blank', () => {
  const fx = makeFixture();
  fs.rmSync(path.join(fx.home, '.claude', 'forge-gate-workspaces.json'));
  const line = formatAddress(resolveRunAddress(fx.wsDir, fx.runId, { home: fx.home }));
  assert(line.includes('no-registry'), `degraded root shows its reason: ${line}`);
});

// ── Additive-field round-trip through forge-runs ────────────────────────────

test('address fields round-trip: a run recorded with branch/root/project reads them back', () => {
  const fx = makeFixture({ record: { branch: 'forge/M-fixture', root: '~/Development' } });
  const a = resolveRunAddress(fx.wsDir, fx.runId, { home: fx.home });
  assertEqual(a.run.branch, 'forge/M-fixture', 'branch reaches the address');
  assertEqual(a.root.source, 'record', 'declared root is authoritative');
  assertEqual(a.root.path, fx.dev, '~-anchored declared root resolves against the synthetic home');
});

test('a declared root given as a bare NAME resolves against the declared roots', () => {
  const fx = makeFixture({ record: { root: 'Development' } });
  const a = resolveRunAddress(fx.wsDir, fx.runId, { home: fx.home });
  assertEqual(a.root.source, 'record', 'source');
  assertEqual(a.root.path, fx.dev, 'bare name matched the declared root by basename');
});

test('a declared root that matches nothing degrades named — it does not fall back to derivation', () => {
  const fx = makeFixture({ record: { root: 'no-such-root' } });
  const a = resolveRunAddress(fx.wsDir, fx.runId, { home: fx.home });
  assertEqual(a.root.path, null, 'no invented path');
  assertEqual(a.root.source, 'record', 'the record spoke — the source stays record');
  assertEqual(a.root.reason, 'record-root-unresolvable', 'named reason');
  assert(a.root.reason !== 'no-containing-root', 'must NOT silently degrade into the derivation miss');
});

test('a declared project that is RELATIVE is reported, never resolved against the caller cwd', () => {
  const fx = makeFixture({ record: { project: 'ws' } });
  const fromRoot = resolveRunAddress(fx.wsDir, fx.runId, { home: fx.home });
  const fromOut  = resolveRunAddress(fx.outside, fx.runId, { home: fx.home });
  assertEqual(fromRoot.project.path, null, 'no cwd-relative guess');
  assertEqual(fromRoot.project.reason, 'record-project-unanchored', 'named reason');
  // The point of refusing: a `path.resolve` here would make the address differ
  // between these two calls, reopening cwd-dependence through precedence.
  assertEqual(identity(fromOut), identity(fromRoot), 'still cwd-invariant');
});

test('a legacy run record with NO address fields resolves without migration and leaves the file untouched', () => {
  const fx = makeFixture();
  const runFile = path.join(fx.wsDir, '.gsd', 'forge', 'runs', `${fx.runId}.json`);
  const before = fs.readFileSync(runFile);
  // Match the KEY, not the value: `"isolation_mode": "branch"` contains the
  // string `"branch"` and made the first version of this guard pass for the
  // wrong reason.
  assert(!/"branch"\s*:/.test(before.toString('utf8')), 'fixture is genuinely legacy (no branch KEY on disk)');

  const a = resolveRunAddress(fx.wsDir, fx.runId, { home: fx.home });
  assertEqual(a.run.branch, null, 'missing branch reads back as null, never undefined');
  assert(JSON.stringify(a.run).includes('"branch":null'), 'null survives JSON.stringify; undefined would vanish');
  assert(fs.readFileSync(runFile).equals(before), 'resolving must NOT rewrite the record on disk');
});

// ── R5 (closing half) ───────────────────────────────────────────────────────

test('R5: the operator live registry was never written by this suite', () => {
  const after = liveRegistryStamp();
  assertEqual(after, LIVE_BEFORE,
    `${LIVE_REGISTRY} changed during the suite (before=${LIVE_BEFORE} after=${after}) — fixtures must use a synthetic HOME`);
  // Non-vacuity: if this ever reads 'absent' on the operator's machine the
  // guard has stopped guarding anything, and that must be visible.
  console.log(`      (live registry stamp ${LIVE_BEFORE})`);
});

cleanup();

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
