#!/usr/bin/env node
// forge-claim-audit — cross-run File Audit CORE: what a unit actually WROTE
// (VCS delta, S02) confronted against what ANOTHER run CLAIMED (S03), with a
// reconciling census, a closed verdict set and an anti-silence floor.
//
// ── Why this module exists (IN-8, D4) ──────────────────────────────────────
//
// `work-lost` is today NARRATION: a line a model wrote about itself. The whole
// point of this file is that the finding becomes produced by an artifact the
// model does NOT author. That is the TASK-021 lesson already paid for in this
// repository — the harness printed the correct hint and the session's prose
// overwrote it, and a whole slice routed 4/4 to the wrong engine while the log
// said so. So the detector derives from the VCS and from recorded claims, and
// the section (T02) is emitted by code, unconditionally.
//
// ── The locked boundary (inherited verbatim from forge-claim-overlap.js) ───
//
// THIS MODULE SIGNALS. It does not sequence runs, it does not gate a dispatch,
// it does not block a merge, it does not suggest who merges first, it does not
// persist a queue and it performs no speculative integration. Those together
// are an integration pipeline — a whole product — out of scope BY DECISION,
// not for lack of time. A plan that grows this file in that direction is wrong
// however elegant it looks from here. The suite asserts `exit 0` by SPAWNING
// the CLI, never by claiming it in a comment.
//
// ── Why the floor precedes every other branch ──────────────────────────────
//
//     pairs_compared === 0   ->  inconclusive     (BEFORE anything else)
//     findings.length > 0    ->  overlap
//     otherwise              ->  clean
//
// `clean` is an ASSERTION ABOUT WORK PERFORMED — "I confronted these pairs and
// found no collision". A comparator that emits it having confronted nothing
// reports its own inactivity as good news, and that report is byte-for-byte
// indistinguishable from a broken detector. This repository has re-learned the
// invariant three times (`forge-overlap.js`, S02's `units_measured === 0`,
// S03's `pairs_compared === 0`); here it is STRUCTURAL — the zero case cannot
// reach `clean`, and the suite forces a zero-comparison case over a NON-EMPTY
// universe rather than merely describing the rule.
//
// ── Composition, never reimplementation ────────────────────────────────────
//
//   written side      forge-unit-delta.writtenByUnit / unitKeyFor   (D6: VCS)
//   declared side     forge-write-coverage.declaredFor / discoverCorpus
//   claimed side      forge-claim-overlap.collectRunClaims / claimsConflict
//                     / codeDirScope   +  the `claim-gate` lines of events.jsonl
//   JSONL reading     forge-review-pairing.readEvents
//
// D6 is not a preference: the source of the WRITTEN side is the VCS, never the
// per-tool activity log — that equivalence was REFUTED BY MEASUREMENT in S02.
// No line of this module reads that log as the source of what was written, and
// the suite proves the absence by scanning this source with comments stripped,
// WITH a positive control (the scanner finds the word when it is planted).
//
// The intra-slice predicate of `forge-parallelism` (the one whose polarity says
// "empty list = no conflict") is likewise NOT imported and NOT referenced: that
// polarity is correct intra-slice and FORBIDDEN cross-run by D1, because
// absence of declaration is never evidence of safety. Only the glob ALGEBRA is
// reused, reached through `forge-claim-overlap.claimsConflict`.
//
// ── Posture ────────────────────────────────────────────────────────────────
//
// Advisory, and its writes are exactly two, both its own (T02): the
// `## File Audit (cross-run)` section of the target SUMMARY, and one appended
// `work-lost` line per finding. `auditClaims` itself stays read-only, which the
// suite proves by
// SHA-256 of every `.gsd/forge/runs/<run-id>.json`, of `events.jsonl` and of the
// (the glob is spelled out on purpose: a `slash-star` inside a line comment
// opens a phantom block comment for the source scanner of the suite, which
// would swallow the requires below and blind the D6/D1 guards — measured, and
// the reason the suite carries an anti-blindness floor over the same scan)
// target SUMMARY, before and after a full run.
//
// CLI:
//   node forge-claim-audit.js --slice S07 --milestone M-… [--cwd <dir>]
//                             [--code-dir <dir>] [--run <id>] [--json]
//                             [--write <SUMMARY>]

'use strict';

const fs = require('fs');
const path = require('path');

const { writtenByUnit, unitKeyFor } = require('./forge-unit-delta.js');
const { discoverCorpus, declaredFor } = require('./forge-write-coverage.js');
const {
  collectRunClaims, claimsConflict, codeDirScope, CONFLICT_CAUSES,
} = require('./forge-claim-overlap.js');
const { readEvents } = require('./forge-review-pairing.js');
const runs = require('./forge-runs.js');

