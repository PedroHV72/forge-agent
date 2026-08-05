'use strict';

// forge-sweep-sealed — the three proofs a unit is closed for writes, and the
// sweep container numbering. This module is PURE with regard to the decision:
// it never writes, never touches VCS, never knows about forge-epoch-group.
// It only says, given a unit id, whether grouping it is provably safe — or
// refuses with a legible reason. Whoever applies the verdict is out of scope
// here (T04).
//
// Library exports:
//   loadLedgerIds(cwd)          → Set<string>
//   owningUnitId(id)            → string
//   dateInId(id)                → Date | null
//   isExtinctId(id)             → boolean
//   sealedBy(unit, ctx)         → { groupable: true, proof, date } | { groupable: false, reason }
//   nextSweepNumber(dirs)       → number
//   containerName(n)            → string

const fs = require('fs');

const { timestampOf } = require('./forge-ids');
const ledger = require('./forge-ledger');
const memory = require('./forge-memory');
const { SWEEP_CONTAINER_RE } = require('./forge-grouped-file');

// ── loadLedgerIds ────────────────────────────────────────────────────────────
// One Set, read once per plan (not per member) — callers pass it forward in
// ctx.ledgerIds. Degrades to an empty Set when the directory does not exist;
// never throws.
function loadLedgerIds(cwd) {
  try {
    const fragments = ledger.listFragments(cwd);
    return new Set(fragments.map(entry => entry.id));
  } catch (_) {
    return new Set();
  }
}

// ── owningUnitId ─────────────────────────────────────────────────────────────
// For a qualified memory key (`M-x__S04`) the ledger only ever has an entry
// for the OWNING milestone/task, not the slice/task fragment inside it — so
// this is what proof (a) actually looks up. For anything else (already a
// top-level id, or a shape parseStorageKey does not recognize as qualified),
// the id itself is what would appear in the ledger.
function owningUnitId(id) {
  const parsed = memory.parseStorageKey(id);
  if (parsed && parsed.milestoneId) return parsed.milestoneId;
  return id;
}

// ── date validation ──────────────────────────────────────────────────────────
// Date.UTC silently rolls over out-of-range components (month 13, day 32,
// Feb 30) instead of rejecting them — round-tripping the parts back out of
// the constructed date is what actually catches '9999-99-99'-shaped garbage.
function validDateFromParts(y, mo, d) {
  const yy = Number(y);
  const mm = Number(mo);
  const dd = Number(d);
  if (!Number.isInteger(yy) || !Number.isInteger(mm) || !Number.isInteger(dd)) return null;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const date = new Date(Date.UTC(yy, mm - 1, dd));
  if (date.getUTCFullYear() !== yy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) {
    return null;
  }
  return date;
}

function dateFromCanonicalTimestamp(ts) {
  // ts is the 14-digit YYYYMMDDHHMMSS string forge-ids.timestampOf returns
  // for canonical (compact or dashed) timestamp ids.
  if (typeof ts !== 'string' || ts.length !== 14) return null;
  return validDateFromParts(ts.slice(0, 4), ts.slice(4, 6), ts.slice(6, 8));
}

// Real ask-* session ids in the store carry a DOUBLED prefix
// (`ask-ask-2026-05-29-1403`, `forge-ask`'s own session-id minting logic
// prepends `ask-` to an id that already starts with `ask-`). Anchoring the
// date match right after the FIRST `ask-` (the old ASK_DASHED_DATE_RE /
// ASK_COMPACT_DATE_RE below) matched a shape that only ever existed in the
// test fixtures — every real fragment in the reference store failed both regexes
// and fell through to "no proof", the literal repeat of PR 1's F2. Fix:
// gate on memory.ASK_ID_RE (the actual `ask-<anything>` validity check,
// already used by forge-memory.js and forge-decisions.js) and THEN look for
// a date anywhere within the id, not immediately after the first `ask-`.
const ASK_DASHED_DATE_RE = /(\d{4})-(\d{2})-(\d{2})(?:[-_].*)?$/;
const ASK_COMPACT_DATE_RE = /(\d{4})(\d{2})(\d{2})(?:[-_].*)?$/;

// ── dateInId ─────────────────────────────────────────────────────────────────
// Date embedded in the id, or null when none can be derived — a null date
// does not disqualify a unit from proof (a)/(c); it just contributes nothing
// to a date range (DS9-5).
function dateInId(id) {
  if (typeof id !== 'string' || !id) return null;

  const closure = closureDateInId(id);
  if (closure) return closure;

  const canonical = timestampOf(id);
  if (canonical) {
    const date = dateFromCanonicalTimestamp(canonical);
    if (date) return date;
  }

  return null;
}

// ── closureDateInId — the ONLY dates that satisfy proof (b) ────────────────
// A date embedded in an id proves closure only when the id's OWN semantics
// mean the date is a point in time that is never revisited — a session id
// (`ask-<date>`). A milestone/task id's embedded timestamp is CREATION time,
// not closure — a milestone can still be open (unmerged, no ledger entry)
// long after its timestamp, and the currently-executing milestone is exactly
// that shape. Grouping on creation-timestamp alone would let the next write
// to a still-open milestone/task miss the loose fragment and shadow
// accumulated memory — the precise hazard this slice exists to prevent.
// Canonical (M-/T-) timestamp ids therefore fall through to proof (a)
// (ledger) instead; dateInId() above still surfaces their date as metadata
// once grouped by ledger, but sealedBy()'s proof (b) must not use it.
function closureDateInId(id) {
  if (!memory.ASK_ID_RE.test(id)) return null;

  let match = ASK_DASHED_DATE_RE.exec(id);
  if (match) {
    const date = validDateFromParts(match[1], match[2], match[3]);
    if (date) return date;
  }

  match = ASK_COMPACT_DATE_RE.exec(id);
  if (match) {
    const date = validDateFromParts(match[1], match[2], match[3]);
    if (date) return date;
  }

  return null;
}

