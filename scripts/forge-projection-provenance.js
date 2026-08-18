#!/usr/bin/env node
'use strict';

// forge-projection-provenance.js — "were these bytes ever OUR output?"
//
// WHY THIS EXISTS
// ---------------
// The digest rung in `forge-projection-ownership` closes the freeze going
// FORWARD: once a run writes a destination it records what it wrote, and the next
// run recognizes those bytes as its own. It cannot close it for a destination
// that was ALREADY divergent when the rung shipped, and the reason is structural:
// `recordOf` only records what the run WROTE, and a `user_owned` destination is
// exactly what a run does NOT write. So it never enters the record; the next run
// finds no marker and no record and preserves it again. Forever. Rung 4 is
// unreachable for precisely the files that need it.
//
// Measured on a real 4.8.0 → 4.15.0 update that exited 0 and reported success:
// `manifest.ownership` carried 110 entries and NOT ONE for any of the four
// destinations the same run listed in `adapters.*.conflicts` with
// `reason: "user_owned"`. `~/.claude/forge-hook.js` was 37166 bytes on disk
// against 60455 in the release — and byte-identical to its 4.8.0 upstream content
// once CRLF was normalized. There was not one line of operator customization in
// it. The installer preserved, as if they were the operator's, files that were
// integrally its own; half the install stayed 4.15.0 and half stayed 4.8.0.
// Worse, the manual fix does not self-sustain: bytes copied by hand never pass
// through the installer, so no digest is recorded and the next update freezes
// them again — now at the newer content. The cycle repeats indefinitely.
//
// THE PROOF USED HERE
// -------------------
// The source repo is a git clone, so history answers the question directly:
// are the bytes on disk identical to SOME historical revision of the file we
// project from? If yes, those bytes are our own output at some release — not an
// operator edit — and replacing them is safe. If no, they are not ours to touch
// and the destination stays preserved.
//
// Comparison is on content digests (CRLF-normalized, via the ownership module's
// own `digest`), not on git blob ids. A blob-id comparison would be cheaper but
// would depend on the clean filters that `.gitattributes`/`core.autocrlf` happen
// to apply on THIS machine — the exact class of Windows EOL trap that issue #104
// lives in. Digesting the real bytes of each revision is invariant to that.
//
// STRICTLY ADDITIVE, LIKE THE RUNG IT FEEDS
// -----------------------------------------
// This can only ever GRANT ownership. A file that matches no revision is left
// exactly as the previous behavior left it, so the "strictly additive" decision
// recorded in `forge-projection-ownership` is unchanged. A file the operator
// edited to byte-equal an older release is adopted — and treating that as ours is
// correct, because it IS our content.
//
// DEGRADATION IS NAMED, NEVER SILENT
// ----------------------------------
// No git, no `.git`, no history for the path, a git failure, a synthesized
// artifact with no source file, a history longer than the bound, a shallow clone:
// each produces a reason the caller reports. A preserved destination must always
// say whether we could even check — "preserved because we proved it is yours" and
// "preserved because we could not look" are different facts and must not read
// alike. In particular `operator-edit` is reserved for the case where the WHOLE
// history was visible; on a shallow or truncated read the answer is
// `shallow-history`, because blaming the operator for our own blind spot is the
// kind of confident-and-unmeasured claim this repo has had to delete before.
//
// Zero npm dependencies — Node built-ins plus the git already required to clone.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ownership = require('./forge-projection-ownership');

// Bounded on purpose: history is unbounded and an install must not be. 200
// revisions of one file reach far past any release an operator could be frozen
// at, and truncation is reported rather than assumed harmless.
const DEFAULT_LIMIT = 200;
const MAX_BUFFER = 64 * 1024 * 1024;

const REASONS = Object.freeze({
  RELEASE_MATCH: 'release-match',       // the bytes are ours, at some past revision
  OPERATOR_EDIT: 'operator-edit',       // history read in full; nothing matches
  SHALLOW_HISTORY: 'shallow-history',   // nothing matches, but we cannot see the whole history
  NO_SOURCE: 'no-source',               // synthesized artifact: no repo file to compare against
  NO_GIT: 'no-git',                     // not a git work tree, or git unavailable
  NO_HISTORY: 'no-history',             // tracked path with no revisions (new/untracked file)
  GIT_FAILED: 'git-failed',             // a git invocation failed; error carried
  NOT_CONSULTED: 'not-consulted',       // caller ran without a resolver
});

