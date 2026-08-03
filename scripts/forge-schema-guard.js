#!/usr/bin/env node
'use strict';

/*
 * forge-schema-guard.js — directional schema guard seam (M-S01 T03).
 *
 * INVARIANTS:
 *  - Read is fail-open, unconditionally. Absent or unparseable
 *    `.gsd/SCHEMA-VERSION` NEVER blocks a read and NEVER produces a warning —
 *    a repo with no stamp, or a stamp neither side can parse, behaves exactly
 *    like today. `guardRead` never throws: every branch is wrapped so a
 *    missing cwd or a garbage file degrades to the same fail-open result.
 *  - Write refusal is intentional. When the data's major version is AHEAD of
 *    the major the tooling understands, the data was pushed by newer tooling
 *    (SVN model) — writing under old code risks silently dropping content
 *    that newer code would have understood (see forge-hook.js buildSchemaWarning
 *    for the mirror-image danger: tooling older than repo). `assertWrite`
 *    returns `{ ok: false }` in that case; it does not throw — the caller
 *    (CLI here, and the 4 fragment-store readers in T04) decides whether that
 *    becomes a thrown error or a non-zero exit.
 *  - Only the MAJOR component decides direction. `cmpSemver` still compares
 *    all three components and stays exported for reuse/compat, but the guard
 *    itself only looks at `parsed[0]`. A minor/patch bump on either side is
 *    invisible to this seam by design (Section 5 of the test suite pins this).
 *  - Zero-dep, CommonJS, primitives-first, normalized return values, CLI
 *    guarded below `module.exports` — same shape as forge-vcs.js.
 */

const path = require('path');

// readSchemaVersion(cwd) is the single source of truth for reading
// `.gsd/SCHEMA-VERSION` (fail-open, returns null on any read error). This
// module deliberately does not reimplement file reading.
const { readSchemaVersion } = require('./forge-migrate.js');

