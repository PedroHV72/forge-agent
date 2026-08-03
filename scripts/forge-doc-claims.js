#!/usr/bin/env node
'use strict';

/**
 * forge-doc-claims.js — an in-process guard against revoked documentation
 * claims, born from a measured failure: the ROADMAP's demo criterion for S06
 * (`grep -rn "single source of truth"`) was GREEN before any work started.
 *
 * Root cause: this environment's `grep` is a shell function wrapping
 * `ugrep --ignore-files`, which honors `.gitignore` — and `.gitignore` lists
 * `CLAUDE.md`, the exact file carrying the revoked claim. Only
 * `/usr/bin/grep` or an explicit file argument ever reached it. A checker
 * that never sees the file it is supposed to police is worse than no
 * checker — it reports "clean" while blind.
 *
 * This module never shells out. It walks the filesystem itself with `fs`,
 * so `.gitignore` semantics (which are a property of the `grep`/`git`
 * *tools*, not of the filesystem) cannot hide anything from it.
 *
 * Two properties this scanner exists to guarantee, both proven by the
 * paired test suite (forge-doc-claims.test.js), never merely asserted:
 *   1. Bite — reintroducing a revoked claim into the scanned set turns the
 *      result red; removing it turns it green again (both directions).
 *   2. Anti-silence floor — `scanned === 0` (or below a conservative floor)
 *      is itself a FAILURE, not a clean pass. "Found nothing" and "scanned
 *      nothing" must never be indistinguishable.
 */

const fs = require('fs');
const path = require('path');

// ── Revoked claims — data, not a loose inline regex ─────────────────────────
//
// Each entry documents WHY the claim is revoked so a future reviewer can see
// the rationale without archaeology. `pattern` is a RegExp (case-insensitive,
// no `g` flag needed — scanClaims tests per-line). `appliesTo` narrows which
// files the claim is even meaningful for (a defensive comment, not currently
// used to filter — the regex itself must carry the precision, per Step 2 of
// the task plan: false positives are the real risk here).

