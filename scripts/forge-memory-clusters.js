'use strict';

const path = require('path');
const memory = require('./forge-memory');
const normalize = require('./forge-memory-normalize');
const axes = require('./forge-memory-axes');

// This is a deliberately conservative, principled default.  It is not tuned
// to manufacture targets: the planning measurement was 10 pairs >= 0.20,
// 1 pair >= 0.30, and 0 pairs >= 0.40 in the current store.
const CLUSTER_MIN_SCORE = 0.40;
const NGRAM_SIZE = 3;
const CLUSTERS_PER_BATCH = 3;
const ITEMS_PER_CLUSTER = 8;

function itemKey(storageKey, memId) { return `${storageKey}::${memId}`; }

function ngrams(value, size) {
  const text = String(value);
  const width = size || NGRAM_SIZE;
  const result = new Set();
  if (!text) return result;
  if (text.length < width) { result.add(text); return result; }
  for (let i = 0; i <= text.length - width; i += 1) result.add(text.slice(i, i + width));
  return result;
}

function jaccard(a, b) {
  const left = a instanceof Set ? a : ngrams(a);
  const right = b instanceof Set ? b : ngrams(b);
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function compareItems(a, b) {
  return String(a.storage_key).localeCompare(String(b.storage_key), 'en')
    || String(a.mem_id).localeCompare(String(b.mem_id), 'en');
}

function isFirstHand(memId) { return /^MEM\d{3}$/.test(String(memId || '')); }
function isDst(memId) { return /^DST-/.test(String(memId || '')); }

function recommendationOrder(a, b) {
  return (Boolean(a.grouped) - Boolean(b.grouped))
    || (Number(isFirstHand(b.mem_id)) - Number(isFirstHand(a.mem_id)))
    || compareItems(a, b);
}

function parseFact(entry, fact, subjectTokens) {
  const category = fact && fact.category != null ? String(fact.category) : '';
  const text = fact && fact.text != null ? String(fact.text) : '';
  const parsed = subjectTokens(text);
  return {
    storage_key: entry.storageKey,
    mem_id: fact && fact.mem_id != null ? String(fact.mem_id) : '',
    category,
    text,
    grouped: Boolean(entry.grouped),
    unit_id: entry.unitId,
    milestone_id: entry.milestoneId,
    subjects: parsed.tokens.slice().sort((a, b) => a.localeCompare(b, 'en')),
  };
}

function enumerateFacts(cwd, api, subjectTokens) {
  const fragments = api.listFragments(cwd);
  const facts = [];
  const skipped = [];
  // makeClusters keys every fact by itemKey(storage_key, mem_id). Legacy data
  // can carry the same mem_id twice inside one fragment (parseFragment accepts
  // it), and a Map keyed that way would silently drop one of them. Name the
  // discard here instead: enumeration is the only place that can still see it.
  const seen = new Set();
  for (const entry of fragments) {
    // Keep storage identity grounded in the shared parser.  This also makes
    // malformed test doubles auditable without ever opening entry.path here.
    if (typeof api.parseStorageKey === 'function' && !api.parseStorageKey(entry.storageKey)) {
      skipped.push({ key: entry.storageKey, reason: 'invalid-storage-key' });
      continue;
    }
    let source;
    try {
      source = api.readFragmentText(cwd, entry);
      const parsed = api.parseFragment(String(source).replace(/\r\n?/g, '\n'));
      for (const fact of Array.isArray(parsed.facts) ? parsed.facts : []) {
        const parsedFact = parseFact(entry, fact, subjectTokens);
        const key = itemKey(parsedFact.storage_key, parsedFact.mem_id);
        if (seen.has(key)) { skipped.push({ key, reason: 'duplicate-mem-id-in-fragment' }); continue; }
        seen.add(key);
        facts.push(parsedFact);
      }
    } catch (error) {
      skipped.push({ key: entry.storageKey, reason: 'unreadable-fragment' });
    }
  }
  facts.sort(compareItems);
  return { fragments_examined: fragments.length, facts, skipped };
}

function makeClusters(facts, minScore) {
  const parent = new Map(facts.map(item => [itemKey(item.storage_key, item.mem_id), itemKey(item.storage_key, item.mem_id)]));
  function find(key) {
    let root = parent.get(key);
    while (root !== parent.get(root)) root = parent.get(root);
    let cursor = key;
    while (parent.get(cursor) !== root) { const next = parent.get(cursor); parent.set(cursor, root); cursor = next; }
    return root;
  }
  function union(left, right) { const a = find(left); const b = find(right); if (a !== b) parent.set(b, a); }
  const fingerprints = facts.map(item => ngrams(normalize.normalizeForCompare(`${item.category}\n${item.text}`), NGRAM_SIZE));
  const pairs = [];
  for (let i = 0; i < facts.length; i += 1) {
    for (let j = i + 1; j < facts.length; j += 1) {
      const score = jaccard(fingerprints[i], fingerprints[j]);
      pairs.push({ left: itemKey(facts[i].storage_key, facts[i].mem_id), right: itemKey(facts[j].storage_key, facts[j].mem_id), score });
      if (score >= minScore) union(pairs[pairs.length - 1].left, pairs[pairs.length - 1].right);
    }
  }
  const groups = new Map();
  for (const pair of pairs.filter(item => item.score >= minScore)) {
    const root = find(pair.left);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root).add(pair.left); groups.get(root).add(pair.right);
  }
  const byKey = new Map(facts.map(item => [itemKey(item.storage_key, item.mem_id), item]));
  const clusters = [...groups.values()].map(keys => {
    const items = [...keys].map(key => byKey.get(key)).sort(compareItems);
    const survivor = items.slice().sort(recommendationOrder)[0];
    return {
      id: items.map(item => itemKey(item.storage_key, item.mem_id)).join('|'),
      items: items.map(item => ({ ...item, recommendation: itemKey(item.storage_key, item.mem_id) === itemKey(survivor.storage_key, survivor.mem_id)
        ? { action: 'sobrevivente-recomendado', reason: 'solto > primeira-mao > menor-storage-key' }
        : { action: 'fundir-no-sobrevivente', survivor: itemKey(survivor.storage_key, survivor.mem_id), reason: 'duplicata-semantica-advisory' } })),
    };
  });
  clusters.sort((a, b) => compareItems(a.items[0], b.items[0]));
  return { clusters, pairs_compared: pairs.length, pairs };
}