// ── Verdicts ───────────────────────────────────────────────────────────────
//
// Closed set. `compareClaimAudit` may return nothing outside this list: an
// unlisted verdict string sails through every `===` a caller writes and reads
// as "nothing found", i.e. as silence.
const VERDICTS = ['overlap', 'clean', 'inconclusive'];

// ── Claim sources ──────────────────────────────────────────────────────────
//
// The two NAMED sources of the claimed side. They are distinct on purpose:
// a claim is EPHEMERAL UNTIL THE COMMIT (D2/S05), so at `complete-slice` time
// the registry may legitimately carry nothing while the history still does.
// A source that contributed ZERO appears NAMED with `contributed: 0` — never
// absent, because an absent row is indistinguishable from a source nobody
// consulted.
const CLAIM_SOURCES = [
  'run-registry', // live `write_claim` of every registered run (`collectRunClaims`), scoped to the same CODE_DIR by `codeDirScope` (D2).
  'gate-events',  // `claim-gate` lines of `.gsd/forge/events.jsonl`; their `counterparts[].paths` SURVIVE the release of the claim (D2/S05).
];

// ── Skip kinds ─────────────────────────────────────────────────────────────
//
// Which census equation a skip belongs to. The census reconciles by ARITHMETIC
// EQUALITY per kind, so a skip filed under the wrong kind breaks a test rather
// than quietly unbalancing a total.
const AUDIT_SKIP_KINDS = ['unit', 'claim-source', 'pair', 'collector'];

// ── Skip reasons ───────────────────────────────────────────────────────────
//
// Closed set, crossed BOTH WAYS by the suite (every reason this code emits is
// listed; every listed entry is emitted by >= 1 test). A value from outside
// the set is LOUD at the seam — it throws — instead of becoming an unlabelled
// string in the census that a downstream `includes` reads as absence. Same
// mould as `CONFLICT_CAUSES`/`CLAIM_NOTE_REASONS` in `forge-claim-gate.js`.
const AUDIT_SKIP_REASONS = [
  'delta-unavailable',  // kind `unit`: the VCS delta could not measure this unit. The ORIGINAL `DELTA_REASONS` value rides in `detail` — translated, never discarded.
  'no-written-files',   // kind `unit`: the unit was measured and wrote no file, so there is nothing to confront. Named, never dropped.
  'source-unavailable', // kind `claim-source`: the source could not be consulted at all (unreadable registry, unreadable log). NOT the same as a source that was read and contributed zero — that one is a named row with `contributed: 0`.
  'different-code-dir', // kind `pair`: D2 — the two sides write from DIFFERENT `code_dir`s, so identical relative paths denote different files. Pair skipped; `pairs_compared` NOT incremented.
  'same-run',           // kind `pair`: the counterpart IS the run under audit. Confronting a run with itself would manufacture a finding out of its own bookkeeping.
  'collector-failed',   // kind `collector`: a collector THREW (absent VCS, corrupt registry). The report still exists — an exception never becomes silence and never becomes a crash (S02/R2 precedent, where a reader's throw escaped the whole measurement).
];

// ── Note reasons ───────────────────────────────────────────────────────────
//
// A note is NOT a skip: the pair or unit STAYS in the comparison and the note
// records what is uncertain about it. `code-dir-unknown` in particular is
// CARRIED, never converted into a skip and never dropped — S07 transports the
// uncertainty into the census and decides no policy over it (the policy is the
// gate's, S04).
const AUDIT_NOTE_REASONS = [
  'code-dir-unknown',    // one or both sides recorded no `code_dir`. Inherited verbatim from S03 `codeDirScope`.
  'code-dir-relative',   // a side recorded a NON-ABSOLUTE `code_dir`: identity was not measured.
  'code-dir-invalid',    // a side persisted a `code_dir` that is not a string at all.
  'code-dir-unresolved', // both absolute, at least one unresolvable: the comparison degraded to lexical identity, and the degradation is named.
  'plan-legacy-schema',  // the unit's own plan carries no structured `must_haves:`, so the DECLARED side is unreadable. The unit stays compared — under D1, an unreadable declaration is not evidence of safety.
  'self-run-unknown',    // the run under audit could not be identified in the registry, so `same-run` exclusion could not be applied. Named rather than assumed harmless.
];

/** Seam: a reason from outside the closed set throws instead of leaking. */
function recordSkip(skipped, kind, id, reason, detail) {
  if (!AUDIT_SKIP_KINDS.includes(kind)) {
    throw new Error(`forge-claim-audit: kind fora de AUDIT_SKIP_KINDS: ${kind}`);
  }
  if (!AUDIT_SKIP_REASONS.includes(reason)) {
    throw new Error(`forge-claim-audit: razão fora de AUDIT_SKIP_REASONS: ${reason}`);
  }
  skipped.push({ kind, id, reason, detail: detail === undefined ? null : detail });
  return skipped;
}

