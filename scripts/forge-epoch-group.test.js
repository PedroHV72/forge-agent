#!/usr/bin/env node
'use strict';

// Standalone regression suite for the sealed-epoch grouping engine.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const group = require('./forge-epoch-group');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

function tmp() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-epoch-group-'));
  fs.mkdirSync(path.join(cwd, '.gsd', 'ledger'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.gsd', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.gsd', 'memory'), { recursive: true });
  return cwd;
}

function remove(cwd) { fs.rmSync(cwd, { recursive: true, force: true }); }
function write(cwd, rel, content) {
  const target = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function ledger(id, date, body) {
  return `---\nid: ${id}\ncompleted_at: ${date}\n---\n${body || id}\n`;
}

function decision(id, when) {
  return `---\nunit_id: ${id}\ndecisions:\n  - when: ${when}\n    scope: test\n    decision: group\n    choice: yes\n    rationale: test\n    revisable: false\n---\n`;
}

function memory(id, date) {
  return `---\nunit_id: ${id}\nfacts:\n  - mem_id: MEM-${id}\n    category: test\n    text: payload\n    created_at: ${date}\n    source_unit: ${id}\nstats: []\n---\n`;
}

function filesBelow(root) {
  const result = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else result.push(full);
    }
  }
  walk(root);
  return result.sort();
}

function seedAllStores(cwd) {
  write(cwd, '.gsd/ledger/M-20260101000000-old.md', ledger('M-20260101000000-old', '2026-01-01', 'old ledger'));
  write(cwd, '.gsd/ledger/M-20260401000000-current.md', ledger('M-20260401000000-current', '2026-04-01', 'current ledger'));
  write(cwd, '.gsd/decisions/T-20260101000000-old.md', decision('T-20260101000000-old', '2026-01-02'));
  write(cwd, '.gsd/decisions/T-20260401000000-current.md', decision('T-20260401000000-current', '2026-04-02'));
  write(cwd, '.gsd/memory/T-20260101000000-old.md', memory('T-20260101000000-old', '2026-01-03'));
  write(cwd, '.gsd/memory/T-20260401000000-current.md', memory('T-20260401000000-current', '2026-04-03'));
}

test('plans only sealed epochs and records the current epoch with a reason', () => {
  const cwd = tmp();
  try {
    seedAllStores(cwd);
    const planned = group.plan(cwd);
    assert.equal(planned.targets.length, 3);
    assert(planned.targets.every(target => target.epoch === '2026-Q1'));
    assert(planned.skipped.filter(item => /época corrente/.test(item.reason)).length === 3);
    assert(planned.skipped.every(item => typeof item.reason === 'string' && item.reason.length));
    for (const target of planned.targets) assert.equal(target.members.length, 1);
  } finally { remove(cwd); }
});

test('apply writes the described in-store containers before removing members', () => {
  const cwd = tmp();
  try {
    seedAllStores(cwd);
    const planned = group.plan(cwd);
    const applied = group.apply(cwd, planned);
    assert.equal(applied.written.length, 3);
    assert.equal(applied.removed.length, 3);
    assert.equal(applied.counts.filesBefore - applied.counts.filesAfter, 0);
    for (const target of planned.targets) {
      assert(fs.existsSync(target.containerPath));
      assert(!fs.existsSync(target.members[0].path));
      assert.equal(path.dirname(target.containerPath), path.dirname(target.members[0].path));
    }
    assert(!fs.existsSync(path.join(cwd, '.gsd', 'archive')));
  } finally { remove(cwd); }
});

test('a second plan and apply are byte-identical and have no targets', () => {
  const cwd = tmp();
  try {
    seedAllStores(cwd);
    const first = group.plan(cwd);
    group.apply(cwd, first);
    const before = first.targets.map(target => fs.readFileSync(target.containerPath));
    const second = group.plan(cwd);
    assert.equal(second.targets.length, 0);
    const secondApply = group.apply(cwd, second);
    assert.equal(secondApply.written.length, 0);
    first.targets.forEach((target, index) => {
      assert.equal(Buffer.compare(before[index], fs.readFileSync(target.containerPath)), 0);
    });
  } finally { remove(cwd); }
});

