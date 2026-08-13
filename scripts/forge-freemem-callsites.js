#!/usr/bin/env node
'use strict';

/**
 * forge-freemem-callsites.js — an in-process scanner that turns the absence
 * of `os.freemem()` call sites in `scripts/` into a verifiable fact, in the
 * mold of `scripts/forge-exec-callsites.js` / `scripts/forge-doc-claims.js`.
 *
 * WHY IN-PROCESS, NEVER SHELL-OUT: this environment's `grep` is a shell
 * function wrapping `ugrep --ignore-files`, which honors `.gitignore` — a
 * `grep` that returns empty can mean "genuinely absent" or "the file is
 * gitignored and was never read". Proof of absence has to be made by reading
 * files with `fs` directly.
 *
 * WHY THIS SCANNER EXISTS (D1, non-revisable): `os.freemem()` lied under
 * saturated swap, measured on this repo's own resource-control milestone. It
 * is banned as an admission signal anywhere in `scripts/`. `os.totalmem()` is
 * capacity, not pressure — deliberately NOT banned, or legitimate capacity
 * reads would false-positive.
 *
 * ANTI-SILENCE FLOOR — B3, the property this whole file exists to get right.
 * `os.freemem()` currently has ZERO occurrences in `scripts/` (measured) —
 * so a clean scan finding zero matches is the HEALTHY state, not a failure.
 * The floor therefore keys on FILES SCANNED, never on matches found:
 *   - `scanned === 0` ⇒ `outcome: 'anti-silence'`, a reason distinct from
 *     both "0 violations found" (clean) and "found violations" — never a
 *     clean pass, and never confused with either of the other two outcomes.
 *   - `scanned > 0` and no violations ⇒ `outcome: 'clean'`.
 *   - `scanned > 0` and violations found ⇒ `outcome: 'violations'`.
 * Getting this backwards produces either a gate that is red from birth (keys
 * on matches>0 ⇒ fail) or a gate indistinguishable from a scanner that
 * walked nothing (keys on matches===0 ⇒ pass, even with scanned===0). This
 * repo has shipped that exact defect before (a scanner blind to its own
 * target word; a grep honoring `.gitignore` and sweeping nothing) — hence
 * the anti-silence floor is asserted bidirectionally by the paired test.
 *
 * PREDICATE — what counts as a forbidden call site (patterns are built by
 * string concatenation below so this file does not self-accuse):
 *   1. `qualified` — `os.freemem(` (member-expression call).
 *   2. `destructured` — `const { freemem } = require('os')` /
 *      `require('node:os')` (destructuring assignment), followed anywhere
 *      later in the file by a bare `freemem(` call. File-scoped, not a line
 *      window — the destructuring and the call can be on different lines.
 * Scope is deliberately narrow: `os.totalmem()` is untouched (D1 bans
 * freemem-as-admission-signal, not capacity reads).
 *
 * SELF-EXCLUSION — explicit and enumerated, not an invisible skip. This
 * scanner and its paired test both CONTAIN the forbidden patterns (as regex
 * source / fixture strings) and are excluded by basename, recorded in
 * `skipped[]` with reason `self-fixture` — never silently dropped.
 *
 * A second, distinct exclusion class: `forge-resources.test.js` (T01's
 * test suite) contains the line
 * `assert(!/os\.freemem\(/.test(src), 'forge-resources.js never calls
 * os.freemem()')` — a self-referential assertion that PROVES the absence of
 * the call, not a call site itself. Text-matching cannot tell "this line
 * calls os.freemem()" apart from "this line is a string/regex literal
 * asserting that nothing else does" without a real JS parser, which this
 * scanner deliberately does not carry (D-none: no new parse dependency for
 * one file). Rather than weaken the ban (unacceptable — it would let a real
 * call site through) or delete the D1 guard in the test (load-bearing), the
 * file is named in a SECOND closed exclusion set with its own reason
 * (`self-referential-assertion`, distinct from `self-fixture`) — still
 * counted and enumerated in `skipped[]`, never silently dropped.
 *
 * CENSUS, NOT VERDICT-ONLY: the scan always reports `scanned` (files
 * actually read) alongside the verdict. Every file the walk encounters but
 * does not scan (wrong extension, unreadable, this scanner's own fixture
 * files) is recorded in `skipped[{path, reason}]` with a reason drawn from a
 * CLOSED enum — never silently dropped.
 */

const fs = require('fs');
const path = require('path');

