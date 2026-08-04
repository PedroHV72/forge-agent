#!/usr/bin/env node
// forge-overlap — advisory cross-run overlap signal, with a census and an
// anti-silence floor.
//
// ── The locked boundary (S07-PLAN.md § Fronteira travada) ──────────────────
//
// THIS MODULE SIGNALS. It does not sequence runs, it does not gate a merge,
// and it does not perform speculative integration — those three together are
// an integration pipeline, a whole product, and they are out of scope BY
// DECISION, not for lack of time. A future consumer may read this output and
// build that product; this file must never grow into it, however elegant the
// growth would look. `forge-overlap.test.js` asserts that absence in
// executable form (it scans this source, comments stripped, for that
// vocabulary) so the boundary survives a refactor that nobody re-reads this
// header during.
//
// ── The one property (S07-PLAN.md § The one property) ──────────────────────
//
// `clean` and `inconclusive` are DIFFERENT verdicts and this code may never
// confuse them. "I compared 3 pairs and none of them collided" is `clean`.
// "There was no pair to compare", "no run carried touch data", "the repo did
// not resolve to a path" is `inconclusive`. A comparator that answers `clean`
// without having compared a single pair is indistinguishable from a broken
// detector — and this milestone has already been bitten by exactly that
// failure mode three times, in escalating subtlety:
//
//   1. S06's own acceptance criterion was vacuously green (a `grep` that
//      honoured `.gitignore` and therefore scanned nothing).
//   2. The scanner that replaced it was blind to its own target wording
//      (a `\b` after `é`, which is not a word boundary the way it looks).
//   3. The widened pattern was still evadable by rewording.
//
// Hence: EVERY report carries a full census (`runs_examined`,
// `runs_with_touch_data`, `pairs_compared`, `files_compared`, `skipped[]`,
// `notes[]`), and every run or repo left out of the comparison carries a
// NAMED, ENUMERATED reason from `OVERLAP_REASONS`. A run dropped without a
// named reason is the defect, not an optimisation.
//
// ── Composition, not reimplementation ───────────────────────────────────────
//
//   run universe      forge-runs.listAll
//   touch snapshot    forge-touch.readTouched      (T01)
//
// This module NEVER shells out to git. T01 owns derivation; T02 compares the
// snapshots T01 wrote. Re-deriving here would be a second implementation of
// the same relation — the defect, per S07-PLAN.md § Standards.
//
// ── Posture ────────────────────────────────────────────────────────────────
//
// Read-only and advisory. `exit 0` ALWAYS, including when overlap is found
// (asserted by spawning the CLI, not claimed in a comment). Writes nothing:
// no `RunRecord` is mutated, which the suite proves by SHA-256 of every
// `.gsd/forge/runs/*.json` before and after a `--check`.
//
// CLI:
//   node forge-overlap.js --check [--json] [--all] [--cwd <dir>]

'use strict';

const path = require('path');

const { readTouched } = require('./forge-touch.js');
const runs = require('./forge-runs.js');

// ── Verdicts ─────────────────────────────────────────────────────────────
//
// Closed set. `computeOverlap` may return nothing outside this list, which
// the suite asserts directly — an unlisted verdict string would sail through
// every `===` comparison a caller writes and read as "not overlap", i.e. as
// silence.
const VERDICTS = ['overlap', 'clean', 'inconclusive'];

// ── Reasons ──────────────────────────────────────────────────────────────
//
// Why a run, or one repo inside a run, did not participate in the comparison.
// Each value documents exactly WHEN it is reachable, and the suite asserts
// the crossing in BOTH directions: every reason this code emits is in this
// list, and every entry in this list is emitted by at least one test. A
// one-directional check lets a dead entry rot (documented but unreachable)
// or an undocumented one leak (emitted but unnamed) — TASK-021's lesson is
// that a comment which misdescribes its own reachable cases IS the defect.
const OVERLAP_REASONS = [
  // ── run-level ──
  'no-touch-record',                 // `readTouched(rec) === null` — the run was NEVER recorded. Distinct from recorded-and-empty; collapsing the two is the silent-`clean` bug.
  'touch-record-empty-but-recorded', // recorded, every repo examined, zero files. NOT a skip: the run PARTICIPATES in the comparison and lands in `notes[]`, because "we looked and found nothing" is a real, comparable answer.
  'run-inactive',                    // `rec.active !== true` and `--all` was not given — excluded by the default activity filter, never dropped silently.
  'not-comparable-single-run',       // exactly one comparable run survived the filters, so `n*(n-1)/2 === 0` pairs exist. This is the named reason behind the `inconclusive` floor.
  'no-comparable-repo',              // recorded, but EVERY repo in the snapshot was skipped — nothing about this run's work is known. Distinct from `touch-record-empty-but-recorded`, where repos WERE examined and honestly held nothing.
  // ── repo-level (carried over from the T01 snapshot; see forge-touch.TOUCH_REASONS) ──
  'repo-path-unresolved',            // T01 could not resolve a path for this repo. Kept VISIBLE here on purpose: the known `discoverRepos` one-level-deep limit (item I-20260803060030) must shrink the comparison in plain sight, not in silence.
  'repo-not-git',                    // path resolved, but it is not a git repo — T01 had nothing to derive.
  'git-command-failed',              // a git invocation failed for that repo during T01's capture.
  'run-has-no-repos',                // T01's synthetic entry for a run that addressed zero repos.
  'worktree-path-missing',           // the run registers a worktree for that repo and the directory is gone. T01 refuses to substitute the registered checkout, so there is nothing to compare — the comparison shrinks visibly instead of comparing the wrong tree.
  'repo-skip-unclassified',          // a skipped repo entry whose T01 reason is not one of the above (a newer forge-touch, a hand-edited record). Named rather than dropped: an unrecognised reason is still a reason.
];

