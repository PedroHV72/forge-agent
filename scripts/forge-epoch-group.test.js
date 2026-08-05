#!/usr/bin/env node
'use strict';

// Standalone regression suite for the sweep-based grouping engine (S09).
//
// The calendar axis (epoch/quarter, "época corrente") is gone. Selection is
// now a verdict from forge-sweep-sealed's sealedBy() per member; naming comes
// from a single sweep number shared across every store the plan touches
// (DS9-3). The test that matters most here is PRECISION (a member with no
// proof at all is skipped, by name, even surrounded by eligible members) —
// round-trip byte-identity does not catch this slice's failure mode.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const group = require('./forge-epoch-group');
const journal = require('./forge-sweep-journal');
const { serializeGroup } = require('./forge-grouped-file');

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

function ledgerFragment(id, date, body) {
  return `---\nid: ${id}\ncompleted_at: ${date}\n---\n${body || id}\n`;
}

function decisionFragment(id, when) {
  return `---\nunit_id: ${id}\ndecisions:\n  - when: ${when}\n    scope: test\n    decision: group\n    choice: yes\n    rationale: test\n    revisable: false\n---\n`;
}

// Seeds ledger proof (a) for each id via an ALREADY-GROUPED container. A
// LOOSE ledger fragment for the same id would also make plan()'s ledger-store
// loop treat it as its own independently-groupable member — an extra target
// (or an extra member inside the ledger target) that wrapper/store fixtures
// below do not expect, since plan() skips an already-grouped file outright
// ('já agrupado') instead of listing it as loose. The filename deliberately
// does not match sweep-project-NN so it never perturbs nextSweepNumber().
function seedLedgerProof(cwd, ids) {
  const units = ids.map(id => ({ id, content: Buffer.from(ledgerFragment(id, '2026-01-01'), 'utf8') }));
  const serialized = serializeGroup({ label: 'sweep-project-00', units });
  write(cwd, '.gsd/ledger/seed-closure-proof.md', serialized.buffer);
}

function memoryFragment(id, date) {
  return `---\nunit_id: ${id}\nfacts:\n  - mem_id: MEM-${id}\n    category: test\n    text: payload\n    created_at: ${date}\n    source_unit: ${id}\nstats: []\n---\n`;
}

// A container built by hand, byte for byte, in the shape PR 1 actually wrote:
// no grouped_from/grouped_to lines at all (T03 added those). Deliberately NOT
// routed through serializeGroup — that would only prove the new writer is
// consistent with itself, not that the reader still understands the old
// format (DS9-1).
function legacyContainerBytes(id, content) {
  const header = [
    '---',
    'grouped_format: forge-group@1',
    'grouped_epoch: 2026-Q1',
    'grouped_units: 1',
    '---',
    '',
    '',
  ].join('\n');
  const payload = Buffer.from(content, 'utf8');
  const start = `<!-- forge:unit id=${id} bytes=${payload.length} -->\n`;
  const end = `\n<!-- forge:endunit id=${id} -->\n`;
  return Buffer.concat([Buffer.from(header, 'utf8'), Buffer.from(start, 'utf8'), payload, Buffer.from(end, 'utf8')]);
}

test('STORE_TARGETS declares all three fragment stores', () => {
  assert.deepEqual(group.STORE_TARGETS.map(item => item.name), ['ledger', 'decisions', 'memory']);
  for (const store of group.STORE_TARGETS) {
    assert.equal(typeof store.dir, 'function');
    assert.equal(typeof store.idOf, 'function');
    assert.equal(typeof store.dateHintOf, 'function');
  }
});