test('ungroup restores each original member byte-for-byte', () => {
  const cwd = tmp();
  try {
    seedAllStores(cwd);
    const planned = group.plan(cwd);
    const originals = new Map();
    for (const target of planned.targets) {
      for (const member of target.members) originals.set(member.path, fs.readFileSync(member.path));
    }
    group.apply(cwd, planned);
    for (const target of planned.targets) {
      const result = group.ungroup(cwd, target.containerPath);
      assert.equal(result.restored.length, target.members.length);
      for (const member of target.members) {
        assert.equal(Buffer.compare(originals.get(member.path), fs.readFileSync(member.path)), 0);
      }
    }
  } finally { remove(cwd); }
});

test('unresolved, grouped, delimiter, and legacy-orphan units are enumerated as skipped', () => {
  const cwd = tmp();
  try {
    write(cwd, '.gsd/ledger/plain.md', 'no date or id\n');
    write(cwd, '.gsd/ledger/M-20260101000000-delimiter.md', ledger('M-20260101000000-delimiter', '2026-01-01', '<!-- forge: unsafe -->'));
    write(cwd, '.gsd/memory/legacy-orphan.md', '<!-- gsd-auto-memory mem_id:MEM001 -->\n');
    // epochOfUnit resolves through three links — id, then dateHint, then the
    // file's mtime. `plain.md` has neither id nor date, but it was just
    // written, so link 3 succeeds and it is skipped as 'época corrente'
    // instead. 'época indeterminada' is only reachable when the stat itself
    // fails (the path vanishing between listing and stat). Stubbing statSync
    // for that one path is the deterministic, cross-platform way to reach the
    // branch this assertion names — mirroring what forge-memory-index.test.js
    // does with readFileSync. The mtime fallback is part of the format and is
    // NOT removed to make the assertion pass.
    const realStatSync = fs.statSync;
    fs.statSync = function (p, ...rest) {
      if (typeof p === 'string' && p.replace(/\\/g, '/').endsWith('/.gsd/ledger/plain.md')) {
        throw new Error('ENOENT: simulated vanished fragment');
      }
      return realStatSync.call(fs, p, ...rest);
    };
    let planned;
    try {
      planned = group.plan(cwd);
    } finally {
      fs.statSync = realStatSync;
    }
    const reasons = planned.skipped.map(item => item.reason).join('\n');
    assert(/época indeterminada/.test(reasons));
    assert(/delimitador no conteúdo/.test(reasons));
    assert(/legacy-orphan/.test(reasons));
  } finally { remove(cwd); }
});

test('apply rejects a hand-crafted path outside its store', () => {
  const cwd = tmp();
  try {
    const source = write(cwd, '.gsd/ledger/M-20260101000000-safe.md', ledger('M-20260101000000-safe', '2026-01-01'));
    const outside = path.join(cwd, '.gsd', 'archive', '2026-Q1.md');
    const result = group.apply(cwd, { targets: [{
      store: 'ledger', epoch: '2026-Q1', containerPath: outside,
      members: [{ id: 'M-20260101000000-safe', path: source }],
    }], skipped: [] });
    assert.equal(result.written.length, 0);
    assert(fs.existsSync(source));
    assert(!fs.existsSync(outside));
  } finally { remove(cwd); }
});

test('STORE_TARGETS declares all three fragment stores', () => {
  assert.deepEqual(group.STORE_TARGETS.map(item => item.name), ['ledger', 'decisions', 'memory']);
  for (const store of group.STORE_TARGETS) {
    assert.equal(typeof store.dir, 'function');
    assert.equal(typeof store.idOf, 'function');
    assert.equal(typeof store.dateHintOf, 'function');
  }
});