// ── Closed enum of skip reasons — never invent a new string inline ─────────

const SKIP_REASONS = Object.freeze({
  EXTENSION_NOT_SCANNED: 'extension-not-scanned',
  UNREADABLE: 'unreadable',
  SELF_FIXTURE: 'self-fixture',
  SELF_REFERENTIAL_ASSERTION: 'self-referential-assertion',
  ROOT_NOT_FOUND: 'root-not-found',
});

// ── Closed enum of violation forms ──────────────────────────────────────────

const VIOLATION_FORMS = Object.freeze({
  QUALIFIED: 'qualified',       // os.freemem(
  DESTRUCTURED: 'destructured', // const { freemem } = require('os'); ... freemem(
});

const DEFAULT_ROOT = 'scripts';
const SCANNED_EXTENSIONS = Object.freeze(['.js']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'fixtures']);

// This scanner and its paired suite deliberately CONTAIN the forbidden
// pattern (as regex source and as fixture strings) — self-matching would be
// permanent, unfixable noise, never a real violation. Excluded on basename.
const SELF_FIXTURE_BASENAMES = new Set([
  'forge-freemem-callsites.js',
  'forge-freemem-callsites.test.js',
]);

// A separate, distinct exclusion set (see SELF-EXCLUSION doc above): files
// whose only match is a self-referential assertion proving the ban, not a
// real call site. Kept apart from SELF_FIXTURE_BASENAMES so the two reasons
// never collapse into one — a future reader must be able to tell "this
// scanner's own fixture" from "a consumer's proof-of-absence test" by
// reason alone.
const SELF_REFERENTIAL_ASSERTION_BASENAMES = new Set([
  'forge-resources.test.js',
]);

// Built by concatenation so this file's own source does not contain the
// literal call it forbids.
const OS_WORD = 'os';
const FREE = 'free' + 'mem';
const QUALIFIED_RE = new RegExp('\\b' + OS_WORD + '\\.' + FREE + '\\s*\\(');
const DESTRUCTURE_RE = new RegExp(
  '(?:const|let|var)\\s*\\{[^}]*\\b' + FREE + '\\b[^}]*\\}\\s*=\\s*require\\(\\s*[\'"]node:' + OS_WORD + '[\'"]\\s*\\)'
  + '|(?:const|let|var)\\s*\\{[^}]*\\b' + FREE + '\\b[^}]*\\}\\s*=\\s*require\\(\\s*[\'"]' + OS_WORD + '[\'"]\\s*\\)'
);
const BARE_CALL_RE = new RegExp('\\b' + FREE + '\\s*\\(');

function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

// ── collectFiles — impure, in-process walk under a single root, no shell ───

function collectFiles(rootDir) {
  const files = [];
  const skipped = [];

  let rootStat;
  try {
    rootStat = fs.statSync(rootDir);
  } catch {
    skipped.push({ path: rootDir, reason: SKIP_REASONS.ROOT_NOT_FOUND });
    return { files, skipped };
  }
  if (!rootStat.isDirectory()) {
    skipped.push({ path: rootDir, reason: SKIP_REASONS.ROOT_NOT_FOUND });
    return { files, skipped };
  }

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped.push({ path: dir, reason: SKIP_REASONS.UNREADABLE });
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      if (SELF_FIXTURE_BASENAMES.has(entry.name)) {
        skipped.push({ path: full, reason: SKIP_REASONS.SELF_FIXTURE });
        continue;
      }

      if (SELF_REFERENTIAL_ASSERTION_BASENAMES.has(entry.name)) {
        skipped.push({ path: full, reason: SKIP_REASONS.SELF_REFERENTIAL_ASSERTION });
        continue;
      }

      const ext = path.extname(entry.name);
      if (!SCANNED_EXTENSIONS.includes(ext)) {
        skipped.push({ path: full, reason: SKIP_REASONS.EXTENSION_NOT_SCANNED });
        continue;
      }

      files.push(full);
    }
  }

  walk(rootDir);
  return { files, skipped };
}

// ── classifyFile — pure, testable with in-memory fixtures ──────────────────
//
// `record` is `{ path, content }` (in-memory, for fixtures) or a plain path
// string (read from disk).
//
// Returns `{ scanned: 0|1, unreadable, violations: [...] }`.

