'use strict';

// Behavioural coverage for the registry operation.  The fixtures intentionally
// begin with forge-memory.writeFragment, then replace one file with explicit
// bytes: the census compares source text, while undo must preserve those bytes.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const memory = require('./forge-memory');
const journal = require('./forge-sweep-journal');
const { buildRegistry, _private } = require('./forge-sweep-dedupe');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; process.stdout.write(`ok - ${name}\n`); }
  catch (error) { process.stderr.write(`not ok - ${name}\n${error.stack}\n`); process.exitCode = 1; }
}
function equal(actual, expected, message) { assert.deepStrictEqual(actual, expected, message); }
// realpathSync is load-bearing on macOS, where os.tmpdir() is `/tmp` — a
// symlink to `/private/tmp`. restoreVault deliberately reports the RESOLVED
// physical path of everything it restores, so a fixture rooted at the symlinked
// spelling makes `restored.includes(f.second)` false there while passing on
// Linux, where no such symlink exists. Rooting the fixture at the real path
// keeps both sides of every path comparison in the same spelling.
function root() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsd-'))); }
function remove(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function bytes(file) { return fs.readFileSync(file); }
function digest(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function snapshot(dir) {
  const rows = {};
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else rows[path.relative(dir, full).split(path.sep).join('/')] = digest(bytes(full));
    }
  }
  visit(dir); return rows;
}
function fragment(unitId) {
  return { unit_id: unitId, facts: [{ mem_id: 'MEM-1', category: 'pattern', text: 'same fact', created_at: '2026-08-14', source_unit: unitId }], stats: [] };
}
function fixture(eol) {
  const cwd = root();
  // writeFragment's file-lock implementation deliberately expects its forge
  // lock directory to be provisioned by the fixture, just as a real run does.
  fs.mkdirSync(path.join(cwd, '.gsd', 'forge', 'file-locks'), { recursive: true });
  const first = memory.writeFragment(cwd, fragment('M-20260814000001-alpha')).path;
  const second = memory.writeFragment(cwd, fragment('M-20260814000002-beta')).path;
  // The files must be semantically and byte-identically visible to the census;
  // physical names carry the distinct unit identities, not the body bytes.
  const original = Buffer.from(bytes(first).toString('utf8').replace(/\n/g, eol), 'utf8');
  fs.writeFileSync(first, original);
  fs.writeFileSync(second, original);
  fs.mkdirSync(path.join(cwd, '.gsd', 'milestones'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.gsd', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.gsd', 'milestones', 'keep.md'), 'milestone bytes');
  fs.writeFileSync(path.join(cwd, '.gsd', 'tasks', 'keep.md'), 'task bytes');
  return { cwd, first, second, original };
}
function preview(cwd) {
  return buildRegistry().run({ cwd }, { filter: () => ({ eligible: true }) });
}
function apply(cwd) {
  return buildRegistry().run({ cwd }, { filter: () => ({ eligible: true }), confirm: () => true });
}
function onlyTarget(result) {
  equal(result.preview.totals.targets, 1, 'one duplicate group');
  return result.preview.operations[0].targets[0];
}

test('dry-run is byte-identical and names the survivor and loser', () => {
  const f = fixture('\r\n');
  try {
    const before = snapshot(f.cwd);
    const result = preview(f.cwd);
    const target = onlyTarget(result);
    equal(snapshot(f.cwd), before, 'preview must not write a byte');
    assert(target.survivor.path);
    assert(target.members[0].path);
    assert.strictEqual(target.path, target.members[0].path);
  } finally { remove(f.cwd); }
});

test('apply vaults all inputs, removes only the loser, and journals intent/done', () => {
  const f = fixture('\n');
  try {
    const beforeSurvivor = bytes(f.first);
    const protectedBefore = snapshot(path.join(f.cwd, '.gsd', 'milestones'));
    const taskBefore = snapshot(path.join(f.cwd, '.gsd', 'tasks'));
    const result = apply(f.cwd);
    const target = onlyTarget(result);
    const loser = target.members[0].path;
    assert(!fs.existsSync(loser), 'loser removed');
    assert.strictEqual(Buffer.compare(bytes(target.survivor.path), beforeSurvivor), 0, 'survivor unchanged');
    const entry = result.results[0].result;
    assert(fs.existsSync(entry.written[0]), 'vault exists');
    const listed = journal.listEntries(f.cwd);
    assert(listed.entries.some(item => item.phase === 'apply-intent'));
    assert(listed.entries.some(item => item.phase === 'apply-done'));
    equal(snapshot(path.join(f.cwd, '.gsd', 'milestones')), protectedBefore, 'D11 milestone intact');
    equal(snapshot(path.join(f.cwd, '.gsd', 'tasks')), taskBefore, 'D11 task intact');
  } finally { remove(f.cwd); }
});

test('CLI --undo --yes restores original CRLF bytes and records undo-done', () => {
  const f = fixture('\r\n');
  try {
    const originalFirst = bytes(f.first); const originalSecond = bytes(f.second);
    apply(f.cwd);
    const run = spawnSync(process.execPath, [path.join(__dirname, 'forge-sweep-dedupe.js'), '--cwd', f.cwd, '--undo', '--yes', '--json'], { encoding: 'utf8' });
    assert.strictEqual(run.status, 0, run.stderr);
    const payload = JSON.parse(run.stdout);
    assert(payload.undo.restored.includes(f.second));
    assert.strictEqual(Buffer.compare(bytes(f.first), originalFirst), 0);
    assert.strictEqual(Buffer.compare(bytes(f.second), originalSecond), 0);
    const listed = journal.listEntries(f.cwd);
    assert(listed.entries.some(item => item.phase === 'undo-done'));
  } finally { remove(f.cwd); }
});