test('date hints group non-timestamp identifiers without inventing a size threshold', () => {
  const cwd = tmp();
  try {
    write(cwd, '.gsd/ledger/old-note.md', ledger('old-note', '2025-12-31', 'hint only'));
    write(cwd, '.gsd/ledger/current-note.md', ledger('current-note', '2026-04-01', 'hint only'));
    const planned = group.plan(cwd);
    const target = planned.targets.find(item => item.store === 'ledger');
    assert(target, 'one sealed hint-derived ledger member is groupable');
    assert.equal(target.epoch, '2025-Q4');
    assert.equal(target.members.length, 1);
    const applied = group.apply(cwd, planned);
    assert(applied.written.includes(target.containerPath));
    assert(fs.existsSync(target.containerPath));
    assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', 'current-note.md')));
  } finally { remove(cwd); }
});

test('the plan defaults to dry-run metadata and never writes implicitly', () => {
  const cwd = tmp();
  try {
    const old = write(cwd, '.gsd/ledger/M-20260101000000-old.md', ledger('M-20260101000000-old', '2026-01-01'));
    write(cwd, '.gsd/ledger/M-20260401000000-current.md', ledger('M-20260401000000-current', '2026-04-01'));
    const before = filesBelow(path.join(cwd, '.gsd', 'ledger'));
    const planned = group.plan(cwd);
    assert.equal(planned.dryRun, true);
    assert(planned.targets.length > 0);
    assert(fs.existsSync(old));
    assert.deepEqual(filesBelow(path.join(cwd, '.gsd', 'ledger')), before);
  } finally { remove(cwd); }
});

test('the default plan gates wrapper directories until explicitly enabled', () => {
  // This assertion is intentionally about the returned targets, not about
  // the implementation flag. It fails if wrappers leak back into default
  // enumeration even when the option name or its implementation changes.
  const cwd = tmp();
  try {
    seedAllStores(cwd);
    write(cwd, '.gsd/milestones/M-20260101000000-old/PLAN.md', 'old milestone');
    write(cwd, '.gsd/milestones/M-20260401000000-current/PLAN.md', 'current milestone');
    write(cwd, '.gsd/tasks/T-20260101000000-old/PLAN.md', 'old task');
    write(cwd, '.gsd/tasks/T-20260401000000-current/PLAN.md', 'current task');

    const planned = group.plan(cwd);
    assert(planned.targets.some(target => target.store === 'ledger'));
    assert(planned.targets.some(target => target.store === 'decisions'));
    assert(planned.targets.some(target => target.store === 'memory'));
    assert(planned.targets.every(target =>
      target.store !== 'milestone-wrappers' && target.store !== 'task-wrappers'));
    assert(planned.targets.length > 0, 'the default assertion must not pass by vacuity');
    assert(planned.skipped.every(item =>
      !/[\\/]\.gsd[\\/](milestones|tasks)[\\/]/.test(item.path)));

    const explicitlyEnabled = group.plan(cwd, { includeWrapperDirs: true });
    assert(explicitlyEnabled.targets.some(target => target.store === 'milestone-wrappers'));
    assert(explicitlyEnabled.targets.some(target => target.store === 'task-wrappers'));
    assert.equal(explicitlyEnabled.targets.filter(target =>
      target.store.endsWith('-wrappers')).length, 2);
    const stringFalse = group.plan(cwd, { includeWrapperDirs: 'false' });
    assert(stringFalse.targets.every(target =>
      target.store !== 'milestone-wrappers' && target.store !== 'task-wrappers'));
  } finally { remove(cwd); }
});

