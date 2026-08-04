'use strict';

// forge-sweep-journal.js — append-only pointer journal for forge-sweep undo.
//
// The journal records ONLY pointers: container paths (relative POSIX), ids,
// timestamps, operation, phase and an advisory sha256 of the container.  It
// NEVER stores member/fragment bytes — the container itself is the single
// source of truth for content (see S08-RISK.md § W3). Storing content here
// "just to be safe" would recreate exactly the silent-divergence risk this
// milestone spent six slices removing.
//
// No function in this module's public API throws. Every I/O boundary is
// wrapped in try/catch and failures come back as { ok: false, error }.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { nowTimestamp } = require('./forge-ids');
const { STORE_TARGETS, WRAPPER_TARGETS, isDirectChild } = require('./forge-epoch-group');

function journalPath(cwd) {
  return path.join(cwd, '.gsd', 'forge', 'sweep-journal.jsonl');
}

function randomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

function toPosix(relPath) {
  return String(relPath).split(path.sep).join('/');
}

// Normalize a caller-supplied container path (write side — trusted, we wrote
// it ourselves this call) to a relative POSIX string, relative to cwd if it
// happens to be absolute.
function normalizeContainerForWrite(cwd, containerPath) {
  const abs = path.isAbsolute(containerPath) ? containerPath : path.resolve(cwd, containerPath);
  const rel = path.relative(cwd, abs);
  return toPosix(rel);
}

// The set of directories a journal-referenced container is allowed to live
// directly under. Mirrors forge-epoch-group's own store roots — a container
// this journal ever pointed at was created by that module, so it must
// resolve as a direct child of one of these directories.
function storeRoots(cwd) {
  const roots = [];
  for (const store of STORE_TARGETS) {
    try { roots.push(store.dir(cwd)); } catch (_) { /* ignore */ }
  }
  for (const wrapper of WRAPPER_TARGETS) {
    try { roots.push(wrapper.parent(cwd)); } catch (_) { /* ignore */ }
  }
  return roots;
}

// Read-side validation (the vector T05 depends on): a container path coming
// back out of the journal is untrusted input. Reject anything that isn't a
// plain relative POSIX string resolving as a direct child of a known
// fragment/wrapper store — no absolute paths, no `..`, no Windows separators
// smuggled through, no traversal into a sibling directory.
function safeContainerPath(cwd, relPosix) {
  if (typeof relPosix !== 'string' || !relPosix || path.isAbsolute(relPosix)) return null;
  if (relPosix.includes('\\')) return null;
  const resolved = path.resolve(cwd, relPosix);
  const roots = storeRoots(cwd);
  for (const root of roots) {
    if (isDirectChild(root, resolved)) return resolved;
  }
  return null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// probe(cwd) — checks the journal is writable without recording a line.
// Opens the file for append and closes it immediately (creates the parent
// dir and/or the file itself if missing).
function probe(cwd) {
  try {
    const file = journalPath(cwd);
    ensureDir(path.dirname(file));
    const fd = fs.openSync(file, 'a');
    fs.closeSync(fd);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function appendLine(cwd, record) {
  try {
    const file = journalPath(cwd);
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf-8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// appendIntent(cwd, { operation, containers }) → { ok, id } | { ok:false, error }
function appendIntent(cwd, opts) {
  try {
    const operation = opts && opts.operation;
    const containersIn = (opts && Array.isArray(opts.containers)) ? opts.containers : [];
    const containers = containersIn.map(c => normalizeContainerForWrite(cwd, c));
    const id = `${nowTimestamp()}-${randomSuffix()}`;
    const record = {
      id,
      ts: nowTimestamp(),
      phase: 'apply-intent',
      operation,
      containers,
    };
    const result = appendLine(cwd, record);
    if (!result.ok) return result;
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// appendOutcome(cwd, { id, phase, written, sha256 }) → { ok, id } | { ok:false, error }
// phase: 'apply-done' | 'undo-done'
function appendOutcome(cwd, opts) {
  try {
    const id = opts && opts.id;
    const phase = opts && opts.phase;
    if (!id || (phase !== 'apply-done' && phase !== 'undo-done')) {
      return { ok: false, error: 'appendOutcome requires id and phase apply-done|undo-done' };
    }
    const writtenIn = (opts && Array.isArray(opts.written)) ? opts.written : [];
    const containers = writtenIn.map(c => normalizeContainerForWrite(cwd, c));
    const record = { id, ts: nowTimestamp(), phase, containers };
    if (opts && opts.sha256 && typeof opts.sha256 === 'object') {
      record.sha256 = opts.sha256;
    }
    const result = appendLine(cwd, record);
    if (!result.ok) return result;
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// listEntries(cwd) → { ok, entries: [...] } — tolerant per-line parsing.
// Corrupted lines are warned to stderr (index + reason only, never the raw
// line contents) and skipped; they never abort the listing.
function listEntries(cwd) {
  try {
    const file = journalPath(cwd);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (e) {
      if (e.code === 'ENOENT') return { ok: true, entries: [] };
      throw e;
    }
    const lines = raw.split('\n').filter(line => line.trim().length > 0);
    const entries = [];
    lines.forEach((line, index) => {
      try {
        const parsed = JSON.parse(line);
        // Read named fields explicitly — never spread the parsed object.
        // Guards against prototype-pollution via a tampered __proto__/
        // constructor key in an adulterated line.
        const entry = {
          id: typeof parsed.id === 'string' ? parsed.id : null,
          ts: typeof parsed.ts === 'string' ? parsed.ts : null,
          phase: typeof parsed.phase === 'string' ? parsed.phase : null,
          operation: typeof parsed.operation === 'string' ? parsed.operation : undefined,
          containers: Array.isArray(parsed.containers)
            ? parsed.containers.filter(c => typeof c === 'string')
            : [],
        };
        if (parsed.sha256 && typeof parsed.sha256 === 'object' && !Array.isArray(parsed.sha256)) {
          entry.sha256 = Object.create(null);
          for (const key of Object.keys(parsed.sha256)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            if (typeof parsed.sha256[key] === 'string') entry.sha256[key] = parsed.sha256[key];
          }
        }
        entries.push(entry);
      } catch (_) {
        process.stderr.write(`[forge-sweep-journal] warn: skipping corrupted line ${index + 1}\n`);
      }
    });
    return { ok: true, entries };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// latestUndoable(cwd) → { ok, entry|null }
// Walks entries newest-first; the first apply-done record whose containers
// ALL (a) resolve safely inside a known store, and (b) still exist on disk,
// wins. Records with an unsafe/escaping path are treated the same as
// records with a missing container — skipped, never trusted.
function latestUndoable(cwd) {
  const listed = listEntries(cwd);
  if (!listed.ok) return listed;
  const entries = listed.entries;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.phase !== 'apply-done') continue;
    const containers = Array.isArray(entry.containers) ? entry.containers : [];
    if (containers.length === 0) continue;
    let allSafeAndPresent = true;
    for (const container of containers) {
      const resolved = safeContainerPath(cwd, container);
      if (!resolved || !fs.existsSync(resolved)) {
        allSafeAndPresent = false;
        break;
      }
    }
    if (allSafeAndPresent) return { ok: true, entry };
  }
  return { ok: true, entry: null };
}

module.exports = {
  journalPath,
  probe,
  appendIntent,
  appendOutcome,
  listEntries,
  latestUndoable,
  _private: { safeContainerPath, storeRoots, normalizeContainerForWrite },
};