test('precision: a member with no proof at all is skipped by name, even surrounded by eligible members', () => {
  const cwd = tmp();
  try {
    // Deliberately the MEMORY store, not ledger: sealedBy's proof (a) checks
    // `ledgerIds` against the LEDGER directory, a genuinely separate store —
    // a ledger-store fixture would trivially self-satisfy proof (a) by its
    // own presence in that same directory listing, which would prove nothing
    // about a member with no proof at all.
    write(cwd, '.gsd/memory/T-20260101000000-one.md', memoryFragment('T-20260101000000-one', '2026-01-01'));
    write(cwd, '.gsd/memory/T-20260102000000-two.md', memoryFragment('T-20260102000000-two', '2026-01-02'));
    write(cwd, '.gsd/memory/T-20260103000000-three.md', memoryFragment('T-20260103000000-three', '2026-01-03'));
    // A memory-store id's own timestamp is creation, not closure (proof (b)
    // narrowing) — each of the three eligible members needs a real ledger
    // entry (proof a) naming its owning task id to be groupable.
    write(cwd, '.gsd/ledger/T-20260101000000-one.md', ledgerFragment('T-20260101000000-one', '2026-01-01'));
    write(cwd, '.gsd/ledger/T-20260102000000-two.md', ledgerFragment('T-20260102000000-two', '2026-01-02'));
    write(cwd, '.gsd/ledger/T-20260103000000-three.md', ledgerFragment('T-20260103000000-three', '2026-01-03'));
    // A bare local unit id, per the B1 finding: it passes parseStorageKey
    // (so it is NOT extinct), has no timestamp in the id, and the ledger
    // store (untouched in this fixture) has no entry naming it — no proof
    // of any of the three kinds fires.
    write(cwd, '.gsd/memory/S02.md', memoryFragment('S02', '2026-01-01'));
    const planned = group.plan(cwd);
    const target = planned.targets.find(item => item.store === 'memory');
    assert(target, 'the three eligible members produce a target');
    assert.equal(target.members.length, 3);
    assert(target.members.every(member => member.id !== 'S02'));
    const skip = planned.skipped.find(item => /S02\.md$/.test(item.path));
    assert(skip, 'S02 is named in skipped, not silently dropped');
    assert(/sem prova de encerramento/.test(skip.reason));
  } finally { remove(cwd); }
});

test('legacy-orphan is skipped in all three stores by the shared proof module (DS9-6)', () => {
  const cwd = tmp();
  try {
    write(cwd, '.gsd/ledger/legacy-orphan.md', '<!-- gsd-auto-memory mem_id:MEM001 -->\n');
    write(cwd, '.gsd/ledger/M-20260101000000-one.md', ledgerFragment('M-20260101000000-one', '2026-01-01', 'one'));
    write(cwd, '.gsd/decisions/legacy-orphan.md', '<!-- gsd-auto-memory mem_id:MEM001 -->\n');
    write(cwd, '.gsd/decisions/T-20260101000000-one.md', decisionFragment('T-20260101000000-one', '2026-01-02'));
    write(cwd, '.gsd/memory/legacy-orphan.md', '<!-- gsd-auto-memory mem_id:MEM001 -->\n');
    write(cwd, '.gsd/memory/T-20260101000000-one.md', memoryFragment('T-20260101000000-one', '2026-01-03'));
    // The task-shaped id's own timestamp is creation, not closure — give it a
    // real ledger entry (proof a) so the decisions/memory members are
    // groupable on the honest proof, independent of the legacy-orphan guard
    // this test is actually about.
    write(cwd, '.gsd/ledger/T-20260101000000-one.md', ledgerFragment('T-20260101000000-one', '2026-01-02'));
    const planned = group.plan(cwd);
    const orphanSkips = planned.skipped.filter(item => /legacy-orphan\.md$/.test(item.path));
    assert.equal(orphanSkips.length, 3, 'legacy-orphan is skipped in ledger, decisions, and memory');
    assert(orphanSkips.every(item => /legacy-orphan não é agrupável/.test(item.reason)));
    for (const name of ['ledger', 'decisions', 'memory']) {
      const target = planned.targets.find(item => item.store === name);
      assert(target, `${name} still groups its one eligible member`);
      assert(target.members.every(member => member.id !== 'legacy-orphan'));
    }
  } finally { remove(cwd); }
});

test('the guard store.name === "memory" is gone: legacy-orphan is not special-cased by store identity', () => {
  // Regression for the removed `if (store.name === 'memory' && id === 'legacy-orphan')`
  // at the old :151 — a ledger or decisions file literally named legacy-orphan
  // must be refused too, not only in memory.
  const cwd = tmp();
  try {
    write(cwd, '.gsd/ledger/legacy-orphan.md', 'not a real orphan payload but named the same\n');
    const planned = group.plan(cwd);
    assert(planned.skipped.some(item => /legacy-orphan\.md$/.test(item.path) && /legacy-orphan não é agrupável/.test(item.reason)));
    assert(planned.targets.every(target => target.members.every(member => member.id !== 'legacy-orphan')));
  } finally { remove(cwd); }
});

