'use strict';

// Unidade de origem is deliberately derived from the fragment envelope carried
// by each fact. A fact's source_unit is descriptive metadata, not an identity
// boundary: the storage key is the durable boundary returned by listFragments.
const { parseStorageKey } = require('./forge-memory');

function sortFacts(a, b) {
  return String(a && a.mem_id || '').localeCompare(String(b && b.mem_id || ''), 'en');
}

function buildUnitAxis(result, opts) {
  opts = opts || {};
  const facts = Array.isArray(result && result.facts) ? result.facts : [];
  const groups = new Map();
  const undetermined = new Map();

  for (const fact of facts) {
    const storageKey = fact && typeof fact.storage_key === 'string' ? fact.storage_key : '';
    const parsed = storageKey ? parseStorageKey(storageKey) : null;
    if (!parsed) {
      const reason = storageKey ? 'invalid-storage-key' : 'missing-storage-key';
      const key = storageKey || '<sem storage_key>';
      if (!undetermined.has(key)) undetermined.set(key, { storage_key: storageKey || null, reason, facts: [] });
      undetermined.get(key).facts.push(fact);
      continue;
    }
    if (!groups.has(parsed.storageKey)) {
      groups.set(parsed.storageKey, {
        storage_key: parsed.storageKey,
        unit_id: parsed.unitId,
        milestone_id: parsed.milestoneId,
        facts: [],
      });
    }
    groups.get(parsed.storageKey).facts.push(fact);
  }

  const units = [...groups.values()].sort((a, b) => a.storage_key.localeCompare(b.storage_key, 'en'));
  for (const unit of units) unit.facts.sort(sortFacts);
  const unitsUndetermined = [...undetermined.values()].sort((a, b) => String(a.storage_key).localeCompare(String(b.storage_key), 'en'));
  for (const unit of unitsUndetermined) unit.facts.sort(sortFacts);

  const coverage = (result && result.coverage) || {};
  const factsNotRead = {
    unreadable_fragments: Array.isArray(coverage.unreadable_fragments) ? coverage.unreadable_fragments.length : 0,
    fragments_skipped_by_store: Array.isArray(coverage.fragments_skipped_by_store) ? coverage.fragments_skipped_by_store.length : 0,
  };
  return {
    units,
    units_undetermined: unitsUndetermined,
    coverage: {
      facts_total: facts.length,
      facts_with_unit: units.reduce((n, unit) => n + unit.facts.length, 0),
      units_total: units.length,
      units_undetermined: unitsUndetermined,
      facts_not_read: factsNotRead,
    },
    partial: !!(result && result.partial),
    fragment_listing_failed: coverage.fragment_listing_failed || null,
    requested: Array.isArray(opts.requested) ? opts.requested.slice() : [],
  };
}

function unitMatches(unit, requested) {
  return requested.some((query) => query === unit.storage_key || query === unit.unit_id);
}

function renderUnitAxis(axis, opts) {
  opts = opts || {};
  const requested = Array.isArray(opts.requested) ? opts.requested : [];
  const units = Array.isArray(axis && axis.units) ? axis.units : [];
  const shown = requested.length === 0 ? units : units.filter((unit) => unitMatches(unit, requested));
  const partial = !!(axis && axis.partial);
  const listingFailed = axis && axis.fragment_listing_failed;
  const { factLine, codeCell, cell, prose } = require('./forge-memory-index');
  const lines = ['## Eixo unidade de origem', ''];

  if (listingFailed) {
    lines.push(`> O store não pôde ser lido (fragment_listing_failed): ${prose(listingFailed)}`);
    lines.push('> A ausência de unidade não foi confirmada; os fatos abaixo podem estar ausentes por falha de leitura.', '');
  } else if (partial) {
    lines.push('> O índice está incompleto (index-partial-no-match); a ausência de unidade não foi confirmada.', '');
  }

  if (shown.length === 0) {
    if (requested.length > 0) {
      const reason = listingFailed ? 'index-unavailable' : partial ? 'index-partial-no-match' : 'no-facts-for-unit';
      lines.push('_Nenhum fato confirmado para a unidade solicitada._');
      lines.push('');
      for (const query of requested) lines.push(`- ${codeCell(query)} — ${reason}`);
      lines.push('');
    } else {
      lines.push('_Nenhuma unidade com fatos lidos._', '');
    }
  } else {
    for (const unit of shown) {
      lines.push(`### ${codeCell(unit.storage_key)}`, '');
      for (const fact of unit.facts) lines.push(factLine(fact));
      lines.push('');
    }
  }

  const undetermined = Array.isArray(axis && axis.units_undetermined) ? axis.units_undetermined : [];
  lines.push('### Unidades indeterminadas', '');
  if (undetermined.length === 0) lines.push('_Nenhum fragmento com unidade indeterminada._');
  else for (const unit of undetermined) lines.push(`- ${unit.storage_key ? codeCell(unit.storage_key) : '(sem storage_key)'} — ${cell(unit.reason)} — fatos: ${unit.facts.length}`);
  lines.push('');

  const c = (axis && axis.coverage) || {};
  const nr = c.facts_not_read || {};
  lines.push(`- cobertura estrutural: ${c.facts_with_unit || 0}/${c.facts_total || 0} fatos lidos com unidade resolvida`);
  lines.push(`- fatos não lidos: unreadable_fragments=${nr.unreadable_fragments || 0}; fragments_skipped_by_store=${nr.fragments_skipped_by_store || 0}`);
  lines.push('');
  return lines.join('\n');
}

