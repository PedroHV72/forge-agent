#!/usr/bin/env node
'use strict';

/*
 * forge-schema-guard.js — directional schema guard seam (M-S01 T03).
 *
 * THE STAMP HAS THREE STATES, and the two sides treat them differently:
 *
 *   state                          | guardRead        | assertWrite
 *   -------------------------------|------------------|---------------------
 *   absent (no .gsd, no file)      | clean, no warning| allowed
 *   garbage but READABLE ("lixo")  | clean, no warning| allowed
 *   UNREADABLE (EISDIR/EACCES/…)   | clean, no warning| REFUSED (errno named)
 *
 * INVARIANTS:
 *  - Read is fail-open, unconditionally, in ALL THREE states above. A repo with
 *    no stamp, a stamp neither side can parse, or a stamp that cannot be read at
 *    all behaves exactly like today on the read side. `guardRead` never throws:
 *    every branch is wrapped so a missing cwd or a garbage file degrades to the
 *    same fail-open result. Reading must never be the thing that breaks.
 *  - Write refusal is intentional, and there are TWO conditions for it:
 *    (1) The data's major version is AHEAD of the major the tooling understands:
 *        the data was pushed by newer tooling (SVN model) — writing under old
 *        code risks silently dropping content that newer code would have
 *        understood (see forge-hook.js buildSchemaWarning for the mirror-image
 *        danger: tooling older than repo).
 *    (2) The stamp EXISTS BUT COULD NOT BE READ (`unreadable`). A guard that
 *        could not read the stamp knows nothing about direction, and "I could
 *        not measure it" is not evidence of safety in either direction (the
 *        precedent from PR #68: an unanswered question is not evidence). Before
 *        this, a directory named `.gsd/SCHEMA-VERSION` disabled the write guard
 *        silently — found by dogfood on PR #70. Absence is NOT this state:
 *        absence is a legitimate, common, pre-stamp repo and still writes.
 *    In both cases `assertWrite` returns `{ ok: false }`; it does not throw —
 *    the caller (CLI here, and the 4 fragment-store writers in T04) decides
 *    whether that becomes a thrown error or a non-zero exit.
 *  - Only the MAJOR component decides direction. `cmpSemver` still compares
 *    all three components and stays exported for reuse/compat, but the guard
 *    itself only looks at `parsed[0]`. A minor/patch bump on either side is
 *    invisible to this seam by design (Section 5 of the test suite pins this).
 *  - Zero-dep, CommonJS, primitives-first, normalized return values, CLI
 *    guarded below `module.exports` — same shape as forge-vcs.js.
 */

const path = require('path');