test('NN is shared across every store the plan touches, and grows on the next sweep', () => {
  const cwd = tmp();
  try {
    write(cwd, '.gsd/ledger/M-20260101000000-a.md', ledgerFragment('M-20260101000000-a', '2026-01-01'));
    write(cwd, '.gsd/decisions/T-20260101000000-b.md', decisionFragment('T-20260101000000-b', '2026-01-01'));
    write(cwd, '.gsd/memory/T-20260101000000-c.md', memoryFragment('T-20260101000000-c', '2026-01-01'));
    // Task-shaped ids b and c need their own ledger entries (proof a) — their
    // embedded timestamp is creation time, not closure.
    write(cwd, '.gsd/ledger/T-20260101000000-b.md', ledgerFragment('T-20260101000000-b', '2026-01-01'));
    write(cwd, '.gsd/ledger/T-20260101000000-c.md', ledgerFragment('T-20260101000000-c', '2026-01-01'));
    const first = group.plan(cwd);
    assert.equal(first.targets.length, 3, 'ledger, decisions, and memory each produce one target');
    const labels = new Set(first.targets.map(target => target.label));
    assert.equal(labels.size, 1, 'a single sweep number, shared by every store touched this plan');
    const label = [...labels][0];
    assert(/^sweep-project-\d{2,}$/.test(label));
    for (const target of first.targets) {
      assert.equal(path.basename(target.containerPath), `${label}.md`);
    }
    group.apply(cwd, first);

    write(cwd, '.gsd/ledger/M-20260201000000-d.md', ledgerFragment('M-20260201000000-d', '2026-02-01'));
    const second = group.plan(cwd);
    assert.equal(second.targets.length, 1, 'only ledger has a new eligible member');
    const secondNum = parseInt(second.targets[0].label.replace('sweep-project-', ''), 10);
    const firstNum = parseInt(label.replace('sweep-project-', ''), 10);
    assert.equal(secondNum, firstNum + 1, 'the second sweep advances the shared counter by one');
  } finally { remove(cwd); }
});

test('date range is the min/max of derived member dates; a member with no derivable date enters and contributes nothing (DS9-5)', () => {
  const cwd = tmp();
  try {
    write(cwd, '.gsd/ledger/M-20260215000000-known.md', ledgerFragment('M-20260215000000-known', '2026-02-15'));
    write(cwd, '.gsd/ledger/old-note.md', ledgerFragment('old-note', '2025-12-31', 'hint only'));
    // S03-T02: hyphenated, so parseStorageKey refuses it outright — extinct by
    // construction (proof c), independent of any date. mtime is stubbed away
    // below so this member truly has NO derivable date, on any of the three
    // links in dateOfUnit's chain.
    const noDatePath = write(cwd, '.gsd/ledger/S03-T02.md', ledgerFragment('S03-T02', '', 'no date at all'));
    const realStatSync = fs.statSync;
    fs.statSync = function (p, ...rest) {
      if (typeof p === 'string' && p.replace(/\\/g, '/').endsWith('/.gsd/ledger/S03-T02.md')) {
        throw new Error('ENOENT: simulated unresolvable mtime');
      }
      return realStatSync.call(fs, p, ...rest);
    };
    let planned;
    try {
      planned = group.plan(cwd);
    } finally {
      fs.statSync = realStatSync;
    }
    const target = planned.targets.find(item => item.store === 'ledger');
    assert(target, 'all three members are eligible');
    assert.equal(target.members.length, 3, 'the dateless member enters the container, not skipped');
    // S03-T02 is eligible either way — parseStorageKey refuses it outright
    // (extinct-id, proof c), and as a ledger-store fixture it also sits in
    // the very directory loadLedgerIds scans (self-satisfying proof a). This
    // test is about the DATE outcome, not which proof fired.
    const noDateMember = target.members.find(member => member.id === 'S03-T02');
    assert(noDateMember, 'S03-T02 is present');
    assert.equal(noDateMember.date, null);

    const applied = group.apply(cwd, planned);
    assert.equal(applied.written.length, 1);
    const { parseGroup } = require('./forge-grouped-file');
    const parsed = parseGroup(fs.readFileSync(target.containerPath));
    assert.equal(parsed.from, '2025-12-31');
    assert.equal(parsed.to, '2026-02-15');
    assert.equal(parsed.units.length, 3);
    assert(!fs.existsSync(noDatePath));
  } finally { remove(cwd); }
});

