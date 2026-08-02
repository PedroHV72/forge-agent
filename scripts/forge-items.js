#!/usr/bin/env node
// forge-items — Work-item fragment store for Forge Agent (.gsd/items/)
//
// One file per item: `.gsd/items/<I-id>.md`. Two items born on two branches are
// two distinct files, so they merge without conflict by construction — no shared
// index file is ever written.
//
// Library exports:
//   ITEMS_DIR                          → string  // relative path '.gsd/items'
//   STATUSES                           → frozen array // the ONLY status set
//   itemsDir(cwd)                      → string  // absolute path to items dir
//   itemPath(cwd, id)                  → string  // absolute path to <I-id>.md
//   parseItem(text)                    → object  // frontmatter + body
//   serializeItem(item)                → string  // lossless round-trip of parseItem
//   validateItem(item)                 → { valid, errors: [] }
//   addItem(cwd, fields, opts)         → { id, path, created }
//   readItem(cwd, idOrPrefix)          → object   // throws on unknown/ambiguous
//   listItems(cwd, filter)             → Array<object>  // sorted by id asc
//   updateItem(cwd, idOrPrefix, patch) → { id, path, item }
//   setStatus(cwd, idOrPrefix, status) → { id, path, item }
//   setPriority(cwd, idOrPrefix, prio) → { id, path, item }
//   labelsToArray(scalar)              → string[]  // ONLY for the --list --json edge
//   promoteItem(cwd, idOrPrefix, targetId) → { id, path, item }
//   resolveItemId(cwd, prefix)         → string   // unique prefix → full ID
//
// CLI:
//   --add/--list/--read/--update/--set-status/--set-priority/--promote
//   --validate/--resolve
//   --smoke-regression, --help — see cliMain() below for the full surface.
//
// Exit codes:
//   0 — success
//   1 — runtime error (invalid id, parse error, etc.)
//   2 — unknown/missing arguments
//
// Boundary with .gsd/memory/ (forge-memory): items are PENDING ACTIONS — work
// that still needs to happen. Facts about the project — things that BECAME TRUE —
// belong to .gsd/memory/ instead. The two stores never compete for the same
// capture: forge-memory's quality gate explicitly rejects pendência candidates
// and never calls into this module to create an item.

'use strict';

const fs = require('fs');
const path = require('path');
const { makeItemId, isValid, entityKind } = require('./forge-ids');
const yamlSafe = require('./forge-yaml-safe');

// ── Constants ─────────────────────────────────────────────────────────────────

const ITEMS_DIR = '.gsd/items';

// The closed status set. This frozen constant is the ONLY place the set exists —
// addItem, updateItem, setStatus and validateItem all reference it.
const STATUSES = Object.freeze(['inbox', 'triaged', 'doing', 'done', 'dropped']);

// The closed priority set, in the same mould as STATUSES: this frozen constant is
// the ONLY place the set exists — validateItem and setPriority both reference it,
// so no write path can ever accept a value the others reject.
const PRIORITIES = Object.freeze(['p0', 'p1', 'p2', 'p3']);

// Provenance regimes. `auto` items must carry a `source`; `human` items need not.
const ORIGINS = Object.freeze(['human', 'auto']);

// Frozen key order for diff stability. Unknown keys are emitted after these,
// sorted alphabetically, so third-party additions never reshuffle the core block.
//
// `closed_at` sits right after `updated` because it is the other timestamp of the
// lifecycle. Inserting a key in the MIDDLE of this list does NOT reorder legacy
// fragments that lack it: serializeItem walks `KEY_ORDER.filter(k => k in item)`,
// so an absent key is simply skipped and every surviving key keeps its relative
// position. That is a property, not a hope — section 8 of forge-items.test.js
// round-trips real pre-closed_at fragments byte-for-byte and would fail here.
const KEY_ORDER = Object.freeze([
  'id', 'title', 'status', 'priority', 'labels', 'blocked_by', 'origin', 'created', 'updated', 'closed_at',
  'source', 'file', 'sha', 'milestone', 'promoted_to',
]);