function sliceClusters(clusters) {
  const output = [];
  for (const cluster of clusters) {
    if (cluster.items.length <= ITEMS_PER_CLUSTER) { output.push(cluster); continue; }
    const parts = Math.ceil(cluster.items.length / ITEMS_PER_CLUSTER);
    for (let i = 0; i < parts; i += 1) output.push({ ...cluster, id: `${cluster.id}#${i + 1}`, sliced_from: cluster.id, part: i + 1, parts, items: cluster.items.slice(i * ITEMS_PER_CLUSTER, (i + 1) * ITEMS_PER_CLUSTER) });
  }
  return output;
}

function batchClusters(clusters) {
  const batches = [];
  for (let i = 0; i < clusters.length; i += CLUSTERS_PER_BATCH) batches.push({ batch: batches.length + 1, clusters: clusters.slice(i, i + CLUSTERS_PER_BATCH) });
  return batches;
}

function buildClusters(cwd, opts) {
  const options = opts || {};
  const api = options.memory || memory;
  const enumerated = enumerateFacts(cwd, api, (options.axes || axes)._private.subjectTokens);
  const minScore = options.minScore == null ? CLUSTER_MIN_SCORE : Number(options.minScore);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) throw new Error('min-score must be between 0 and 1');
  const made = makeClusters(enumerated.facts, minScore);
  const dst = enumerated.facts.filter(item => isDst(item.mem_id)).length;
  const cross = made.pairs.filter(pair => (isDst(pair.left.split('::')[1]) && isFirstHand(pair.right.split('::')[1])) || (isDst(pair.right.split('::')[1]) && isFirstHand(pair.left.split('::')[1]))).length;
  const without = enumerated.facts.filter(item => item.subjects.length === 0).map(item => ({
    item: itemKey(item.storage_key, item.mem_id),
    reason: item.text.trim() ? 'so-tokens-curtos-ou-stopwords' : 'texto-vazio',
  }));
  const clusters = sliceClusters(made.clusters);
  return {
    verdict: enumerated.fragments_examined === 0 ? 'EMPTY-STORE' : made.pairs_compared === 0 ? 'NO-PAIRS' : clusters.length ? 'TARGETS' : 'NO-TARGET',
    clusters,
    batches: batchClusters(clusters),
    recommendation_is_advisory: true,
    min_score: minScore,
    census: { fragments_examined: enumerated.fragments_examined, facts_examined: enumerated.facts.length, pairs_compared: made.pairs_compared, facts_dst: dst, pairs_dst_x_mem: cross, facts_without_tokens: without, skipped: enumerated.skipped },
  };
}

function renderClusters(result) {
  const lines = [`Clustering de fatos: ${result.verdict}`, `Censo: ${result.census.fragments_examined} fragmento(s), ${result.census.facts_examined} fato(s), ${result.census.pairs_compared} par(es)`];
  for (const cluster of result.clusters) lines.push(`- ${cluster.id}: ${cluster.items.map(item => itemKey(item.storage_key, item.mem_id)).join(', ')}`);
  if (!result.clusters.length) lines.push('- nenhum cluster');
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { cwd: '.', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cwd' || arg === '--min-score') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} requer um valor`); options[arg.slice(2).replace('-', '')] = arg === '--min-score' ? Number(argv[++i]) : argv[++i]; }
    else if (arg === '--json') options.json = true;
    else if (arg === '--help') options.help = true;
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  return options;
}

function usage() { return 'Uso: node scripts/forge-memory-clusters.js [--cwd <dir>] [--min-score <0..1>] [--json] [--help]'; }
function main(argv) {
  let options;
  try { options = parseArgs(argv); } catch (error) { process.stderr.write(`${error.message}\n${usage()}\n`); return 2; }
  if (options.help) { process.stdout.write(`${usage()}\n`); return 0; }
  try { const result = buildClusters(path.resolve(options.cwd), { minScore: options.minscore }); process.stdout.write(`${options.json ? JSON.stringify(result) : renderClusters(result)}\n`); return 0; }
  catch (error) { process.stderr.write(`${error.message}\n`); return 1; }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { buildClusters, renderClusters, CLUSTER_MIN_SCORE, NGRAM_SIZE, CLUSTERS_PER_BATCH, ITEMS_PER_CLUSTER, itemKey, main, _private: { ngrams, jaccard, parseArgs, enumerateFacts, makeClusters, sliceClusters, batchClusters, compareItems, recommendationOrder } };
