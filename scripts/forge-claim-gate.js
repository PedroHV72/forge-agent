#!/usr/bin/env node
// forge-claim-gate — the ENFORCING decision core of the cross-run write lease
// (M-20260813133328-lease-escrita-cross-run, S04/T01).
//
// ── What this module is, and what its neighbour is not ──────────────────────
//
// `forge-claim-overlap.js` SIGNALS: it compares the write claims of every
// active run and reports, always exiting 0. Its header names the boundary it
// refuses to cross — "the gate that REFUSES a dispatch is S04's, and it
// consumes this output; it must never be grown into this file". THIS is that
// consumer. The algebra of confrontation (`claimsConflict`, `codeDirScope`,
// `collectRunClaims`) is IMPORTED, never re-implemented: a second copy of the
// polarity D1 rests on would be the defect, not the feature.
//
// `forge-parallelism.writesConflict` is the INTRA-SLICE predicate with the
// OPPOSITE polarity ("empty list = no conflict"). It is correct there and out
// of scope here. It is not imported, not called and not named anywhere in this
// source: `forge-claim-gate.test.js` scans this file with comments stripped,
// with a positive AND a negative control, and `forge-claim-polarity.test.js`
// guards the same absence one module over.
//
// ── Posture: ENFORCING, so it fails CLOSED (S04-PLAN contract #10) ─────────
//
// The advisory neighbours in this family swallow an internal error and return
// 0. This one must not: a gate that goes mute is indistinguishable from a gate
// that approved, and that indistinguishability is the origin defect of the
// whole milestone. `main` therefore returns a NON-ZERO code on an internal
// error, and the consumer (skill) treats exit != 0 or non-JSON stdout as
// `block` with reason `gate-unavailable`, loud.
//
// ── What it decides ────────────────────────────────────────────────────────
//
//   proceed  — nothing in scope collides (or nothing is in scope at all, which
//              is a DIFFERENT reason and says so).
//   defer    — collision; the posture says to try another unit first.
//   block    — collision; the posture says to stop. Also the D3 FLOOR: a
//              `defer` with zero ready alternatives becomes `block` — deferring
//              with nowhere to defer to is waiting dressed as progress, and it
//              must NEVER degrade into proceeding.
//   refuse   — terminal for this dispatch: the OWN side never declared what it
//              writes (D1) or conceded a review item with no path (D7). Waiting
//              does not fix a missing declaration; the plan does.
//
// CLI:
//   node forge-claim-gate.js --evaluate (--plan <p> | --conceded <json|@file> | --paths <csv>)
//        --run <id> [--code-dir <p>] [--posture defer|block]
//        [--ready-alternatives <n>] [--cwd <dir>] [--json]

'use strict';

const fs = require('fs');
const path = require('path');

const {
  collectRunClaims,
  claimsConflict,
  codeDirScope,
  isUndeclared,
  CONFLICT_CAUSES,
  CLAIM_NOTE_REASONS,
} = require('./forge-claim-overlap.js');
const { declaredFor } = require('./forge-write-coverage.js');
const {
  normalizeClaim, recordClaim, readClaim, isHeld, CLAIM_SOURCES, RELEASE_MECHANISMS,
} = require('./forge-write-claim.js');
// S05/T03 — the release DECISION is never re-implemented here. `probeClaim`
// collects the facts (the only function in that module with I/O) and
// `classifyRelease` applies the precedence of S05-PLAN contract #5, PURE. This
// gate only consumes the verdict and translates it into a NAMED census skip.
const {
  probeClaim, classifyRelease, measureBaseline, CLAIM_RELEASE_REASONS,
} = require('./forge-claim-release.js');
const { readPrefs } = require('./forge-prefs.js');
const runs = require('./forge-runs.js');

// ── Closed sets ────────────────────────────────────────────────────────────
//
// Same discipline as the neighbour: every value documents WHEN it is
// reachable, and the suite crosses each set in BOTH directions (every value
// this code emits is listed; every listed value is emitted by >= 1 test).
// One-directional checking lets a dead entry rot or an undocumented one leak.

const GATE_DECISIONS = [
  'proceed', // no counterpart in scope, or every in-scope counterpart was confronted with no collision.
  'defer',   // collision, posture `defer`, and at least one ready alternative exists to spend the wait on.
  'block',   // collision with posture `block`, OR the D3 floor firing on a `defer` with zero alternatives.
  'refuse',  // the OWN side is ineligible (D1 undeclared / D7 pathless) AND >= 1 counterpart is in scope.
];

const GATE_CAUSES = [
  'overlap',                // both sides declared, and `pathsOverlap` matched — a MEASURED collision.
  'undeclared-writes',      // a side carries no claim or an empty one. Never reported as `overlap`, nor the reverse.
  'pathless-conceded-item', // D7: a conceded review item arrived with no path, so the claim cannot be derived.
];

const PROCEED_REASONS = [
  'no-active-counterpart', // zero counterparts in scope: NOTHING was confronted. Kept distinct on purpose —
                           // a proceed that confronted nothing must never wear the clothes of a clean confrontation.
  'no-conflict',           // >= 1 counterpart confronted, and none collided.
];

const GATE_SKIP_REASONS = [
  'different-code-dir', // D2: the counterpart writes from a MEASURED different CODE_DIR, so identical
                        // relative paths denote different files. Out of scope; never counted as confronted.
  // ── Release skips (S05/T03) — one entry PER MECHANISM, because each names a
  // DIFFERENT thing that was proved. Collapsing them into a single
  // `claim-released` would leave the operator unable to tell a claim that a
  // measured commit retired from one the TTL net swept away, and those two
  // deserve very different follow-ups.
  //
  // Every one of them is a skip, never a note: the counterpart LEFT the
  // universe, and a census where a departure looks like an uncertainty is the
  // same silence one font smaller.
  'claim-released:committed',   // the two probes agreed: the baseline advanced AND no claimed path is still in flight.
  'claim-released:ttl-expired', // the TTL net (D2) fired: `ttl + grace` elapsed over a run measured INACTIVE. Never age alone.
  'claim-released:explicit',    // the claim already carried the `released` envelope, written by an earlier corroborated release.
  'claim-released:manual',      // the operator released it by hand (S05/review R4). Asserts NO measurement — the one mechanism
                                // the CLI may write, precisely because it cannot lie about corroboration. `classifyRelease`
                                // never emits it, so this skip is reached only through an injected classifier (the same seam
                                // the fail-closed branches use) or a future probe taught to read the persisted envelope;
                                // the hand-released claim's mechanism surfaces today as `persisted_mechanism`.
];

/**
 * `RELEASE_MECHANISMS` (forge-write-claim.js, T01) -> the skip reason above.
 *
 * Derived from the CLOSED set of the owner module rather than written out a
 * second time: a mechanism grown there without being taught here must surface
 * loudly (the counterpart is KEPT, see `counterpartRelease`), never as an
 * unlabelled skip string that every `includes` downstream reads as absence.
 */
const RELEASE_SKIP_BY_MECHANISM = Object.freeze(RELEASE_MECHANISMS.reduce((acc, m) => {
  acc[m] = `claim-released:${m}`;
  return acc;
}, {}));

