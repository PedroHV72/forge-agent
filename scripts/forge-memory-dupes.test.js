'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { serializeGroup } = require('./forge-grouped-file');
const memory = require('./forge-memory');
const { findDuplicateGroups, renderCensus } = require('./forge-memory-dupes');

let passed = 0;
let failed = 0;
const MILESTONE = 'M-20260814222313-dupes-test';

function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; console.log(`  ✗ ${name}: ${error.message}`); }
}

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-dupes-test-'));
}

let clockTick = 0;

// Every envelope field that differs between two independently written
// duplicates is made to differ here on purpose: unit_id, mem_id, created_at
// and source_unit. Only the fact text is shared.
function fact(text, unitId) {
  clockTick += 1;
  return {
    mem_id: `MEM-${unitId}-${clockTick}`,
    category: 'test',
    text,
    created_at: `2026-08-14T00:00:${String(clockTick).padStart(2, '0')}Z`,
    source_unit: `${unitId}/synthetic-${clockTick}`,
  };
}

function write(cwd, unitId, text, opts) {
  memory.writeFragment(cwd, { unit_id: unitId, facts: [fact(text, unitId)], stats: [] }, opts);
}

function factText(cwd, unitId) {
  const source = memory.listFragments(cwd).find(item => item.unitId === unitId);
  return memory.parseFragment(fs.readFileSync(source.path, 'utf8')).facts[0].text;
}

// A duplicate is written independently, never byte-copied: copying the raw file
// preserves the envelope and would only prove the detector matches itself.
function clone(cwd, sourceId, targetId, transform) {
  const text = factText(cwd, sourceId);
  write(cwd, targetId, transform ? transform(text) : text);
}

function groupOne(cwd, unitId, epoch) {
  const entry = memory.listFragments(cwd).find(item => item.unitId === unitId);
  const container = path.join(memory.memoryDir(cwd), `${epoch}.md`);
  fs.writeFileSync(container, serializeGroup({ epoch, units: [{ id: entry.storageKey, content: fs.readFileSync(entry.path) }] }).buffer);
  fs.unlinkSync(entry.path);
}

function cleanup(cwd) { fs.rmSync(cwd, { recursive: true, force: true }); }

console.log('\n=== forge-memory-dupes.test.js ===\n');

test('detecta duplicata com diferença apenas de caixa', () => {
  const cwd = fixture();
  try {
    write(cwd, 'M001', 'Synthetic text');
    clone(cwd, 'M001', 'M002', text => text.replace('Synthetic text', 'synthetic text'));
    const result = findDuplicateGroups(cwd);
    assert.strictEqual(result.fragments_examined, 2);
    assert.strictEqual(result.groups.length, 1);
    assert.strictEqual(result.verdict, 'TARGETS');
  } finally { cleanup(cwd); }
});

// R1: the production case. Two fragments written independently share only the
// fact text; unit_id, mem_id, created_at and source_unit all differ, so a
// whole-file digest could never collide and the detector would be green-inert.
test('duplicatas independentes (envelope diferente, mesmo fato) agrupam', () => {
  const cwd = fixture();
  try {
    write(cwd, 'M001', 'Independently written fact');
    write(cwd, 'M002', 'Independently written fact');
    const files = memory.listFragments(cwd).map(item => fs.readFileSync(item.path, 'utf8'));
    assert.notStrictEqual(files[0], files[1], 'os envelopes precisam mesmo diferir');
    const result = findDuplicateGroups(cwd);
    assert.strictEqual(result.groups.length, 1, 'duplicata real precisa agrupar');
    assert.strictEqual(result.verdict, 'TARGETS');
  } finally { cleanup(cwd); }
});

test('não agrupa conteúdo realmente diferente', () => {
  const cwd = fixture();
  try {
    write(cwd, 'M001', 'Synthetic one');
    write(cwd, 'M002', 'Synthetic two');
    const result = findDuplicateGroups(cwd);
    assert.strictEqual(result.groups.length, 0);
    assert.strictEqual(result.verdict, 'NO-TARGET');
  } finally { cleanup(cwd); }
});

