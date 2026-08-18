#!/usr/bin/env node
// forge-projection-ownership.js — one formulation of "is this destination ours?"
//
// WHY THIS EXISTS
// ---------------
// A projection is only managed if the installer can prove the file on disk is
// its own output. That proof used to be a single mechanism — an origin marker
// embedded in the content — and a mechanism embedded in content cannot exist for
// a format without comments. JSON is that format, so every JSON projection
// (`forge-prefs.schema.json`, the Codex `capabilities.json`) became a permanent
// `user_owned` conflict the first time it diverged: frozen at the bytes of
// whichever release created it, while each `--update` preserved it and reported
// success. The same defect took `.js` projections until scripts learned a `//`
// marker, which fixed the symptom for one more format and left the shape intact.
//
// The durable fix is a proof that does not live in the file: record the digest of
// what we wrote, and on the next run ask whether the bytes on disk are still that.
// It works for every format, including the ones that can never carry a marker.
//
// STRICTLY ADDITIVE, AND THAT IS A DECISION
// -----------------------------------------
// The digest is consulted only when the marker is absent — it can grant ownership,
// never revoke it. A hash-FIRST rule would be defensible and slightly stronger
// (it would also stop the installer from overwriting an operator's edits to a
// marked file, which today it happily does), but it would turn files that are
// currently updated into conflicts, which is a behavior change well beyond
// closing the freeze. Recorded here as a deliberate non-change rather than an
// oversight; flipping it is a separate decision with its own migration.
//
// THE RUNG THAT WAS UNREACHABLE, AND WHY A FIFTH ONE EXISTS
// ---------------------------------------------------------
// The digest rung closes the freeze only for destinations this installer WROTE:
// `recordOf` records what a run wrote, and a `user_owned` destination is exactly
// what a run does not write. So a file that was already divergent when the rung
// shipped never enters the record, and every later run finds no marker and no
// record and preserves it again — the digest rung is unreachable for precisely
// the files that need it. Measured: a real 4.8.0 → 4.15.0 update reported success
// with 110 ownership entries and NONE for the four destinations it had itself
// listed as `user_owned`; two of them were byte-identical to their 4.8.0 upstream
// content, with zero operator customization, and stayed frozen.
//
// Rung 5 supplies the missing proof from outside the file AND outside our own
// record: the source repo's history (§ forge-projection-provenance). It is still
// additive — it can only grant.
//
// Exports:
//   digest(content) → sha256 hex of the normalized bytes
//   decide({ current, recordedDigest, markerPresent, migrateLegacy, releaseDigests }) → { ours, basis }
//     basis: 'absent' | 'marker' | 'digest' | 'release' | 'migrate-legacy' | null
//   recordOf(entries) → { [resolved destination]: digest }
//   keyFor(destination) → resolved absolute path used as the record key
//
// Zero npm dependencies — Node built-ins only.

'use strict';

const crypto = require('crypto');
const path = require('path');

// Line endings are not content. A checkout with core.autocrlf=true hands back
// CRLF for a file we wrote as LF; digesting the raw bytes would report every
// such destination as operator-edited and re-freeze exactly what this closes.
function normalize(content) {
  return String(content).replace(/\r\n/g, '\n');
}

function digest(content) {
  return crypto.createHash('sha256').update(normalize(content), 'utf8').digest('hex');
}

function keyFor(destination) {
  return path.resolve(String(destination));
}

/**
 * Match the bytes on disk against every content this projection ever shipped as.
 *
 * The argument may be a thunk, and that is the point: reading repo history costs
 * git subprocesses, and it must only happen for the destinations that actually
 * reach this rung. A clean update never evaluates it.
 */
function releaseMatch(current, releaseDigests) {
  if (!releaseDigests) return false;
  let known = releaseDigests;
  if (typeof known === 'function') {
    try { known = known(); } catch (_) { return false; } // provenance is advisory: it never breaks an install
  }
  if (!known) return false;
  const wanted = digest(current);
  if (known instanceof Set) return known.has(wanted);
  if (Array.isArray(known)) return known.includes(wanted);
  return false;
}

/**
 * Decide whether a destination is the installer's to overwrite.
 *
 * Order is the contract, not an implementation detail:
 *  1. nothing on disk        → ours (a fresh install always projects)
 *  2. --migrate-legacy       → ours (the explicit operator escape, unchanged)
 *  3. marker present         → ours (pre-existing behavior, never narrowed)
 *  4. digest matches record  → ours (the only rung a marker-less format can reach)
 *  5. bytes are some past     → ours (NEW — reachable for a destination that was
 *     revision of the source          ALREADY divergent, which rung 4 cannot be)
 *  6. otherwise              → not ours
 *
 * Rung 5 sits AFTER rung 4 deliberately: our own record is a cheaper and more
 * direct claim than repo archaeology, and when both would answer they agree.
 *
 * @param {object} input
 * @param {?string} input.current          bytes on disk, or null when absent
 * @param {?string} input.recordedDigest   digest we recorded when we last wrote it
 * @param {boolean} input.markerPresent    result of the renderer's marker probe
 * @param {boolean} [input.migrateLegacy]  operator asked to adopt unmarked files
 * @param {Set|Array|function} [input.releaseDigests]  digests of past revisions,
 *        or a thunk producing them (evaluated only if this rung is reached)
 * @returns {{ours: boolean, basis: ?string}}
 */
function decide(input = {}) {
  const { current, recordedDigest, markerPresent, migrateLegacy, releaseDigests } = input;

  if (current === null || current === undefined) return { ours: true, basis: 'absent' };
  if (migrateLegacy) return { ours: true, basis: 'migrate-legacy' };
  if (markerPresent) return { ours: true, basis: 'marker' };
  if (recordedDigest && digest(current) === recordedDigest) return { ours: true, basis: 'digest' };
  if (releaseMatch(current, releaseDigests)) return { ours: true, basis: 'release' };
  return { ours: false, basis: null };
}

/**
 * Build the record to persist from everything this run wrote or already owned.
 *
 * A dry run contributes nothing: recording a digest for bytes never written
 * would make the NEXT run believe it owns a file it never touched.
 *
 * @param {Array<{destination: string, content: string, dry_run?: boolean}>} entries
 * @returns {object}
 */
function recordOf(entries) {
  const record = {};
  for (const entry of entries || []) {
    if (!entry || !entry.destination || entry.dry_run) continue;
    if (typeof entry.content !== 'string') continue;
    record[keyFor(entry.destination)] = digest(entry.content);
  }
  return record;
}

module.exports = { digest, decide, releaseMatch, recordOf, keyFor, normalize };
