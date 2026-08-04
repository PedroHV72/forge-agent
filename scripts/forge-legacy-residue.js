#!/usr/bin/env node
// forge-legacy-residue.js — read-only detector for legacy accretion residue.
//
// WHAT THIS IS
// ------------
// `forge-memory-migrate.js:433` writes a whole multi-source list, comma-joined,
// into a single `source_unit` field.  The deterministic signature for that
// residue (D9) is therefore: **a comma inside the `source_unit` VALUE**.
//
// This module answers one question, per fact, with evidence attached:
//   does the declared signature match this fact, and is it really residue?
//
// WHAT THIS IS NOT
// ----------------
// It is not a cleaner.  There is no mutation path in this file — no
// `child_process`, no `fs` at all (not even a require), no `svn`, no `git`.
// The only write the module performs is to `process.stdout` from the CLI.
// The reason `fs` is absent rather than merely unused: an absent require is
// checkable by grep, an unused one is a promise.
//
// WHY THE VALUE AND NOT THE LINE
// ------------------------------
// A line-level grep over a memory store (`grep '"source_unit"' | grep ','`)
// matches every JSON end-of-line comma — the delimiter, not the data.  Those
// are all false positives, and false positives are exactly what this detector
// exists to refuse.  Precision over recall (D9): a missed fact leaves residue
// behind, which is the status quo; a wrong match corrupts a good fact.
// Consequently the signature is applied to `String(fact.source_unit)` and to
// nothing else.  No regex is built from scanned input, so no escaping is
// needed; if that ever changes, escape before `new RegExp()` the way
// `forge-symbol-check.js:195` does.
//
// EXIT CONTRACT
// -------------
//   0 — the scan completed.  This includes a FAIL, NO-TARGET or ERROR verdict:
//       a gate that reports "no targets" — or "I could not read the store" —
//       has succeeded at its job of reporting.  The verdict lives in the JSON
//       and in the report text, never in the exit code.
//   1 — runtime error
//   2 — invalid arguments
//
// Usage:
//   node scripts/forge-legacy-residue.js --cwd <path> [--json]

'use strict';

const path = require('path');

const {
  listFragments,
  readFragmentText,
  parseFragment,
} = require('./forge-memory.js');

// ── Verdicts ──────────────────────────────────────────────────────────────────
// Exactly three, and they are exhaustive: `classifyFact` has no path that
// returns anything else, so no evaluated fact can leave the enumeration
// without a verdict of its own.
const VERDICT_RESIDUE = 'residuo-legado';
const VERDICT_SINGLE = 'intocado — fonte única';
const VERDICT_NO_SIGNATURE = 'intocado — sem assinatura';

const VERDICTS = [VERDICT_RESIDUE, VERDICT_SINGLE, VERDICT_NO_SIGNATURE];

// The signature separator, as written by the migration.
const SOURCE_SEPARATOR = ',';

// ── sourceUnitValue ───────────────────────────────────────────────────────────
// The value under audit, normalised to a string.  A missing `source_unit` is an
// empty string, never `undefined` — the caller must be able to print it.
function sourceUnitValue(fact) {
  if (!fact || fact.source_unit === undefined || fact.source_unit === null) return '';
  if (Array.isArray(fact.source_unit)) return fact.source_unit.join(SOURCE_SEPARATOR);
  return String(fact.source_unit);
}

// ── splitSources ──────────────────────────────────────────────────────────────
// Derives the source list from the value.  Empty segments are dropped so that a
// trailing separator (`"a,"`) yields one source and is caught as a false
// positive rather than silently counted as two.
function splitSources(value) {
  return String(value)
    .split(SOURCE_SEPARATOR)
    .map(part => part.trim())
    .filter(part => part !== '');
}

// ── hasSignature ──────────────────────────────────────────────────────────────
// The whole of D9, in one line, applied to the VALUE.
function hasSignature(value) {
  return String(value).indexOf(SOURCE_SEPARATOR) !== -1;
}

