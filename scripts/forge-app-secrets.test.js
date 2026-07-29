#!/usr/bin/env node
'use strict';

// forge-app-secrets.test.js — standing regression guard for the secrets vault:
// "the engine is the only thing that writes a secret".
//
// WHY THIS GUARD EXISTS
// ---------------------
// SecretsView.swift used to write the value itself with SecItemAdd before
// calling the engine, on the reasoning that the framework call kept the secret
// out of argv. That reasoning is wrong — the engine's `security
// add-generic-password` needs the value in `-w` and ran immediately afterwards
// regardless — so the write avoided no exposure whatsoever. What it did do was
// create a Keychain item whose ACL trusts the creating binary's code
// signature. This app is ad-hoc signed, so its cdhash changes on every
// rebuild, and every later read by `security(1)` came from an "unknown"
// binary: macOS prompted for authorisation, again and again.
//
// The reason this needs a guard rather than a code review is that reintroducing
// it LOOKS like a security improvement, and the damage is invisible from the
// code: nothing fails, no test goes red, no error is logged. The bug shows up
// days later as a dialog that will not stop appearing, on a machine, for one
// user — arbitrarily far from the commit that caused it. So the invariant is
// pinned here instead of relearned.
//
// Like forge-app-items.test.js (the mold this is copied from), this suite is
// pure file reading — no swift invocation — so it NEVER skips and runs on
// every platform, including CI.
//
// Zero deps, standalone runner (repo convention): exit != 0 on any failure.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const appSourcesDir = path.join(repoRoot, 'app', 'Sources');
const secretsViewPath = path.join(appSourcesDir, 'Forge', 'SecretsView.swift');

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

console.log('\n=== forge app secrets write path ===\n');

// A missing app dir is a real problem in this repo, not a platform difference,
// so we fail loudly rather than skip.
if (!fs.existsSync(appSourcesDir)) {
  console.error(`✗ app/Sources/ not found at ${appSourcesDir} — this repo always has it; refusing to skip.`);
  process.exit(1);
}

function listSwiftFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSwiftFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.swift')) out.push(full);
  }
  return out;
}

// Strip `//` line comments before matching. SecretsView.swift's header
// discusses SecItemAdd on purpose — explaining why it was removed is exactly
// how this stays understood — so only a real code reference must fail.
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

check('SecretsView.swift exists', () => {
  assert(fs.existsSync(secretsViewPath), `not found: ${path.relative(repoRoot, secretsViewPath)}`);
});

// --- No app-side secret write anywhere in the app ------------------------

check('no Swift source writes a secret through the Security framework', () => {
  // Scanned across all of app/Sources/, not just SecretsView.swift: moving the
  // write into a helper elsewhere would be the obvious way to reintroduce it.
  const forbidden = ['SecItemAdd', 'SecItemUpdate', 'kSecValueData', 'import Security'];
  const hits = [];
  for (const file of listSwiftFiles(appSourcesDir)) {
    for (const pattern of forbidden) {
      hits.push(...findForbiddenPattern(file, pattern));
    }
  }
  assert(
    hits.length === 0,
    'Security-framework secret write found in app/Sources/ — the engine ' +
      '(scripts/forge-secrets.js) must be the only writer. An item created by the app carries ' +
      'an ACL bound to the ad-hoc cdhash, which changes every rebuild and makes macOS prompt ' +
      'on every later read:\n' + hits.map(h => `    ${h}`).join('\n')
  );
});

// --- The write path still exists ------------------------------------------

check('SecretsStore.add writes through the engine via ForgeCore.runWithInput', () => {
  // Without this, deleting the engine call along with the framework write
  // would satisfy the guard above while making add() store nothing at all.
  const src = fs.readFileSync(secretsViewPath, 'utf8');
  assert(src.includes('forge-secrets.js'),
    'SecretsView.swift does not reference forge-secrets.js — the vault may be unwired');
  assert(src.includes('ForgeCore.runWithInput'),
    'SecretsView.swift does not call ForgeCore.runWithInput — the secret write path is gone; ' +
    'add() would register metadata with no value behind it');
});

check('the header explains the removal instead of leaving it to be rediscovered', () => {
  const src = fs.readFileSync(secretsViewPath, 'utf8');
  assert(!/\bSAFER\b/.test(src),
    'SecretsView.swift still claims the app path is SAFER than the CLI — it is not: the engine ' +
    'passes the value in argv (-w) either way');
});

// --- The matcher bites, in both directions --------------------------------

check('guard actually bites — a real (non-comment) framework write is detected', () => {
  const fakeAdd = '        let status = SecItemAdd(insert as CFDictionary, nil)';
  assert(stripLineComments(fakeAdd).includes('SecItemAdd'),
    'matcher failed to catch a real, non-comment SecItemAdd reference');
  const fakeUpdate = '        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)';
  assert(stripLineComments(fakeUpdate).includes('SecItemUpdate'),
    'matcher failed to catch a real, non-comment SecItemUpdate reference');
  const fakeData = '        insert[kSecValueData as String] = data';
  assert(stripLineComments(fakeData).includes('kSecValueData'),
    'matcher failed to catch a real, non-comment kSecValueData reference');
  const fakeImport = 'import Security';
  assert(stripLineComments(fakeImport).includes('import Security'),
    'matcher failed to catch a real, non-comment import Security');
});

check('guard does not bite comments — the header may name what it removed', () => {
  const commentAdd = '// through the Security framework (SecItemAdd), which is why the prompt appeared';
  assert(!stripLineComments(commentAdd).includes('SecItemAdd'),
    'matcher incorrectly flagged a comment-only SecItemAdd mention');
  const commentImport = '// import Security is deliberately absent — see the header';
  assert(!stripLineComments(commentImport).includes('import Security'),
    'matcher incorrectly flagged a comment-only import Security mention');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
