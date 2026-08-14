#!/usr/bin/env node
// forge-resources-census — advisory reader over the resource-control event
// stream, with a consolidated reason registry and an anti-silence floor.
//
// ── This module READS (S05-PLAN.md § Goal, CONTEXT D10) ────────────────────
//
// S01–S04 own sizing, admission, pooling and command rewriting. NOTHING here
// decides how many workers to run, how much heap to grant, or whether to
// admit. This file consumes the stream those slices already emit and turns it
// into a census. A future edit that computes a budget here would put a second
// sizing rule in the codebase — the exact defect D10 ("formula-once") exists
// to prevent. `forge-resources.js` is the single owner; this is a consumer.
//
// ── The one property (inherited verbatim from forge-overlap.js:17-37) ──────
//
// `clean` and `inconclusive` are DIFFERENT verdicts and this code may never
// confuse them. `clean` is a CLAIM ABOUT WORK DONE — "I scanned a real stream
// and found no degradation". A reader that answers `clean` having scanned
// nothing is reporting its own inactivity as good news, and that report is
// byte-for-byte indistinguishable from a broken detector.
//
// The floor therefore has TWO halves, and the second is the one this slice
// exists for:
//
//   events_scanned  === 0  ->  inconclusive   (`events-file-empty`)
//   resource_events === 0  ->  inconclusive   (`no-resource-events`)
//
// The second half is NOT redundant. `.gsd/forge/events.jsonl` is shared with
// the dispatch stream, so a log holding 900 `dispatch` lines and zero resource
// lines has `events_scanned === 900`. Under a floor testing only the first
// half, that log reads `clean` — i.e. "resource control healthy" asserted from
// a stream in which resource control never appeared. That is precisely the
// pathology S05-PLAN.md § names: "reportaria zero como saúde". Both halves are
// asserted by dedicated tests.
//
// MEASURED during T01, and worth stating because it is counter-intuitive: the
// second half SUBSUMES the first, since `events_scanned === 0` necessarily
// implies `resource_events === 0`. The first branch is therefore kept for the
// REASON it produces, not for the verdict it reaches — `events-file-empty`
// ("nothing was written at all") and `no-resource-events` ("plenty was written,
// none of it ours") send a reader to two completely different investigations,
// and collapsing them would lose that. The suite proves exactly this: mutating
// the first half leaves the verdict `inconclusive` and DEGRADES THE REASON,
// while mutating both halves produces the lying `clean`.
//
// ── Two field names, both real (S05-PLAN.md § O stream tem DOIS nomes) ─────
//
// MEASURED at the producers, not inferred, and NOT to be "normalised" away:
//
//   kind   forge-resources.js:421,442,513,535   shadow-wait, resource-admission,
//                                               resource-degradation,
//                                               resource-pool-{granted,released}
//   kind   forge-resource-pool.js:170           stale-lease-reaped
//   kind   forge-verify.js:289,333,347,380      resource-clamp-{applied,skipped}
//          forge-reverify.js:236,249,262
//   event  forge-hook.js:795,820                rewrite-{applied,skipped}
//
// A reader looking only at `kind` would lose 100% of S03's rewrite stream.
// Hence `line.kind ?? line.event`, accepting BOTH.
//
// ── Keyed on the REASON, not the kind ──────────────────────────────────────
//
// `platform-unsupported:linux` degrades FAIL-OPEN (`admit: true`), so it is
// written as `kind: resource-admission` — never as `resource-degradation`.
// Counting degradation by `kind` would see no platform degradation at all.
// The census aggregates on the reason; `kind` is a secondary dimension.
//
// Also measured: every producer spreads its payload at the TOP level
// (`JSON.stringify({ ts, kind, ...payload })`), so the reason lives at
// `line.reason` — there is no nested `payload` object to walk.
//
// ── Posture ────────────────────────────────────────────────────────────────
//
// Read-only and advisory. Never writes. Never spawns (the statusline consumer
// in T03 renders continuously; a spawn on that path is forbidden by
// S05-PLAN.md § Statusline). `readLastResourceEvent` reads a BOUNDED TAIL, so
// an events log that grows without limit never costs the renderer more than
// `tailBytes`.
//
// CLI:
//   node forge-resources-census.js --check [--json] [--cwd <dir>]