function gitRunner(repo) {
  return (args, input) => spawnSync('git', ['-C', repo, ...args], {
    encoding: 'buffer',
    shell: false,
    maxBuffer: MAX_BUFFER,
    input: input === undefined ? undefined : Buffer.from(String(input), 'utf8'),
  });
}

function stderrOf(result) {
  if (result && result.stderr) {
    const text = result.stderr.toString('utf8').trim();
    if (text) return text;
  }
  return (result && result.error && result.error.message) || 'git falhou sem diagnóstico';
}

/**
 * Parse `git cat-file --batch` output. Binary-safe: the header is read up to the
 * first LF, then exactly `size` bytes of payload, then the trailing LF. Reading
 * this as text would corrupt any revision that is not valid UTF-8 and silently
 * change its digest.
 */
function parseBatch(buffer) {
  const contents = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline === -1) break;
    const header = buffer.slice(offset, newline).toString('utf8').trim();
    offset = newline + 1;
    const parts = header.split(' ');
    if (parts.length < 3 || parts[1] !== 'blob') continue; // `<obj> missing`, nothing to skip
    const size = Number(parts[2]);
    if (!Number.isFinite(size) || size < 0) break;
    contents.set(parts[0], buffer.slice(offset, offset + size));
    offset += size + 1;
  }
  return contents;
}

function blobIdsOf(buffer) {
  const ids = [];
  for (const line of buffer.toString('utf8').split('\n')) {
    const parts = line.trim().split(' ');
    if (parts.length >= 3 && parts[1] === 'blob') ids.push(parts[0]);
  }
  return [...new Set(ids)];
}

function empty(reason, extra = {}) {
  return { digests: new Set(), revisions: 0, truncated: false, shallow: false, reason, ...extra };
}

/**
 * Every distinct content this repo ever held at `sourcePath`, as digests.
 *
 * @param {object} input
 * @param {string} input.repo        source repo root (a git clone)
 * @param {string} input.sourcePath  repo-relative POSIX path of the projected input
 * @param {number} [input.limit]     revision bound (default 200)
 * @param {function} [input.git]     injected runner (args, input) → spawnSync result
 * @returns {{digests: Set<string>, revisions: number, truncated: boolean, reason: string, error?: string}}
 */
