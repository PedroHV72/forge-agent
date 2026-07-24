#!/usr/bin/env node
// forge-routing.test.js — parser suite for readRoutingConfig (T01).
// Adversarial fixtures for the 3-level `routing:` block parser: broken
// indentation, tabs vs spaces, per-domain last-wins across the cascade,
// `fallback:` mid-tiers, block at END of file, inline `#` comments, and
// all-or-nothing degradation. Each scenario writes real prefs files into a
// fresh temp cascade (home > repo > local), invokes readRoutingConfig via
// require (in-process), asserts, and self-cleans. Exit 1 on any failure.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readRoutingConfig } = require('./forge-routing');

// M015 jsonc-only cut: production reads never parse legacy markdown routing
// blocks anymore (forge-prefs.js resolveLayer hard-stops on md-without-jsonc).
// The adversarial md-parser coverage below (tabs, CRLF, broken indentation,
// inline comments, blank lines, cascade merge...) still has value — it now
// lives on, and is exercised through, the SANCTIONED bridge module
// (forge-prefs-legacy.js legacyReadLayer, used by the migrator). This shim
// reproduces the exact same cascade/merge contract readRoutingConfig used to
// expose (present/ok/routing/error), built ONLY from sanctioned exports
// (legacyReadLayer + forge-prefs.js deepMerge) — never reimplementing parser
// logic here.
const { legacyReadLayer } = require('./forge-prefs-legacy.js');
const { deepMerge } = require('./forge-prefs.js');

function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function legacyRoutingConfig(cwd) {
  const homeFile = path.join(process.env.HOME, '.claude', 'forge-agent-prefs.md');
  const repoFile = path.join(cwd, '.gsd', 'claude-agent-prefs.md');
  const localFile = path.join(cwd, '.gsd', 'prefs.local.md');
  const globalLayer = legacyReadLayer([homeFile].filter(fileExists));
  const localLayer = legacyReadLayer([repoFile, localFile].filter(fileExists));
  if (globalLayer.routingMalformed || localLayer.routingMalformed) {
    return { present: true, ok: false, routing: {}, error: 'routing-parse-error' };
  }
  const merged = deepMerge(globalLayer.prefs, localLayer.prefs);
  const present = Object.prototype.hasOwnProperty.call(merged, 'routing');
  return { present, ok: true, routing: merged.routing || {}, error: null };
}

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
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

// Build an isolated cascade. Sets $HOME so os.homedir() (and therefore the
// home prefs path) resolves inside the temp root — fully deterministic.
function withCascade({ home = null, repo = null, local = null, homeJsonc = null, repoJsonc = null }, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-routing-test-'));
  const homeDir = path.join(root, 'home');
  const repoDir = path.join(root, 'repo');
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, '.gsd'), { recursive: true });
  if (home !== null) fs.writeFileSync(path.join(homeDir, '.claude', 'forge-agent-prefs.md'), home);
  if (repo !== null) fs.writeFileSync(path.join(repoDir, '.gsd', 'claude-agent-prefs.md'), repo);
  if (local !== null) fs.writeFileSync(path.join(repoDir, '.gsd', 'prefs.local.md'), local);
  if (homeJsonc !== null) fs.writeFileSync(path.join(homeDir, '.claude', 'forge-agent-prefs.jsonc'), homeJsonc);
  if (repoJsonc !== null) fs.writeFileSync(path.join(repoDir, '.gsd', 'forge-prefs.jsonc'), repoJsonc);

  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  try {
    return fn(repoDir);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

console.log('\n=== forge-routing.js — readRoutingConfig parser suite ===\n');

// --- Scenario 1: no routing block anywhere → compat path ---
console.log('Scenario 1: no routing block in the cascade');
withCascade({ repo: '# just prefs\ntier_models:\n  standard: claude-sonnet-5\n' }, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  test('present false', () => assertEq(r.present, false));
  test('ok true', () => assertEq(r.ok, true));
  test('routing empty', () => assertEq(r.routing, {}));
  test('error null', () => assertEq(r.error, null));
});

// --- Scenario 2: valid single domain (spaces) ---
console.log('\nScenario 2: valid single domain, space indentation');
withCascade({
  repo: 'routing:\n  backend:\n    executor:\n      standard: claude-sonnet-5\n      fallback: claude-sonnet-5\n    planner:\n      heavy: claude-opus-4-8\n',
}, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  test('present true, ok true', () => assert(r.present && r.ok, JSON.stringify(r)));
  test('backend.executor.standard parsed as list', () =>
    assertEq(r.routing.backend.executor.standard, ['claude-sonnet-5']));
  test('backend.executor.fallback scalar', () =>
    assertEq(r.routing.backend.executor.fallback, 'claude-sonnet-5'));
  test('backend.planner.heavy parsed', () =>
    assertEq(r.routing.backend.planner.heavy, ['claude-opus-4-8']));
});