// Wrapper-directory contract: only the structural predicate from forge-epoch
// makes a directory eligible.  The fixture deliberately mixes valid, active,
// multi-file, and nested wrappers so enumeration also proves its diagnostics.
//
// Two fixture invariants are load-bearing and neither is decorative:
//
// 1. Ids use the shapes forge-ids actually mints — `M-<14>-slug` and
//    `T-<14>-slug`. `TASK-<14>-slug` is NOT one of them: timestampOf only
//    accepts `TASK-` in its dashed `TASK-YYYYMMDD-HHMMSS` form, so a compact
//    `TASK-<14>` id resolves no epoch from the id and silently falls through
//    epochOfUnit's chain to the file mtime — i.e. to "now" for a fixture file,
//    which lands every such unit in the current epoch and makes it unplannable.
//
// 2. Sealedness is computed PER STORE (sealedEpochs over that store's own
//    labels), so each store needs its own current-epoch occupant before any
//    older epoch inside it counts as sealed. That is T05's engine contract, and
//    it mirrors reality: a live .gsd always holds an active milestone/task.
//    Hence the tasks store gets its own current wrapper, not just milestones.
test('wrapper dirs plan only eligible sealed milestone/task directories', () => {
  const cwd = tmp();
  try {
    const roots = ['.gsd/milestones', '.gsd/tasks'];
    for (const root of roots) fs.mkdirSync(path.join(cwd, root), { recursive: true });
    for (const id of ['M-20260101000000-a', 'M-20260102000000-b', 'T-20260103000000-c']) {
      const root = id.startsWith('M') ? '.gsd/milestones' : '.gsd/tasks';
      write(cwd, `${root}/${id}/PLAN.md`, `original ${id}\r\n`);
    }
    write(cwd, '.gsd/milestones/M-20260104000000-two/A.md', 'a');
    write(cwd, '.gsd/milestones/M-20260104000000-two/B.md', 'b');
    write(cwd, '.gsd/milestones/M-20260105000000-nested/PLAN.md', 'x');
    fs.mkdirSync(path.join(cwd, '.gsd/milestones/M-20260105000000-nested', 'slices'));
    write(cwd, '.gsd/milestones/M-20260401000000-current/PLAN.md', 'current');
    write(cwd, '.gsd/tasks/T-20260401000000-current/PLAN.md', 'current');
    const planned = group.plan(cwd, { includeWrapperDirs: true });
    // One container per store, and the three eligible sealed wrappers land in
    // them: two milestones in 2026-Q1, one task in 2026-Q1.
    assert.equal(planned.targets.length, 2);
    assert(planned.targets.every(target => target.epoch === '2026-Q1'));
    assert.equal(planned.targets.reduce((total, target) => total + target.members.length, 0), 3);
    assert.equal(planned.targets.find(target => target.store === 'milestone-wrappers').members.length, 2);
    assert.equal(planned.targets.find(target => target.store === 'task-wrappers').members.length, 1);
    assert(planned.skipped.some(item => item.reason.includes('2 arquivos')));
    assert(planned.skipped.some(item => item.reason.includes('subpasta slices/')));
    assert(planned.skipped.some(item => item.reason.includes('época corrente')));
    // The ineligible wrappers stay untouched on disk.
    assert(fs.existsSync(path.join(cwd, '.gsd/milestones/M-20260104000000-two/A.md')));
    assert(fs.existsSync(path.join(cwd, '.gsd/milestones/M-20260105000000-nested/slices')));
  } finally { remove(cwd); }
});

test('wrapper apply is in-place, removes dirs, and never creates archive', () => {
  const cwd = tmp();
  try {
    const original = write(cwd, '.gsd/milestones/M-20260101000000-one/STATE.md', Buffer.from('bom\r\nconteúdo', 'utf8'));
    write(cwd, '.gsd/milestones/M-20260401000000-current/STATE.md', 'live');
    const planned = group.plan(cwd, { includeWrapperDirs: true });
    const result = group.apply(cwd, planned);
    assert.equal(result.written.length, 1);
    assert(!fs.existsSync(path.dirname(original)));
    assert(fs.existsSync(path.join(cwd, '.gsd/milestones/2026-Q1.md')));
    assert(!fs.existsSync(path.join(cwd, '.gsd/archive')));
    assert(result.counts.dirsAfter < result.counts.dirsBefore);
    assert(!fs.existsSync(original));
  } finally { remove(cwd); }
});