// ── parseSchemaSemver ────────────────────────────────────────────────────────
// Parses the semver embedded in a schema string ("fragment-store@1.0.0" →
// [1,0,0]). Returns null when the version cannot be parsed. Extracted
// verbatim from the private copy that used to live in forge-hook.js.
function parseSchemaSemver(s) {
  const m = String(s || '').match(/@(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// ── cmpSemver ────────────────────────────────────────────────────────────────
// Compares two [major,minor,patch] tuples → -1 | 0 | 1. Kept for reuse/compat
// (also extracted verbatim); the directional guard below only reads a[0]
// vs b[0] — see the invariant note above.
function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; }
  return 0;
}

// ── toolingSchema resolution ──────────────────────────────────────────────────
// Lazily require forge-doctor.js for CURRENT_SCHEMA. Lazy (not top-level)
// because forge-doctor.js is loaded via dev/installed dual-path resolution
// elsewhere in the repo (see forge-hook.js loadDoctor) and to keep this
// module importable even in contexts where forge-doctor.js is not colocated
// (no cycle exists today — forge-doctor.js does not require forge-migrate.js
// or this file — but resolving lazily avoids ever introducing one silently).
function defaultToolingSchema() {
  try {
    return require('./forge-doctor.js').CURRENT_SCHEMA;
  } catch (_) {
    return null;
  }
}

// ── checkSchemaDirection ──────────────────────────────────────────────────────
// { ok, ahead, dataSchema, toolingSchema, message }
// ahead === true only when BOTH sides parse and major(data) > major(tooling).
function checkSchemaDirection(cwd, opts) {
  const options = opts || {};
  const toolingSchema = typeof options.toolingSchema === 'string'
    ? options.toolingSchema
    : defaultToolingSchema();

  let dataSchema = null;
  try {
    dataSchema = readSchemaVersion(cwd);
  } catch (_) {
    dataSchema = null;
  }

  const dataParsed = parseSchemaSemver(dataSchema);
  const toolingParsed = parseSchemaSemver(toolingSchema);

  // Fail-open: absent/unparseable on either side is never "ahead".
  if (!dataParsed || !toolingParsed) {
    return { ok: true, ahead: false, dataSchema, toolingSchema, message: null };
  }

  const ahead = dataParsed[0] > toolingParsed[0];
  return {
    ok: true,
    ahead,
    dataSchema,
    toolingSchema,
    message: ahead
      ? `schema major ${dataParsed[0]} (data) > ${toolingParsed[0]} (tooling)`
      : null,
  };
}

// ── formatSchemaWarning ───────────────────────────────────────────────────────
// High-visibility pt-BR warning string for a checkSchemaDirection() result
// where ahead === true. Cites dataSchema, toolingSchema and the fix action.
function formatSchemaWarning(res) {
  const header = '⚠️ ATENÇÃO — schema do Forge à frente da tooling local';
  return [
    header,
    `O dado em .gsd/SCHEMA-VERSION (${res.dataSchema}) está à frente da tooling Forge local (${res.toolingSchema}).`,
    'Rode /forge-update para atualizar a tooling antes de escrever neste fragment store.',
  ].join('\n');
}

// ── guardRead ──────────────────────────────────────────────────────────────
// { ok: true, partial: <ahead>, warning: <string|null> } — never throws.
function guardRead(cwd, opts) {
  try {
    const res = checkSchemaDirection(cwd, opts);
    if (!res.ahead) return { ok: true, partial: false, warning: null };
    return { ok: true, partial: true, warning: formatSchemaWarning(res) };
  } catch (_) {
    // Total fail-open: any unexpected error reading/parsing degrades to a
    // clean, silent read — reading must never be the thing that breaks.
    return { ok: true, partial: false, warning: null };
  }
}

// ── assertWrite ───────────────────────────────────────────────────────────────
// { ok: <!ahead>, message: <string|null> } — returns, never throws. The
// caller (CLI below, and the 4 fragment-store writers in T04) decides
// whether a false `ok` becomes a thrown error or a non-zero exit.
function assertWrite(cwd, opts) {
  let res;
  try {
    res = checkSchemaDirection(cwd, opts);
  } catch (_) {
    // A runtime error while checking direction must not block a write that
    // would otherwise be legal — treat as fail-open, mirroring guardRead.
    return { ok: true, message: null };
  }
  if (!res.ahead) return { ok: true, message: null };
  return { ok: false, message: formatSchemaWarning(res) };
}

// ── Warning dedupe (T04) ─────────────────────────────────────────────────────
// One emission per process per cwd. Without this a single `--render` that walks
// N fragments through N guarded reads would print N identical warnings and bury
// the signal it exists to raise. The Set lives HERE (not in each of the 4
// readers) so the four wire the exact same mechanic — forge-projection.renderX
// calls forge-ledger.listFragments, so a per-file Set would still double-emit.
// Keyed by path.resolve(cwd): two spellings of the same directory are one key.
const WARNED_CWDS = new Set();

// ── emitSchemaWarningOnce ────────────────────────────────────────────────────
// Writes `warning` to stderr at most once per (process, resolved cwd).
// Returns true when it actually emitted. NEVER throws and never writes to
// stdout — a read must never fail because a warning could not be printed
// (stderr closed, EPIPE, unresolvable cwd).
function emitSchemaWarningOnce(cwd, warning) {
  if (!warning) return false;
  try {
    const key = path.resolve(cwd || process.cwd());
    if (WARNED_CWDS.has(key)) return false;
    WARNED_CWDS.add(key);
    process.stderr.write(`${warning}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

// Test-only seam: lets a suite exercise dedupe across scenarios inside one
// process. Not used by production code.
function _resetSchemaWarnings() {
  WARNED_CWDS.clear();
}

// ── guardReadAndWarn ─────────────────────────────────────────────────────────
// The single read-side entry point the 4 fragment-store readers call:
// guardRead + deduped stderr emission in one step. Returns guardRead's shape
// unchanged ({ ok, partial, warning }) — `partial` stays true on every call,
// including the ones whose warning was deduped, so envelope marking never
// depends on emission order. Never throws (fail-open all the way down).
function guardReadAndWarn(cwd, opts) {
  const res = guardRead(cwd, opts);
  if (res.partial) emitSchemaWarningOnce(cwd, res.warning);
  return res;
}

// ── assertWriteOrThrow ───────────────────────────────────────────────────────
// The single write-side entry point. assertWrite returns rather than throws by
// design (T03 invariant); the fragment-store writers want a throw, because the
// CLI `catch` blocks already translate a thrown Error into "message on stderr +
// exit 1". Placed at the TOP of each writeFragment/writeAll so the refusal
// happens before any bytes reach disk.
function assertWriteOrThrow(cwd, opts) {
  const res = assertWrite(cwd, opts);
  if (!res.ok) throw new Error(res.message);
  return res;
}

module.exports = {
  parseSchemaSemver,
  cmpSemver,
  checkSchemaDirection,
  guardRead,
  assertWrite,
  formatSchemaWarning,
  emitSchemaWarningOnce,
  guardReadAndWarn,
  assertWriteOrThrow,
  _resetSchemaWarnings,
};

// ── CLI ────────────────────────────────────────────────────────────────────
// node forge-schema-guard.js --check [--cwd <dir>]
// Exit 0 success (even ahead:true — diagnostic, not a gate), 1 runtime error,
// 2 invalid args. Warning goes to stderr, never stdout.
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) out._.push(arg);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[++i];
    else out[arg.slice(2)] = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check !== true || args._.length !== 0) {
    process.stderr.write('forge-schema-guard: --check [--cwd <dir>] is required\n');
    return 2;
  }
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd();
  try {
    const res = checkSchemaDirection(cwd, {});
    if (res.ahead) {
      process.stderr.write(`${formatSchemaWarning(res)}\n`);
    }
    process.stdout.write(`${JSON.stringify({
      ok: res.ok,
      ahead: res.ahead,
      dataSchema: res.dataSchema,
      toolingSchema: res.toolingSchema,
      message: res.message,
    })}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`forge-schema-guard: ${e && e.message ? e.message : String(e)}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
