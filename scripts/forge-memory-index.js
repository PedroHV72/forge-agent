'use strict';

// forge-memory-index.js — core of the file-source → facts index.
//
// Invariants (LOCKED — T02 renders on top of this, T03 asserts against it):
//   1. Citation extraction from `fact.text` prose is HEURISTIC. Any result this module
//      produces MUST carry the report of what it could not cover — a gate that does not
//      enumerate its own coverage/discard is an inert gate (Layer-3 forge-doctor precedent).
//   2. Paths found inside `fact.text` are UNTRUSTED STRINGS. Containment is checked
//      BEFORE any disk access (existsSync/basename lookup) — never a blind realpathSync.
//   3. `counts`/`coverage` numbers are ALWAYS derived by filtering the entries/facts
//      arrays — never incremented in a parallel counter (checkSymbols contract).
//
// This file exports the plain core (citation extraction, resolution, file walk,
// summarization, index building). The markdown renderer and CLI are added in T02 —
// intentionally absent here.

const fs = require('fs');
const path = require('path');

const { listFragments, parseFragment } = require('./forge-memory');

// ── isWithin (molde de forge-prompt.js:75-78) ──────────────────────────────────
function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// ── CITATION_REGEXES ────────────────────────────────────────────────────────────
// Ordered registry — order IS precedence (first match for a given span wins).
// `name`s are LOCKED: T02 prints them, T03 asserts against them.
// Uses [ \t], never \s — do not cross newlines (MEM004 precedent). \Z does not exist in JS.
const CODE_EXT = '(?:js|mjs|cjs|ts|json|md|sh|ps1|yml|yaml)';

const CITATION_REGEXES = [
  {
    name: 'backticked-path',
    // `some/dir/file.ext` or `some/dir/file.ext:123`
    regex: new RegExp('`([\\w.\\-/]+/[\\w.\\-]+\\.' + CODE_EXT + ')(?::(\\d+))?`', 'g'),
    description: 'Caminho com barra entre crases, extensão de código/markdown, sufixo :linha opcional.',
  },
  {
    name: 'bare-path',
    // some/dir/file.ext outside backticks
    regex: new RegExp('(?<![`\\w./\\-])([\\w.\\-]+(?:/[\\w.\\-]+)+\\.' + CODE_EXT + ')(?::(\\d+))?(?![`\\w])', 'g'),
    description: 'Caminho com barra e extensão de código/markdown fora de crases.',
  },
  {
    name: 'backticked-basename',
    // `file.ext` — no slash, inside backticks
    regex: new RegExp('`([\\w.\\-]+\\.' + CODE_EXT + ')`', 'g'),
    description: 'Nome de arquivo (sem barra) só com extensão, entre crases.',
  },
  {
    name: 'bare-basename',
    // file.ext loose in prose — dominant case in this repo's real fragment
    regex: new RegExp('(?<![`\\w./\\-])([\\w\\-]+\\.' + CODE_EXT + ')(?![`\\w])', 'g'),
    description: 'Nome de arquivo solto na prosa, sem crases e sem barra.',
  },
];

// Extension test used by the token-based dynamic-candidate scan below — bounded
// per-token, never a whole-text greedy match (avoids catastrophic over-match
// across unrelated backticks elsewhere in the sentence).
const EXT_SUFFIX_RE = new RegExp('\\.' + CODE_EXT + '[)\\],.;:!?]*$');