const GATE_NOTE_REASONS = [
  'own-claim-ineligible-no-counterpart', // the own side did not declare, but nobody is in scope to be harmed by it.
                                         // Visible, never punished into a refuse without a counterpart (D1).
  'posture-invalid',                     // the posture given is outside {defer, block}; fell back to `defer`, named.
  'invalid-posture-pref',                // `parallelism.cross_run_overlap` resolved to a value outside {defer, block}.
  'invalid-timing-pref',                 // one of the three anti-livelock timings resolved to a non-positive integer.
  'defer-ledger-unreadable',             // the defer ledger could not be read; the counter is treated as 0, NEVER a crash.
  'defer-ledger-unwritable',             // the ledger could not be persisted; the decision still stands, and says so.
  // ── Release probe notes (S05/T03). ALL THREE mean the same thing about the
  // decision — the counterpart STAYED in scope — and different things about
  // WHY, which is exactly why they are three. A probe that could not answer
  // must never look like a probe that answered "still held": the first is a
  // hole in the evidence, the second is evidence.
  'release-probe-unavailable',   // the probe answered `held-probe-unavailable` (no code_dir, no vcs_baseline, seam `{ok:false}`). Counterpart KEPT.
  'release-probe-threw',         // the injected probe (or `classifyRelease`) threw. Counterpart KEPT — a broken probe never opens the fence.
  'release-probe-unrecognised',  // the verdict came back outside `CLAIM_RELEASE_REASONS`/`RELEASE_MECHANISMS`. Counterpart KEPT, loudly.
  // ── Baseline measured at RECORD time (S05/T03, B2 posture).
  'vcs-baseline-absent',     // no `code_dir` was GIVEN, so nothing could be measured: `vcs_baseline: null`, NAMED, never derived from root/branch.
  'vcs-baseline-unmeasured', // a `code_dir` was given and the measurement FAILED (`detail` carries the seam's named error): `vcs_baseline: null`, NAMED.
];

// Escalations are a FIELD of the result, never a fifth decision value. The
// decision stays `block` and the CONSUMER acts on the escalation — a gate that
// invented a decision here would force every caller to learn a new verb.
const ESCALATIONS = [
  'wait-ceiling', // `--wait` polled up to `parallelism.block_wait_ms` and the conflict never cleared.
  'defer-cap',    // the same unit deferred `parallelism.defer_cap` times in a row; waiting stopped being productive.
];
// Counterpart-scope notes (`code-dir-unknown` and friends) are NOT redefined
// here: they come from S03's `CLAIM_NOTE_REASONS` and travel verbatim.

// ── Boundaries this gate does NOT cover — enumerated, never silent ─────────
//
// Present in EVERY result, including `proceed`. A gap the operator can read is
// a decision; a gap nobody prints is an omission that looks like coverage.
const UNCOVERED_BOUNDARIES = [
  {
    boundary: 'complete-slice',
    // S05/T03: the OLD reason said this boundary collided with "the release of
    // IN-6 (S05)". IN-6 is DELIVERED — `forge-claim-release.js` exists and this
    // gate consumes it — so keeping that sentence would leave an enumerated
    // LIE in the one list whose whole job is to be trustworthy. The boundary
    // stays out because the CONTEXT deferred it (the completer does not invoke
    // the gate and does not request a release at slice close), not for want of
    // a mechanism: the mechanism is now here and the wiring is a decision.
    reason: 'o completer não invoca o gate nem pede release ao fechar o slice — fora por decisão (Deferred do CONTEXT); o mecanismo de release existe desde IN-6/S05',
  },
  {
    boundary: 'orchestrator-writes',
    reason: 'escritas .gsd/** do próprio orquestrador não passam pelo claim — Deferred do CONTEXT',
  },
  {
    boundary: 'forge-task',
    reason: 'o Boundary Map desta milestone limita o wiring a forge-auto/forge-next; /forge-task não invoca o gate',
  },
];

const POSTURES = ['defer', 'block'];

// ── Derivation: the declared side of a T##-PLAN.md ─────────────────────────

/**
 * `{ eligible, paths, source: 'plan-writes', detail, cause }` for one plan.
 *
 * The union `writes:` ∪ `expected_output:` is NOT recomputed here — it is
 * `declaredFor` (forge-write-coverage.js), imported. A second copy of that
 * union would drift from the corpus measurement that produced the milestone's
 * GO verdict.
 *
 * This function REPORTS FACTS. It never decides to refuse: refusing needs the
 * counterpart universe, which only `evaluateGate` has (D1 — an undeclared plan
 * with nobody else running is not an incident). `detail` distinguishes a plan
 * whose structured schema could not be read (`legacy-plan-schema`) from a plan
 * that was read and is honestly empty (`declared-empty`) — the same
 * never-collapse rule `readClaim` applies to `null` vs `{ paths: [] }`.
 */
function deriveClaimFromPlan(cwd, planPath) {
  const abs = path.resolve(cwd, planPath);
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    // Boundary validation: an unreadable plan is an internal error, and this
    // gate fails CLOSED — it must not become an eligible empty claim.
    throw new Error(`forge-claim-gate: plano ilegível ${abs} — ${e.message}`);
  }

  const rel = path.relative(cwd, abs).split(path.sep).join('/');
  const d = declaredFor(cwd, { content, plan_path: rel });

  if (d.legacy) {
    return {
      eligible: false,
      paths: [],
      source: 'plan-writes',
      detail: `legacy-plan-schema: ${d.detail}`,
      cause: 'undeclared-writes',
    };
  }
  if (d.declared.length === 0) {
    return {
      eligible: false,
      paths: [],
      source: 'plan-writes',
      detail: 'declared-empty',
      cause: 'undeclared-writes',
    };
  }
  return {
    eligible: true, paths: d.declared, source: 'plan-writes', detail: null, cause: null,
  };
}

/**
 * D7 — the review-fix side. Items are the conceded objections, each ideally
 * carrying the `path:line` the fix lands on.
 *
 * An item with NO path makes the claim underivable, and that is a NAMED branch
 * (`pathless-conceded-item`), never a quiet degradation into "declared
 * nothing": the operator must be able to tell "this review item forgot its
 * path" from "this run never claimed". The R#s that lack a path travel in
 * `pathless` so the message can name them.
 */
function deriveClaimFromConcededItems(items) {
  const list = Array.isArray(items) ? items : [];
  const paths = [];
  const pathless = [];
  const seen = new Set();

  for (const item of list) {
    const it = item || {};
    const raw = typeof it.path === 'string' ? it.path.trim() : '';
    const id = it.r || it.id || '(?)';
    if (raw === '') {
      pathless.push(id);
      continue;
    }
    // Strip the `:line` (and `:line-line`) suffix: a claim is about FILES.
    const stripped = raw.replace(/:\d+(?:-\d+)?$/, '');
    if (stripped === '' || seen.has(stripped)) continue;
    seen.add(stripped);
    paths.push(stripped);
  }

  if (pathless.length > 0) {
    return {
      eligible: false,
      paths,
      pathless,
      source: 'review-fix-paths',
      detail: `itens concedidos sem path: ${pathless.join(', ')}`,
      cause: 'pathless-conceded-item',
    };
  }
  if (paths.length === 0) {
    return {
      eligible: false,
      paths: [],
      pathless: [],
      source: 'review-fix-paths',
      detail: 'declared-empty',
      cause: 'undeclared-writes',
    };
  }
  return {
    eligible: true, paths, pathless: [], source: 'review-fix-paths', detail: null, cause: null,
  };
}

// ── Posture: a SEAM for S06/D8, not an implementation ──────────────────────