'use strict';

const fs = require('fs');
const path = require('path');

const { REASON_CODES } = require('./forge-resources.js');
const { POOL_REASON_CODES } = require('./forge-resource-pool.js');
const {
  TOKENIZE_REFUSAL_REASONS,
  REWRITE_REASON_CODES,
} = require('./forge-command-rewrite.js');

// ── Verdicts ─────────────────────────────────────────────────────────────
//
// Closed set. `buildCensus` may return nothing outside this list — an
// unlisted verdict string would sail through every `===` a caller writes and
// read as "not degraded", i.e. as silence.
const CENSUS_VERDICTS = ['degraded', 'clean', 'inconclusive'];

// ── Reason registry ──────────────────────────────────────────────────────
//
// Built by ITERATING the four frozen enums the producers already export.
// Not one reason string is retyped here as a literal. That is the whole point:
// a reason added to `REASON_CODES` tomorrow is registered here the moment it
// exists, with no second edit and no chance of a typo minting a phantom
// "unregistered" reason. Retyping any of these strings — even one, even to
// "make the map readable" — reintroduces the drift this construction removes.
const REASON_OWNERS = Object.freeze(['resources', 'pool', 'tokenize', 'rewrite']);

const ENUMS_BY_OWNER = Object.freeze({
  resources: REASON_CODES,
  pool: POOL_REASON_CODES,
  tokenize: TOKENIZE_REFUSAL_REASONS,
  rewrite: REWRITE_REASON_CODES,
});

function buildReasonRegistry() {
  const out = {};
  for (const owner of REASON_OWNERS) {
    const enumObj = ENUMS_BY_OWNER[owner] || {};
    for (const code of Object.keys(enumObj)) {
      const value = enumObj[code];
      if (typeof value !== 'string' || value.length === 0) continue;
      // First owner wins. No value is currently shared across two enums; if
      // one ever is, the census keeps the earlier owner rather than silently
      // reclassifying it on import order.
      if (!Object.prototype.hasOwnProperty.call(out, value)) {
        out[value] = Object.freeze({ code, owner });
      }
    }
  }
  return Object.freeze(out);
}

const REASON_REGISTRY = buildReasonRegistry();

// ── Degradation set ──────────────────────────────────────────────────────
//
// Which reasons mean "resource control could not do its job as designed, or
// the machine is under critical pressure". Built from enum MEMBERS, never
// from retyped strings, so it cannot drift from the registry above.
//
// Deliberately EXCLUDED, with cause:
//   pool-granted / pool-released / pool-clamped-by-pool
//       the pool working exactly as designed; a clamp is the feature, not a
//       fault.
//   pressure-normal / pressure-warn
//       measured, healthy states.
//   shadow-wait
//       shadow mode is the DESIGNED posture this milestone ships under
//       (CONTEXT D3, enforcement deferred). Counting it as degradation would
//       make every healthy run read `degraded`, and a verdict that is always
//       degraded carries no signal.
//   tokenize-refused:* / intact:* / rewritten:*
//       normal rewrite outcomes. A command that cannot be tokenised is a
//       COVERAGE fact (it is counted and shown in the census), not a fault of
//       the control.
const DEGRADATION_REASONS = Object.freeze(new Set([
  REASON_CODES.PLATFORM_UNSUPPORTED_LINUX,
  REASON_CODES.PLATFORM_UNSUPPORTED_WIN32,
  REASON_CODES.PLATFORM_UNSUPPORTED_OTHER,
  REASON_CODES.SYSCTL_SPAWN_FAILED,
  REASON_CODES.SYSCTL_PARSE_FAILED,
  REASON_CODES.INTERNAL_ERROR_DEGRADED,
  REASON_CODES.PRESSURE_CRITICAL_MEASURED,
  REASON_CODES.PRESSURE_CRITICAL_FORCED,
  POOL_REASON_CODES.POOL_UNAVAILABLE_FAIL_OPEN,
  POOL_REASON_CODES.POOL_EXHAUSTED_MINIMUM_GRANT,
  POOL_REASON_CODES.STALE_LEASE_REAPED,
]));

