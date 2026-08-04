#!/usr/bin/env node
'use strict';

// forge-repo-index.js — name → absolute path, deterministically, from any cwd.
//
// The founding incident (TASK-021) reads "`repo: freyr` was not resolvable".
// The mechanical cause was measured, not guessed: `forge-repos.discoverRepos`
// walks ONE level below the workspace, and `freyr` lives two levels down at
// `lookchina/services/freyr`. So `matchDeclaredRepo` in `forge-code-dir.js`
// was matching a declaration against a list that could not contain the answer
// — the declaration was correct and the lookup was blind.
//
// This module is the addressing half of the fix. It answers exactly one
// question — "where does the repo called X live?" — from the `repos[]` index
// T01 writes into the registry.
//
// ── Why cwd is not an input ─────────────────────────────────────────────────
//
// Under isolation `worktree` a unit runs with cwd at
// `<root>/.forge-worktrees/{RUN}/<repo>`, a path that is NOT contained in the
// workspace tree. Any resolver that derives its answer by walking UP from cwd
// fails precisely there — which is where the sidecar runs, and therefore where
// the incident happened. A resolver of that shape passes a naive test (run it
// from inside the workspace and it looks fine) and fails the real case.
//
// Hence: the index is GLOBAL (it comes from the registry, which is anchored at
// `$HOME`, not at cwd), and cwd enters in exactly one place — as a tiebreaker
// when a bare name matches more than one repo. A unique match never consults
// cwd at all, and the suite proves that by resolving from four different cwds
// (one of them inside a worktree outside the workspace) and asserting the
// answers are identical.
//
// ── Scope, deliberately narrow ──────────────────────────────────────────────
//
// This module ADDRESSES; it does not re-scope isolation. Answering "freyr
// lives at /abs/path" is separate from "does that repo have a worktree in the
// current isolation" — the latter stays with `forge-isolation.js`, untouched.
// Registry-first by decision D3: the on-disk marker (`forge-marker.js`) is
// consulted only when the registry is absent or unreadable — see
// `buildRepoIndex`'s own doc comment for the precise trigger.
//
// Zero deps. CommonJS. Library exports + `require.main` CLI, the same shape
// `forge-workspace.js` established.

const path = require('path');

const {
  loadRegistry,
  isStrictlyUnder,
  resolveEntryPath,
  registryPath,
} = require('./forge-workspace.js');

// ── helpers ─────────────────────────────────────────────────────────────────

/** Separator-normalised form for comparison. Never used to build a real path. */
function normalizeSlashes(p) {
  return String(p == null ? '' : p).split(path.sep).join('/').replace(/\/+$/, '');
}

function requireString(v, what) {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`forge-repo-index: ${what} must be a non-empty string`);
  }
  return v;
}

/**
 * `true` when `cwd` sits at or below `dir`.
 *
 * `isStrictlyUnder` is reused rather than re-derived — a bare `startsWith`
 * makes `/w/api-v2` look nested inside `/w/api`, and this function decides
 * which of two same-named repos wins a tiebreak. Equality is accepted on top
 * of strict containment because standing exactly on the workspace root is a
 * perfectly good statement of "I am in this workspace".
 */
function containsOrEquals(dir, cwd) {
  const d = path.resolve(dir);
  const c = path.resolve(cwd);
  return d === c || isStrictlyUnder(c, d);
}

// ── the index ───────────────────────────────────────────────────────────────