const REPO_LEVEL_REASONS = new Set([
  'repo-path-unresolved', 'repo-not-git', 'git-command-failed', 'run-has-no-repos',
  'worktree-path-missing',
]);

/**
 * Classify a skipped repo entry from a T01 snapshot.
 *
 * Falls back to `repo-skip-unclassified` rather than passing the raw string
 * through: `OVERLAP_REASONS` is a closed enum and a census that quietly
 * widened it would defeat the point of enumerating at all.
 */
function repoSkipReason(entry) {
  const r = entry && entry.reason;
  return REPO_LEVEL_REASONS.has(r) ? r : 'repo-skip-unclassified';
}

/** POSIX-normalise a path for cross-machine comparison of repo identities. */
function posix(p) {
  return typeof p === 'string' ? p.split(path.sep).join('/') : p;
}

/**
 * Do two repo entries, from two different runs, denote the SAME repo?
 *
 * Name must match, then the STRONGEST identity both entries carry decides:
 *
 *   1. `repo_id` — the shared git object store (T01's `repoIdentity`, i.e.
 *      `git rev-parse --git-common-dir`). Checkout-INVARIANT: two worktrees
 *      cut from one repo share it, two independent clones do not.
 *   2. `path` — the working-tree location, for snapshots that predate
 *      `repo_id` or whose identity could not be read.
 *   3. `name` alone — the permissive floor, on purpose: an advisory signal
 *      should over-report rather than go quiet.
 *
 * ── Why `repo_id` precedes `path` (review-fix R2) ──────────────────────────
 *
 * Path equality alone gets the worktree case exactly backwards, and it is the
 * case this slice exists for. Two runs in `worktree` isolation work in
 * `.forge-worktrees/{RUN-A}/freyr` and `.forge-worktrees/{RUN-B}/freyr` —
 * different paths — but both branches merge back into the SAME default
 * branch, so a file present in both is precisely the future merge conflict
 * the signal is meant to flag. Comparing paths there answers `clean` about
 * two genuinely conflicting runs.
 *
 * This does NOT reopen the case path equality was protecting: two independent
 * CLONES of `freyr` at different roots have different object stores and so
 * different `repo_id`s — they still do not match, now for a structural reason
 * instead of a positional one.
 *
 * Falling back to NAME-only matching would have "fixed" the worktree case too,
 * and must not be done: `apps/norns` + `services/norns` is the DEFAULT case on
 * this operator's disk (see `repoLeg` in forge-run-address.js), and a
 * name-keyed identity collapses those two distinct repos into one.
 */
function reposMatch(a, b) {
  if (!a || !b) return false;
  if (!a.name || !b.name || a.name !== b.name) return false;
  if (a.repo_id && b.repo_id) return a.repo_id === b.repo_id;
  if (a.path && b.path) return posix(a.path) === posix(b.path);
  return true;
}

/**
 * Read the run registry and split every run into `comparable` or `skipped`.
 *
 * Invariant asserted by the suite: `comparable.length + <run-level skips>`
 * equals the number of runs in the registry. Nothing is discarded silently —
 * a run that leaves the comparison leaves a named entry behind.
 *
 * `opts.all` includes inactive runs (CLI `--all`); the default compares only
 * active ones, since a finished run's touches are not a live collision.
 *
 * Reads only. This function does not write, and does not call git.
 */
