#!/usr/bin/env node
// forge-runs.test.js — contract test suite for forge-runs.js
// Covers the ENOGSD guard added to close the fourth `.gsd/` manufacturer:
//   - ensureRunsDir (strict writer, exercised via add()) refuses to create
//     .gsd/ when it is absent.
//   - refreshLegacyAlias (best-effort writer) silently no-ops without .gsd/,
//     never throws, never manufactures .gsd/.
//   - CLI surfaces a readable one-line error (no stack trace) and exits 1.
//   - --migrate-legacy on an uninitialised dir still exits 0 with
//     {migrated:false} and creates nothing.
// Run: node scripts/forge-runs.test.js  (exits 0 = all pass, 1 = any fail)

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runs = require('./forge-runs.js');

// ── Harness ───────────────────────────────────────────────────────────────────
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

function withSandbox(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runs-test-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const CLI = path.join(__dirname, 'forge-runs.js');

console.log('\n=== forge-runs.js — contract test suite ===\n');

// ── ENOGSD: strict writer (ensureRunsDir via add()) ─────────────────────────

test('add() on clean tmpdir (no .gsd/) throws ENOGSD and manufactures nothing', () => {
  withSandbox(dir => {
    let threw = null;
    try {
      runs.add(dir, { id: 'M001', kind: 'milestone', session_id: 'sess-1' });
    } catch (e) {
      threw = e;
    }
    assert(threw, 'expected add() to throw');
    assertEq(threw.code, 'ENOGSD', 'error.code');
    assert(/forge-runs:.*has no \.gsd\//.test(threw.message), 'message mentions missing .gsd/');
    assert(!fs.existsSync(path.join(dir, '.gsd')), '.gsd/ must NOT be manufactured');
  });
});

test('add() against a tmpdir WITH .gsd/ succeeds and creates .gsd/forge/runs/', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const rec = runs.add(dir, { id: 'M002', kind: 'milestone', session_id: 'sess-2' });
    assertEq(rec.id, 'M002', 'record.id');
    assert(fs.existsSync(runs.runsDir(dir)), '.gsd/forge/runs/ created');
    assert(fs.existsSync(runs.runFile(dir, 'M002')), 'run record file written');
  });
});

// ── Best-effort writer (refreshLegacyAlias) ─────────────────────────────────

test('refreshLegacyAlias() without .gsd/ silently no-ops: no throw, no .gsd/ created', () => {
  withSandbox(dir => {
    let threw = null;
    try {
      runs.refreshLegacyAlias(dir);
    } catch (e) {
      threw = e;
    }
    assertEq(threw, null, 'refreshLegacyAlias must never throw');
    assert(!fs.existsSync(path.join(dir, '.gsd')), '.gsd/ must NOT be manufactured');
  });
});

test('refreshLegacyAlias() with .gsd/ present still writes auto-mode.json mirror', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    runs.refreshLegacyAlias(dir);
    const aliasPath = path.join(dir, '.gsd', 'forge', 'auto-mode.json');
    assert(fs.existsSync(aliasPath), 'alias file written when .gsd/ exists');
    const mirror = JSON.parse(fs.readFileSync(aliasPath, 'utf8'));
    assertEq(mirror.active, false, 'no active runs → active:false');
  });
});

// ── CLI ───────────────────────────────────────────────────────────────────────

test('CLI --add without .gsd/ prints readable error (no stack trace) and exits 1', () => {
  withSandbox(dir => {
    const res = spawnSync(process.execPath, [
      CLI, '--add', '--id', 'M003', '--kind', 'milestone', '--session', 'sess-3', '--cwd', dir,
    ], { encoding: 'utf8' });
    assertEq(res.status, 1, 'exit code');
    assert(/forge-runs error:.*\/forge-init/.test(res.stderr), `stderr mentions /forge-init: ${res.stderr}`);
    assert(!/at Object|at Module|\.js:\d+:\d+/.test(res.stderr), `stderr has no stack trace: ${res.stderr}`);
    assert(!fs.existsSync(path.join(dir, '.gsd')), '.gsd/ must NOT be manufactured');
  });
});