/**
 * `{ posture, override: null, note }`.
 *
 * Today it validates the preference and returns it. The signature takes BOTH
 * complete `RunRecord`s on purpose (W3/D8): S06 will add the `defer` -> `block`
 * override by reading the additive field of `resolveEffectiveMode` on the
 * COUNTERPART's record, and it must be able to do so WITHOUT rewriting the
 * gate. `override` is the field that override will populate; it is `null` here
 * because D8 belongs to S06 by ROADMAP decision, not because it was forgotten.
 *
 * The test asserts that the counterpart's record — including its
 * `isolation_mode` — actually reaches this function; a seam nobody feeds is a
 * seam that will be discovered broken in S06.
 */
function resolvePosture(opts) {
  const o = opts || {};
  if (POSTURES.includes(o.pref)) {
    return { posture: o.pref, override: null, note: null };
  }
  // Fail toward the softer of the two ONLY because the D3 floor below still
  // converts a useless `defer` into `block`; the invalid value is NAMED, never
  // silently accepted.
  return { posture: 'defer', override: null, note: 'posture-invalid' };
}

// ── The decision ───────────────────────────────────────────────────────────

/** Own-side eligibility as a fact: `{ eligible, cause }`. */
function ownEligibility(claim) {
  if (claim && claim.eligible === false) {
    return { eligible: false, cause: GATE_CAUSES.includes(claim.cause) ? claim.cause : 'undeclared-writes' };
  }
  if (isUndeclared(claim)) return { eligible: false, cause: 'undeclared-writes' };
  return { eligible: true, cause: null };
}

// ── Release awareness: a dead claim must stop blocking, and only a dead one ──
//
// The DEFAULT probe is T02's `probeClaim`, held here by REFERENCE so the suite
// can assert the wiring by identity instead of by re-testing behaviour that
// already has its own suite one module over.
const DEFAULT_RELEASE_PROBE = probeClaim;
// The second half of the SAME seam. It exists for one reason, stated plainly:
// the two guards below (`reason` outside `CLAIM_RELEASE_REASONS`, `mechanism`
// outside `RELEASE_MECHANISMS`) are UNREACHABLE through the probe alone —
// `classifyRelease` cannot emit either, by construction. A guard no test can
// reach is an inert guard, and this repo has already paid for inert guards more
// than once. Injecting the classifier is how the fail-closed branch is PROVED
// to bite rather than asserted to exist. Default held by reference, like above.
const DEFAULT_RELEASE_CLASSIFY = classifyRelease;

/**
 * Is this counterpart's claim still alive? `{ released, mechanism, reason,
 * skip, note, detail }`.
 *
 * ── The polarity, which is not negotiable anywhere in this milestone ────────
 *
 * A question that COULD NOT BE ASKED keeps the claim. A probe that throws, a
 * verdict outside the closed sets, a `held-probe-unavailable`, a missing seam:
 * every one of them KEEPS the counterpart in scope and adds a NAMED note. The
 * opposite reading — "the probe broke, so assume the claim is gone" — would
 * remove counterparts silently, and a fence that silently lets everyone through
 * is byte-for-byte indistinguishable from a clean `proceed`. That
 * indistinguishability is the origin defect of this whole milestone; a broken
 * probe must never be able to recreate it.
 *
 * A claim that is ABSENT (`null`) is not probed at all and is never called
 * released: absent, empty and released are THREE facts (contract #6) and this
 * function is where two of them would be easiest to collapse. Absent stays in
 * scope and remains `undeclared-writes` under D1 — the release must never
 * become a shortcut around the declaration requirement.
 */
function counterpartRelease(claim, opts) {
  const o = opts || {};
  if (!claim) {
    // Never probed, never released. `collectRunClaims` already noted
    // `claim-absent` for this run; adding a release verdict on top of an
    // absent claim is exactly the collapse contract #6 forbids.
    return { released: false, mechanism: null, reason: null, skip: null, note: null, detail: null };
  }

  const probe = typeof o.releaseProbe === 'function' ? o.releaseProbe : DEFAULT_RELEASE_PROBE;
  const classify = typeof o.releaseClassify === 'function' ? o.releaseClassify : DEFAULT_RELEASE_CLASSIFY;
  let verdict;
  try {
    // The counterpart's COMPLETE RunRecord travels with the claim: `runRecord`
    // is what lets `releaseIfObservable`-shaped probes (and any future seam,
    // the way `resolvePosture` carries the record for S06/D8) answer without a
    // second registry read, and it is asserted by spy so the seam is never
    // discovered broken later.
    const facts = probe(claim, Object.assign({}, o.releaseProbeOpts, {
      cwd: o.cwd,
      runId: o.runId,
      runRecord: o.runRecord || null,
    }));
    verdict = classify(facts);
  } catch (e) {
    return {
      released: false, mechanism: null, reason: null,
      skip: null, note: 'release-probe-threw', detail: e && e.message ? e.message : String(e),
    };
  }

  if (!verdict || !CLAIM_RELEASE_REASONS.includes(verdict.reason)) {
    return {
      released: false, mechanism: null, reason: null,
      skip: null, note: 'release-probe-unrecognised',
      detail: `razão fora de CLAIM_RELEASE_REASONS: ${verdict ? JSON.stringify(verdict.reason) : 'sem veredito'}`,
    };
  }

  if (verdict.held === true) {
    return {
      released: false,
      mechanism: null,
      reason: verdict.reason,
      skip: null,
      // `held-uncommitted` is a MEASURED answer and needs no note; only the
      // hole in the evidence does.
      note: verdict.reason === 'held-probe-unavailable' ? 'release-probe-unavailable' : null,
      detail: null,
    };
  }

  const skip = RELEASE_SKIP_BY_MECHANISM[verdict.mechanism];
  if (!skip) {
    // A release with a mechanism this gate does not know how to NAME is not a
    // release this gate may act on: naming is what keeps it out of
    // `claim-absent`, and an unnamed skip would leave the departure invisible.
    return {
      released: false, mechanism: null, reason: verdict.reason,
      skip: null, note: 'release-probe-unrecognised',
      detail: `mecanismo fora de RELEASE_MECHANISMS: ${JSON.stringify(verdict.mechanism)}`,
    };
  }
  // Cross-check against the persisted fact when the mechanism claims the claim
  // was already released: `isHeld` (T01) is the accessor that distinguishes
  // absent from released, and it is consulted rather than re-derived here.
  return {
    released: true,
    mechanism: verdict.mechanism,
    reason: verdict.reason,
    skip,
    note: null,
    detail: verdict.mechanism === 'explicit' && isHeld(claim)
      ? 'envelope released ausente no claim persistido' : null,
  };
}

/**
 * The heart. Returns a result that ALWAYS carries a census and the
 * enumeration of uncovered boundaries — a decision without a census does not
 * exist here, because a verdict nobody can audit is the same lie in a smaller
 * font.
 *
 * @param {object} opts
 *   cwd, runId, claim (own, persisted shape; may carry additive
 *   `eligible`/`cause` from a derivation), posture ('defer'|'block'),
 *   readyAlternatives (number; absent => 0, fail closed).
 */
