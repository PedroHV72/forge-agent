#!/usr/bin/env node
'use strict';

/**
 * forge-eol-anchors.js -- an in-process, call-site census of source constructs
 * anchored to LF.  This exists because D5's root condition is deliberately
 * still present: this repository has no .gitattributes; core.autocrlf=true is
 * supplied by Git's SYSTEM configuration (C:/Program Files/Git/etc/gitconfig),
 * not by the repository or user configuration; and eol=lf was refused and
 * closed by the maintainer.  A committed scanner, rather than an ignored
 * CLAUDE.md demonstration, is therefore the evidence this class is measured.
 *
 * The scanner uses fs/path only.  It never invokes a shell: a shell boundary
 * could reinterpret the very backslash escapes being audited.  Its unit is a
 * construct, not a file.  A source file can consequently produce several
 * entries, one per matching split/join/regular-expression/boundary operation.
 */

const fs = require('fs');
const path = require('path');

// All skip values are named here.  Callers must use these values, never an
// ad-hoc explanatory string, so the census remains machine-auditable.
const SKIP_REASONS = Object.freeze({
  EXTENSION_NOT_SCANNED: 'extension-not-scanned',
  UNREADABLE: 'unreadable',
  UNPARSEABLE: 'unparseable',
  SELF_FIXTURE: 'self-fixture',
  ROOT_NOT_FOUND: 'root-not-found',
  OUT_OF_SCOPE_DIRECTORY: 'out-of-scope-directory',
  SCOPE_UNDETERMINED: 'scope-undetermined',
});

const ANCHOR_FORMS = Object.freeze({
  SPLIT_LF: 'split-lf',
  JOIN_LF: 'join-lf',
  REGEX_LF: 'regex-lf',
  BOUNDARY_LF: 'boundary-lf',
  FRONTMATTER_OPEN_LF: 'frontmatter-open-lf',
});

const DEFAULT_ROOTS = Object.freeze(['scripts']);
const SCANNED_EXTENSIONS = Object.freeze(['.js', '.cjs', '.mjs']);
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.build', 'build', '.gsd']);
const SELF_FIXTURE_BASENAMES = new Set(['forge-eol-anchors.js', 'forge-eol-anchors.test.js']);