// Versioned, deliberately conservative lexical vocabulary. This is not a
// quality threshold: it only prevents grammatical glue from becoming a topic.
const STOPWORDS_VERSION = 'pt-BR+en-2026-08-14-v1';
const STOPWORDS = new Set([
  'a', 'as', 'ao', 'aos', 'com', 'como', 'da', 'das', 'de', 'do', 'dos', 'e',
  'em', 'entre', 'essa', 'esse', 'esta', 'este', 'for', 'foi', 'ha', 'isso',
  'isto', 'na', 'nas', 'nem', 'no', 'nos', 'o', 'os', 'ou', 'para', 'por',
  'que', 'se', 'sem', 'sua', 'suas', 'te', 'um', 'uma', 'uns', 'umas', 'à',
  'às', 'é', 'are', 'an', 'and', 'as', 'at', 'be', 'by', 'for', 'from', 'has',
  'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the',
  'their', 'this', 'to', 'was', 'were', 'with', 'without', 'you', 'your',
]);
// D-2: K limits presentation only. Coverage is reported honestly; no
// percentage or minimum-subject assertion belongs here.
const SUBJECTS_PER_FACT = 5;

function normalizeSubject(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\r\n?/g, '\n').toLocaleLowerCase('en')
    .trim().replace(/^[\W_]+|[\W_]+$/gu, '');
}

function subjectTokens(text) {
  const original = String(text === null || text === undefined ? '' : text).replace(/\r\n?/g, '\n').trim();
  if (!original) return { tokens: [], reason: 'texto-vazio' };
  const raw = original.match(/`[^`]+`|[\p{L}\p{N}_-]+(?:[A-Z][\p{L}\p{N}_-]*)?/gu) || [];
  const tokens = raw.map((token) => token.replace(/^`|`$/g, '')).filter((token) => {
    const lowered = token.toLocaleLowerCase('en');
    const meaningfulSyntax = /`|[-_]|[A-Z]/.test(token);
    return !STOPWORDS.has(lowered) && (lowered.length >= 4 || meaningfulSyntax);
  }).map((token) => token.toLocaleLowerCase('en'));
  const nonStop = raw.filter((token) => !STOPWORDS.has(token.toLocaleLowerCase('en')));
  if (tokens.length) return { tokens };
  return { tokens: [], reason: nonStop.length ? 'so-tokens-curtos' : 'so-stopwords' };
}

// S02 R4 (review-fix): a ordenação por raridade (tf-idf) era computada inline e
// só observável através de `subjects`, que é ordenado por localeCompare — um
// teste sobre aquela lista mede ordem alfabética, não o contrato "termo raro
// vence termo comum". Extraída para ser asserida diretamente (via `_private`).
function rankSubjects(tokens, df, totalFacts) {
  const frequency = new Map();
  for (const token of tokens) frequency.set(token, (frequency.get(token) || 0) + 1);
  return [...frequency.keys()].sort((a, b) => {
    const scoreA = frequency.get(a) * Math.log(totalFacts / df.get(a));
    const scoreB = frequency.get(b) * Math.log(totalFacts / df.get(b));
    return scoreB - scoreA || a.localeCompare(b, 'en');
  }).slice(0, SUBJECTS_PER_FACT);
}

