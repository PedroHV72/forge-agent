#!/usr/bin/env node
// forge-evidence-path.js — single owner of the evidence-log FILE NAME shape.
//
// Builds the composite key `milestone|slice|unit` into a NEW file name,
// parses it back (plus the 4 legacy forms already living in .gsd/forge/),
// resolves the union of files for one logical unit, and produces a
// reconciling census. No consumer (hook, materializer, dashboard,
// statusline, completer, executor) is touched by this module — this is the
// naming authority only (S01 T01, S01-PLAN.md).
//
// ── Measured baseline (S01-RESEARCH.md, executed against .gsd/forge/ live) ──
//   47 evidence-*.jsonl files today, reconciling as:
//     milestone-qualified 34  (adhoc 8, S## 9 [AMBIGUOUS under a slice-token
//       anchor — these are unit=S## dispatches, not slice=S##], comma 3
//       [mutilated BATCH: form], milestone-id 3, T## 11)
//     slice-qualified (S##-T##)  5
//     bare                        8
//   8 + 5 + 34 === 47, unmatched = 0 under the known-ids set.
//   A form-regex classifier got 31/34 wrong on the same input (control
//   negative, S01-RESEARCH.md "Controle negativo medido"). This module
//   resolves the milestone axis against the SET OF KNOWN IDS by longest
//   prefix — never by anchoring on a slice-shaped token — because `-` is
//   both the structural separator AND a legal character inside every axis
//   (delimiter collision, Pitfall 1).
//
// New composite names use a reserved delimiter (`~`) that the axis
// sanitizer cannot ever emit (it is outside the `[A-Za-z0-9._-]` class, so
// it always collapses to `_` if present in a value) — this makes the new
// form decidable BY CONSTRUCTION, with no ambiguity to resolve at all.
// Legacy forms (bare / slice-qualified / milestone-qualified with `-`) are
// still read forever (ROADMAP § Notes (f)) via the known-ids resolution.
//
// Zero-dependency CommonJS: only `fs` and `path`.

'use strict';

const fs = require('fs');
const path = require('path');

// ── Closed, exported vocabulary ─────────────────────────────────────────────
const EVIDENCE_FORMS = Object.freeze([
  'composite',
  'milestone-qualified',
  'slice-qualified',
  'bare',
  'unrecognized',
]);

// Reserved axis delimiter for the NEW composite form. Verified (S01-RESEARCH
// Pitfall 1): 0 occurrences across the 47 live evidence file names, and it
// falls outside the sanitizer's allowed class so a value can never smuggle
// it in.
const AXIS_DELIM = '~';

// Named sentinels — never a bare literal spread across call sites. An empty
// milestone/slice axis resolves to one of these tokens, so `evidence--T01`
// (an empty axis silently reading as "nothing here") can never happen.
const SENTINEL_NO_MILESTONE = '_no-milestone_';
const SENTINEL_NO_SLICE = '_no-slice_';

// Whole-name cap (Pitfall 7): the per-axis sanitizer already caps each axis,
// but three near-max axes plus delimiters can still exceed Windows path
// budgets once joined with a long worktree CODE_DIR. Cap the ASSEMBLED name,
// not each axis in isolation.
const MAX_AXIS_LEN = 60;
const MAX_NAME_LEN = 200;

// ── Axis sanitization ────────────────────────────────────────────────────────
// Molded on forge-evidence-materialize.js:94-106 (evidenceFileName) — the
// more complete of the two existing sanitizers (forge-hook.js:113
// sanitizeRunId is the weaker variant that lets the comma-in-unit form
// through when applied to the wrong axis). Devolves a NAME fragment, never a
// path: the disallowed-char class strips `/`, `\`, and any traversal
// structure before `..`-collapse even runs.
function sanitizeAxis(value) {
  const flat = String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_AXIS_LEN);
  return flat || 'unknown';
}

