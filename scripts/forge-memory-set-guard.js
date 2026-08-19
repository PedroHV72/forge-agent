#!/usr/bin/env node
'use strict';

// forge-memory-set-guard.js — compares mem_id SETS across a before/after
// snapshot pair and enumerates every identifier that left the set by name.
//
// Scope, deliberately narrow: this module answers "which mem_id values
// present before are absent after", nothing more. It does not read any
// memory projection itself — callers supply already-loaded snapshots — and
// it is not wired into any production write path in this task.
//
// Why a set comparison and not a length comparison: a before/after pair can
// have EQUAL array length while every original identifier is gone (ten
// removed, two new identifiers repeated across the same number of records).
// A length check does not move in that case. This module compares identity
// (the set of mem_id values), never cardinality.
//
// The sequence that produces such a pair in production was NOT determined
// by this task. This module and its suite describe only observable
// before/after snapshots and removed mem_id values.
//
// Zero dependencies. CommonJS.

/**
 * Validate that `snapshot` is an array of fact-like objects, each carrying a
 * non-empty string `mem_id`.
 * @param {*} snapshot
 * @param {string} label - used only in the thrown message.
 */
function assertValidSnapshot(snapshot, label) {
  if (!Array.isArray(snapshot)) {
    throw new TypeError(`${label} must be an array`);
  }
  for (let i = 0; i < snapshot.length; i++) {
    const entry = snapshot[i];
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`${label}[${i}] must be an object with a mem_id`);
    }
    if (typeof entry.mem_id !== 'string' || entry.mem_id.length === 0) {
      throw new TypeError(`${label}[${i}] must have a non-empty string mem_id`);
    }
  }
}

/**
 * Compare the unique mem_id SET of `before` against the unique mem_id SET of
 * `after`. Identity is the set, not array length — duplicate records in
 * either snapshot never distort the result.
 *
 * @param {Array<{mem_id: string}>} before
 * @param {Array<{mem_id: string}>} after
 * @returns {{ok: boolean, before_count: number, after_count: number, removed: string[]}}
 */
function checkMemIdSet(before, after) {
  assertValidSnapshot(before, 'before');
  assertValidSnapshot(after, 'after');

  const beforeSet = new Set(before.map((e) => e.mem_id));
  const afterSet = new Set(after.map((e) => e.mem_id));

  const removed = [];
  for (const id of beforeSet) {
    if (!afterSet.has(id)) removed.push(id);
  }
  removed.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    ok: removed.length === 0,
    before_count: beforeSet.size,
    after_count: afterSet.size,
    removed,
  };
}

module.exports = { checkMemIdSet, assertValidSnapshot };

// ── CLI ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    let input;
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      input = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`forge-memory-set-guard: malformed JSON on stdin: ${e.message}\n`);
      process.exit(2);
      return;
    }

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      process.stderr.write('forge-memory-set-guard: input must be a JSON object with before/after arrays\n');
      process.exit(2);
      return;
    }

    let result;
    try {
      result = checkMemIdSet(input.before, input.after);
    } catch (e) {
      process.stderr.write(`forge-memory-set-guard: malformed snapshot: ${e.message}\n`);
      process.exit(2);
      return;
    }

    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  });
}
