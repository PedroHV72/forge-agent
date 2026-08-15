#!/usr/bin/env node
// forge-write-claim — record/read/clear the write claim a run declares on its
// RunRecord: what it is about to write, plus the CODE_DIR it is writing from.
//
// ── Where the signal lives ──────────────────────────────────────────────────
//
// An ADDITIVE `write_claim` field on the `RunRecord`, written via
// `runs.update`. Nothing migrates: a record written before this field existed
// stays byte-identical on disk until `recordClaim` gives it a real reason to
// change. This mirrors `withAddressDefaults` (forge-runs.js) and
// `forge-touch.js` exactly, down to the one property that matters: `null`
// (never claimed) and `{ paths: [] }` (claimed, honestly empty) are DIFFERENT
// facts and must never collapse. A caller (T02) that treats them alike
// reports "nothing declared" when the honest answer is "declared and empty" —
// or vice versa — the same anti-silence defect S07/T01 already closed once.
//
// ── code_dir is a GIVEN fact, never derived ─────────────────────────────────
//
// Same precedent as `runs.add()`: "records what it is GIVEN and derives
// nothing". Deriving `code_dir` from root/branch/isolation_mode would repeat
// the defect S06 already named — a derived string names a directory that may
// not exist. Absent `--code-dir` -> `code_dir: null`, never a guess.
//
// ── Composition, not reimplementation ───────────────────────────────────────
//
//   persistence        forge-runs.get / forge-runs.update
//   path normalization forge-parallelism.normalizePath
//
// A second implementation of path normalization here would be the defect
// this module's own Standards section forbids.
//
// ── Posture ──────────────────────────────────────────────────────────────
//
// This module is a PRIMITIVE. Coupling the claim's release to a commit (git
// or svn) and any TTL are out of scope here (IN-6/S05) — `clearClaim` exists
// so tests and CLI callers can reset state, nothing more.
//
// CLI:
//   node forge-write-claim.js --claim <run-id> --unit <u> [--source <s>]
//                              [--code-dir <p>] [--paths <csv|json>] [--json] [--cwd <dir>]
//   node forge-write-claim.js --show  <run-id> [--json] [--cwd <dir>]
//   node forge-write-claim.js --clear <run-id> [--json] [--cwd <dir>]

'use strict';

const runs = require('./forge-runs.js');
const { normalizePath } = require('./forge-parallelism.js');

// Closed set. `plan-writes` = came from a T##-PLAN.md `writes:`/`expected_output:`
// block. `review-fix-paths` = came from the `path:line` of conceded review
// items (D7, consumed in S04). `manual` = operator/CLI. A source outside this
// set must never be recorded — see `normalizeClaim` below.
const CLAIM_SOURCES = ['plan-writes', 'review-fix-paths', 'manual'];

/**
 * Pure — no disk. Validates and shapes a claim input into the persisted form
 * `{ at, unit, source, code_dir, paths: [] }`.
 *
 * `unit` is carried verbatim (the "worker" grammar has THREE forms —
 * "UNIT_TYPE/UNIT_ID", null, "BATCH:<csv>" — and parsing it here would repeat
 * the defect already measured in forge-hook.js:169). `source` must belong to
 * `CLAIM_SOURCES`; anything else throws, naming both the rejected value and
 * the closed set, and nothing is written. `code_dir` is the GIVEN value —
 * absent means `null`, never derived. `paths` are normalized via the
 * imported `normalizePath` (never reimplemented), empty entries dropped,
 * order preserved.
 */
function normalizeClaim(input) {
  const opts = input || {};
  if (!CLAIM_SOURCES.includes(opts.source)) {
    throw new Error(
      `forge-write-claim: unknown source ${JSON.stringify(opts.source)} — ` +
      `must be one of ${JSON.stringify(CLAIM_SOURCES)}`);
  }
  // `code_dir` is GIVEN, never derived — but "given" is not "anything". A
  // non-string value used to be persisted verbatim (only `source` was
  // checked), and downstream `path.isAbsolute` then threw
  // ERR_INVALID_ARG_TYPE inside the comparator, where the CLI's global catch
  // turned it into exit 0 with NO verdict and NO census: one malformed record
  // silenced the comparison of every run. Validated here, at the only place
  // that writes; the read side classifies a legacy malformed value as
  // `code-dir-invalid` rather than trusting this gate retroactively.
  if (!(opts.code_dir === undefined || opts.code_dir === null || opts.code_dir === ''
        || typeof opts.code_dir === 'string')) {
    throw new Error(
      `forge-write-claim: invalid code_dir ${JSON.stringify(opts.code_dir)} ` +
      `(${typeof opts.code_dir}) — must be a non-empty string or null`);
  }
  const paths = Array.isArray(opts.paths)
    ? opts.paths.map(normalizePath).filter((p) => p !== '')
    : [];
  return {
    at: opts.at || Date.now(),
    unit: opts.unit || null,
    source: opts.source,
    // GIVEN, never derived. See module header.
    code_dir: (opts.code_dir === undefined || opts.code_dir === null || opts.code_dir === '')
      ? null : opts.code_dir,
    paths,
  };
}

