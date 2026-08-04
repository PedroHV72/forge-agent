#!/usr/bin/env node
'use strict';

// forge-marker.js — an on-disk fallback address for `resolveRepoName` when the
// registry in `~/.claude/` is not available at all.
//
// ── D3, and why this file exists ────────────────────────────────────────────
//
// Milestone decision D3 (LOCKED): the registry is AUTHORITATIVE. This marker
// is the FALLBACK, used only in contexts where the registry cannot be
// consulted in the first place — CI, a container, a fresh machine that never
// ran `forge-workspace.js --sync-repos`. It is not a second opinion; it is a
// substitute for a missing first opinion.
//
// The precedence rule this module exists to serve, stated once so nobody
// re-derives it wrong while wiring the fallback in `forge-repo-index.js`:
//
//   1. Registry present, even with zero matching entries → the answer is
//      `unknown`. A marker sitting on disk next to an empty registry is NEVER
//      consulted — "the registry has nothing to say" and "the registry does
//      not exist" are different facts, and only the second one is a fallback
//      trigger. Collapsing them back together is exactly the silent
//      divergence this milestone exists to close (see `I-20260803025613`).
//   2. Registry present and disagreeing with the marker → the registry wins,
//      full stop. The marker is never consulted to arbitrate; comparing the
//      two and reporting a mismatch is a different task (T04), not this one.
//   3. Registry absent (file does not exist) or unreadable (corrupt JSON, I/O
//      error) → THIS is the only door the marker walks through.
//
// This module itself does not implement precedence — that lives in
// `buildRepoIndex` (`forge-repo-index.js`), which is the only caller allowed
// to decide "the registry failed me, try the marker". This module only
// answers two narrower questions: "is there a marker file reachable from
// here", and "what does it say".
//
// ── Format ───────────────────────────────────────────────────────────────
//
// JSONC: plain JSON plus `//` line comments, `/* */` block comments, and a
// trailing comma before `}`/`]`. The parser below is a small state machine,
// not a regex sweep — a bare regex over `//` would mangle
// `"url": "https://example.com"`, and that exact string is one of the tests.
//
// A marker file describes ONE workspace (or ONE standalone project, `kind:
// "root"`) — the same granularity as a single registry entry, not the whole
// registry. `MARKER_FILENAMES` lists both accepted names, in precedence
// order: `forge-workspace.jsonc` is preferred over `forge-root.jsonc` when a
// directory somehow has both.
//
//   {
//     "kind": "workspace",           // or "root"
//     "name": "lookchina",
//     "repos": [
//       { "name": "freyr", "path": "services/freyr" },
//       { "name": "lookchina", "path": "." }
//     ]
//   }
//
// `repos[].path` is marker-relative (same portability discipline the
// registry itself uses for its own `repos[]` — see `forge-workspace.js`).
// `readMarker` resolves each one to an absolute path against the marker's own
// directory; nothing downstream ever has to know the file was relative.
//
// Zero deps. CommonJS. Library exports + `require.main` CLI.

const fs = require('fs');
const path = require('path');

const { isStrictlyUnder } = require('./forge-workspace.js');

// ── constants ────────────────────────────────────────────────────────────

/**
 * Accepted marker filenames, in precedence order. `findMarker` checks a
 * directory for `forge-workspace.jsonc` before `forge-root.jsonc` — a
 * workspace marker describing several repos is preferred over a root marker
 * describing one, when (unusually) a directory carries both.
 */
const MARKER_FILENAMES = ['forge-workspace.jsonc', 'forge-root.jsonc'];

const MARKER_KINDS = ['workspace', 'root'];

// ── JSONC codec ──────────────────────────────────────────────────────────

/**
 * Strip `//` and `/* *\/` comments and trailing commas from `text`, then
 * `JSON.parse` the result.
 *
 * Implemented as a single-pass state machine tracking "currently inside a
 * double-quoted string" (with escape handling), rather than a global regex.
 * A regex sweep for `//` cannot tell a real comment from a substring inside
 * a string literal — `"url": "https://example.com"` contains `//` and must
 * survive untouched. The state machine simply never looks for comment
 * markers while `inString` is true, so that case is not a special case, it
 * falls out of the design.
 *
 * Trailing commas are removed the same way, in the same pass: a `,` is
 * dropped when the next non-whitespace, non-string character is `}` or `]`.
 */