/**
 * Build the name → path index from the registry.
 *
 * Two kinds of entry contribute, and no third:
 *
 *   an entry with a populated `repos[]` (only workspaces ever get one —
 *     `syncWorkspaceRepos` enforces that on write) — every element becomes an
 *     addressable entry. `repos[]` holds workspace-relative paths (T01's
 *     contract: never absolute), so the absolute location is derived here by
 *     joining against the workspace's own resolved path. The `"."` element —
 *     the workspace is itself a single repo — is recorded under the
 *     workspace's own basename.
 *
 *   an entry with an empty `repos[]` — the entry itself is addressable by its
 *     basename. A standalone project under no workspace is still a repo
 *     somebody can name, and refusing to resolve it would be a gratuitous
 *     regression in addressing.
 *
 * The branch is keyed on `repos[]` rather than on `kind` deliberately. `kind`
 * is recomputed from disk on every load (`deriveEntryKind`) and is documented
 * there as a display cache, never authority — so a workspace whose nested
 * entry happens not to be registered reads back as `kind: project`, and an
 * index keyed on `kind` would then drop every repo under it. `repos[]` is the
 * fact this module needs, and it says what it means without a disk round-trip.
 *
 * Returns `{ byName, byPath, entries, workspaces, source, file, missing }`.
 * `byName` maps a name to an ARRAY — collisions are real on the operator's
 * disk (`apps/norns` and `services/norns`), and collapsing them to one value
 * here would silently pick a winner at index-build time, which is exactly the
 * failure mode `status: 'ambiguous'` exists to prevent.
 *
 * `source` is `'registry'`, `'marker'`, or `'none'` — the field D3's
 * precedence rule is expressed through. It is NOT derived from whether the
 * index ended up with any entries; a present-but-empty registry is still
 * `source: 'registry'` (a MISS, never a fallback trigger — see below).
 *
 * ── D3 fallback (T03) ───────────────────────────────────────────────────
 *
 * The registry is consulted first, always. Only when `loadRegistry` reports
 * genuine ABSENCE (`null` — the file does not exist) or THROWS (unreadable /
 * corrupt) does this function try `forge-marker.js`'s `findMarker` from
 * `opts.cwd`. A registry that loads successfully but has nothing matching —
 * `entries: []`, or entries that just don't cover this name — is a MISS, and
 * a MISS never reaches the marker: precedence is decided by whether the
 * registry could be READ, not by whether it had an answer. Blurring that
 * distinction would reopen the exact silent-divergence hole D3 exists to
 * close (`I-20260803025613`).
 *
 * A marker found but malformed is NOT swallowed into an empty index here —
 * `readMarker` throws with the file's own name and reason, and that throw is
 * left to propagate. Degrading to `{ entries: [] }` on a parse failure would
 * be indistinguishable from "this workspace has zero repos", which is the
 * TASK-021 failure class recurring on the marker's side of the fallback.
 */
function buildRepoIndex(opts) {
  const o = opts || {};
  const home = requireString(o.home, 'home');
  const file = o.registryFile || registryPath(home);

  const byName = new Map();
  const byPath = new Map();
  const entries = [];
  const workspaces = [];

  const add = (rec) => {
    entries.push(rec);
    const key = normalizeSlashes(rec.path);
    if (!byPath.has(key)) byPath.set(key, rec);
    const list = byName.get(rec.name);
    if (list) list.push(rec);
    else byName.set(rec.name, [rec]);
  };

  let registry = o.registry;
  if (!registry) {
    try {
      registry = loadRegistry(file, { home });
    } catch (e) {
      registry = null; // unreadable — treated the same as absent for D3 purposes
    }
  }
  if (!registry) {
    // Registry absent or unreadable — this is the one and only door the
    // marker fallback walks through (D3).
    const cwd = o.cwd || process.cwd();
    // eslint-disable-next-line global-require
    const { findMarker, readMarker } = require('./forge-marker.js');
    const found = findMarker(cwd);
    if (found) {
      const data = readMarker(found.file); // malformed → throws, propagates
      for (const r of data.repos) {
        add({ name: r.name, path: r.path, workspace: data.dir, relative: '.' });
      }
      return {
        byName, byPath, entries, workspaces: [{ path: data.dir, repos: data.repos.map(r => r.path) }],
        source: 'marker', file: data.file, missing: false,
      };
    }
    return {
      byName, byPath, entries, workspaces,
      source: 'none',
      file, missing: true,
    };
  }

  for (const e of registry.entries || []) {
    const abs = e.abs ? path.resolve(e.abs) : resolveEntryPath(e, home);

    const repos = Array.isArray(e.repos) ? e.repos : [];

    if (repos.length) {
      workspaces.push({ path: abs, repos: repos.slice() });
      for (const rel of repos) {
        const relNorm = normalizeSlashes(rel);
        const repoAbs = relNorm === '' || relNorm === '.'
          ? abs
          : path.resolve(abs, relNorm.split('/').join(path.sep));
        add({
          name: path.basename(repoAbs),
          path: repoAbs,
          workspace: abs,
          relative: relNorm === '' ? '.' : relNorm,
        });
      }
      continue;
    }

    // No index for this entry — it is addressable as itself.
    add({ name: path.basename(abs), path: abs, workspace: abs, relative: '.' });
  }

  return { byName, byPath, entries, workspaces, source: 'registry', file, missing: false };
}

