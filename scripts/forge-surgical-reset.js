#!/usr/bin/env node
'use strict';

/*
 * forge-surgical-reset.js — git-derived surgical reset engine + CLI (M013 S01).
 *
 * SAFETY-CRITICAL. This module RESETS a git working tree. A bug here can destroy
 * a user's uncommitted work. Every design decision below is load-bearing; do not
 * "simplify" without re-reading .gsd/milestones/M013/slices/S01/S01-RISK.md.
 *
 * The problem it solves: the sidecar (codex/agy) runs in the user's worktree with
 * auto_commit:false. When the sidecar fails and we fall back to Claude, we must
 * undo ONLY what the sidecar touched — never the work the user already had
 * uncommitted before dispatch. The legacy reset was `git checkout $SHA -- . &&
 * git clean -fd` which nukes ALL uncommitted work (Blocker: destroys pre-existing).
 *
 * The mechanism (locked design — do not deviate):
 *   1. BEFORE dispatch, snapshot the pre-existing dirty set as {path, hash} pairs
 *      (git hash-object of current content; hash:null for a pre-existing deletion).
 *      Persist it in the state file alongside start_sha (survives the poll loop +
 *      auto-compact — shell vars do not).
 *   2. AFTER the run, the reset target = (changes vs START_SHA) MINUS (pre_dirty
 *      paths whose CURRENT hash still equals the snapshot hash).
 *   3. OVERLAP DETECTION (non-negotiable): a pre-dirty tracked file ALWAYS appears
 *      in the post-run diff vs START_SHA even if the sidecar never touched it — a
 *      pure path-set diff cannot tell "intact" from "also-touched". So we re-hash
 *      every pre_dirty path: if any diverged, the sidecar ALSO wrote a pre-dirty
 *      file → abort, reset NOTHING (not even the non-overlapped files), exit 3.
 *
 * All git calls use spawnSync('git', [args...]) with array args — never shell,
 * never string interpolation. All parsing is NUL-delimited (-z) so paths with
 * spaces/quotes/newlines are safe.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_BUFFER = 32 * 1024 * 1024; // 32MB — large diffs on big worktrees

// ── .gsd exclusion — ONE predicate, used in all three operations ────────────────
// The orchestrator writes .gsd/** during the flow (state files, events). It must
// be excluded consistently from snapshot, post-run diff AND reset — an inclusion
// mismatch across the three corrupts the set-diff (explicit S01-RISK warning).
function isGsdPath(p) {
  return p === '.gsd' || p.startsWith('.gsd/');
}

// ── git primitives (array args, never shell) ────────────────────────────────────

function git(cwd, args, opts) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'buffer',
    maxBuffer: MAX_BUFFER,
    ...opts,
  });
}

function gitText(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) {
    const err = r.stderr ? r.stderr.toString('utf8').trim() : `git ${args.join(' ')} failed`;
    throw new Error(`git ${args[0]} failed: ${err}`);
  }
  return r.stdout.toString('utf8');
}

/**
 * git hash-object of the CURRENT content of <relPath> in <cwd>. Returns the SHA-1
 * string, or null when the file does not exist (a pre-existing/current deletion).
 * @returns {string|null}
 */
function hashObject(cwd, relPath) {
  const abs = path.join(cwd, relPath);
  if (!fs.existsSync(abs)) return null;
  const r = git(cwd, ['hash-object', '--', relPath]);
  if (r.status !== 0) return null;
  return r.stdout.toString('utf8').trim() || null;
}

// ── porcelain / diff parsers (NUL-delimited) ────────────────────────────────────

/**
 * Parse `git status --porcelain -uall -z` (NUL-delimited). Each record is
 * "XY<space>path\0"; a rename/copy record (X or Y is R/C) is immediately
 * followed by an extra "origPath\0" field. Returns [{xy, path, origPath?}].
 * @param {Buffer|string} buf
 */
function parsePorcelainZ(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  // Split on NUL; drop the trailing empty produced by the final terminator.
  const tokens = s.split('\0');
  if (tokens.length && tokens[tokens.length - 1] === '') tokens.pop();

  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.length < 3) continue; // malformed / stray token
    const xy = tok.slice(0, 2);
    const p = tok.slice(3); // skip the single space after XY
    const isRenameCopy = xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C';
    if (isRenameCopy) {
      // The NEXT token is the original path (rename source).
      const origPath = tokens[i + 1];
      i += 1;
      out.push({ xy, path: p, origPath });
    } else {
      out.push({ xy, path: p });
    }
  }
  return out;
}