function parseJsonc(text) {
  const src = String(text == null ? '' : text);
  const n = src.length;
  let out = '';
  let i = 0;
  let inString = false;

  while (i < n) {
    const c = src[i];

    if (inString) {
      out += c;
      if (c === '\\') {
        // Copy the escaped character verbatim without inspecting it — this
        // is what keeps `\"` from being mistaken for the closing quote.
        if (i + 1 < n) {
          out += src[i + 1];
          i += 2;
          continue;
        }
      } else if (c === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }

    if (c === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }

    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2; // consume the closing `*/` (or run off the end — JSON.parse
      // below will report the resulting truncation, which is the correct
      // failure mode for an unterminated block comment)
      continue;
    }

    if (c === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) j += 1;
      if (src[j] === '}' || src[j] === ']') {
        // Trailing comma before a closer — drop the comma, keep the closer
        // for the main loop to emit on its own turn.
        i += 1;
        continue;
      }
    }

    out += c;
    i += 1;
  }

  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`forge-marker: invalid JSONC (${e.message})`);
  }
}

// ── walk-up ──────────────────────────────────────────────────────────────

/**
 * Walk up from `startDir` looking for the first directory that contains one
 * of `MARKER_FILENAMES`. Returns `{ file, dir, name }` for the first hit, or
 * `null` if none is found before reaching the filesystem root (or `stopAt`,
 * if given).
 *
 * `stopAt`, when provided, is still CHECKED (a marker sitting exactly at the
 * boundary counts) — only directories strictly above it are excluded. This
 * mirrors how `forge-workspace.js`'s own walk-up treats its boundary.
 *
 * Never throws: a filesystem that refuses to stat a directory along the way
 * is treated as "no marker there", not as a fatal condition — this function
 * answers "is one reachable", not "is the filesystem healthy".
 */
function findMarker(startDir, opts) {
  const o = opts || {};
  const stopAt = o.stopAt ? path.resolve(o.stopAt) : null;
  let dir = path.resolve(String(startDir == null ? '' : startDir));

  // Guard against handing a file (rather than a directory) as `startDir`.
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) dir = path.dirname(dir);
  } catch (e) {
    // Non-existent start dir: still walk up from wherever it would live —
    // a caller passing a not-yet-created worktree path is not an error here.
    dir = path.dirname(dir) === dir ? dir : dir;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const name of MARKER_FILENAMES) {
      const file = path.join(dir, name);
      let exists = false;
      try {
        exists = fs.statSync(file).isFile();
      } catch (e) {
        exists = false;
      }
      if (exists) return { file, dir, name };
    }

    if (stopAt && dir === stopAt) return null;

    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

// ── read ─────────────────────────────────────────────────────────────────

/**
 * Read and validate a marker file. Throws — with the file's basename and the
 * concrete reason — on anything malformed: unreadable file, invalid JSONC,
 * wrong shape, unknown `kind`, a `repos[]` element missing `path`.
 *
 * This function deliberately never degrades to an empty result. An empty
 * `repos: []` returned in place of a parse failure is indistinguishable from
 * "this workspace genuinely has zero repos" — exactly the confusion class
 * TASK-021 was born from, now on the marker's side of the fallback instead
 * of the sidecar's. A malformed marker must fail loudly enough that the
 * caller (`buildRepoIndex`) has no choice but to propagate it.
 */