// These are deliberately regex literals.  In a RegExp source, `\\n` denotes
// the two source characters backslash+n; `\n` would denote a physical newline.
const SPLIT_JOIN_RE = /\.(split|join)[ \t]*\([ \t]*(['"`])\\n\2[ \t]*\)/g;
const BOUNDARY_RE = /\.(startsWith|endsWith|includes|indexOf)[ \t]*\([ \t]*(['"`])(?:[^\\\n]|\\.)*\\n(?:[^\\\n]|\\.)*\2/g;
// The captures name the declaration which owns the following brace: function,
// assigned arrow, and method respectively.  Symbol ownership is deliberately
// part of the static result, rather than a line-number convention maintained
// by a caller.  This is what lets a match in incrementRepairCount remain
// identifiable when unrelated edits move it through forge-repair.js.
const SCOPE_DECL_RE = /(?:\b(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)[ \t]*\([^()\r\n]*\)[ \t]*|\b(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]*)?\([^()\r\n]*\)[ \t]*=>[ \t]*|^[ \t]*(?:async[ \t]+)?(?!(?:if|for|while|switch|catch|with)\b)([A-Za-z_$][\w$]*)[ \t]*\([^()\r\n]*\)[ \t]*)\{/gm;
const WRITE_RE = /\bfs\.(?:writeFileSync|appendFileSync|writeSync)\s*\(|\bfs\.promises\.writeFile\s*\(/;

function escapedLineText(line) {
  return line.replace(/\r$/, '');
}

function lineStarts(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineNumberAt(starts, index) {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= index) low = middle; else high = middle;
  }
  return low + 1;
}

function hasCrTolerance(construct) {
  // This asks only the matched construct.  A CR expression elsewhere in a
  // file cannot excuse an unrelated LF anchor.
  return /\\r\?\\n|\\r\\n\?|\\r\?\$/.test(construct);
}

function isRegexLiteralAt(content, start) {
  const previous = content[start - 1] || '';
  return previous !== '/' && previous !== '\\';
}

// A `/` opens a regex literal only in expression position.  These are the
// punctuators and keywords after which a regex may legally begin; anything
// else (identifier, digit, `)`, `]`, `}`) makes the slash a division operator.
const REGEX_START_PUNCTUATORS = new Set(
  ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '~', '^', '<', '>'],
);
const REGEX_START_KEYWORDS = new Set(
  ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'],
);

function regexCanStartAt(content, index, previousSignificant, previousSignificantIndex) {
  if (!previousSignificant) return true;
  if (REGEX_START_PUNCTUATORS.has(previousSignificant)) return true;
  if (!/[A-Za-z0-9_$]/.test(previousSignificant)) return false;
  let start = previousSignificantIndex;
  while (start >= 0 && /[A-Za-z0-9_$]/.test(content[start])) start--;
  return REGEX_START_KEYWORDS.has(content.slice(start + 1, previousSignificantIndex + 1));
}

/**
 * One tokenizer for the whole file.  It is the single implementation of "what
 * is code and what is not": comment spans, quoted spans, regex-literal spans
 * and brace pairing are all decided here.  A second, partial implementation is
 * exactly how a brace inside a regex literal came to be counted as a block
 * brace -- the defect this function exists to make unrepresentable.
 */
function scanSpans(content) {
  const comments = [];
  const closeOf = new Map();
  // Entries are either `{brace, index}` (a real block brace, whose match is
  // recorded) or `{template: true}` (the `${` of a template substitution,
  // whose `}` returns the scanner to template text rather than closing a
  // block).  Without the second kind, a nested template such as
  // `` `'${String(p).replace(/'/g, `'\\''`)}'` `` terminates the outer literal
  // at the inner backtick and every construct after it is misread.
  const stack = [];
  let template = false;
  let previousSignificant = '';
  let previousSignificantIndex = -1;
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1] || '';
    if (template) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { template = false; previousSignificant = '`'; previousSignificantIndex = i; i++; continue; }
      if (ch === '$' && next === '{') { stack.push({ template: true }); template = false; i += 2; continue; }
      i++;
      continue;
    }
    if (ch === '`') { template = true; i++; continue; }
    if (ch === '/' && next === '/') {
      const start = i;
      i += 2;
      while (i < content.length && content[i] !== '\n') i++;
      comments.push([start, i]);
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i = Math.min(i + 2, content.length);
      comments.push([start, i]);
      continue;
    }
    if (ch === '"' || ch === "'") {
      // A quoted string cannot span a physical line.  Bounding it keeps a
      // stray apostrophe from opening a string that swallows the rest of the
      // file -- including the `//` that starts a real comment, which would
      // then be misreported as code.
      i++;
      while (i < content.length) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === ch) { i++; break; }
        if (content[i] === '\n') break;
        i++;
      }
      previousSignificant = ch;
      previousSignificantIndex = i - 1;
      continue;
    }
    if (ch === '/' && regexCanStartAt(content, i, previousSignificant, previousSignificantIndex)) {
      // A `/` inside a character class does not close the literal, and a
      // literal never spans a physical line: an unterminated slash must not
      // swallow the remainder of the file.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < content.length && content[j] !== '\n') {
        const cur = content[j];
        if (cur === '\\') { j += 2; continue; }
        if (cur === '[') inClass = true;
        else if (cur === ']') inClass = false;
        else if (cur === '/' && !inClass) { closed = true; j++; break; }
        j++;
      }
      if (closed) {
        previousSignificant = '/';
        previousSignificantIndex = j - 1;
        i = j;
        continue;
      }
      // Not a literal after all: fall through and treat it as an operator.
    }
    if (ch === '{') stack.push({ index: i });
    else if (ch === '}') {
      const open = stack.pop();
      if (open && open.template) { template = true; i++; continue; }
      if (open) closeOf.set(open.index, i);
    }
    if (!/\s/.test(ch)) { previousSignificant = ch; previousSignificantIndex = i; }
    i++;
  }
  return { comments, closeOf };
}

// The tokenizer is O(n); scopesIn asks for a brace end once per declaration.
// Memoise the last document so a file is tokenised once, not once per scope.
let spanCache = { content: null, spans: null };

function spansFor(content) {
  if (spanCache.content === content) return spanCache.spans;
  spanCache = { content, spans: scanSpans(content) };
  return spanCache.spans;
}

function isInComment(content, index) {
  for (const [start, end] of spansFor(content).comments) {
    if (index >= start && index < end) return true;
    if (start > index) break;
  }
  return false;
}

function braceEnd(content, openingBrace) {
  const end = spansFor(content).closeOf.get(openingBrace);
  return end === undefined ? -1 : end;
}