const REVOKED_CLAIMS = [
  {
    id: 'state-md-single-source-of-truth',
    // Matches the STATE.md claim specifically — requires "STATE.md"
    // IMMEDIATELY followed (within ~20 chars, past an optional
    // is/é/was/foi copula) by "single source of truth" on the same line.
    // This is adjacency, not mere co-occurrence: it is what distinguishes
    // an actual ASSERTION (subject STATE.md, immediately claiming to *be*
    // that phrase) from prose that merely discusses both terms without asserting the
    // claim — including this very file's own comments/rationale text and
    // the paired test's fixtures, which mention STATE.md and "single
    // source of truth" in the same sentence while explicitly describing
    // the REVOCATION, not restating the claim. Loose co-occurrence was
    // tried first and flagged this file's own doc comments — proof the
    // precision has to live in the regex, not in an exclude-list hack.
    //
    // The many legitimate occurrences measured in S06-PLAN §2
    // (forge-doctor.js, forge-items.js, forge-store-state.js,
    // forge-accounts.js, shared/forge-mcps.md, skills/forge-sweep/SKILL.md)
    // are about OTHER subjects being "the single source of truth" and
    // never have "STATE.md" immediately adjacent to the phrase — they
    // don't match this adjacency-scoped pattern either.
    // NOTE: no trailing \b after the copula group — "é" is not an ASCII
    // word character, so JS's \b (which only recognizes [A-Za-z0-9_] as
    // "word") never reports a boundary after it, silently failing to
    // match every Portuguese-copula case. Caught by R2's bite fixture.
    //
    // Two patterns, not one — evadable-by-rewording was itself the defect
    // the original single-copula regex carried (the same class of bug T02
    // diagnosed one step removed in its own \b/é bug). `patterns` (plural)
    // widens the CONNECTOR set within the same adjacency window, it does
    // not loosen adjacency into co-occurrence — the thing that was already
    // measured (comment at :53-55) to false-positive on this file's own
    // rationale text.
    //   - forwardPattern: STATE.md <connector> <=20 chars> "single source
    //     of truth" — connector now includes "remains", "continues to be",
    //     and appositive punctuation (em/en dash, colon), in addition to
    //     the original is/é/was/foi copulas. The punctuation-tolerance
    //     class also grew a `*` so Markdown bold (`**STATE.md**`) doesn't
    //     defeat the "immediately adjacent" requirement.
    //   - reversedPattern: "single source of truth" <=20 chars> <copula>
    //     STATE.md — the mirror-image assertion ("the single source of
    //     truth is STATE.md"), which the forward-only pattern could never
    //     reach regardless of connector set.
    patterns: [
      /\bSTATE\.md\b[`'"*)\]]*\s*(?:is|é|was|foi|remains|continues to be|—|–|:)\s*[^\n]{0,20}single source of truth/i,
      /single source of truth\s*[^\n]{0,20}?(?:is|é|was|foi)\s*STATE\.md\b/i,
    ],
    rationale:
      'The root .gsd/STATE.md is a generated projection (scripts/forge-dashboard.js ' +
      'renders it under a lock); it is not authoritative and must never be described ' +
      'as the single source of truth. Per-run M###-STATE.md is unaffected and remains ' +
      'a legitimate "source of truth for a single milestone run" (shared/forge-state.md §1).',
  },
];

// ── collectFiles — impure, in-process walk, no shell, no .gitignore ────────
//
// Walks `rootDir` recursively via fs.readdirSync. Reachable outcomes:
//   - `rootDir` does not exist → returns [] (caller sees scanned === 0 and
//     the anti-silence floor in scanClaims/checkTree turns that into a
//     failure, not a silent clean pass).
//   - `rootDir` exists but every entry is skipped (all dirs, all excluded)
//     → returns [] (same anti-silence outcome).
//   - Symlinks are not followed (lstat-free readdirSync default behavior
//     already avoids traversing into them as directories on most platforms;
//     we additionally guard with a try/catch per entry so a dangling
//     symlink or permission error on one entry never aborts the whole walk).
//
// Deliberately skipped directories (documented, not inferred):
//   - `.git`            — VCS internals, never documentation.
//   - `node_modules`    — third-party code, not this repo's claims.
//   - `app/.build`, `app/build` — Swift build artifacts, not documentation.
//   - `.gsd/`           — this repo's own dogfood/archaeology directory.
//     Explicit decision: this entire milestone discusses the STATE.md claim
//     INSIDE .gsd/ on purpose (plans, ROADMAP, CONTEXT all quote it as the
//     thing being revoked) — flagging that would be permanent, unfixable
//     noise, not a real violation.
//
// Everything else is walked, INCLUDING dotfiles and files listed in
// .gitignore (CLAUDE.md chief among them) — this scanner has no concept of
// .gitignore at all, which is the entire point.

const SKIP_DIRS = new Set(['.git', 'node_modules', '.build', 'build', '.gsd']);

function collectFiles(rootDir, opts) {
  opts = opts || {};
  const extFilter = opts.extensions || null; // e.g. ['.md', '.js'] or null = all
  const out = [];

  let rootStat;
  try {
    rootStat = fs.statSync(rootDir);
  } catch {
    return out; // rootDir does not exist — empty, not an error, floor catches it
  }
  if (!rootStat.isDirectory()) return out;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, don't abort the whole walk
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue; // skip symlinks/sockets/etc explicitly
      if (extFilter) {
        const ext = path.extname(entry.name);
        if (!extFilter.includes(ext)) continue;
      }
      out.push(full);
    }
  }

  walk(rootDir);
  return out;
}

// ── scanClaims — pure, testable with in-memory fixtures ────────────────────
//
// `files` is an array of paths (as collectFiles returns) OR an array of
// `{ path, content }` records (for in-memory fixtures in tests, avoiding
// disk I/O entirely). Reads from disk only when a record lacks `content`.
//
// Returns `{ scanned, violations: [{ file, line, claimId, text }] }`.
// `scanned` counts files actually examined — always reported, even when
// `violations` is empty, so "found nothing" and "scanned nothing" never
// collapse into the same shape.

function scanClaims(files, claims) {
  claims = claims || REVOKED_CLAIMS;
  const violations = [];
  let scanned = 0;

  for (const entry of files) {
    const filePath = typeof entry === 'string' ? entry : entry.path;
    let content;
    if (typeof entry === 'object' && typeof entry.content === 'string') {
      content = entry.content;
    } else {
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue; // unreadable — not scanned, not counted
      }
    }
    scanned++;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const claim of claims) {
        // Claims carry either a single `pattern` (legacy shape, still
        // supported) or a `patterns` array — any pattern matching is a hit.
        // Widening the connector set (R2) needed two independent regexes
        // (forward + reversed-order assertion) that cannot be expressed as
        // one RegExp without losing the readability that made the original
        // false-positive precision auditable in the first place.
        const candidates = Array.isArray(claim.patterns) ? claim.patterns : [claim.pattern];
        const hit = candidates.some((p) => p && p.test(line));
        if (!hit) continue;
        if (claim.coOccur && !claim.coOccur.test(line)) continue;
        violations.push({
          file: filePath,
          line: i + 1,
          claimId: claim.id,
          text: line.trim(),
        });
      }
    }
  }

  return { scanned, violations };
}

// ── Anti-silence guard ───────────────────────────────────────────────────
//
// A scanner that walked zero files and reports "clean" is exactly the
// broken detector this task exists to prevent (the ROADMAP demo criterion
// that was green before any work started). `checkTree` wraps collectFiles +
// scanClaims and fails whenever `scanned` is zero or below a conservative
// floor — regardless of whether violations were found.
//
// Reachable outcomes:
//   - rootDir missing / not a directory → scanned === 0 → ok: false, floor breach.
//   - rootDir exists but every file skipped/unreadable → scanned === 0 → same.
//   - scanned > 0 but below MIN_SCANNED_FLOOR (misconfigured root, e.g.
//     pointed at a near-empty subdirectory) → ok: false, floor breach.
//   - scanned >= floor and violations.length > 0 → ok: false, real violation.
//   - scanned >= floor and violations.length === 0 → ok: true, genuinely clean.

const MIN_SCANNED_FLOOR = 20;

function checkTree(rootDir, opts) {
  opts = opts || {};
  const floor = typeof opts.floor === 'number' ? opts.floor : MIN_SCANNED_FLOOR;
  const files = collectFiles(rootDir, opts);
  const { scanned, violations } = scanClaims(files, opts.claims);

  if (scanned === 0) {
    return {
      ok: false,
      scanned,
      violations,
      reason: `anti-silence floor: scanned 0 files under ${rootDir} — indistinguishable from a broken detector`,
    };
  }
  if (scanned < floor) {
    return {
      ok: false,
      scanned,
      violations,
      reason: `anti-silence floor: scanned ${scanned} files, below the conservative floor of ${floor}`,
    };
  }
  if (violations.length > 0) {
    return { ok: false, scanned, violations, reason: `${violations.length} revoked-claim violation(s)` };
  }
  return { ok: true, scanned, violations, reason: 'clean' };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { json: false, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--cwd') out.cwd = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = checkTree(args.cwd);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`scanned: ${result.scanned}`);
    if (result.violations.length === 0) {
      console.log(result.ok ? 'clean' : `FAIL: ${result.reason}`);
    } else {
      for (const v of result.violations) {
        console.log(`${v.file}:${v.line} [${v.claimId}] ${v.text}`);
      }
      console.log(`FAIL: ${result.reason}`);
    }
  }

  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  REVOKED_CLAIMS,
  collectFiles,
  scanClaims,
  checkTree,
  MIN_SCANNED_FLOOR,
};
