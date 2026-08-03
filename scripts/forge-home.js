#!/usr/bin/env node
'use strict';

// One path boundary for the Forge core.  Runtime homes are projections only;
// the Forge home is the source of truth for shared code, schemas and prefs.
// This module intentionally uses only node:fs/node:path/node:os semantics so
// the same contract works from native Windows PowerShell, macOS and Linux.

const os = require('os');
const path = require('path');

const RUNTIMES = Object.freeze(['claude', 'codex']);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function absolute(value, label) {
  const text = nonEmpty(value);
  if (!text) throw new TypeError(`${label} must be a non-empty path`);
  return path.resolve(text);
}

function platformOf(options) {
  const candidate = options && options.platform;
  return candidate === 'win32' || candidate === 'darwin' || candidate === 'linux'
    ? candidate
    : process.platform;
}

/** Resolve the operator home without invoking a shell or expanding ~. */
function resolveUserHome(options) {
  const opts = options || {};
  if (opts.userHome) return absolute(opts.userHome, 'userHome');
  const platform = platformOf(opts);
  const names = platform === 'win32' ? ['USERPROFILE', 'HOME'] : ['HOME', 'USERPROFILE'];
  for (const name of names) {
    const value = nonEmpty(opts.env && opts.env[name]) || nonEmpty(process.env[name]);
    if (value) return absolute(value, name);
  }
  return absolute(os.homedir(), 'home');
}

/**
 * Resolve the canonical shared Forge home. FORGE_HOME is an explicit test and
 * embedding override and always wins over HOME/USERPROFILE. A caller may pass
 * `env` to test this precedence without mutating process.env.
 */
function resolveForgeHome(options) {
  const opts = options || {};
  const configured = nonEmpty(opts.forgeHome) || nonEmpty(opts.env && opts.env.FORGE_HOME) || nonEmpty(process.env.FORGE_HOME);
  return configured ? absolute(configured, 'FORGE_HOME') : path.join(resolveUserHome(opts), '.forge-agent');
}

function assertRuntime(runtime) {
  const value = nonEmpty(runtime);
  if (!RUNTIMES.includes(value)) throw new RangeError(`runtime must be one of: ${RUNTIMES.join(', ')}`);
  return value;
}

function resolveRuntimeHome(runtime, options) {
  const opts = options || {};
  const name = assertRuntime(runtime);
  const explicit = name === 'claude' ? opts.claudeHome : opts.codexHome;
  if (explicit) return absolute(explicit, `${name}Home`);
  return path.join(resolveUserHome(opts), `.${name}`);
}

function resolveForgePaths(options) {
  const opts = options || {};
  const cwd = absolute(opts.cwd || process.cwd(), 'cwd');
  const forgeHome = resolveForgeHome(opts);
  const userHome = resolveUserHome(opts);
  const runtimeHomes = Object.freeze({
    claude: resolveRuntimeHome('claude', opts),
    codex: resolveRuntimeHome('codex', opts),
  });
  const shared = Object.freeze({
    root: forgeHome,
    scripts: path.join(forgeHome, 'scripts'),
    schemas: path.join(forgeHome, 'schemas'),
    prefs: path.join(forgeHome, 'forge-agent-prefs.jsonc'),
    templates: path.join(forgeHome, 'templates'),
    adapters: path.join(forgeHome, 'adapters'),
    version: path.join(forgeHome, 'VERSION'),
    manifest: path.join(forgeHome, 'manifest.json'),
  });
  return Object.freeze({
    platform: platformOf(opts),
    cwd,
    userHome,
    forgeHome,
    runtimeHomes,
    claudeHome: runtimeHomes.claude,
    codexHome: runtimeHomes.codex,
    shared,
    project: Object.freeze({ root: cwd, gsd: path.join(cwd, '.gsd') }),
    adapters: Object.freeze({
      root: shared.adapters,
      claude: path.join(shared.adapters, 'claude'),
      codex: path.join(shared.adapters, 'codex'),
    }),
  });
}

function resolvePreferencePaths(cwd, options) {
  const opts = options || {};
  const paths = resolveForgePaths({ ...opts, cwd: cwd || opts.cwd });
  const explicitGlobal = Boolean(opts.globalDir);
  const canonicalGlobal = absolute(opts.globalDir || paths.forgeHome, 'globalDir');
  const legacyGlobal = paths.runtimeHomes.claude;
  const canonical = {
    jsoncPath: path.join(canonicalGlobal, 'forge-agent-prefs.jsonc'),
    mdFiles: [path.join(canonicalGlobal, 'forge-agent-prefs.md')],
  };
  const legacy = {
    jsoncPath: path.join(legacyGlobal, 'forge-agent-prefs.jsonc'),
    mdFiles: [path.join(legacyGlobal, 'forge-agent-prefs.md')],
  };
  const localDir = absolute(opts.localDir || path.join(paths.cwd, '.gsd'), 'localDir');
  return Object.freeze({
    globalDir: canonicalGlobal,
    localDir,
    canonical,
    legacy: explicitGlobal ? null : legacy,
    jsoncCandidates: explicitGlobal ? [canonical.jsoncPath] : [canonical.jsoncPath, legacy.jsoncPath],
    mdCandidates: explicitGlobal ? canonical.mdFiles : canonical.mdFiles.concat(legacy.mdFiles),
    legacyMdFiles: explicitGlobal ? [] : legacy.mdFiles,
    local: {
      jsoncPath: path.join(localDir, 'forge-prefs.jsonc'),
      mdFiles: [path.join(localDir, 'claude-agent-prefs.md'), path.join(localDir, 'prefs.local.md')],
    },
  });
}

// Compatibility aliases make the boundary easy to consume from older scripts.
const resolveForgePathsForCwd = resolveForgePaths;
const forgeHomeDescriptors = resolveForgePaths;

module.exports = {
  RUNTIMES,
  resolveUserHome,
  resolveForgeHome,
  resolveRuntimeHome,
  resolveForgePaths,
  resolveForgePathsForCwd,
  resolvePreferencePaths,
  forgeHomeDescriptors,
};

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(resolveForgePaths())}\n`);
}
