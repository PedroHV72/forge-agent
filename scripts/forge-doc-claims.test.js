#!/usr/bin/env node
'use strict';

// forge-doc-claims.test.js — proves reach, bite, anti-silence, and a clean
// real-tree run for the in-process revoked-claim guard.
//
// This suite exists because the ROADMAP's own demo criterion for S06
// (`grep -rn "single source of truth"`) was measured GREEN before any work
// was done: this environment's `grep` is a shell function wrapping
// `ugrep --ignore-files`, which honors `.gitignore`, and `.gitignore` lists
// CLAUDE.md — the exact file carrying the claim. R1 below proves the
// scanner does NOT share that blindness. R2 proves bite in BOTH directions
// (mutation testing lesson from S02: removal-only mutation silently no-ops
// the moment the thing is absent for another reason). R4 proves the
// anti-silence floor is a real failure mode, not a comment.
//
// Every fixture lives in fs.mkdtempSync under os.tmpdir(). Nothing here
// reads or writes the operator's real ~/.claude/forge-gate-workspaces.json,
// and nothing writes into the real working tree.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  REVOKED_CLAIMS,
  collectFiles,
  scanClaims,
  checkTree,
} = require('./forge-doc-claims.js');

const repoRoot = path.resolve(__dirname, '..');

// ── Runner ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
  }
}

const tmps = [];

function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-doc-claims-'));
  tmps.push(d);
  return fs.realpathSync(d);
}

function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Built from parts rather than one contiguous literal: this test file is
// itself part of the tracked tree the real-tree scan (R5) walks, and the
// whole point of the guard is adjacency detection — a literal copy of the
// revoked claim sitting in this file's own source text would be a genuine
// self-match, not a false positive. Splitting it here is not evasion of
// the regex; it is avoiding accidentally SHIPPING the revoked claim itself
// as committed prose.
const CLAIM_PARTS = ['STATE.md', 'é', 'single', 'source', 'of', 'truth'];
const CLAIM_LINE = `- **${CLAIM_PARTS.join(' ')}** — só o orquestrador e o completer escrevem nele`;

// ── R1: reach — collectFiles must see CLAUDE.md ────────────────────────────

console.log('R1 — reach into a gitignored-but-tracked file');

test('collectFiles(repoRoot) includes CLAUDE.md — fails if .gitignore filtering is ever reintroduced', () => {
  const files = collectFiles(repoRoot);
  const hasClaudeMd = files.some((f) => f === path.join(repoRoot, 'CLAUDE.md'));
  assert(
    hasClaudeMd,
    'CLAUDE.md not found in scanned set — the scanner is honoring .gitignore, which defeats its whole purpose'
  );
});

test('collectFiles skips .gsd/ by explicit design (dogfood/archaeology, not a target)', () => {
  const files = collectFiles(repoRoot);
  const insideGsd = files.some((f) => f.split(path.sep).includes('.gsd'));
  assert(!insideGsd, '.gsd/ entries leaked into the scanned set');
});

test('collectFiles on a nonexistent root returns [] (not a throw) — feeds the anti-silence floor', () => {
  const files = collectFiles(path.join(os.tmpdir(), 'forge-doc-claims-does-not-exist-xyz'));
  assertEqual(files.length, 0, 'files.length');
});

// ── R2: bite — the central test, proven both directions ───────────────────

console.log('R2 — bite (fixture re-injection, both directions)');

test('reinjecting the revoked claim into a gitignored-but-tracked fixture file produces a violation', () => {
  const dir = mktmp('forge-doc-claims-bite-');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'alvo.md\n');
  fs.writeFileSync(path.join(dir, 'alvo.md'), `# doc\n\n${CLAIM_LINE}\n`);

  const files = collectFiles(dir);
  assert(files.some((f) => f.endsWith('alvo.md')), 'alvo.md must be reachable despite .gitignore listing it');

  const result = scanClaims(files, REVOKED_CLAIMS);
  assert(result.scanned > 0, 'scanned must be > 0');
  assert(result.violations.length >= 1, 'expected >= 1 violation with the claim present');
  assertEqual(result.violations[0].claimId, 'state-md-single-source-of-truth', 'claimId');
});