/**
 * Parse `git diff --name-status -z <sha>` (NUL-delimited). Records are a status
 * token followed by NUL-separated path field(s). A rename/copy status (R###/C###)
 * carries TWO path fields (old, new); everything else carries one.
 * Returns [{status, path, origPath?}] with status as the raw first char.
 * @param {Buffer|string} buf
 */
function parseNameStatusZ(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  const tokens = s.split('\0');
  if (tokens.length && tokens[tokens.length - 1] === '') tokens.pop();

  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const statusTok = tokens[i];
    if (!statusTok) continue;
    const code = statusTok[0];
    if (code === 'R' || code === 'C') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      i += 2;
      out.push({ status: code, path: newPath, origPath: oldPath });
    } else {
      const p = tokens[i + 1];
      i += 1;
      out.push({ status: code, path: p });
    }
  }
  return out;
}

// ── snapshot / post-run change computation ──────────────────────────────────────

/**
 * Snapshot the pre-existing dirty set as {path, hash} pairs. .gsd/** excluded.
 * hash = git hash-object of current content; null for a pre-existing deletion.
 * Renames contribute BOTH the new path (current content) and the old path
 * (now-missing → hash:null), so an overlap on either side is detected.
 * @returns {{path:string, hash:string|null}[]}
 */
function captureSnapshot(cwd) {
  const porcelain = git(cwd, ['status', '--porcelain', '-uall', '-z']).stdout;
  const entries = parsePorcelainZ(porcelain);
  const seen = new Set();
  const snapshot = [];
  const add = (p) => {
    if (!p || isGsdPath(p) || seen.has(p)) return;
    seen.add(p);
    snapshot.push({ path: p, hash: hashObject(cwd, p) });
  };
  for (const e of entries) {
    add(e.path);
    if (e.origPath) add(e.origPath);
  }
  return snapshot;
}

/**
 * All changes in the working tree vs START_SHA, .gsd/** excluded. Union of:
 *   - `git diff --name-status -z <startSha>` (tracked A/M/D/R vs the commit;
 *     a rename R → old becomes D, new becomes A);
 *   - untracked files from `git status --porcelain -uall -z` (?? → A).
 * @returns {{path:string, status:'A'|'M'|'D'}[]}
 */
function computePostChanges(cwd, startSha) {
  const byPath = new Map(); // path → 'A' | 'M' | 'D'
  const set = (p, st) => {
    if (!p || isGsdPath(p)) return;
    byPath.set(p, st);
  };

  const diffBuf = git(cwd, ['diff', '--name-status', '-z', startSha]).stdout;
  for (const e of parseNameStatusZ(diffBuf)) {
    if (e.status === 'R' || e.status === 'C') {
      // old path removed (D), new path created (A). For a copy the old side is
      // unchanged, but marking it D is harmless: it is restored from START_SHA
      // where it already exists (checkout is a no-op on identical content).
      set(e.origPath, 'D');
      set(e.path, 'A');
    } else if (e.status === 'A') {
      set(e.path, 'A');
    } else if (e.status === 'D') {
      set(e.path, 'D');
    } else {
      set(e.path, 'M'); // M, T (type change), etc. → restore from START_SHA
    }
  }

  // Untracked files (not in the diff vs a commit) → treat as created (A).
  const porcelain = git(cwd, ['status', '--porcelain', '-uall', '-z']).stdout;
  for (const e of parsePorcelainZ(porcelain)) {
    if (e.xy === '??') set(e.path, 'A');
  }

  return Array.from(byPath.entries()).map(([p, st]) => ({ path: p, status: st }));
}

// ── the pure decision function (the heart of the engine) ────────────────────────

/**
 * PURE. Partition the post-run changes into what the reset should touch, given
 * the pre-dirty snapshot and a live re-hash function.
 *
 * @param {{path:string,status:'A'|'M'|'D'}[]} postChanges
 * @param {{path:string,hash:string|null}[]} preDirty
 * @param {(path:string)=>string|null} hashNow  re-hash of current content (injectable)
 * @returns {{restore:string[], remove:string[], preserved:string[], overlap:string[]}}
 *
 * OVERLAP is computed over EVERY pre_dirty path (re-hashed), independent of the
 * post-run diff: a pre-dirty path whose current hash diverges from the snapshot
 * hash means the sidecar ALSO wrote it. Any overlap → the CALLER must execute
 * NOTHING (checked again in executeReset as a hard guard).
 */
