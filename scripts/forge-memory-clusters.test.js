'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const memory = require('./forge-memory');
const clusters = require('./forge-memory-clusters');

let passed = 0;
let failed = 0;
function test(name, fn) { try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (error) { failed += 1; console.log(`  ✗ ${name}: ${error.message}`); } }
function fixture() { return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-clusters-test-')); }
function cleanup(cwd) { fs.rmSync(cwd, { recursive: true, force: true }); }
function write(cwd, unitId, facts, opts) { return memory.writeFragment(cwd, { unit_id: unitId, facts, stats: [] }, opts); }
function fact(memId, text, category) { return { mem_id: memId, category: category || 'pattern', text, created_at: '2026-08-15', source_unit: 'test' }; }
function keys(result) { return result.clusters.flatMap(cluster => cluster.items.map(item => clusters.itemKey(item.storage_key, item.mem_id))); }
function stub(entries) {
  return { listFragments: () => entries.map(entry => ({ ...entry })), readFragmentText: (_cwd, entry) => entry.text, parseFragment: text => ({ facts: JSON.parse(text).facts }) };
}
function digestTree(cwd) {
  const files = [];
  function walk(dir) { if (!fs.existsSync(dir)) return; for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, item.name); if (item.isDirectory()) walk(full); else files.push([path.relative(cwd, full), fs.readFileSync(full)]); } }
  walk(path.join(cwd, '.gsd')); return crypto.createHash('sha256').update(files.sort().map(([name, data]) => `${name}\0${data}`).join('')).digest('hex');
}

console.log('\n=== forge-memory-clusters.test.js ===\n');

test('exporta constantes e identidade composta', () => {
  assert.strictEqual(clusters.NGRAM_SIZE, 3);
  assert.strictEqual(clusters.CLUSTER_MIN_SCORE, 0.40);
  assert.strictEqual(clusters.CLUSTERS_PER_BATCH, 3);
  assert.strictEqual(clusters.ITEMS_PER_CLUSTER, 8);
  assert.strictEqual(clusters.itemKey('M001', 'MEM001'), 'M001::MEM001');
});

test('mesmo mem_id em fragmentos diferentes não é fundido', () => {
  const cwd = fixture();
  try {
    write(cwd, 'M001', [fact('MEM001', 'same fact alpha')]);
    write(cwd, 'M002', [fact('MEM001', 'same fact alpha')]);
    const result = clusters.buildClusters(cwd, { minScore: 0.2 });
    const all = keys(result);
    assert.strictEqual(new Set(all).size, 2);
    assert(all.includes('M001::MEM001') && all.includes('M002::MEM001'));
    const json = JSON.stringify(result);
    assert(json.includes('M001::MEM001') && json.includes('M002::MEM001'));
  } finally { cleanup(cwd); }
});

test('score usa normalização e char-3gram sem dependência externa', () => {
  const cwd = fixture();
  try {
    write(cwd, 'M001', [fact('MEM001', 'Stable text with   spaces')]);
    write(cwd, 'M002', [fact('MEM002', 'stable text with   spaces')]);
    assert.strictEqual(clusters.buildClusters(cwd, { minScore: 1 }).verdict, 'TARGETS');
    const source = fs.readFileSync(path.join(__dirname, 'forge-memory-clusters.js'), 'utf8');
    const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
    assert(requires.every(name => ['path', './forge-memory', './forge-memory-normalize', './forge-memory-axes'].includes(name)));
  } finally { cleanup(cwd); }
});