// Deterministic, talking truncation for the assembled name: trims the
// CURRENTLY-longest axis by one char per iteration and appends a short
// decimal fingerprint (sum of char codes mod 1296, base36) once truncation
// actually happens — so two distinct long values that would otherwise
// truncate to the same prefix keep differing, and the presence of the `+NN`
// suffix itself signals "this axis was cut", never a silent collision.
function fingerprint(value) {
  let sum = 0;
  for (let i = 0; i < value.length; i++) sum = (sum + value.charCodeAt(i) * (i + 1)) % 1296;
  return sum.toString(36);
}

function capAssembledName(prefix, axes, suffix) {
  const parts = axes.slice();
  const assemble = () => `${prefix}${AXIS_DELIM}${parts.join(AXIS_DELIM)}${suffix}`;
  let name = assemble();
  if (name.length <= MAX_NAME_LEN) return name;
  const truncatedFlags = parts.map(() => false);
  while (assemble().length > MAX_NAME_LEN) {
    let longestIdx = 0;
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].length > parts[longestIdx].length) longestIdx = i;
    }
    if (parts[longestIdx].length <= 4) break; // nothing sane left to cut
    if (!truncatedFlags[longestIdx]) {
      const mark = `+${fingerprint(parts[longestIdx])}`;
      parts[longestIdx] = parts[longestIdx].slice(0, Math.max(1, parts[longestIdx].length - mark.length)) + mark;
      truncatedFlags[longestIdx] = true;
    } else {
      parts[longestIdx] = parts[longestIdx].slice(0, -1);
    }
  }
  return assemble();
}

// ── buildEvidenceFileName ────────────────────────────────────────────────────
// { milestone, slice, unit } → evidence~<m>~<s>~<u>.jsonl (new composite form).
// A milestone/slice axis that is absent resolves to the exported sentinel —
// never an empty string spliced into the name.
function buildEvidenceFileName(ctx) {
  const raw = ctx || {};
  const milestone = raw.milestone ? sanitizeAxis(raw.milestone) : SENTINEL_NO_MILESTONE;
  const slice = raw.slice ? sanitizeAxis(raw.slice) : SENTINEL_NO_SLICE;
  const unit = sanitizeAxis(raw.unit);
  return capAssembledName('evidence', [milestone, slice, unit], '.jsonl');
}

// ── Known-ids resolution (the fix for R1 / delimiter collision) ────────────
// Longest-prefix match against the set of ids the workspace actually knows
// about (.gsd/forge/runs/*.json ids + .gsd/milestones/ directory names) —
// never a regex over the SHAPE of the string. S01-RESEARCH.md control
// negative: shape-regex got 31/34 wrong on this exact input; the known-ids
// set got 34/34, unmatched=0.
function collectKnownMilestoneIds(cwd) {
  const ids = new Set();
  try {
    const runsDir = path.join(cwd, '.gsd', 'forge', 'runs');
    for (const f of fs.readdirSync(runsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
        if (rec && typeof rec.id === 'string' && rec.id) ids.add(rec.id);
      } catch { /* one bad run record never drops the rest */ }
    }
  } catch { /* runs/ absent or unreadable */ }
  try {
    const msDir = path.join(cwd, '.gsd', 'milestones');
    for (const name of fs.readdirSync(msDir)) ids.add(name);
  } catch { /* milestones/ absent or unreadable */ }
  return [...ids];
}

function findMilestonePrefix(rest, knownIds) {
  let best = null;
  for (const id of knownIds || []) {
    if (!id) continue;
    if (rest === id || rest.startsWith(`${id}-`)) {
      if (!best || id.length > best.length) best = id;
    }
  }
  return best;
}