// ── Resource event names ─────────────────────────────────────────────────
//
// These are EVENT NAMES, not reason codes — no producer exports them as a
// frozen enum, so they are named here (this is not the "retyped reason
// string" the registry above forbids). Anything outside this set is another
// stream sharing the same file (`dispatch`, `worker-engine-fallback`, ...):
// counted, skipped with a name, never silently dropped.
//
// TWO of them are NOT written as literals, because for those two the event
// name and the reason code are THE SAME STRING at the producer:
// `shadow-wait` (forge-resources.js:421) and `stale-lease-reaped`
// (forge-resource-pool.js:170, where the `kind` IS the reason code). Binding
// them to the enum members makes that coincidence machine-enforced: if either
// enum value is ever renamed, this set follows automatically instead of
// silently ceasing to match the stream it is meant to recognise.
const RESOURCE_EVENT_NAMES = Object.freeze(new Set([
  REASON_CODES.SHADOW_WAIT,
  'resource-admission',
  'resource-degradation',
  'resource-pool-granted',
  'resource-pool-released',
  POOL_REASON_CODES.STALE_LEASE_REAPED,
  'resource-clamp-applied',
  'resource-clamp-skipped',
  'rewrite-applied',
  'rewrite-skipped',
]));

const REWRITE_EVENT_NAMES = Object.freeze(new Set(['rewrite-applied', 'rewrite-skipped']));

// ── Skip reasons ─────────────────────────────────────────────────────────
//
// Why a line, or a whole file, did not become a census entry. Closed enum;
// the suite crosses it in BOTH directions — every reason emitted is listed,
// and every listed reason is emitted by at least one test. A one-directional
// check lets a dead entry rot or an undocumented one leak.
const CENSUS_SKIP_REASONS = Object.freeze([
  'events-file-missing',        // `.gsd/forge/events.jsonl` absent. Distinct from present-and-empty: nothing was ever written vs. nothing matched.
  'events-file-unreadable',     // present but `readFileSync` threw (permissions, a directory in its place, an I/O fault).
  'line-not-json',              // a malformed line. Counted and NAMED; the remaining lines keep being read — one bad append never blinds the census.
  'line-without-event-name',    // valid JSON carrying neither `kind` nor `event`.
  'event-not-resource-related', // a real event from another stream sharing the file. Counted, never invisible.
  'evidence-log-empty',         // W3: no evidence file, or zero `Bash` lines in them.
  'evidence-file-unreadable',   // W3: an evidence file that could not be read.
]);

const SKIP_REASON_SET = new Set(CENSUS_SKIP_REASONS);

/** Guard: only an enumerated skip reason may ever reach a report. */
function namedSkip(id, reason) {
  return {
    id,
    reason: SKIP_REASON_SET.has(reason) ? reason : 'line-not-json',
  };
}

function eventsFilePath(cwd, opts) {
  const o = opts || {};
  if (o.eventsFile) return o.eventsFile;
  return path.join(cwd, '.gsd', 'forge', 'events.jsonl');
}

/**
 * Read the event stream and split every line into an entry or a named skip.
 *
 * Returns `{ events_scanned, resource_events, entries[], skipped[], sources[] }`.
 *
 * `events_scanned` counts every NON-EMPTY line the reader walked, including
 * lines belonging to other streams and lines that failed to parse. It is a
 * by-product of the walk, incremented in the loop — never a length computed on
 * the side. A counter derived from a formula stays correct while the loop it
 * describes fails to run, which is the same lie in a smaller font.
 */