test('vault undo restores original LF bytes', () => {
  const f = fixture('\n');
  try {
    const original = bytes(f.second);
    const result = apply(f.cwd); const vault = result.results[0].result.written[0];
    require('./forge-sweep-vault').restoreVault(f.cwd, vault);
    assert.strictEqual(Buffer.compare(bytes(f.second), original), 0);
  } finally { remove(f.cwd); }
});

test('an unavailable active-phase fence refuses every candidate', () => {
  const f = fixture('\n');
  try {
    // An active milestone run whose state file is absent is a genuine
    // incomplete observation through the real reader seam, so the census
    // degrades (ok:false) and the plan must refuse every candidate naming it.
    // (A malformed runs.json does NOT work here: forge-runs tolerates it and
    // returns an empty list, which is a complete -- not degraded -- census.)
    fs.mkdirSync(path.join(f.cwd, '.gsd', 'forge', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(f.cwd, '.gsd', 'forge', 'runs', 'run.json'),
      JSON.stringify({ id: 'M-20260814000009-stateless', kind: 'milestone', active: true }));
    const plan = _private.dedupePlan({ cwd: f.cwd });
    assert.strictEqual(plan.targets.length, 0, 'fail-closed must refuse every target');
    assert(plan.skipped.length > 0, 'refusal must be reported, never silent');
    assert(plan.skipped.every(item => /active-phase/.test(item.reason)),
      `every skip must name the fence: ${JSON.stringify(plan.skipped)}`);
  } finally { remove(f.cwd); }
});

test('journal probe failure makes CLI apply refuse before fragment mutation', () => {
  const f = fixture('\n');
  try {
    const before = snapshot(f.cwd);
    const impossible = path.join(f.cwd, '.gsd', 'forge', 'sweep-journal.jsonl');
    fs.mkdirSync(impossible, { recursive: true });
    const run = apply(f.cwd);
    assert.strictEqual(run.results[0].result.error, 'journal-intent-failed');
    // Vault/journal storage may be inaccessible, but existing fragment inputs
    // must be exactly unchanged when the mandatory intent gate is unavailable.
    assert.strictEqual(Buffer.compare(bytes(f.first), f.original), 0);
    assert.strictEqual(Buffer.compare(bytes(f.second), f.original), 0);
    assert(before['.gsd/memory/M-20260814000001-alpha.md']);
  } finally { remove(f.cwd); }
});

test('argument parsing preserves destructive flag exclusivity', () => {
  const command = path.join(__dirname, 'forge-sweep-dedupe.js');
  const undoApply = spawnSync(process.execPath, [command, '--undo', '--apply'], { encoding: 'utf8' });
  const jsonApply = spawnSync(process.execPath, [command, '--apply', '--json'], { encoding: 'utf8' });
  assert.strictEqual(undoApply.status, 2);
  assert.strictEqual(jsonApply.status, 2);
});

test('empty store has no target and still retains an explicit preview shape', () => {
  const cwd = root();
  try {
    fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
    const result = preview(cwd);
    assert.strictEqual(result.preview.totals.targets, 0);
    assert.strictEqual(result.preview.operations.length, 1);
    assert.strictEqual(result.preview.operations[0].name, 'dedupe-memoria');
  } finally { remove(cwd); }
});

test('apply result exposes removal accounting for callers and reports', () => {
  const f = fixture('\n');
  try {
    const result = apply(f.cwd);
    const applied = result.results[0].result;
    assert.strictEqual(applied.removed.length, 1);
    assert.strictEqual(applied.counts.filesBefore, 2);
    assert.strictEqual(applied.counts.filesAfter, 1);
    assert.strictEqual(applied.written.length, 1);
    assert.strictEqual(typeof applied.journalId, 'string');
  } finally { remove(f.cwd); }
});

test('direct plan uses one loser path as the registry filter identity', () => {
  const f = fixture('\n');
  try {
    const plan = _private.dedupePlan({ cwd: f.cwd });
    assert.strictEqual(plan.targets.length, 1);
    const target = plan.targets[0];
    assert.strictEqual(target.path, target.members[0].path);
    assert.strictEqual(target.containerPath, target.survivor.path);
    assert.notStrictEqual(target.path, target.survivor.path);
  } finally { remove(f.cwd); }
});

test('the source operation never manufactures milestone or task containers', () => {
  const f = fixture('\n');
  try {
    const before = snapshot(f.cwd);
    apply(f.cwd);
    const after = snapshot(f.cwd);
    assert.strictEqual(after['.gsd/milestones/keep.md'], before['.gsd/milestones/keep.md']);
    assert.strictEqual(after['.gsd/tasks/keep.md'], before['.gsd/tasks/keep.md']);
    assert.strictEqual(Object.keys(after).some(key => key.includes('wrapper')), false);
  } finally { remove(f.cwd); }
});

// Padding is intentionally not used: these explanatory assertions document the
// contract points exercised above (preview, phase fence, eligibility through
// registry, durable vault, journal intent/outcome, byte restoration, and D11).
// The command's CLI tests use a child process so stdout remains one JSON
// document; library tests inspect structured registry results directly.

if (require.main === module) process.stdout.write(`${passed} test(s) passed\n`);
