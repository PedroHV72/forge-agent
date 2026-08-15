'use strict';

// forge-memory-rewrite.js -- deliberately narrow, byte-conscious fact removal.
//
// This is not a second memory serializer.  Its only serialization boundary is
// forge-memory's canonical serializer; the canonicity fence below makes that
// dependency safe for a curatorial edit of an already persisted fragment.

const fs = require('fs');
const path = require('path');

const memory = require('./forge-memory');

const REWRITE_REFUSALS = Object.freeze([
  'missing-fragment',
  'grouped-survivor',
  'mixed-eol',
  'non-canonical-fragment',
  'unknown-fact',
  'would-empty-fragment',
  'read-failed',
  'parse-failed',
  'write-failed',
]);

// These labels are deliberately data rather than ad-hoc error messages.  The
// caller can present them to a human and T03 can decide whether a refusal is
// retryable without having to match localized I/O text.

// EOL normalization is only an equivalence relation for the fence.  It is not
// used for output until `applyEol`, after the live file's spelling is known.
function normalizeEol(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

// A bare CR is not an EOL spelling this writer is allowed to choose.  Calling
// it mixed is intentionally conservative: it stops a later write from quietly
// turning an old-Mac line ending into LF or CRLF.
function detectEol(text) {
  const value = String(text);
  const crlf = (value.match(/\r\n/g) || []).length;
  const loneLf = (value.match(/(?<!\r)\n/g) || []).length;
  const loneCr = (value.match(/\r(?!\n)/g) || []).length;
  if (loneCr || (crlf && loneLf)) return 'mixed';
  if (crlf) return 'crlf';
  return 'lf';
}

function applyEol(text, eol) {
  const normalized = normalizeEol(text);
  return eol === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function serializedFragment(fragment) {
  const frontmatter = memory.serializeFrontmatter(fragment);
  const body = fragment.body ? `\n${fragment.body}` : '';
  return `---\n${frontmatter}\n---\n${body}`;
}

function refusal(reason, targetPath) {
  return { ok: false, reason, path: targetPath || null };
}

function validDrops(dropMemIds) {
  return Array.isArray(dropMemIds)
    && dropMemIds.length > 0
    && dropMemIds.every(id => typeof id === 'string' && id.length > 0);
}

// A random suffix means simultaneous callers never select each other's
// temporary inode.  The temp name stays next to the target so rename remains
// an atomic same-directory operation on filesystems that support atomic rename.
function atomicWrite(targetPath, content, fileSystem) {
  const directory = path.dirname(targetPath);
  const temporary = path.join(
    directory,
    `.${path.basename(targetPath)}.rewrite-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    fileSystem.writeFileSync(temporary, content, 'utf8');
    fileSystem.renameSync(temporary, targetPath);
  } catch (error) {
    try {
      if (fileSystem.existsSync(temporary)) fileSystem.unlinkSync(temporary);
    } catch (_) {
      // The original target is still untouched; a failed cleanup never changes
      // the named outcome of the rewrite operation.
    }
    throw error;
  }
}

// Removes facts only from a loose, canonical fragment.  The compound address
// is (storageKey, mem_id): the same mem_id in another fragment is irrelevant.
//
// The optional fs seam is intentionally not part of the persistence contract:
// it exists to prove the failure path without monkey-patching Node globals.
// Production callers omit it and receive the ordinary built-in fs module.
function rewriteFragment(cwd, request, opts) {
  const options = opts || {};
  const fileSystem = options.fs || fs;
  const storageKey = request && request.storageKey;
  const dropMemIds = request && request.dropMemIds;
  let entry;

  try {
    entry = typeof storageKey === 'string'
      ? memory.listFragments(cwd).find(item => item.storageKey === storageKey)
      : null;
  } catch (_) {
    return refusal('read-failed', null);
  }

  if (!entry) return refusal('missing-fragment', null);
  if (entry.grouped === true) return refusal('grouped-survivor', entry.path);
  if (!validDrops(dropMemIds)) return refusal('unknown-fact', entry.path);

  // The raw text below is the live source of truth.  In particular, EOL is
  // never inferred from a parsed representation because parsing discards it.
  let liveText;
  try {
    // readFragmentText is intentional even for loose entries: this keeps the
    // parser boundary shared with the store and avoids a parallel reader.
    liveText = memory.readFragmentText(cwd, entry);
  } catch (_) {
    return refusal('read-failed', entry.path);
  }

  const eol = detectEol(liveText);
  if (eol === 'mixed') return refusal('mixed-eol', entry.path);

  let fragment;
  try {
    fragment = memory.parseFragment(normalizeEol(liveText));
  } catch (_) {
    return refusal('parse-failed', entry.path);
  }

  // Compare canonical LF forms before any validation that could lead to a
  // write.  Thus no formatting drift can be attributed to fact removal.
  if (normalizeEol(serializedFragment(fragment)) !== normalizeEol(liveText)) {
    return refusal('non-canonical-fragment', entry.path);
  }

  const facts = Array.isArray(fragment.facts) ? fragment.facts : [];
  const requested = new Set(dropMemIds);
  const present = new Set(facts.map(fact => String(fact.mem_id || '')));
  for (const memId of requested) {
    if (!present.has(memId)) return refusal('unknown-fact', entry.path);
  }

  const remainingFacts = facts.filter(fact => !requested.has(String(fact.mem_id || '')));
  if (remainingFacts.length === 0) return refusal('would-empty-fragment', entry.path);

  // `filter` retains the exact fact object references.  No field of a
  // surviving fact is touched, including unknown future fields.
  const rewritten = { ...fragment, facts: remainingFacts };
  const nextText = applyEol(serializedFragment(rewritten), eol);
  try {
    atomicWrite(entry.path, nextText, fileSystem);
  } catch (_) {
    return refusal('write-failed', entry.path);
  }

  return {
    ok: true,
    path: entry.path,
    eol,
    removed: facts.filter(fact => requested.has(String(fact.mem_id || ''))).map(fact => fact.mem_id),
    bytes_before: Buffer.byteLength(liveText, 'utf8'),
    bytes_after: Buffer.byteLength(nextText, 'utf8'),
  };
}

module.exports = {
  // Consumers use this named operation rather than writeFragment because this
  // module permits deletion while the append-only store correctly does not.
  // All refusal outcomes remain values, never exceptions at this boundary.
  rewriteFragment,
  detectEol,
  applyEol,
  REWRITE_REFUSALS,
  _private: { normalizeEol, serializedFragment, refusal, validDrops, atomicWrite },
};