// ── parseEvidenceFileName ────────────────────────────────────────────────────
// name → { form, milestone, slice, unit, name }.
//
// `form` is always one of EVIDENCE_FORMS — a name that matches nothing
// recognized comes back as 'unrecognized' with the raw name preserved.
// Never guesses.
//
// `opts.knownMilestoneIds` (array) drives the legacy milestone-qualified
// resolution. Callers that omit it get best-effort parsing of the
// unambiguous forms only (composite, slice-qualified, bare); the composite
// form never needed the ids set in the first place — it is decidable by the
// reserved delimiter alone.
function parseEvidenceFileName(name, opts) {
  const options = opts || {};
  const knownMilestoneIds = Array.isArray(options.knownMilestoneIds) ? options.knownMilestoneIds : [];
  const raw = String(name == null ? '' : name);
  const empty = { form: 'unrecognized', milestone: null, slice: null, unit: null, name: raw };

  if (!raw.startsWith('evidence') || !raw.endsWith('.jsonl') || raw.length <= 'evidence.jsonl'.length - 1) {
    return empty;
  }
  const body = raw.slice('evidence'.length, raw.length - '.jsonl'.length);
  if (body.length === 0) return empty;

  // New composite form: decidable by construction — the reserved delimiter
  // cannot appear inside a sanitized axis, so seeing it at all means this IS
  // the composite form (or it's malformed, in which case it's unrecognized,
  // never guessed as something else).
  if (body[0] === AXIS_DELIM) {
    const parts = body.slice(1).split(AXIS_DELIM);
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) return empty;
    const [m, s, u] = parts;
    return {
      form: 'composite',
      milestone: m === SENTINEL_NO_MILESTONE ? null : m,
      slice: s === SENTINEL_NO_SLICE ? null : s,
      unit: u,
      name: raw,
    };
  }

  // Legacy forms all use `-` as the (structurally ambiguous) separator.
  if (body[0] !== '-') return empty;
  const rest = body.slice(1);
  if (rest.length === 0) return empty;

  // milestone-qualified — resolved against the KNOWN-IDS SET, never a
  // slice-token anchor (S01-RESEARCH.md: 9 live evidence-<milestone>-S##
  // files would misclassify as slice-qualified under that anchor — their
  // S## is the UNIT axis, not the slice axis).
  const msPrefix = findMilestonePrefix(rest, knownMilestoneIds);
  if (msPrefix) {
    const unitPart = rest === msPrefix ? '' : rest.slice(msPrefix.length + 1);
    return { form: 'milestone-qualified', milestone: msPrefix, slice: null, unit: unitPart || null, name: raw };
  }

  // slice-qualified (legacy): evidence-S##-<unit>.jsonl, no milestone axis.
  const sliceMatch = rest.match(/^(S\d{2})-(.+)$/);
  if (sliceMatch) {
    return { form: 'slice-qualified', milestone: null, slice: sliceMatch[1], unit: sliceMatch[2], name: raw };
  }

  // bare: whatever is left, taken whole as the unit axis.
  return { form: 'bare', milestone: null, slice: null, unit: rest, name: raw };
}

// ── resolveEvidenceFiles ─────────────────────────────────────────────────────
// Union: the exact composite name PLUS every legacy form compatible with the
// same logical unit (milestone-qualified sharing milestone+unit;
// slice-qualified sharing slice+unit; bare sharing unit). Molded on
// forge-route-audit.js: strict filter first, aggregation by composite key
// after — an absent field is never a wildcard.
function resolveEvidenceFiles(cwd, ctx) {
  const target = ctx || {};
  const dir = path.join(cwd, '.gsd', 'forge');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { files: [], by_form: {}, skipped: [], dir_error: (err && err.code) || 'dir-unreadable' };
  }
  const knownMilestoneIds = collectKnownMilestoneIds(cwd);
  const files = [];
  const by_form = {};
  const skipped = [];

  for (const entry of entries) {
    if (!entry.isFile || !entry.isFile()) continue;
    if (!entry.name.startsWith('evidence') || !entry.name.endsWith('.jsonl')) continue;
    const parsed = parseEvidenceFileName(entry.name, { knownMilestoneIds });
    if (parsed.form === 'unrecognized') {
      skipped.push({ file: entry.name, reason: 'unrecognized-form' });
      continue;
    }
    let matches = false;
    if (parsed.form === 'composite') {
      matches = parsed.milestone === (target.milestone || null)
        && parsed.slice === (target.slice || null)
        && parsed.unit === target.unit;
    } else if (parsed.form === 'milestone-qualified') {
      matches = parsed.milestone === target.milestone && parsed.unit === target.unit;
    } else if (parsed.form === 'slice-qualified') {
      matches = parsed.slice === target.slice && parsed.unit === target.unit;
    } else if (parsed.form === 'bare') {
      matches = parsed.unit === target.unit;
    }
    if (matches) {
      files.push({ name: entry.name, form: parsed.form });
      by_form[parsed.form] = (by_form[parsed.form] || 0) + 1;
    }
  }
  return { files, by_form, skipped };
}