/** Derive AND persist — the ONLY function in this module that writes. */
function recordClaim(cwd, runId, input) {
  const write_claim = normalizeClaim(input);
  runs.update(cwd, runId, { write_claim });
  return write_claim;
}

/**
 * `null` for a run that was never claimed, the recorded object otherwise —
 * INCLUDING when that object says `paths: []`-shaped emptiness. The two must
 * never collapse: `null` means "nobody claimed on this run yet"; a present
 * object means "claimed, and here is the honest — possibly empty — answer".
 * Do not "simplify" this to `rec.write_claim || null` — an object with
 * `paths: []` is truthy, so `||` already behaves correctly here today, but
 * the explicit form is kept so intent survives a future shape change (same
 * reasoning as forge-touch.js::readTouched).
 */
function readClaim(rec) {
  return rec && rec.write_claim ? rec.write_claim : null;
}

/**
 * Grava `write_claim: null` — a PRIMITIVE reset, not a release protocol. The
 * coupling to a commit (git/svn) and any TTL are IN-6/S05 and do NOT belong
 * here; this function exists only so tests and CLI callers can return a run
 * to its unclaimed state.
 */
function clearClaim(cwd, runId) {
  runs.update(cwd, runId, { write_claim: null });
  return null;
}

// ── CLI ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

function parsePathsArg(raw) {
  if (raw === undefined || raw === true) return [];
  const s = String(raw).trim();
  if (s === '') return [];
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) { /* fall through to CSV */ }
  }
  return s.split(',').map((p) => p.trim()).filter((p) => p !== '');
}

const USAGE = `forge-write-claim — record/read/clear the write claim on a run's RunRecord

Flags:
  --claim <run-id> --unit <u> [--source <s>] [--code-dir <p>] [--paths <csv|json>]
                       record a write claim for the run (source default: manual)
  --show <run-id>      print the run's currently recorded claim
  --clear <run-id>     reset the run's claim to null
  --json               emit JSON instead of the human-readable form
  --cwd <path>         where to look for the run registry (default: process.cwd())
  --help               this text

recordClaim is the only function that writes. Exit code 0 on success.
`;

function formatClaim(claim) {
  if (!claim) return '(sem claim)';
  const lines = [
    `at=${new Date(claim.at).toISOString()} unit=${claim.unit || '(?)'} source=${claim.source}`,
    `code_dir=${claim.code_dir === null ? '(desconhecido)' : claim.code_dir}`,
    `paths=${claim.paths.length === 0 ? '(vazio)' : claim.paths.join(', ')}`,
  ];
  return lines.join('\n');
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (!args.claim && !args.show && !args.clear)) {
    process.stdout.write(USAGE);
    return 0;
  }
  const cwd = typeof args.cwd === 'string' ? args.cwd : process.cwd();

  try {
    if (typeof args.claim === 'string') {
      const claim = recordClaim(cwd, args.claim, {
        unit: typeof args.unit === 'string' ? args.unit : null,
        source: typeof args.source === 'string' ? args.source : 'manual',
        code_dir: typeof args['code-dir'] === 'string' ? args['code-dir'] : undefined,
        paths: parsePathsArg(args.paths),
      });
      process.stdout.write(args.json ? `${JSON.stringify(claim, null, 2)}\n` : `${formatClaim(claim)}\n`);
      return 0;
    }
    if (typeof args.show === 'string') {
      const rec = runs.get(cwd, args.show);
      const claim = readClaim(rec);
      process.stdout.write(args.json ? `${JSON.stringify(claim, null, 2)}\n` : `${formatClaim(claim)}\n`);
      return 0;
    }
    if (typeof args.clear === 'string') {
      clearClaim(cwd, args.clear);
      process.stdout.write(args.json ? `${JSON.stringify(null)}\n` : '(claim limpo)\n');
      return 0;
    }
  } catch (e) {
    process.stderr.write(`forge-write-claim: ${e.message}\n`);
    return 1;
  }

  process.stdout.write(USAGE);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  normalizeClaim,
  recordClaim,
  readClaim,
  clearClaim,
  CLAIM_SOURCES,
  parseArgs,
  main,
  USAGE,
};