// Reversibility is the core guarantee: the wrapper's original FILENAME is not
// derivable from the id, so the container has to carry it. It travels in the
// marker id as `<dirId>~<fileName>`, which is what lets ungroup rebuild
// `<parent>/<dirId>/<fileName>` instead of guessing a name.
test('wrapper ungroup restores original filename and bytes exactly', () => {
  const cwd = tmp();
  try {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0x0d, 0x0a, 0x42]);
    // A filename that no convention would reproduce from the id alone, so a
    // restore that merely guessed a canonical name could not pass this.
    const source = write(cwd, '.gsd/tasks/T-20260101000000-one/NOTES-original.md', bytes);
    // The tasks store needs its own current-epoch occupant for 2026-Q1 to be
    // sealed there — sealedness is per store. See the eligibility test above.
    write(cwd, '.gsd/tasks/T-20260401000000-current/PLAN.md', 'live');
    const plan = group.plan(cwd, { includeWrapperDirs: true });
    const applied = group.apply(cwd, plan);
    assert.equal(applied.written.length, 1, 'the sealed task wrapper produced a container');
    assert(!fs.existsSync(source), 'the wrapper file is gone once grouped');
    assert(!fs.existsSync(path.dirname(source)), 'the wrapper dir is gone once grouped');
    // The filename survives inside the container, not merely in memory.
    assert(fs.readFileSync(applied.written[0]).toString('utf8')
      .includes('T-20260101000000-one~NOTES-original.md'));

    const result = group.ungroup(cwd, applied.written[0]);
    assert.deepEqual(result.restored, [source]);
    assert(fs.existsSync(source), 'the original path is rebuilt with its original filename');
    assert.equal(Buffer.compare(fs.readFileSync(source), bytes), 0);
    assert(!fs.existsSync(applied.written[0]), 'the container is consumed by ungroup');
    // The untouched current wrapper is unaffected by the round-trip.
    assert(fs.existsSync(path.join(cwd, '.gsd/tasks/T-20260401000000-current/PLAN.md')));
  } finally { remove(cwd); }
});

test('wrapper apply is idempotent after the first plan is consumed', () => {
  const cwd = tmp();
  try {
    write(cwd, '.gsd/milestones/M-20260101000000-one/PLAN.md', 'one');
    write(cwd, '.gsd/milestones/M-20260401000000-current/PLAN.md', 'live');
    const firstPlan = group.plan(cwd, { includeWrapperDirs: true });
    const first = group.apply(cwd, firstPlan);
    // Captured BEFORE the second apply — comparing a post-apply read against
    // itself was 0 unconditionally and proved nothing about stability.
    const afterFirst = fs.readFileSync(first.written[0]);
    const second = group.apply(cwd, group.plan(cwd, { includeWrapperDirs: true }));
    assert.equal(second.written.length, 0);
    assert.equal(group.plan(cwd, { includeWrapperDirs: true }).targets.length, 0);
    assert.equal(Buffer.compare(afterFirst, fs.readFileSync(first.written[0])), 0,
      'the container bytes are untouched by a second apply');
  } finally { remove(cwd); }
});

// R2: the marker id is `dirId~fileName` and the split takes the FIRST `~`, so
// grouping `foo~bar/PLAN.md` would restore it to `foo/bar~PLAN.md` — a silent
// relocation, invisible because the original is deleted first.
test('never groups a wrapper whose directory name contains the reserved separator', () => {
  const cwd = tmp();
  try {
    const source = write(cwd, '.gsd/tasks/T-20260101000000-one~sub/PLAN.md', 'payload');
    write(cwd, '.gsd/tasks/T-20260401000000-current/PLAN.md', 'live');
    const planned = group.plan(cwd, { includeWrapperDirs: true });
    assert.equal(planned.targets.length, 0, 'the ~ wrapper is not a grouping target');
    assert(planned.skipped.some(item => /separador reservado/.test(item.reason)),
      `expected a reserved-separator reason, got ${JSON.stringify(planned.skipped)}`);
    group.apply(cwd, planned);
    assert(fs.existsSync(source), 'the wrapper file is left exactly where it was');
  } finally { remove(cwd); }
});