// ── findDynamicCandidates ────────────────────────────────────────────────────
// Token-bounded scan (never a single greedy regex over the whole text) for
// candidates that embed a template-literal `${`, a wildcard `*`, or an
// INTERNAL backtick (one that is not merely the token's own wrapping pair)
// before an accepted extension. Always discarded as pattern:'dynamic' — never
// silenced; enumerated, per step 4 of T01-PLAN.
function findDynamicCandidates(text) {
  const results = [];
  const tokenRe = /\S+/g;
  let tm;
  while ((tm = tokenRe.exec(text)) !== null) {
    const token = tm[0];
    if (!EXT_SUFFIX_RE.test(token)) continue;

    const hasTemplate = token.includes('${');
    const hasWildcard = token.includes('*');

    const backtickPositions = [];
    for (let i = 0; i < token.length; i++) {
      if (token[i] === '`') backtickPositions.push(i);
    }
    // A single wrapping pair (first char + last char) is already handled by the
    // ordered backtick patterns above — only an ADDITIONAL backtick strictly
    // inside the token counts as "internal".
    const hasInternalBacktick = backtickPositions.some((p) => p !== 0 && p !== token.length - 1);

    if (hasTemplate || hasWildcard || hasInternalBacktick) {
      results.push({ raw: token, path: token, line: null, pattern: 'dynamic', index: tm.index });
    }
  }
  return results;
}

// ── extractCitations ─────────────────────────────────────────────────────────
// Extracts file citations from free-prose fact.text.
// Returns Array<{ raw, path, line, pattern }>, deduplicated by path
// (first occurrence wins, including its line), preserving order of appearance.
//
// Candidates containing `${`, an internal backtick, or `*` are discarded as
// "dynamic" citations — the caller keeps them enumerable via resolveCitation
// returning UNRESOLVED/dynamic, rather than silently dropping them.
function extractCitations(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const found = []; // { raw, path, line, pattern, index }
  for (const { name, regex } of CITATION_REGEXES) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const raw = m[0];
      const rawPath = m[1];
      const line = m[2] ? parseInt(m[2], 10) : null;

      found.push({
        raw,
        path: rawPath,
        line,
        pattern: name,
        index: m.index,
      });

      // Guard against zero-width infinite loop (should not happen with these patterns).
      if (regex.lastIndex === m.index) regex.lastIndex++;
    }
  }

  // Dynamic candidates (${, *, internal backtick) — bounded per-token scan.
  found.push(...findDynamicCandidates(text));

  // Preserve order of appearance across all patterns combined.
  found.sort((a, b) => a.index - b.index);

  // Dedup by path — first occurrence wins (keeps its line).
  const seen = new Map();
  const ordered = [];
  for (const c of found) {
    if (seen.has(c.path)) continue;
    seen.set(c.path, true);
    ordered.push({ raw: c.raw, path: c.path, line: c.line, pattern: c.pattern });
  }

  return ordered;
}

// ── listRepoFiles ────────────────────────────────────────────────────────────
// Single bounded walk of the repository. Skips .git, node_modules, dist, build,
// .next, .forge-worktrees. Returns paths normalized with '/' for stable output
// across Windows and POSIX. Caps at opts.limit (default 20000) files — the cap
// itself is a reported fact in coverage, never a silent truncation.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.forge-worktrees']);

function listRepoFiles(root, opts) {
  opts = opts || {};
  const limit = typeof opts.limit === 'number' ? opts.limit : 20000;

  const files = [];
  const byBasename = new Map();
  let capped = false;

  const stack = [root];
  while (stack.length > 0) {
    if (capped) break;
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (capped) break;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      if (files.length >= limit) {
        capped = true;
        break;
      }

      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      files.push(rel);

      const basename = entry.name;
      if (!byBasename.has(basename)) byBasename.set(basename, []);
      byBasename.get(basename).push(rel);
    }
  }

  return { files, byBasename, capped };
}