function evaluateGate(opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const runId = o.runId || null;
  const claim = o.claim || null;
  const readyAlternatives = Number.isFinite(o.readyAlternatives) ? o.readyAlternatives : 0;

  const collected = collectRunClaims(cwd);
  const skipped = [];
  const notes = (collected.notes || []).slice();

  // Own and counterpart RunRecords: one registry read for the active universe,
  // `get` as the honest fallback for a run that is not active (or not there).
  const activeById = new Map();
  for (const rec of runs.listActive(cwd)) activeById.set(rec.id, rec);
  const ownRun = activeById.get(runId) || runs.get(cwd, runId);

  const candidates = (collected.comparable || []).filter((c) => c.id !== runId);
  const inScope = [];
  const released_counterparts = [];

  for (const c of candidates) {
    const { scope, note } = codeDirScope(claim, c.claim);
    if (note) {
      // The note comes from S03's closed set and is carried verbatim. Checked
      // at the seam so a value added there without being taught here surfaces
      // as a loud error, never as an unlabelled string in the census.
      if (!CLAIM_NOTE_REASONS.includes(note)) {
        throw new Error(`forge-claim-gate: note de escopo fora de CLAIM_NOTE_REASONS: ${note}`);
      }
      notes.push({ id: `${runId} × ${c.id}`, reason: note });
    }
    if (scope === 'different') {
      // The ONLY way out of scope: two absolutes resolved real-vs-real that
      // differ. `unknown` STAYS IN (contract #5, W2) — excluding on unknown is
      // "absence of information = safe", the exact polarity D1 forbids.
      skipped.push({ id: c.id, reason: 'different-code-dir' });
      continue;
    }

    const record = activeById.get(c.id) || runs.get(cwd, c.id);

    // ── Release probe — AFTER the scope skip, on purpose (T03-PLAN step 2) ──
    // `different-code-dir` is cheap and I/O-free; probing first would spend a
    // VCS round-trip on pairs that are out of scope anyway, and would grow the
    // census with release facts about runs this evaluation never had to judge.
    const rel = counterpartRelease(c.claim, {
      cwd,
      runId: c.id,
      runRecord: record,
      releaseProbe: o.releaseProbe,
      releaseClassify: o.releaseClassify,
      releaseProbeOpts: o.releaseProbeOpts,
    });
    if (rel.note) {
      const n = { id: `${runId} × ${c.id}`, reason: rel.note };
      if (rel.detail) n.detail = rel.detail;
      notes.push(n);
    }
    if (rel.released) {
      // The departure is NAMED and COUNTED: it stays inside
      // `counterparts_considered`, leaves `counterparts_in_scope`, and lands in
      // `skipped` carrying the mechanism that proved it. What it must NEVER do
      // is fall back into the universe as an absent claim — that would turn a
      // release into `undeclared-writes` (D1) and make the release WORSEN the
      // very block it came to fix (contract #6, the most expensive possible
      // mistake in this slice; it has its own dedicated assert).
      skipped.push({ id: c.id, reason: rel.skip });
      const entry = { id: c.id, mechanism: rel.mechanism, reason: rel.reason };
      // `mechanism` is the mechanism of THIS verdict; when the claim already
      // carried the envelope, that verdict is `explicit` and the mechanism that
      // originally retired the claim lives in the envelope. Both are reported,
      // because collapsing them would tell the operator "released explicitly"
      // about a claim a measured commit retired — true about the verdict,
      // misleading about the history.
      if (c.claim.released && c.claim.released.mechanism) {
        entry.persisted_mechanism = c.claim.released.mechanism;
      }
      released_counterparts.push(entry);
      continue;
    }

    inScope.push({
      id: c.id,
      claim: c.claim,
      scope,
      note: note || null,
      record,
    });
  }

  const census = {
    runs_examined: collected.runs_examined || 0,
    counterparts_considered: candidates.length,
    counterparts_in_scope: inScope.length,
    skipped: skipped.concat(collected.skipped || []),
    notes,
  };

  const base = {
    run: runId,
    posture_pref: o.posture || null,
    ready_alternatives: readyAlternatives,
    census,
    // Additive field (S05/T03), same convention as `tier`/`reason` on the
    // dispatch event: a reader that does not know it ignores it and stays
    // correct. It rides on EVERY result, `proceed` included — a departure that
    // is only reported where someone remembered to look is not reported.
    released_counterparts,
    not_covered: UNCOVERED_BOUNDARIES,
  };

  const own = ownEligibility(claim);

  // Nothing in scope: NOTHING was confronted, and the proceed says exactly
  // that. This branch comes FIRST — before eligibility and before the
  // confrontation — because both of the alternatives would lie about it: an
  // own-ineligible claim would be refused with no counterpart to protect (D1
  // punishing a harmless plan), and an eligible one would fall through the
  // empty confrontation loop and emerge as `no-conflict`, i.e. a proceed that
  // confronted nothing wearing the clothes of a clean confrontation.
  if (inScope.length === 0) {
    if (!own.eligible) {
      // Visible, never punished without a counterpart.
      census.notes.push({ id: runId, reason: 'own-claim-ineligible-no-counterpart' });
    }
    return Object.assign({
      decision: 'proceed',
      cause: null,
      reason: 'no-active-counterpart',
      undeclared_side: null,
      floor: null,
      counterparts: [],
      paths: [],
    }, base);
  }

  // (c) Own side ineligible — D1/D7. Refuse only reaches here, i.e. only with
  // >= 1 counterpart in scope.
  if (!own.eligible) {
    const counterpartAlsoUndeclared = inScope.some((c) => isUndeclared(c.claim));
    return Object.assign({
      decision: 'refuse',
      cause: own.cause,
      reason: null,
      undeclared_side: own.cause === 'undeclared-writes'
        ? (counterpartAlsoUndeclared ? 'both' : 'own')
        : null,
      floor: null,
      counterparts: inScope.map((c) => ({
        id: c.id, cause: null, paths: [], scope: c.scope, note: c.note,
      })),
    }, base);
  }

  // (d) Confrontation — the algebra is S03's, never a second copy.
  const counterparts = [];
  let sawOverlap = false;
  let sawUndeclared = false;
  const matchedPaths = [];

  for (const c of inScope) {
    const hit = claimsConflict(claim, c.claim);
    if (hit) {
      // Same seam check as the scope note: S03 owns this set, and a cause it
      // grows without teaching this gate must be loud, not silently ignored by
      // the two `===` below (which would read as "no conflict" — silence).
      if (!CONFLICT_CAUSES.includes(hit.cause)) {
        throw new Error(`forge-claim-gate: causa fora de CONFLICT_CAUSES: ${hit.cause}`);
      }
      if (hit.cause === 'overlap') {
        sawOverlap = true;
        for (const p of hit.paths) if (!matchedPaths.includes(p)) matchedPaths.push(p);
      } else if (hit.cause === 'undeclared-writes') {
        sawUndeclared = true;
      }
    }
    counterparts.push({
      id: c.id,
      cause: hit ? hit.cause : null,
      paths: hit ? hit.paths : [],
      scope: c.scope,
      note: c.note,
    });
  }

  if (!sawOverlap && !sawUndeclared) {
    return Object.assign({
      decision: 'proceed',
      cause: null,
      reason: 'no-conflict',
      undeclared_side: null,
      floor: null,
      counterparts,
      paths: [],
    }, base);
  }

  // A MEASURED collision outranks a missing declaration when both are present:
  // `overlap` names files that will actually be fought over. The two are never
  // substituted for one another — when only one is present, only that one is
  // reported, and the suite asserts both directions.
  const cause = sawOverlap ? 'overlap' : 'undeclared-writes';
  // Own/both already became `refuse` above, so the only undeclared side
  // reachable here is the counterpart's — stated as a derived fact, not assumed.
  const undeclared_side = sawUndeclared ? 'counterpart' : null;

  const firstConflicting = inScope.find((c) => counterparts.some((r) => r.id === c.id && r.cause));
  // Called through `module.exports` ON PURPOSE: this is the S06/D8 seam, and a
  // seam nobody can observe is a seam that will be discovered broken later. The
  // indirection lets the suite substitute a spy and PROVE that the counterpart's
  // complete RunRecord (its `isolation_mode` included) actually arrives here —
  // instead of asserting it by reading the call site.
  const resolved = module.exports.resolvePosture({
    pref: o.posture,
    ownRun,
    counterpartRun: firstConflicting ? firstConflicting.record : null,
  });
  if (resolved.note) census.notes.push({ id: runId, reason: resolved.note });

  let decision = resolved.posture;
  let floor = null;
  if (decision === 'defer' && readyAlternatives === 0) {
    // D3 — the floor. Deferring with nowhere to defer to is waiting dressed as
    // progress. It becomes `block`, and it NEVER degrades into proceeding:
    // moving this branch, or letting it fall through to `proceed`, reopens the
    // exact incident class this milestone exists to close.
    decision = 'block';
    floor = 'defer-floor';
  }

  return Object.assign({
    decision,
    cause,
    reason: null,
    undeclared_side,
    floor,
    counterparts,
    paths: matchedPaths,
    posture_override: resolved.override,
  }, base);
}