function collectResourceEvents(cwd, opts) {
  const o = opts || {};
  const file = eventsFilePath(cwd, o);

  const entries = [];
  const skipped = [];
  const sources = [];
  let events_scanned = 0;
  let resource_events = 0;

  let raw;
  try {
    if (!fs.existsSync(file)) {
      skipped.push(namedSkip(file, 'events-file-missing'));
      return { events_scanned, resource_events, entries, skipped, sources };
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    skipped.push(namedSkip(file, 'events-file-unreadable'));
    return { events_scanned, resource_events, entries, skipped, sources };
  }

  sources.push(file);

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    events_scanned += 1;
    const id = `${file}:${i + 1}`;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped.push(namedSkip(id, 'line-not-json'));
      continue;
    }

    if (!parsed || typeof parsed !== 'object') {
      skipped.push(namedSkip(id, 'line-not-json'));
      continue;
    }

    // BOTH field names, by measurement. See the header.
    const name = parsed.kind !== undefined && parsed.kind !== null
      ? parsed.kind
      : parsed.event;

    if (typeof name !== 'string' || name === '') {
      skipped.push(namedSkip(id, 'line-without-event-name'));
      continue;
    }

    if (!RESOURCE_EVENT_NAMES.has(name)) {
      skipped.push(namedSkip(id, 'event-not-resource-related'));
      continue;
    }

    resource_events += 1;
    entries.push({
      id,
      name,
      // Producers spread the payload at the top level, so the reason is here.
      reason: typeof parsed.reason === 'string' && parsed.reason !== ''
        ? parsed.reason
        : null,
      ts: typeof parsed.ts === 'string' || typeof parsed.ts === 'number' ? parsed.ts : null,
    });
  }

  return { events_scanned, resource_events, entries, skipped, sources };
}

/**
 * Aggregate entries by reason and reach a verdict.
 *
 * PURE. No disk, no writes. Everything it needs is in `collected`, which makes
 * the floor directly testable without a fixture.
 *
 * ── Verdict order is FIXED and the floor is FIRST ──────────────────────────
 *
 *     events_scanned  === 0  ->  inconclusive
 *     resource_events === 0  ->  inconclusive
 *     degraded_count   > 0   ->  degraded
 *     otherwise              ->  clean
 *
 * Reordering these branches, or short-circuiting to `clean` before the floor,
 * reintroduces the whole bug class described in the header. Both floor halves
 * are proven to BITE by tests that mutate them and observe RED.
 *
 * A reason absent from `REASON_REGISTRY` becomes `reason-unregistered:<value>`
 * with `registered: false` — counted and shown, NEVER discarded. A reason that
 * appears tomorrow rises in the census under its own label instead of
 * vanishing. (Direct precedent: `repo-skip-unclassified`, forge-overlap.js:95.)
 * An unregistered reason does NOT flip the verdict to `degraded`: unknown is
 * not the same as broken, and inventing degradation from an unrecognised
 * string would make the verdict unreliable in the other direction. It is
 * surfaced through `unregistered_reasons` instead.
 */
