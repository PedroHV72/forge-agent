#!/usr/bin/env node
'use strict';

// forge-workspace-consistency.js — advisory guard that confronts the two sources
// D3 created: the registry (`~/.claude/forge-workspace.json`, authoritative) and
// the on-disk marker (`forge-workspace.jsonc`/`forge-root.jsonc`, T03's fallback).
//
// ── Why this exists (D3, verbatim requirement) ──────────────────────────────
//
// D3 accepted a risk in the same breath it created the fallback: "two sources
// that can diverge in silence are the same failure class as TASK-021, where the
// right data existed and nobody confronted it." This module IS the confrontation.
// It is a first-class deliverable of the milestone, not a nicety layered on top.
//
// ── Posture (fixed by D3, not a preference) ─────────────────────────────────
//
//   Advisory  — the CLI's exit code is 0 UNCONDITIONALLY, divergence or not.
//   Visible   — wired into `forge-doctor`, a place the operator already looks,
//               not just a JSON blob nobody asks for.
//
// A guard that ever starts blocking pauses everybody's loop the first time a
// second machine's marker legitimately lags the registry after a rename. That
// is not this guard's job — `sidecar-code-dir-undeclared` / `unknown` already
// fail closed at resolution time (T02/T05) when a name genuinely cannot be
// resolved. This guard only makes an existing, already-tolerated disagreement
// VISIBLE so a human can reconcile it — it never decides that disagreement is
// fatal.
//
// ── Precedence note (does NOT change here) ──────────────────────────────────
//
// `buildRepoIndex` (forge-repo-index.js) only ever consults the marker when the
// registry is absent or unreadable — the two are never both consulted during
// normal resolution. This module is the ONLY code path that looks at both at
// once, specifically to notice when they disagree. Auditing here changes
// nothing about which source resolution actually uses.
//
// ── Shape ────────────────────────────────────────────────────────────────
//
//   compareSources({ workspace, registryRepos, markerRepos })
//     Pure. No `fs.*` calls anywhere in its body (a test scans the source to
//     prove this, the same pattern S01 used to prove `migrate()` is pure).
//     Returns { ok, diffs: [{ name, kind, registry_path, marker_path }] }.
//     `kind` is one of:
//       missing-in-marker    — name exists in the registry, absent from the marker
//       missing-in-registry  — name exists in the marker, absent from the registry
//       path-mismatch        — same name, different normalized absolute path
//
//   auditWorkspaces({ home, registryFile, cwd })
//     Impure gatherer. Loads the registry, and for every entry that carries a
//     populated `repos[]` (i.e. is a workspace with an index — the only kind
//     of entry a marker could plausibly duplicate), looks for a marker file
//     DIRECTLY INSIDE that workspace's own directory — never walking up. The
//     question here is "does THIS workspace have a marker", not "who governs
//     this cwd" (that second question is `findMarker`'s normal, walk-up job
//     used elsewhere). Returns one result per workspace:
//       { workspace, status: 'ok'|'divergent'|'no-marker'|'marker-unreadable',
//         diffs, error }
//     A workspace with no marker file is `no-marker` with `diffs: []` — the
//     absence of a second source is not a disagreement, and reporting it as
//     one would manufacture noise on every machine that never opted into a
//     marker. A marker file that fails to parse is `marker-unreadable`,
//     distinct from `divergent` — a read failure and a factual disagreement
//     are different problems with different fixes.
//
//   CLI: node forge-workspace-consistency.js --check [--json] [--home <dir>]
//        [--file <path>] [--cwd <dir>]
//     Human output is pt-BR, one line per divergence naming the repo and both
//     paths. `process.exit(0)` always — see the posture note above; this is
//     commented again at the call site so nobody "fixes" it into a failure
//     exit later.
//
// This module NEVER writes anything — no marker correction, no registry
// correction. A guessed reconciliation would be worse than a visible gap,
// exactly the discipline `forge-code-dir.js` already holds for `hintFor`.

const fs = require('fs');
const path = require('path');

const { loadRegistry, registryPath } = require('./forge-workspace');

function normalizeSlashes(p) {
  return String(p).split(path.sep).join('/');
}

function normalizePath(p) {
  return normalizeSlashes(path.normalize(String(p)));
}

// ── compareSources — pure ───────────────────────────────────────────────────
/**
 * Confront two flat repo lists for the SAME workspace and name the diffs.
 * Pure: reads only the arrays it is handed, never touches disk.
 *
 * @param {object} opts
 * @param {string} opts.workspace     - absolute path of the workspace (for context only)
 * @param {Array<{name:string,path:string}>} opts.registryRepos
 * @param {Array<{name:string,path:string}>} opts.markerRepos
 * @returns {{ ok: boolean, diffs: Array<{name:string,kind:string,registry_path:string|null,marker_path:string|null}> }}
 */