// ── The knob, made live (B1) ───────────────────────────────────────────────
//
// `parallelism.cross_run_overlap` shipped with ZERO consumers: it was declared
// in the schema, documented in the reference and read by nobody. This module is
// its first reader. Three precedents in this repo say that "the value is read"
// is NOT the property worth proving (ROUTING_DOMAINS inert, plan-check
// Dimension 9 anchored on the wrong artifact, the Layer 3 gate that flagged the
// three correct files and passed the one versioned offender): a knob is alive
// when CHANGING IT CHANGES THE DECISION. The suite proves that with the same
// pair of colliding runs under both values, and with an EXECUTED bite that
// neutralises the read below and leaves one of the two red.
//
// The hardcoded fallbacks here are the LAST line of defence, and each one MUST
// be byte-identical to the corresponding default in forge-prefs.schema.json —
// `forge-prefs-schema.test.js` carries a witness assert per key citing THIS
// file as the reader. A fallback that drifts from the schema makes the
// documented default a lie for anyone who never wrote a prefs file.
const PARALLELISM_FALLBACKS = {
  cross_run_overlap: 'defer', // == forge-prefs.schema.json parallelism.cross_run_overlap.default
  block_wait_ms: 300000,      // == parallelism.block_wait_ms.default (5 min — ceiling of ONE blocking wait)
  block_poll_ms: 15000,       // == parallelism.block_poll_ms.default
  defer_cap: 3,               // == parallelism.defer_cap.default (consecutive defers of the SAME unit)
};

function positiveIntPref(value, fallback, key, notes) {
  if (Number.isInteger(value) && value > 0) return value;
  if (value === undefined) return fallback;
  notes.push({ id: `parallelism.${key}`, reason: 'invalid-timing-pref' });
  return fallback;
}

/**
 * The three anti-livelock timings, resolved from prefs (W6: they are OPERATOR
 * knobs, never magic constants buried in this file — an operator who cannot
 * find the ceiling cannot raise it).
 *
 * `opts` is forwarded verbatim to `readPrefs` so a test can isolate the global
 * layer (`globalDir`) instead of reading the operator's real home.
 */
function readParallelism(cwd, opts) {
  const notes = [];
  let block = {};
  try {
    const resolved = readPrefs(cwd, opts);
    const p = resolved && resolved.prefs && resolved.prefs.parallelism;
    if (p && typeof p === 'object') block = p;
  } catch (_) {
    // Unreadable prefs are not a reason to go mute: fall back to the documented
    // defaults, which are the SAME values the operator would have got by
    // writing nothing at all.
    block = {};
  }
  return {
    cross_run_overlap: block.cross_run_overlap,
    block_wait_ms: positiveIntPref(block.block_wait_ms, PARALLELISM_FALLBACKS.block_wait_ms, 'block_wait_ms', notes),
    block_poll_ms: positiveIntPref(block.block_poll_ms, PARALLELISM_FALLBACKS.block_poll_ms, 'block_poll_ms', notes),
    defer_cap: positiveIntPref(block.defer_cap, PARALLELISM_FALLBACKS.defer_cap, 'defer_cap', notes),
    notes,
  };
}

/**
 * `{ posture, source, note }` — the FIRST real read of
 * `parallelism.cross_run_overlap` in this repo.
 *
 * `source` says where the value came from (`prefs` | `fallback` |
 * `invalid-pref`), so a `block` that came from a typo is distinguishable from a
 * `block` the operator asked for. A value outside `{defer, block}` falls back to
 * `defer` and is NAMED (`invalid-posture-pref`) — never silently accepted,
 * because the D3 floor downstream still converts a useless `defer` into `block`.
 *
 * The single line that reads the pref is the BITE TARGET of the suite: it must
 * appear exactly once in this file.
 */
function resolvePostureFromPrefs(cwd, opts) {
  const raw = readParallelism(cwd, opts).cross_run_overlap;
  if (raw === undefined || raw === null) {
    return { posture: PARALLELISM_FALLBACKS.cross_run_overlap, source: 'fallback', note: null };
  }
  if (POSTURES.includes(raw)) return { posture: raw, source: 'prefs', note: null };
  return {
    posture: PARALLELISM_FALLBACKS.cross_run_overlap,
    source: 'invalid-pref',
    note: 'invalid-posture-pref',
  };
}

// ── Anti-livelock: the defer ledger ────────────────────────────────────────
//
// `.gsd/forge/claim-gate-defers.json`, keyed `"<runId>|<unit>"`. Consecutive
// defers of the SAME unit are counted; a `proceed` resets the counter, because
// what the cap measures is "waiting stopped being productive", not "this unit
// ever waited".
function deferLedgerPath(cwd) {
  return path.join(cwd, '.gsd', 'forge', 'claim-gate-defers.json');
}

/**
 * `{ data, note }` — an unreadable or corrupt ledger is treated as EMPTY with a
 * named note, never as a crash. The ledger is a SAFETY NET (it escalates a
 * livelock to the operator); a broken net must not become the thing that stops
 * every dispatch, and it must not pretend to be intact either.
 */
function readDeferLedger(cwd) {
  const file = deferLedgerPath(cwd);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // A ledger that was never written is not a fault — only a real read error is.
    if (e && e.code === 'ENOENT') return { data: {}, note: null };
    return { data: {}, note: 'defer-ledger-unreadable' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { data: parsed, note: null };
    return { data: {}, note: 'defer-ledger-unreadable' };
  } catch (_) {
    return { data: {}, note: 'defer-ledger-unreadable' };
  }
}

/** `null` on success, `'defer-ledger-unwritable'` otherwise — never a throw. */
function writeDeferLedger(cwd, data) {
  const file = deferLedgerPath(cwd);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return null;
  } catch (_) {
    return 'defer-ledger-unwritable';
  }
}

function deferKey(runId, unit) {
  return `${runId}|${unit || '(sem unidade)'}`;
}

// ── The event, written BY CODE ─────────────────────────────────────────────

