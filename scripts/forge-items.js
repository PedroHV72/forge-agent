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
//   promoteItem(cwd, idOrPrefix, targetId) → { id, path, item }
//   resolveItemId(cwd, prefix)         → string   // unique prefix → full ID
//
// CLI:
//   (added in T03 — this file currently exposes a usage stub and exits 2)
//
// Exit codes:
//   0 — success
//   1 — runtime error (invalid id, parse error, etc.)
//   2 — unknown/missing arguments

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

// Provenance regimes. `auto` items must carry a `source`; `human` items need not.
const ORIGINS = Object.freeze(['human', 'auto']);

// Frozen key order for diff stability. Unknown keys are emitted after these,
// sorted alphabetically, so third-party additions never reshuffle the core block.
const KEY_ORDER = Object.freeze([
  'id', 'title', 'status', 'origin', 'created', 'updated',
  'source', 'file', 'sha', 'milestone', 'promoted_to',
]);

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

  if (item.promoted_to !== undefined && item.promoted_to !== null && item.promoted_to !== '') {
    if (!isValidPromotionTarget(item.promoted_to)) {
      errors.push(
        `promoted_to must be a valid milestone or task ID; got "${item.promoted_to}"`
      );
    }
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
  itemsDir,
  itemPath,
  parseItem,
  serializeItem,
  validateItem,
  addItem,
  readItem,
  listItems,
  updateItem,
  setStatus,
  promoteItem,
  resolveItemId,
};

// ── cliMain ───────────────────────────────────────────────────────────────────
// Placeholder — the real CLI surface lands in T03. Kept so the file is runnable
// (and require-safe) at every commit.
function printUsage() {
  console.log(`Usage: node forge-items.js <command> [options]

The forge-items CLI is not available yet (lands in T03).
This module is currently library-only; require() it from Node:

  const items = require('./forge-items');
  items.addItem(cwd, { title: '...', origin: 'human' });

Exit codes:
  0  Success
  1  Runtime error
  2  Unknown or missing arguments`);
}

function cliMain(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    process.exit(0);
  }
  printUsage();
  process.exit(2);
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