test('componentes são determinísticos e stdout é byte-idêntico', () => {
  const cwd = fixture();
  try {
    write(cwd, 'M001', [fact('MEM001', 'a repeated deterministic fact')]);
    write(cwd, 'M002', [fact('MEM002', 'a repeated deterministic fact')]);
    const first = spawnSync(process.execPath, [path.join(__dirname, 'forge-memory-clusters.js'), '--cwd', cwd, '--min-score', '0.4', '--json'], { encoding: 'utf8' });
    const second = spawnSync(process.execPath, [path.join(__dirname, 'forge-memory-clusters.js'), '--cwd', cwd, '--min-score', '0.4', '--json'], { encoding: 'utf8' });
    assert.strictEqual(first.status, 0); assert.strictEqual(second.status, 0); assert.strictEqual(first.stdout, second.stdout);
    assert.strictEqual(JSON.parse(first.stdout).verdict, 'TARGETS');
  } finally { cleanup(cwd); }
});

test('fatia 9 itens e preserva a união', () => {
  const entries = [];
  for (let i = 0; i < 9; i += 1) entries.push({ storageKey: `M${String(i + 1).padStart(3, '0')}`, unitId: `M${String(i + 1).padStart(3, '0')}`, milestoneId: null, grouped: false, text: JSON.stringify({ facts: [fact(`MEM${String(i + 1).padStart(3, '0')}`, 'nine identical facts')] }) });
  const result = clusters.buildClusters('unused', { memory: stub(entries), minScore: 1 });
  assert.strictEqual(result.clusters.length, 2); assert.strictEqual(result.clusters[0].sliced_from, result.clusters[1].sliced_from);
  assert.strictEqual(new Set(keys(result)).size, 9); assert.strictEqual(result.clusters[0].parts, 2);
});

test('loteia em no máximo três clusters', () => {
  const entries = [];
  for (let i = 0; i < 14; i += 1) entries.push({ storageKey: `M${String(i + 1).padStart(3, '0')}`, unitId: `M${String(i + 1).padStart(3, '0')}`, milestoneId: null, grouped: false, text: JSON.stringify({ facts: [fact(`MEM${String(i + 1).padStart(3, '0')}`, `unique pair ${Math.floor(i / 2)}`)] }) });
  const result = clusters.buildClusters('unused', { memory: stub(entries), minScore: 1 });
  assert.strictEqual(result.clusters.length, 7); assert(result.batches.every(batch => batch.clusters.length <= 3)); assert.strictEqual(result.batches.length, 3);
});

test('recomendação prefere solto, MEM e chave menor', () => {
  const entries = [{ storageKey: 'M002', unitId: 'M002', grouped: true, text: JSON.stringify({ facts: [fact('DST-1', 'recommended same')] }) }, { storageKey: 'M003', unitId: 'M003', grouped: false, text: JSON.stringify({ facts: [fact('DST-2', 'recommended same')] }) }, { storageKey: 'M001', unitId: 'M001', grouped: false, text: JSON.stringify({ facts: [fact('MEM001', 'recommended same')] }) }];
  const result = clusters.buildClusters('unused', { memory: stub(entries), minScore: 1 });
  const survivor = result.clusters[0].items.find(item => item.recommendation.action === 'sobrevivente-recomendado');
  assert.strictEqual(clusters.itemKey(survivor.storage_key, survivor.mem_id), 'M001::MEM001'); assert.strictEqual(result.recommendation_is_advisory, true);
});

test('corrida é read-only no store', () => {
  const cwd = fixture();
  try { write(cwd, 'M001', [fact('MEM001', 'read only')]); const before = digestTree(cwd); clusters.buildClusters(cwd); assert.strictEqual(digestTree(cwd), before); } finally { cleanup(cwd); }
});