// R6: splitWrapperMarkerId requires .md, so apply() rejected a non-.md member
// by discarding the ENTIRE epoch target under a misleading reason.
test('skips only the non-.md wrapper and still groups its epoch siblings', () => {
  const cwd = tmp();
  try {
    const stray = write(cwd, '.gsd/tasks/T-20260102000000-two/notes.txt', 'not markdown');
    const groupable = write(cwd, '.gsd/tasks/T-20260101000000-one/PLAN.md', 'payload');
    write(cwd, '.gsd/tasks/T-20260401000000-current/PLAN.md', 'live');
    const planned = group.plan(cwd, { includeWrapperDirs: true });
    assert.equal(planned.targets.length, 1, 'the epoch survives one ineligible wrapper');
    assert.equal(planned.targets[0].members.length, 1);
    assert(planned.skipped.some(item => /não é \.md/.test(item.reason)),
      `expected a non-.md reason, got ${JSON.stringify(planned.skipped)}`);
    const applied = group.apply(cwd, planned);
    assert.equal(applied.written.length, 1, 'the .md sibling is grouped');
    assert(!fs.existsSync(groupable));
    assert(fs.existsSync(stray), 'the non-.md wrapper is untouched');
  } finally { remove(cwd); }
});

// R3: the wrapper branch guards the destination and throws; the store branch
// wrote straight over it. By the loose-wins invariant the clobbered file is the
// canonical one.
test('refuses to restore a store member over an existing loose file', () => {
  const cwd = tmp();
  try {
    write(cwd, '.gsd/ledger/M-20260101000000-old.md', ledger('M-20260101000000-old', '2026-01-01', 'grouped body'));
    write(cwd, '.gsd/ledger/M-20260401000000-current.md', ledger('M-20260401000000-current', '2026-04-01'));
    const applied = group.apply(cwd, group.plan(cwd));
    const container = applied.written.find(item => item.includes(`${path.sep}ledger${path.sep}`));
    const canonical = write(cwd, '.gsd/ledger/M-20260101000000-old.md', 'loose wins — do not clobber');
    assert.throws(() => group.ungroup(cwd, container), /destination already exists/);
    assert.equal(fs.readFileSync(canonical, 'utf8'), 'loose wins — do not clobber');
    assert(fs.existsSync(container), 'the container is not consumed by a refused ungroup');
  } finally { remove(cwd); }
});

// B1: a container survives a failure that reaches only some of its members —
// a second ungroup() must complete the restoration instead of relaunching the
// whole thing from the member that already crashed it. treeSnapshot mirrors
// the byte-level idiom from forge-sweep-project.test.js:48.
function treeSnapshot(root) {
  const rows = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        rows.push({ relative, kind: 'dir' });
        visit(full);
      } else {
        rows.push({ relative, kind: 'file', bytes: fs.readFileSync(full).toString('base64') });
      }
    }
  }
  visit(root);
  return rows.sort((a, b) => a.relative.localeCompare(b.relative));
}

