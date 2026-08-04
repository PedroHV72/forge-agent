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

console.log(`\nforge-epoch-group: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