// --- Scenario 3: tab indentation parses identically ---
console.log('\nScenario 3: tab indentation');
withCascade({
  repo: 'routing:\n\tbackend:\n\t\texecutor:\n\t\t\tstandard: claude-sonnet-5\n',
}, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  test('tabs parse ok', () => assert(r.ok && r.present, JSON.stringify(r)));
  test('tabbed value intact', () =>
    assertEq(r.routing.backend.executor.standard, ['claude-sonnet-5']));
});

// --- Scenario 4: broken nesting (dedent to unknown level) → all-or-nothing ---
console.log('\nScenario 4: broken indentation → routing-parse-error');
withCascade({
  repo: 'routing:\n  backend:\n    executor:\n      standard: claude-sonnet-5\n   planner:\n      heavy: claude-opus-4-8\n',
}, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  test('present true', () => assertEq(r.present, true));
  test('ok false', () => assertEq(r.ok, false));
  test('routing emptied (never partial)', () => assertEq(r.routing, {}));
  test('error routing-parse-error', () => assertEq(r.error, 'routing-parse-error'));
});

// --- Scenario 5: domain duplicated across cascade → last-wins whole domain ---
console.log('\nScenario 5: duplicate domain across cascade (last-wins per domain)');
withCascade({
  repo: 'routing:\n  backend:\n    executor:\n      standard: claude-sonnet-5\n    planner:\n      heavy: claude-opus-4-8\n',
  local: 'routing:\n  backend:\n    executor:\n      standard: gpt-5\n',
}, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  test('ok true', () => assert(r.ok, JSON.stringify(r)));
  test('local domain replaces repo domain entirely', () =>
    assertEq(r.routing.backend, { executor: { standard: ['gpt-5'] } }));
  test('repo planner NOT merged in (whole-domain replace)', () =>
    assertEq(r.routing.backend.planner, undefined));
});

// --- Scenario 6: fallback in the middle of tiers → still valid ---
console.log('\nScenario 6: fallback: between tier keys');
withCascade({
  repo: 'routing:\n  backend:\n    executor:\n      standard: claude-sonnet-5\n      fallback: claude-sonnet-5\n      heavy: claude-opus-4-8\n',
}, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  test('ok true', () => assert(r.ok, JSON.stringify(r)));
  test('fallback captured mid-tiers', () =>
    assertEq(r.routing.backend.executor.fallback, 'claude-sonnet-5'));
  test('tiers around fallback intact', () => {
    assertEq(r.routing.backend.executor.standard, ['claude-sonnet-5']);
    assertEq(r.routing.backend.executor.heavy, ['claude-opus-4-8']);
  });
});

// --- Scenario 7: routing block at END of file, no trailing newline ---
console.log('\nScenario 7: block at end of file (\\Z-class regression)');
withCascade({
  repo: 'tier_models:\n  standard: claude-sonnet-5\n\nrouting:\n  default:\n    executor:\n      standard: claude-sonnet-5',
}, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  test('trailing block captured', () => assert(r.ok && r.present, JSON.stringify(r)));
  test('default domain parsed', () =>
    assertEq(r.routing.default.executor.standard, ['claude-sonnet-5']));
});

// --- Scenario 8: inline # comments + inline list value ---
console.log('\nScenario 8: inline comments and inline list values');
withCascade({
  repo: 'routing:\n  backend:  # backend domain\n    executor:\n      standard: [claude-sonnet-5, gpt-5]  # mixed cell\n      fallback: claude-sonnet-5 # net\n',
}, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  test('ok true', () => assert(r.ok, JSON.stringify(r)));
  test('inline list → array, comment stripped', () =>
    assertEq(r.routing.backend.executor.standard, ['claude-sonnet-5', 'gpt-5']));
  test('scalar comment stripped', () =>
    assertEq(r.routing.backend.executor.fallback, 'claude-sonnet-5'));
});

// --- Scenario 9: all-or-nothing — one malformed file poisons the cascade ---
console.log('\nScenario 9: malformed file in cascade poisons whole cascade');
withCascade({
  repo: 'routing:\n  backend:\n    executor:\n      standard: claude-sonnet-5\n',
  local: 'routing:\n  frontend:\n      standard: gpt-5\n', // phase level skipped
}, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  test('present true', () => assertEq(r.present, true));
  test('ok false (never partial across files)', () => assertEq(r.ok, false));
  test('routing empty', () => assertEq(r.routing, {}));
  test('error routing-parse-error', () => assertEq(r.error, 'routing-parse-error'));
});