function scopesIn(content) {
  const scopes = [];
  SCOPE_DECL_RE.lastIndex = 0;
  let match;
  while ((match = SCOPE_DECL_RE.exec(content)) !== null) {
    const symbol = match[1] || match[2] || match[3];
    const openingBrace = match.index + match[0].lastIndexOf('{');
    // Scope ownership is bounded by the matching closing brace of THIS
    // declaration.  A global brace stack can be desynchronised by unrelated
    // source constructs before a declaration and make a later top-level CLI
    // block inherit the preceding function's symbol.
    scopes.push({
      start: match.index,
      end: braceEnd(content, openingBrace),
      // A declaration matched by SCOPE_DECL_RE always has one of these
      // captures.  Keep the explicit fallback nevertheless: malformed source
      // must surface uncertainty, never emit a silent null symbol.
      symbol: symbol || null,
    });
  }
  return scopes.filter((scope) => scope.end >= scope.start);
}

function findEnclosingScope(content, siteIndex, precomputedScopes) {
  let nearest = null;
  for (const scope of (precomputedScopes || scopesIn(content))) {
    if (scope.start <= siteIndex && scope.end >= siteIndex && (!nearest || scope.start > nearest.start)) nearest = scope;
  }
  return nearest;
}

function classifyMutation(content, siteIndex, precomputedScopes) {
  const scope = findEnclosingScope(content, siteIndex, precomputedScopes);
  if (!scope || !scope.symbol) {
    return { mutates: 'undetermined', reason: SKIP_REASONS.SCOPE_UNDETERMINED, symbol: null };
  }
  const body = content.slice(scope.start, scope.end + 1);
  return { mutates: WRITE_RE.test(body), reason: null, symbol: scope.symbol };
}

function requiredForm(mutates) {
  return mutates === false ? 'A' : 'B';
}

function makeEntry(filePath, content, index, form, text, starts, scopes) {
  const mutation = classifyMutation(content, index, scopes);
  return {
    file: filePath,
    line: lineNumberAt(starts, index),
    form,
    text: text.trim(),
    exposed: !hasCrTolerance(text),
    mutates: mutation.mutates,
    required_form: requiredForm(mutation.mutates),
    ...(mutation.symbol ? { symbol: mutation.symbol } : {}),
    ...(mutation.reason ? { scope_reason: mutation.reason } : {}),
  };
}

function collectMatches(content, filePath) {
  const found = [];
  const starts = lineStarts(content);
  const scopes = scopesIn(content);
  SPLIT_JOIN_RE.lastIndex = 0;
  let match;
  while ((match = SPLIT_JOIN_RE.exec(content)) !== null) {
    found.push(makeEntry(filePath, content, match.index,
      match[1] === 'split' ? ANCHOR_FORMS.SPLIT_LF : ANCHOR_FORMS.JOIN_LF, match[0], starts, scopes));
  }

  // Restrict literal-regex discovery to a physical line.  Besides reflecting
  // JavaScript's non-newline regex literals, this prevents an unterminated
  // slash in a large source file from repeatedly searching its whole suffix.
  let offset = 0;
  for (const sourceLine of content.split('\n')) {
    BOUNDARY_RE.lastIndex = 0;
    while ((match = BOUNDARY_RE.exec(sourceLine)) !== null) {
      found.push(makeEntry(filePath, content, offset + match.index, ANCHOR_FORMS.BOUNDARY_LF, match[0], starts, scopes));
    }
    let slash = sourceLine.indexOf('/');
    while (slash >= 0) {
      const end = sourceLine.indexOf('/', slash + 1);
      if (end < 0) break;
      const literal = sourceLine.slice(slash, end + 1);
      const index = offset + slash;
      // A slash inside a comment is prose, not a call site.  Per D-S02-1 the
      // census enumerates EOL-relevant call sites, so an inert quotation
      // admitted here would inflate exposed/required_form counts that T03's
      // recall calibration consumes as ground truth.
      if (isRegexLiteralAt(content, index) && literal.includes('\\n') && !isInComment(content, index)) {
        const form = /^\/\^---(?:\\r\?)?\\n/.test(literal)
          ? ANCHOR_FORMS.FRONTMATTER_OPEN_LF
          : ANCHOR_FORMS.REGEX_LF;
        found.push(makeEntry(filePath, content, index, form, literal, starts, scopes));
      }
      slash = sourceLine.indexOf('/', end + 1);
    }
    offset += sourceLine.length + 1;
  }
  return found.sort((a, b) => a.line - b.line || a.form.localeCompare(b.form));
}

