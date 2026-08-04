'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { serializeGroup } = require('./forge-grouped-file');
const ledger = require('./forge-ledger');
const decisions = require('./forge-decisions');
const memory = require('./forge-memory');
const projection = require('./forge-projection');
const memoryIndex = require('./forge-memory-index');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error });
    console.log(`  ✗ ${name}`);
  }
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-projection-grouped-'));
  fs.mkdirSync(ledger.ledgerDir(cwd), { recursive: true });
  fs.mkdirSync(decisions.decisionsDir(cwd), { recursive: true });
  fs.mkdirSync(memory.memoryDir(cwd), { recursive: true });

  ledger.writeFragment(cwd, {
    id: 'M001',
    title: 'Grouped projection fixture',
    completed_at: '2026-01-01',
    slices: ['S01'],
    key_files: ['scripts/example.js'],
    key_decisions: ['Use grouped stores'],
  });
  decisions.writeFragment(cwd, {
    unit_id: 'M001',
    decisions: [{
      when: '2026-01-01',
      scope: 'fixture',
      decision: 'Keep rendered output stable',
      choice: 'grouped readers',
      rationale: 'payload accessor',
      revisable: 'yes',
    }],
  });
  memory.writeFragment(cwd, {
    unit_id: 'M001',
    facts: [{
      mem_id: 'MEM001',
      category: 'architecture',
      text: 'The reader is implemented in `scripts/example.js`.',
      source: 'fixture',
    }],
    stats: [],
  });
  return { cwd };
}

function groupOne(dir, epoch, id, sourcePath) {
  const container = path.join(dir, `${epoch}.md`);
  fs.writeFileSync(container, serializeGroup({
    epoch,
    units: [{ id, content: fs.readFileSync(sourcePath) }],
  }).buffer);
  fs.unlinkSync(sourcePath);
  return container;
}

function groupSealedEpoch(cwd) {
  return {
    ledger: groupOne(cwd && ledger.ledgerDir(cwd), '2026-Q1', 'M001', ledger.fragmentPath(cwd, 'M001')),
    decisions: groupOne(cwd && decisions.decisionsDir(cwd), '2026-Q1', 'M001', decisions.fragmentPath(cwd, 'M001')),
    memory: groupOne(cwd && memory.memoryDir(cwd), '2026-Q1', 'M001', memory.fragmentPath(cwd, 'M001')),
  };
}

function rendered(cwd) {
  return {
    ledger: projection.renderLedger(cwd),
    decisions: projection.renderDecisions(cwd),
    memory: projection.renderMemory(cwd),
  };
}

test('renderLedger, renderDecisions, and renderMemory stay byte-identical after grouping', () => {
  const { cwd } = fixture();
  const before = rendered(cwd);
  const containers = groupSealedEpoch(cwd);
  const after = rendered(cwd);
  assert.deepStrictEqual(after, before);
  assert.ok(fs.existsSync(containers.ledger));
  assert.ok(fs.existsSync(containers.decisions));
  assert.ok(fs.existsSync(containers.memory));
});

test('the memory index reads grouped member payloads, not the container', () => {
  const { cwd } = fixture();
  const before = memoryIndex.buildFileIndex(cwd);
  groupSealedEpoch(cwd);
  const after = memoryIndex.buildFileIndex(cwd);
  assert.strictEqual(after.coverage.facts_total, before.coverage.facts_total);
  assert.deepStrictEqual(after.coverage.fragments_skipped_by_store, []);
  assert.strictEqual(after.coverage.fragments_read, before.coverage.fragments_read);
  assert.strictEqual(after.entries.length, before.entries.length);
});

test('every grouped store entry points at its physical container', () => {
  const { cwd } = fixture();
  const containers = groupSealedEpoch(cwd);
  const ledgerEntry = ledger.listFragments(cwd)[0];
  const decisionsEntry = decisions.listFragments(cwd)[0];
  const memoryEntry = memory.listFragments(cwd)[0];
  assert.strictEqual(ledgerEntry.path, containers.ledger);
  assert.strictEqual(decisionsEntry.path, containers.decisions);
  assert.strictEqual(memoryEntry.path, containers.memory);
  assert.ok(ledgerEntry.grouped && decisionsEntry.grouped && memoryEntry.grouped);
});

test('projection accessors expose the selected fragment and never group frontmatter', () => {
  const { cwd } = fixture();
  groupSealedEpoch(cwd);
  const ledgerText = ledger.readFragmentText(cwd, ledger.listFragments(cwd)[0]);
  const decisionsText = decisions.readFragmentText(cwd, decisions.listFragments(cwd)[0]);
  const memoryText = memory.readFragmentText(cwd, memory.listFragments(cwd)[0]);
  assert.ok(ledgerText.includes('Grouped projection fixture'));
  assert.ok(decisionsText.includes('Keep rendered output stable'));
  assert.ok(memoryText.includes('scripts/example.js'));
  assert.ok(!ledgerText.includes('grouped_format: forge-group@1'));
  assert.ok(!decisionsText.includes('grouped_format: forge-group@1'));
  assert.ok(!memoryText.includes('grouped_format: forge-group@1'));
});

test('the index does not report the container as skipped by the memory store', () => {
  const { cwd } = fixture();
  const containers = groupSealedEpoch(cwd);
  const result = memoryIndex.buildFileIndex(cwd);
  const returnedNames = new Set(memory.listFragments(cwd).map(entry => path.basename(entry.path)));
  assert.ok(returnedNames.has(path.basename(containers.memory)));
  assert.deepStrictEqual(result.coverage.fragments_skipped_by_store, []);
  assert.strictEqual(result.coverage.facts_total, 1);
});

test('rendered markdown itself contains no grouped-container marker', () => {
  const { cwd } = fixture();
  groupSealedEpoch(cwd);
  const output = rendered(cwd);
  assert.ok(!output.ledger.includes('grouped_format: forge-group@1'));
  assert.ok(!output.decisions.includes('grouped_format: forge-group@1'));
  assert.ok(!output.memory.includes('grouped_format: forge-group@1'));
  assert.ok(output.ledger.startsWith('# Forge Project Ledger'));
  assert.ok(output.decisions.startsWith('# Forge Decisions Log'));
  assert.ok(output.memory.startsWith('# Forge Auto-Memory'));
});

if (failed) {
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error.message}`);
  process.exitCode = 1;
} else {
  console.log(`\n${passed} grouped projection tests passed`);
}