test('censo e quatro vereditos são nomeados', () => {
  const empty = fixture();
  try { assert.strictEqual(clusters.buildClusters(empty).verdict, 'EMPTY-STORE'); } finally { cleanup(empty); }
  const noPairs = clusters.buildClusters('unused', { memory: stub([{ storageKey: 'M001', unitId: 'M001', text: JSON.stringify({ facts: [fact('MEM001', 'one')] }) }]) });
  assert.strictEqual(noPairs.verdict, 'NO-PAIRS');
  const noTarget = clusters.buildClusters('unused', { memory: stub([{ storageKey: 'M001', unitId: 'M001', text: JSON.stringify({ facts: [fact('MEM001', 'one')] }) }, { storageKey: 'M002', unitId: 'M002', text: JSON.stringify({ facts: [fact('MEM002', 'other')] }) }]), minScore: 1 });
  assert.strictEqual(noTarget.verdict, 'NO-TARGET');
  const target = clusters.buildClusters('unused', { memory: stub([{ storageKey: 'M001', unitId: 'M001', text: JSON.stringify({ facts: [fact('MEM001', 'same')] }) }, { storageKey: 'M002', unitId: 'M002', text: JSON.stringify({ facts: [fact('MEM002', 'same')] }) }]) });
  assert.strictEqual(target.verdict, 'TARGETS'); assert.strictEqual(target.census.pairs_compared, 1);
});

test('censo inclui DST/MEM, facts sem tokens e skipped nomeado', () => {
  const api = { listFragments: () => [{ storageKey: 'M001', unitId: 'M001', grouped: false, text: '{bad' }, { storageKey: 'M002', unitId: 'M002', grouped: false, text: JSON.stringify({ facts: [fact('DST-1', ''), fact('MEM001', 'same')] }) }], readFragmentText: (_cwd, entry) => entry.text, parseFragment: text => { if (text === '{bad') throw new Error('bad'); return { facts: JSON.parse(text).facts }; } };
  const result = clusters.buildClusters('unused', { memory: api, minScore: 1 });
  assert.strictEqual(result.census.skipped[0].reason, 'unreadable-fragment'); assert.strictEqual(result.census.facts_dst, 1); assert.strictEqual(result.census.pairs_dst_x_mem, 1); assert.strictEqual(result.census.facts_without_tokens.length, 1);
});