function compareSources(opts) {
  const o = opts || {};
  const registryRepos = Array.isArray(o.registryRepos) ? o.registryRepos : [];
  const markerRepos = Array.isArray(o.markerRepos) ? o.markerRepos : [];

  // name -> sorted array of normalized paths. A duplicate basename (e.g.
  // `apps/norns` and `services/norns`, the exact case `forge-repo-index.js`'s
  // own doc comment cites as real on the operator's disk) is the DEFAULT
  // case here, not exotic — registry-side names come from
  // `path.basename(repoAbs)` and `deriveMarkerFromRegistry` derives the same
  // way. Collapsing to a single `name -> path` `Map` (the previous shape)
  // let a second same-named row silently overwrite the first, so a marker
  // that dropped or rewrote one of two same-named repos compared CLEAN —
  // exactly the silent-divergence hole this guard exists to close.
  const byNameRegistry = new Map();
  for (const r of registryRepos) {
    const list = byNameRegistry.get(r.name) || [];
    list.push(normalizePath(r.path));
    byNameRegistry.set(r.name, list);
  }
  const byNameMarker = new Map();
  for (const m of markerRepos) {
    const list = byNameMarker.get(m.name) || [];
    list.push(normalizePath(m.path));
    byNameMarker.set(m.name, list);
  }

  const names = new Set([...byNameRegistry.keys(), ...byNameMarker.keys()]);
  const sortedNames = Array.from(names).sort();

  const diffs = [];
  for (const name of sortedNames) {
    const regPaths = (byNameRegistry.get(name) || []).slice().sort();
    const mkPaths = (byNameMarker.get(name) || []).slice().sort();

    if (regPaths.length && !mkPaths.length) {
      for (const p of regPaths) {
        diffs.push({ name, kind: 'missing-in-marker', registry_path: p, marker_path: null });
      }
      continue;
    }
    if (!regPaths.length && mkPaths.length) {
      for (const p of mkPaths) {
        diffs.push({ name, kind: 'missing-in-registry', registry_path: null, marker_path: p });
      }
      continue;
    }

    // Present on both sides — compare as multisets of normalized paths.
    // A path present on one side but not the other (by exact multiset
    // membership, accounting for repeats) is reported; only paths that
    // pair up cleanly are considered consistent. This is what makes two
    // same-named repos at different paths comparable without either one
    // masking the other.
    const mkRemaining = mkPaths.slice();
    const unmatchedReg = [];
    for (const p of regPaths) {
      const idx = mkRemaining.indexOf(p);
      if (idx === -1) unmatchedReg.push(p);
      else mkRemaining.splice(idx, 1);
    }
    // `unmatchedReg` / `mkRemaining` now hold, respectively, registry and
    // marker paths for this name with no counterpart on the other side.
    // Pair them up as `path-mismatch` while both remain (the common case —
    // same name, different path); any leftover on just one side is reported
    // with the other half null, honestly reflecting that no candidate paired.
    const pairCount = Math.max(unmatchedReg.length, mkRemaining.length);
    for (let i = 0; i < pairCount; i++) {
      const registryPathVal = unmatchedReg[i] || null;
      const markerPathVal = mkRemaining[i] || null;
      const kind = registryPathVal && !markerPathVal
        ? 'missing-in-marker'
        : !registryPathVal && markerPathVal
          ? 'missing-in-registry'
          : 'path-mismatch';
      diffs.push({ name, kind, registry_path: registryPathVal, marker_path: markerPathVal });
    }
  }

  return { ok: diffs.length === 0, diffs };
}

// ── auditWorkspaces — impure gatherer ───────────────────────────────────────
/**
 * Confront the registry against the on-disk marker, per workspace.
 *
 * @param {object} opts
 * @param {string} opts.home          - home dir (required, never implicit)
 * @param {string} [opts.registryFile] - override registry path (default: registryPath(home))
 * @param {string} [opts.cwd]         - reserved for symmetry with other CLIs; unused here
 *                                      (audit walks ALL workspaces in the registry, not one cwd)
 * @returns {{ ok: true, file: string, workspaces: Array<object>, skipped?: string }}
 */