function collectRunTouches(cwd, opts) {
  const o = opts || {};
  const all = runs.listAll(cwd);

  const comparable = [];
  const skipped = [];
  const notes = [];

  for (const rec of all) {
    const id = rec && rec.id ? rec.id : '(?)';

    if (!o.all && rec.active !== true) {
      skipped.push({ id, reason: 'run-inactive' });
      continue;
    }

    const touched = readTouched(rec);
    if (touched === null) {
      // NEVER recorded — categorically different from recorded-and-empty
      // below. See forge-touch.readTouched's contract.
      skipped.push({ id, reason: 'no-touch-record' });
      continue;
    }

    const repos = [];
    for (const r of (touched.repos || [])) {
      if (!r || r.status !== 'ok') {
        skipped.push({ id: `${id}/${(r && r.name) || '(?)'}`, reason: repoSkipReason(r) });
        continue;
      }
      // `repo_id` carried through verbatim — it is the identity `reposMatch`
      // prefers, and a snapshot that predates the field simply arrives with
      // `undefined` and degrades to path comparison there.
      repos.push({
        name: r.name,
        path: r.path || null,
        repo_id: r.repo_id || null,
        files: Array.isArray(r.files) ? r.files : [],
      });
    }

    if (repos.length === 0) {
      // Recorded, yet not one repo could be examined — a run about whose work
      // NOTHING is known. Letting it into the pair loop would let it "confirm"
      // a `clean` it cannot support: it matches no repo, contributes no file,
      // and silently manufactures the count that makes `clean` reachable. The
      // honest outcome is that the comparison visibly shrinks — possibly all
      // the way to the `inconclusive` floor.
      //
      // NOT the same as `touch-record-empty-but-recorded` below, which stays a
      // note and stays comparable: there the repos WERE examined and the empty
      // answer is real. Here there is no answer at all.
      skipped.push({ id, reason: 'no-comparable-repo' });
      continue;
    }

    const fileCount = repos.reduce((n, r) => n + r.files.length, 0);
    if (fileCount === 0) {
      // A note, NOT a skip: this run was examined and honestly has nothing.
      // It still enters the pair loop, so a `clean` verdict that includes it
      // is backed by real work.
      notes.push({ id, reason: 'touch-record-empty-but-recorded' });
    }

    comparable.push({ id, repos });
  }

  return { runs_examined: all.length, comparable, skipped, notes };
}

/** Stable output: by repo name, then by the two run ids. */
function byRepoThenIds(x, y) {
  const r = String(x.repo).localeCompare(String(y.repo));
  if (r !== 0) return r;
  const a = String(x.runs[0]).localeCompare(String(y.runs[0]));
  if (a !== 0) return a;
  return String(x.runs[1]).localeCompare(String(y.runs[1]));
}

/**
 * The heart: confront every unordered pair of comparable runs.
 *
 * PURE. No disk, no writes, no git. Everything it needs is in `collected`,
 * which makes the verdict floor below directly testable without a fixture.
 *
 * ── Why `pairs_compared === 0` precedes every other test ──────────────────
 *
 * The verdict order is FIXED and the floor is FIRST:
 *
 *     pairs_compared === 0  ->  inconclusive     (before anything else)
 *     overlaps.length > 0   ->  overlap
 *     otherwise             ->  clean
 *
 * It is first because `clean` is a CLAIM ABOUT WORK DONE — "I confronted
 * these pairs and found no collision" — and a comparator that emits it
 * having confronted nothing is reporting its own inactivity as good news.
 * That report is byte-for-byte indistinguishable from a detector that is
 * simply broken, which is precisely how this milestone's three prior
 * anti-silence bugs each survived review (see the header). Reordering these
 * branches, or short-circuiting `overlaps.length === 0` to `clean` before
 * the floor, reintroduces the whole bug class. The suite proves the floor
 * bites by mutating it and observing RED.
 *
 * `pairs_compared` is incremented INSIDE the loop, once per pair actually
 * walked — never computed as `n*(n-1)/2` on the side. A counter derived from
 * a formula stays correct while the loop it describes fails to run, which is
 * the same lie in a smaller font.
 */