test('B1 store: ungroup is resumable after a partial failure and idempotent on byte-identical retries', () => {
  const cwd = tmp();
  try {
    write(cwd, '.gsd/ledger/M-20260101000000-one.md', ledger('M-20260101000000-one', '2026-01-01', 'member one'));
    write(cwd, '.gsd/ledger/M-20260102000000-two.md', ledger('M-20260102000000-two', '2026-01-02', 'member two'));
    write(cwd, '.gsd/ledger/M-20260103000000-three.md', ledger('M-20260103000000-three', '2026-01-03', 'member three'));
    write(cwd, '.gsd/ledger/M-20260401000000-current.md', ledger('M-20260401000000-current', '2026-04-01', 'current ledger'));
    const preApplySnapshot = treeSnapshot(path.join(cwd, '.gsd'));

    const planned = group.plan(cwd);
    const target = planned.targets.find(item => item.store === 'ledger');
    assert(target, 'the three sealed ledger members are groupable');
    assert.equal(target.members.length, 3);
    const originals = new Map(target.members.map(member => [member.path, fs.readFileSync(member.path)]));
    const applied = group.apply(cwd, planned);
    assert(applied.written.includes(target.containerPath));

    // Simulate a crash mid-restoration: member one is restored by hand with
    // its original bytes (as a prior partial ungroup() would have left it),
    // and member two is planted with DIFFERENT bytes — a genuine conflict.
    const memberOne = target.members.find(member => /one/.test(member.path));
    const memberTwo = target.members.find(member => /two/.test(member.path));
    fs.writeFileSync(memberOne.path, originals.get(memberOne.path));
    fs.writeFileSync(memberTwo.path, 'conflicting content — not the grouped payload');

    assert.throws(() => group.ungroup(cwd, target.containerPath), /destination already exists with different content/);
    assert(fs.existsSync(target.containerPath), 'the container survives a refused ungroup');
    assert.equal(fs.readFileSync(memberOne.path).toString('utf8'), originals.get(memberOne.path).toString('utf8'),
      'the already-restored member is untouched by the failed retry');

    // Resolve the conflict as an operator would, then retry.
    fs.writeFileSync(memberTwo.path, originals.get(memberTwo.path));
    const result = group.ungroup(cwd, target.containerPath);
    assert.equal(result.restored.length, 1, 'only member three needed a fresh write');
    assert.equal(result.alreadyPresent.length, 2, 'members one and two were already byte-identical on disk');
    assert(result.alreadyPresent.includes(memberOne.path));
    assert(result.alreadyPresent.includes(memberTwo.path));
    assert(!fs.existsSync(target.containerPath), 'the container is removed once every member is accounted for');
    for (const member of target.members) {
      assert.equal(Buffer.compare(originals.get(member.path), fs.readFileSync(member.path)), 0);
    }
    assert.deepEqual(treeSnapshot(path.join(cwd, '.gsd')), preApplySnapshot,
      'the final tree is byte-identical to the state before apply()');
  } finally { remove(cwd); }
});

// B1 wrapper branch — same scenario, guarding :374's existsSync check instead
// of the store branch's :389.
test('B1 wrapper: ungroup is resumable after a partial failure and idempotent on byte-identical retries', () => {
  const cwd = tmp();
  try {
    const bytesOne = Buffer.from('member one payload\r\n', 'utf8');
    const bytesTwo = Buffer.from('member two payload\r\n', 'utf8');
    const sourceOne = write(cwd, '.gsd/tasks/T-20260101000000-one/NOTES.md', bytesOne);
    const sourceTwo = write(cwd, '.gsd/tasks/T-20260102000000-two/NOTES.md', bytesTwo);
    write(cwd, '.gsd/tasks/T-20260401000000-current/PLAN.md', 'live');
    const preApplySnapshot = treeSnapshot(path.join(cwd, '.gsd'));

    const planned = group.plan(cwd, { includeWrapperDirs: true });
    const target = planned.targets.find(item => item.store === 'task-wrappers');
    assert(target, 'the two sealed task wrappers are groupable');
    assert.equal(target.members.length, 2);
    const applied = group.apply(cwd, planned);
    assert.equal(applied.written.length, 1);
    const container = applied.written[0];

    // Wrapper dir + destination for member one restored by hand (a prior
    // partial ungroup would have left exactly this on disk); member two's
    // wrapper dir is planted with a conflicting destination.
    fs.mkdirSync(sourceOne.replace(/[\\/]NOTES\.md$/, ''), { recursive: true });
    fs.writeFileSync(sourceOne, bytesOne);
    fs.mkdirSync(sourceTwo.replace(/[\\/]NOTES\.md$/, ''), { recursive: true });
    fs.writeFileSync(sourceTwo, 'conflicting content — not the grouped payload');

    assert.throws(() => group.ungroup(cwd, container), /destination already exists with different content/);
    assert(fs.existsSync(container), 'the container survives a refused ungroup');
    assert.equal(fs.readFileSync(sourceOne).toString('utf8'), bytesOne.toString('utf8'),
      'the already-restored wrapper member is untouched by the failed retry');

    fs.writeFileSync(sourceTwo, bytesTwo);
    const result = group.ungroup(cwd, container);
    assert.equal(result.restored.length, 0, 'both wrapper members were already byte-identical on disk');
    assert.equal(result.alreadyPresent.length, 2);
    assert(result.alreadyPresent.includes(sourceOne));
    assert(result.alreadyPresent.includes(sourceTwo));
    assert(!fs.existsSync(container), 'the container is removed once every member is accounted for');
    assert.equal(Buffer.compare(fs.readFileSync(sourceOne), bytesOne), 0);
    assert.equal(Buffer.compare(fs.readFileSync(sourceTwo), bytesTwo), 0);
    assert.deepEqual(treeSnapshot(path.join(cwd, '.gsd')), preApplySnapshot,
      'the final tree is byte-identical to the state before apply()');
  } finally { remove(cwd); }
});

