#!/usr/bin/env node
// forge-run-address — the ADDRESS of a run: run -> root -> project -> repo.
//
// The gap this closes, measured before it was written: a `RunRecord` carried
// `cwd` and nothing else about where it lives. Two runs on the same project in
// different branches therefore had BYTE-IDENTICAL `cwd`, and the only thing
// separating them was the accident of two different filenames in
// `.gsd/forge/runs/`. A filename is not an address — you cannot ask a question
// of it, you cannot compare two of them, and nothing downstream could tell the
// operator which run owned which branch.
//
// ── The one property that matters ───────────────────────────────────────────
//
// The address is CWD-INVARIANT. Resolving the same run id from the project
// root, from a nested subdirectory, and from a tmpdir entirely outside the
// tree yields a byte-identical answer. `cwd` is the door you walk through to
// find the registry; it is never part of what you find. This is not a
// convenience property — the pre-S06 form derived the answer from
// `process.cwd()`, and under isolation `worktree` the orchestrator's cwd is
// `<root>/.forge-worktrees/{RUN}/<repo>`, a path outside the workspace tree
// entirely. A cwd-derived address is correct in exactly the place nobody runs
// and wrong in the place the incidents happen (the TASK-021 shape).
//
// `resolved_from` is carried in the output for AUDIT ONLY and is the single
// field the invariance test excludes — it is there so a human can see which
// door was used, never so a caller can branch on it.
//
// ── This module composes; it does not re-derive ─────────────────────────────
//
//   root containment  -> forge-isolation.findContainingRoot  (S04)
//   project ownership -> forge-workspace.resolveOwner        (D1, nearest wins)
//   project role      -> forge-workspace.resolveRole
//   repo index        -> forge-repo-index.buildRepoIndex     (S05, D3)
//
// A fourth implementation of any of those relations is the defect, not the
// feature. Every leg reports its own `source` so a reader can tell a recorded
// fact from a derived one without guessing.
//
// CLI:
//   node forge-run-address.js --address <run-id> [--json] [--cwd <path>]

'use strict';

const os   = require('os');
const path = require('path');

const runs      = require('./forge-runs.js');
const ws        = require('./forge-workspace.js');
const isolation = require('./forge-isolation.js');
const repoIndex = require('./forge-repo-index.js');

// ── Degradation reasons ─────────────────────────────────────────────────────
//
// Enumerated because a comment that misstates its own reachable cases IS the
// defect (TASK-021; and S04/R1 shipped a FREEZE comment claiming "legacy
// records only" when `rec === null` also landed there). So: every value below
// is reachable, INCLUDING `null`, and `null` is listed first because it is the
// common case that a prose-only enumeration silently omits.
//
// project.reason
//   null                          project resolved (source 'record' or 'derived')
//   'no-owning-project'           the walk up from the run's recorded cwd found
//                                 no `.gsd/` — resolveOwner returned null. NOT
//                                 an error: a run can be registered against a
//                                 directory whose project was since removed.
//   'record-project-unanchored'   the record DECLARES a project, and the value
//                                 is relative. Reachable with source 'record'
//                                 and a null path — the record spoke and what
//                                 it said was unusable.
//
// root.reason
//   null                       root resolved (source 'record' or 'derived')
//   'record-root-unresolvable' the record DECLARES a root that is neither a
//                              resolvable path nor the name of a declared
//                              root. Same shape as above: source 'record',
//                              path null.
//   'no-project'               the project leg failed, so containment has
//                              nothing to test. Reported instead of
//                              'no-containing-root' because "we could not
//                              look" and "we looked and found none" are
//                              different facts.
//   'no-registry'          the registry file does not exist.
//   'registry-unreadable'  it exists and could not be parsed. Kept DISTINCT
//                          from 'no-registry' — S04 separated these two and
//                          collapsing them is how an unreadable operator
//                          registry starts reading as an empty one.
//   'no-roots-declared'    registry read fine, `roots[]` is empty. Distinct
//                          from the next one for the same reason: nothing was
//                          declared vs. something was declared and missed.
//   'no-containing-root'   roots exist; none strictly contains the project.
const REASONS = {
  project: [null, 'no-owning-project', 'record-project-unanchored'],
  root:    [null, 'record-root-unresolvable', 'no-project', 'no-registry',
            'registry-unreadable', 'no-roots-declared', 'no-containing-root'],
};

