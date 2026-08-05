#!/usr/bin/env node
// forge-repos — Discover git repos in a workspace
//
// Auto-detect: walk subdirs of the workspace cwd, list any with a .git/ directory
// or .git file (worktree pointer). Apply include/exclude globs from prefs.
//
// Library exports:
//   discoverRepos(cwd, opts) → string[] (absolute paths)
//   readReposPrefs(cwd) → { autoDetect, include, exclude }
//
// CLI:
//   node forge-repos.js --list [--cwd <path>]

'use strict';

const fs   = require('fs');
const path = require('path');
const { readPrefsCached } = require('./forge-prefs.js');

const DEFAULT_EXCLUDE = ['node_modules/**', 'vendor/**', '.forge-worktrees/**', '.gsd/**', 'dist/**', 'build/**', '.next/**'];

function readReposPrefs(cwd) {
  const repos = readPrefsCached(cwd).prefs.forge_isolation?.repos || {};
  return {
    autoDetect: typeof repos.auto_detect === 'boolean' ? repos.auto_detect : true,
    include: Array.isArray(repos.include) ? repos.include.slice() : [],
    exclude: Array.isArray(repos.exclude) ? repos.exclude.slice() : DEFAULT_EXCLUDE.slice(),
  };
}

// Lightweight glob matcher (no minimatch — zero deps).
// Supports: literal segments, `*` (any chars within segment), `**` (any depth).
function globMatch(pattern, str) {
  const re = '^' + pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*') + '$';
  return new RegExp(re).test(str);
}

function matchesAny(patterns, relPath) {
  return patterns.some(p => globMatch(p, relPath));
}

function isGitRepo(dir) {
  const gitPath = path.join(dir, '.git');
  if (!fs.existsSync(gitPath)) return false;
  const stat = fs.statSync(gitPath);
  // .git can be a dir (main repo) or a file (worktree pointer)
  return stat.isDirectory() || stat.isFile();
}

function discoverRepos(cwd, opts) {
  opts = opts || {};
  const prefs = readReposPrefs(cwd);

  // Explicit include wins
  if (prefs.include.length > 0) {
    return prefs.include
      .map(p => path.isAbsolute(p) ? p : path.join(cwd, p))
      .filter(p => isGitRepo(p));
  }

  if (!prefs.autoDetect) return [];

  // Walk 1 level deep (workspace is the cwd, repos are direct subdirs)
  const candidates = [];
  let entries;
  try { entries = fs.readdirSync(cwd, { withFileTypes: true }); }
  catch { return []; }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue;
    if (matchesAny(prefs.exclude, ent.name) || matchesAny(prefs.exclude, ent.name + '/**')) continue;

    const sub = path.join(cwd, ent.name);
    if (isGitRepo(sub)) candidates.push(sub);
  }

  // Also include the workspace itself if it's a git repo (single-repo case)
  if (isGitRepo(cwd) && !candidates.includes(cwd)) candidates.unshift(cwd);

  return candidates;
}

function repoNames(cwd) {
  return discoverRepos(cwd).map(p => path.basename(p));
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

  if (args.help) {
    process.stdout.write(`forge-repos — discover git repos in workspace

Flags:
  --list           print discovered repo paths (one per line)
  --json           output as JSON array (with prefs)
  --cwd <path>     override working directory
`);
    return;
  }

  try {
    const repos = discoverRepos(cwd);
    if (args.json) {
      process.stdout.write(JSON.stringify({ prefs: readReposPrefs(cwd), repos }, null, 2) + '\n');
    } else {
      process.stdout.write(repos.join('\n') + (repos.length ? '\n' : ''));
    }
  } catch (e) {
    process.stderr.write(`forge-repos error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();

module.exports = { discoverRepos, repoNames, readReposPrefs, globMatch };