function buildCensus(collected) {
  const c = collected || {};
  const entries = Array.isArray(c.entries) ? c.entries : [];
  const skipped = Array.isArray(c.skipped) ? c.skipped.slice() : [];
  const sources = Array.isArray(c.sources) ? c.sources.slice() : [];
  const events_scanned = c.events_scanned || 0;
  const resource_events = c.resource_events || 0;

  const byReason = new Map();
  let degraded_count = 0;
  let unregistered_reasons = 0;

  for (const e of entries) {
    // When the event carries no reason, the event NAME is the key. This is the
    // `stale-lease-reaped` case (where `kind` IS the reason code) and the
    // `rewrite-applied` case (forge-hook.js:795 emits `{runner, workers,
    // heapMb}` and no reason at all — measured, not assumed).
    const fromEventName = e.reason === null || e.reason === undefined;
    const rawReason = fromEventName ? e.name : e.reason;
    const known = Object.prototype.hasOwnProperty.call(REASON_REGISTRY, rawReason);
    const key = known ? rawReason : `reason-unregistered:${rawReason}`;

    let row = byReason.get(key);
    if (!row) {
      row = {
        reason: key,
        raw_reason: rawReason,
        count: 0,
        owner: known ? REASON_REGISTRY[rawReason].owner : null,
        registered: known,
        // Distinguishes "a reason string not in the registry" from "the event
        // carried no reason and the key was derived from its name". Both are
        // unregistered; only the reader can tell which matters.
        from_event_name: fromEventName,
        kinds: [],
      };
      byReason.set(key, row);
      if (!known) unregistered_reasons += 1;
    }
    row.count += 1;
    if (!row.kinds.includes(e.name)) row.kinds.push(e.name);
    if (known && DEGRADATION_REASONS.has(rawReason)) degraded_count += 1;
  }

  const reasons = Array.from(byReason.values())
    .sort((a, b) => (b.count - a.count) || String(a.reason).localeCompare(String(b.reason)));

  let verdict;
  let reason;
  if (events_scanned === 0) {
    verdict = 'inconclusive';
    reason = 'nenhum evento examinado (events-file-empty)';
  } else if (resource_events === 0) {
    verdict = 'inconclusive';
    reason = `${events_scanned} evento(s) examinado(s), nenhum de recursos (no-resource-events)`;
  } else if (degraded_count > 0) {
    verdict = 'degraded';
    reason = `${degraded_count} evento(s) de degradação em ${resource_events} de recursos`;
  } else {
    verdict = 'clean';
    reason = `${resource_events} evento(s) de recursos examinado(s), nenhuma degradação`;
  }

  return {
    verdict,
    reason,
    events_scanned,
    resource_events,
    degraded_count,
    unregistered_reasons,
    reasons,
    skipped,
    sources,
  };
}

// ── W3 reconciliation ────────────────────────────────────────────────────

function evidenceFiles(cwd, opts) {
  const o = opts || {};
  if (Array.isArray(o.evidenceFiles)) return o.evidenceFiles;
  const dir = o.evidenceDir || path.join(cwd, '.gsd', 'forge');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith('evidence-') && f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Reconcile rewrite candidates against the Bash evidence log — BY COUNT.
 *
 * ── Why counting, and never string matching ────────────────────────────────
 *
 * Three MEASURED facts make pairing an evidence line to a rewrite event
 * impossible, so this function does not attempt it and no future edit should:
 *
 *   1. `.gsd/forge/evidence-*.jsonl` was EMPTY through S01→S03 (Forward
 *      Intelligence of all three slices). Absent evidence yields
 *      `unreconciled`; it never yields an assertion of 100% coverage.
 *   2. The hook truncates `cmd` at 200 bytes (forge-hook.js:864), so exact
 *      textual comparison is impossible for any real test command.
 *   3. The REWRITTEN command differs from the original by construction, so
 *      even untruncated the two strings would not be equal.
 *
 * Hence: `non_candidates = bash_total - rewrite_events`, and the anomaly
 * `rewrite_events > bash_total` is NAMED (`candidates-exceed-evidence`) rather
 * than clamped to zero. Hiding it behind a `Math.max(0, …)` would turn a real
 * inconsistency — more clamp decisions than Bash calls, which cannot happen if
 * both logs describe the same run — into a plausible-looking zero.
 */
function reconcileW3(cwd, censusOrCollected, opts) {
  const o = opts || {};
  const src = censusOrCollected || {};

  let rewrite_events = 0;
  if (Array.isArray(src.entries)) {
    for (const e of src.entries) {
      if (REWRITE_EVENT_NAMES.has(e.name)) rewrite_events += 1;
    }
  } else if (Array.isArray(src.reasons)) {
    for (const r of src.reasons) {
      for (const k of (r.kinds || [])) {
        if (REWRITE_EVENT_NAMES.has(k)) { rewrite_events += r.count; break; }
      }
    }
  }

  const files = evidenceFiles(cwd, o);
  const skipped = [];
  let bash_total = 0;
  let evidence_lines = 0;

  for (const f of files) {
    let raw;
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch {
      skipped.push(namedSkip(f, 'evidence-file-unreadable'));
      continue;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      evidence_lines += 1;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipped.push(namedSkip(f, 'evidence-file-unreadable'));
        continue;
      }
      if (parsed && parsed.tool === 'Bash') bash_total += 1;
    }
  }

  if (files.length === 0 || bash_total === 0) {
    skipped.push(namedSkip(o.evidenceDir || path.join(cwd, '.gsd', 'forge'), 'evidence-log-empty'));
    return {
      status: 'unreconciled',
      reason: 'evidence-log-empty',
      bash_total,
      rewrite_events,
      evidence_files: files.length,
      evidence_lines,
      skipped,
    };
  }

  if (rewrite_events > bash_total) {
    return {
      status: 'inconsistent',
      reason: 'candidates-exceed-evidence',
      bash_total,
      rewrite_events,
      evidence_files: files.length,
      evidence_lines,
      skipped,
    };
  }

  return {
    status: 'reconciled',
    reason: null,
    bash_total,
    rewrite_events,
    non_candidates: bash_total - rewrite_events,
    evidence_files: files.length,
    evidence_lines,
    skipped,
  };
}