function historyDigests(input = {}) {
  const repo = input.repo ? path.resolve(input.repo) : null;
  const sourcePath = String(input.sourcePath || '').replace(/\\/g, '/');
  const limit = Number.isFinite(input.limit) && input.limit > 0 ? Math.floor(input.limit) : DEFAULT_LIMIT;
  if (!repo || !sourcePath) return empty(REASONS.NO_GIT);

  const sourceFile = path.join(repo, sourcePath.split('/').join(path.sep));
  let onDisk = false;
  try { onDisk = fs.existsSync(sourceFile); } catch (_) { onDisk = false; }
  if (!onDisk) return empty(REASONS.NO_SOURCE);

  const git = typeof input.git === 'function' ? input.git : gitRunner(repo);

  // Both facts in one process. Shallowness matters because on a truncated clone
  // "nothing matches" does NOT mean the operator edited it — it can mean the
  // revision that would have matched is simply not here. Telling those apart is
  // the difference between a fact and an accusation.
  const probe = git(['rev-parse', '--git-dir', '--is-shallow-repository']);
  if (!probe || probe.status !== 0) return empty(REASONS.NO_GIT);
  const shallow = probe.stdout.toString('utf8').split('\n').map((line) => line.trim()).includes('true');

  // One extra revision is requested so truncation is DETECTED rather than
  // inferred from hitting the bound exactly.
  const revisions = git(['rev-list', `--max-count=${limit + 1}`, '--all', '--', sourcePath]);
  if (!revisions || revisions.status !== 0) return empty(REASONS.GIT_FAILED, { shallow, error: stderrOf(revisions) });
  const commits = revisions.stdout.toString('utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  if (commits.length === 0) return empty(REASONS.NO_HISTORY, { shallow });
  const truncated = commits.length > limit;
  const used = commits.slice(0, limit);

  // Two batched calls, never one process per revision: resolve `<commit>:<path>`
  // to blob ids first, dedupe, then read only the distinct blobs.
  const check = git(['cat-file', '--batch-check'], `${used.map((commit) => `${commit}:${sourcePath}`).join('\n')}\n`);
  if (!check || check.status !== 0) return empty(REASONS.GIT_FAILED, { shallow, error: stderrOf(check) });
  const blobs = blobIdsOf(check.stdout);
  if (blobs.length === 0) return empty(REASONS.NO_HISTORY, { revisions: used.length, truncated, shallow });

  const batch = git(['cat-file', '--batch'], `${blobs.join('\n')}\n`);
  if (!batch || batch.status !== 0) return empty(REASONS.GIT_FAILED, { shallow, error: stderrOf(batch) });
  const digests = new Set();
  for (const content of parseBatch(batch.stdout).values()) digests.add(ownership.digest(content.toString('utf8')));

  return { digests, revisions: blobs.length, truncated, shallow, reason: digests.size ? 'ok' : REASONS.NO_HISTORY };
}

/**
 * Memoized per-source-path resolver. History is read at most once per path per
 * run, and only for the destinations that actually reached the last rung — a
 * clean update never spawns git at all.
 */
function createResolver(options = {}) {
  const repo = options.repo ? path.resolve(options.repo) : null;
  const cache = new Map();

  function lookup(sourcePath) {
    const key = String(sourcePath || '').replace(/\\/g, '/');
    if (!cache.has(key)) cache.set(key, historyDigests({ repo, sourcePath: key, limit: options.limit, git: options.git }));
    return cache.get(key);
  }

  return {
    repo,
    digestsFor(sourcePath) { return lookup(sourcePath).digests; },
    /**
     * The one place the final label is decided, so "we proved it is yours" and
     * "we could not look" never collapse into the same word.
     */
    verdictFor(sourcePath, content) {
      const entry = lookup(sourcePath);
      const matched = content !== null && content !== undefined && entry.digests.has(ownership.digest(content));
      // "Nothing matched" is only an accusation when we could see everything. On a
      // shallow or truncated clone the revision that would have matched may simply
      // not be here, and saying `operator-edit` there would blame the operator for
      // our own blind spot.
      const unmatched = (entry.shallow || entry.truncated) ? REASONS.SHALLOW_HISTORY : REASONS.OPERATOR_EDIT;
      const reason = matched
        ? REASONS.RELEASE_MATCH
        : (entry.reason === 'ok' ? unmatched : entry.reason);
      return { matched, reason, revisions: entry.revisions, truncated: entry.truncated, shallow: entry.shallow, error: entry.error };
    },
    consulted() { return [...cache.keys()]; },
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { repo: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--source') out.source = argv[++i];
    else if (arg === '--file') out.file = argv[++i];
    else if (arg === '--limit') out.limit = Number(argv[++i]);
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`opção desconhecida: ${arg}`);
  }
  return out;
}

// Operator-facing surface: answers "is this installed file still one of ours, or
// did I edit it?" without running an install.
function main(argv = process.argv.slice(2), write = process.stdout.write.bind(process.stdout), errorWrite = process.stderr.write.bind(process.stderr)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { errorWrite(`forge-projection-provenance: ${error.message}\n`); return 2; }
  if (options.help || !options.source) {
    write('Usage: forge-projection-provenance.js --source REL [--repo DIR] [--file PATH] [--limit N] [--json]\n');
    return options.help ? 0 : 2;
  }
  const resolver = createResolver({ repo: options.repo, limit: options.limit });
  let content = null;
  if (options.file) {
    try { content = fs.readFileSync(options.file, 'utf8'); }
    catch (error) { errorWrite(`forge-projection-provenance: não foi possível ler ${options.file}: ${error.message}\n`); return 1; }
  }
  const verdict = resolver.verdictFor(options.source, content);
  write(options.json
    ? `${JSON.stringify({ source: options.source, file: options.file || null, ...verdict }, null, 2)}\n`
    : `${options.source}: ${verdict.reason} (${verdict.revisions} revisões${verdict.truncated ? ', truncado' : ''})\n`);
  return 0;
}

module.exports = { REASONS, DEFAULT_LIMIT, historyDigests, createResolver, parseBatch, blobIdsOf, parseArgs, main };
if (require.main === module) process.exitCode = main();