test('plan() is deterministic: two runs over the same store produce identical targets and skipped', () => {
  const cwd = tmp();
  try {
    write(cwd, '.gsd/ledger/M-20260101000000-a.md', ledgerFragment('M-20260101000000-a', '2026-01-01'));
    write(cwd, '.gsd/ledger/M-20260102000000-b.md', ledgerFragment('M-20260102000000-b', '2026-01-02'));
    write(cwd, '.gsd/ledger/S02.md', ledgerFragment('S02', '2026-01-01', 'no proof'));
    const first = group.plan(cwd);
    const second = group.plan(cwd);
    assert.deepEqual(first.targets, second.targets);
    assert.deepEqual(first.skipped, second.skipped);
  } finally { remove(cwd); }
});

test('a second plan and apply are byte-identical and have no targets', () => {
  const cwd = tmp();
  try {
    write(cwd, '.gsd/ledger/M-20260101000000-one.md', ledgerFragment('M-20260101000000-one', '2026-01-01'));
    write(cwd, '.gsd/decisions/T-20260101000000-one.md', decisionFragment('T-20260101000000-one', '2026-01-02'));
    write(cwd, '.gsd/memory/T-20260101000000-one.md', memoryFragment('T-20260101000000-one', '2026-01-03'));
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

test('ungroup restores each original member byte-for-byte, with the new sweep-numbered name', () => {
  const cwd = tmp();
  try {
    write(cwd, '.gsd/ledger/M-20260101000000-one.md', ledgerFragment('M-20260101000000-one', '2026-01-01'));
    write(cwd, '.gsd/decisions/T-20260101000000-one.md', decisionFragment('T-20260101000000-one', '2026-01-02'));
    write(cwd, '.gsd/memory/T-20260101000000-one.md', memoryFragment('T-20260101000000-one', '2026-01-03'));
    const planned = group.plan(cwd);
    const originals = new Map();
    for (const target of planned.targets) {
      for (const member of target.members) originals.set(member.path, fs.readFileSync(member.path));
    }
    group.apply(cwd, planned);
    for (const target of planned.targets) {
      assert(/^sweep-project-\d{2,}\.md$/.test(path.basename(target.containerPath)));
      const result = group.ungroup(cwd, target.containerPath);
      assert.equal(result.restored.length, target.members.length);
      for (const member of target.members) {
        assert.equal(Buffer.compare(originals.get(member.path), fs.readFileSync(member.path)), 0);
      }
    }
  } finally { remove(cwd); }
});

test('DS9-1: ungroup reads a LEGACY 2026-Q1.md container written in the PR 1 byte format', () => {
  const cwd = tmp();
  try {
    const legacyId = 'M-20260101000000-legacy';
    const bytes = legacyContainerBytes(legacyId, 'legacy payload, PR 1 era\n');
    const containerPath = write(cwd, '.gsd/ledger/2026-Q1.md', bytes);
    const result = group.ungroup(cwd, containerPath);
    assert.deepEqual(result.restored, [path.join(cwd, '.gsd', 'ledger', `${legacyId}.md`)]);
    assert.equal(fs.readFileSync(result.restored[0], 'utf8'), 'legacy payload, PR 1 era\n');
    assert(!fs.existsSync(containerPath), 'the legacy container is consumed by ungroup like any other');
  } finally { remove(cwd); }
});

test('W5: an S08 journal line written in the OLD (YYYY-QN) format still undoes correctly after S09', () => {
  const cwd = tmp();
  try {
    const legacyId = 'M-20260101000000-old-journal';
    const bytes = legacyContainerBytes(legacyId, 'undo me\n');
    write(cwd, '.gsd/ledger/2026-Q1.md', bytes);

    const probeResult = journal.probe(cwd);
    assert(probeResult.ok);
    const intent = journal.appendIntent(cwd, {
      operation: 'agrupar-epocas-seladas',
      containers: ['.gsd/ledger/2026-Q1.md'],
    });
    assert(intent.ok);
    const outcome = journal.appendOutcome(cwd, {
      id: intent.id,
      phase: 'apply-done',
      written: ['.gsd/ledger/2026-Q1.md'],
    });
    assert(outcome.ok);

    // Naming-agnostic (DS8-4): latestUndoable never looks at the label, only
    // at the path recorded in the intent/outcome records — which is exactly
    // what forge-epoch-group.plan()/apply() changed. If the journal depended
    // on epoch-shaped names this would already be failing.
    const undoable = journal.latestUndoable(cwd);
    assert(undoable.ok);
    assert(undoable.entry, 'the old-format container is still discoverable as undoable');
    assert.equal(undoable.entry.containers.length, 1);
    assert.equal(undoable.entry.containers[0], '.gsd/ledger/2026-Q1.md');

    const absolute = path.join(cwd, undoable.entry.containers[0]);
    const restoredResult = group.ungroup(cwd, absolute);
    assert.equal(restoredResult.restored.length, 1);
    const restoredPath = path.join(cwd, '.gsd', 'ledger', `${legacyId}.md`);
    assert(fs.existsSync(restoredPath));
    assert.equal(fs.readFileSync(restoredPath, 'utf8'), 'undo me\n');
    assert(!fs.existsSync(absolute), 'the container is consumed once undo completes');

    const undoDone = journal.appendOutcome(cwd, { id: intent.id, phase: 'undo-done', written: restoredResult.restored });
    assert(undoDone.ok);
    const nothingLeft = journal.latestUndoable(cwd);
    assert.equal(nothingLeft.entry, null, 'a fully undone record is no longer offered up');
  } finally { remove(cwd); }
});

test('unresolved (no-proof), delimiter, and unsafe-id units are enumerated as skipped (structural guards untouched)', () => {
  const cwd = tmp();
  try {
    // A free-form filename like 'plain.md' fails parseStorageKey outright,
    // which under DS9-4/B1's narrowing makes it EXTINCT (proof c) — grouped,
    // not skipped. The genuine no-proof case is a well-formed bare local id
    // (parseStorageKey accepts it) with no date and no ledger record, kept
    // in the memory store to avoid ledger's directory self-reference.
    write(cwd, '.gsd/memory/S06.md', memoryFragment('S06', '2026-01-01'));
    write(cwd, '.gsd/ledger/M-20260101000000-delimiter.md', ledgerFragment('M-20260101000000-delimiter', '2026-01-01', '<!-- forge: unsafe -->'));
    const planned = group.plan(cwd);
    const reasons = planned.skipped.map(item => item.reason).join('\n');
    assert(/sem prova de encerramento/.test(reasons));
    assert(/delimitador no conteúdo/.test(reasons));
    assert(planned.targets.every(target => target.members.every(member => member.id !== 'S06')));
  } finally { remove(cwd); }
});

test('apply rejects a hand-crafted path outside its store', () => {
  const cwd = tmp();
  try {
    const source = write(cwd, '.gsd/ledger/M-20260101000000-safe.md', ledgerFragment('M-20260101000000-safe', '2026-01-01'));
    const outside = path.join(cwd, '.gsd', 'archive', 'sweep-project-01.md');
    const result = group.apply(cwd, { targets: [{
      store: 'ledger', label: 'sweep-project-01', containerPath: outside,
      members: [{ id: 'M-20260101000000-safe', path: source }],
    }], skipped: [] });
    assert.equal(result.written.length, 0);
    assert(fs.existsSync(source));
    assert(!fs.existsSync(outside));
  } finally { remove(cwd); }
});

test('the plan defaults to dry-run metadata and never writes implicitly', () => {
  const cwd = tmp();
  try {
    const old = write(cwd, '.gsd/ledger/M-20260101000000-old.md', ledgerFragment('M-20260101000000-old', '2026-01-01'));
    write(cwd, '.gsd/ledger/M-20260401000000-current.md', ledgerFragment('M-20260401000000-current', '2026-04-01'));
    const planned = group.plan(cwd);
    assert.equal(planned.dryRun, true);
    assert(planned.targets.length > 0);
    assert(fs.existsSync(old));
  } finally { remove(cwd); }
});

test('the default plan gates wrapper directories until explicitly enabled', () => {
  const cwd = tmp();
  try {
    write(cwd, '.gsd/ledger/M-20260101000000-one.md', ledgerFragment('M-20260101000000-one', '2026-01-01'));
    write(cwd, '.gsd/decisions/T-20260101000000-one.md', decisionFragment('T-20260101000000-one', '2026-01-02'));
    write(cwd, '.gsd/memory/T-20260101000000-one.md', memoryFragment('T-20260101000000-one', '2026-01-03'));
    // T-20260101000000-one's own timestamp is creation, not closure — give it
    // a real ledger entry (proof a) so decisions/memory still produce targets.
    write(cwd, '.gsd/ledger/T-20260101000000-one.md', ledgerFragment('T-20260101000000-one', '2026-01-02'));
    write(cwd, '.gsd/milestones/M-20260101000000-old/PLAN.md', 'old milestone');
    write(cwd, '.gsd/tasks/T-20260101000000-old/PLAN.md', 'old task');
    // Same narrowing applies to the wrapper dirs exercised later in this test
    // (explicitlyEnabled) — they need ledger entries to be sealed.
    write(cwd, '.gsd/ledger/M-20260101000000-old.md', ledgerFragment('M-20260101000000-old', '2026-01-01'));
    write(cwd, '.gsd/ledger/T-20260101000000-old.md', ledgerFragment('T-20260101000000-old', '2026-01-01'));

    const planned = group.plan(cwd);
    assert(planned.targets.some(target => target.store === 'ledger'));
    assert(planned.targets.some(target => target.store === 'decisions'));
    assert(planned.targets.some(target => target.store === 'memory'));
    assert(planned.targets.every(target =>
      target.store !== 'milestone-wrappers' && target.store !== 'task-wrappers'));
    assert(planned.skipped.every(item =>
      !/[\\/]\.gsd[\\/](milestones|tasks)[\\/]/.test(item.path)));

    const explicitlyEnabled = group.plan(cwd, { includeWrapperDirs: true });
    assert(explicitlyEnabled.targets.some(target => target.store === 'milestone-wrappers'));
    assert(explicitlyEnabled.targets.some(target => target.store === 'task-wrappers'));
    const stringFalse = group.plan(cwd, { includeWrapperDirs: 'false' });
    assert(stringFalse.targets.every(target =>
      target.store !== 'milestone-wrappers' && target.store !== 'task-wrappers'));
  } finally { remove(cwd); }
});

// Wrapper-directory contract: only the structural predicate from forge-epoch
// makes a directory eligible in the first place; sealedBy decides whether the
// eligible wrapper is actually groupable. No "current epoch occupant" is
// needed anymore — a wrapper with a timestamped id is groupable on sight.
test('wrapper dirs plan only structurally eligible AND sealed milestone/task directories', () => {
  const cwd = tmp();
  try {
    const roots = ['.gsd/milestones', '.gsd/tasks'];
    for (const root of roots) fs.mkdirSync(path.join(cwd, root), { recursive: true });
    write(cwd, '.gsd/milestones/M-20260101000000-a/PLAN.md', 'a');
    write(cwd, '.gsd/milestones/M-20260102000000-b/PLAN.md', 'b');
    write(cwd, '.gsd/tasks/T-20260103000000-c/PLAN.md', 'c');
    // The wrapper's own embedded timestamp is creation, not closure — each
    // structurally-eligible wrapper needs a real ledger entry (proof a) to
    // also be sealed. M-20260104000000-two and M-20260105000000-nested are
    // deliberately left without one: they are excluded on STRUCTURAL grounds
    // (file count / nested subfolder) before sealedBy is ever consulted, so
    // this test's proof-independence is preserved.
    // Seeded already-grouped (not loose) so these entries only prove closure
    // for the wrapper members — they must not also surface as their own
    // ledger-store target/members, which would break the total-member count
    // this test asserts below.
    seedLedgerProof(cwd, ['M-20260101000000-a', 'M-20260102000000-b', 'T-20260103000000-c']);
    write(cwd, '.gsd/milestones/M-20260104000000-two/A.md', 'a');
    write(cwd, '.gsd/milestones/M-20260104000000-two/B.md', 'b');
    write(cwd, '.gsd/milestones/M-20260105000000-nested/PLAN.md', 'x');
    fs.mkdirSync(path.join(cwd, '.gsd/milestones/M-20260105000000-nested', 'slices'));

    const planned = group.plan(cwd, { includeWrapperDirs: true });
    assert.equal(planned.targets.reduce((total, target) => total + target.members.length, 0), 3);
    assert.equal(planned.targets.find(target => target.store === 'milestone-wrappers').members.length, 2);
    assert.equal(planned.targets.find(target => target.store === 'task-wrappers').members.length, 1);
    assert(planned.skipped.some(item => item.reason.includes('2 arquivos')));
    assert(planned.skipped.some(item => item.reason.includes('subpasta slices/')));
    assert(fs.existsSync(path.join(cwd, '.gsd/milestones/M-20260104000000-two/A.md')));
    assert(fs.existsSync(path.join(cwd, '.gsd/milestones/M-20260105000000-nested/slices')));
  } finally { remove(cwd); }
});

test('wrapper apply is in-place, removes dirs, and never creates archive', () => {
  const cwd = tmp();
  try {
    const original = write(cwd, '.gsd/milestones/M-20260101000000-one/STATE.md', Buffer.from('bom\r\nconteúdo', 'utf8'));
    // The wrapper's embedded timestamp is creation, not closure — a real
    // ledger entry (proof a) is what makes it sealed. Seeded already-grouped
    // so it does not also become a standalone ledger-store target here.
    seedLedgerProof(cwd, ['M-20260101000000-one']);
    const planned = group.plan(cwd, { includeWrapperDirs: true });
    const result = group.apply(cwd, planned);
    assert.equal(result.written.length, 1);
    assert(!fs.existsSync(path.dirname(original)));
    assert(/^sweep-project-\d{2,}\.md$/.test(path.basename(result.written[0])));
    assert(!fs.existsSync(path.join(cwd, '.gsd/archive')));
    assert(result.counts.dirsAfter < result.counts.dirsBefore);
  } finally { remove(cwd); }
});

// Reversibility is the core guarantee: the wrapper's original FILENAME is not
// derivable from the id, so the container has to carry it, via the marker id
// `<dirId>~<fileName>`.
test('wrapper ungroup restores original filename and bytes exactly', () => {
  const cwd = tmp();
  try {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0x0d, 0x0a, 0x42]);
    const source = write(cwd, '.gsd/tasks/T-20260101000000-one/NOTES-original.md', bytes);
    // The wrapper's embedded timestamp is creation, not closure — a real
    // ledger entry (proof a) is what makes it sealed. Seeded already-grouped
    // so it does not also become its own ledger-store target here.
    seedLedgerProof(cwd, ['T-20260101000000-one']);
    const plan = group.plan(cwd, { includeWrapperDirs: true });
    const applied = group.apply(cwd, plan);
    assert.equal(applied.written.length, 1);
    assert(!fs.existsSync(source));
    assert(fs.readFileSync(applied.written[0]).toString('utf8')
      .includes('T-20260101000000-one~NOTES-original.md'));

    const result = group.ungroup(cwd, applied.written[0]);
    assert.deepEqual(result.restored, [source]);
    assert(fs.existsSync(source));
    assert.equal(Buffer.compare(fs.readFileSync(source), bytes), 0);
    assert(!fs.existsSync(applied.written[0]));
  } finally { remove(cwd); }
});

test('never groups a wrapper whose directory name contains the reserved separator', () => {
  const cwd = tmp();
  try {
    const source = write(cwd, '.gsd/tasks/T-20260101000000-one~sub/PLAN.md', 'payload');
    const planned = group.plan(cwd, { includeWrapperDirs: true });
    assert.equal(planned.targets.length, 0);
    assert(planned.skipped.some(item => /separador reservado/.test(item.reason)));
    group.apply(cwd, planned);
    assert(fs.existsSync(source));
  } finally { remove(cwd); }
});

test('skips only the non-.md wrapper and still groups its sibling', () => {
  const cwd = tmp();
  try {
    const stray = write(cwd, '.gsd/tasks/T-20260102000000-two/notes.txt', 'not markdown');
    const groupable = write(cwd, '.gsd/tasks/T-20260101000000-one/PLAN.md', 'payload');
    // T-20260102000000-two is skipped for the non-.md reason regardless of
    // proof, so it deliberately gets none; T-20260101000000-one needs a real
    // ledger entry (proof a) to be the sibling that is groupable. Seeded
    // already-grouped so it does not also become its own ledger-store target.
    seedLedgerProof(cwd, ['T-20260101000000-one']);
    const planned = group.plan(cwd, { includeWrapperDirs: true });
    assert.equal(planned.targets.length, 1);
    assert.equal(planned.targets[0].members.length, 1);
    assert(planned.skipped.some(item => /não é \.md/.test(item.reason)));
    const applied = group.apply(cwd, planned);
    assert.equal(applied.written.length, 1);
    assert(!fs.existsSync(groupable));
    assert(fs.existsSync(stray));
  } finally { remove(cwd); }
});

test('refuses to restore a store member over an existing loose file', () => {
  const cwd = tmp();
  try {
    write(cwd, '.gsd/ledger/M-20260101000000-old.md', ledgerFragment('M-20260101000000-old', '2026-01-01', 'grouped body'));
    const applied = group.apply(cwd, group.plan(cwd));
    const container = applied.written.find(item => item.includes(`${path.sep}ledger${path.sep}`));
    const canonical = write(cwd, '.gsd/ledger/M-20260101000000-old.md', 'loose wins — do not clobber');
    assert.throws(() => group.ungroup(cwd, container), /destination already exists/);
    assert.equal(fs.readFileSync(canonical, 'utf8'), 'loose wins — do not clobber');
    assert(fs.existsSync(container));
  } finally { remove(cwd); }
});

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
    write(cwd, '.gsd/ledger/M-20260101000000-one.md', ledgerFragment('M-20260101000000-one', '2026-01-01', 'member one'));
    write(cwd, '.gsd/ledger/M-20260102000000-two.md', ledgerFragment('M-20260102000000-two', '2026-01-02', 'member two'));
    write(cwd, '.gsd/ledger/M-20260103000000-three.md', ledgerFragment('M-20260103000000-three', '2026-01-03', 'member three'));
    const preApplySnapshot = treeSnapshot(path.join(cwd, '.gsd'));

    const planned = group.plan(cwd);
    const target = planned.targets.find(item => item.store === 'ledger');
    assert(target);
    assert.equal(target.members.length, 3);
    const originals = new Map(target.members.map(member => [member.path, fs.readFileSync(member.path)]));
    const applied = group.apply(cwd, planned);
    assert(applied.written.includes(target.containerPath));

    const memberOne = target.members.find(member => /one/.test(member.path));
    const memberTwo = target.members.find(member => /two/.test(member.path));
    fs.writeFileSync(memberOne.path, originals.get(memberOne.path));
    fs.writeFileSync(memberTwo.path, 'conflicting content — not the grouped payload');

    assert.throws(() => group.ungroup(cwd, target.containerPath), /destination already exists with different content/);
    assert(fs.existsSync(target.containerPath));
    assert.equal(fs.readFileSync(memberOne.path).toString('utf8'), originals.get(memberOne.path).toString('utf8'));

    fs.writeFileSync(memberTwo.path, originals.get(memberTwo.path));
    const result = group.ungroup(cwd, target.containerPath);
    assert.equal(result.restored.length, 1);
    assert.equal(result.alreadyPresent.length, 2);
    assert(!fs.existsSync(target.containerPath));
    for (const member of target.members) {
      assert.equal(Buffer.compare(originals.get(member.path), fs.readFileSync(member.path)), 0);
    }
    assert.deepEqual(treeSnapshot(path.join(cwd, '.gsd')), preApplySnapshot);
  } finally { remove(cwd); }
});

