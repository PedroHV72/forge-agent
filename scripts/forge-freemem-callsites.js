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
 * MATCHING IS WHOLE-CONTENT, NOT LINE-BY-LINE (R4/R5, S01 review-fix): a
 * per-line regex test is evadable by putting whitespace between `os`, `.`,
 * and `freemem`, or by splitting the member access across a line break.
 * Both call-site regexes are matched against the FULL FILE CONTENT (after
 * string/comment stripping — see below), with a whitespace-tolerant
 * pattern, so neither evasion works.
 *
 * STRING/COMMENT BLINDNESS FOR CALL SITES (R8, S01 review-fix): a match
 * landing inside a string literal or a comment (line, block, or inline
 * trailing) must not be flagged as a real call site — see
 * `stripStringsAndComments` below. This is in tension with R4/R5 (every
 * layer added to avoid false positives is a layer where a real call could
 * get masked); the operator's explicit tie-break is that false-negative
 * safety (R4/R5) wins over false-positive noise (R8) if the two cannot both
 * hold. They are proven to hold simultaneously by a dedicated test: a
 * genuine call adjacent to, and on the same line as, a string and a comment
 * containing the same text is still caught.
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
 * R6 (operator-arbitrated, S01 review-fix): this exclusion originally
 * matched by BASENAME ALONE — any file anywhere named
 * `forge-resources.test.js` was excluded, a pattern-wide blind spot. It is
 * now an EXACT path check (directory AND basename both checked:
 * `scripts/forge-resources.test.js`), narrowing the surface from "any file
 * with this name" to "one specific, known, enumerated file". This does not
 * close the core hole (that one file is still blind to a genuine call site
 * smuggled into it) — that is a deliberate, named trade-off, not an
 * oversight. No parser was added.
 *
 * CENSUS, NOT VERDICT-ONLY: the scan always reports `scanned` (files
 * actually read) alongside the verdict. Every file/dir the walk encounters
 * but does not scan (wrong extension, unreadable, this scanner's own
 * fixture files, VCS/dependency dirs, `fixtures/` dirs) is recorded in
 * `skipped[{path, reason}]` with a reason drawn from a CLOSED enum — never
 * silently dropped. (R7, S01 review-fix: `fixtures/` dirs were previously
 * skipped via `SKIP_DIRS` with no census entry at all — a real, contentful
 * skip contradicting this module's own documented contract. Every
 * `SKIP_DIRS` hit is now recorded, with `fixtures/` carrying its own
 * distinct named reason so the exemption is a decision on record, not an
 * omission.)
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
  // R7: `fixtures` dirs hold real, readable .js files — a distinct named
  // reason from the generic VCS/dependency dir skip below, so the
  // exemption is a decision on record, not an omission.
  FIXTURES_DIR_EXCLUDED: 'fixtures-dir-excluded',
  // .git / node_modules — never source we own; still recorded (R7: "record
  // every SKIP_DIRS hit with a closed named reason", not just fixtures).
  VCS_OR_DEPENDENCY_DIR_EXCLUDED: 'vcs-or-dependency-dir-excluded',
});

// ── Closed enum of violation forms ──────────────────────────────────────────

const VIOLATION_FORMS = Object.freeze({
  QUALIFIED: 'qualified',       // os.freemem(
  DESTRUCTURED: 'destructured', // const { freemem } = require('os'); ... freemem(
});

const DEFAULT_ROOT = 'scripts';
const SCANNED_EXTENSIONS = Object.freeze(['.js']);
// 'fixtures' is intentionally NOT in this set — it is checked and recorded
// separately, with its own reason (FIXTURES_DIR_EXCLUDED), so the exemption
// is explicit rather than folded into the generic VCS/dependency skip.
const SKIP_DIRS = new Set(['.git', 'node_modules']);

// This scanner and its paired suite deliberately CONTAIN the forbidden
// pattern (as regex source and as fixture strings) — self-matching would be
// permanent, unfixable noise, never a real violation. Excluded on basename.
const SELF_FIXTURE_BASENAMES = new Set([
  'forge-freemem-callsites.js',
  'forge-freemem-callsites.test.js',
]);