/** Every addressable name, sorted and de-duplicated — the `unknown` payload. */
function availableNames(index) {
  return Array.from(index.byName.keys()).sort();
}

function miss(name, index, extra) {
  return Object.assign({
    name,
    status: 'unknown',
    path: '',
    workspace: '',
    relative: '',
    source: index.source,
    candidates: [],
    tiebreak: null,
    available: availableNames(index),
  }, extra || {});
}

function hit(name, rec, index, tiebreak, candidates) {
  return {
    name,
    status: 'ok',
    path: rec.path,
    workspace: rec.workspace,
    relative: rec.relative,
    source: index.source,
    candidates: (candidates || [rec]).map(c => c.path),
    tiebreak: tiebreak || null,
    available: [],
  };
}

function ambiguous(name, cands, index) {
  return {
    name,
    status: 'ambiguous',
    path: '',
    workspace: '',
    relative: '',
    source: index.source,
    candidates: cands.map(c => c.path),
    tiebreak: null,
    available: [],
  };
}

/**
 * Candidate lookup for one declaration, in a fixed strategy order:
 *
 *   (a) absolute path matching `byPath`
 *   (b) workspace-relative path (`services/freyr`) matching exactly one repo's
 *       `relative` within some workspace
 *   (c) bare basename in `byName`
 *
 * The order mirrors `matchDeclaredRepo` in `forge-code-dir.js:243-256` on
 * purpose: that function is the consumer T05 wires this into, and two layers
 * that disagree about what "matches" would produce a resolver whose answer the
 * caller then rejects.
 *
 * Comparison is separator-normalised but CASE-SENSITIVE at this level. The
 * operator's disk is case-insensitive, so a case-folded match would quietly
 * succeed on a typo that the `hint` is supposed to surface. Case-insensitive
 * matching exists only as a labelled last resort (see `resolveRepoName`).
 */
function candidatesFor(declared, index, fold) {
  const norm = fold ? normalizeSlashes(declared).toLowerCase() : normalizeSlashes(declared);
  const eq = (a) => (fold ? String(a).toLowerCase() : String(a));

  // (a) absolute
  if (path.isAbsolute(declared)) {
    const found = index.entries.filter(r => eq(normalizeSlashes(r.path)) === norm);
    if (found.length) return { strategy: 'absolute', found };
  }

  // (b) workspace-relative — only meaningful when the declaration has depth
  if (norm.includes('/')) {
    const found = index.entries.filter(r => eq(r.relative) === norm);
    if (found.length) return { strategy: 'relative', found };
  }

  // (c) basename
  const found = index.entries.filter(r => eq(r.name) === norm);
  return { strategy: 'name', found };
}

/**
 * Resolve a declared repo name to an absolute path.
 *
 * `index` is injectable so the suite can exercise pure resolution without
 * touching disk; when absent the index is built from the registry.
 *
 * Ambiguity is resolved by cwd, and ONLY by cwd containment in a candidate's
 * workspace. If zero or more than one candidate survives that filter the
 * result stays `ambiguous` and carries ALL original candidates. A worktree cwd
 * lives under no workspace, so it never disambiguates — that is honest rather
 * than convenient, and it is the case T05's `hint` tells the operator to fix
 * by declaring the full path.
 */
