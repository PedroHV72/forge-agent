'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serializeGroup } = require('./forge-grouped-file');
const ledger = require('./forge-ledger');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; failures.push({ name, error }); console.log(`  ✗ ${name}`); }
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ledger-grouped-'));
  fs.mkdirSync(ledger.ledgerDir(cwd), { recursive: true });
  const entries = ['M001', 'M002', 'M003'].map((id, index) => ({
    id,
    title: `Ledger ${index}`,
    slices: [],
    key_files: [],
    key_decisions: [],
    body: `body-${id}`,
  }));
  for (const entry of entries) ledger.writeFragment(cwd, entry);
  return { cwd, entries };
}

function groupEntries(cwd, ids, epoch) {
  const units = ids.map(id => ({
    id,
    content: fs.readFileSync(ledger.fragmentPath(cwd, id)),
  }));
  const result = serializeGroup({ epoch, units });
  const container = path.join(ledger.ledgerDir(cwd), `${epoch}.md`);
  fs.writeFileSync(container, result.buffer);
  for (const id of ids) fs.unlinkSync(ledger.fragmentPath(cwd, id));
  return container;
}

function captureStderr(fn) {
  let output = '';
  const original = process.stderr.write;
  process.stderr.write = value => { output += String(value); return true; };
  try { fn(); } finally { process.stderr.write = original; }
  return output;
}

test('grouped and loose stores expose the same unit count', () => {
  const { cwd } = fixture();
  const before = ledger.listFragments(cwd);
  groupEntries(cwd, ['M001', 'M002'], '2026-Q1');
  const after = ledger.listFragments(cwd);
  assert.strictEqual(before.length, 3);
  assert.strictEqual(after.length, before.length);
  assert.ok(after.every(entry => typeof entry.grouped === 'boolean'));
  assert.ok(after.every(entry => typeof entry.epoch === 'string' || entry.epoch === null));
  assert.ok(after.every(entry => fs.existsSync(entry.path)));
});

test('readFragment and readFragmentText read one grouped member', () => {
  const { cwd, entries } = fixture();
  const original = fs.readFileSync(ledger.fragmentPath(cwd, 'M001'), 'utf8');
  groupEntries(cwd, ['M001', 'M002'], '2026-Q1');
  const listed = ledger.listFragments(cwd).find(entry => entry.id === 'M001');
  assert.strictEqual(listed.grouped, true);
  assert.strictEqual(ledger.readFragmentText(cwd, listed), original);
  assert.deepStrictEqual(ledger.readFragment(cwd, 'M001'), ledger.parseFragment(original));
});

test('loose duplicate wins and emits a warning', () => {
  const { cwd } = fixture();
  const original = fs.readFileSync(ledger.fragmentPath(cwd, 'M001'));
  const container = path.join(ledger.ledgerDir(cwd), '2026-Q2.md');
  fs.writeFileSync(container, serializeGroup({ epoch: '2026-Q2', units: [{ id: 'M001', content: original }] }).buffer);
  const warning = captureStderr(() => {
    const list = ledger.listFragments(cwd).filter(entry => entry.id === 'M001');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].grouped, false);
  });
  assert.ok(warning.includes('M001'));
  assert.ok(warning.includes('usando a solta'));
});

test('writing a grouped id creates a loose file and preserves the container', () => {
  const { cwd } = fixture();
  const container = groupEntries(cwd, ['M001', 'M002'], '2026-Q1');
  const before = fs.readFileSync(container);
  ledger.writeFragment(cwd, { id: 'M001', title: 'rewritten', slices: [], key_files: [], key_decisions: [], body: 'new' });
  assert.ok(fs.existsSync(ledger.fragmentPath(cwd, 'M001')));
  assert.deepStrictEqual(fs.readFileSync(container), before);
});

test('loose entries carry null epoch while members carry the container epoch', () => {
  const { cwd } = fixture();
  groupEntries(cwd, ['M001'], '2026-Q9');
  const list = ledger.listFragments(cwd);
  assert.strictEqual(list.find(entry => entry.id === 'M001').epoch, '2026-Q9');
  assert.strictEqual(list.find(entry => entry.id === 'M002').epoch, null);
});

test('readFragment keeps invalid-id behavior', () => {
  const { cwd } = fixture();
  assert.throws(() => ledger.readFragment(cwd, 'not-an-id'), /Invalid ledger ID/);
});

test('every grouped envelope points at the physical container', () => {
  const { cwd } = fixture();
  const container = groupEntries(cwd, ['M001', 'M002'], '2026-Q1');
  for (const entry of ledger.listFragments(cwd).filter(item => item.grouped)) {
    assert.strictEqual(entry.path, container);
    assert.ok(fs.statSync(entry.path).isFile());
  }
});

test('loose read text remains the complete original fragment', () => {
  const { cwd } = fixture();
  const entry = ledger.listFragments(cwd).find(item => item.id === 'M003');
  const text = ledger.readFragmentText(cwd, entry);
  assert.ok(text.startsWith('---'));
  assert.ok(text.includes('id: M003'));
  assert.ok(text.includes('body-M003'));
});

// An unreadable container used to be pushed as a LOOSE fragment named after
// its epoch, and the second loop then skipped it: every unit inside vanished
// with nothing on stderr, while a mere parse error two lines below did warn.
test('an unreadable container warns instead of listing itself as a loose fragment', () => {
  const { cwd } = fixture();
  groupEntries(cwd, ['M001', 'M002'], '2026-Q1');
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = (target, ...rest) => {
    if (typeof target === 'string' && target.endsWith('2026-Q1.md')) {
      const error = new Error('EACCES: permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return realReadFileSync(target, ...rest);
  };
  let listed;
  let output;
  try { output = captureStderr(() => { listed = ledger.listFragments(cwd); }); }
  finally { fs.readFileSync = realReadFileSync; }
  assert.ok(!listed.some(entry => entry.id === '2026-Q1'),
    'the container is not listed as a loose fragment named after its epoch');
  assert.ok(/container-unreadable/.test(output), `expected a warning, got: ${JSON.stringify(output)}`);
  assert.ok(listed.some(entry => entry.id === 'M003'), 'readable neighbours are unaffected');
});

test('list ordering remains deterministic by id', () => {
  const { cwd } = fixture();
  assert.deepStrictEqual(ledger.listFragments(cwd).map(entry => entry.id), ['M001', 'M002', 'M003']);
});

if (failed) {
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error.message}`);
  process.exitCode = 1;
} else {
  console.log(`\n${passed} grouped ledger tests passed`);
}