// ── isExtinctId — DS9-4, narrowed by the B1 finding ────────────────────────
// The plan's original premise was that the only producer of a bare local
// storage key (e.g. `S02`, no `__<milestone>` prefix) is
// forge-memory-migrate.js:451, a one-shot legacy migration. That premise is
// FALSE: skills/forge-sweep/SKILL.md:262 writes memory via
// `node scripts/forge-memory.js --write --cwd .` WITHOUT `--milestone`, and
// forge-memory.js qualifiedStorageKey():147-148
// (`if (!LOCAL_UNIT_ID_RE.test(unitId) || !milestoneId) return unitId;`)
// leaves such a write's key bare. `/forge-sweep` is model-invocable and runs
// at the end of every work cycle — a legacy `S02.md` CAN still receive a
// write today. Grouping it would let the next write miss the loose path and
// start from zero, shadowing accumulated memory (forge-memory.js:692-704).
//
// DS9-4's own fallback is what fires here: the proof narrows to the ONLY
// shape that is extinct by construction — a storage key parseStorageKey()
// REFUSES outright (e.g. `S03-T02`: LOCAL_UNIT_ID_RE has no hyphen, so
// fragmentPath() would throw; no code path can ever write that key). A bare
// local key like `S02` PASSES parseStorageKey() (validateUnitId() accepts
// it via LOCAL_UNIT_ID_RE), so it is NOT extinct under this narrowing — it is
// left to fall through sealedBy() to the "no proof" branch and gets skipped
// with a reason, never grouped on the strength of a refuted premise.
function isExtinctId(id) {
  return memory.parseStorageKey(id) === null;
}

const LEGACY_ORPHAN_REASON = 'legacy-orphan não é agrupável';
const NO_PROOF_REASON = 'sem prova de encerramento — unidade pode receber escrita';

// ── sealedBy ─────────────────────────────────────────────────────────────────
// unit is { id }; the store it came from never matters (DS9-6) — the
// legacy-orphan guard runs first and unconditionally, before any of the
// three proofs, so it behaves identically no matter which of the three
// stores calls it.
function sealedBy(unit, ctx) {
  const id = unit && unit.id;

  if (id === 'legacy-orphan') {
    return { groupable: false, reason: LEGACY_ORPHAN_REASON };
  }

  if (typeof id !== 'string' || !id) {
    return { groupable: false, reason: NO_PROOF_REASON };
  }

  const ledgerIds = (ctx && ctx.ledgerIds) || new Set();

  // (a) ledger — an entry exists for the unit's owning milestone/task.
  if (ledgerIds.has(owningUnitId(id))) {
    return { groupable: true, proof: 'ledger', date: dateInId(id) };
  }

  // (b) date embedded in the id — ONLY closure-semantics ids (ask-<date>
  // sessions). A milestone/task's embedded timestamp is creation time, not
  // closure, and must fall through to proof (a)/(c) instead (see
  // closureDateInId above).
  const date = closureDateInId(id);
  if (date) {
    return { groupable: true, proof: 'id-date', date };
  }

  // (c) extinct id format, narrowed per DS9-4/B1 above.
  if (isExtinctId(id)) {
    return { groupable: true, proof: 'extinct-id', date: null };
  }

  return { groupable: false, reason: NO_PROOF_REASON };
}

const SWEEP_CONTAINER_PREFIX = 'sweep-project-';

// ── nextSweepNumber ──────────────────────────────────────────────────────────
// Scans the given directories for existing sweep containers (matched via
// SWEEP_CONTAINER_RE, imported — never redefined), and returns max + 1
// across ALL of them (one number shared per sweep across stores, DS9-3).
// A missing/unreadable directory contributes nothing; 1 when none found.
function nextSweepNumber(dirs) {
  const list = Array.isArray(dirs) ? dirs : [dirs];
  let max = 0;
  for (const dir of list) {
    if (!dir) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const name = entry.replace(/\.md$/, '');
      if (!SWEEP_CONTAINER_RE.test(name)) continue;
      const num = parseInt(name.slice(SWEEP_CONTAINER_PREFIX.length), 10);
      if (Number.isInteger(num)) max = Math.max(max, num);
    }
  }
  return max + 1;
}

// ── containerName ─────────────────────────────────────────────────────────────
// Zero-pads to (at least) 2 digits, growing naturally past 99 — matches the
// floor semantics of SWEEP_CONTAINER_RE (\d{2,}).
function containerName(n) {
  return `${SWEEP_CONTAINER_PREFIX}${String(n).padStart(2, '0')}`;
}

module.exports = {
  loadLedgerIds,
  owningUnitId,
  dateInId,
  isExtinctId,
  sealedBy,
  nextSweepNumber,
  containerName,
};