// See R6 doc above — exact path exclusion, not basename-wide.
const SELF_REFERENTIAL_ASSERTION_EXACT_PATHS = new Set([
  path.join('scripts', 'forge-resources.test.js'),
]);

function isSelfReferentialAssertionFile(dir, name) {
  if (name !== 'forge-resources.test.js') return false;
  return path.basename(dir) === 'scripts';
}

// Built by concatenation so this file's own source does not contain the
// literal call it forbids.
const OS_WORD = 'os';
const FREE = 'free' + 'mem';
// R4: whitespace-tolerant between `os`, the `.`, and `freemem` — a reader
// (and a formatter) can legally write `os . freemem()` or split the member
// access across a line break; the ban must not be evadable by whitespace.
const QUALIFIED_RE_SRC = '\\b' + OS_WORD + '\\s*\\.\\s*' + FREE + '\\s*\\(';
const DESTRUCTURE_RE_SRC =
  '(?:const|let|var)\\s*\\{[^}]*\\b' + FREE + '\\b[^}]*\\}\\s*=\\s*require\\(\\s*[\'"]node:' + OS_WORD + '[\'"]\\s*\\)'
  + '|(?:const|let|var)\\s*\\{[^}]*\\b' + FREE + '\\b[^}]*\\}\\s*=\\s*require\\(\\s*[\'"]' + OS_WORD + '[\'"]\\s*\\)';
const BARE_CALL_RE_SRC = '\\b' + FREE + '\\s*\\(';