// ── classifyFact ──────────────────────────────────────────────────────────────
// Returns { verdict, sourceUnit, sources, sourceCount }.
// Total function: every input lands on one of the three verdicts.
function classifyFact(fact) {
  const sourceUnit = sourceUnitValue(fact);
  const sources = splitSources(sourceUnit);
  const sourceCount = sources.length;

  let verdict;
  if (hasSignature(sourceUnit)) {
    verdict = VERDICT_RESIDUE;
  } else if (sourceCount === 1) {
    verdict = VERDICT_SINGLE;
  } else {
    // No separator and nothing parseable: no attribution to audit at all.
    verdict = VERDICT_NO_SIGNATURE;
  }

  return { verdict, sourceUnit, sources, sourceCount };
}

// ── scanStore ─────────────────────────────────────────────────────────────────
// Enumerates every fact the real store reader returns for `cwd`.
//
// The population comes from `listFragments`/`readFragmentText`/`parseFragment`
// — the same reader the rest of the system uses — and never from a private glob
// over `.gsd/memory/`.  A private glob would measure a different universe than
// the one the system reads, which is how a gate ends up shouting in the wrong
// place and staying quiet in the right one.
//
// Degradation is per fragment: an unreadable fragment is counted AND named in
// `population.fragments_unreadable`, then skipped.  It never aborts the sweep
// and it never disappears quietly — "did not match" must stay distinguishable
// from "was never looked at".
//
// `opts.readText` exists solely so the degradation contract can be exercised:
// on this platform there is no cheap way to make a listed fragment genuinely
// unreadable, and a degradation path that is never executed is a comment, not
// behaviour.  It defaults to the real `readFragmentText` and the CLI never
// passes it.
function scanStore(cwd, opts) {
  const options = opts || {};
  const readText = options.readText || readFragmentText;
  const root = path.resolve(cwd || process.cwd());

  const items = [];
  const unreadable = [];
  const counts = { matched: 0, single_source: 0, no_signature: 0 };

  let fragments = [];
  try {
    fragments = listFragments(root, options.memoryOpts);
  } catch (error) {
    // The store itself is unreachable.  Report a zero population explicitly
    // rather than an empty one that looks like a clean store.
    return {
      cwd: root,
      population: { fragments: 0, facts: 0, fragments_unreadable: [], store_error: error.message },
      items: [],
      counts,
      false_positives: [],
    };
  }

  for (const entry of fragments) {
    let parsed;
    try {
      parsed = parseFragment(readText(root, entry));
    } catch (error) {
      unreadable.push({ storageKey: entry.storageKey, path: entry.path, reason: error.message });
      process.stderr.write(`[forge-legacy-residue] warn: ${entry.storageKey}: ${error.message}\n`);
      continue;
    }

    const facts = Array.isArray(parsed && parsed.facts) ? parsed.facts : [];
    for (const fact of facts) {
      const verdictInfo = classifyFact(fact);
      items.push({
        fragment: entry.storageKey,
        fragment_path: entry.path,
        grouped: Boolean(entry.grouped),
        mem_id: fact && fact.mem_id ? String(fact.mem_id) : null,
        source_unit: verdictInfo.sourceUnit,
        sources: verdictInfo.sources,
        sourceCount: verdictInfo.sourceCount,
        verdict: verdictInfo.verdict,
      });

      if (verdictInfo.verdict === VERDICT_RESIDUE) counts.matched++;
      else if (verdictInfo.verdict === VERDICT_SINGLE) counts.single_source++;
      else counts.no_signature++;
    }
  }

  // A matched item that carries fewer than two sources is, by definition, not
  // multi-source residue.  By construction this list should be empty; when it
  // is not, it IS the proof that the signature matches what it must not.
  const falsePositives = items.filter(
    item => item.verdict === VERDICT_RESIDUE && item.sourceCount < 2
  );

  return {
    cwd: root,
    population: {
      fragments: fragments.length,
      facts: items.length,
      fragments_unreadable: unreadable,
    },
    items,
    counts,
    false_positives: falsePositives,
  };
}