// ── Registry context: loaded ONCE, passed to the derivers as immutable ──────
//
// One read, one status. `forge-isolation.loadRegistryRoots` covers the roots
// half of this, but it returns neither the entries (needed for `resolveRole`)
// nor the registry object (needed by `buildRepoIndex` to avoid a third read of
// the same file), and it folds "absent" and "unreadable" into one
// `present:false` + optional warn. Three reads of one file can disagree with
// each other; one read cannot. The registry CODEC is still entirely
// forge-workspace's — nothing here parses the file.
function loadContext(opts) {
  const home = opts.home || os.homedir();
  const file = opts.registryFile || ws.registryPath(home);

  if (opts.registry) {
    return { home, file, registry: opts.registry, status: 'ok' };
  }
  let registry = null;
  let status   = 'ok';
  try {
    registry = ws.loadRegistry(file, { home });
    if (!registry) status = 'no-registry';
  } catch {
    status = 'registry-unreadable';
  }
  return { home, file, registry, status };
}

/** Absolute paths of every registered entry — `resolveRole`'s active set. */
function activePaths(ctx) {
  if (!ctx.registry) return [];
  const out = [];
  for (const e of ctx.registry.entries || []) {
    try { out.push(e.abs ? path.resolve(e.abs) : ws.resolveEntryPath(e, ctx.home)); }
    catch { /* one unusable entry never disqualifies the others (findContainingRoot's rule) */ }
  }
  return out;
}

// ── Legs ────────────────────────────────────────────────────────────────────

function projectLeg(rec, ctx, opts) {
  if (rec.project) {
    // A relative declared project would be resolved against the CALLER's cwd,
    // which is the one thing this module must never do — it would smuggle cwd
    // straight back into the identity through the precedence door. Unanchored
    // is reported, never guessed.
    if (!path.isAbsolute(rec.project)) {
      return { path: null, name: null, source: 'record', reason: 'record-project-unanchored' };
    }
    const abs = path.resolve(rec.project);
    return { path: abs, name: path.basename(abs), source: 'record', reason: null };
  }
  // The start of the walk is the RUN's recorded cwd — never the caller's. This
  // single choice is what the cwd-invariance test defends.
  const owner = ws.resolveOwner(rec.cwd, opts.stopAt ? { stopAt: opts.stopAt } : {});
  if (!owner) {
    return { path: null, name: null, source: null, reason: 'no-owning-project' };
  }
  return { path: owner, name: path.basename(owner), source: 'derived', reason: null };
}

/** A declared root given as a bare NAME, matched against the declared roots. */
function matchRootByName(name, ctx) {
  const roots = (ctx.registry && ctx.registry.roots) || [];
  for (let i = 0; i < roots.length; i++) {
    let abs;
    try { abs = ws.resolveRootPath(ws.normalizeRootEntry(roots[i], i).path, ctx.home); }
    catch { continue; }   // one unusable root never disqualifies the others
    if (path.basename(abs) === name) return abs;
  }
  return null;
}

function rootLeg(rec, project, ctx) {
  // Precedence: what the record DECLARES beats what the tree implies, and it
  // is checked before the project leg — a declared root stands on its own and
  // does not need a project to have resolved.
  if (rec.root) {
    let abs = null;
    try { abs = ws.resolveRootPath(rec.root, ctx.home); }
    catch { abs = matchRootByName(rec.root, ctx); }   // not a path — try it as a root name
    if (!abs) {
      return { path: null, name: null, source: 'record', reason: 'record-root-unresolvable' };
    }
    return { path: abs, name: path.basename(abs), source: 'record', reason: null };
  }
  if (!project.path) {
    return { path: null, name: null, source: null, reason: 'no-project' };
  }
  if (ctx.status !== 'ok') {
    return { path: null, name: null, source: null, reason: ctx.status };
  }
  const roots = (ctx.registry && ctx.registry.roots) || [];
  if (roots.length === 0) {
    return { path: null, name: null, source: null, reason: 'no-roots-declared' };
  }
  const found = isolation.findContainingRoot(project.path, roots, ctx.home);
  if (!found) {
    return { path: null, name: null, source: null, reason: 'no-containing-root' };
  }
  return { path: found.abs, name: path.basename(found.abs), source: 'derived', reason: null };
}