// --- Scenario 10: cascade merge of DIFFERENT domains (home + repo) ---
console.log('\nScenario 10: different domains merge across cascade');
withCascade({
  home: 'routing:\n  default:\n    executor:\n      standard: claude-sonnet-5\n',
  repo: 'routing:\n  backend:\n    planner:\n      heavy: claude-opus-4-8\n',
}, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  test('ok true', () => assert(r.ok, JSON.stringify(r)));
  test('home default domain present', () =>
    assertEq(r.routing.default.executor.standard, ['claude-sonnet-5']));
  test('repo backend domain present', () =>
    assertEq(r.routing.backend.planner.heavy, ['claude-opus-4-8']));
});

// --- Scenario 11: nesting too deep (level 4) → malformed ---
console.log('\nScenario 11: excessive nesting depth');
withCascade({
  repo: 'routing:\n  backend:\n    executor:\n      standard:\n        extra: claude-sonnet-5\n',
}, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  test('depth>3 → ok false', () => assertEq(r.ok, false));
  test('error routing-parse-error', () => assertEq(r.error, 'routing-parse-error'));
});

// --- Scenario 12: blank line between two domains inside the block ---
console.log('\nScenario 12: blank line between two domains does not truncate the block');
withCascade({
  repo:
    'routing:\n' +
    '  backend:\n' +
    '    executor:\n' +
    '      standard: claude-sonnet-5\n' +
    '\n' +
    '  frontend:\n' +
    '    executor:\n' +
    '      standard: claude-opus-4-8\n',
}, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  test('ok true', () => assert(r.ok, JSON.stringify(r)));
  test('present true', () => assertEq(r.present, true));
  test('backend domain parsed', () =>
    assertEq(r.routing.backend.executor.standard, ['claude-sonnet-5']));
  test('frontend domain parsed (past the blank line)', () =>
    assertEq(r.routing.frontend.executor.standard, ['claude-opus-4-8']));
});

// --- Scenario 13: blank-line block followed by another top-level key ---
console.log('\nScenario 13: blank-line block does not swallow a following top-level key');
withCascade({
  repo:
    'routing:\n' +
    '  backend:\n' +
    '    executor:\n' +
    '      standard: claude-sonnet-5\n' +
    '\n' +
    '  frontend:\n' +
    '    executor:\n' +
    '      standard: claude-opus-4-8\n' +
    '\n' +
    'review:\n' +
    '  mode: dialectic\n',
}, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  test('ok true', () => assert(r.ok, JSON.stringify(r)));
  test('backend domain parsed', () =>
    assertEq(r.routing.backend.executor.standard, ['claude-sonnet-5']));
  test('frontend domain parsed', () =>
    assertEq(r.routing.frontend.executor.standard, ['claude-opus-4-8']));
  test('no stray "review" domain captured', () =>
    assert(!Object.prototype.hasOwnProperty.call(r.routing, 'review'), JSON.stringify(r.routing)));
});

// --- Scenario 14: CRLF line endings parse identically to LF ---
console.log('\nScenario 14: CRLF routing block parses identically to the LF equivalent');
withCascade({
  repo:
    'routing:\r\n' +
    '  backend:\r\n' +
    '    executor:\r\n' +
    '      standard: claude-sonnet-5\r\n' +
    '      fallback: claude-opus-4-8\r\n',
}, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  test('ok true', () => assert(r.ok, JSON.stringify(r)));
  test('present true', () => assertEq(r.present, true));
  test('backend cell parsed', () =>
    assertEq(r.routing.backend.executor.standard, ['claude-sonnet-5']));
  test('fallback parsed', () =>
    assertEq(r.routing.backend.executor.fallback, 'claude-opus-4-8'));
});

// --- Scenario 15: cutover goldens (engine adapter contract) ---
console.log('\nScenario 15: engine adapter preserves golden routing objects');
withCascade({
  home:
    'routing:\n' +
    '  backend:\n' +
    '    executor:\n' +
    '      standard: [global, global-fallback] # ignored comment\n',
  repo:
    'routing:\n' +
    '  backend:\n' +
    '    planner:\n' +
    '      heavy: repo-planner\n' +
    '  default:\n' +
    '    executor:\n' +
    '      standard: default-model\n',
  local:
    'routing:\n' +
    '  backend:\n' +
    '    executor:\n' +
    '      standard: local-model\n' +
    '      fallback: local-fallback\n',
}, (cwd) => {
  const r = legacyRoutingConfig(cwd);
  const golden = {
    backend: { executor: { standard: ['local-model'], fallback: 'local-fallback' } },
    default: { executor: { standard: ['default-model'] } },
  };
  test('Markdown cascade golden retains atomic last-wins domain replacement', () =>
    assertEq(r, { present: true, ok: true, routing: golden, error: null }));
});