function readMarker(file) {
  const base = path.basename(file);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`forge-marker: cannot read ${base}: ${e.message}`);
  }

  let data;
  try {
    data = parseJsonc(text);
  } catch (e) {
    throw new Error(`forge-marker: ${base} is not valid JSONC (${e.message})`);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`forge-marker: ${base} must contain a JSON object at the top level`);
  }

  if (!MARKER_KINDS.includes(data.kind)) {
    throw new Error(
      `forge-marker: ${base} has an invalid "kind" (${JSON.stringify(data.kind)}) — expected "workspace" or "root"`);
  }

  const dir = path.dirname(file);
  const name = typeof data.name === 'string' && data.name.length
    ? data.name
    : path.basename(dir);

  const reposRaw = data.repos == null ? [] : data.repos;
  if (!Array.isArray(reposRaw)) {
    throw new Error(`forge-marker: ${base} "repos" must be an array`);
  }

  const repos = reposRaw.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.path !== 'string') {
      throw new Error(`forge-marker: ${base} repos[${i}] must be an object with a string "path"`);
    }
    const rel = r.path;
    const abs = rel === '' || rel === '.'
      ? dir
      : path.resolve(dir, rel.split('/').join(path.sep));

    // Containment guard — mirrors `resolveEntryPath`'s discipline
    // (forge-workspace.js). `repos[].path` is documented as
    // "marker-relative" and no legitimate marker ever needs to escape its
    // own directory (workspace repos are under the workspace by
    // definition; `deriveMarkerFromRegistry` only ever emits contained
    // relatives). The marker is the LEAST trusted input in this system —
    // it ships inside a cloned repo — so an absolute-or-`..` path that
    // resolves outside `dir` is refused rather than silently indexed.
    if (abs !== dir && !isStrictlyUnder(abs, dir)) {
      throw new Error(
        `forge-marker: ${base} repos[${i}] escapes its own directory (${JSON.stringify(rel)} -> ${abs})`);
    }

    const repoName = typeof r.name === 'string' && r.name.length ? r.name : path.basename(abs);
    return { name: repoName, path: abs };
  });

  return { kind: data.kind, name, repos, file, dir };
}

// ── write ────────────────────────────────────────────────────────────────

/**
 * Serialize `{ kind, name, repos }` with a fixed key order and fixed
 * per-repo key order, 2-space indent, and a trailing newline — the exact
 * shape needed for byte-identical output across repeated writes of the same
 * logical data. `JSON.stringify`'s own key ordering follows insertion order
 * on plain objects, so building `ordered` by hand (rather than sorting an
 * arbitrary input object) is what makes this deterministic without needing a
 * general-purpose "sort object keys" pass.
 */