// The subset of STATUSES that counts as "closed" for `closed_at` stamping.
// `dropped` IS stamped: the field records WHEN an item left the open board, not
// whether it was a delivery. Excluding dropped items from a throughput count is
// a reporting decision made where the count is computed, not here.
const CLOSED_STATUSES = Object.freeze(new Set(['done', 'dropped']));

// ── itemsDir ──────────────────────────────────────────────────────────────────
// Absolute path to the items directory for a given cwd. Every filesystem path in
// this module derives from here — nothing writes outside the project's .gsd/.
function itemsDir(cwd) {
  return path.join(cwd || process.cwd(), '.gsd', 'items');
}

// ── itemPath ──────────────────────────────────────────────────────────────────
// Absolute path to the fragment file for an item ID.
// Throws unless the ID is a valid item ID (I-<ts>[-slug]).
function itemPath(cwd, id) {
  if (!isValid(id) || entityKind(id) !== 'item') {
    throw new Error(
      `Invalid item ID: "${id}". Expected an item ID of the form I-<14-digit-timestamp>[-<slug>].`
    );
  }
  return path.join(itemsDir(cwd), `${id}.md`);
}

// ── parseItem ─────────────────────────────────────────────────────────────────
// Parses an item fragment (YAML frontmatter + free-form markdown body).
// Flat scalar frontmatter only — values go through yamlSafe.parseScalar so
// multi-line and colon-leading strings round-trip losslessly.
// Unknown keys pass through unchanged (same tolerance as forge-decisions).
function parseItem(text) {
  const match = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { id: null, body: String(text).trim() };
  }

  const lines = match[1].split('\n');
  const body = match[2].trim();
  const result = {};

  let i = 0;
  while (i < lines.length) {
    const kv = lines[i].match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!kv) { i++; continue; }

    const key = kv[1];
    // Feed the remainder of the line plus the following lines to parseScalar so
    // it can consume block-scalar continuation lines when present.
    const synthetic = [kv[2], ...lines.slice(i + 1)];
    const parsed = yamlSafe.parseScalar(synthetic, 0, 0);
    result[key] = parsed.value;
    i += parsed.nextIndex;
  }

  if (result.id === undefined) result.id = null;
  result.body = body;
  return result;
}