// readSchemaVersionDetailed(cwd) is the single source of truth for reading
// `.gsd/SCHEMA-VERSION`. This module deliberately does not reimplement file
// reading. The Detailed variant (not the plain `readSchemaVersion`, which
// collapses every failure into null) is used because the write side must tell
// "absent" apart from "unreadable" — see the three-state table above.
const { readSchemaVersionDetailed } = require('./forge-migrate.js');

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
// { ok, ahead, unreadable, errno, dataSchema, toolingSchema, message }
// ahead === true only when BOTH sides parse and major(data) > major(tooling).
// unreadable === true when the stamp exists but could not be read; it is a
// SEPARATE axis from `ahead` (an unreadable stamp yields ahead:false, because
// direction was never measured). Both `unreadable` and `errno` are additive
// fields: every consumer reads named fields, none spreads or iterates this
// object, so adding them cannot change existing behaviour — but the write side
// MUST NOT collapse them into `ahead:false` again, which is exactly the bug
// this closes.
function checkSchemaDirection(cwd, opts) {
  const options = opts || {};
  const toolingSchema = typeof options.toolingSchema === 'string'
    ? options.toolingSchema
    : defaultToolingSchema();

  let dataSchema = null;
  let unreadable = false;
  let errno = null;
  try {
    const read = readSchemaVersionDetailed(cwd);
    dataSchema = read.value;
    unreadable = read.unreadable === true;
    errno = read.errno;
  } catch (_) {
    // The reader is documented never to throw; if it somehow does, we know even
    // less than in the unreadable case. Stay on the historical fail-open path
    // rather than inventing a state we did not measure.
    dataSchema = null;
    unreadable = false;
    errno = null;
  }

  const dataParsed = parseSchemaSemver(dataSchema);
  const toolingParsed = parseSchemaSemver(toolingSchema);

  // Fail-open on DIRECTION: absent/unparseable on either side is never "ahead".
  // `unreadable` still travels out of here untouched — the read side ignores it,
  // the write side refuses on it.
  if (!dataParsed || !toolingParsed) {
    return { ok: true, ahead: false, unreadable, errno, dataSchema, toolingSchema, message: null };
  }

  const ahead = dataParsed[0] > toolingParsed[0];
  return {
    ok: true,
    ahead,
    unreadable,
    errno,
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

// ── formatUnreadableStampRefusal ──────────────────────────────────────────────
// High-visibility pt-BR refusal string for the `unreadable` write case. It is
// deliberately NOT formatSchemaWarning: that one interpolates res.dataSchema,
// which is null on this path, and would claim "O dado em .gsd/SCHEMA-VERSION
// (null) está à frente da tooling" — an assertion about a direction that was
// never measured. Names the errno instead, because the errno is the only thing
// we actually know, and it is what tells the operator what to fix (EISDIR: a
// directory sits where the file belongs; EACCES/EPERM: permissions).
function formatUnreadableStampRefusal(res) {
  const header = '⚠️ ATENÇÃO — .gsd/SCHEMA-VERSION existe mas não pôde ser lido';
  const errno = res && res.errno ? res.errno : 'desconhecido';
  return [
    header,
    `A leitura de .gsd/SCHEMA-VERSION falhou com ${errno}, então a direção do schema não pôde ser verificada.`,
    'Escrita recusada: um guard que não conseguiu medir o schema não pode autorizar a escrita.',
    'Verifique o caminho .gsd/SCHEMA-VERSION (ele deve ser um ARQUIVO legível) e tente de novo.',
  ].join('\n');
}

// ── guardRead ──────────────────────────────────────────────────────────────
// { ok: true, partial: <ahead>, warning: <string|null> } — never throws.
function guardRead(cwd, opts) {
  try {
    const res = checkSchemaDirection(cwd, opts);
    // NOTE: `res.unreadable` is deliberately NOT consulted here. The read side
    // stays fail-open in all three stamp states — only the write side refuses.
    // The asymmetry is the design (see the table at the top of this file).
    if (!res.ahead) return { ok: true, partial: false, warning: null };
    return { ok: true, partial: true, warning: formatSchemaWarning(res) };
  } catch (_) {
    // Total fail-open: any unexpected error reading/parsing degrades to a
    // clean, silent read — reading must never be the thing that breaks.
    return { ok: true, partial: false, warning: null };
  }
}

// ── assertWrite ───────────────────────────────────────────────────────────────
// { ok: <!ahead && !unreadable>, message: <string|null> } — returns, never
// throws. The caller (CLI below, and the 4 fragment-store writers in T04)
// decides whether a false `ok` becomes a thrown error or a non-zero exit.
function assertWrite(cwd, opts) {
  let res;
  try {
    res = checkSchemaDirection(cwd, opts);
  } catch (_) {
    // Distinguish the two error shapes: an error RAISED BY THIS CHECK ITSELF
    // (unexpected runtime fault in the guard's own code) must not block a write
    // that would otherwise be legal, so this stays fail-open. An error READING
    // THE STAMP is a different thing entirely — it never reaches this catch,
    // because the reader reports it as `res.unreadable` below, and that path
    // REFUSES. This catch used to be the only line of defense and was
    // unreachable for the real EISDIR case (PR #70 dogfood); it is now the
    // narrow net it was always meant to be.
    return { ok: true, message: null };
  }
  // Refuse first on "could not read the stamp": at this point `ahead` is false
  // only because direction was never measured, so checking `ahead` first would
  // hand back an allow for a repo we know nothing about.
  if (res.unreadable) return { ok: false, message: formatUnreadableStampRefusal(res) };
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
  formatUnreadableStampRefusal,
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

/**
 * Validate the parsed argv shape against the documented CLI contract. Anything
 * else — unknown flag, positional argument, valueless `--cwd` — is exit 2. A
 * valueless `--cwd` must never silently fall back to process.cwd(): that would
 * inspect a different repository than the operator typed while reporting
 * success.
 *
 * @param {object} args
 * @returns {boolean}
 */
function validArgs(args) {
  if (!args || args._.length !== 0) return false;
  const keys = Object.keys(args).filter(k => k !== '_');
  if (keys.some(k => k !== 'check' && k !== 'cwd')) return false;
  if (args.check !== true) return false;
  if ('cwd' in args && (typeof args.cwd !== 'string' || args.cwd === '')) return false;
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!validArgs(args)) {
    process.stderr.write('forge-schema-guard: --check [--cwd <dir>] is required\n');
    return 2;
  }
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd();
  try {
    const res = checkSchemaDirection(cwd, {});
    if (res.ahead) {
      process.stderr.write(`${formatSchemaWarning(res)}\n`);
    } else if (res.unreadable) {
      // Diagnostic only — --check reports, it does not gate (exit stays 0).
      process.stderr.write(`${formatUnreadableStampRefusal(res)}\n`);
    }
    process.stdout.write(`${JSON.stringify({
      ok: res.ok,
      ahead: res.ahead,
      unreadable: res.unreadable,
      errno: res.errno,
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
