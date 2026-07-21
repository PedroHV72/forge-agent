#!/usr/bin/env node
// forge-isolation — Setup/cleanup for branch + worktree isolation modes
//
// For each git repo in the workspace:
//   branch mode   : git fetch origin <def> && git checkout <def> && git merge --ff-only origin/<def> && git checkout -b forge/{runId} (idempotent)
//   worktree mode : git fetch origin <def> && git worktree add {root}/{runId}/{repo} -b forge/{runId} origin/<def>
//
// Branching in git NEVER talks to the server — `git worktree add ... <def>` /
// `git checkout -b` start from the LOCAL ref, which may be many commits behind
// origin if nobody ran `git pull` on it. So we fetch origin/<def> first (updates
// the remote-tracking cache without touching any working tree) and branch from
// `origin/<def>`, deterministically, regardless of which branch the main checkout
// currently sits on. Falls back to the local ref when there is no origin remote.
//
// Library exports:
//   setupForRun(cwd, runId, opts) → { mode, repos: [{path, branch?, worktree?, status, error?}] }
//   cleanupForRun(cwd, runId, opts) → similar shape
//   readIsolationPrefs(cwd) → { mode, branchPattern, autoPullMain, worktreeRoot, worktreeCleanupOnComplete }
//
// CLI:
//   node forge-isolation.js --setup --run M065 [--cwd <path>]
//   node forge-isolation.js --cleanup --run M065 [--cwd <path>]

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { readPrefsCached } = require('./forge-prefs.js');

const repos = require('./forge-repos.js');
const runs = require('./forge-runs.js');