test('B1: a wrapper directory that already exists (not planted by a prior partial ungroup) is reused, not rejected', () => {
  const cwd = tmp();
  try {
    const bytes = Buffer.from('payload\n', 'utf8');
    const source = write(cwd, '.gsd/tasks/T-20260101000000-one/NOTES.md', bytes);
    write(cwd, '.gsd/tasks/T-20260401000000-current/PLAN.md', 'live');
    const planned = group.plan(cwd, { includeWrapperDirs: true });
    const applied = group.apply(cwd, planned);
    assert.equal(applied.written.length, 1);

    // The wrapper directory exists (as it would mid-restore) but is empty —
    // this must not throw merely because fs.existsSync(wrapper) is true.
    fs.mkdirSync(source.replace(/[\\/]NOTES\.md$/, ''), { recursive: true });
    const result = group.ungroup(cwd, applied.written[0]);
    assert.equal(result.restored.length, 1);
    assert(fs.existsSync(source));
    assert.equal(Buffer.compare(fs.readFileSync(source), bytes), 0);
  } finally { remove(cwd); }
});

test('B1: pure idempotent skip — every destination already byte-identical yields an empty restored list', () => {
  const cwd = tmp();
  try {
    write(cwd, '.gsd/ledger/M-20260101000000-one.md', ledger('M-20260101000000-one', '2026-01-01', 'member one'));
    write(cwd, '.gsd/ledger/M-20260102000000-two.md', ledger('M-20260102000000-two', '2026-01-02', 'member two'));
    write(cwd, '.gsd/ledger/M-20260401000000-current.md', ledger('M-20260401000000-current', '2026-04-01', 'current ledger'));
    const planned = group.plan(cwd);
    const target = planned.targets.find(item => item.store === 'ledger');
    const originals = new Map(target.members.map(member => [member.path, fs.readFileSync(member.path)]));
    const applied = group.apply(cwd, planned);
    const container = applied.written.find(item => item === target.containerPath);

    // Nothing is deleted — restore every member by hand with identical bytes
    // before ungroup() ever runs, simulating a fully-completed prior attempt
    // whose only remaining step was removing the container.
    for (const [memberPath, content] of originals) fs.writeFileSync(memberPath, content);

    const result = group.ungroup(cwd, container);
    assert.deepEqual(result.restored, []);
    assert.equal(result.alreadyPresent.length, target.members.length);
    assert(!fs.existsSync(container));
    for (const [memberPath, content] of originals) {
      assert.equal(Buffer.compare(fs.readFileSync(memberPath), content), 0);
    }
  } finally { remove(cwd); }
});

console.log(`\nforge-epoch-group: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
