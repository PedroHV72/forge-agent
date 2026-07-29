#!/usr/bin/env node
'use strict';

// forge-keychain-switch.test.js — standing regression guard:
// "no test run can reach the real macOS `security` binary".
//
// WHY THIS GUARD EXISTS
// ---------------------
// run-tests.js isolates HOME. `security` resolves the login keychain THROUGH
// HOME, so under a temp HOME there is no login.keychain-db to write into — and
// rather than failing, `security add-generic-password` raises a MODAL dialog
// ("Chaves Não Encontradas") and blocks until a human answers. The call's
// timeout then SIGTERMs it and leaves the window orphaned on screen. Measured
// 2026-07-29: 249 dialogs in 3 hours, in bursts of 8–13 per minute — one per
// assertion that touched the vault.
//
// This needs a guard rather than a code review because the failure is invisible
// from the code and from CI. Nothing goes red: the suite still passes, the
// engine's fallback still stores the value, the timeout still fires. The damage
// lands on ONE machine — the operator's — as dialogs arriving hours later, with
// no line in any log tying them to the commit that caused it. Diagnosing it the
// first time took a day and a JSONL instrumentation layer. So the invariant is
// pinned here instead of relearned.
//
// The invariant has two halves and both are guarded:
//   1. Every Keychain branch in both engines consults keychainEnabled().
//   2. run-tests.js sets FORGE_KEYCHAIN_DISABLED=1 for every child it spawns.
// Breaking either one alone restores the bug, so neither may be assumed.
//
// Like forge-app-secrets.test.js (the mold), this is pure file reading plus one
// in-process call — no spawning, no `security`, no swift — so it NEVER skips
// and runs on every platform, including CI.
//
// Zero deps, standalone runner (repo convention): exit != 0 on any failure.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const ENGINES = [
  path.join(__dirname, 'forge-secrets.js'),
  path.join(__dirname, 'forge-accounts.js'),
];
const RUN_TESTS = path.join(__dirname, 'run-tests.js');
const SWITCH = path.join(__dirname, 'forge-keychain-switch.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\n=== keychain kill-switch — the suite cannot reach `security` ===\n');

// ── Matching that ignores prose ──────────────────────────────────────────────
// Both engines discuss `security` and the switch at length in comments — that
// discussion is how this stays understood, and it must never satisfy or trip a
// matcher. A naive regex over raw source already produced one false proof in
// this codebase, so comments are stripped before anything is matched.
function stripComments(source) {
  return source
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      const hash = line.indexOf('#');
      const cut = [idx, hash].filter((i) => i !== -1).sort((a, b) => a - b)[0];
      return cut === undefined ? line : line.slice(0, cut);
    })
    .join('\n');
}