function auditWorkspaces(opts) {
  const o = opts || {};
  const home = o.home;
  if (typeof home !== 'string' || home.length === 0) {
    throw new Error('forge-workspace-consistency: home must be a non-empty string');
  }
  const file = o.registryFile || registryPath(home);

  // eslint-disable-next-line global-require
  const { findMarker, readMarker } = require('./forge-marker.js');

  let registry;
  try {
    registry = loadRegistry(file, { home });
  } catch (e) {
    // Registry unreadable — there is nothing authoritative to confront the
    // marker against. This is not itself a divergence; report it plainly and
    // audit nothing. Advisory posture still applies at the CLI layer.
    return { ok: true, file, workspaces: [], skipped: `registry unreadable: ${e.message}` };
  }
  if (!registry) {
    return { ok: true, file, workspaces: [], skipped: 'registry absent' };
  }

  const results = [];

  for (const e of registry.entries || []) {
    const repos = Array.isArray(e.repos) ? e.repos : [];
    if (repos.length === 0) continue; // only indexed workspaces can have a marker worth confronting

    const abs = e.abs;
    const registryRepos = repos.map((rel) => {
      const relNorm = rel === '' || rel === '.' ? '.' : rel;
      const repoAbs = relNorm === '.' ? abs : path.resolve(abs, relNorm.split('/').join(path.sep));
      return { name: path.basename(repoAbs), path: repoAbs };
    });

    // Marker lookup is scoped to THIS workspace's own directory — never walks
    // up. `stopAt: abs` makes `findMarker` check `abs` and, finding nothing,
    // stop there instead of climbing toward an ancestor's marker that would
    // answer a different question ("who governs this cwd").
    let found;
    try {
      found = findMarker(abs, { stopAt: abs });
    } catch (_) {
      found = null;
    }

    if (!found) {
      results.push({ workspace: abs, status: 'no-marker', diffs: [] });
      continue;
    }

    let data;
    try {
      data = readMarker(found.file);
    } catch (err) {
      results.push({ workspace: abs, status: 'marker-unreadable', diffs: [], error: err.message, file: found.file });
      continue;
    }

    const markerRepos = data.repos.map((r) => ({ name: r.name, path: r.path }));
    const cmp = compareSources({ workspace: abs, registryRepos, markerRepos });
    results.push({
      workspace: abs,
      status: cmp.ok ? 'ok' : 'divergent',
      diffs: cmp.diffs,
      file: data.file,
    });
  }

  return { ok: true, file, workspaces: results };
}

// ── module.exports ──────────────────────────────────────────────────────────
module.exports = {
  compareSources,
  auditWorkspaces,
};

// ── CLI ──────────────────────────────────────────────────────────────────
const USAGE = [
  'uso: node scripts/forge-workspace-consistency.js --check [--json]',
  '     [--home <dir>] [--file <path>] [--cwd <dir>]',
  '',
  'Guard advisory (D3): confronta o registry (~/.claude) contra o marcador em',
  'disco de cada workspace indexado. SEMPRE sai com exit 0 — divergência é',
  'relatada, nunca bloqueia.',
].join('\n');

function parseArgs(argv) {
  const out = { check: false, json: false, home: null, file: null, cwd: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--home') { out.home = argv[++i]; }
    else if (a === '--file') { out.file = argv[++i]; }
    else if (a === '--cwd') { out.cwd = argv[++i]; }
  }
  return out;
}

function formatHuman(result) {
  const lines = [];
  const divergent = result.workspaces.filter((w) => w.status === 'divergent');
  const unreadable = result.workspaces.filter((w) => w.status === 'marker-unreadable');
  const noMarker = result.workspaces.filter((w) => w.status === 'no-marker');
  const ok = result.workspaces.filter((w) => w.status === 'ok');

  if (result.skipped) {
    lines.push(`forge-workspace-consistency: ${result.skipped} — nada a confrontar.`);
    return lines.join('\n');
  }

  lines.push(`forge-workspace-consistency: ${result.workspaces.length} workspace(s) indexado(s) verificado(s).`);

  for (const w of divergent) {
    lines.push(`  ⚠ divergência em ${w.workspace}:`);
    for (const d of w.diffs) {
      const reg = d.registry_path || '(ausente)';
      const mk = d.marker_path || '(ausente)';
      lines.push(`      - ${d.name} [${d.kind}] registry=${reg} marcador=${mk}`);
    }
  }
  for (const w of unreadable) {
    lines.push(`  ✗ marcador ilegível: ${w.file || '(?)'} (${w.error})`);
  }
  if (ok.length) lines.push(`  ✓ ${ok.length} workspace(s) consistente(s) com seu marcador.`);
  if (noMarker.length) lines.push(`  · ${noMarker.length} workspace(s) sem marcador (não é divergência).`);

  return lines.join('\n');
}

function main(argv) {
  const args = parseArgs(argv);

  if (args.help || !args.check) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const home = args.home ? path.resolve(args.home) : (process.env.HOME || process.env.USERPROFILE || '');
  if (!home) {
    process.stderr.write('forge-workspace-consistency: sem HOME — use --home\n');
    // Even a usage problem stays advisory-shaped here: this CLI's contract is
    // "never fail the run" (D3). We still signal via stderr/return code so a
    // human notices, but callers that shell out to `--check all` in
    // forge-doctor must not have their own exit code flipped by this.
    return 0;
  }
  const registryFile = args.file ? path.resolve(args.file) : registryPath(home);
  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();

  const result = auditWorkspaces({ home, registryFile, cwd });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatHuman(result)}\n`);
  }

  // process.exit(0) UNCONDITIONALLY — D3 mandates this guard is advisory.
  // Divergence is information for a human, never a reason to fail a run.
  // Do NOT change this to reflect `result.workspaces.some(w => w.status ===
  // 'divergent')` — that would turn an advisory guard into a blocking one,
  // exactly the drift D3 warns against.
  return 0;
}

module.exports.main = main;
module.exports.parseArgs = parseArgs;
module.exports.USAGE = USAGE;

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