// Compilation here is a syntax-only boundary check: Function construction
// parses its string but does not execute it.  The scanner is intentionally not
// an AST tool, yet an invalid JavaScript file must be named in skipped[] rather
// than being mistaken for a source file with no anchors.
function checkParseableSource(content) {
  try {
    // eslint-disable-next-line no-new-func -- syntax validation, never invoked
    // Function does not accept Node's otherwise-valid hashbang; remove only
    // that first physical line before asking the JavaScript parser.
    new Function(content.replace(/^#![^\r\n]*(?:\r?\n|$)/, ''));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: SKIP_REASONS.UNPARSEABLE, message: error.message };
  }
}

/**
 * Pure classifier for `{path, content}` fixtures.  It never reads from disk;
 * the scan driver is responsible for boundary I/O and named unreadable skips.
 */
function classifyFile(record) {
  if (!record || typeof record.path !== 'string' || typeof record.content !== 'string') {
    return { scanned: 0, call_sites: [], error: SKIP_REASONS.UNREADABLE };
  }
  const parse = checkParseableSource(record.content);
  if (!parse.ok) return { scanned: 0, call_sites: [], error: parse.reason };
  return { scanned: 1, call_sites: collectMatches(record.content, record.path) };
}

function collectFiles(rootDir) {
  const files = [];
  const skipped = [];
  let walked = 0;
  let unreadableDirs = 0;
  let stat;
  try { stat = fs.statSync(rootDir); } catch {
    return { files, skipped: [{ file: rootDir, reason: SKIP_REASONS.ROOT_NOT_FOUND }], walked: 1, unreadableDirs };
  }
  if (stat.isFile()) {
    if (SELF_FIXTURE_BASENAMES.has(path.basename(rootDir))) {
      return { files, skipped: [{ file: rootDir, reason: SKIP_REASONS.SELF_FIXTURE }], walked: 1, unreadableDirs };
    }
    if (!SCANNED_EXTENSIONS.includes(path.extname(rootDir))) {
      return { files, skipped: [{ file: rootDir, reason: SKIP_REASONS.EXTENSION_NOT_SCANNED }], walked: 1, unreadableDirs };
    }
    return { files: [rootDir], skipped, walked: 1, unreadableDirs };
  }
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {
      unreadableDirs++;
      // A directory is not a file unit, so it does not enter the arithmetic.
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name === 'fixtures') {
          walked++;
          skipped.push({ file: full, reason: SKIP_REASONS.OUT_OF_SCOPE_DIRECTORY });
        } else walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      walked++;
      if (SELF_FIXTURE_BASENAMES.has(entry.name)) {
        skipped.push({ file: full, reason: SKIP_REASONS.SELF_FIXTURE });
      } else if (!SCANNED_EXTENSIONS.includes(path.extname(entry.name))) {
        skipped.push({ file: full, reason: SKIP_REASONS.EXTENSION_NOT_SCANNED });
      } else files.push(full);
    }
  }
  walk(rootDir);
  return { files, skipped, walked, unreadableDirs };
}

/**
 * Scan directory roots or, with `{inMemory:true}`, fixture records.  `walked`
 * is deliberately a file census, so its reconciliation is mechanically
 * checkable: every walked file was either read (`scanned`) or named skipped.
 */