// ── R4/R5/R8 — whole-content matching, string/comment-blind, never
// whitespace-evadable ──────────────────────────────────────────────────────
//
// Two properties this scanner must hold AT THE SAME TIME, and the tension
// between them is the entire point:
//   R4/R5 (false-negative safety): matching must run against the FULL FILE
//     CONTENT, not line-by-line — `os . freemem()`, `os\n  .freemem()`, and
//     a multiline destructure+call pair must all be caught.
//   R8 (false-positive noise): a match landing inside a string literal or a
//     comment (line or block, including an inline trailing comment) must
//     NOT be flagged.
// Per the operator's explicit tie-break: every layer added for R8 is a
// layer where a REAL call could get masked. If the two properties cannot
// both hold, R4/R5 (safety) wins over R8 (noise) — see the paired test
// `a genuine call adjacent to a string and a comment on one line is still
// caught` below, which is the assert proving they DO both hold here.
//
// `stripStringsAndComments` walks the content once, character by character,
// and replaces every character inside a string/template literal or a
// comment with a space (newlines are preserved as newlines) — so byte
// OFFSETS and LINE NUMBERS in the stripped text still line up with the
// original file, and regex matching against the stripped text can never see
// into a string or comment, no matter how the call is split across
// whitespace.
//
// `keepStrings` — when true, string/template literal CONTENT (and its
// quotes) is passed through unmodified; only comments are blanked. This is
// used for the DESTRUCTURE_RE pass: `require('os')` / `require('node:os')`
// legitimately needs its literal quotes to match, and that quoted module
// name is structural code, not free-form prose the R8 masking rule is
// aimed at. Call-site detection (QUALIFIED_RE / BARE_CALL_RE) always uses
// `keepStrings: false` — those are the patterns R8 is about.
function stripStringsAndComments(content, keepStrings) {
  let out = '';
  const n = content.length;
  let i = 0;
  while (i < n) {
    const c = content[i];
    const c2 = i + 1 < n ? content[i + 1] : '';

    // Line comment: // ... to end of line.
    if (c === '/' && c2 === '/') {
      while (i < n && content[i] !== '\n') { out += ' '; i++; }
      continue;
    }

    // Block comment: /* ... */ (may span multiple lines).
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(content[i] === '*' && i + 1 < n && content[i + 1] === '/')) {
        out += content[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }

    // String / template literal: '...', "...", `...` — backslash escapes
    // (including an escaped newline) are consumed without ending the
    // literal early.
    if (c === '"' || c === '\'' || c === '`') {
      const quote = c;
      out += keepStrings ? c : ' ';
      i++;
      while (i < n && content[i] !== quote) {
        if (content[i] === '\\' && i + 1 < n) {
          out += keepStrings ? content[i] : (content[i] === '\n' ? '\n' : ' ');
          i++;
          out += keepStrings ? content[i] : (content[i] === '\n' ? '\n' : ' ');
          i++;
          continue;
        }
        out += keepStrings ? content[i] : (content[i] === '\n' ? '\n' : ' ');
        i++;
      }
      if (i < n) { out += keepStrings ? content[i] : ' '; i++; } // closing quote
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

// 1-indexed line number of a byte offset into `text` (works for both the
// original content and either stripped variant — they are the same length
// with the same newline positions).
function lineNumberAtOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function lineTextAt(content, lineNumber) {
  const lines = content.split('\n');
  return (lines[lineNumber - 1] || '').trim();
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
        if (entry.name === 'fixtures') {
          skipped.push({ path: full, reason: SKIP_REASONS.FIXTURES_DIR_EXCLUDED });
          continue;
        }
        if (SKIP_DIRS.has(entry.name)) {
          skipped.push({ path: full, reason: SKIP_REASONS.VCS_OR_DEPENDENCY_DIR_EXCLUDED });
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      if (SELF_FIXTURE_BASENAMES.has(entry.name)) {
        skipped.push({ path: full, reason: SKIP_REASONS.SELF_FIXTURE });
        continue;
      }

      if (isSelfReferentialAssertionFile(dir, entry.name)) {
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

  const violations = [];
  // Call-site detection (R8): strings AND comments blanked — these are the
  // patterns the false-positive-noise rule is about.
  const strippedForCalls = stripStringsAndComments(content, false);
  // Destructure declaration detection: only comments blanked. The quoted
  // module name (`'os'` / `'node:os'`) is structural code the pattern needs
  // to match literally — not prose R8 is aimed at.
  const strippedForDestructure = stripStringsAndComments(content, true);

  // ── Qualified form: os.freemem( — whitespace-tolerant, whole-content ────
  const qualifiedRe = new RegExp(QUALIFIED_RE_SRC, 'g');
  let m;
  while ((m = qualifiedRe.exec(strippedForCalls)) !== null) {
    const line = lineNumberAtOffset(strippedForCalls, m.index);
    violations.push({ file: filePath, line, form: VIOLATION_FORMS.QUALIFIED, text: lineTextAt(content, line) });
    if (m[0].length === 0) qualifiedRe.lastIndex++; // guard against zero-width infinite loop
  }

  // ── Destructured form: const { freemem } = require('os') ... freemem() ──
  // File-scoped, not line-windowed — the declaration and the bare call can
  // be arbitrarily far apart, including across a line boundary.
  const destructureRe = new RegExp(DESTRUCTURE_RE_SRC);
  const dMatch = destructureRe.exec(strippedForDestructure);
  const sawDestructure = dMatch !== null;
  const destructureLine = sawDestructure ? lineNumberAtOffset(strippedForDestructure, dMatch.index) : -1;

  if (sawDestructure) {
    const bareCallRe = new RegExp(BARE_CALL_RE_SRC, 'g');
    while ((m = bareCallRe.exec(strippedForCalls)) !== null) {
      const line = lineNumberAtOffset(strippedForCalls, m.index);
      violations.push({
        file: filePath,
        line,
        form: VIOLATION_FORMS.DESTRUCTURED,
        text: lineTextAt(content, line),
        destructuredAt: destructureLine,
      });
      if (m[0].length === 0) bareCallRe.lastIndex++;
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
  SELF_REFERENTIAL_ASSERTION_EXACT_PATHS,
  collectFiles,
  classifyFile,
  scanFreemem,
};