// ── verdictOf ─────────────────────────────────────────────────────────────────
// The slice-level rule, fixed by S04-PLAN and not decided here:
//   store unreadable             → ERROR
//   any false positive           → FAIL
//   zero matches                 → NO-TARGET
//   ≥1 match, zero false pos.    → PASS
//
// ERROR exists because a scanner that could not read the store has measured
// nothing, and "measured nothing" must never be spelled the same way as
// "measured a clean store".  Consumers of this verdict (the `## Veredicto`
// block that T02/T03 read at step zero) proceed only on PASS, so a fourth
// non-PASS value is safe by construction — it stops them, as it must.
function verdictOf(scan) {
  if (scan.population && scan.population.store_error) return 'ERROR';
  if (scan.false_positives.length > 0) return 'FAIL';
  if (scan.counts.matched === 0) return 'NO-TARGET';
  return 'PASS';
}

// ── formatReport ──────────────────────────────────────────────────────────────
// Human-readable enumeration.  Matched items are printed one per line with the
// evidence needed to adjudicate them by hand; non-matched are summarised by
// count per verdict, because the aggregate is never allowed to exist without
// the population that produced it.
function formatReport(scan) {
  const lines = [];
  lines.push(`store: ${scan.cwd}`);
  // Printed FIRST and unconditionally when present: the human output of an
  // unreadable store must not be readable as the output of a clean one.
  if (scan.population && scan.population.store_error) {
    lines.push(`store_error: ${scan.population.store_error}`);
  }
  lines.push(
    `population: ${scan.population.fragments} fragments returned, ` +
    `${scan.population.facts} facts evaluated, ` +
    `${scan.population.fragments_unreadable.length} unreadable`
  );
  for (const bad of scan.population.fragments_unreadable) {
    lines.push(`  unreadable: ${bad.storageKey} — ${bad.reason}`);
  }
  lines.push('');
  lines.push(`matched (${VERDICT_RESIDUE}): ${scan.counts.matched}`);
  for (const item of scan.items) {
    if (item.verdict !== VERDICT_RESIDUE) continue;
    lines.push(
      `  - ${item.fragment} / ${item.mem_id || '<no mem_id>'} ` +
      `source_unit="${item.source_unit}" sources=${item.sourceCount}`
    );
  }
  lines.push(`untouched (${VERDICT_SINGLE}): ${scan.counts.single_source}`);
  lines.push(`untouched (${VERDICT_NO_SIGNATURE}): ${scan.counts.no_signature}`);
  lines.push(`false positives: ${scan.false_positives.length}`);
  for (const item of scan.false_positives) {
    lines.push(
      `  ! ${item.fragment} / ${item.mem_id || '<no mem_id>'} ` +
      `source_unit="${item.source_unit}" sources=${item.sourceCount}`
    );
  }
  lines.push('');
  lines.push(`verdict: ${verdictOf(scan)}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { cwd: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') {
      args.cwd = argv[++i];
      if (!args.cwd) throw new Error('--cwd requires a path');
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

const USAGE = 'usage: node scripts/forge-legacy-residue.js --cwd <path> [--json]';

module.exports = {
  scanStore,
  classifyFact,
  verdictOf,
  formatReport,
  VERDICT_RESIDUE,
  VERDICT_SINGLE,
  VERDICT_NO_SIGNATURE,
  VERDICTS,
  _private: { sourceUnitValue, splitSources, hasSignature, parseArgs },
};

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  try {
    const scan = scanStore(args.cwd);
    const payload = args.json
      ? JSON.stringify(Object.assign({ verdict: verdictOf(scan) }, scan), null, 2)
      : formatReport(scan);
    process.stdout.write(`${payload}\n`);
    // FAIL, NO-TARGET and ERROR are all successful gate RUNS — exit 0 either
    // way; the verdict, not the exit code, is what a consumer reads.
    process.exit(0);
  } catch (error) {
    process.stderr.write(`[forge-legacy-residue] error: ${error.message}\n`);
    process.exit(1);
  }
}
