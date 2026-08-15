'use strict';

const path = require('path');
const memory = require('./forge-memory');
const { normalizeForCompare, digestOf, NORMALIZATION_RULES } = require('./forge-memory-normalize');

// Facts are joined with a control character that cannot appear in a YAML
// scalar, so two different fact lists can never serialise to the same string.
const FACT_SEPARATOR = '\u001e';

// The grouping key must describe the *fact content*, never the envelope.
// unit_id, mem_id, created_at and source_unit differ by construction between
// two independently written duplicates, so hashing the raw file would make the
// detector green but inert: it would only ever match byte-copies of one file.
//
// Fact order is deliberately preserved (not sorted): reordering is a wider
// equivalence relation than this slice named, and the damage asymmetry
// (false positive shadows live memory) says to stay narrow.
function semanticContent(text, api) {
  // Unify line endings before parsing: parseFragment anchors on "---\n", so a
  // CRLF fragment would otherwise fall through to the raw branch and never
  // match its LF twin.
  const unified = String(text).replace(/\r\n?/g, '\n');
  const parse = (api && typeof api.parseFragment === 'function') ? api.parseFragment : memory.parseFragment;
  let parsed = null;
  try { parsed = parse(unified); } catch (error) { parsed = null; }
  if (!parsed || typeof parsed !== 'object') return { basis: 'raw', content: unified };
  const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
  if (facts.length > 0) {
    const content = facts
      .map(item => `${item && item.category != null ? item.category : ''}\n${item && item.text != null ? item.text : ''}`)
      .join(FACT_SEPARATOR);
    return { basis: 'facts', content };
  }
  const body = typeof parsed.body === 'string' ? parsed.body : '';
  if (body) return { basis: 'body', content: body };
  return { basis: 'raw', content: unified };
}

function semanticDigest(text, api) {
  const semantic = semanticContent(text, api);
  return digestOf(`${semantic.basis}\n${semantic.content}`);
}

function compareSurvivors(a, b) {
  if (a.grouped !== b.grouped) return a.grouped ? 1 : -1;
  const aQualified = a.storageKey.includes('__');
  const bQualified = b.storageKey.includes('__');
  if (aQualified !== bQualified) return aQualified ? -1 : 1;
  return a.storageKey.localeCompare(b.storageKey, 'en');
}

function publicEntry(entry) {
  return {
    storageKey: entry.storageKey,
    unitId: entry.unitId,
    milestoneId: entry.milestoneId,
    grouped: Boolean(entry.grouped),
    epoch: entry.epoch == null ? null : entry.epoch,
  };
}

function findDuplicateGroups(cwd, opts) {
  const options = opts || {};
  const api = options.memory || memory;
  const entries = api.listFragments(cwd, options.listOptions);
  const byDigest = new Map();
  const skipped = [];
  let fragmentsExamined = 0;

  for (const entry of entries) {
    fragmentsExamined += 1;
    let text;
    try {
      text = api.readFragmentText(cwd, entry);
    } catch (error) {
      skipped.push({ key: entry.storageKey, reason: 'unreadable-fragment' });
      continue;
    }
    const digest = semanticDigest(text, api);
    if (!byDigest.has(digest)) byDigest.set(digest, []);
    byDigest.get(digest).push(entry);
  }

  const groups = [];
  for (const [digest, members] of byDigest) {
    if (members.length < 2) continue;
    const ordered = [...members].sort(compareSurvivors);
    const loose = ordered.filter(entry => !entry.grouped);
    if (loose.length === 0) {
      for (const entry of ordered) skipped.push({ key: entry.storageKey, reason: 'no-loose-survivor' });
      continue;
    }
    groups.push({
      digest,
      survivor: publicEntry(ordered[0]),
      losers: ordered.slice(1).map(publicEntry),
    });
  }
  groups.sort((a, b) => a.digest.localeCompare(b.digest, 'en'));

  const verdict = fragmentsExamined === 0
    ? 'EMPTY-STORE'
    : groups.length > 0 ? 'TARGETS' : 'NO-TARGET';
  return {
    fragments_examined: fragmentsExamined,
    groups,
    skipped,
    verdict,
    rules: NORMALIZATION_RULES,
  };
}

function renderEntry(entry) {
  return `${entry.storageKey}${entry.grouped ? ' (agrupado)' : ''}`;
}

function renderCensus(result) {
  const lines = [
    `Censo de duplicatas: ${result.fragments_examined} fragmento(s) examinado(s) — veredito ${result.verdict}`,
  ];
  if (result.groups.length === 0) lines.push('Grupos: nenhum');
  for (const group of result.groups) {
    lines.push(`Grupo ${group.digest}: sobrevivente ${renderEntry(group.survivor)}; perdedores ${group.losers.map(renderEntry).join(', ')}`);
  }
  lines.push('Pulados:');
  if (result.skipped.length === 0) lines.push('  nenhum');
  for (const item of result.skipped) lines.push(`  ${item.key}: ${item.reason}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { cwd: '.', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cwd') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--cwd requer um diretório');
      options.cwd = argv[++i];
    } else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  return options;
}

function usage() {
  return 'Uso: node scripts/forge-memory-dupes.js --cwd <dir> [--json]';
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    const result = findDuplicateGroups(path.resolve(options.cwd));
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${renderCensus(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  findDuplicateGroups,
  renderCensus,
  _private: { compareSurvivors, parseArgs, normalizeForCompare, semanticContent, semanticDigest },
};