withCascade({
  repoJsonc: '{\n  // JSONC reaches the same adapter contract\n  "routing": {\n    "backend": { "executor": { "standard": ["jsonc-model"], "fallback": "jsonc-fallback" } }\n  }\n}',
}, (cwd) => {
  test('JSONC routing golden flows through the same contract', () =>
    assertEq(readRoutingConfig(cwd), {
      present: true,
      ok: true,
      routing: { backend: { executor: { standard: ['jsonc-model'], fallback: 'jsonc-fallback' } } },
      error: null,
    }));
});

withCascade({
  repo: 'routing:\n  backend:\n      executor:\n    standard: broken\n',
}, (cwd) => {
  test('malformed-block golden degrades the whole cascade', () =>
    assertEq(legacyRoutingConfig(cwd), {
      present: true, ok: false, routing: {}, error: 'routing-parse-error',
    }));
});

// --- Composite model IDs and walk termination -------------------------------
// Regression: a list written as ONE string ("claude-fable-5, claude-opus-5" —
// the comma inside the quotes) used to reach modelToAlias, whose substring
// match happily returned `fable`, so the rest of the chain vanished and a
// model nobody chose got dispatched. Seen in the wild both in routing cells and
// in a T##-PLAN frontmatter `worker:`.
{
  const { resolveRoute } = require('./forge-routing');
  const { modelToAlias, isMalformedId } = require('./forge-model-alias');

  test('composite id is not mapped to a plausible alias', () => {
    assertEq(modelToAlias('claude-fable-5, claude-opus-5'), { alias: null, mapped: false });
    assertEq(modelToAlias('gpt-5.6-terra, claude-opus-5'), { alias: null, mapped: false });
  });
  test('a legitimate id with surrounding whitespace still maps', () =>
    assertEq(modelToAlias('  claude-sonnet-5  '), { alias: 'sonnet', mapped: true }));
  test('the [1m] suffix is not treated as malformed', () =>
    assert(isMalformedId('claude-opus-4-8[1m]') === false));

  test('a composite frontmatter worker is skipped, not dispatched', () => {
    const r = resolveRoute({
      unitType: 'execute-task', tier: 'heavy',
      frontmatterWorker: 'gpt-5.6-terra, claude-opus-5', cwd: process.cwd(),
    });
    assertEq(r.chain, [], 'no chain member may carry a composite id');
    assert(/skipped-malformed-id/.test(r.reason), `reason must surface the skip: ${r.reason}`);
  });
}

// Regression: the category fallback defaults to the tier head, so the raw walk
// order repeated an id. --next-after then never returned '' and the Failure
// Taxonomy's "chain exhausted → stop the loop" branch was unreachable.
{
  const { parseArgs, nextInChain } = require('./forge-routing');
  // Bounded walk: before the fix this loop would run out its 8 iterations
  // instead of ending, which is exactly what `ended` asserts against.
  const walk = (chain, fallback, start) => {
    const seen = [];
    let cur = start;
    for (let i = 0; i < 8 && cur; i++) {
      seen.push(cur);
      cur = nextInChain(chain, fallback, cur);
    }
    return { seen, ended: !cur };
  };
  const member = (id) => ({ id });

  test('single-member chain whose fallback repeats it terminates', () => {
    const r = walk([member('claude-fable-5')], { id: 'claude-fable-5' }, 'claude-fable-5');
    assertEq(r.seen, ['claude-fable-5']);
    assert(r.ended, 'walk must exhaust instead of handing back the same model');
  });
  test('two-member chain does not ping-pong through the fallback', () => {
    const r = walk(
      [member('claude-fable-5'), member('claude-opus-5')],
      { id: 'claude-fable-5' }, 'claude-fable-5'
    );
    assertEq(r.seen, ['claude-fable-5', 'claude-opus-5']);
    assert(r.ended, 'walk must exhaust after the last distinct member');
  });
  test('a fallback outside the chain is still walked once', () => {
    const r = walk([member('claude-fable-5')], { id: 'claude-opus-5' }, 'claude-fable-5');
    assertEq(r.seen, ['claude-fable-5', 'claude-opus-5']);
    assert(r.ended);
  });
  test('parseArgs still reads --next-after', () =>
    assertEq(parseArgs(['--next-after', 'claude-opus-5']).nextAfter, 'claude-opus-5'));
}

// --- Summary ---
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`      ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