/// Split a file into top-level `function name(...) { ... }` blocks by brace
/// depth. Crude on purpose: it only has to be right about which `security`
/// call sits in which function, and a miscount can only merge blocks (making
/// the guard more permissive in a way the call-site count below would catch).
function functionBlocks(source) {
  const lines = source.split('\n');
  const blocks = [];
  let current = null;
  let depth = 0;
  lines.forEach((line, i) => {
    const start = /^function\s+([A-Za-z0-9_$]+)\s*\(/.exec(line);
    if (start && depth === 0) current = { name: start[1], line: i + 1, body: [] };
    if (current) current.body.push(line);
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (current && depth === 0 && current.body.length > 0 && line.includes('}')) {
      blocks.push({ ...current, body: current.body.join('\n') });
      current = null;
    }
  });
  return blocks;
}

const SECURITY_CALL = /execFileSync\(\s*['"]security['"]/;

// ── Half 1: every call site is gated ─────────────────────────────────────────

check('the shared predicate exists and is the two-part test it claims to be', () => {
  assert(fs.existsSync(SWITCH), `${path.relative(repoRoot, SWITCH)} is missing`);
  const { keychainEnabled, DISABLE_ENV } = require('./forge-keychain-switch.js');
  assert(DISABLE_ENV === 'FORGE_KEYCHAIN_DISABLED',
    `the opt-out variable was renamed to ${DISABLE_ENV} — run-tests.js and every doc reference must follow`);

  const prev = process.env[DISABLE_ENV];
  try {
    process.env[DISABLE_ENV] = '1';
    assert(keychainEnabled() === false,
      'FORGE_KEYCHAIN_DISABLED=1 must disable the Keychain on every platform');
    delete process.env[DISABLE_ENV];
    assert(keychainEnabled() === (process.platform === 'darwin'),
      'with the variable unset the predicate must be exactly the old platform test — production behaviour may not change');
  } finally {
    if (prev === undefined) delete process.env[DISABLE_ENV];
    else process.env[DISABLE_ENV] = prev;
  }
});

check('the predicate is read at call time, never cached at require time', () => {
  // A module-level `const enabled = ...` would snapshot the variable before a
  // suite that sets it later could speak, and the snapshot would be silently
  // wrong for the whole process.
  const src = stripComments(fs.readFileSync(SWITCH, 'utf8'));
  const fnBody = /function keychainEnabled\(\)\s*\{([\s\S]*?)\n\}/.exec(src);
  assert(fnBody, 'keychainEnabled() is no longer a plain function declaration');
  assert(/process\.env/.test(fnBody[1]),
    'keychainEnabled() must read process.env inside the function body, not from a cached constant');
});

for (const engine of ENGINES) {
  const rel = path.relative(repoRoot, engine);
  const src = stripComments(fs.readFileSync(engine, 'utf8'));

  check(`${rel} routes every \`security\` call through the kill-switch`, () => {
    const callSites = src.split('\n').filter((l) => SECURITY_CALL.test(l)).length;
    assert(callSites > 0,
      `no \`security\` call found in ${rel} — if the engine stopped using it, delete this half of the guard deliberately`);

    const offenders = functionBlocks(src)
      .filter((b) => SECURITY_CALL.test(b.body))
      .filter((b) => !/keychainEnabled\(\)/.test(b.body))
      .map((b) => `${rel}:${b.line} ${b.name}()`);

    assert(offenders.length === 0,
      `these functions spawn \`security\` without consulting keychainEnabled():\n        ${offenders.join('\n        ')}\n      A test run would reach the real Keychain and raise modal dialogs.`);
  });

  check(`${rel} has no bare platform check left guarding a \`security\` call`, () => {
    // `if (IS_DARWIN)` around a Keychain branch is the exact shape that caused
    // the bug: true under the test runner, so the branch is taken.
    const blocks = functionBlocks(src).filter((b) => SECURITY_CALL.test(b.body));
    const offenders = blocks
      .filter((b) => /if\s*\(\s*IS_DARWIN\s*\)/.test(b.body))
      .map((b) => `${rel}:${b.line} ${b.name}()`);
    assert(offenders.length === 0,
      `bare IS_DARWIN guard around a \`security\` call in:\n        ${offenders.join('\n        ')}`);
  });
}

// ── Half 2: the runner disables it ───────────────────────────────────────────

check('run-tests.js disables the Keychain for isolated-HOME children', () => {
  // Called, not grepped: this asserts the value a child actually receives.
  const { childEnv } = require('./run-tests.js');
  assert(typeof childEnv === 'function',
    'run-tests.js no longer exports childEnv — the runner-side half of this guard cannot be checked');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'kcswitch-'));
  try {
    const env = childEnv(tmp, 'sample.test.js');
    assert(env.FORGE_KEYCHAIN_DISABLED === '1',
      `run-tests.js must set FORGE_KEYCHAIN_DISABLED=1 for isolated children; got ${JSON.stringify(env.FORGE_KEYCHAIN_DISABLED)}`);
    assert(env.HOME && env.HOME.startsWith(tmp),
      'isolated children must still get an isolated HOME');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('run-tests.js disables the Keychain for --inherit-home children too', () => {
  // Inheriting the real HOME makes the calls succeed instead of hang — which is
  // worse in one way: a test suite silently writing into the operator's real
  // keychain. The switch is not conditional on isolation.
  const { childEnv } = require('./run-tests.js');
  const env = childEnv(null, 'sample.test.js');
  assert(env.FORGE_KEYCHAIN_DISABLED === '1',
    `--inherit-home children must be disabled as well; got ${JSON.stringify(env.FORGE_KEYCHAIN_DISABLED)}`);
});

// ── The matcher itself ───────────────────────────────────────────────────────

check('matcher bites a real, non-comment call site', () => {
  const real = [
    'function storeSecret(service, name, secret) {',
    '  if (IS_DARWIN) {',
    "    execFileSync('security', ['add-generic-password']);",
    '  }',
    '}',
  ].join('\n');
  const blocks = functionBlocks(stripComments(real)).filter((b) => SECURITY_CALL.test(b.body));
  assert(blocks.length === 1, 'matcher failed to find a real security call site');
  assert(!/keychainEnabled\(\)/.test(blocks[0].body),
    'matcher failed to notice the missing kill-switch consultation');
  assert(/if\s*\(\s*IS_DARWIN\s*\)/.test(blocks[0].body),
    'matcher failed to notice the bare platform guard');
});

check('matcher does not bite a mention inside a comment', () => {
  // This is the false proof the codebase already produced once: a guard that
  // reads its own explanatory prose as if it were code.
  const commented = [
    'function storeSecret(service, name, secret) {',
    "  // execFileSync('security', ...) used to run here under if (IS_DARWIN)",
    '  if (keychainEnabled()) {',
    "    execFileSync('security', ['add-generic-password']);",
    '  }',
    '}',
  ].join('\n');
  const stripped = stripComments(commented);
  const blocks = functionBlocks(stripped).filter((b) => SECURITY_CALL.test(b.body));
  assert(blocks.length === 1, 'matcher lost the real call site while stripping comments');
  assert(/keychainEnabled\(\)/.test(blocks[0].body),
    'matcher failed to see the kill-switch consultation');
  assert(!/if\s*\(\s*IS_DARWIN\s*\)/.test(blocks[0].body),
    'matcher read a commented-out IS_DARWIN guard as if it were code — the exact false positive this strip exists to prevent');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