test('CLI aceita exatamente as flags documentadas e unknown sai 2', () => {
  const help = spawnSync(process.execPath, [path.join(__dirname, 'forge-memory-clusters.js'), '--help'], { encoding: 'utf8' });
  assert.strictEqual(help.status, 0); assert(help.stdout.includes('--min-score'));
  const bad = spawnSync(process.execPath, [path.join(__dirname, 'forge-memory-clusters.js'), '--nope'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 2); assert(bad.stderr.includes('Argumento desconhecido'));
});

test('renderClusters é textual e não aplica mudanças', () => {
  const rendered = clusters.renderClusters({ verdict: 'NO-PAIRS', clusters: [], census: { fragments_examined: 1, facts_examined: 1, pairs_compared: 0 } });
  assert(rendered.includes('NO-PAIRS')); assert(rendered.includes('nenhum cluster'));
});

test('Jaccard é simétrico, limitado e trata conjuntos vazios', () => {
  const helper = clusters._private.jaccard;
  assert.strictEqual(helper(new Set(), new Set()), 1);
  assert.strictEqual(helper(new Set(), new Set(['a'])), 0);
  assert.strictEqual(helper(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
  assert.strictEqual(helper(new Set(['a', 'b']), new Set(['b', 'c'])), helper(new Set(['b', 'c']), new Set(['a', 'b'])));
});

test('ngrams usa exatamente a largura exportada', () => {
  const grams = clusters._private.ngrams('abcd', clusters.NGRAM_SIZE);
  assert.deepStrictEqual([...grams], ['abc', 'bcd']);
  assert.deepStrictEqual([...clusters._private.ngrams('ab', 3)], ['ab']);
  assert.strictEqual(clusters._private.ngrams('', 3).size, 0);
});

test('ordenação total não depende da ordem de entrada', () => {
  const entries = [
    { storageKey: 'M002', unitId: 'M002', grouped: false, text: JSON.stringify({ facts: [fact('MEM002', 'order stable')] }) },
    { storageKey: 'M001', unitId: 'M001', grouped: false, text: JSON.stringify({ facts: [fact('MEM001', 'order stable')] }) },
  ];
  const result = clusters.buildClusters('unused', { memory: stub(entries), minScore: 1 });
  assert.deepStrictEqual(result.clusters[0].items.map(item => item.storage_key), ['M001', 'M002']);
  const reversed = clusters.buildClusters('unused', { memory: stub(entries.reverse()), minScore: 1 });
  assert.strictEqual(JSON.stringify(result), JSON.stringify(reversed));
});

test('parseArgs rejeita valores ausentes e aceita as quatro superfícies', () => {
  const parse = clusters._private.parseArgs;
  assert.deepStrictEqual(parse(['--cwd', 'fixture', '--min-score', '0.8', '--json']), { cwd: 'fixture', json: true, minscore: 0.8 });
  assert.strictEqual(parse(['--help']).help, true);
  assert.throws(() => parse(['--cwd']), /requer um valor/);
  assert.throws(() => parse(['--min-score', '--json']), /requer um valor/);
  assert.throws(() => parse(['--unknown']), /Argumento desconhecido/);
});

test('min-score inválido é falha de execução, não cluster parcial', () => {
  const api = stub([{ storageKey: 'M001', unitId: 'M001', text: JSON.stringify({ facts: [fact('MEM001', 'x')] }) }]);
  assert.throws(() => clusters.buildClusters('unused', { memory: api, minScore: 2 }), /between 0 and 1/);
  assert.throws(() => clusters.buildClusters('unused', { memory: api, minScore: -0.1 }), /between 0 and 1/);
});

test('clusters vazios não fabricam TARGETS', () => {
  const result = clusters.buildClusters('unused', { memory: stub([{ storageKey: 'M001', unitId: 'M001', text: JSON.stringify({ facts: [] }) }]) });
  assert.strictEqual(result.verdict, 'NO-PAIRS');
  assert.deepStrictEqual(result.clusters, []);
  assert.deepStrictEqual(result.batches, []);
});

test('subjects são apenas eixo de exibição e não mudam o score', () => {
  const result = clusters.buildClusters('unused', { memory: stub([
    { storageKey: 'M001', unitId: 'M001', grouped: false, text: JSON.stringify({ facts: [fact('MEM001', 'a stable semantic statement')] }) },
    { storageKey: 'M002', unitId: 'M002', grouped: false, text: JSON.stringify({ facts: [fact('MEM002', 'a stable semantic statement')] }) },
  ]), minScore: 1 });
  const items = result.clusters[0].items;
  assert(items.every(item => Array.isArray(item.subjects)));
  assert.deepStrictEqual(items.map(item => item.subjects), items.map(item => item.subjects));
});

test('fatiamento mantém metadados de origem em toda parte', () => {
  const entries = [];
  for (let i = 0; i < 10; i += 1) entries.push({ storageKey: `M${String(i + 1).padStart(3, '0')}`, unitId: `M${String(i + 1).padStart(3, '0')}`, grouped: false, text: JSON.stringify({ facts: [fact(`MEM${String(i + 1).padStart(3, '0')}`, 'slice metadata')] }) });
  const result = clusters.buildClusters('unused', { memory: stub(entries), minScore: 1 });
  assert(result.clusters.every(cluster => cluster.sliced_from && cluster.part && cluster.parts));
  assert(result.clusters.every(cluster => cluster.items.length <= clusters.ITEMS_PER_CLUSTER));
});

test('falha de leitura conta fragmento examinado e não aborta o JSON', () => {
  const result = clusters.buildClusters('unused', { memory: {
    listFragments: () => [{ storageKey: 'M001', unitId: 'M001' }],
    readFragmentText: () => { throw new Error('unreadable synthetic'); },
    parseFragment: memory.parseFragment,
  } });
  assert.strictEqual(result.verdict, 'NO-PAIRS');
  assert.strictEqual(result.census.fragments_examined, 1);
  assert.deepStrictEqual(result.census.skipped, [{ key: 'M001', reason: 'unreadable-fragment' }]);
});

if (failed) { console.error(`\n${failed} falha(s), ${passed} passou(aram).`); process.exit(1); }
console.log(`\nPASS: ${passed} testes`);