test('removing the claim from the SAME fixture reports clean, with scanned > 0 (proves both directions, not removal-only)', () => {
  const dir = mktmp('forge-doc-claims-bite-clean-');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'alvo.md\n');
  fs.writeFileSync(path.join(dir, 'alvo.md'), '# doc\n\nSTATE.md is a generated projection.\n');

  const files = collectFiles(dir);
  const result = scanClaims(files, REVOKED_CLAIMS);
  assert(result.scanned > 0, 'scanned must be > 0');
  assertEqual(result.violations.length, 0, 'violations.length');
});

test('checkTree end-to-end: violation present -> ok:false; violation removed -> ok:true (same fixture root)', () => {
  const dir = mktmp('forge-doc-claims-e2e-');
  // Pad past the anti-silence floor with harmless filler files so this
  // fixture's own size doesn't trip the floor and mask the claim signal.
  for (let i = 0; i < 25; i++) {
    fs.writeFileSync(path.join(dir, `filler-${i}.md`), `filler file ${i}, nothing revoked here.\n`);
  }
  const target = path.join(dir, 'alvo.md');

  fs.writeFileSync(target, `${CLAIM_LINE}\n`);
  const dirty = checkTree(dir, { floor: 20 });
  assertEqual(dirty.ok, false, 'dirty.ok');
  assert(dirty.violations.length >= 1, 'dirty.violations.length');

  fs.writeFileSync(target, 'STATE.md is a generated projection now.\n');
  const clean = checkTree(dir, { floor: 20 });
  assertEqual(clean.ok, true, 'clean.ok');
  assertEqual(clean.violations.length, 0, 'clean.violations.length');
});

// ── R2b: wider connector set — the guard must not be evadable by rewording ─
//
// R2's review objection: the original pattern required one of exactly four
// copulas (is/é/was/foi) IMMEDIATELY after "STATE.md" — three verifiably
// unflagged rewordings of the identical claim proved the guard evadable.
// Each case here is proven red-before/green-after against the fix (verified
// live during T-review-fix: `git stash` the forge-doc-claims.js fix, rerun,
// observe 0 violations on all three, `git stash pop`, rerun, observe 1 each).

console.log('R2b — wider connector set (appositive dash, "remains", reversed order)');

// Split apart for the same reason CLAIM_PARTS is (see comment above it):
// this test file is itself part of the real-tree walk R5 performs, and a
// contiguous literal copy of the widened-connector claim would be a genuine
// self-match, not a false positive.
const DASH_LINE = ['- **STATE.md**', '—', 'the single source of truth, per the old claim.'].join(' ');
const REMAINS_LINE = ['STATE.md remains the single', 'source of truth for the milestone.'].join(' ');
const REVERSED_LINE = ['The idea is that the single source of truth is', 'STATE.md, always.'].join(' ');

test('appositive-dash Markdown-bold phrasing (STATE.md, em-dash) is a violation', () => {
  const result = scanClaims([{ path: '/fx/a.md', content: DASH_LINE + '\n' }], REVOKED_CLAIMS);
  assertEqual(result.violations.length, 1, 'violations.length');
});

test('"remains" connector (STATE.md remains ... claim) is a violation', () => {
  const result = scanClaims([{ path: '/fx/a.md', content: REMAINS_LINE + '\n' }], REVOKED_CLAIMS);
  assertEqual(result.violations.length, 1, 'violations.length');
});

test('reversed subject/predicate order (claim ... is STATE.md) is a violation', () => {
  const result = scanClaims([{ path: '/fx/a.md', content: REVERSED_LINE + '\n' }], REVOKED_CLAIMS);
  assertEqual(result.violations.length, 1, 'violations.length');
});

test('widened pattern still does not flag this file\'s own rationale text (adjacency, not co-occurrence)', () => {
  const result = scanClaims(
    [{
      path: '/fx/rationale.md',
      content:
        'Per-run M###-STATE.md is unaffected and remains a legitimate ' +
        '"source of truth for a single milestone run".\n',
    }],
    REVOKED_CLAIMS
  );
  assertEqual(result.violations.length, 0, 'violations.length — "remains" connector must not float past a non-adjacent phrase');
});