function readIsolationPrefs(cwd) {
  let mode = 'shared';
  let branchPattern = 'forge/{M###}';
  let autoPullMain = true;
  let worktreeRoot = '.forge-worktrees';
  let worktreeCleanupOnComplete = false;
  let prOnComplete = false;

  const isolation = readPrefsCached(cwd).prefs.forge_isolation;
  if (!isolation || typeof isolation !== 'object' || Array.isArray(isolation)) {
    return { mode, branchPattern, autoPullMain, worktreeRoot, worktreeCleanupOnComplete, prOnComplete };
  }
  if (typeof isolation.mode === 'string') mode = isolation.mode.toLowerCase();
  const stringValue = (value, fallback) => { if (typeof value !== 'string') return fallback; const s = value.replace(/^["']|["']$/g, '').trim(); return s.length > 0 ? s : fallback; };
  branchPattern = stringValue(isolation.branch_pattern, branchPattern);
  worktreeRoot = stringValue(isolation.worktree_root, worktreeRoot);
  const boolValue = (value, fallback) => value === undefined ? fallback : (typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true');
  autoPullMain = boolValue(isolation.auto_pull_main, autoPullMain);
  worktreeCleanupOnComplete = boolValue(isolation.worktree_cleanup_on_complete, worktreeCleanupOnComplete);
  prOnComplete = boolValue(isolation.pr_on_complete, prOnComplete);
  return { mode, branchPattern, autoPullMain, worktreeRoot, worktreeCleanupOnComplete, prOnComplete };
}

// ── Effective-mode elevation (require_worktree per write-engine) ────────────
// S03/M014: `shared` installs that resolve an EXTERNAL WRITE-engine
// (codex/gpt/gemini) for execute-task are elevated to `worktree` STATICALLY at
// activation — never mid-run. Elevation reuses the existing worktree mechanics
// wholesale (setupWorktreeOne/cleanupWorktreeOne); it only swaps the effective
// mode consumed by setupForRun/cleanupForRun. False-positive of elevation is
// acceptable; false-negative is NOT — detection is deliberately generous.

// Reads workers.require_worktree from the prefs cascade. Normalizes JSONC
// boolean true/false → "true"/"false". Valid set {auto,true,false}; anything
// else (or absent) → "auto" (default).
function resolveRequireWorktree(cwd) {
  try {
    const workers = readPrefsCached(cwd).prefs.workers;
    if (!workers || typeof workers !== 'object' || Array.isArray(workers)) return 'auto';
    const raw = workers.require_worktree;
    if (raw === undefined || raw === null) return 'auto';
    const v = String(raw).toLowerCase().trim();
    if (v === 'auto' || v === 'true' || v === 'false') return v;
    return 'auto';
  } catch { return 'auto'; }
}

// Detects whether an external write-engine (codex/gpt/gemini) is configured for
// execute-task. Returns { detected, reason }. Two signals (generous, OR'd):
//   (1) workers.execute-task == codex (the sidecar write path);
//   (2) any routing.<domain>.executor.<tier|fallback> id whose modelFamily is
//       gpt or gemini. Read-only paths (plan-slice Branch D, review challenger)
//       are intentionally NOT inspected — they never write.
// Never throws (never blocks activation): any error → { detected:true,
// reason:'detect-error (fail-safe: elevating)' } — detection fails SAFE
// (false-positive by design), consistent with the line-62 invariant.
function detectExternalWriteEngine(cwd) {
  try {
    const { modelFamily } = require('./forge-model-alias.js');
    const { readRoutingConfig } = require('./forge-routing.js');

    const prefs = readPrefsCached(cwd).prefs;
    if (prefs.workers && String(prefs.workers['execute-task']).toLowerCase() === 'codex') {
      return { detected: true, reason: 'workers.execute-task:codex' };
    }

    const cfg = readRoutingConfig(cwd);
    if (cfg.present && cfg.ok && cfg.routing && typeof cfg.routing === 'object') {
      for (const [domain, dcfg] of Object.entries(cfg.routing)) {
        if (!dcfg || typeof dcfg !== 'object') continue;
        if (!dcfg.executor || typeof dcfg.executor !== 'object') continue;
        for (const [tier, ids] of Object.entries(dcfg.executor)) {
          // Both tier chains (arrays) and the `fallback` string are inspected —
          // a gpt/gemini fallback is still write-engine intent (false-positive OK).
          const list = Array.isArray(ids) ? ids : [ids];
          for (const id of list) {
            const fam = modelFamily(id);
            if (fam === 'gpt' || fam === 'gemini') {
              return { detected: true, reason: 'routing.' + domain + '.executor.' + tier + ':' + fam };
            }
          }
        }
      }
    }
    return { detected: false, reason: null };
  } catch { return { detected: true, reason: 'detect-error (fail-safe: elevating)' }; }
}

// Resolves the EFFECTIVE isolation mode for a run, applying require_worktree
// elevation once at activation. Returns
//   { mode, user_mode, require_worktree, elevated, elevation_reason, write_engine }
// Invariants: `false` never elevates (byte-identical); a `worktree` user mode is
// a no-op; `true` always yields `worktree` from shared/branch; `auto` elevates
// only from `shared` when a write-engine is detected.
function resolveEffectiveMode(cwd) {
  const iso = readIsolationPrefs(cwd);
  const userMode = iso.mode;
  const req = resolveRequireWorktree(cwd);
  const base = { mode: userMode, user_mode: userMode, require_worktree: req, elevated: false, elevation_reason: null, write_engine: null };

  if (req === 'false') return base;            // never elevate — invariant
  if (userMode === 'worktree') return base;    // already isolated — no-op

  if (req === 'true') {
    return { ...base, mode: 'worktree', elevated: true, elevation_reason: 'require_worktree:true (' + userMode + '→worktree)' };
  }
  if (req === 'auto' && userMode === 'shared') {
    const det = detectExternalWriteEngine(cwd);
    if (det.detected) {
      return { ...base, mode: 'worktree', elevated: true, elevation_reason: 'require_worktree:auto ' + det.reason, write_engine: det.reason };
    }
  }
  return base;
}

function resolveBranchName(pattern, runId) {
  return pattern.replace(/\{M###\}/gi, runId).replace(/\{id\}/gi, runId);
}

function gitDefaultBranch(repoPath) {
  // Try origin/HEAD first; fall back to "main" then "master"
  try {
    const out = execSync('git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null', { cwd: repoPath, encoding: 'utf8', shell: true }).trim();
    return out.replace(/^origin\//, '') || 'main';
  } catch {}
  for (const b of ['main', 'master']) {
    try { execSync(`git rev-parse --verify ${b}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'ignore' }); return b; } catch {}
  }
  return 'main';
}

function gitCurrentBranch(repoPath) {
  try { return execSync('git branch --show-current', { cwd: repoPath, encoding: 'utf8', shell: true }).trim(); }
  catch { return null; }
}

function gitHasOriginRemote(repoPath) {
  try {
    execSync('git remote get-url origin', { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Fetch <def> from origin so worktrees/branches start from the freshest remote
// state, not a stale local ref. `git fetch` updates the `origin/<def>` cache
// without touching any working tree and does not depend on which branch the
// checkout currently sits on. Returns the ref to branch from:
//   { ref: 'origin/<def>', fetched: true }   when the fetch + verify succeeded
//   { ref: '<def>',        fetched: false }   no origin remote, or fetch failed
function fetchDefaultBranch(repoPath, def) {
  if (!gitHasOriginRemote(repoPath)) return { ref: def, fetched: false };
  try {
    execSync(`git fetch origin ${def} --quiet`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
    // Confirm the remote-tracking ref resolves before we rely on it as a base.
    execSync(`git rev-parse --verify origin/${def}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'ignore' });
    return { ref: `origin/${def}`, fetched: true };
  } catch (e) {
    return { ref: def, fetched: false, warn: `fetch origin ${def} failed: ${e.message.split('\n')[0]}` };
  }
}

function branchExists(repoPath, branch) {
  try {
    execSync(`git rev-parse --verify ${branch}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// ── Branch mode ─────────────────────────────────────────────────────────────
function setupBranchOne(repoPath, branchName, autoPullMain) {
  const result = { path: repoPath, branch: branchName, status: 'pending' };
  try {
    const currentBranch = gitCurrentBranch(repoPath);
    if (currentBranch === branchName) {
      result.status = 'already-on-branch';
      return result;
    }

    if (autoPullMain) {
      const def = gitDefaultBranch(repoPath);
      const base = fetchDefaultBranch(repoPath, def);
      if (base.warn) result.warn = base.warn;
      try {
        execSync(`git checkout ${def}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
        if (base.fetched) {
          // Fast-forward the local default to the freshly-fetched origin tip.
          execSync(`git merge --ff-only origin/${def}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
        } else {
          execSync(`git pull --ff-only`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
        }
      } catch (e) {
        result.warn = `update ${def} failed: ${e.message.split('\n')[0]}`;
      }
    }

    if (branchExists(repoPath, branchName)) {
      execSync(`git checkout ${branchName}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
      result.status = 'checked-out-existing';
    } else {
      execSync(`git checkout -b ${branchName}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
      result.status = 'created';
    }
  } catch (e) {
    result.status = 'error';
    result.error = e.message.split('\n')[0];
  }
  return result;
}

function cleanupBranchOne(repoPath, branchName) {
  // Do NOT auto-delete the branch — operator may want to PR. Just checkout main.
  const result = { path: repoPath, branch: branchName, status: 'pending' };
  try {
    const def = gitDefaultBranch(repoPath);
    const current = gitCurrentBranch(repoPath);
    if (current === branchName) {
      execSync(`git checkout ${def}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
      result.status = 'checked-out-default';
    } else {
      result.status = 'already-off-branch';
    }
  } catch (e) {
    result.status = 'error';
    result.error = e.message.split('\n')[0];
  }
  return result;
}

// ── Worktree mode ───────────────────────────────────────────────────────────
function setupWorktreeOne(repoPath, branchName, worktreeRoot, runId, autoPullMain) {
  const result = { path: repoPath, branch: branchName, worktree: null, status: 'pending' };
  try {
    const repoName = path.basename(repoPath);
    const wtPath = path.isAbsolute(worktreeRoot)
      ? path.join(worktreeRoot, runId, repoName)
      : path.join(repoPath, '..', worktreeRoot, runId, repoName);
    result.worktree = wtPath;

    // Already exists?
    if (fs.existsSync(wtPath)) {
      result.status = 'already-exists';
      return result;
    }

    fs.mkdirSync(path.dirname(wtPath), { recursive: true });

    if (autoPullMain) {
      const def = gitDefaultBranch(repoPath);
      // Fetch first, then branch the worktree from origin/<def> (fresh remote
      // cache) — NOT the local <def>, which is never updated by branching and is
      // commonly stale. Falls back to local <def> when there is no origin.
      const base = fetchDefaultBranch(repoPath, def);
      if (base.warn) result.warn = base.warn;
      result.base = base.ref;
      execSync(`git worktree add "${wtPath}" -b ${branchName} ${base.ref}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
    } else {
      execSync(`git worktree add "${wtPath}" -b ${branchName}`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
    }
    result.status = 'created';
  } catch (e) {
    result.status = 'error';
    result.error = e.message.split('\n')[0];
  }
  return result;
}

function cleanupWorktreeOne(repoPath, worktreePath) {
  const result = { path: repoPath, worktree: worktreePath, status: 'pending' };
  try {
    if (!fs.existsSync(worktreePath)) {
      result.status = 'not-found';
      return result;
    }
    // Uncommitted work (modified or untracked) is unrecoverable after removal —
    // commits on the forge/{id} branch survive, the working tree does not.
    // worktree_cleanup_on_complete only authorizes removal of a CLEAN worktree.
    const dirty = execSync('git status --porcelain', { cwd: worktreePath, encoding: 'utf8', shell: true, stdio: 'pipe' }).trim();
    if (dirty) {
      result.status = 'skipped (dirty)';
      result.reason = 'uncommitted changes in worktree — commit on the forge branch (or discard) before cleanup; nothing was removed';
      return result;
    }
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd: repoPath, encoding: 'utf8', shell: true, stdio: 'pipe' });
    result.status = 'removed';
  } catch (e) {
    result.status = 'error';
    result.error = e.message.split('\n')[0];
  }
  return result;
}

// ── Public top-level ────────────────────────────────────────────────────────
function setupForRun(cwd, runId, opts) {
  opts = opts || {};
  const prefs = readIsolationPrefs(cwd);
  const eff = resolveEffectiveMode(cwd);   // may elevate shared→worktree at activation
  const mode = eff.mode;
  const result = { mode, user_mode: eff.user_mode, elevated: eff.elevated, elevation_reason: eff.elevation_reason, repos: [] };

  if (mode === 'shared') return result;  // no-op

  const branchName = resolveBranchName(prefs.branchPattern, runId);
  const repoList = repos.discoverRepos(cwd);

  for (const r of repoList) {
    if (mode === 'branch') {
      result.repos.push(setupBranchOne(r, branchName, prefs.autoPullMain));
    } else if (mode === 'worktree') {
      result.repos.push(setupWorktreeOne(r, branchName, prefs.worktreeRoot, runId, prefs.autoPullMain));
    }
  }
  return result;
}

// Cleanup must honor the effective mode recorded at activation. This closes
// the M014 S03-R2 debt: a mid-run pref flip worktree→shared must not hit the
// shared guard and orphan the worktree. Only isolation_mode is registry-backed;
// a mid-run worktree_root flip remains out of scope.
const VALID_ISOLATION_MODES = new Set(['shared', 'branch', 'worktree']);

function resolveCleanupMode(cwd, runId) {
  let rec = null;
  try { rec = runs.get(cwd, runId); } catch { rec = null; }
  if (rec && typeof rec.isolation_mode === 'string' && rec.isolation_mode.trim()) {
    const normalized = rec.isolation_mode.trim().toLowerCase();
    if (VALID_ISOLATION_MODES.has(normalized)) {
      return { mode: normalized, source: 'registry' };
    }
    // Corrupted/unknown registry value: no-op rather than silently falling
    // back to re-resolving current prefs (that reintroduces the mid-run
    // pref-flip hazard this slice closed).
    return { mode: 'shared', source: 'invalid-registry' };
  }
  const eff = resolveEffectiveMode(cwd);
  return {
    mode: eff.mode,
    source: 'fallback-resolve',
    user_mode: eff.user_mode,
    elevated: eff.elevated,
    elevation_reason: eff.elevation_reason,
  };
}

function cleanupForRun(cwd, runId, opts) {
  opts = opts || {};
  const prefs = readIsolationPrefs(cwd);
  const cm = resolveCleanupMode(cwd, runId);
  const mode = cm.mode;
  const result = {
    mode,
    mode_source: cm.source,
    user_mode: cm.user_mode === undefined ? null : cm.user_mode,
    elevated: cm.elevated === undefined ? null : cm.elevated,
    elevation_reason: cm.elevation_reason === undefined ? null : cm.elevation_reason,
    repos: [],
  };

  if (mode === 'shared') return result;

  const branchName = resolveBranchName(prefs.branchPattern, runId);
  const repoList = repos.discoverRepos(cwd);

  for (const r of repoList) {
    if (mode === 'branch') {
      result.repos.push(cleanupBranchOne(r, branchName));
    } else if (mode === 'worktree') {
      if (!prefs.worktreeCleanupOnComplete) {
        result.repos.push({ path: r, status: 'skipped (worktree_cleanup_on_complete=false)' });
        continue;
      }
      const repoName = path.basename(r);
      const wtPath = path.isAbsolute(prefs.worktreeRoot)
        ? path.join(prefs.worktreeRoot, runId, repoName)
        : path.join(r, '..', prefs.worktreeRoot, runId, repoName);
      result.repos.push(cleanupWorktreeOne(r, wtPath));
    }
  }
  return result;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  const cwd  = args.cwd || process.cwd();

  if (args.help || (!args.setup && !args.cleanup && !args.prefs && !args['effective-mode'])) {
    process.stdout.write(`forge-isolation — setup/cleanup branch + worktree modes

Flags:
  --setup --run <id>     setup branch or worktree per repo (idempotent)
  --cleanup --run <id>   cleanup (checkout main / remove worktree)
  --prefs                print resolved forge_isolation prefs
  --effective-mode       print resolveEffectiveMode JSON (git-free; shows require_worktree elevation)
  --cwd <path>           override working directory

Reads prefs from forge_isolation: + workers.require_worktree (cascade user → repo → local).
--setup/--cleanup JSON carry elevated/elevation_reason/user_mode.
`);
    return;
  }

  try {
    if (args['effective-mode']) {
      process.stdout.write(JSON.stringify(resolveEffectiveMode(cwd), null, 2) + '\n');
    } else if (args.prefs) {
      process.stdout.write(JSON.stringify(readIsolationPrefs(cwd), null, 2) + '\n');
    } else if (args.setup) {
      const r = setupForRun(cwd, args.run);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else if (args.cleanup) {
      const r = cleanupForRun(cwd, args.run);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    }
  } catch (e) {
    process.stderr.write(`forge-isolation error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();

module.exports = {
  setupForRun, cleanupForRun, readIsolationPrefs,
  resolveEffectiveMode, detectExternalWriteEngine, resolveRequireWorktree, resolveCleanupMode,
  resolveBranchName, gitDefaultBranch, gitCurrentBranch,
  gitHasOriginRemote, fetchDefaultBranch,
};