function classifyFile(record) {
  const filePath = typeof record === 'string' ? record : record.path;
  let content;
  if (typeof record === 'object' && typeof record.content === 'string') {
    content = record.content;
  } else {
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return { scanned: 0, unreadable: true, violations: [] };
    }
  }

  const lines = content.split('\n');
  const violations = [];

  let sawDestructure = false;
  let destructureLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;

    if (QUALIFIED_RE.test(line)) {
      violations.push({ file: filePath, line: i + 1, form: VIOLATION_FORMS.QUALIFIED, text: line.trim() });
    }

    if (DESTRUCTURE_RE.test(line)) {
      sawDestructure = true;
      destructureLine = i + 1;
    }
  }

  // Second pass: a destructured `freemem` used anywhere later (file-scoped,
  // not line-windowed) as a bare call.
  if (sawDestructure) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      if (BARE_CALL_RE.test(line)) {
        violations.push({
          file: filePath,
          line: i + 1,
          form: VIOLATION_FORMS.DESTRUCTURED,
          text: line.trim(),
          destructuredAt: destructureLine,
        });
      }
    }
  }

  return { scanned: 1, unreadable: false, violations };
}

// ── scanFreemem — the public entry point ────────────────────────────────────
//
// `roots` — array of directory paths (resolved by caller), or an array of
// `{ path, content }` file records for in-memory fixtures when
// `opts.inMemory` is true.
//
// Returns:
//   { outcome: 'clean' | 'violations' | 'anti-silence',
//     scanned, violations: [{file, line, form, text}],
//     skipped: [{path, reason}], reason }

function scanFreemem(roots, opts) {
  opts = opts || {};
  let fileRecords = [];
  const skipped = [];

  if (opts.inMemory) {
    fileRecords = Array.isArray(roots) ? roots : [];
  } else {
    const rootList = Array.isArray(roots) && roots.length > 0 ? roots : [DEFAULT_ROOT];
    for (const root of rootList) {
      const { files, skipped: rootSkipped } = collectFiles(root);
      fileRecords = fileRecords.concat(files);
      skipped.push(...rootSkipped);
    }
  }

  let scanned = 0;
  const violations = [];

  for (const record of fileRecords) {
    const result = classifyFile(record);
    if (result.unreadable) {
      const p = typeof record === 'string' ? record : record.path;
      skipped.push({ path: p, reason: SKIP_REASONS.UNREADABLE });
      continue;
    }
    scanned += result.scanned;
    violations.push(...result.violations);
  }

  let outcome;
  let reason = null;
  if (scanned === 0) {
    outcome = 'anti-silence';
    reason = 'anti-silence-floor: scanned 0 files — indistinguishable from a broken detector';
  } else if (violations.length > 0) {
    outcome = 'violations';
    reason = `${violations.length} os.freemem() call site(s) found`;
  } else {
    outcome = 'clean';
  }

  return { outcome, scanned, violations, skipped, reason };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { check: false, json: false, roots: [], cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--json') out.json = true;
    else if (a === '--root') out.roots.push(argv[++i]);
    else if (a === '--cwd') out.cwd = argv[++i];
    else {
      process.stderr.write(`forge-freemem-callsites: unknown argument '${a}'\n`);
      process.exit(2);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.check) {
    process.stderr.write('forge-freemem-callsites: usage: forge-freemem-callsites.js --check [--json] [--root <dir> ...] [--cwd <dir>]\n');
    process.exit(2);
  }

  const roots = args.roots.length > 0
    ? args.roots.map((r) => path.resolve(args.cwd, r))
    : [path.resolve(args.cwd, DEFAULT_ROOT)];

  const result = scanFreemem(roots);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`scanned: ${result.scanned}, outcome: ${result.outcome}`);
    if (result.violations.length > 0) {
      for (const v of result.violations) {
        console.log(`  VIOLATION [${v.form}] ${v.file}:${v.line} ${v.text}`);
      }
    }
    if (result.reason) {
      console.log(`  reason: ${result.reason}`);
    }
    if (result.skipped.length > 0) {
      console.log(`  ${result.skipped.length} file(s)/root(s) skipped (see --json for reasons)`);
    }
  }

  process.exitCode = result.outcome === 'clean' ? 0 : (result.outcome === 'anti-silence' ? 2 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  SKIP_REASONS,
  VIOLATION_FORMS,
  DEFAULT_ROOT,
  SCANNED_EXTENSIONS,
  SELF_FIXTURE_BASENAMES,
  SELF_REFERENTIAL_ASSERTION_BASENAMES,
  collectFiles,
  classifyFile,
  scanFreemem,
};
