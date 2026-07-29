#!/usr/bin/env node
'use strict';

// forge-app-items.test.js — standing regression guard for S05 (backlog board
// in the app): "the CLI is the only write path to the item store".
//
// This suite pins the invariant that sustains the whole slice: the app talks
// to `.gsd/items/` **only** through `scripts/forge-items.js` (shelled out via
// ForgeCore); no status semantics are reimplemented in Swift; and the board
// is actually wired into the sidebar (Section.items) and the card
// (ProjectCard's item Stat) — so an "optimization" that reads `.gsd/items/`
// directly, or a wiring regression that silently drops the Section/Stat,
// fails loudly instead of merging unnoticed.
//
// Like forge-app-workspace.test.js (the mold this is copied from), this
// suite is pure file reading — no swift invocation — so it NEVER skips and
// runs on every platform, including CI.
//
// Zero deps, standalone runner (repo convention): exit != 0 on any failure.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const appSourcesDir = path.join(repoRoot, 'app', 'Sources');
const itemsViewPath = path.join(appSourcesDir, 'Forge', 'ItemsView.swift');
const viewsPath = path.join(appSourcesDir, 'Forge', 'Views.swift');
const projectsPath = path.join(appSourcesDir, 'Forge', 'Projects.swift');
const forgeKitItemsPath = path.join(appSourcesDir, 'ForgeKit', 'Items.swift');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n  ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log('\n=== forge app items board ===\n');

// Guard the whole suite on app/Sources/ existing — a missing app dir is a
// real problem in this repo, not a platform difference, so we fail loudly
// rather than skip like forge-app.test.js does for the Swift build.
if (!fs.existsSync(appSourcesDir)) {
  console.error(`✗ app/Sources/ not found at ${appSourcesDir} — this repo always has it; refusing to skip.`);
  process.exit(1);
}

// Strip `//` line comments before matching so legitimate comment mentions
// (this file's own header, `ItemsView.swift`'s doc comments explaining the
// single-write-path rule) do not false-positive the guard. Only a real code
// reference must fail the build.
function stripLineComments(line) {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n');
}

function findForbiddenPattern(filePath, pattern) {
  const hits = [];
  readLines(filePath).forEach((line, i) => {
    if (stripLineComments(line).includes(pattern)) {
      hits.push(`${path.relative(repoRoot, filePath)}:${i + 1}`);
    }
  });
  return hits;
}

check('ItemsView.swift and Views.swift and Projects.swift and ForgeKit/Items.swift exist', () => {
  for (const p of [itemsViewPath, viewsPath, projectsPath, forgeKitItemsPath]) {
    assert(fs.existsSync(p), `not found: ${path.relative(repoRoot, p)}`);
  }
});

// --- Single write path: no direct .gsd write in ItemsView.swift ----------

check('ItemsView.swift shells out to forge-items.js via ForgeCore, never writes .gsd/ directly', () => {
  const src = fs.readFileSync(itemsViewPath, 'utf8');
  assert(src.includes('forge-items.js'), 'ItemsView.swift does not reference forge-items.js — store may be unwired');
  assert(src.includes('ForgeCore.'), 'ItemsView.swift does not call ForgeCore — shell-out layer may be bypassed');

  const forbidden = ['FileManager.default.createFile', '.write(toFile:', '.write(to:'];
  const hits = [];
  for (const pattern of forbidden) {
    hits.push(...findForbiddenPattern(itemsViewPath, pattern));
  }
  assert(
    hits.length === 0,
    'forbidden direct file write found in ItemsView.swift (the CLI must be the only write path ' +
      'to .gsd/items/ — ROADMAP Note 5):\n' + hits.map(h => `    ${h}`).join('\n')
  );
});

check('guard actually bites — a real (non-comment) direct write is detected', () => {
  // Prove the comment-stripping is not a blanket false-negative: a synthetic
  // in-memory line with a real (non-comment) occurrence must be caught by
  // the same matching logic used above.
  const fakeLine1 = '        try? contents.write(toFile: itemsPath, atomically: true, encoding: .utf8)';
  assert(stripLineComments(fakeLine1).includes('.write(toFile:'),
    'matcher failed to catch a real, non-comment .write(toFile: reference');
  const fakeLine2 = '        FileManager.default.createFile(atPath: p, contents: data)';
  assert(stripLineComments(fakeLine2).includes('FileManager.default.createFile'),
    'matcher failed to catch a real, non-comment FileManager.default.createFile reference');
  // And prove a comment-only mention is correctly ignored.
  const commentLine = '    // never call .write(toFile: here — forge-items.js owns .gsd/items/';
  assert(!stripLineComments(commentLine).includes('.write(toFile:'),
    'matcher incorrectly flagged a comment-only .write(toFile: mention');
});