/**
 * One JSON line appended to `.gsd/forge/events.jsonl` of the given `--cwd`.
 *
 * Written HERE, in code, and not narrated by the orchestrator: this repo has
 * measured what happens when the only record of a routing decision is a line
 * the model was asked to write (TASK-021 — a whole slice fell through to a
 * different engine and the session narrated it as a tooling bug). Returns
 * `{ event_written, event_error }`; a failure to log NEVER swallows the
 * decision, and never hides that it failed.
 */
function emitGateEvent(cwd, result) {
  const line = {
    event: 'claim-gate',
    ts: new Date().toISOString(),
    run: result.run,
    unit: result.unit === undefined ? null : result.unit,
    decision: result.decision,
    cause: result.cause === undefined ? null : result.cause,
    undeclared_side: result.undeclared_side === undefined ? null : result.undeclared_side,
    posture: result.posture === undefined ? null : result.posture,
    posture_source: result.posture_source === undefined ? null : result.posture_source,
    escalation: result.escalation === undefined ? null : result.escalation,
    floor: result.floor === undefined ? null : result.floor,
    counterparts: result.counterparts || [],
    // ADDITIVE (S05/T03): who left the universe because their claim was
    // measured dead, and by which mechanism. An old reader that ignores the
    // key stays correct; a reader that wants to explain why a `proceed`
    // happened now can, without re-running the probe.
    released_counterparts: result.released_counterparts || [],
    census: result.census,
    not_covered: result.not_covered,
  };
  const file = path.join(cwd, '.gsd', 'forge', 'events.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
    return { event_written: true, event_error: null };
  } catch (e) {
    return { event_written: false, event_error: e.message };
  }
}

// ── Record, then evaluate — an invisible fence does not fence ──────────────

/** Zero-dep synchronous sleep. The poll is synchronous on purpose (see below). */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function eligibilityOfPaths(paths) {
  const list = Array.isArray(paths) ? paths : [];
  return list.length > 0
    ? { eligible: true, cause: null, detail: null }
    : { eligible: false, cause: 'undeclared-writes', detail: 'declared-empty' };
}

/**
 * The operational entry point: RECORD the own claim, THEN evaluate.
 *
 * The order is canonical and not an implementation detail (S04-PLAN contract
 * #6): a fence nobody can see does not fence. Two symmetric runs that record
 * before evaluating SEE EACH OTHER and both stop; the deadlock that follows is
 * resolved by the wait ceiling and the defer cap ESCALATING TO THE OPERATOR —
 * never by a tie-break. Ordering runs, or picking a winner, is an integration
 * queue: an entire product, and the LOCKED frontier of S07. Do not grow one here.
 *
 * `code_dir` is a GIVEN fact (B2/contract #7): whatever `codeDir` is passed gets
 * recorded, and its ABSENCE is recorded as `null` — never derived from
 * root/branch/isolation_mode. A `null` scope stays IN scope (fail closed).
 *
 * `record: false` is the BATCH mode (R2 of the S04 review). The batch protocol
 * of `shared/forge-claim-gate.md § Step 1` demands two things at once — "record
 * the union of the whole batch FIRST" and "never use `--evaluate`" (which emits
 * no event) — and until this option existed the module had no mode that
 * satisfied both: every per-task `--claim-and-check` overwrote the union two
 * lines after it was written (`recordClaim` is a SINGLE SLOT —
 * forge-write-claim.js `runs.update({ write_claim })` replaces wholesale), so
 * during the evaluation of task *k* the RunRecord described only *k*. With
 * `record: false` the derived claim is evaluated and the event IS emitted, and
 * the persisted claim — the union — is left exactly as it was. The suite proves
 * the preservation by reading the record back after the call.
 *
 * Options: `{ cwd, runId, unit, source, codeDir, paths, derived,
 * readyAlternatives, posture, prefsOpts, wait, emitEvent, onPoll, record }`.
 */
function recordAndEvaluate(opts) {
  const o = opts || {};
  const cwd = o.cwd || process.cwd();
  const runId = o.runId || null;
  const unit = o.unit || null;
  const readyAlternatives = Number.isFinite(o.readyAlternatives) ? o.readyAlternatives : 0;

  const timings = readParallelism(cwd, o.prefsOpts);
  // An explicit `--posture` is an OPERATOR override and outranks the pref; its
  // absence is what makes the pref the deciding input (this is exactly what the
  // B1 pair exercises — the fixture sets no posture, only the prefs file).
  const resolvedPref = typeof o.posture === 'string'
    ? { posture: o.posture, source: 'explicit', note: null }
    : resolvePostureFromPrefs(cwd, o.prefsOpts);

  // (1) RECORD — via S03's primitive, never `runs.update` directly. Under
  // `record: false` the same shape is DERIVED and not persisted: the batch
  // union already on the record is the fence, and overwriting it here is the
  // very defect R2 named.
  // The baseline is measured AT RECORD TIME and nowhere else (S05/T03): it is
  // the "before" half of probe A, and a "before" read after the fact is not a
  // before. Same B2 posture as `code_dir`: without a `code_dir` there is
  // nothing to measure, so the field is `null` and the ABSENCE IS NAMED — never
  // derived from `root`+`branch` (a derived string names a tree that may not
  // exist, the defect S06 already measured), and never guessed.
  const baselineNotes = [];
  let vcs_baseline = null;
  if (typeof o.codeDir === 'string' && o.codeDir !== '') {
    const measured = measureBaseline(o.codeDir, { vcsSeam: o.vcsSeam, vcs: o.vcs });
    if (measured.ok) {
      vcs_baseline = { vcs: measured.vcs, id: measured.id };
    } else {
      baselineNotes.push({ id: runId, reason: 'vcs-baseline-unmeasured', detail: measured.error });
    }
  } else {
    baselineNotes.push({ id: runId, reason: 'vcs-baseline-absent', detail: 'code_dir não foi dado ao dispatch' });
  }

  const claimInput = {
    unit,
    source: CLAIM_SOURCES.includes(o.source) ? o.source : 'manual',
    code_dir: typeof o.codeDir === 'string' ? o.codeDir : undefined,
    paths: Array.isArray(o.paths) ? o.paths : [],
    vcs_baseline,
  };
  const recording = o.record !== false;
  const claim = recording ? recordClaim(cwd, runId, claimInput) : normalizeClaim(claimInput);

  // Read back through S03's own accessor: the point of recording first is that
  // the fence becomes VISIBLE to the other run, and "visible" means persisted —
  // asserted by the suite on a call whose decision is `block`.
  const claim_persisted = readClaim(runs.get(cwd, runId));

  const elig = o.derived
    ? { eligible: o.derived.eligible, cause: o.derived.cause, detail: o.derived.detail }
    : eligibilityOfPaths(claim.paths);
  const evalClaim = Object.assign({}, claim, elig);

  // (2) EVALUATE — the recorded claim is the one confronted.
  const evaluate = () => evaluateGate({
    cwd,
    runId,
    claim: evalClaim,
    posture: resolvedPref.posture,
    readyAlternatives,
    // The seam travels through: an injected probe must reach the counterpart
    // loop from here too, otherwise the operational entry point would silently
    // fall back to the default while the tests exercised the injection.
    releaseProbe: o.releaseProbe,
    releaseClassify: o.releaseClassify,
    releaseProbeOpts: o.releaseProbeOpts,
  });

  let result = evaluate();
  let escalation = null;
  let wait = null;

  // (3) The ceiling. Synchronous polling in-process: the consumer owns the tool
  // call timeout (contract in shared/forge-claim-gate.md, T03). Expiry NEVER
  // becomes `proceed` — it becomes a named escalation with the decision intact.
  if (o.wait && result.decision === 'block') {
    const started = Date.now();
    let polls = 0;
    while (result.decision === 'block') {
      const elapsed = Date.now() - started;
      if (elapsed >= timings.block_wait_ms) break;
      sleepSync(Math.min(timings.block_poll_ms, timings.block_wait_ms - elapsed));
      polls++;
      // Observation seam: the suite substitutes the world between polls (clearing
      // the counterpart's claim) to prove a conflict that CLEARS produces
      // `proceed` — asserting that against wall-clock timers would be flaky.
      if (typeof o.onPoll === 'function') o.onPoll(polls);
      result = evaluate();
    }
    wait = { polls, waited_ms: Date.now() - started, ceiling_ms: timings.block_wait_ms };
    if (result.decision === 'block') escalation = 'wait-ceiling';
  }

  // (4) The cap. Deferring forever is waiting dressed as progress (same family
  // as the D3 floor); when it stops being productive the gate ESCALATES — D3
  // inherited: it never degrades into proceeding.
  const ledger = readDeferLedger(cwd);
  const notes = result.census.notes;
  for (const n of timings.notes) notes.push(n);
  // The baseline outcome is census material even when it succeeded silently:
  // only its ABSENCE produces a note, and that absence must be visible on the
  // same result that carries the decision it will later be used to release.
  for (const n of baselineNotes) notes.push(n);
  if (ledger.note) notes.push({ id: runId, reason: ledger.note });

  const key = deferKey(runId, unit);
  let deferCount = 0;
  const previous = ledger.data[key] && Number(ledger.data[key].count);
  const prior = Number.isFinite(previous) && previous > 0 ? previous : 0;

  if (result.decision === 'defer') {
    deferCount = prior + 1;
    if (deferCount > timings.defer_cap) {
      result.decision = 'block';
      escalation = 'defer-cap';
    }
    ledger.data[key] = { count: deferCount, last_at: Date.now() };
    const werr = writeDeferLedger(cwd, ledger.data);
    if (werr) notes.push({ id: key, reason: werr });
  } else if (result.decision === 'proceed') {
    if (Object.prototype.hasOwnProperty.call(ledger.data, key)) {
      delete ledger.data[key];
      const werr = writeDeferLedger(cwd, ledger.data);
      if (werr) notes.push({ id: key, reason: werr });
    }
  } else {
    deferCount = prior;
  }

  if (resolvedPref.note) notes.push({ id: runId, reason: resolvedPref.note });

  const full = Object.assign({}, result, {
    unit,
    claim,
    claim_recorded: recording,
    claim_persisted,
    posture: resolvedPref.posture,
    posture_source: resolvedPref.source,
    escalation,
    wait,
    defer_count: result.decision === 'defer' || escalation === 'defer-cap' ? deferCount : prior,
    defer_cap: timings.defer_cap,
  });

  if (o.emitEvent === false) return Object.assign(full, { event_written: null, event_error: null });
  return Object.assign(full, emitGateEvent(cwd, full));
}