// ── resolveCitation ──────────────────────────────────────────────────────────
// Non-binary resolution. NEVER throws (total try/catch).
// Order: dynamic → containment (outside-root, BEFORE any existsSync) →
//        exact disk match → basename match (1 candidate = RESOLVED, ≥2 = ambiguous) →
//        not-found.
function resolveCitation(citation, cwd, index) {
  try {
    if (!citation || typeof citation.path !== 'string' || citation.path.length === 0) {
      return { state: 'UNRESOLVED', reason: 'not-found' };
    }

    if (citation.pattern === 'dynamic') {
      return { state: 'UNRESOLVED', reason: 'dynamic' };
    }

    const root = path.resolve(cwd);
    const candidatePath = citation.path;

    // Absolute path or path escaping the root → outside-root, before any disk access.
    if (path.isAbsolute(candidatePath)) {
      return { state: 'UNRESOLVED', reason: 'outside-root' };
    }
    const resolved = path.resolve(root, candidatePath);
    if (!isWithin(root, resolved)) {
      return { state: 'UNRESOLVED', reason: 'outside-root' };
    }

    // Exact match against the disk (relative to root).
    const relNormalized = path.relative(root, resolved).split(path.sep).join('/');
    let existsExact = false;
    try {
      existsExact = fs.existsSync(resolved) && fs.statSync(resolved).isFile();
    } catch (_) {
      existsExact = false;
    }
    if (existsExact) {
      return { state: 'RESOLVED', file: relNormalized, how: 'path' };
    }

    // Basename match, only meaningful for bare-basename / backticked-basename patterns
    // (candidatePath without a slash) but harmless to try generally.
    const basename = path.basename(candidatePath);
    const byBasename = index && index.byBasename;
    const candidates = byBasename ? byBasename.get(basename) : null;

    if (candidates && candidates.length === 1) {
      return { state: 'RESOLVED', file: candidates[0], how: 'basename' };
    }
    if (candidates && candidates.length >= 2) {
      return { state: 'UNRESOLVED', reason: 'ambiguous-basename', candidates: candidates.slice() };
    }

    return { state: 'UNRESOLVED', reason: 'not-found' };
  } catch (_) {
    return { state: 'UNRESOLVED', reason: 'not-found' };
  }
}

// ── summarizeFact ─────────────────────────────────────────────────────────────
// First sentence of fact.text, normalized (collapse line breaks/whitespace),
// truncated at opts.maxChars (default 160) with an ellipsis. Deterministic, no
// wallclock.
function summarizeFact(fact, opts) {
  opts = opts || {};
  const maxChars = typeof opts.maxChars === 'number' ? opts.maxChars : 160;

  const text = (fact && typeof fact.text === 'string') ? fact.text : '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '';

  // First sentence: up to first '. ' (followed by space/end) or full string if none.
  const sentenceMatch = collapsed.match(/^(.+?[.!?])(?:\s|$)/);
  let sentence = sentenceMatch ? sentenceMatch[1] : collapsed;

  if (sentence.length > maxChars) {
    sentence = sentence.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
  }

  return sentence;
}