/** Seam: same discipline for notes. */
function recordNote(notes, id, reason) {
  if (!AUDIT_NOTE_REASONS.includes(reason)) {
    throw new Error(`forge-claim-audit: razão fora de AUDIT_NOTE_REASONS: ${reason}`);
  }
  notes.push({ id, reason });
  return notes;
}

/** Repo-relative POSIX form, so git output and claim paths compare alike. */
function posix(p) {
  return typeof p === 'string' ? p.split('\\').join('/').replace(/^\.\//, '') : p;
}

// ── Collectors (the only code here that touches disk) ──────────────────────

/**
 * The WRITTEN side (D6): the VCS delta of S02, narrowed to this milestone/slice
 * by the COMPOSITE key `unitKeyFor` already carries. Narrowing by `S##/T##`
 * alone would collapse eleven milestones' `S04/T01` into one bucket.
 *
 * Units the delta could not measure are TRANSPORTED into `skipped[]` as
 * `delta-unavailable` carrying the original `DELTA_REASONS` value in `detail` —
 * a remainder that is renamed but never dropped.
 */
function collectWritten(cwd, opts) {
  const o = opts || {};
  const repoRoot = o.codeDir || cwd;
  const delta = (o.delta) || writtenByUnit(repoRoot, o.deltaOptions || {});
  const units = [];
  const skipped = [];

  for (const u of (delta.units || [])) {
    if (u.owner !== o.milestone) continue;
    if (o.slice && u.slice !== o.slice) continue;
    const files = (u.files || []).map(posix).filter(Boolean);
    units.push({ unit: u.unit, owner: u.owner, slice: u.slice, task: u.task, files });
  }
  for (const s of (delta.skipped || [])) {
    if (s.unit !== o.milestone) continue;
    recordSkip(skipped, 'unit', s.unit, 'delta-unavailable', s.reason);
  }

  return { vcs: delta.vcs, repo: repoRoot, units, skipped, refs_examined: delta.refs_examined || 0 };
}

/**
 * The DECLARED side: `writes:` ∪ `expected_output:` of each `T##-PLAN.md`,
 * keyed by the SAME composite key as the written side. Purely an ANNOTATION on
 * a finding (D4's partial-declaration residue is exactly what this detector
 * covers); it never removes a unit from the comparison, because under D1 an
 * unreadable declaration is not evidence of safety.
 */
function collectDeclared(cwd, opts) {
  const o = opts || {};
  const corpus = o.corpus || discoverCorpus(cwd);
  const byUnit = new Map();
  const notes = [];

  for (const unit of (corpus.units || [])) {
    if (unit.owner !== o.milestone) continue;
    if (o.slice && unit.slice !== o.slice) continue;
    const d = declaredFor(cwd, unit);
    if (d.legacy) recordNote(notes, unit.unit, 'plan-legacy-schema');
    byUnit.set(unit.unit, (d.declared || []).map(posix));
  }
  return { byUnit, notes, plans_seen: byUnit.size };
}

/** Every run id that belongs to this milestone (own id, or `milestone_dir`). */
function runIdsForMilestone(cwd, milestone) {
  const ids = new Set();
  let records = [];
  try { records = runs.listAll(cwd); } catch { records = []; }
  for (const rec of records) {
    if (!rec || typeof rec.id !== 'string') continue;
    const dirId = typeof rec.milestone_dir === 'string'
      ? (rec.milestone_dir.split('/').filter(Boolean).pop() || null)
      : null;
    if (rec.id === milestone || dirId === milestone) ids.add(rec.id);
  }
  return ids;
}

/**
 * The CLAIMED side, from BOTH named sources — and both are reported even when
 * one contributes nothing.
 *
 * `gate-events` exists because of D2/S05: the live claim is released at commit
 * time, so at `complete-slice` the registry can be legitimately empty while the
 * `counterparts[].paths` recorded in the history still name the collision. A
 * finding reachable ONLY through the history must still be found — the suite
 * proves exactly that case.
 *
 * A composite label (`a × b`) recorded by S03 for a matched pair is split back
 * into its two path operands: the label is a rendering of two real paths, and
 * re-deriving them here is reading S03's record, not inventing a path.
 */
function collectClaims(cwd, opts) {
  const o = opts || {};
  const claims = [];
  const skipped = [];
  const notes = [];
  const sources = [];
  const selfRun = o.run || null;

  // (1) run-registry — live claims.
  let registryContributed = 0;
  let runsExamined = 0;
  try {
    const collected = o.collected || collectRunClaims(cwd, { all: true });
    runsExamined = collected.runs_examined || 0;
    for (const c of collected.comparable) {
      if (selfRun && c.id === selfRun) {
        recordSkip(skipped, 'pair', c.id, 'same-run', 'run sob auditoria');
        continue;
      }
      claims.push({
        run: c.id,
        source: 'run-registry',
        paths: ((c.claim && c.claim.paths) || []).map(posix),
        claim: c.claim,
        scope_source: 'code-dir',
        scope: null,
        note: null,
      });
      registryContributed += 1;
    }
    sources.push({ source: 'run-registry', consulted: true, contributed: registryContributed, runs_examined: runsExamined });
  } catch (e) {
    recordSkip(skipped, 'claim-source', 'run-registry', 'source-unavailable', (e && e.message) || String(e));
    sources.push({ source: 'run-registry', consulted: false, contributed: 0, runs_examined: 0 });
  }

  // (2) gate-events — historical claims that survive the release.
  let eventContributed = 0;
  let eventsSeen = 0;
  let eventsInScope = 0;
  try {
    const file = o.eventsFile || path.join(cwd, '.gsd', 'forge', 'events.jsonl');
    const events = o.events || readEvents(file);
    const scopeIds = o.scopeRunIds || runIdsForMilestone(cwd, o.milestone);
    for (const ev of events) {
      if (!ev || ev.event !== 'claim-gate') continue;
      eventsSeen += 1;
      // The query boundary: only lines emitted by a run of THIS milestone. This
      // is the scope of the question, not a discarded remainder — the census
      // reports both counts so the narrowing stays visible.
      if (scopeIds.size > 0 && !scopeIds.has(ev.run)) continue;
      eventsInScope += 1;
      for (const cp of (ev.counterparts || [])) {
        if (!cp || typeof cp.id !== 'string') continue;
        if (selfRun && cp.id === selfRun) {
          recordSkip(skipped, 'pair', cp.id, 'same-run', 'contraparte é a run sob auditoria');
          continue;
        }
        const paths = [];
        for (const raw of (cp.paths || [])) {
          for (const part of String(raw).split(' × ')) {
            const p = posix(part.trim());
            if (p && !paths.includes(p)) paths.push(p);
          }
        }
        if (paths.length === 0) continue;
        claims.push({
          run: cp.id,
          source: 'gate-events',
          paths,
          claim: { paths, code_dir: null },
          // The event already recorded the measured scope, so the audit reads
          // it rather than re-deriving an identity from a `code_dir` the line
          // never carried.
          scope_source: 'event',
          scope: cp.scope === 'same' ? 'same' : 'unknown',
          note: AUDIT_NOTE_REASONS.includes(cp.note) ? cp.note : (cp.scope === 'same' ? null : 'code-dir-unknown'),
        });
        eventContributed += 1;
      }
    }
    sources.push({ source: 'gate-events', consulted: true, contributed: eventContributed, events_seen: eventsSeen, events_in_scope: eventsInScope });
  } catch (e) {
    recordSkip(skipped, 'claim-source', 'gate-events', 'source-unavailable', (e && e.message) || String(e));
    sources.push({ source: 'gate-events', consulted: false, contributed: 0, events_seen: 0, events_in_scope: 0 });
  }

  if (!selfRun) recordNote(notes, '(self)', 'self-run-unknown');

  return { claims, sources, skipped, notes };
}

// ── The pure core ──────────────────────────────────────────────────────────

/**
 * Confront every (written unit × claim of another run) pair. PURE: no disk, no
 * registry, no git — everything it needs is in `input`, which is what makes the
 * floor directly testable without a fixture.
 *
 * `pairs_compared` is incremented INSIDE the loop, once per pair actually
 * walked — never computed as `n*m` on the side. A counter derived from a
 * formula stays correct while the loop it describes fails to run: the same lie
 * in a smaller font.
 */
function compareClaimAudit(input) {
  const i = input || {};
  const codeDir = i.code_dir || null;
  const written = (i.written && i.written.units) || [];
  const claims = (i.claims && i.claims.claims) || [];
  const declaredBy = (i.declared && i.declared.byUnit) || new Map();

  const skipped = []
    .concat((i.written && i.written.skipped) || [])
    .concat((i.declared && i.declared.skipped) || [])
    .concat((i.claims && i.claims.skipped) || [])
    .concat(i.skipped || []);
  const notes = []
    .concat((i.declared && i.declared.notes) || [])
    .concat((i.claims && i.claims.notes) || [])
    .concat(i.notes || []);

  const findings = [];
  let pairs_compared = 0;
  let units_compared = 0;
  // Distinct written paths that entered the comparison. T02's `clean` sentence
  // is an ASSERTION ABOUT WORK PERFORMED, and "N pairs" alone does not say over
  // how much surface: two runs and one file is a different claim from two runs
  // and four hundred. Counted from the units actually walked, never derived.
  const pathsSeen = new Set();

  for (const unit of written) {
    if (!unit.files || unit.files.length === 0) {
      recordSkip(skipped, 'unit', unit.unit, 'no-written-files', 'delta mediu a unidade e ela não escreveu arquivo');
      continue;
    }
    units_compared += 1;
    for (const f of unit.files) pathsSeen.add(f);
    const declared = declaredBy instanceof Map ? (declaredBy.get(unit.unit) || null) : (declaredBy[unit.unit] || null);

    for (const c of claims) {
      const pairId = `${unit.unit} × ${c.run}`;

      // Scope (D2). Two provenances, one decision: an event carries the scope
      // S03 already measured; a registry claim is measured here by S03's own
      // `codeDirScope`. Neither invents an identity.
      let scope;
      let note;
      if (c.scope_source === 'event') {
        scope = c.scope;
        note = c.note;
      } else {
        const s = codeDirScope({ code_dir: codeDir }, { code_dir: (c.claim && c.claim.code_dir) || null });
        scope = s.scope;
        note = s.note;
      }
      // The note is recorded BEFORE the skip branch and independently of it —
      // a degraded comparison that ends in `different` still degraded. It is
      // CARRIED to the pair and never converted into a skip (S07 transports
      // the uncertainty; the policy over it belongs to the gate, S04).
      if (note) recordNote(notes, pairId, note);
      if (scope === 'different') {
        recordSkip(skipped, 'pair', pairId, 'different-code-dir', 'D2: árvores distintas, caminhos iguais nomeiam arquivos distintos');
        continue;
      }

      pairs_compared += 1;

      const hit = claimsConflict({ paths: unit.files, code_dir: codeDir }, c.claim);
      if (!hit) continue;
      // S03 owns this set; a cause it grows without teaching this audit must be
      // loud, never silently read as "no conflict" by an `===` below.
      if (!CONFLICT_CAUSES.includes(hit.cause)) {
        throw new Error(`forge-claim-audit: causa fora de CONFLICT_CAUSES: ${hit.cause}`);
      }
      findings.push({
        unit: unit.unit,
        counterpart_run: c.run,
        claim_source: c.source,
        cause: hit.cause,
        paths: hit.paths,
        note: note || null,
        declared_by_own_plan: declared === null ? null : hit.paths.some((p) => declared.includes(p.split(' × ')[0])),
      });
    }
  }

  findings.sort((a, b) => (`${a.unit}|${a.counterpart_run}`).localeCompare(`${b.unit}|${b.counterpart_run}`));

  const unitSkips = skipped.filter((s) => s.kind === 'unit').length;
  const sourceSkips = skipped.filter((s) => s.kind === 'claim-source').length;
  const sources = (i.claims && i.claims.sources) || [];
  const contributing = sources.filter((s) => s.contributed > 0).length;

  // ── The floor. FIRST, always. See the module header. ──────────────────────
  let verdict;
  let reason;
  if (pairs_compared === 0) {
    verdict = 'inconclusive';
    reason = `${units_compared} unidade(s) com escrita e ${claims.length} claim(s), 0 par(es) confrontado(s)`;
  } else if (findings.length > 0) {
    verdict = 'overlap';
    reason = `${findings.length} achado(s) em ${pairs_compared} par(es) confrontado(s)`;
  } else {
    verdict = 'clean';
    reason = `${pairs_compared} par(es) confrontado(s), nenhuma colisão`;
  }

  return {
    verdict,
    reason,
    milestone: i.milestone || null,
    slice: i.slice || null,
    code_dir: codeDir,
    census: {
      units_examined: units_compared + unitSkips,
      units_compared,
      claim_sources_examined: sources.length + sourceSkips,
      claim_sources_contributing: contributing,
      claims_considered: claims.length,
      pairs_compared,
      paths_compared: pathsSeen.size,
      findings: findings.length,
      skipped: skipped.length,
    },
    claim_sources: sources,
    findings,
    skipped,
    notes,
  };
}

/**
 * Orchestrate the collectors and the pure core. Every collector is wrapped:
 * a throw becomes a NAMED `collector-failed` skip and the report still exists.
 * An exception here never becomes silence and never becomes a crash.
 */
function auditClaims(options) {
  const o = options || {};
  const cwd = path.resolve(o.cwd || process.cwd());
  const codeDir = o.codeDir ? path.resolve(o.codeDir) : cwd;
  const c = o.collectors || {};
  const skipped = [];

  const run = (fn, name, fallback) => {
    try {
      return fn();
    } catch (e) {
      recordSkip(skipped, 'collector', name, 'collector-failed', (e && e.message) || String(e));
      return fallback;
    }
  };

  const written = run(
    () => (c.written || collectWritten)(cwd, { ...o, codeDir }),
    'written', { units: [], skipped: [] },
  );
  const declared = run(
    () => (c.declared || collectDeclared)(cwd, o),
    'declared', { byUnit: new Map(), notes: [] },
  );
  const claims = run(
    () => (c.claims || collectClaims)(cwd, { ...o, codeDir }),
    'claims', { claims: [], sources: [], skipped: [], notes: [] },
  );

  return compareClaimAudit({
    milestone: o.milestone || null,
    slice: o.slice || null,
    code_dir: codeDir,
    written,
    declared,
    claims,
    skipped,
  });
}

/** Human-readable rendering. The reason rides on the first line for EVERY
 * verdict, `inconclusive` included: a mute `inconclusive` repeats one level up
 * the very defect this module exists to close. */
function formatClaimAudit(result) {
  const cs = result.census;
  const lines = [];
  lines.push(`forge-claim-audit: ${result.verdict} — ${result.reason}`);
  lines.push(
    `  censo: units ${cs.units_compared}/${cs.units_examined}`
    + ` · fontes ${cs.claim_sources_contributing}/${cs.claim_sources_examined}`
    + ` · claims ${cs.claims_considered} · pares ${cs.pairs_compared}`
    + ` · achados ${cs.findings} · skipped ${cs.skipped}`,
  );
  for (const s of result.claim_sources) {
    lines.push(`  · fonte ${s.source}: contribuiu ${s.contributed}`);
  }
  for (const f of result.findings) {
    lines.push(`  ⚠ ${f.unit} × ${f.counterpart_run} — ${f.cause} (${f.claim_source}): ${f.paths.join(', ') || '(nada declarado)'}`);
  }
  for (const s of result.skipped) {
    lines.push(`  · fora da comparação [${s.kind}]: ${s.id} (${s.reason})`);
  }
  for (const n of result.notes) {
    lines.push(`  · nota: ${n.id} (${n.reason})`);
  }
  return lines.join('\n');
}

// ── The section, written BY CODE and UNCONDITIONALLY ───────────────────────
//
// The heading is `## File Audit (cross-run)`, anchored on its own literal and
// therefore DISJOINT from the intra-slice `## File Audit` that sub-step 1.6
// owns: `^## File Audit\r?$` cannot match this one and this one cannot match
// that one. Two neighbouring sections, two owners, neither overwriting the
// other — asserted in both directions by the suite.
//
// Emitted for ALL THREE verdicts, `clean` included. The instruction this
// replaces ("if both are empty, omit the section entirely") is the origin
// defect: an omitted section is byte-for-byte indistinguishable from a detector
// that never ran. A clean section therefore does not merely exist — it STATES
// THE WORK PERFORMED ("confrontei N pares sobre M caminhos"), which is a claim
// a broken detector cannot make.
const AUDIT_SECTION_HEADING = '## File Audit (cross-run)';
const AUDIT_SECTION_ANCHOR = /^## File Audit \(cross-run\)\r?$/m;

function formatClaimAuditMd(result) {
  const cs = result.census;
  const lines = [
    AUDIT_SECTION_HEADING,
    '',
    '_Advisory — o que esta slice ESCREVEU (delta de VCS) confrontado com o que OUTRA run CLAIMOU. Sinaliza; não ordena runs, não bloqueia merge, não sugere quem mergeia primeiro._',
    '',
  ];
  // Verdict + reason first, census second — the same two-line contract as the
  // human rendering, so `inconclusive` can never be read as a quiet pass.
  lines.push(`- Veredicto: **${result.verdict}** — ${result.reason}.`);
  lines.push(
    `- Censo: units ${cs.units_compared}/${cs.units_examined}`
    + ` · fontes ${cs.claim_sources_contributing}/${cs.claim_sources_examined}`
    + ` · claims ${cs.claims_considered} · pares ${cs.pairs_compared}`
    + ` · caminhos ${cs.paths_compared} · achados ${cs.findings} · skipped ${cs.skipped}.`,
  );

  if (result.verdict === 'overlap') {
    for (const f of result.findings) {
      const paths = f.paths.length ? f.paths.map((p) => `\`${p}\``).join(', ') : '(nenhum caminho nomeado)';
      const declared = f.declared_by_own_plan === null
        ? 'declaração do próprio plano ilegível'
        : (f.declared_by_own_plan ? 'declarado no próprio plano' : 'NÃO declarado no próprio plano');
      lines.push(`- ⚠ \`${f.unit}\` × run \`${f.counterpart_run}\` — ${f.cause} (fonte: ${f.claim_source}): ${paths} — ${declared}.`);
      if (f.note) lines.push(`  - nota: ${f.note} (incerteza transportada, não resolvida aqui).`);
    }
  } else if (result.verdict === 'clean') {
    lines.push(`- Confrontei ${cs.pairs_compared} par(es) sobre ${cs.paths_compared} caminho(s) escrito(s) e não achei colisão.`);
  } else {
    lines.push(`- Inconclusivo: ${result.reason}. Não é uma afirmação de limpeza — nenhum par foi confrontado, então nada foi verificado.`);
  }

  for (const s of result.claim_sources) {
    lines.push(`- Fonte \`${s.source}\`: consultada=${s.consulted}, contribuiu ${s.contributed}.`);
  }
  // Every discarded row surfaces with its reason. A census that reconciles but
  // does not enumerate is a gate that counts without naming.
  for (const s of result.skipped) {
    lines.push(`- Fora da comparação [${s.kind}]: \`${s.id}\` — ${s.reason}${s.detail ? ` (${s.detail})` : ''}.`);
  }
  for (const n of result.notes) {
    lines.push(`- Nota: \`${n.id}\` — ${n.reason}.`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Upsert the section into a SUMMARY. Mould: `forge-route-audit.upsertRouteSection`
 * — no second section-writing mechanism enters this repo.
 *
 * Three NAMED refusals, and on each of them the target keeps its bytes: a write
 * that cannot be proven safe does not happen partially and does not happen
 * quietly somewhere else.
 */
function upsertClaimAuditSection(summaryPath, md, cwd) {
  try {
    if (!fs.existsSync(summaryPath)) return { written: false, reason: 'target-missing' };
    const stat = fs.lstatSync(summaryPath);
    if (stat.isSymbolicLink()) return { written: false, reason: 'target-symlink' };
    const root = fs.realpathSync(path.resolve(cwd || process.cwd(), '.gsd'));
    const realParent = fs.realpathSync(path.dirname(summaryPath));
    const target = path.resolve(realParent, path.basename(summaryPath));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return { written: false, reason: 'outside-gsd' };

    // Operate on the ORIGINAL bytes. Normalizing the whole file would rewrite
    // line endings in sections this tool does not own; only the injected
    // section is normalized, and it adopts the file's own convention.
    const current = fs.readFileSync(summaryPath, 'utf8');
    const crlf = /\r\n/.test(current);
    const eol = crlf ? '\r\n' : '\n';
    const section = md.replace(/\r\n/g, '\n').replace(/\n*$/, '\n').replace(/\n/g, eol);

    let next;
    const hit = AUDIT_SECTION_ANCHOR.exec(current);
    if (hit) {
      const tail = current.slice(hit.index + hit[0].length);
      const nextHeader = /^## /m.exec(tail);
      const end = nextHeader ? hit.index + hit[0].length + nextHeader.index : current.length;
      next = current.slice(0, hit.index) + section + (nextHeader ? `${eol}${current.slice(end)}` : '');
    } else {
      const anchors = [/^## Checker Memory/m, /^## ⚠ Review Flags/m, /^## Security Flags/m, /^## Forward Intelligence/m, /^## Drill/m];
      const anchor = anchors.map((re) => re.exec(current)).find(Boolean);
      next = anchor
        ? current.slice(0, anchor.index).replace(/[\r\n]*$/, eol + eol) + section + eol + current.slice(anchor.index)
        : current.replace(/[\r\n]*$/, eol + eol) + section;
    }
    if (next !== current) fs.writeFileSync(summaryPath, next, 'utf8');
    return { written: true, reason: null };
  } catch (error) { return { written: false, reason: error.code || error.message }; }
}

// ── The event, written BY CODE ─────────────────────────────────────────────
//
// Why the event name did NOT change (SCOPE open question (e)): `work-lost`
// already names this fact in the histories that exist, and renaming it would
// orphan every historical line — the reader would have to know both names to
// see one phenomenon. The legibility of the narrated lines is kept; what is
// added is the ability to TELL THEM APART, through an ADDITIVE marker. An old
// reader ignoring the two keys stays correct; a new one can say whether the
// line was measured by a detector or written by a model about itself.
const WORK_LOST_EMITTER = 'forge-claim-audit';
const WORK_LOST_ORIGINS = ['code', 'narrated'];

/**
 * Classify one `work-lost` line. Accepts the raw JSON string or the parsed
 * object. Closed set `{ code, narrated }`; a line that is not `work-lost` at
 * all is LOUD here rather than silently bucketed as narrated.
 */
function originOf(line) {
  let ev = line;
  if (typeof line === 'string') {
    try { ev = JSON.parse(line); } catch (e) {
      throw new Error(`forge-claim-audit: linha work-lost ilegível: ${(e && e.message) || String(e)}`);
    }
  }
  if (!ev || typeof ev !== 'object' || ev.event !== 'work-lost') {
    throw new Error(`forge-claim-audit: originOf só classifica linhas work-lost, veio: ${ev && ev.event}`);
  }
  if (ev.origin === 'code' && ev.emitter === WORK_LOST_EMITTER) return 'code';
  // No marker: the hand-written historical form. Named, never discarded.
  return 'narrated';
}

/**
 * Append ONE `work-lost` line PER FINDING to `.gsd/forge/events.jsonl` of the
 * WORKSPACE `cwd` (never the CODE_DIR — the log lives with the artifacts).
 *
 * Field shape follows the historical narrated line verbatim (`milestone`,
 * `slice`, `unit`, `cause`, `other_run`, `files`) so both forms read alike,
 * plus the additive origin marker. Mould: `forge-claim-gate.emitGateEvent` —
 * a failure to log NEVER swallows the finding and never hides that it failed.
 */
function emitWorkLostEvent(cwd, result) {
  if (result.verdict !== 'overlap' || result.findings.length === 0) {
    return { event_written: false, event_error: null, event_lines: 0, event_skipped: 'no-finding' };
  }
  const file = path.join(path.resolve(cwd || process.cwd()), '.gsd', 'forge', 'events.jsonl');
  const payload = result.findings.map((f) => JSON.stringify({
    ts: new Date().toISOString(),
    event: 'work-lost',
    milestone: result.milestone,
    slice: result.slice,
    unit: f.unit,
    cause: f.cause,
    other_run: f.counterpart_run,
    files: f.paths,
    claim_source: f.claim_source,
    declared_by_own_plan: f.declared_by_own_plan,
    // ADDITIVE marker — see WORK_LOST_ORIGINS above.
    origin: 'code',
    emitter: WORK_LOST_EMITTER,
  })).join('\n');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${payload}\n`, 'utf8');
    return { event_written: true, event_error: null, event_lines: result.findings.length, event_skipped: null };
  } catch (e) {
    return { event_written: false, event_error: (e && e.message) || String(e), event_lines: 0, event_skipped: null };
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────
const USAGE = [
  'uso: node scripts/forge-claim-audit.js --slice <S##> --milestone <id>',
  '                                       [--cwd <dir>] [--code-dir <dir>]',
  '                                       [--run <id>] [--json]',
  '                                       [--write <SUMMARY.md>]',
  '',
  'Sinal advisory cross-run: confronta o que a unidade ESCREVEU (delta de VCS)',
  'contra o que OUTRA run CLAIMOU (registry vivo + histórico claim-gate).',
  'SEMPRE sai com exit 0.',
  '',
  'Veredictos: overlap | clean | inconclusive.',
  '`clean` exige ter confrontado ao menos um par; sem par, o veredicto é',
  '`inconclusive` — nunca `clean`.',
  '',
  'Com --write, o script é o dono da seção `## File Audit (cross-run)` do SUMMARY',
'e a escreve nos TRÊS veredictos — seção omitida é indistinguível de detector',
'quebrado. O evento `work-lost` (origin: code) é appendado só em `overlap`.',
].join('\n');

function parseArgs(argv) {
  const out = { slice: null, milestone: null, cwd: null, codeDir: null, run: null, write: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--slice') out.slice = argv[++i];
    else if (a === '--milestone') out.milestone = argv[++i];
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--code-dir') out.codeDir = argv[++i];
    else if (a === '--run') out.run = argv[++i];
    else if (a === '--write') out.write = argv[++i];
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.milestone) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = auditClaims({
      cwd: args.cwd, codeDir: args.codeDir, milestone: args.milestone, slice: args.slice, run: args.run,
    });
    if (args.write) {
      const cwd = path.resolve(args.cwd || process.cwd());
      // The section FIRST, and unconditionally: it is written even when the
      // event fails, and even when the verdict is clean. Order matters — a
      // logging failure must never be able to suppress the finding's rendering.
      const up = upsertClaimAuditSection(path.resolve(args.write), formatClaimAuditMd(result), cwd);
      result.write = up;
      const ev = emitWorkLostEvent(cwd, result);
      Object.assign(result, ev);
      process.stderr.write(up.written
        ? `forge-claim-audit: cross-run file audit: ${args.write}\n`
        : `forge-claim-audit: refused: ${up.reason}\n`);
      if (ev.event_error) process.stderr.write(`forge-claim-audit: evento work-lost NÃO registrado: ${ev.event_error}\n`);
    }
    process.stdout.write(args.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${formatClaimAudit(result)}\n`);
  } catch (e) {
    // Advisory: an unreadable corpus is REPORTED — loud on stderr — never fatal
    // to a caller's loop. Same posture as forge-route-audit.js / forge-overlap.js.
    process.stderr.write(`forge-claim-audit: ${(e && e.message) || String(e)}\n`);
    return 0;
  }
  // Return 0 UNCONDITIONALLY, including when `verdict === 'overlap'`. This
  // signal informs; nothing here refuses, blocks or sequences anything. Making
  // this reflect the verdict is the single edit that converts an advisory
  // detector into the integration pipeline S07 declared out of scope.
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  VERDICTS,
  CLAIM_SOURCES,
  AUDIT_SKIP_KINDS,
  AUDIT_SKIP_REASONS,
  AUDIT_NOTE_REASONS,
  recordSkip,
  recordNote,
  collectWritten,
  collectDeclared,
  collectClaims,
  compareClaimAudit,
  auditClaims,
  formatClaimAudit,
  formatClaimAuditMd,
  upsertClaimAuditSection,
  emitWorkLostEvent,
  originOf,
  AUDIT_SECTION_HEADING,
  AUDIT_SECTION_ANCHOR,
  WORK_LOST_EMITTER,
  WORK_LOST_ORIGINS,
  runIdsForMilestone,
  parseArgs,
  main,
  USAGE,
};