function resolveRepoName(name, opts) {
  const o = opts || {};
  const declared = String(name == null ? '' : name).trim();
  const index = o.index || buildRepoIndex({ home: o.home, registryFile: o.registryFile, cwd: o.cwd });

  if (!declared) return miss(declared, index);

  for (const fold of [false, true]) {
    const { found } = candidatesFor(declared, index, fold);
    if (!found.length) continue;

    const label = fold ? 'case-insensitive' : null;

    // Distinct paths only: the same repo reachable by two index rows is one answer.
    const uniq = [];
    const seen = new Set();
    for (const r of found) {
      const k = normalizeSlashes(r.path);
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(r);
    }

    if (uniq.length === 1) return hit(declared, uniq[0], index, label, uniq);

    if (o.cwd) {
      const cwd = path.resolve(o.cwd);
      const near = uniq.filter(r => containsOrEquals(r.workspace, cwd));
      if (near.length === 1) {
        return hit(declared, near[0], index, label ? `cwd+${label}` : 'cwd', uniq);
      }
    }
    return ambiguous(declared, uniq, index);
  }

  return miss(declared, index);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = [
  'uso: node scripts/forge-repo-index.js --resolve <nome> [--json] [--cwd <dir>] [--home <dir>] [--file <registry>]',
  '     node scripts/forge-repo-index.js --list [--json] [--home <dir>] [--file <registry>]',
  '',
  'exit: 0 resolvido | 1 desconhecido/ambíguo | 2 uso inválido',
].join('\n');

function parseArgs(argv) {
  const out = { json: false, list: false, resolve: null, cwd: null, home: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--list') out.list = true;
    else if (a === '--resolve') { out.resolve = argv[++i]; if (out.resolve == null) throw new Error('--resolve exige um nome'); }
    else if (a === '--cwd') { out.cwd = argv[++i]; if (out.cwd == null) throw new Error('--cwd exige um diretório'); }
    else if (a === '--home') { out.home = argv[++i]; if (out.home == null) throw new Error('--home exige um diretório'); }
    else if (a === '--file') { out.file = argv[++i]; if (out.file == null) throw new Error('--file exige um caminho'); }
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  return out;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}\n`);
    return 2;
  }

  if (!args.list && !args.resolve) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const home = args.home || process.env.HOME || process.env.USERPROFILE || '';
  if (!home) {
    process.stderr.write('forge-repo-index: sem HOME — use --home\n');
    return 2;
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();

  let index;
  try {
    index = buildRepoIndex({ home, registryFile: args.file, cwd });
  } catch (e) {
    process.stderr.write(`forge-repo-index: ${e.message}\n`);
    return 2;
  }

  if (args.list) {
    const rows = index.entries
      .map(r => ({ name: r.name, path: r.path, workspace: r.workspace, relative: r.relative }))
      .sort((a, b) => (a.name === b.name ? a.path.localeCompare(b.path) : a.name.localeCompare(b.name)));
    if (args.json) {
      process.stdout.write(JSON.stringify({
        source: index.source, file: index.file, missing: index.missing, count: rows.length, repos: rows,
      }, null, 2) + '\n');
    } else if (!rows.length) {
      process.stdout.write(`nenhum repo indexado (registry: ${index.file}${index.missing ? ', ausente' : ''})\n`);
    } else {
      for (const r of rows) process.stdout.write(`${r.name}\t${r.path}\n`);
    }
    return 0;
  }

  const res = resolveRepoName(args.resolve, { home, registryFile: args.file, cwd, index });

  if (args.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } else if (res.status === 'ok') {
    process.stdout.write(`${res.path}\n`);
  } else if (res.status === 'ambiguous') {
    process.stderr.write(`"${res.name}" é ambíguo — ${res.candidates.length} candidatos:\n`);
    for (const c of res.candidates) process.stderr.write(`  ${c}\n`);
    process.stderr.write('Declare o caminho completo para desambiguar.\n');
  } else {
    process.stderr.write(`"${res.name}" não casa com nenhum repo indexado.\n`);
    if (res.available.length) {
      process.stderr.write(`Disponíveis: ${res.available.join(', ')}\n`);
    } else {
      process.stderr.write(`Nenhum repo indexado — rode \`node scripts/forge-workspace.js --sync-repos\` (registry: ${index.file}).\n`);
    }
  }

  return res.status === 'ok' ? 0 : 1;
}

module.exports = {
  buildRepoIndex,
  resolveRepoName,
  availableNames,
  candidatesFor,
  containsOrEquals,
  normalizeSlashes,
  parseArgs,
  main,
  USAGE,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