test('CRLF e LF são o mesmo conteúdo normalizado', () => {
  const cwd = fixture();
  try {
    write(cwd, 'M001', 'Synthetic\nline');
    clone(cwd, 'M001', 'M002');
    const second = memory.listFragments(cwd).find(item => item.unitId === 'M002');
    fs.writeFileSync(second.path, fs.readFileSync(second.path, 'utf8').replace(/\n/g, '\r\n'));
    assert.strictEqual(findDuplicateGroups(cwd).groups.length, 1);
  } finally { cleanup(cwd); }
});

test('solto vence agrupado', () => {
  const cwd = fixture();
  try {
    write(cwd, 'M001', 'Same synthetic');
    clone(cwd, 'M001', 'M002');
    groupOne(cwd, 'M002', '2026-Q1');
    const group = findDuplicateGroups(cwd).groups[0];
    assert.strictEqual(group.survivor.storageKey, 'M001');
    assert.strictEqual(group.losers[0].storageKey, 'M002');
  } finally { cleanup(cwd); }
});

test('entre soltos a chave qualificada vence a nua', () => {
  const cwd = fixture();
  try {
    write(cwd, 'S01', 'Same synthetic', { milestoneId: MILESTONE });
    clone(cwd, 'S01', 'S02');
    const result = findDuplicateGroups(cwd);
    assert.strictEqual(result.groups[0].survivor.storageKey, `${MILESTONE}__S01`);
  } finally { cleanup(cwd); }
});

test('grupo só-agrupado vai para skipped sem sobrevivente', () => {
  const cwd = fixture();
  try {
    write(cwd, 'M001', 'Grouped only');
    clone(cwd, 'M001', 'M002');
    groupOne(cwd, 'M001', '2026-Q1');
    groupOne(cwd, 'M002', '2026-Q2');
    const result = findDuplicateGroups(cwd);
    assert.strictEqual(result.groups.length, 0);
    assert.strictEqual(result.skipped.filter(x => x.reason === 'no-loose-survivor').length, 2);
  } finally { cleanup(cwd); }
});

test('store vazio é EMPTY-STORE, não NO-TARGET', () => {
  const cwd = fixture();
  try {
    const result = findDuplicateGroups(cwd);
    assert.deepStrictEqual(result, { fragments_examined: 0, groups: [], skipped: [], verdict: 'EMPTY-STORE', rules: result.rules });
  } finally { cleanup(cwd); }
});

test('falha de leitura é descarte nomeado e não aborta', () => {
  const result = findDuplicateGroups('synthetic', {
    memory: {
      listFragments: () => [{ storageKey: 'M001' }],
      readFragmentText: () => { throw new Error('synthetic unreadable'); },
    },
  });
  assert.strictEqual(result.fragments_examined, 1);
  assert.deepStrictEqual(result.skipped, [{ key: 'M001', reason: 'unreadable-fragment' }]);
});

test('renderCensus sempre imprime Pulados e regras permanecem no JSON', () => {
  const result = findDuplicateGroups(fixture());
  try {
    assert(renderCensus(result).includes('Pulados:\n  nenhum'));
    assert(Array.isArray(result.rules) && result.rules.length > 0);
  } finally { /* fixture has no content, cleanup is safe */ }
});

test('CLI JSON produz um único documento e exit 0', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, 'forge-memory-dupes.js'), '--cwd', fixture(), '--json'], { encoding: 'utf8' });
  assert.strictEqual(run.status, 0);
  assert.strictEqual(JSON.parse(run.stdout).verdict, 'EMPTY-STORE');
});

if (failed) {
  console.error(`\n${failed} falha(s), ${passed} passou(aram).`);
  process.exit(1);
}
console.log(`\nPASS: ${passed} testes`);