test('CLI --migrate-legacy on an uninitialised dir exits 0 with migrated:false, creates nothing', () => {
  withSandbox(dir => {
    const res = spawnSync(process.execPath, [
      CLI, '--migrate-legacy', '--cwd', dir,
    ], { encoding: 'utf8' });
    assertEq(res.status, 0, 'exit code');
    const parsed = JSON.parse(res.stdout);
    assertEq(parsed.migrated, false, 'migrated:false');
    assertEq(parsed.reason, 'no STATE.md', 'reason');
    assert(!fs.existsSync(path.join(dir, '.gsd')), '.gsd/ must NOT be manufactured');
  });
});

test('CLI --add succeeds against an initialised dir', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const res = spawnSync(process.execPath, [
      CLI, '--add', '--id', 'M004', '--kind', 'milestone', '--session', 'sess-4', '--cwd', dir,
    ], { encoding: 'utf8' });
    assertEq(res.status, 0, 'exit code');
    const parsed = JSON.parse(res.stdout);
    assertEq(parsed.id, 'M004', 'record.id');
  });
});

// ── Address fields: branch / root / project (S06/T03) ───────────────────────
//
// These three are ADDITIVE. The proof that matters is not that they can be
// written — it is that the records written before they existed still load.
// At the time of writing there were 7 such records live on disk, none of them
// carrying any of the three, and none of them is migrated.