/**
 * Repos of the workspace the project IS, `[]` when it is not a workspace.
 *
 * The anchor handed to `buildRepoIndex` is the run's own project (falling back
 * to its recorded cwd), NEVER the caller's cwd. That anchor only feeds D3's
 * marker walk-up, but feeding it a caller-supplied cwd would make the marker
 * fallback answer a different question from three different directories — the
 * invariance would then hold only by the luck of the registry being present.
 * Anchoring on the record makes it structural. (S05 Forward Intelligence: pass
 * the cwd forward explicitly and say which one; never let it default.)
 *
 * A malformed marker throws out of `readMarker` and that throw is deliberately
 * NOT caught here: S05 chose propagation because degrading to `[]` would be
 * indistinguishable from "this workspace has zero repos" — the exact silence
 * this milestone exists to remove.
 */
function repoLeg(rec, project, ctx) {
  const anchor = project.path || rec.cwd;
  const index = repoIndex.buildRepoIndex({
    home: ctx.home,
    registryFile: ctx.file,
    registry: ctx.registry || undefined,
    cwd: anchor,
  });
  if (!project.path) return [];
  const isWorkspace = index.workspaces.some(w => path.resolve(w.path) === project.path);
  if (!isWorkspace) return [];
  return index.entries
    .filter(e => path.resolve(e.workspace) === project.path)
    // Sorted by (name, path), not name alone: basename collision
    // (`apps/norns` + `services/norns`) is the DEFAULT case on this operator's
    // disk, and a name-only sort is unstable exactly where it collides.
    .map(e => ({ name: e.name, path: e.path }))
    .sort((a, b) => (a.name === b.name ? a.path.localeCompare(b.path) : a.name.localeCompare(b.name)));
}

/**
 * Find the run record for `runId` WITHOUT letting the caller's cwd decide the
 * answer.
 *
 * The naive form — `runs.get(cwd, runId)` — makes the address unresolvable
 * from anywhere but the project root: a nested subdirectory has no `.gsd/`,
 * and a tmpdir outside the tree has no relationship to the run at all. An
 * address you can only ask for while standing on top of it is not an address.
 *
 * So the registry is scanned FIRST, in registry order. That order is a
 * property of the file, not of the caller, which is what makes the answer
 * identical from three different cwds. Ids are unique in practice; scanning in
 * a fixed order means that even if they were not, the winner is still the same
 * one from every direction.
 *
 * The caller's owning project is a FALLBACK, reached only when the registry
 * had no answer — an unregistered project can still address its own runs. This
 * is the one leg where cwd can influence the result, and it is reachable only
 * where the alternative is no result at all.
 */
function findRunRecord(cwd, runId, ctx) {
  for (const p of activePaths(ctx)) {
    const rec = runs.get(p, runId);
    if (rec) return rec;
  }
  const owner = ws.resolveOwner(cwd, {});
  if (owner) {
    const rec = runs.get(owner, runId);
    if (rec) return rec;
  }
  return null;
}

// ── The resolver ────────────────────────────────────────────────────────────

/**
 * `resolveRunAddress(cwd, runId, opts) -> address`
 *
 * `cwd` locates the `.gsd/` holding the run registry and nothing else. Two
 * calls differing only in `cwd` differ only in `resolved_from`.
 *
 * Precedence, per leg: a value RECORDED on the run wins over derivation
 * (registry-authoritative-first, D3's rule). Derivation runs only where the
 * recorded field is `null`.
 *
 * Throws only for an unknown run id — every other failure degrades to a named
 * `reason`, never to an invented path.
 */
