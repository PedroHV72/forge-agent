#!/usr/bin/env node
// forge-keychain-diagnostics — records evidence for macOS Keychain WRITE
// failures ("Chaves Não Encontradas" style dialogs), so the next occurrence
// leaves a trace instead of vanishing into a silent fallback.
//
// WHY THIS EXISTS
// ----------------
// `forge-secrets.storeSecret()` catches a failing `security add-generic-
// password` and silently falls back to a 0600 file — useful for the user
// (the credential still works) but useless for diagnosis (no evidence a
// failure even happened). This module is the shared recorder both
// forge-secrets and forge-accounts call from their write paths.
//
// STORAGE
//   ~/.claude/forge-keychain-diagnostics.jsonl — user-global (not per-project,
//   not under .gsd/). Append-only JSONL, capped at ~256 KB by truncating to
//   the most recent entries.
//
// ABSOLUTE CONSTRAINT: never record the secret value. Every field recorded
// here is either non-secret (service name, account name — both public
// identifiers, not credentials) or metadata about the failure (exit status,
// signal, trimmed stderr). Callers must never pass the secret itself into
// `stderr` here — see the trim/scrub below as a second line of defense.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DIAG_FILE = process.env.FORGE_KEYCHAIN_DIAGNOSTICS
  || path.join(CLAUDE_DIR, 'forge-keychain-diagnostics.jsonl');

const MAX_BYTES = 256 * 1024;
const STDERR_MAX_CHARS = 500;

// `security add-generic-password ... -w <secret>` is the exact argv shape
// both write paths use. If a future macOS/security build ever echoes the
// invoked command (or a fragment of it) back into stderr, the secret would
// ride along. Scrub any `-w <token>` sequence unconditionally, before
// truncation — belt-and-suspenders alongside the fact that `security` has
// never been observed to do this.
const DASH_W_RE = /-w\s+\S+/g;

function trimStderr(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw);
  if (Buffer.isBuffer(raw)) s = raw.toString('utf8');
  s = s.replace(DASH_W_RE, '-w [scrubbed]');
  s = s.trim();
  if (s.length > STDERR_MAX_CHARS) s = `${s.slice(0, STDERR_MAX_CHARS)}…(truncated)`;
  return s;
}

/// Cap the file so it can never grow unbounded. Keeps the most recent
/// entries — a full line-parse-and-rewrite, acceptable at this size.
function truncateIfNeeded(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }
  if (stat.size <= MAX_BYTES) return;
  let lines;
  try { lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean); }
  catch { return; }
  // Drop from the front until under budget, keeping whole lines.
  let kept = lines;
  while (kept.length > 1 && Buffer.byteLength(kept.join('\n'), 'utf8') > MAX_BYTES) {
    kept = kept.slice(1);
  }
  try {
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${kept.join('\n')}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch { /* best-effort — never let cap maintenance break the caller */ }
}

/// Record one Keychain write failure. Never throws — a diagnostics failure
/// must never mask or replace the real error the caller is already handling.
///
/// @param {object} info
///   engine        {string}  e.g. 'forge-secrets.storeSecret' | 'forge-accounts.storeToken'
///   service       {string}  the keychain -s value (not a secret)
///   account       {string}  the keychain -a value (not a secret)
///   err           {Error}   the caught error from execFileSync (status/signal/code/stderr)
///   fallback      {boolean} whether a fallback file was used
function recordFailure(info) {
  try {
    const err = info && info.err;
    const entry = {
      ts: new Date().toISOString(),
      engine: (info && info.engine) || 'unknown',
      service: (info && info.service) || null,
      account: (info && info.account) || null,
      status: err && typeof err.status === 'number' ? err.status : null,
      signal: (err && err.signal) || null,
      code: (err && err.code) || null,
      stderr: trimStderr(err && err.stderr),
      fallback: !!(info && info.fallback),
      process: {
        ppid: process.ppid,
        term_program: process.env.TERM_PROGRAM || null,
        claude_code_entrypoint: !!process.env.CLAUDE_CODE_ENTRYPOINT,
        claudecode: !!process.env.CLAUDECODE,
        cf_bundle_identifier: process.env.__CFBundleIdentifier || null,
      },
    };
    fs.mkdirSync(path.dirname(DIAG_FILE), { recursive: true });
    fs.appendFileSync(DIAG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
    truncateIfNeeded(DIAG_FILE);
  } catch {
    // Silent-fail by design (MEM008): observability must never break the
    // caller's real control flow.
  }
}

function readEntries() {
  try {
    return fs.readFileSync(DIAG_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function formatEntries(entries) {
  if (!entries.length) return 'Nenhuma falha de escrita no Keychain registrada.';
  return entries.map((e) => [
    `[${e.ts}] ${e.engine}`,
    `  service=${e.service}  account=${e.account}  fallback=${e.fallback}`,
    `  status=${e.status}  signal=${e.signal}  code=${e.code}`,
    e.stderr ? `  stderr: ${e.stderr}` : null,
    e.process
      ? `  ppid=${e.process.ppid} term=${e.process.term_program} ` +
        `claude_entrypoint=${e.process.claude_code_entrypoint} claudecode=${e.process.claudecode} ` +
        `bundle=${e.process.cf_bundle_identifier}`
      : null,
  ].filter(Boolean).join('\n')).join('\n\n');
}

module.exports = {
  DIAG_FILE,
  recordFailure,
  readEntries,
  formatEntries,
  trimStderr,
  truncateIfNeeded,
};