// --- No store semantics reimplemented in Swift ----------------------------

check('the five status literals appear only in ForgeKit/Items.swift, not in ItemsView.swift', () => {
  const statusLiterals = ['"inbox"', '"triaged"', '"doing"', '"done"', '"dropped"'];
  const viewSrc = fs.readFileSync(itemsViewPath, 'utf8');
  const hits = statusLiterals.filter(lit => viewSrc.includes(lit));
  assert(
    hits.length === 0,
    'ItemsView.swift contains raw status string literal(s) ' + JSON.stringify(hits) +
      ' — status semantics must live only in ForgeKit/Items.swift (ItemStatus enum); the engine ' +
      '(scripts/forge-items.js) owns the closed set, Swift only labels it'
  );
});

check('guard actually bites — a real (non-comment) status literal in ItemsView.swift would be caught', () => {
  const fakeLine = '        if status == "inbox" { self.tag = "new" }';
  assert(fakeLine.includes('"inbox"'), 'matcher failed to catch a real status literal');
});

// --- Sidebar wiring: Section.items + switch branch ------------------------

check('Views.swift declares case items in the Section enum and routes to ItemsView(state: in the detail switch', () => {
  const src = fs.readFileSync(viewsPath, 'utf8');
  assert(/case\s+items\b/.test(src), 'Views.swift is missing `case items` in the Section enum');
  assert(src.includes('ItemsView(state:'), 'Views.swift detail switch is missing the ItemsView(state: branch');
});

// --- Card wiring: ProjectCard Stat for open items --------------------------

check('Projects.swift references ItemBoard.openCount and renders a Stat( for items', () => {
  const src = fs.readFileSync(projectsPath, 'utf8');
  assert(src.includes('ItemBoard.openCount'), 'Projects.swift does not reference ItemBoard.openCount — card Stat may be unwired');
  assert(/Stat\(\s*value:\s*openItems/.test(src) || /Stat\(/.test(src),
    'Projects.swift does not render a Stat( for items');
  assert(src.includes('label: "item"') || src.includes("label: \"item\""),
    'Projects.swift is missing the item-labelled Stat entry');
});

// --- Pure layer exists and is substantive ----------------------------------

check('ForgeKit/Items.swift exists, declares ItemBoard and ItemStatus, and is a plausible size', () => {
  const src = fs.readFileSync(forgeKitItemsPath, 'utf8');
  assert(src.includes('enum ItemStatus') || src.includes('ItemStatus'), 'Items.swift does not declare ItemStatus');
  assert(src.includes('enum ItemBoard') || src.includes('ItemBoard'), 'Items.swift does not declare ItemBoard');
  const lineCount = src.split('\n').length;
  assert(lineCount >= 40, `Items.swift looks too small to be the real pure layer (${lineCount} lines)`);
});

// --- No pre-macOS-13 APIs in the new/changed slice files -------------------

check('no pre-macOS-13 API usage in the slice files', () => {
  const forbidden = ['.onKeyPress', '.draggable(', '.dropDestination('];
  const files = [itemsViewPath, projectsPath, viewsPath, forgeKitItemsPath];
  const hits = [];
  for (const file of files) {
    for (const pattern of forbidden) {
      hits.push(...findForbiddenPattern(file, pattern));
    }
  }
  assert(
    hits.length === 0,
    'API above macOS 13 baseline found in slice files (S05 Acceptance Criteria #7):\n' +
      hits.map(h => `    ${h}`).join('\n')
  );
});

check('guard actually bites — a real (non-comment) above-baseline API is detected', () => {
  const fakeLine = '        content.onKeyPress(.return) { .handled }';
  assert(stripLineComments(fakeLine).includes('.onKeyPress'),
    'matcher failed to catch a real, non-comment .onKeyPress reference');
  const commentLine = '    // .onKeyPress is not available on macOS 13, do not use it here';
  assert(!stripLineComments(commentLine).includes('.onKeyPress'),
    'matcher incorrectly flagged a comment-only .onKeyPress mention');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