function scanEolAnchors(roots, opts) {
  opts = opts || {};
  const skipped = [];
  const records = [];
  let walked = 0;
  let unreadableDirs = 0;
  if (opts.inMemory) {
    for (const record of (Array.isArray(roots) ? roots : [])) { records.push(record); walked++; }
  } else {
    const rootList = Array.isArray(roots) && roots.length ? roots : DEFAULT_ROOTS;
    for (const root of rootList) {
      const result = collectFiles(root);
      records.push(...result.files);
      skipped.push(...result.skipped);
      walked += result.walked;
      unreadableDirs += result.unreadableDirs;
    }
  }
  let scanned = 0;
  const callSites = [];
  // Additive: the roster of files actually read.  Without it a consumer cannot
  // tell "file never scanned" from "file scanned, zero anchors" -- and naming
  // the second as the first would be a confidently wrong reason.
  const scannedFiles = [];
  for (const record of records) {
    const filePath = typeof record === 'string' ? record : record.path;
    let result;
    if (typeof record === 'string') {
      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch {
        skipped.push({ file: filePath, reason: SKIP_REASONS.UNREADABLE });
        continue;
      }
      result = classifyFile({ path: filePath, content });
    } else result = classifyFile(record);
    if (!result.scanned) { skipped.push({ file: filePath, reason: result.error || SKIP_REASONS.UNREADABLE }); continue; }
    scanned += result.scanned;
    scannedFiles.push(filePath);
    callSites.push(...result.call_sites);
  }
  const reconciles = walked === scanned + skipped.length;
  // Every branch below is reachable, and the set of emitted values is exactly
  // {scan-failed, found}.  A `clean` initialiser used to sit here: no code path
  // could emit it, because zero call sites is the anti-silence floor (a failure,
  // deliberately) and any positive count is `found`.  Documenting an outcome the
  // module cannot produce misleads a consumer branching on it.
  let outcome;
  let reason = null;
  if (scanned === 0 || callSites.length === 0) { outcome = 'scan-failed'; reason = 'no-call-sites-scanned'; }
  else if (unreadableDirs > 0 || !reconciles) { outcome = 'scan-failed'; reason = SKIP_REASONS.UNREADABLE; }
  else outcome = 'found';
  return {
    outcome, ...(reason ? { reason } : {}), walked, scanned, call_sites: callSites, skipped,
    scanned_files: scannedFiles,
    reconciles,
    counts: { call_sites: callSites.length, exposed: callSites.filter((x) => x.exposed).length,
      unexposed: callSites.filter((x) => !x.exposed).length,
      mutates: callSites.filter((x) => x.mutates === true).length,
      read_only: callSites.filter((x) => x.mutates === false).length,
      undetermined: callSites.filter((x) => x.mutates === 'undetermined').length },
  };
}

function checkEolAnchors(roots, opts) {
  const result = scanEolAnchors(roots, opts);
  return { ok: result.outcome !== 'scan-failed', ...result, message: result.reason || result.outcome };
}

// ---------------------------------------------------------------------------
// Recall calibration against the S01 behavioural ground truth.
//
// This mode measures THE PREDICATE ABOVE.  It never introduces a second
// heuristic: a recall figure produced by a different matcher would describe a
// scanner nobody ships.  Nothing here widens the predicate either -- a suite
// the predicate misses is published in gaps[] under a named reason, because
// widening a predicate until recall closes reproduces S01's R2 (a false
// CONFIRMED) at whole-tree scale.
// ---------------------------------------------------------------------------

const CALIBRATION_REASONS = Object.freeze({
  GROUND_TRUTH_MISSING: 'ground-truth-missing',
  GROUND_TRUTH_UNPARSEABLE: 'ground-truth-unparseable',
  GROUND_TRUTH_EMPTY_CONFIRMED: 'ground-truth-empty-confirmed',
  NO_EXPOSED_CALL_SITE_FLAGGED: 'no-exposed-call-site-flagged',
  SUITE_FILE_NOT_SCANNED: 'suite-file-not-scanned',
});

// The exact criterion, carried in the output rather than left implicit.  An
// implicit granularity would be the fourth instance of the same defect this
// milestone exists to sweep (S01-REVIEW, "Nota de metodo", counts three).
const RECALL_GRANULARITY =
  'per-suite, never per-assert: S01 asserts_flipped carries assert NAMES, not files or lines, ' +
  'so a flip cannot be attributed to a specific call site from this data. The attribution set ' +
  "for each confirmed suite is the suite file PLUS its first-level require('./...') dependencies " +
  'resolved under the scanned roots; the suite counts as flagged when at least one call site with ' +
  'exposed:true exists anywhere in that set.';

const ATTRIBUTION_NOT_PER_ASSERT =
  'Attribution is NOT per assert. The ground truth records assert names only; no file or line is ' +
  'recorded for a flipped assert, so mapping one assert onto one call site is not derivable from ' +
  'the available data. Per-suite attribution is therefore the finest honest granularity, and it is ' +
  'declared here instead of being left for a reader to infer.';

const UNPROVEN_NOT_CLEAN =
  'unproven is NOT clean: the behavioural differential could not judge these suites at all. The ' +
  'static exposure count below is coverage the behavioural instrument could not give, not a verdict ' +
  'that these suites are safe.';