function computeResetTarget(postChanges, preDirty, hashNow) {
  const preByPath = new Map(preDirty.map((d) => [d.path, d.hash]));
  const preserved = [];
  const overlap = [];

  for (const { path: p, hash: snapHash } of preDirty) {
    const current = hashNow(p);
    if (current === snapHash) preserved.push(p);
    else overlap.push(p);
  }

  const restore = [];
  const remove = [];
  for (const { path: p, status } of postChanges) {
    if (preByPath.has(p)) continue; // pre-existing → never a reset target
    if (status === 'A') remove.push(p);
    else restore.push(p); // M or D → restore from START_SHA
  }

  return { restore, remove, preserved, overlap };
}

// ── reset execution + verification ──────────────────────────────────────────────

/** Remove empty parent directories of <relPath>, upward, stopping at the repo
 *  root or the first non-empty dir. Best-effort — never throws. */
function pruneEmptyParents(cwd, relPath) {
  let dir = path.dirname(relPath);
  while (dir && dir !== '.' && dir !== path.sep) {
    const abs = path.join(cwd, dir);
    try {
      if (fs.readdirSync(abs).length !== 0) break;
      fs.rmdirSync(abs);
    } catch { break; }
    dir = path.dirname(dir);
  }
}

/**
 * Execute the reset. HARD GUARD: refuses to run when target.overlap is non-empty.
 * - restore: `git checkout START_SHA -- <paths...>` in one batched, shell-free call.
 * - remove:  fs.rmSync each file + prune emptied parent dirs.
 * Never touches preserved paths, never touches .gsd/**.
 * @returns {{restored:string[], removed:string[]}}
 */
function executeReset(cwd, startSha, target) {
  if (target.overlap.length !== 0) {
    throw new Error('executeReset refused: overlap is non-empty (caller must abort)');
  }
  const restored = [];
  const removed = [];

  if (target.restore.length) {
    const r = git(cwd, ['checkout', startSha, '--', ...target.restore]);
    if (r.status !== 0) {
      const err = r.stderr ? r.stderr.toString('utf8').trim() : 'git checkout failed';
      throw new Error(`surgical reset checkout failed: ${err}`);
    }
    restored.push(...target.restore);
  }

  for (const rel of target.remove) {
    if (isGsdPath(rel)) continue; // defensive — never remove .gsd/**
    const abs = path.join(cwd, rel);
    try {
      fs.rmSync(abs, { force: true });
      removed.push(rel);
      pruneEmptyParents(cwd, rel);
    } catch { /* best-effort — leftover surfaces in verifyReset */ }
  }

  return { restored, removed };
}

/**
 * Verify the tree after a reset: recompute the post-run changes; every remaining
 * change MUST be a pre_dirty path whose current hash still equals the snapshot
 * hash (i.e. only the preserved pre-existing work is left). Anything else is a
 * leftover → verification fails.
 * @returns {{verified:boolean, leftover:string[]}}
 */
function verifyReset(cwd, startSha, preDirty) {
  const preByPath = new Map(preDirty.map((d) => [d.path, d.hash]));
  const post = computePostChanges(cwd, startSha);
  const leftover = [];
  for (const { path: p } of post) {
    if (!preByPath.has(p)) { leftover.push(p); continue; }
    if (hashObject(cwd, p) !== preByPath.get(p)) leftover.push(p);
  }
  return { verified: leftover.length === 0, leftover };
}

// ── state file (persisted snapshot; survives the poll loop + auto-compact) ───────

function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}

