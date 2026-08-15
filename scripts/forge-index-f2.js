'use strict';

// Instrumento F2: estimativa independente do recall do extrator de citações.
// Este módulo só lê o store e o índice; a escrita permanece deliberadamente fora
// desta superfície, para que a medição possa ser executada em produção.
const path = require('path');
const { buildFileIndex, extractCitations } = require('./forge-memory-index');
const { listFragments, parseFragment, readFragmentText } = require('./forge-memory');

// Vocabulário próprio. Não usar CODE_EXT/CITATION_REGEXES aqui: o detector deve
// ser uma segunda observação, mais larga, do mesmo texto.
const TRAILING_PUNCTUATION = '.,;:!?)]}>';
const VERSION_RE = /^\d+(?:\.\d+)+$/;
const PLAIN_NOISE = new Set(['e/ou', 'n/a', 'na', 'ou']);

function cleanToken(raw) {
  let value = String(raw || '');
  while (value.length > 1 && TRAILING_PUNCTUATION.includes(value[value.length - 1])) value = value.slice(0, -1);
  return value;
}

function basename(value) {
  return String(value || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
}

function mentionKind(value) {
  const core = cleanToken(value);
  const wrapped = core.length >= 2 && core[0] === '`' && core[core.length - 1] === '`';
  const inner = wrapped ? core.slice(1, -1) : core;
  const segments = inner.split('/');
  if (wrapped) return 'backticks';
  if (/\.[A-Za-z0-9]{1,6}$/.test(inner)) return 'suffix';
  if (segments.length >= 2 && segments.every(Boolean)) return 'slash';
  return null;
}

function detectMentions(text) {
  if (typeof text !== 'string' || !text) return [];
  const mentions = [];
  const tokenRe = /\S+/g;
  let match;
  while ((match = tokenRe.exec(text)) !== null) {
    const raw = match[0];
    const core = cleanToken(raw);
    const why = mentionKind(core);
    if (!why) continue;
    const inner = core.length >= 2 && core[0] === '`' && core[core.length - 1] === '`' ? core.slice(1, -1) : core;
    mentions.push({ raw, normalized: basename(inner), why });
  }
  return mentions;
}

function detectorFalsePositive(mention) {
  const normalized = mention.normalized;
  const raw = String(mention.raw || '').toLowerCase();
  if (PLAIN_NOISE.has(raw)) return 'segmentos de prosa, não caminho de arquivo';
  if (VERSION_RE.test(normalized)) return 'número decimal ou versão nua';
  if (/^[a-z]\/([a-z]|\d)$/i.test(raw)) return 'abreviação com barra';
  if (mention.why === 'slash' && !/[.][A-Za-z0-9]{1,6}$/.test(normalized)) return 'token com barra sem aparência de arquivo';
  return null;
}

// S02 R1 (review-fix): o ruído conhecido do próprio detector é SUBTRAÍDO do
// denominador antes de names/missing/bucket/f2_recall. Antes desta correção o
// filtro era só diagnóstico: uma versão nua (`3.1.2`) ou `e/ou` contava como
// menção não capturada e deprimia o recall gateado em F2_THRESHOLD. A lista
// diagnóstica (`detector_false_positives`) continua sendo emitida a partir da
// lista CHEIA — descarte enumerado, nunca silencioso.
function signalMentions(mentions) {
  return (Array.isArray(mentions) ? mentions : []).filter((item) => !detectorFalsePositive(item));
}

// Menções já filtradas de ruído, para consumidores fora deste módulo (o índice
// usa isto no bucket (b)) — assim os dois lados classificam pelo mesmo critério.
function detectSignalMentions(text) {
  return signalMentions(detectMentions(text));
}

function classifyCitationPrecision(citations, mentions, memId) {
  const mentionNames = new Set(mentions.map((item) => item.normalized));
  return citations
    .filter((citation) => !mentionNames.has(basename(citation.path || citation.raw)))
    .map((citation) => ({ mem_id: memId || null, raw: citation.raw, motivo: 'citação extraída sem menção independente correspondente' }));
}

function classifyFact(fact, fragment) {
  const text = fact && fact.text ? String(fact.text).replace(/\r\n?/g, '\n') : '';
  const observed = detectMentions(text);
  const mentions = signalMentions(observed);
  const citations = extractCitations(text);
  const names = new Set(mentions.map((item) => item.normalized));
  const cited = new Set(citations.map((item) => basename(item.path || item.raw)));
  const missing = mentions.filter((item) => !cited.has(item.normalized));
  let bucket = 'no-mention';
  if (mentions.length && !missing.length) bucket = 'covered';
  else if (missing.length && missing.length < mentions.length) bucket = 'partial';
  else if (mentions.length) bucket = 'missed';
  return {
    mem_id: fact && fact.mem_id ? fact.mem_id : null,
    storage_key: fragment && fragment.storageKey ? fragment.storageKey : null,
    text,
    mentions,
    citations,
    missing_mentions: missing,
    bucket,
    precision_candidates: classifyCitationPrecision(citations, mentions, fact && fact.mem_id),
    detector_false_positives: observed.filter((item) => detectorFalsePositive(item)).map((item) => ({ ...item, motivo: detectorFalsePositive(item) })),
  };
}

function sumUnresolved(unresolved) {
  return (Array.isArray(unresolved) ? unresolved : []).reduce((total, item) => total + Number(item.count || 0), 0);
}

function assertCoverageIdentity(report) {
  const byReason = Object.values(report.unresolved_by_reason || {});
  const unresolved = byReason.reduce((total, count) => total + count, 0);
  return unresolved === report.citations_total - report.citations_resolved;
}

function reportFactCounts(facts) {
  return {
    covered: facts.filter((fact) => fact.bucket === 'covered').length,
    partial: facts.filter((fact) => fact.bucket === 'partial').length,
    missed: facts.filter((fact) => fact.bucket === 'missed').length,
    no_mention: facts.filter((fact) => fact.bucket === 'no-mention').length,
  };
}

function measureF2(cwd, opts) {
  const root = path.resolve(cwd || process.cwd());
  const options = opts || {};
  const facts = [];
  const fragments = listFragments(root, options.listFragments || {});
  for (const fragment of fragments) {
    const parsed = parseFragment(readFragmentText(root, fragment));
    for (const fact of Array.isArray(parsed.facts) ? parsed.facts : []) facts.push(classifyFact(fact, fragment));
  }
  const mentioned = facts.filter((fact) => fact.mentions.length > 0);
  const missed = facts.filter((fact) => fact.bucket === 'missed');
  const partial = facts.filter((fact) => fact.bucket === 'partial');
  const covered = facts.filter((fact) => fact.bucket === 'covered');
  const index = buildFileIndex(root, options.index || {});
  const coverage = index.coverage || {};
  const unresolvedByReason = {};
  for (const item of Array.isArray(coverage.unresolved) ? coverage.unresolved : []) unresolvedByReason[item.reason] = (unresolvedByReason[item.reason] || 0) + Number(item.count || 0);
  const citationsTotal = Number(coverage.citations_total || 0);
  const citationsResolved = Number(coverage.citations_resolved || 0);
  const unresolvedTotal = Object.values(unresolvedByReason).reduce((a, b) => a + b, 0);
  if (unresolvedTotal !== citationsTotal - citationsResolved) throw new Error('unresolved_by_reason não fecha a identidade de citações');
  const detectorFalsePositives = facts.flatMap((fact) => fact.detector_false_positives.map((item) => ({ mem_id: fact.mem_id, raw: item.raw, motivo: item.motivo })));
  const falsePositiveCandidates = facts.flatMap((fact) => fact.precision_candidates);
  const denominator = mentioned.length;
  return {
    verdict: denominator === 0 ? 'EMPTY-DENOMINATOR' : 'MEASURED',
    facts_that_mention_file: denominator,
    facts_covered: covered,
    facts_missed_total: missed,
    facts_missed_partial: partial.map((fact) => ({ mem_id: fact.mem_id, missing_mentions: fact.missing_mentions })),
    f2_recall: denominator === 0 ? null : 1 - (missed.length + partial.length) / denominator,
    citations_total: citationsTotal,
    citations_resolved: citationsResolved,
    resolution_rate: citationsTotal === 0 ? null : citationsResolved / citationsTotal,
    unresolved_by_reason: unresolvedByReason,
    false_positive_candidates: falsePositiveCandidates,
    detector_false_positives: detectorFalsePositives,
    facts_no_mention: facts.filter((fact) => fact.bucket === 'no-mention').map((fact) => ({ mem_id: fact.mem_id })),
    fact_counts: reportFactCounts(facts),
    coverage_identity: assertCoverageIdentity({ unresolved_by_reason: unresolvedByReason, citations_total: citationsTotal, citations_resolved: citationsResolved }),
    partial: !!index.partial,
  };
}

function parseCliArgs(argv) {
  const result = { cwd: process.cwd(), json: false, valid: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') result.json = true;
    else if (argv[i] === '--cwd' && argv[i + 1] && !argv[i + 1].startsWith('--')) result.cwd = argv[++i];
    else { result.valid = false; break; }
  }
  return result;
}

function runCli(argv) {
  const args = parseCliArgs(argv);
  if (!args.valid) { process.stderr.write(JSON.stringify({ error: 'Uso: forge-index-f2.js --cwd <dir> [--json]' }) + '\n'); return 2; }
  try {
    const report = measureF2(args.cwd);
    if (args.json) process.stdout.write(JSON.stringify(report) + '\n');
    else process.stdout.write(`# Medição F2\n\n- veredito: ${report.verdict}\n- recall: ${report.f2_recall}\n- fatos com menção: ${report.facts_that_mention_file}\n- resolução: ${report.resolution_rate}\n`);
    return 0;
  } catch (error) { process.stderr.write(JSON.stringify({ error: error.message || String(error) }) + '\n'); return 1; }
}

module.exports = { detectMentions, detectSignalMentions, detectorFalsePositive, classifyCitationPrecision, measureF2, runCli };
if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