test('widened pattern does not flag a quoted "STATE.md" followed by unrelated prose', () => {
  const result = scanClaims(
    [{ path: '/fx/rationale2.md', content: 'never have "STATE.md" immediately adjacent to the phrase\n' }],
    REVOKED_CLAIMS
  );
  assertEqual(result.violations.length, 0, 'violations.length');
});

// ── R3: no false positives on the measured legitimate occurrences ─────────

console.log('R3 — no false positive on legitimate "single source of truth" phrasing');

test('legitimate occurrences (not about STATE.md) report zero violations', () => {
  // These six mirror the occurrences measured in S06-PLAN §2, step 2 of
  // T02-PLAN: real lines from the repo where the phrase is legitimate and
  // unrelated to STATE.md.
  const fixtures = [
    { path: '/fx/forge-doctor.js', content: '// this registry is the single source of truth for workspace roots\n' },
    { path: '/fx/forge-items.js', content: '// items.json is the single source of truth for backlog entries\n' },
    { path: '/fx/forge-store-state.js', content: '// the store module owns the single source of truth for run state\n' },
    { path: '/fx/forge-accounts.js', content: '// forge-accounts.json is the single source of truth for account metadata\n' },
    { path: '/fx/forge-mcps.md', content: '# The MCP catalog is the single source of truth for available servers\n' },
    { path: '/fx/SKILL.md', content: '## Sweep Policy (single source of truth)\n' },
  ];

  const result = scanClaims(fixtures, REVOKED_CLAIMS);
  assertEqual(result.scanned, fixtures.length, 'scanned');
  assertEqual(result.violations.length, 0, `expected 0 false positives, got ${JSON.stringify(result.violations)}`);
});

test('a line mentioning STATE.md alone (no "single source of truth") is not a violation', () => {
  const result = scanClaims(
    [{ path: '/fx/a.md', content: 'STATE.md is a generated dashboard, read-only.\n' }],
    REVOKED_CLAIMS
  );
  assertEqual(result.violations.length, 0, 'violations.length');
});

// ── R4: anti-silence — scanned === 0 is a FAILURE, not a clean pass ────────

console.log('R4 — anti-silence floor');

test('empty directory => scanned === 0 => checkTree.ok is false, not a clean pass', () => {
  const dir = mktmp('forge-doc-claims-empty-');
  const result = checkTree(dir);
  assertEqual(result.scanned, 0, 'scanned');
  assertEqual(result.ok, false, 'ok — zero-scanned must never read as clean');
  assert(/anti-silence/i.test(result.reason), `reason should cite the anti-silence floor, got: ${result.reason}`);
});

test('nonexistent root => scanned === 0 => checkTree.ok is false', () => {
  const result = checkTree(path.join(os.tmpdir(), 'forge-doc-claims-nowhere-xyz'));
  assertEqual(result.scanned, 0, 'scanned');
  assertEqual(result.ok, false, 'ok');
});

test('scanned above zero but below the floor is still a failure', () => {
  const dir = mktmp('forge-doc-claims-below-floor-');
  fs.writeFileSync(path.join(dir, 'one.md'), 'nothing revoked here\n');
  const result = checkTree(dir, { floor: 20 });
  assert(result.scanned > 0 && result.scanned < 20, 'precondition: scanned should be small but nonzero');
  assertEqual(result.ok, false, 'ok — below-floor scan must fail even with zero violations');
});

// ── R5: real tree — must be clean after T01, and above the floor ──────────

console.log('R5 — real tree (post-T01)');

test('node scripts/forge-doc-claims.test.js against the real repo: zero violations, scanned above the floor', () => {
  const result = checkTree(repoRoot);
  if (!result.ok && result.violations.length > 0) {
    const detail = result.violations.map((v) => `${v.file}:${v.line} ${v.text}`).join('\n');
    throw new Error(`revoked claim(s) still present in the real tree:\n${detail}`);
  }
  assert(result.scanned >= 20, `scanned (${result.scanned}) should be comfortably above the anti-silence floor`);
  assertEqual(result.violations.length, 0, 'violations.length against the real tree');
  assertEqual(result.ok, true, 'checkTree.ok against the real tree');
});

// ── Cleanup + report ──────────────────────────────────────────────────────

cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