// ── censusEvidenceDir ─────────────────────────────────────────────────────────
// { files_considered, by_form, unqualified, skipped }.
// Reconciliation is the invariant this function exists to prove:
//   Σ by_form + Σ skipped === files_considered
// files_considered === 0 always carries a NAMED reason
// (empty-dir | dir-unreadable) — never a clean-looking census. A comparator
// that reports its own inactivity as good news is indistinguishable from a
// broken detector (precedent: forge-overlap.js).
function censusEvidenceDir(cwd) {
  const dir = path.join(cwd, '.gsd', 'forge');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { files_considered: 0, by_form: {}, unqualified: 0, skipped: [], reason: 'dir-unreadable' };
  }
  const evidenceEntries = entries.filter((e) => e.isFile() && e.name.startsWith('evidence') && e.name.endsWith('.jsonl'));
  if (evidenceEntries.length === 0) {
    return { files_considered: 0, by_form: {}, unqualified: 0, skipped: [], reason: 'empty-dir' };
  }

  const knownMilestoneIds = collectKnownMilestoneIds(cwd);
  const by_form = {};
  const skipped = [];
  let unqualified = 0;

  for (const entry of evidenceEntries) {
    const parsed = parseEvidenceFileName(entry.name, { knownMilestoneIds });
    if (parsed.form === 'unrecognized') {
      skipped.push({ file: entry.name, reason: 'unrecognized-form' });
      continue;
    }
    by_form[parsed.form] = (by_form[parsed.form] || 0) + 1;
    if (parsed.form === 'bare' || parsed.form === 'slice-qualified') unqualified++;
  }

  return { files_considered: evidenceEntries.length, by_form, unqualified, skipped };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// Exits: 0 success, 1 runtime error, 2 invalid args. Advisory — never asserts
// exit 1 on ordinary "found nothing" results (that is a named-reason JSON
// payload on stdout at exit 0, not a runtime failure).
function parseArgs(argv) {
  const out = { cwd: process.cwd(), json: false, mode: null, milestone: undefined, slice: undefined, unit: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--census') out.mode = 'census';
    else if (a === '--resolve') out.mode = 'resolve';
    else if (a === '--json') out.json = true;
    else if (['--cwd', '--milestone', '--slice', '--unit'].includes(a) && argv[i + 1] !== undefined) {
      out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode) {
    process.stderr.write('forge-evidence-path: use --census or --resolve [--json] [--cwd <dir>]\n');
    process.exit(2);
    return;
  }
  try {
    const cwd = path.resolve(args.cwd || process.cwd());
    let result;
    if (args.mode === 'census') {
      result = censusEvidenceDir(cwd);
    } else {
      result = resolveEvidenceFiles(cwd, { milestone: args.milestone, slice: args.slice, unit: args.unit });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
    process.exit(1);
  }
}

module.exports = {
  EVIDENCE_FORMS,
  AXIS_DELIM,
  SENTINEL_NO_MILESTONE,
  SENTINEL_NO_SLICE,
  buildEvidenceFileName,
  parseEvidenceFileName,
  resolveEvidenceFiles,
  censusEvidenceDir,
  collectKnownMilestoneIds,
  _private: { sanitizeAxis, findMilestonePrefix, capAssembledName, fingerprint },
};

if (require.main === module) cliMain();