function serializeMarker(kind, name, repos) {
  const ordered = {
    kind,
    name,
    repos: repos.map((r) => ({ name: String(r.name), path: String(r.path) })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Write a marker into `dir`. `data` is `{ kind, name, repos }` where
 * `repos[].path` is ALREADY marker-relative (this function does not resolve
 * or re-relativize paths — that discipline belongs to the caller, the same
 * way `forge-workspace.js`'s `encodeEntryPath` owns it for the registry).
 *
 * Filename defaults to `MARKER_FILENAMES[0]` (`forge-workspace.jsonc`);
 * `opts.filename` overrides it (used by the suite to exercise the
 * `forge-root.jsonc` precedence case without a second code path).
 *
 * Idempotent by construction: the same `(dir, data)` pair always produces
 * the same bytes, because `serializeMarker` has no hidden inputs (no
 * timestamps, no random ordering) — calling this twice with unchanged `data`
 * writes the same file twice.
 */
function writeMarker(dir, data, opts) {
  const o = opts || {};
  const d = data || {};
  const absDir = path.resolve(String(dir == null ? '' : dir));
  const kind = MARKER_KINDS.includes(d.kind) ? d.kind : 'workspace';
  const name = typeof d.name === 'string' && d.name.length ? d.name : path.basename(absDir);
  const repos = Array.isArray(d.repos) ? d.repos : [];
  const filename = MARKER_FILENAMES.includes(o.filename) ? o.filename : MARKER_FILENAMES[0];

  const text = serializeMarker(kind, name, repos);
  const file = path.join(absDir, filename);
  fs.mkdirSync(absDir, { recursive: true });
  fs.writeFileSync(file, text, 'utf8');

  return { file, dir: absDir, name, kind };
}

// ── derive from registry (CLI convenience) ──────────────────────────────

/**
 * Build the `{ kind, name, repos }` shape `writeMarker` expects, from the
 * registry entry whose absolute path equals `cwd`. This is a CLI-only
 * convenience (`--write-marker` derives its content instead of requiring the
 * operator to hand-author a marker) — it intentionally requires `forge-
 * workspace.js` directly rather than `forge-repo-index.js`, because that
 * module requires THIS one for its fallback; going through it here would be
 * a require cycle for a path that only the CLI needs.
 *
 * Throws when there is no registry to derive from, or no entry matches
 * `cwd` exactly — deriving a marker nobody asked for from the nearest
 * ancestor would silently produce the wrong workspace's data.
 */
function deriveMarkerFromRegistry(home, cwd) {
  const { loadRegistry, registryPath } = require('./forge-workspace.js');
  const file = registryPath(home);

  let registry;
  try {
    registry = loadRegistry(file, { home });
  } catch (e) {
    throw new Error(`forge-marker: cannot derive from registry: ${e.message}`);
  }
  if (!registry) {
    throw new Error(`forge-marker: no registry at ${file} — nothing to derive a marker from`);
  }

  const absCwd = path.resolve(cwd);
  const entry = (registry.entries || []).find((e) => path.resolve(e.abs) === absCwd);
  if (!entry) {
    throw new Error(`forge-marker: no registry entry matches ${absCwd}`);
  }

  const relRepos = Array.isArray(entry.repos) ? entry.repos : [];
  if (relRepos.length) {
    return {
      kind: 'workspace',
      name: path.basename(entry.abs),
      repos: relRepos.map((rel) => {
        const relNorm = rel === '' ? '.' : rel;
        const abs = relNorm === '.'
          ? entry.abs
          : path.resolve(entry.abs, relNorm.split('/').join(path.sep));
        return { name: path.basename(abs), path: relNorm };
      }),
    };
  }

  return {
    kind: 'root',
    name: path.basename(entry.abs),
    repos: [{ name: path.basename(entry.abs), path: '.' }],
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────

const USAGE = [
  'uso: node scripts/forge-marker.js --write-marker [--cwd <dir>] [--home <dir>]',
  '     node scripts/forge-marker.js --read-marker [--cwd <dir>] [--json]',
  '',
  'exit: 0 sucesso | 1 marcador não encontrado / recusado | 2 uso inválido',
].join('\n');

function parseArgs(argv) {
  const out = { write: false, read: false, json: false, cwd: null, home: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write-marker') out.write = true;
    else if (a === '--read-marker') out.read = true;
    else if (a === '--json') out.json = true;
    else if (a === '--cwd') { out.cwd = argv[++i]; if (out.cwd == null) throw new Error('--cwd exige um diretório'); }
    else if (a === '--home') { out.home = argv[++i]; if (out.home == null) throw new Error('--home exige um diretório'); }
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

  if (!args.write && !args.read) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();

  if (args.write) {
    const home = args.home || process.env.HOME || process.env.USERPROFILE || '';
    if (!home) {
      process.stderr.write('forge-marker: sem HOME — use --home\n');
      return 2;
    }
    try {
      const data = deriveMarkerFromRegistry(home, cwd);
      const res = writeMarker(cwd, data);
      process.stdout.write(`${res.file}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
  }

  // --read-marker
  const found = findMarker(cwd);
  if (!found) {
    process.stderr.write(`forge-marker: nenhum marcador encontrado a partir de ${cwd}\n`);
    return 1;
  }
  let data;
  try {
    data = readMarker(found.file);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    process.stdout.write(`${data.file} (${data.kind}: ${data.name})\n`);
    for (const r of data.repos) process.stdout.write(`  ${r.name}\t${r.path}\n`);
  }
  return 0;
}

module.exports = {
  MARKER_FILENAMES,
  MARKER_KINDS,
  parseJsonc,
  findMarker,
  readMarker,
  writeMarker,
  serializeMarker,
  deriveMarkerFromRegistry,
  parseArgs,
  main,
  USAGE,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