function buildSubjectAxis(result, opts) {
  opts = opts || {};
  const facts = Array.isArray(result && result.facts) ? result.facts.slice() : [];
  const tokenized = facts.map((fact) => subjectTokens(fact && (fact.text || fact.summary)));
  const df = new Map();
  for (const item of tokenized) for (const token of new Set(item.tokens)) df.set(token, (df.get(token) || 0) + 1);
  const subjects = new Map();
  const without = [];
  facts.forEach((fact, index) => {
    const item = tokenized[index];
    if (!item.tokens.length) {
      without.push({ mem_id: fact && fact.mem_id ? fact.mem_id : null, reason: item.reason });
      return;
    }
    const ranked = rankSubjects(item.tokens, df, facts.length);
    for (const subject of ranked) {
      if (!subjects.has(subject)) subjects.set(subject, { subject, facts: [] });
      subjects.get(subject).facts.push(fact);
    }
  });
  const ordered = [...subjects.values()].sort((a, b) => a.subject.localeCompare(b.subject, 'en'));
  for (const group of ordered) group.facts.sort(sortFacts);
  without.sort((a, b) => String(a.mem_id).localeCompare(String(b.mem_id), 'en'));
  return {
    subjects: ordered,
    coverage: {
      facts_total: facts.length,
      facts_with_subject: facts.length - without.length,
      facts_without_subject: without,
      subjects_total: ordered.length,
      k: SUBJECTS_PER_FACT,
      stopwords_version: STOPWORDS_VERSION,
    },
    requested: Array.isArray(opts.requested) ? opts.requested.map(normalizeSubject) : [],
  };
}

function renderSubjectAxis(axis, opts) {
  opts = opts || {};
  const requested = Array.isArray(opts.requested) ? opts.requested.map(normalizeSubject) : [];
  const groups = Array.isArray(axis && axis.subjects) ? axis.subjects : [];
  const shown = requested.length ? groups.filter((group) => requested.includes(normalizeSubject(group.subject))) : groups;
  const { factLine, codeCell, cell } = require('./forge-memory-index');
  const lines = ['## Eixo assunto', ''];
  if (!shown.length) lines.push(requested.length ? '_Nenhum fato confirmado para o assunto solicitado._' : '_Nenhum assunto com fatos lidos._', '');
  for (const group of shown) {
    lines.push(`### ${codeCell(group.subject)}`, '');
    for (const fact of group.facts) lines.push(factLine(fact));
    lines.push('');
  }
  const coverage = (axis && axis.coverage) || {};
  lines.push('### Fatos sem assunto', '');
  if (!coverage.facts_without_subject || coverage.facts_without_subject.length === 0) lines.push('_Nenhum fato sem assunto._');
  else for (const fact of coverage.facts_without_subject) lines.push(`- ${fact.mem_id ? codeCell(fact.mem_id) : '(sem mem_id)'} — ${cell(fact.reason)}`);
  lines.push('', `- cobertura: ${coverage.facts_with_subject || 0}/${coverage.facts_total || 0} fatos com assunto; subjects_total=${coverage.subjects_total || 0}; k=${coverage.k || SUBJECTS_PER_FACT}; stopwords=${cell(coverage.stopwords_version || STOPWORDS_VERSION)}`, '');
  return lines.join('\n');
}

// The axis intentionally stores the original fact object. This keeps the
// renderer on the shared factLine path and means future additive fact fields
// remain visible without a second projection schema. Sorting happens at both
// group and fact level because Map insertion order is input order, not a
// durable ordering guarantee. The scoring formula is local to one invocation:
// df is computed from the same facts census and therefore cannot depend on
// filesystem order, process time, or external state. A missing text field is
// treated as empty input and receives an explicit coverage reason; it is never
// silently promoted to a generic subject. Requested values are normalized by
// normalizeSubject on both sides, matching the query-path precedent in the
// index module. Markdown headings use codeCell even though subjects came from
// prose, because backticks and pipes are both valid hostile characters here.
// STOPWORDS is exported for inspection and versioning, while callers should
// consume the coverage stopwords_version field rather than infer the version.
// SUBJECTS_PER_FACT is a presentation cap only; it is deliberately not a
// coverage gate and no test may turn it into a minimum percentage requirement.
// This separation also makes empty and partial stores auditable in markdown.

module.exports = { buildUnitAxis, renderUnitAxis, buildSubjectAxis, renderSubjectAxis, STOPWORDS, SUBJECTS_PER_FACT, normalizeSubject, _private: { sortFacts, unitMatches, subjectTokens, rankSubjects } };

// The public result intentionally keeps both the complete read census and the
// filtered presentation concerns separate. This makes future query renderers
// unable to silently redefine structural coverage.