test('B1 wrapper: ungroup is resumable after a partial failure and idempotent on byte-identical retries', () => {
  const cwd = tmp();
  try {
    const bytesOne = Buffer.from('member one payload\r\n', 'utf8');
    const bytesTwo = Buffer.from('member two payload\r\n', 'utf8');
    const sourceOne = write(cwd, '.gsd/tasks/T-20260101000000-one/NOTES.md', bytesOne);
    const sourceTwo = write(cwd, '.gsd/tasks/T-20260102000000-two/NOTES.md', bytesTwo);
    // Both wrappers' embedded timestamps are creation, not closure — real
    // ledger entries (proof a) are what make them sealed. Seeded
    // already-grouped so they do not also become their own ledger-store
    // target/members, which the byte-identity round trip below does not
    // touch either way (nothing here ever ungroups the seed container).
    seedLedgerProof(cwd, ['T-20260101000000-one', 'T-20260102000000-two']);
    const preApplySnapshot = treeSnapshot(path.join(cwd, '.gsd'));

    const planned = group.plan(cwd, { includeWrapperDirs: true });
    const target = planned.targets.find(item => item.store === 'task-wrappers');
    assert(target);
    assert.equal(target.members.length, 2);
    const applied = group.apply(cwd, planned);
    assert.equal(applied.written.length, 1);
    const container = applied.written[0];

    fs.mkdirSync(sourceOne.replace(/[\\/]NOTES\.md$/, ''), { recursive: true });
    fs.writeFileSync(sourceOne, bytesOne);
    fs.mkdirSync(sourceTwo.replace(/[\\/]NOTES\.md$/, ''), { recursive: true });
    fs.writeFileSync(sourceTwo, 'conflicting content — not the grouped payload');

    assert.throws(() => group.ungroup(cwd, container), /destination already exists with different content/);
    assert(fs.existsSync(container));

    fs.writeFileSync(sourceTwo, bytesTwo);
    const result = group.ungroup(cwd, container);
    assert.equal(result.restored.length, 0);
    assert.equal(result.alreadyPresent.length, 2);
    assert(!fs.existsSync(container));
    assert.deepEqual(treeSnapshot(path.join(cwd, '.gsd')), preApplySnapshot);
  } finally { remove(cwd); }
});

console.log(`\nforge-epoch-group: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