// ── Rendering ──────────────────────────────────────────────────────────────

function formatGate(result) {
  const lines = [];
  const tail = result.cause ? ` — ${result.cause}` : (result.reason ? ` — ${result.reason}` : '');
  lines.push(`forge-claim-gate: ${result.decision}${tail}`);
  if (result.floor) lines.push(`  piso: ${result.floor} (defer sem alternativa nunca prossegue — D3)`);
  if (result.escalation) {
    lines.push(`  ESCALAÇÃO: ${result.escalation} — sobe ao operador; o gate nunca degrada para prosseguir`);
  }
  if (result.posture) {
    lines.push(`  postura: ${result.posture} (origem: ${result.posture_source})`);
  }
  if (result.wait) {
    lines.push(`  espera: ${result.wait.polls} polls · ${result.wait.waited_ms}ms de teto ${result.wait.ceiling_ms}ms`);
  }
  if (result.event_written === false) {
    lines.push(`  evento NÃO gravado: ${result.event_error} (a decisão vale; o silêncio do log não)`);
  }
  if (result.undeclared_side) lines.push(`  lado não declarado: ${result.undeclared_side}`);
  if (result.paths && result.paths.length > 0) lines.push(`  caminhos: ${result.paths.join(', ')}`);
  const c = result.census;
  lines.push(
    `  censo: runs ${c.runs_examined} · counterparts ${c.counterparts_considered}`
    + ` · em escopo ${c.counterparts_in_scope} · skipped ${c.skipped.length} · notes ${c.notes.length}`,
  );
  for (const s of c.skipped) lines.push(`  · fora de escopo: ${s.id} (${s.reason})`);
  for (const n of c.notes) lines.push(`  · ${n.id} (${n.reason}${n.detail ? `: ${n.detail}` : ''})`);
  for (const r of (result.released_counterparts || [])) {
    lines.push(`  · claim liberado: ${r.id} — mecanismo ${r.mechanism} (${r.reason})`);
  }
  for (const b of result.not_covered) lines.push(`  · fronteira não coberta: ${b.boundary} — ${b.reason}`);
  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────

const USAGE = [
  'uso: node scripts/forge-claim-gate.js --evaluate (--plan <p> | --conceded <json|@file> | --paths <csv>)',
  '                                      --run <id> [--code-dir <p>] [--posture defer|block]',
  '                                      [--ready-alternatives <n>] [--cwd <dir>] [--json]',
  '     node scripts/forge-claim-gate.js (--claim-and-check | --check-only) (mesmas fontes) --run <id> --unit <u>',
  '                                      [--source <s>] [--code-dir <p>] [--wait] [--posture defer|block]',
  '                                      [--ready-alternatives <n>] [--cwd <dir>] [--json]',
  '',
  'Decide se a unidade pode despachar dado o claim próprio e os claims das runs',
  'ativas que dividem o mesmo CODE_DIR.',
  '',
  'Decisões: proceed | defer | block | refuse.',
  'Causas: overlap | undeclared-writes | pathless-conceded-item — nunca uma no lugar da outra.',
  'Razões de proceed: no-active-counterpart (não confrontou nada) | no-conflict (confrontou, limpo).',
  '',
  'Counterpart cujo claim já foi LIBERADO (S05) sai do universo com skip nomeado',
  '(claim-released:<mecanismo>), contado no censo — nunca vira claim-absent. Sonda de',
  'release que não pôde responder MANTÉM o counterpart em escopo, com note nomeada.',
  '',
  'Este gate é ENFORCING: erro interno sai com exit != 0. O consumidor que',
  'receber exit != 0 ou stdout não-JSON trata como block/gate-unavailable.',
  '',
  'Flags:',
  '  --evaluate                 avalia e emite a decisão (NÃO grava claim, NÃO emite evento);',
  '                             o resultado carrega `claim` — o claim derivado e normalizado',
  '  --claim-and-check          grava o claim ANTES de avaliar e emite o evento claim-gate',
  '  --check-only               avalia o claim derivado e EMITE o evento, PRESERVANDO o claim',
  '                             persistido — o modo do laço por task de um batch, cuja cerca é',
  '                             a união gravada antes do laço (spec § Step 1)',
  '  --unit <u>                 a unidade do claim (execute-task/T02, review-fix/..., ...)',
  '  --source <s>               plan-writes | review-fix-paths | manual (default: derivado da fonte)',
  '  --wait                     em block, re-avalia por poll até parallelism.block_wait_ms;',
  '                             o teto escala (wait-ceiling), NUNCA vira proceed',
  '  --plan <path>              deriva o claim de um T##-PLAN.md (writes: ∪ expected_output:)',
  '  --conceded <json|@file>    deriva o claim dos itens concedidos [{r, path, line}] (D7)',
  '  --paths <csv>              claim explícito (operador/teste)',
  '  --run <id>                 a run própria (excluída do universo de counterparts)',
  '  --code-dir <p>             fato DADO pelo dispatch; ausente => code_dir null => escopo unknown',
  '  --posture defer|block      override explícito; AUSENTE => parallelism.cross_run_overlap das prefs',
  '  --ready-alternatives <n>   quantas outras tasks estão ready (default 0 — falha fechado)',
  '  --cwd <path>               onde vive o registry de runs (default: process.cwd())',
  '  --json                     emite JSON em vez da forma legível',
  '  --help                     este texto',
].join('\n');

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

function parseConceded(raw) {
  let text = String(raw);
  if (text.startsWith('@')) text = fs.readFileSync(text.slice(1), 'utf8');
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('--conceded deve ser um array JSON de itens');
  return parsed;
}

function main(argv) {
  const args = parseArgs(argv);
  const claimAndCheck = Boolean(args['claim-and-check']);
  const checkOnly = Boolean(args['check-only']);
  if (claimAndCheck && checkOnly) {
    process.stderr.write('forge-claim-gate: --claim-and-check e --check-only são exclusivos\n');
    return 2;
  }
  if (args.help || (!args.evaluate && !claimAndCheck && !checkOnly)) {
    process.stdout.write(`${USAGE}\n`);
    return args.help ? 0 : 2;
  }

  const sources = ['plan', 'conceded', 'paths'].filter((k) => typeof args[k] === 'string');
  if (sources.length !== 1) {
    process.stderr.write('forge-claim-gate: exatamente uma fonte de claim é exigida (--plan | --conceded | --paths)\n');
    return 2;
  }
  if (typeof args.run !== 'string') {
    process.stderr.write('forge-claim-gate: --run <id> é obrigatório\n');
    return 2;
  }

  const cwd = typeof args.cwd === 'string' ? path.resolve(args.cwd) : process.cwd();

  let result;
  try {
    let derived;
    if (typeof args.plan === 'string') {
      derived = deriveClaimFromPlan(cwd, args.plan);
    } else if (typeof args.conceded === 'string') {
      derived = deriveClaimFromConcededItems(parseConceded(args.conceded));
    } else {
      const list = String(args.paths).split(',').map((p) => p.trim()).filter((p) => p !== '');
      derived = {
        eligible: list.length > 0,
        paths: list,
        source: 'manual',
        detail: list.length === 0 ? 'declared-empty' : null,
        cause: list.length === 0 ? 'undeclared-writes' : null,
      };
    }

    const source = CLAIM_SOURCES.includes(derived.source) ? derived.source : 'manual';
    // `code_dir` is a GIVEN fact (contract #7): absent flag => null => scope
    // `unknown` => fail closed. Never derived from root/branch/isolation_mode.
    const claim = Object.assign(normalizeClaim({
      unit: typeof args.unit === 'string' ? args.unit : null,
      source,
      code_dir: typeof args['code-dir'] === 'string' ? args['code-dir'] : undefined,
      paths: derived.paths,
    }), { eligible: derived.eligible, cause: derived.cause, detail: derived.detail });

    const readyAlternatives = typeof args['ready-alternatives'] === 'string'
      ? Number(args['ready-alternatives']) : 0;

    if (claimAndCheck || checkOnly) {
      // `--claim-and-check` implies the event: a fence that records and decides
      // without leaving a trace is exactly the silence this milestone closes.
      result = recordAndEvaluate({
        cwd,
        runId: args.run,
        unit: typeof args.unit === 'string' ? args.unit : null,
        source,
        // B2: passed ONLY when the dispatch actually resolved it. Absent flag =>
        // `code_dir: null` => scope `unknown` => fail closed. Never a fallback guess.
        codeDir: typeof args['code-dir'] === 'string' ? args['code-dir'] : undefined,
        paths: derived.paths,
        derived,
        readyAlternatives,
        posture: typeof args.posture === 'string' ? args.posture : undefined,
        wait: Boolean(args.wait),
        // R2: `--check-only` evaluates and LOGS without touching the persisted
        // claim, so a batch union recorded before the loop survives the loop.
        record: !checkOnly,
      });
    } else {
      // `--evaluate` stays exactly what T01 shipped: no write, no event. Only the
      // posture default changed — absent `--posture` now consults the pref.
      const posture = typeof args.posture === 'string'
        ? args.posture
        : resolvePostureFromPrefs(cwd).posture;
      // R1: the derived, normalised claim rides on the result. Without it the
      // consumer's `--evaluate` extraction (`.claim.paths`) threw on EVERY
      // evaluation, the catch returned `[]`, and the batch union was born empty
      // — the fence never existed in runtime. `--claim-and-check` had carried
      // `claim` since T02; `--evaluate` did not, and only the latter is safe to
      // call while deriving a union.
      result = Object.assign(evaluateGate({ cwd, runId: args.run, claim, posture, readyAlternatives }),
        { claim, claim_recorded: false });
    }
  } catch (e) {
    // ENFORCING, so this is NOT the advisory `return 0` of forge-claim-overlap:
    // an internal error must reach the caller as a failure, so it can fail
    // closed. Returning 0 here would make a broken gate look like an approval —
    // the origin defect of this milestone, reintroduced at the exit code.
    process.stderr.write(`forge-claim-gate: ${e.message}\n`);
    return 1;
  }

  process.stdout.write(args.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${formatGate(result)}\n`);
  // Exit 0 means EVALUATED — the decision itself travels in the payload, never
  // in the exit code (a `refuse` is a successful evaluation).
  return 0;
}

module.exports = {
  deriveClaimFromPlan,
  deriveClaimFromConcededItems,
  resolvePosture,
  resolvePostureFromPrefs,
  readParallelism,
  recordAndEvaluate,
  emitGateEvent,
  evaluateGate,
  formatGate,
  PARALLELISM_FALLBACKS,
  ESCALATIONS,
  GATE_DECISIONS,
  GATE_CAUSES,
  PROCEED_REASONS,
  GATE_SKIP_REASONS,
  GATE_NOTE_REASONS,
  UNCOVERED_BOUNDARIES,
  POSTURES,
  // S05/T03: exported so the suite can assert the default seam by REFERENCE
  // IDENTITY against `forge-claim-release.probeClaim` — behaviour is T02's to
  // prove, wiring is this module's.
  DEFAULT_RELEASE_PROBE,
  DEFAULT_RELEASE_CLASSIFY,
  RELEASE_SKIP_BY_MECHANISM,
  counterpartRelease,
  parseArgs,
  main,
  USAGE,
  _private: {
    ownEligibility, parseConceded, readDeferLedger, writeDeferLedger, deferLedgerPath, deferKey,
  },
};

// AFTER `module.exports` on purpose: `evaluateGate` reaches the D8 seam through
// `module.exports.resolvePosture`, so running this file as a CLI before the
// assignment threw "not a function" — measured, not hypothetical (the CLI test
// caught it). Keep this line last.
if (require.main === module) process.exit(main(process.argv.slice(2)));