// ── buildFileIndex ────────────────────────────────────────────────────────────
// Orchestrator: reads all memory fragments via listFragments/parseFragment,
// extracts + resolves citations per fact, and aggregates entries by resolved
// file plus a coverage block whose numbers are always derived by filtering the
// same lists that produced entries — never a parallel counter.
function buildFileIndex(cwd, opts) {
  opts = opts || {};
  const root = path.resolve(cwd);

  const fileIndex = listRepoFiles(root, opts.listRepoFiles || {});

  const unreadableFragments = [];
  const allFacts = []; // { fact, fragment }

  let fragments;
  try {
    fragments = listFragments(cwd, opts.listFragments || {});
  } catch (_) {
    fragments = [];
  }

  for (const fragment of fragments) {
    let parsed;
    try {
      const text = fs.readFileSync(fragment.path, 'utf8');
      parsed = parseFragment(text);
    } catch (e) {
      unreadableFragments.push({
        storageKey: fragment.storageKey,
        path: fragment.path,
        reason: (e && e.message) ? e.message : 'read-error',
      });
      continue;
    }

    const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    for (const fact of facts) {
      allFacts.push({ fact, fragment });
    }
  }

  // entries keyed by resolved file path.
  const entriesByFile = new Map();

  // Per-citation resolution results, kept for coverage aggregation.
  const resolvedCitations = []; // { citation, resolution }
  const factsWithoutCitation = []; // { mem_id, storage_key }
  const factsUnresolvedOnly = []; // { mem_id, storage_key }

  for (const { fact, fragment } of allFacts) {
    const memId = fact && fact.mem_id ? fact.mem_id : null;
    const storageKey = fragment.storageKey;

    const citations = extractCitations(fact && fact.text);

    if (citations.length === 0) {
      factsWithoutCitation.push({ mem_id: memId, storage_key: storageKey });
      continue;
    }

    let anyResolved = false;

    for (const citation of citations) {
      const resolution = resolveCitation(citation, cwd, fileIndex);
      resolvedCitations.push({ citation, resolution });

      if (resolution.state === 'RESOLVED') {
        anyResolved = true;
        const file = resolution.file;
        if (!entriesByFile.has(file)) {
          entriesByFile.set(file, { file, facts: [] });
        }
        entriesByFile.get(file).facts.push({
          mem_id: memId,
          category: fact && fact.category ? fact.category : null,
          summary: summarizeFact(fact, opts.summarize || {}),
          source_unit: fact && fact.source_unit ? fact.source_unit : null,
          unit_id: fragment.unitId,
          storage_key: storageKey,
          line: citation.line,
        });
      }
    }

    if (!anyResolved) {
      factsUnresolvedOnly.push({ mem_id: memId, storage_key: storageKey });
    }
  }

  // entries ordered by file (localeCompare('en')); facts ordered by storage_key then mem_id.
  const entries = [...entriesByFile.values()]
    .sort((a, b) => a.file.localeCompare(b.file, 'en'))
    .map((entry) => ({
      file: entry.file,
      facts: entry.facts.slice().sort((a, b) => {
        const sk = String(a.storage_key).localeCompare(String(b.storage_key), 'en');
        if (sk !== 0) return sk;
        return String(a.mem_id).localeCompare(String(b.mem_id), 'en');
      }),
    }));

  // unresolved — aggregated by raw+reason → { raw, reason, count, example_mem_id, candidates? },
  // ordered by count desc then raw.
  const unresolvedMap = new Map(); // key: raw|reason
  for (const { citation, resolution } of resolvedCitations) {
    if (resolution.state !== 'UNRESOLVED') continue;
    const key = `${citation.raw} ${resolution.reason}`;
    if (!unresolvedMap.has(key)) {
      unresolvedMap.set(key, {
        raw: citation.raw,
        reason: resolution.reason,
        count: 0,
        example_mem_id: null,
        candidates: resolution.candidates,
      });
    }
    const agg = unresolvedMap.get(key);
    agg.count += 1;
  }
  // Attach an example_mem_id per aggregate (first occurrence).
  for (const { citation, resolution } of resolvedCitations) {
    if (resolution.state !== 'UNRESOLVED') continue;
    const key = `${citation.raw} ${resolution.reason}`;
    const agg = unresolvedMap.get(key);
    if (agg && agg.example_mem_id === null) {
      // Find owning fact for this citation among allFacts — best effort, first match.
      for (const { fact } of allFacts) {
        const memId = fact && fact.mem_id ? fact.mem_id : null;
        const citations = extractCitations(fact && fact.text);
        if (citations.some((c) => c.raw === citation.raw)) {
          agg.example_mem_id = memId;
          break;
        }
      }
    }
  }

  const unresolved = [...unresolvedMap.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return String(a.raw).localeCompare(String(b.raw), 'en');
  });

  const citationsTotal = resolvedCitations.length;
  const citationsResolved = resolvedCitations.filter((r) => r.resolution.state === 'RESOLVED').length;

  const coverage = {
    fragments_read: fragments.length - unreadableFragments.length,
    facts_total: allFacts.length,
    facts_with_resolved: allFacts.length - factsWithoutCitation.length - factsUnresolvedOnly.length,
    facts_unresolved_only: factsUnresolvedOnly,
    facts_without_citation: factsWithoutCitation,
    files_indexed: entries.length,
    citations_total: citationsTotal,
    citations_resolved: citationsResolved,
    unresolved,
    unreadable_fragments: unreadableFragments,
    scan_capped: fileIndex.capped,
  };

  return { entries, coverage };
}

module.exports = {
  CITATION_REGEXES,
  extractCitations,
  resolveCitation,
  listRepoFiles,
  summarizeFact,
  buildFileIndex,
};
