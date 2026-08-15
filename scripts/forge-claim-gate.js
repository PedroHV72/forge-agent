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
const { normalizeClaim, CLAIM_SOURCES } = require('./forge-write-claim.js');
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
];

const GATE_NOTE_REASONS = [
  'own-claim-ineligible-no-counterpart', // the own side did not declare, but nobody is in scope to be harmed by it.
                                         // Visible, never punished into a refuse without a counterpart (D1).
  'posture-invalid',                     // the posture given is outside {defer, block}; fell back to `defer`, named.
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
    reason: 'o release do claim pelo completer colide com o release de IN-6 (S05) — Deferred do CONTEXT',
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
    inScope.push({
      id: c.id,
      claim: c.claim,
      scope,
      note: note || null,
      record: activeById.get(c.id) || runs.get(cwd, c.id),
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

// ── Rendering ──────────────────────────────────────────────────────────────

function formatGate(result) {
  const lines = [];
  const tail = result.cause ? ` — ${result.cause}` : (result.reason ? ` — ${result.reason}` : '');
  lines.push(`forge-claim-gate: ${result.decision}${tail}`);
  if (result.floor) lines.push(`  piso: ${result.floor} (defer sem alternativa nunca prossegue — D3)`);
  if (result.undeclared_side) lines.push(`  lado não declarado: ${result.undeclared_side}`);
  if (result.paths && result.paths.length > 0) lines.push(`  caminhos: ${result.paths.join(', ')}`);
  const c = result.census;
  lines.push(
    `  censo: runs ${c.runs_examined} · counterparts ${c.counterparts_considered}`
    + ` · em escopo ${c.counterparts_in_scope} · skipped ${c.skipped.length} · notes ${c.notes.length}`,
  );
  for (const s of c.skipped) lines.push(`  · fora de escopo: ${s.id} (${s.reason})`);
  for (const n of c.notes) lines.push(`  · ${n.id} (${n.reason})`);
  for (const b of result.not_covered) lines.push(`  · fronteira não coberta: ${b.boundary} — ${b.reason}`);
  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────

const USAGE = [
  'uso: node scripts/forge-claim-gate.js --evaluate (--plan <p> | --conceded <json|@file> | --paths <csv>)',
  '                                      --run <id> [--code-dir <p>] [--posture defer|block]',
  '                                      [--ready-alternatives <n>] [--cwd <dir>] [--json]',
  '',
  'Decide se a unidade pode despachar dado o claim próprio e os claims das runs',
  'ativas que dividem o mesmo CODE_DIR.',
  '',
  'Decisões: proceed | defer | block | refuse.',
  'Causas: overlap | undeclared-writes | pathless-conceded-item — nunca uma no lugar da outra.',
  'Razões de proceed: no-active-counterpart (não confrontou nada) | no-conflict (confrontou, limpo).',
  '',
  'Este gate é ENFORCING: erro interno sai com exit != 0. O consumidor que',
  'receber exit != 0 ou stdout não-JSON trata como block/gate-unavailable.',
  '',
  'Flags:',
  '  --evaluate                 avalia e emite a decisão',
  '  --plan <path>              deriva o claim de um T##-PLAN.md (writes: ∪ expected_output:)',
  '  --conceded <json|@file>    deriva o claim dos itens concedidos [{r, path, line}] (D7)',
  '  --paths <csv>              claim explícito (operador/teste)',
  '  --run <id>                 a run própria (excluída do universo de counterparts)',
  '  --code-dir <p>             fato DADO pelo dispatch; ausente => code_dir null => escopo unknown',
  '  --posture defer|block      postura em caso de colisão (default: defer)',
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
  if (args.help || !args.evaluate) {
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

    result = evaluateGate({
      cwd,
      runId: args.run,
      claim,
      posture: typeof args.posture === 'string' ? args.posture : 'defer',
      readyAlternatives: typeof args['ready-alternatives'] === 'string'
        ? Number(args['ready-alternatives']) : 0,
    });
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
  evaluateGate,
  formatGate,
  GATE_DECISIONS,
  GATE_CAUSES,
  PROCEED_REASONS,
  GATE_SKIP_REASONS,
  GATE_NOTE_REASONS,
  UNCOVERED_BOUNDARIES,
  POSTURES,
  parseArgs,
  main,
  USAGE,
  _private: { ownEligibility, parseConceded },
};

// AFTER `module.exports` on purpose: `evaluateGate` reaches the D8 seam through
// `module.exports.resolvePosture`, so running this file as a CLI before the
// assignment threw "not a function" — measured, not hypothetical (the CLI test
// caught it). Keep this line last.
if (require.main === module) process.exit(main(process.argv.slice(2)));