function computeOverlap(collected) {
  const comparable = (collected && collected.comparable) || [];
  const skipped = ((collected && collected.skipped) || []).slice();
  const notes = ((collected && collected.notes) || []).slice();

  const overlaps = [];
  let pairs_compared = 0;
  let files_compared = 0;

  for (let i = 0; i < comparable.length; i++) {
    for (let j = i + 1; j < comparable.length; j++) {
      pairs_compared += 1;
      const A = comparable[i];
      const B = comparable[j];

      for (const ra of A.repos) {
        for (const rb of B.repos) {
          if (!reposMatch(ra, rb)) continue;

          const setA = new Set(ra.files);
          const setB = new Set(rb.files);
          const union = Array.from(new Set([...ra.files, ...rb.files])).sort();

          const shared = [];
          for (const f of union) {
            // Counted here, one increment per path actually walked, for the
            // same reason `pairs_compared` is: a census figure must be a
            // by-product of the work, not a parallel claim about it.
            files_compared += 1;
            if (setA.has(f) && setB.has(f)) shared.push(f);
          }

          if (shared.length > 0) {
            overlaps.push({ runs: [A.id, B.id], repo: ra.name, files: shared });
          }
        }
      }
    }
  }

  overlaps.sort(byRepoThenIds);

  if (comparable.length === 1) {
    skipped.push({ id: comparable[0].id, reason: 'not-comparable-single-run' });
  }

  let verdict;
  let reason;
  if (pairs_compared === 0) {
    verdict = 'inconclusive';
    reason = comparable.length === 1
      ? '1 run com dado de toque, nada a comparar'
      : `${comparable.length} run(s) com dado de toque, nenhum par a comparar`;
  } else if (overlaps.length > 0) {
    verdict = 'overlap';
    reason = `${overlaps.length} sobreposição(ões) em ${pairs_compared} par(es)`;
  } else {
    verdict = 'clean';
    reason = `${pairs_compared} par(es) confrontado(s), ${files_compared} caminho(s), nenhum arquivo em comum`;
  }

  return {
    verdict,
    reason,
    runs_examined: (collected && collected.runs_examined) || 0,
    runs_with_touch_data: comparable.length,
    pairs_compared,
    files_compared,
    overlaps,
    skipped,
    notes,
  };
}

/**
 * Human-readable rendering.
 *
 * The reason rides on the FIRST line for every verdict, `inconclusive`
 * included. A mute `inconclusive` — a verdict with no stated cause — repeats
 * the very defect this module exists to prevent, one level up: the reader
 * cannot tell "nothing to compare" from "the tool is broken".
 */
function formatOverlap(result) {
  const lines = [];
  lines.push(`forge-overlap: ${result.verdict} — ${result.reason}`);
  lines.push(
    `  censo: examined ${result.runs_examined} · with-data ${result.runs_with_touch_data}`
    + ` · pairs ${result.pairs_compared} · files ${result.files_compared}`
    + ` · skipped ${result.skipped.length}`,
  );

  for (const o of result.overlaps) {
    for (const f of o.files) {
      lines.push(`  ⚠ ${o.repo}/${f} — ${o.runs[0]} × ${o.runs[1]}`);
    }
  }

  for (const s of result.skipped) {
    lines.push(`  · fora da comparação: ${s.id} (${s.reason})`);
  }
  for (const n of result.notes) {
    lines.push(`  · ${n.id} (${n.reason})`);
  }

  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────
const USAGE = [
  'uso: node scripts/forge-overlap.js --check [--json] [--all] [--cwd <dir>]',
  '',
  'Sinal advisory: confronta os snapshots de toque gravados por forge-touch e',
  'aponta quando duas runs mexeram no mesmo arquivo. SEMPRE sai com exit 0.',
  '',
  'Veredictos: overlap | clean | inconclusive.',
  '`clean` exige ter confrontado ao menos um par; sem par, o veredicto é',
  '`inconclusive` — nunca `clean`.',
  '',
  'Flags:',
  '  --check        roda a comparação',
  '  --json         emite JSON em vez da forma legível',
  '  --all          inclui runs inativas (default: só as ativas)',
  '  --cwd <path>   onde procurar o registry de runs (default: process.cwd())',
  '  --help         este texto',
].join('\n');

function parseArgs(argv) {
  const out = { check: false, json: false, all: false, cwd: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--json') out.json = true;
    else if (a === '--all') out.all = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--cwd') { out.cwd = argv[++i]; }
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.check) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();

  let result;
  try {
    result = computeOverlap(collectRunTouches(cwd, { all: args.all }));
  } catch (e) {
    // Advisory: an unreadable registry is reported, never fatal to a caller's
    // loop. Same posture as forge-workspace-consistency.js and forge-touch.js.
    process.stderr.write(`forge-overlap: ${e.message}\n`);
    return 0;
  }

  process.stdout.write(args.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${formatOverlap(result)}\n`);

  // Return 0 UNCONDITIONALLY — including when `result.verdict === 'overlap'`.
  // This signal informs a human; it is not a gate. Do NOT make this reflect
  // the verdict: that single edit would convert an advisory detector into the
  // very mechanism S07 declared out of scope.
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  collectRunTouches,
  computeOverlap,
  formatOverlap,
  reposMatch,
  repoSkipReason,
  VERDICTS,
  OVERLAP_REASONS,
  parseArgs,
  main,
  USAGE,
};