/**
 * Last resource event in the stream, via a BOUNDED TAIL read.
 *
 * This is the export the statusline (T03) consumes, and the statusline renders
 * continuously — so this function must never spawn and must never read a whole
 * file whose size it does not control. It opens the file, `fstat`s it, and
 * reads at most `tailBytes` (default 8192) from the end.
 *
 * The first line of the window is DISCARDED whenever the window did not start
 * at byte 0: a tail that begins mid-file almost always begins mid-line, and
 * parsing that fragment would either throw or, worse, succeed on a truncated
 * object. Scans backwards and returns the first resource event found, or null.
 */
function readLastResourceEvent(cwd, opts) {
  const o = opts || {};
  const file = eventsFilePath(cwd, o);
  const tailBytes = o.tailBytes === undefined ? 8192 : o.tailBytes;

  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;

    const start = Math.max(0, size - tailBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);

    const text = buf.toString('utf8');
    const lines = text.split('\n');
    // Partial first line when the window is not anchored at the file start.
    if (start > 0) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.trim() === '') continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const name = parsed.kind !== undefined && parsed.kind !== null
        ? parsed.kind
        : parsed.event;
      if (typeof name !== 'string' || !RESOURCE_EVENT_NAMES.has(name)) continue;
      return {
        name,
        reason: typeof parsed.reason === 'string' && parsed.reason !== '' ? parsed.reason : null,
        ts: parsed.ts === undefined ? null : parsed.ts,
      };
    }
    return null;
  } catch {
    // MEM008: a missing or unreadable log never breaks a render.
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/**
 * Human-readable rendering (molde: forge-overlap.formatOverlap).
 *
 * The reason rides on the FIRST line for every verdict, `inconclusive`
 * included. A mute `inconclusive` repeats the very defect this module exists
 * to prevent, one level up: the reader cannot tell "nothing to scan" from
 * "the tool is broken". Labels in pt-BR, per the repo convention.
 */
function formatCensus(result) {
  const r = result || {};
  const lines = [];
  lines.push(`forge-resources-census: ${r.verdict} — ${r.reason}`);
  lines.push(
    `  censo: eventos ${r.events_scanned || 0} · de-recursos ${r.resource_events || 0}`
    + ` · degradação ${r.degraded_count || 0} · razões ${(r.reasons || []).length}`
    + ` · não-registradas ${r.unregistered_reasons || 0}`
    + ` · pulados ${(r.skipped || []).length}`
    + ` · fontes ${(r.sources || []).length}`,
  );

  for (const s of (r.sources || [])) {
    lines.push(`  · fonte: ${s}`);
  }

  for (const row of (r.reasons || [])) {
    const owner = row.owner ? row.owner : 'sem-dono';
    const flag = row.registered ? '' : ' [não registrada]';
    lines.push(`  · razão: ${row.reason} — ${row.count}× (owner ${owner})${flag}`);
  }

  if (r.w3) {
    const w = r.w3;
    lines.push(
      `  · w3: ${w.status}${w.reason ? ` — ${w.reason}` : ''}`
      + ` (bash ${w.bash_total}, reescritas ${w.rewrite_events}`
      + `${w.non_candidates === undefined ? '' : `, não-candidatos ${w.non_candidates}`})`,
    );
  }

  // Skips are AGGREGATED BY REASON here, with a few example ids — not listed
  // one line each. Measured on this repo's live log during T01: 307 skipped
  // lines rendered 307 identical `event-not-resource-related` rows and pushed
  // the output to 37.6 KB, burying the ten reason rows that carry the actual
  // signal. Aggregating keeps D8 intact — every skip is still counted under a
  // NAMED, enumerated reason, and the exhaustive `skipped[]` array is
  // unchanged in `--json` — while leaving the human output readable. Nothing
  // is dropped; it is summed.
  const skippedByReason = new Map();
  for (const s of (r.skipped || [])) {
    let row = skippedByReason.get(s.reason);
    if (!row) { row = { count: 0, examples: [] }; skippedByReason.set(s.reason, row); }
    row.count += 1;
    if (row.examples.length < 3) row.examples.push(s.id);
  }
  for (const [reason, row] of Array.from(skippedByReason.entries()).sort((a, b) => b[1].count - a[1].count)) {
    const more = row.count > row.examples.length ? `, +${row.count - row.examples.length}` : '';
    lines.push(`  · fora do censo: ${reason} — ${row.count}× (ex.: ${row.examples.join(', ')}${more})`);
  }

  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────
const USAGE = [
  'uso: node scripts/forge-resources-census.js --check [--json] [--cwd <dir>]',
  '',
  'Censo advisory do stream de controle de recursos. SEMPRE sai com exit 0.',
  '',
  'Veredictos: degraded | clean | inconclusive.',
  '`clean` exige ter examinado eventos de recursos de verdade; sem stream, o',
  'veredicto é `inconclusive` — nunca `clean`.',
  '',
  'Flags:',
  '  --check        roda o censo',
  '  --json         emite JSON em vez da forma legível',
  '  --cwd <path>   onde procurar .gsd/forge/events.jsonl (default: process.cwd())',
  '  --help         este texto',
].join('\n');

function parseArgs(argv) {
  const out = { check: false, json: false, cwd: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--json') out.json = true;
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
    const collected = collectResourceEvents(cwd, {});
    result = buildCensus(collected);
    result.w3 = reconcileW3(cwd, collected, {});
  } catch (e) {
    // Advisory: an unreadable stream is reported, never fatal to a caller's
    // loop. Same posture as forge-overlap.js.
    process.stderr.write(`forge-resources-census: ${e.message}\n`);
    return 0;
  }

  process.stdout.write(args.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${formatCensus(result)}\n`);

  // Return 0 UNCONDITIONALLY — including when the verdict is `degraded`.
  // This census informs a human; it is not a gate (S05-PLAN.md § Acceptance 1).
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  collectResourceEvents,
  buildCensus,
  reconcileW3,
  readLastResourceEvent,
  formatCensus,
  REASON_REGISTRY,
  REASON_OWNERS,
  DEGRADATION_REASONS,
  RESOURCE_EVENT_NAMES,
  CENSUS_VERDICTS,
  CENSUS_SKIP_REASONS,
  parseArgs,
  main,
  USAGE,
};