/** A record in the exact pre-T03 shape: no branch, no root, no project. */
function writeLegacyRecord(dir, id) {
  const file = path.join(dir, '.gsd', 'forge', 'runs', `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    kind: 'milestone',
    id,
    session_id: 'sess-legacy',
    active: true,
    started_at: 1785327373325,
    last_heartbeat: 1785338419005,
    worker: null,
    worker_started: null,
    isolation_mode: 'branch',
    milestone_dir: `.gsd/milestones/${id}/`,
    cwd: dir,
    account: 'lookchina',
    worktrees: [],
    attached_to: null,
  }, null, 2), 'utf8');
  return file;
}

test('legacy record (written before the address fields existed) loads — no migration, no throw', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const file = writeLegacyRecord(dir, 'M-legacy');
    const before = fs.readFileSync(file);
    // Guard the KEY, not the value: `"isolation_mode": "branch"` contains the
    // string `"branch"`, so a value-matching regex would pass vacuously here.
    assert(!/"branch"\s*:/.test(before.toString('utf8')), 'fixture is genuinely pre-T03');

    const rec = runs.get(dir, 'M-legacy');
    assert(rec, 'legacy record must load');
    assertEq(rec.id, 'M-legacy', 'id survives');
    assert(fs.readFileSync(file).equals(before), 'reading must NOT rewrite the record (no migration)');
  });
});

test('missing address fields read back as null — never undefined leaking through JSON', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    writeLegacyRecord(dir, 'M-legacy');
    const rec = runs.get(dir, 'M-legacy');

    assertEq(rec.branch, null, 'branch');
    assertEq(rec.root, null, 'root');
    assertEq(rec.project, null, 'project');

    // The distinction this makes: `undefined` vanishes through stringify, so a
    // consumer would see no key at all and could not tell "no value" from
    // "field does not exist".
    const json = JSON.stringify(rec);
    assert(/"branch":null/.test(json), `branch present as null: ${json}`);
    assert(/"root":null/.test(json), 'root present as null');
    assert(/"project":null/.test(json), 'project present as null');
  });
});

test('listAll() applies the same null defaults as get()', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    writeLegacyRecord(dir, 'M-legacy-a');
    writeLegacyRecord(dir, 'M-legacy-b');
    const all = runs.listAll(dir);
    assertEq(all.length, 2, 'both records listed');
    for (const r of all) {
      assertEq(r.branch, null, `${r.id} branch`);
      assertEq(r.root, null, `${r.id} root`);
      assertEq(r.project, null, `${r.id} project`);
    }
  });
});

test('round-trip: add() with branch/root/project → get() returns the same values', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    runs.add(dir, {
      id: 'M-addr', kind: 'milestone', session_id: 'sess-addr',
      branch: 'forge/M-addr', root: '~/Development', project: '/abs/project',
    });
    const rec = runs.get(dir, 'M-addr');
    assertEq(rec.branch, 'forge/M-addr', 'branch round-trips');
    assertEq(rec.root, '~/Development', 'root round-trips');
    assertEq(rec.project, '/abs/project', 'project round-trips');
  });
});

test('add() without address fields writes explicit nulls (default, not absence)', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const rec = runs.add(dir, { id: 'M-plain', kind: 'milestone', session_id: 'sess-plain' });
    assertEq(rec.branch, null, 'branch default');
    assertEq(rec.root, null, 'root default');
    assertEq(rec.project, null, 'project default');
    const onDisk = JSON.parse(fs.readFileSync(runs.runFile(dir, 'M-plain'), 'utf8'));
    assertEq(onDisk.branch, null, 'null is persisted, not omitted');
  });
});

test('two runs on the SAME project in different branches are distinguishable by address', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const a = runs.add(dir, { id: 'M-a', kind: 'milestone', session_id: 's-a', branch: 'forge/M-a', cwd: dir });
    const b = runs.add(dir, { id: 'M-b', kind: 'milestone', session_id: 's-b', branch: 'forge/M-b', cwd: dir });
    // The gap this closes: before `branch`, these two differed in NOTHING but
    // their filename — identical cwd, identical everything addressable.
    assertEq(a.cwd, b.cwd, 'same project: cwd is byte-identical (the original problem)');
    assert(a.branch !== b.branch, 'branch is what now tells them apart');
  });
});

test('update() with branch:"" (shared-mode resume interpolation) reads back as null, not ""', () => {
  // S06/T04 review R3. shared-mode resume in forge-auto/SKILL.md interpolates
  // `"branch":"$RUN_BRANCH"` directly into the --update JSON patch; when
  // $RUN_BRANCH is empty (shared isolation owns no branch) that writes the
  // literal string `""`, bypassing add()'s `|| null` normalization (update()
  // is a bare Object.assign with none of its own). Swift's `String?` decodes
  // `""` as `.some("")`, not `.none` — an `== nil` branch check downstream
  // would misclassify a shared-mode run as having a branch. The fix is on
  // READ (withAddressDefaults), so it must hold regardless of which write
  // path produced the empty string.
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    runs.add(dir, { id: 'M-empty-branch', kind: 'milestone', session_id: 's1', branch: 'forge/M-empty-branch', cwd: dir });
    runs.update(dir, 'M-empty-branch', { branch: '' });

    // Prove the empty string really does land on disk (the bug's precondition) —
    // if this assertion ever fails, the test above is vacuous.
    const onDiskRaw = JSON.parse(fs.readFileSync(path.join(dir, '.gsd', 'forge', 'runs', 'M-empty-branch.json'), 'utf8'));
    assertEq(onDiskRaw.branch, '', 'precondition: "" really is what update() persists verbatim');

    const rec = runs.get(dir, 'M-empty-branch');
    assertEq(rec.branch, null, 'get() must normalize "" to null, not echo it back');

    const listed = runs.listAll(dir).find(r => r.id === 'M-empty-branch');
    assertEq(listed.branch, null, 'listAll() must apply the same normalization as get()');
  });
});

test('unknown keys on a record survive a read (forward-compat)', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const file = writeLegacyRecord(dir, 'M-future');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.some_field_from_a_newer_forge = { nested: true };
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

    const rec = runs.get(dir, 'M-future');
    assertEq(rec.some_field_from_a_newer_forge, { nested: true }, 'unknown key preserved');
    assertEq(rec.branch, null, 'and the defaults still applied');
  });
});

test('CLI --add accepts --branch/--root/--project and records them verbatim', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const res = spawnSync(process.execPath, [
      CLI, '--add', '--id', 'M-cli', '--kind', 'milestone', '--session', 'sess-cli',
      '--branch', 'forge/M-cli', '--root', '~/Development', '--project', '/abs/proj',
      '--cwd', dir,
    ], { encoding: 'utf8' });
    assertEq(res.status, 0, `exit code: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assertEq(parsed.branch, 'forge/M-cli', 'branch');
    assertEq(parsed.root, '~/Development', 'root');
    assertEq(parsed.project, '/abs/proj', 'project');
  });
});

test('CLI --add with a valueless --branch records null, not the boolean true', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const res = spawnSync(process.execPath, [
      CLI, '--add', '--id', 'M-bool', '--kind', 'milestone', '--session', 'sess-bool',
      '--branch', '--cwd', dir,
    ], { encoding: 'utf8' });
    assertEq(res.status, 0, `exit code: ${res.stderr}`);
    assertEq(JSON.parse(res.stdout).branch, null, 'a flag with no value is not a branch name');
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────
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