const REQUIRE_RE = /\brequire[ \t]*\([ \t]*(['"])(\.\.?\/[^'"]+)\1[ \t]*\)/g;

function normalizePath(filePath) {
  return path.resolve(filePath).replace(/\\/g, '/');
}

/** First-level relative requires of one source file, resolved against the scanned set. */
function attributionSet(suiteFile, scannedByPath, readFile) {
  const files = [suiteFile];
  let content;
  try { content = readFile(suiteFile); } catch { return { files, require_read_failed: true }; }
  REQUIRE_RE.lastIndex = 0;
  let match;
  while ((match = REQUIRE_RE.exec(content)) !== null) {
    const raw = match[2];
    const candidates = /\.[cm]?js$/.test(raw) ? [raw] : [`${raw}.js`, `${raw}.cjs`, `${raw}.mjs`];
    for (const candidate of candidates) {
      const resolved = normalizePath(path.resolve(path.dirname(suiteFile), candidate));
      if (scannedByPath.has(resolved) && !files.includes(resolved)) files.push(resolved);
    }
  }
  return { files, require_read_failed: false };
}

function indexScan(scanResult) {
  const byPath = new Map();
  const byBasename = new Map();
  const register = (filePath) => {
    const key = normalizePath(filePath);
    if (!byPath.has(key)) byPath.set(key, []);
    const base = path.basename(key);
    // A basename can legitimately exist under several roots; keep every one so
    // the suite lookup reports ambiguity instead of silently picking the first.
    if (!byBasename.has(base)) byBasename.set(base, new Set());
    byBasename.get(base).add(key);
    return key;
  };
  // The roster comes first: a file read with zero anchors must still resolve,
  // otherwise it would be reported as never scanned.
  for (const file of (scanResult && Array.isArray(scanResult.scanned_files) ? scanResult.scanned_files : [])) register(file);
  for (const site of (scanResult && Array.isArray(scanResult.call_sites) ? scanResult.call_sites : [])) {
    byPath.get(register(site.file)).push(site);
  }
  return { byPath, byBasename };
}

function exposedIn(files, byPath) {
  let exposed = 0;
  let total = 0;
  const evidence = [];
  for (const file of files) {
    for (const site of (byPath.get(file) || [])) {
      total += 1;
      if (site.exposed === true) {
        exposed += 1;
        if (evidence.length < 8) evidence.push({ file, line: site.line, form: site.form, ...(site.symbol ? { symbol: site.symbol } : {}) });
      }
    }
  }
  // `total` separates two different gaps: an attribution set with no anchors at
  // all, and one whose anchors are all CR-tolerant.  Collapsing them would hide
  // which of the two the predicate actually missed.
  return { exposed, total, evidence };
}

function resolveSuite(suite, index) {
  const matches = index.byBasename.get(path.basename(String(suite || ''))) || new Set();
  return Array.from(matches);
}

function measureForms(scanResult) {
  const perForm = new Map();
  for (const site of (scanResult && Array.isArray(scanResult.call_sites) ? scanResult.call_sites : [])) {
    if (!perForm.has(site.form)) perForm.set(site.form, { form: site.form, sites: 0, files: new Set() });
    const bucket = perForm.get(site.form);
    bucket.sites += 1;
    bucket.files.add(normalizePath(site.file));
  }
  return Array.from(perForm.values())
    .map((bucket) => ({ form: bucket.form, sites: bucket.sites, files: bucket.files.size }))
    .sort((a, b) => b.sites - a.sites || a.form.localeCompare(b.form));
}

/**
 * Measure how much of the S01 confirmed[] set the static predicate flags.
 *
 * Pure over `{groundTruth, scanResult}`; the only I/O is the injectable
 * `opts.readFile`, used to resolve first-level requires of each suite file.
 * Anti-silence floor: a zero denominator is an outcome, never a 100% recall.
 */
function calibrateRecall(groundTruth, scanResult, opts) {
  opts = opts || {};
  const readFile = opts.readFile || ((file) => fs.readFileSync(file, 'utf8'));
  const failure = (reason) => ({
    outcome: 'calibration-failed',
    reason,
    recall_flagged: 0,
    recall_total: 0,
    recall_granularity: RECALL_GRANULARITY,
    attribution_note: ATTRIBUTION_NOT_PER_ASSERT,
    flagged: [],
    gaps: [],
    unproven_coverage: [],
    forms_measured: measureForms(scanResult),
    forms_added: [],
  });

  if (!groundTruth || typeof groundTruth !== 'object') return failure(CALIBRATION_REASONS.GROUND_TRUTH_MISSING);
  const confirmed = Array.isArray(groundTruth.confirmed) ? groundTruth.confirmed : null;
  if (!confirmed || confirmed.length === 0) return failure(CALIBRATION_REASONS.GROUND_TRUTH_EMPTY_CONFIRMED);

  const index = indexScan(scanResult);
  const flagged = [];
  const gaps = [];

  for (const entry of confirmed) {
    const suite = entry && entry.suite;
    const flips = Array.isArray(entry && entry.asserts_flipped) ? entry.asserts_flipped.length : 0;
    const suiteFiles = resolveSuite(suite, index);
    if (suiteFiles.length === 0) {
      gaps.push({ suite, asserts_flipped: flips, reason: CALIBRATION_REASONS.SUITE_FILE_NOT_SCANNED, attribution_files: 0, exposed_sites: 0 });
      continue;
    }
    const files = [];
    let requireReadFailed = false;
    for (const suiteFile of suiteFiles) {
      const set = attributionSet(suiteFile, index.byPath, readFile);
      requireReadFailed = requireReadFailed || set.require_read_failed;
      for (const file of set.files) if (!files.includes(file)) files.push(file);
    }
    const { exposed, total, evidence } = exposedIn(files, index.byPath);
    const record = {
      suite,
      asserts_flipped: flips,
      attribution_files: files.length,
      exposed_sites: exposed,
      call_sites_total: total,
      ...(requireReadFailed ? { require_read_failed: true } : {}),
    };
    if (exposed > 0) flagged.push({ ...record, evidence });
    else gaps.push({ ...record, reason: CALIBRATION_REASONS.NO_EXPOSED_CALL_SITE_FLAGGED });
  }

  // Complementary coverage: the differential could not judge these at all.
  const unprovenCoverage = [];
  for (const entry of (Array.isArray(groundTruth.unproven) ? groundTruth.unproven : [])) {
    const suite = entry && entry.suite;
    const suiteFiles = resolveSuite(suite, index);
    if (suiteFiles.length === 0) {
      unprovenCoverage.push({ suite, differential_reason: entry && entry.reason, exposed_sites: 0, attribution_files: 0, coverage: CALIBRATION_REASONS.SUITE_FILE_NOT_SCANNED });
      continue;
    }
    const files = [];
    for (const suiteFile of suiteFiles) {
      for (const file of attributionSet(suiteFile, index.byPath, readFile).files) if (!files.includes(file)) files.push(file);
    }
    const { exposed, total } = exposedIn(files, index.byPath);
    unprovenCoverage.push({
      suite,
      differential_reason: entry && entry.reason,
      exposed_sites: exposed,
      call_sites_total: total,
      attribution_files: files.length,
      coverage: exposed > 0 ? 'static-exposure-found' : 'no-static-exposure',
    });
  }

  // Named divergence, reported and NOT reconciled.  Static exposure and
  // behavioural stability answer different questions (precision vs recall);
  // neither predicate is narrowed or widened to make them agree.
  let stableWithExposure = 0;
  for (const entry of (Array.isArray(groundTruth.stable) ? groundTruth.stable : [])) {
    const suiteFiles = resolveSuite(entry && entry.suite, index);
    if (suiteFiles.length === 0) continue;
    const files = [];
    for (const suiteFile of suiteFiles) {
      for (const file of attributionSet(suiteFile, index.byPath, readFile).files) if (!files.includes(file)) files.push(file);
    }
    if (exposedIn(files, index.byPath).exposed > 0) stableWithExposure += 1;
  }

  return {
    outcome: 'calibrated',
    recall_flagged: flagged.length,
    recall_total: confirmed.length,
    recall_granularity: RECALL_GRANULARITY,
    attribution_note: ATTRIBUTION_NOT_PER_ASSERT,
    flagged,
    gaps,
    unproven_note: UNPROVEN_NOT_CLEAN,
    unproven_coverage: unprovenCoverage,
    counts: {
      confirmed: confirmed.length,
      flagged: flagged.length,
      gaps: gaps.length,
      unproven: unprovenCoverage.length,
      unproven_with_static_exposure: unprovenCoverage.filter((x) => x.coverage === 'static-exposure-found').length,
      unproven_without_static_exposure: unprovenCoverage.filter((x) => x.coverage === 'no-static-exposure').length,
      unproven_suite_file_not_scanned: unprovenCoverage.filter((x) => x.coverage === CALIBRATION_REASONS.SUITE_FILE_NOT_SCANNED).length,
    },
    divergence: {
      stable_suites_with_static_exposure: stableWithExposure,
      note: 'Statically exposed call sites exist in suites the behavioural differential ranks stable. ' +
        'That is the precision axis; this mode measures recall. The divergence is reported, not reconciled: ' +
        'no form is added or removed from the predicate to make the two instruments agree.',
    },
    // The predicate carries exactly the forms T01 shipped.  forms_added is
    // empty by construction; were a form ever added to close recall, its
    // measured tree footprint would have to appear here alongside it.
    forms_measured: measureForms(scanResult),
    forms_added: [],
  };
}

function readGroundTruth(file, readFile) {
  const read = readFile || ((target) => fs.readFileSync(target, 'utf8'));
  let raw;
  try { raw = read(file); } catch {
    return { ok: false, reason: CALIBRATION_REASONS.GROUND_TRUTH_MISSING };
  }
  try { return { ok: true, data: JSON.parse(raw) }; } catch {
    return { ok: false, reason: CALIBRATION_REASONS.GROUND_TRUTH_UNPARSEABLE };
  }
}

function parseArgs(argv) {
  const args = { check: false, json: false, calibrate: null, roots: [], cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--calibrate') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return { error: '--calibrate requires a ground-truth JSON path' };
      args.calibrate = value;
    } else if (arg === '--root' || arg === '--cwd') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return { error: `${arg} requires a directory` };
      if (arg === '--root') args.roots.push(value); else args.cwd = value;
    } else return { error: `unknown argument: ${arg}` };
  }
  if (!args.check && !args.calibrate) return { error: '--check or --calibrate is required' };
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { process.stderr.write(`Error: ${args.error}\n`); process.exitCode = 2; return; }
  const cwd = path.resolve(args.cwd);
  const roots = (args.roots.length ? args.roots : DEFAULT_ROOTS).map((root) => path.resolve(cwd, root));
  let result;
  try { result = scanEolAnchors(roots); } catch (error) {
    result = { outcome: 'scan-failed', reason: error.message, walked: 0, scanned: 0, call_sites: [], skipped: [], reconciles: true, counts: {} };
  }
  if (args.calibrate) {
    // The census and the calibration ship as ONE document: a recall figure
    // detached from the scan it was computed over cannot be re-derived.
    const ground = readGroundTruth(path.resolve(cwd, args.calibrate));
    const calibration = ground.ok
      ? calibrateRecall(ground.data, result)
      : { outcome: 'calibration-failed', reason: ground.reason, recall_flagged: 0, recall_total: 0,
        recall_granularity: RECALL_GRANULARITY, attribution_note: ATTRIBUTION_NOT_PER_ASSERT,
        flagged: [], gaps: [], unproven_coverage: [], forms_measured: measureForms(result), forms_added: [] };
    const document = { ...result, ground_truth: path.resolve(cwd, args.calibrate), calibration };
    if (args.json) process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    else {
      process.stdout.write(`recall ${calibration.recall_flagged}/${calibration.recall_total} (${calibration.outcome}${calibration.reason ? `: ${calibration.reason}` : ''})\n`);
      for (const gap of calibration.gaps) process.stdout.write(`gap ${gap.suite} [${gap.reason}] asserts_flipped=${gap.asserts_flipped}\n`);
    }
    // Named-reason failures are runtime failures (exit 1); invalid arguments
    // stay at exit 2.  A zero denominator never reports 100%.
    process.exitCode = calibration.outcome === 'calibration-failed' ? 1 : (result.outcome === 'scan-failed' ? 2 : 0);
    return;
  }
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const site of result.call_sites) process.stdout.write(`${site.file}:${site.line} [${site.form}] ${site.text}\n`);
    process.stdout.write(`${result.outcome}${result.reason ? `: ${result.reason}` : ''}\n`);
  }
  process.exitCode = result.outcome === 'scan-failed' ? 2 : 0;
}

if (require.main === module) main();

module.exports = {
  SKIP_REASONS,
  ANCHOR_FORMS,
  CALIBRATION_REASONS,
  RECALL_GRANULARITY,
  classifyFile,
  scanEolAnchors,
  checkEolAnchors,
  calibrateRecall,
  _private: { scanSpans, isInComment, braceEnd, collectFiles, collectMatches, hasCrTolerance, findEnclosingScope, classifyMutation, checkParseableSource, parseArgs, requiredForm, calibrateRecall, readGroundTruth, attributionSet, measureForms },
};