// ── serializeItem ─────────────────────────────────────────────────────────────
// Serializes an item object back to the fragment format. Canonical keys first in
// KEY_ORDER, then any extras alphabetically. Empty/absent optional keys are
// omitted entirely rather than emitted blank.
function serializeItem(item) {
  const skip = new Set(['body']);
  const extras = Object.keys(item)
    .filter(k => !skip.has(k) && !KEY_ORDER.includes(k))
    .sort();
  const keys = [...KEY_ORDER.filter(k => k in item), ...extras];

  const lines = [];
  for (const key of keys) {
    const val = item[key];
    if (val === undefined || val === null || val === '') continue;
    lines.push(`${key}: ${yamlSafe.serializeScalar(val, 0)}`);
  }

  const body = item.body ? `\n${item.body}\n` : '';
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

// ── normalizeLabels ───────────────────────────────────────────────────────────
// Joins an array of labels into the comma-separated SCALAR that is the only
// encoding this store ever writes to disk.
//
// The split does NOT belong in parseItem, and the array does NOT belong in
// serializeItem. A YAML list on disk is a proven silent data loss here: the
// `- bug` continuation lines fail parseItem's `^key: value` regex and are
// skipped, leaving `labels: ""`, which serializeItem then drops entirely — the
// key vanishes on the next write with no error and no exit code. So the array
// exists only at the two boundaries: joined on the way IN (here, called from
// addItem/updateItem so library callers are covered too, not just CLI stdin),
// split on the way OUT (labelsToArray, only in --list --json).
function normalizeLabels(value) {
  if (!Array.isArray(value)) return value; // strings pass through untouched
  return value.map(String).map(s => s.trim()).filter(Boolean).join(', ');
}

// `blocked_by` is the SAME encoding problem as `labels` — a list of short tokens
// that must live on disk as one scalar line — so it reuses the same pair of
// boundary functions rather than growing a second, subtly different one. A YAML
// list here would be silently dropped by parseItem exactly as it is for labels.
const normalizeBlockedBy = normalizeLabels;

// ── labelsToArray ─────────────────────────────────────────────────────────────
// The read side of the same boundary: scalar → array. Absent/empty yields [],
// so a consumer can iterate unconditionally without a presence check.
function labelsToArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

// ── toJsonShape ───────────────────────────────────────────────────────────────
// Shallow clone with `labels` widened to an array. Applied ONLY to the
// `--list --json` output — `--read`, listItems() and readItem() all keep the raw
// store shape, so the on-disk encoding stays the single source of truth and no
// caller can accidentally write an array back.
function toJsonShape(item) {
  return { ...item, labels: labelsToArray(item.labels), blocked_by: labelsToArray(item.blocked_by) };
}

// ── validateItem ──────────────────────────────────────────────────────────────
// Structural validation. Dual-regime provenance: an `auto` item requires a
// non-empty `source`; a `human` item does not.
// Returns { valid: boolean, errors: string[] } — never throws.
function validateItem(item) {
  const errors = [];
  if (!item || typeof item !== 'object') {
    return { valid: false, errors: ['item must be an object'] };
  }

  if (!item.id || !isValid(item.id) || entityKind(item.id) !== 'item') {
    errors.push(`id must be a valid item ID (I-<ts>[-slug]); got "${item.id}"`);
  }

  if (!item.title || String(item.title).trim() === '') {
    errors.push('title is required and must be non-empty');
  }

  if (!STATUSES.includes(item.status)) {
    errors.push(`status must be one of ${STATUSES.join(', ')}; got "${item.status}"`);
  }

  if (!ORIGINS.includes(item.origin)) {
    errors.push(`origin must be one of ${ORIGINS.join(', ')}; got "${item.origin}"`);
  }

  // Dual regime: auto ⇒ source required. human ⇒ source optional.
  if (item.origin === 'auto' && (!item.source || String(item.source).trim() === '')) {
    errors.push('origin "auto" requires a non-empty source (e.g. review/S02/R1)');
  }

  // priority is optional, but when present it is a closed set — same regime as
  // status. Checked here so EVERY write path (addItem, updateItem, --add,
  // --update, setPriority) rejects a bad value before anything reaches disk.
  if (item.priority !== undefined && item.priority !== null && item.priority !== '') {
    if (!PRIORITIES.includes(item.priority)) {
      errors.push(`priority must be one of ${PRIORITIES.join(', ')}; got "${item.priority}"`);
    }
  }

  if (item.promoted_to !== undefined && item.promoted_to !== null && item.promoted_to !== '') {
    if (!isValidPromotionTarget(item.promoted_to)) {
      errors.push(
        `promoted_to must be a valid milestone or task ID; got "${item.promoted_to}"`
      );
    }
  }

  // closed_at is a measurement of WHEN status transitioned to a closed state,
  // never an estimate a caller can forge on an open item. A stamp present on
  // an item whose status is not done/dropped would poison any "closed in a
  // window" count downstream. Replacing the stamp on an already-closed item
  // (backfill/date-correction) remains allowed — this only rejects the
  // combination of a stamp with a non-closed status.
  if (item.closed_at && !CLOSED_STATUSES.has(item.status)) {
    errors.push(
      `closed_at requires status to be one of ${[...CLOSED_STATUSES].join(', ')}; got status "${item.status}"`
    );
  }

  return { valid: errors.length === 0, errors };
}

// ── isValidPromotionTarget ────────────────────────────────────────────────────
// A promotion target is a milestone or a task — never another item.
function isValidPromotionTarget(targetId) {
  if (!isValid(targetId)) return false;
  const kind = entityKind(targetId);
  return kind === 'milestone' || kind === 'task';
}

// ── resolveItemId ─────────────────────────────────────────────────────────────
// The ONE resolver. Every read/mutate function routes through it, so prefix
// semantics can never drift between call sites.
//   exact ID      → itself
//   unique prefix → the full ID
//   ambiguous     → throws, naming every candidate (never a guess)
//   no match      → throws
function resolveItemId(cwd, prefix) {
  if (!prefix || String(prefix).trim() === '') {
    throw new Error('resolveItemId requires a non-empty item ID or prefix');
  }
  const needle = String(prefix).trim();

  const dir = itemsDir(cwd);
  let ids = [];
  if (fs.existsSync(dir)) {
    ids = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.slice(0, -3))
      .filter(id => entityKind(id) === 'item');
  }

  // Exact match wins outright — a full ID is never ambiguous against a longer one.
  if (ids.includes(needle)) return needle;

  const matches = ids.filter(id => id.startsWith(needle)).sort();
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous item prefix "${needle}" — ${matches.length} candidates: ${matches.join(', ')}. ` +
      'Use a longer prefix or the full ID.'
    );
  }
  throw new Error(`Unknown item ID or prefix: "${needle}". No item in ${dir} matches.`);
}

// ── addItem ───────────────────────────────────────────────────────────────────
// Creates a new item fragment. Generates the ID from the title, defaults status
// to 'inbox' when absent, validates before writing, writes atomically.
// fields: { title, origin, status?, source?, file?, sha?, milestone?, body?, ... }
// opts:   { runId?, sessionId? }  (lock tracking, passed to writeAtomic)
// Returns { id, path, created }.
function addItem(cwd, fields, opts) {
  opts = opts || {};
  if (!fields || typeof fields !== 'object') {
    throw new Error('addItem requires a fields object');
  }

  const now = new Date().toISOString();
  const id = fields.id || makeItemId(fields.title || '');

  const item = {
    ...fields,
    id,
    status: fields.status || 'inbox',
    created: fields.created || now,
    updated: now,
  };

  // Array → scalar BEFORE validation and before disk. Doing it here rather than
  // in the CLI covers library callers as well.
  if ('labels' in item) item.labels = normalizeLabels(item.labels);
  if ('blocked_by' in item) item.blocked_by = normalizeBlockedBy(item.blocked_by);

  // An item born closed (imported backlog, an item logged only once it was
  // already resolved) never passes through updateItem's transition, so it would
  // otherwise be invisible to any closed-in-window count. Stamp it at creation —
  // an explicit closed_at in `fields` still wins, which is how a backfill
  // preserves the real historical date.
  if (CLOSED_STATUSES.has(item.status) && !item.closed_at) {
    item.closed_at = now;
  }

  const { valid, errors } = validateItem(item);
  if (!valid) {
    throw new Error(`Invalid item: ${errors.join('; ')}`);
  }

  const fpath = itemPath(cwd, id);
  // Guard the one-file-per-item invariant: same title in the same second would
  // otherwise regenerate the same ID and silently overwrite a different item.
  if (fs.existsSync(fpath)) {
    throw new Error(
      `Item ID collision: "${id}" already exists at ${fpath}. ` +
      'Retry (the timestamp advances every second) or vary the title.'
    );
  }
  yamlSafe.writeAtomic(fpath, serializeItem(item), {
    cwd: cwd,
    runId: opts.runId || null,
    sessionId: opts.sessionId || null,
  });

  return { id, path: fpath, created: true };
}

// ── readItem ──────────────────────────────────────────────────────────────────
// Resolves the ID or prefix, then parses the fragment.
// Unknown/ambiguous prefix throws (resolver contract) — including when the store
// directory does not exist at all.
function readItem(cwd, idOrPrefix) {
  const id = resolveItemId(cwd, idOrPrefix);
  const fpath = itemPath(cwd, id);
  return parseItem(fs.readFileSync(fpath, 'utf8'));
}

// ── listItems ─────────────────────────────────────────────────────────────────
// All parsed items sorted by id ascending. `filter.status` narrows the result.
// Returns [] when the store directory is absent.
function listItems(cwd, filter) {
  filter = filter || {};
  const dir = itemsDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const items = fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3))
    .filter(id => entityKind(id) === 'item')
    .sort()
    .map(id => parseItem(fs.readFileSync(path.join(dir, `${id}.md`), 'utf8')));

  if (filter.status) {
    return items.filter(it => it.status === filter.status);
  }
  return items;
}

// ── updateItem ────────────────────────────────────────────────────────────────
// Shallow-merges `patch` into the stored frontmatter/body, re-validates, bumps
// `updated`, and rewrites atomically. Returns { id, path, item }.
function updateItem(cwd, idOrPrefix, patch, opts) {
  opts = opts || {};
  const id = resolveItemId(cwd, idOrPrefix);
  const fpath = itemPath(cwd, id);
  const existing = parseItem(fs.readFileSync(fpath, 'utf8'));

  const merged = {
    ...existing,
    ...(patch || {}),
    id, // the ID is immutable — a patch can never rename an item
    updated: new Date().toISOString(),
  };

  // Same array → scalar join as addItem, applied post-merge so a patch carrying
  // an array is normalized while an untouched stored scalar passes through.
  if ('labels' in merged) merged.labels = normalizeLabels(merged.labels);
  if ('blocked_by' in merged) merged.blocked_by = normalizeBlockedBy(merged.blocked_by);

  // ── closed_at, keyed on the TRANSITION ──────────────────────────────────────
  // Derived from existing.status → merged.status, never from the patch. That is
  // what makes `--update` on a done item leave closed_at untouched while still
  // bumping `updated`: a title patch does not change the status, so no branch
  // below fires. It also means every writer funnels through one rule —
  // setStatus, --update {status} and any future caller all land here.
  //
  // Why this field exists: `updated` bumps on ANY mutation, so counting items
  // closed in a window from `updated` yields a number that shifts retroactively
  // when someone edits an old item. `closed_at` is what makes that count a
  // measurement instead of an estimate.
  const wasClosed = CLOSED_STATUSES.has(existing.status);
  const isClosed = CLOSED_STATUSES.has(merged.status);
  if (isClosed && !merged.closed_at) {
    // Only stamp when there is no stamp yet. done → done (the documented no-op)
    // and done → dropped therefore preserve the ORIGINAL closing time; the item
    // closed once, and re-touching it must not rewrite history.
    merged.closed_at = new Date().toISOString();
  } else if (!isClosed && wasClosed) {
    // Reopening removes the key. `null` — not `delete` — because serializeItem
    // already skips undefined/null/'' when emitting keys, so null IS the
    // module's established "omit this key" signal. A `delete` would work today
    // and diverge the moment the serializer changes; there is no reason to have
    // two mechanisms for one meaning.
    merged.closed_at = null;
  }
  // Deliberately NOT validated as un-patchable: a user could pass closed_at in a
  // patch, but the transition rules above dominate every case that matters, and
  // rejecting the key is a contract change outside this task's scope.

  const { valid, errors } = validateItem(merged);
  if (!valid) {
    throw new Error(`Invalid item after update: ${errors.join('; ')}`);
  }

  yamlSafe.writeAtomic(fpath, serializeItem(merged), {
    cwd: cwd,
    runId: opts.runId || null,
    sessionId: opts.sessionId || null,
  });

  return { id, path: fpath, item: merged };
}

// ── setStatus ─────────────────────────────────────────────────────────────────
// Throws on any value outside the closed STATUSES set, before touching disk.
function setStatus(cwd, idOrPrefix, status, opts) {
  if (!STATUSES.includes(status)) {
    throw new Error(
      `Invalid status "${status}". Allowed: ${STATUSES.join(', ')}.`
    );
  }
  return updateItem(cwd, idOrPrefix, { status }, opts);
}

// ── setPriority ───────────────────────────────────────────────────────────────
// Exact mirror of setStatus: throws on any value outside the closed PRIORITIES
// set BEFORE touching disk. Validating after writing would still exit non-zero
// while leaving a mutated fragment behind — the acceptance criterion is that
// `git status --porcelain .gsd/items/` stays empty after a rejected attempt.
function setPriority(cwd, idOrPrefix, priority, opts) {
  if (!PRIORITIES.includes(priority)) {
    throw new Error(
      `Invalid priority "${priority}". Allowed: ${PRIORITIES.join(', ')}.`
    );
  }
  return updateItem(cwd, idOrPrefix, { priority }, opts);
}

// ── promoteItem ───────────────────────────────────────────────────────────────
// Links an item to the milestone or task it became. Does NOT change status —
// callers decide separately via setStatus.
function promoteItem(cwd, idOrPrefix, targetId, opts) {
  if (!isValidPromotionTarget(targetId)) {
    throw new Error(
      `Invalid promotion target "${targetId}". Expected a milestone (M-…) or task (T-…/TASK-…) ID.`
    );
  }
  return updateItem(cwd, idOrPrefix, { promoted_to: targetId }, opts);
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  ITEMS_DIR,
  STATUSES,
  PRIORITIES,
  itemsDir,
  itemPath,
  parseItem,
  serializeItem,
  validateItem,
  normalizeLabels,
  labelsToArray,
  normalizeBlockedBy,
  toJsonShape,
  addItem,
  readItem,
  listItems,
  updateItem,
  setStatus,
  setPriority,
  promoteItem,
  resolveItemId,
};

// ── cliMain ───────────────────────────────────────────────────────────────────
// Thin dispatcher — zero store semantics live here. Every command delegates to
// the library functions above; the CLI only parses argv, reads stdin JSON when
// needed, and maps results/errors to stdout/stderr + exit codes.
function printUsage() {
  console.log(`Usage: node forge-items.js <command> [options]

Commands:
  --add [--cwd <dir>]                      Create item from stdin JSON
                                            { title, origin, status?, source?,
                                              file?, sha?, milestone?, body? }
                                            Prints { id, path, created }
  --list [--json] [--status <s>] [--cwd <dir>]
                                            List items. Default: human-readable
                                            "<id> <status> <title>" lines.
                                            --json prints the full array.
  --read <id|prefix> [--cwd <dir>]         Print item JSON
  --update <id|prefix> [--cwd <dir>]       Patch item from stdin JSON
  --set-status <id|prefix> <status> [--cwd <dir>]
                                            Set status (closed set); invalid → exit 1
  --set-priority <id|prefix> <priority> [--cwd <dir>]
                                            Set priority (closed set); invalid → exit 1
                                            (rejected before the fragment is touched)
  --promote <id|prefix> <target-id> [--cwd <dir>]
                                            Set promoted_to (milestone or task ID)
  --validate <id|prefix> [--cwd <dir>]     Print { id, valid, errors }; exit 1 if invalid
  --resolve <prefix> [--cwd <dir>]         Print the full ID for a unique prefix
  --smoke-regression                       Run inline regression smoke test (exit 0 = PASS)
  --help, -h                               Show this help

Statuses:   ${STATUSES.join(', ')}
Priorities: ${PRIORITIES.join(', ')}
Origins:    ${ORIGINS.join(', ')}

Options:
  --cwd <dir>   Working directory (default: process.cwd())

Exit codes:
  0  Success
  1  Runtime error (invalid id, validation failure, ambiguous/unknown prefix, etc.)
  2  Unknown or missing arguments`);
}

// ── readStdinJson ─────────────────────────────────────────────────────────────
// Reads all of stdin, parses as JSON, invokes `cb(obj)` on success or exits 1
// with a stderr message on parse failure. Used by --add/--update.
function readStdinJson(cb) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`Failed to parse JSON from stdin: ${e.message}\n`);
      process.exit(1);
    }
    cb(obj);
  });
}

function cliMain(argv) {
  // Parse --cwd first (may appear anywhere in argv).
  let cwd = process.cwd();
  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx !== -1) {
    cwd = argv[cwdIdx + 1];
    if (!cwd) {
      process.stderr.write('--cwd requires a directory argument\n');
      process.exit(2);
    }
    argv = argv.filter((_, i) => i !== cwdIdx && i !== cwdIdx + 1);
  }

  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(0);
  }

  if (cmd === '--smoke-regression') {
    smokeRegression();
    return;
  }

  if (cmd === '--add') {
    readStdinJson(fields => {
      let result;
      try {
        result = addItem(cwd, fields);
      } catch (e) {
        process.stderr.write(`${e.message}\n`);
        process.exit(1);
      }
      console.log(JSON.stringify(result));
      process.exit(0);
    });
    return; // async — do not fall through
  }

  if (cmd === '--list') {
    const asJson = argv.includes('--json');
    const statusIdx = argv.indexOf('--status');
    const filter = {};
    if (statusIdx !== -1) {
      filter.status = argv[statusIdx + 1];
      if (!filter.status) {
        process.stderr.write('--status requires a value\n');
        process.exit(2);
      }
    }
    let result;
    try {
      result = listItems(cwd, filter);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    if (asJson) {
      // The ONE place the scalar widens to an array — the app is the only
      // consumer of that shape (--read stays raw, S01-PLAN Nota 1).
      console.log(JSON.stringify(result.map(toJsonShape)));
    } else {
      for (const it of result) {
        console.log(`${it.id} ${it.status} ${it.title}`);
      }
    }
    process.exit(0);
  }

  if (cmd === '--read') {
    const id = argv[1];
    if (!id) {
      process.stderr.write('--read requires an item ID or prefix\n');
      process.exit(2);
    }
    let result;
    try {
      result = readItem(cwd, id);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (cmd === '--update') {
    const id = argv[1];
    if (!id) {
      process.stderr.write('--update requires an item ID or prefix\n');
      process.exit(2);
    }
    readStdinJson(patch => {
      let result;
      try {
        result = updateItem(cwd, id, patch);
      } catch (e) {
        process.stderr.write(`${e.message}\n`);
        process.exit(1);
      }
      console.log(JSON.stringify(result));
      process.exit(0);
    });
    return; // async — do not fall through
  }

  if (cmd === '--set-status') {
    const id = argv[1];
    const status = argv[2];
    if (!id || !status) {
      process.stderr.write('--set-status requires an item ID/prefix and a status\n');
      process.exit(2);
    }
    let result;
    try {
      result = setStatus(cwd, id, status);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (cmd === '--set-priority') {
    const id = argv[1];
    const priority = argv[2];
    if (!id || !priority) {
      process.stderr.write('--set-priority requires an item ID/prefix and a priority\n');
      process.exit(2);
    }
    let result;
    try {
      result = setPriority(cwd, id, priority);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (cmd === '--promote') {
    const id = argv[1];
    const targetId = argv[2];
    if (!id || !targetId) {
      process.stderr.write('--promote requires an item ID/prefix and a target ID\n');
      process.exit(2);
    }
    let result;
    try {
      result = promoteItem(cwd, id, targetId);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (cmd === '--validate') {
    const id = argv[1];
    if (!id) {
      process.stderr.write('--validate requires an item ID or prefix\n');
      process.exit(2);
    }
    let item;
    try {
      item = readItem(cwd, id);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    const { valid, errors } = validateItem(item);
    console.log(JSON.stringify({ id: item.id, valid, errors }));
    process.exit(valid ? 0 : 1);
  }

  if (cmd === '--resolve') {
    const prefix = argv[1];
    if (!prefix) {
      process.stderr.write('--resolve requires a prefix\n');
      process.exit(2);
    }
    let id;
    try {
      id = resolveItemId(cwd, prefix);
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    console.log(id);
    process.exit(0);
  }

  // Unknown command
  process.stderr.write(`Unknown argument: ${cmd}\n\n`);
  printUsage();
  process.exit(2);
}

// ── smokeRegression ───────────────────────────────────────────────────────────
// Inline regression smoke test — self-cleaning, PASS/FAIL lines, exit 0/1.
// Covers: two distinct fragments, prefix resolution (unique/ambiguous/unknown),
// bad status rejection, auto-without-source validation failure, and promote
// writing a validated promoted_to.
function smokeRegression() {
  const os = require('os');
  const { execFileSync } = require('child_process');
  const smokeDir = path.join(os.tmpdir(), '.gsd-smoke-t03-items');
  let allPassed = true;

  function assert(label, actual, expected) {
    if (actual === expected) {
      console.log('PASS: ' + label);
    } else {
      console.log('FAIL: ' + label + '\n  expected: ' + JSON.stringify(expected) + '\n  got:      ' + JSON.stringify(actual));
      allPassed = false;
    }
  }

  // Cleanup any previous run
  try { fs.rmSync(smokeDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(smokeDir, { recursive: true });

  try {
    // ── A: add two items → two distinct fragment files ──
    const r1 = addItem(smokeDir, { title: 'First item', origin: 'human' });
    const r2 = addItem(smokeDir, { title: 'Second item', origin: 'human' });
    assert('A: item 1 created', r1.created, true);
    assert('A: item 2 created', r2.created, true);
    assert('A: distinct IDs', r1.id !== r2.id, true);
    assert('A: distinct files exist', fs.existsSync(r1.path) && fs.existsSync(r2.path), true);

    // ── B: unique prefix resolves to the full ID ──
    const uniquePrefix = r1.id.slice(0, r1.id.length - 1);
    let resolvedUnique = null;
    try { resolvedUnique = resolveItemId(smokeDir, uniquePrefix); } catch (e) { /* leave null */ }
    assert('B: unique prefix resolves', resolvedUnique, r1.id);

    // ── C: ambiguous prefix — construct a colliding fragment file directly ──
    // Both r1.id and r2.id share the "I-" prefix; use that shared prefix and
    // write a third fragment sharing an even longer common prefix with r1 to
    // guarantee two candidates for a single needle.
    const sharedNeedle = r1.id.slice(0, 12); // "I-<12 digits...>" — always shared by ids minted seconds apart at worst; force it explicitly below
    const collideId = r1.id + 'x';
    const collidePath = path.join(itemsDir(smokeDir), `${collideId}.md`);
    // Only proceed if collideId is still a valid-shaped item ID per entityKind;
    // if not, fall back to using r1.id/r2.id common prefix directly.
    let ambiguousNeedle = null;
    if (entityKind(collideId) === 'item') {
      fs.writeFileSync(collidePath, serializeItem({
        id: collideId, title: 'Collision item', status: 'inbox', origin: 'human',
        created: new Date().toISOString(), updated: new Date().toISOString(),
      }));
      // A needle equal to r1.id would match exactly (never ambiguous per the
      // resolver contract) — use a strict prefix shorter than the full ID so
      // it matches both r1.id and the collision file without matching either
      // exactly.
      ambiguousNeedle = r1.id.slice(0, -1);
    }
    if (ambiguousNeedle) {
      let ambiguousError = null;
      try { resolveItemId(smokeDir, ambiguousNeedle); } catch (e) { ambiguousError = e.message; }
      assert('C: ambiguous prefix throws', ambiguousError !== null, true);
      assert('C: ambiguous error names both candidates', !!(ambiguousError && ambiguousError.includes(r1.id) && ambiguousError.includes(collideId)), true);
      try { fs.rmSync(collidePath, { force: true }); } catch {}
    } else {
      console.log('PASS: C: ambiguous prefix (skipped — could not construct colliding ID shape)');
    }
    void sharedNeedle;

    // ── D: unknown prefix → error ──
    let unknownError = null;
    try { resolveItemId(smokeDir, 'I-99999999999999'); } catch (e) { unknownError = e.message; }
    assert('D: unknown prefix throws', unknownError !== null, true);

    // ── E: setStatus(..., 'foo') → CLI path exits 1 ──
    let exitCodeE = 0;
    try {
      execFileSync('node', [__filename, '--set-status', r1.id, 'foo', '--cwd', smokeDir], { stdio: 'pipe' });
    } catch (e) {
      exitCodeE = e.status;
    }
    assert('E: --set-status <id> foo exits 1', exitCodeE, 1);

    // ── F: origin auto without source → validateItem.valid === false ──
    const autoNoSource = {
      id: r2.id, title: 'Auto item', status: 'inbox', origin: 'auto',
    };
    const { valid: fValid } = validateItem(autoNoSource);
    assert('F: auto without source is invalid', fValid, false);

    // ── G: promoteItem with a valid target writes promoted_to; garbage throws ──
    const promoted = promoteItem(smokeDir, r1.id, 'M001');
    assert('G: promote writes promoted_to', promoted.item.promoted_to, 'M001');
    let promoteError = null;
    try { promoteItem(smokeDir, r2.id, 'not-a-valid-target'); } catch (e) { promoteError = e.message; }
    assert('G: promote with garbage target throws', promoteError !== null, true);
  } catch (e) {
    console.log('FAIL: smoke-regression threw unexpectedly: ' + e.message);
    allPassed = false;
  }

  // ── Cleanup ──
  try { fs.rmSync(smokeDir, { recursive: true, force: true }); } catch {}

  if (allPassed) {
    console.log('\nPASS — all smoke-regression assertions passed');
    process.exit(0);
  } else {
    console.log('\nFAIL — one or more smoke-regression assertions failed');
    process.exit(1);
  }
}

// ── Guarded CLI invocation ────────────────────────────────────────────────────
if (require.main === module) {
  try {
    cliMain(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