function readState(stateFile) {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

/**
 * Capture START_SHA + the pre-dirty snapshot and write BOTH in ONE atomic write.
 * @returns {object} the written state
 */
function initState(stateFile, { cwd, attempt }) {
  const startSha = gitText(cwd, ['rev-parse', 'HEAD']).trim();
  const preDirty = captureSnapshot(cwd);
  const state = {
    attempt: attempt == null ? 1 : attempt,
    start_sha: startSha,
    pre_dirty: preDirty,
    reason: '',
    result_file: '',
    code_dir: cwd,
    transient_retry_count: 0,
  };
  writeJsonAtomic(stateFile, state);
  return state;
}

/** Initialize the durable read-only plan-sidecar state without shell-built JSON.
 * Unlike initState this deliberately performs no git snapshot because plan mode cannot
 * write the workspace. Atomic JSON serialization keeps Windows paths and quotes valid. */
function initReadOnlyState(stateFile, { cwd, attempt, resultFile, contextFile }) {
  const state = {
    attempt: attempt == null ? 1 : attempt,
    reason: '',
    result_file: resultFile,
    code_dir: cwd,
    ctx_file: contextFile,
    transient_retry_count: 0,
  };
  writeJsonAtomic(stateFile, state);
  return state;
}

/** Read-modify-write, atomic, preserving all fields (esp. pre_dirty + start_sha). */
function updateState(stateFile, patch) {
  const state = readState(stateFile);
  const next = { ...state, ...patch };
  writeJsonAtomic(stateFile, next);
  return next;
}

// ── high-level reset (used by the CLI) ──────────────────────────────────────────

/**
 * Full reset flow from a state file. Returns a result object + an exit code.
 * exit 0 ok / 3 overlap-abort (reset NOTHING) / 2 verify-failed.
 */
function resetFromState(stateFile) {
  const state = readState(stateFile);
  const cwd = state.code_dir;
  const startSha = state.start_sha;
  const preDirty = Array.isArray(state.pre_dirty) ? state.pre_dirty : [];

  const post = computePostChanges(cwd, startSha);
  const target = computeResetTarget(post, preDirty, (p) => hashObject(cwd, p));

  if (target.overlap.length !== 0) {
    return { code: 3, result: { ok: false, overlap: target.overlap, preserved: target.preserved } };
  }

  const done = executeReset(cwd, startSha, target);
  const check = verifyReset(cwd, startSha, preDirty);
  if (!check.verified) {
    return {
      code: 2,
      result: { ok: false, restored: done.restored, removed: done.removed, verified: false, leftover: check.leftover },
    };
  }
  return {
    code: 0,
    result: {
      ok: true,
      restored: done.restored,
      removed: done.removed,
      preserved: target.preserved,
      verified: true,
    },
  };
}

module.exports = {
  isGsdPath,
  parsePorcelainZ,
  parseNameStatusZ,
  hashObject,
  captureSnapshot,
  computePostChanges,
  computeResetTarget,
  executeReset,
  verifyReset,
  pruneEmptyParents,
  writeJsonAtomic,
  readState,
  initState,
  initReadOnlyState,
  updateState,
  resetFromState,
};

// ── CLI (manual argv parse, no deps — mold: forge-xllm.js) ───────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usageError(msg) {
  process.stderr.write(`forge-surgical-reset: ${msg}\n`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  try {
    if (args['state-init']) {
      if (!args.state || !args.cwd) usageError('--state-init requires --state <file> --cwd <dir>');
      const attempt = args.attempt != null && args.attempt !== true ? parseInt(args.attempt, 10) : 1;
      const state = initState(args.state, { cwd: args.cwd, attempt });
      process.stdout.write(state.start_sha + '\n'); // skills capture with $( )
      process.exit(0);
    }

    if (args['state-init-read-only']) {
      if (!args.state || !args.cwd || !args['result-file'] || !args['ctx-file']) {
        usageError('--state-init-read-only requires --state <file> --cwd <dir> --result-file <file> --ctx-file <file>');
      }
      const attempt = args.attempt != null && args.attempt !== true ? parseInt(args.attempt, 10) : 1;
      initReadOnlyState(args.state, {
        cwd: args.cwd,
        attempt,
        resultFile: args['result-file'],
        contextFile: args['ctx-file'],
      });
      process.exit(0);
    }

    if (args['state-update']) {
      if (!args.state) usageError('--state-update requires --state <file>');
      const patch = {};
      if (args.reason != null && args.reason !== true) patch.reason = args.reason;
      if (args['result-file'] != null && args['result-file'] !== true) patch.result_file = args['result-file'];
      if (args['dispatch-id'] != null && args['dispatch-id'] !== true) {
        const dispatchId = String(args['dispatch-id']);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(dispatchId)) {
          usageError('--dispatch-id must be 1-128 safe identifier characters');
        }
        patch.dispatch_id = dispatchId;
      }
      if (args['transient-retry-count'] != null && args['transient-retry-count'] !== true) {
        patch.transient_retry_count = parseInt(args['transient-retry-count'], 10);
      }
      updateState(args.state, patch);
      process.exit(0);
    }

    if (args.reset) {
      if (!args.state) usageError('--reset requires --state <file>');
      const { code, result } = resetFromState(args.state);
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(code);
    }

    usageError('one of --state-init | --state-init-read-only | --state-update | --reset is required');
  } catch (e) {
    process.stderr.write(`forge-surgical-reset: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();