function resolveRunAddress(cwd, runId, opts) {
  opts = opts || {};
  if (!runId) throw new Error('forge-run-address: a run id is required');

  const ctx = loadContext(opts);
  const rec = findRunRecord(cwd, runId, ctx);
  if (!rec) {
    throw new Error(
      `forge-run-address: run "${runId}" not found in any registered project (registry ${ctx.file}, status ${ctx.status}) nor under ${path.resolve(cwd)}`);
  }

  const project = projectLeg(rec, ctx, opts);
  const root    = rootLeg(rec, project, ctx);
  const repos   = repoLeg(rec, project, ctx);

  const role = project.path
    ? ws.resolveRole(project.path, activePaths(ctx))
    : null;

  return {
    run: {
      id: rec.id,
      kind: rec.kind,
      active: rec.active === true,
      branch: rec.branch === undefined ? null : rec.branch,
      isolation_mode: rec.isolation_mode || null,
      // ADDITIVE (S07/review-fix R1). Verbatim pass-through of the record's
      // `worktrees: [{ repo, path }]`, where `repo` is the REGISTERED repo path
      // and `path` is the physical worktree. A consumer in worktree isolation
      // that derives from the registered checkout is reading the wrong tree —
      // the run's HEAD lives in the worktree. Exposing it here rather than
      // re-reading the record elsewhere keeps the record lookup single-sourced
      // (`findRunRecord`, cwd-invariant); a second lookup would be the defect.
      // `[]` when the record predates the field or the mode is `branch`/`shared`.
      worktrees: Array.isArray(rec.worktrees) ? rec.worktrees : [],
      cwd: rec.cwd,
    },
    root:    { path: root.path, name: root.name, source: root.source, reason: root.reason },
    project: {
      path: project.path, name: project.name, role,
      source: project.source, reason: project.reason,
    },
    repos,
    resolved_from: path.resolve(cwd),   // AUDIT ONLY — never part of the identity
  };
}

/** One human-readable line: run -> root -> project -> repos. */
function formatAddress(addr) {
  const branch = addr.run.branch ? ` @${addr.run.branch}` : '';
  const rootTxt = addr.root.path
    ? `${addr.root.name} (${addr.root.path})`
    : `— (${addr.root.reason})`;
  const projTxt = addr.project.path
    ? `${addr.project.name} [${addr.project.role || 'unregistered'}]`
    : `— (${addr.project.reason})`;
  const repoTxt = addr.repos.length
    ? addr.repos.map(r => r.name).join(', ')
    : '—';
  return `${addr.run.id}${branch} (${addr.run.kind}, ${addr.run.isolation_mode || '?'})`
       + `\n  root:    ${rootTxt}`
       + `\n  project: ${projTxt}`
       + `\n  repos:   ${repoTxt}`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

const USAGE = `forge-run-address — resolve a run's address (run -> root -> project -> repo)

Flags:
  --address <run-id>   resolve the address of a registered run
  --json               emit JSON instead of the human-readable form
  --cwd <path>         where to look for .gsd/forge/runs/ (default: process.cwd())
  --help               this text

The answer does not depend on --cwd: the same run resolves to the same address
from anywhere. --cwd only says which .gsd/ holds the run registry, and is
echoed back as "resolved_from" for audit.
`;

function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || Object.keys(args).length === 0) {
    process.stdout.write(USAGE);
    return;
  }
  const cwd = typeof args.cwd === 'string' ? args.cwd : process.cwd();
  try {
    if (typeof args.address === 'string') {
      const addr = resolveRunAddress(cwd, args.address);
      process.stdout.write(args.json
        ? JSON.stringify(addr, null, 2) + '\n'
        : formatAddress(addr) + '\n');
    } else {
      process.stderr.write('forge-run-address: --address <run-id> is required. Use --help.\n');
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`forge-run-address error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();

module.exports = {
  resolveRunAddress,
  formatAddress,
  loadContext,
  activePaths,
  findRunRecord,
  projectLeg,
  rootLeg,
  repoLeg,
  parseArgs,
  REASONS,
  USAGE,
};
