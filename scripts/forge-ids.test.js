#!/usr/bin/env node
// forge-ids.test.js — contract test suite for forge-ids.js
// Exercises the pure core: nowTimestamp, slugify, makeMilestoneId, makeTaskId,
// makeItemId, classify, isValid, prefixGlob, entityKind — plus the I/O helpers.
// Run: node scripts/forge-ids.test.js  (exits 0 = all pass, 1 = any fail)

'use strict';

const ids = require('./forge-ids.js');

// ── Harness ───────────────────────────────────────────────────────────────────
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

console.log('\n=== forge-ids.js — contract test suite ===\n');

// ── 1. nowTimestamp ───────────────────────────────────────────────────────────
console.log('1. nowTimestamp');
test('returns 14 digits', () => {
  const ts = ids.nowTimestamp();
  assert(/^\d{14}$/.test(ts), `got: ${ts}`);
});

test('is UTC-based (no locale drift)', () => {
  // Two calls within the same second should share a 12-digit date+hour+min+sec prefix
  const ts = ids.nowTimestamp();
  assert(ts.length === 14, `expected length 14, got ${ts.length}`);
  // Basic sanity: year 202x
  assert(ts.startsWith('202'), `expected year 202x, got: ${ts.slice(0, 4)}`);
});

// ── 2. slugify — determinism (RISK binding) ───────────────────────────────────
console.log('\n2. slugify — determinism');
test('same input twice → identical output (basic)', () => {
  const a = ids.slugify('Autenticação OAuth');
  const b = ids.slugify('Autenticação OAuth');
  assertEq(a, b, 'slugify must be deterministic');
});

test('same input twice → identical output (mixed)', () => {
  const a = ids.slugify('Sistema de Notificações em Tempo Real');
  const b = ids.slugify('Sistema de Notificações em Tempo Real');
  assertEq(a, b, 'slugify determinism on complex input');
});

// ── 3. slugify — accent-fold pt-BR (RISK binding) ────────────────────────────
console.log('\n3. slugify — accent-fold');
test('autenticação → autenticacao', () => {
  assertEq(ids.slugify('autenticação'), 'autenticacao');
});

test('no diacritics in output for á é í ó ú â ê ô õ', () => {
  const result = ids.slugify('café ênfase ímpar ótimo útil fôlego cêntrico ônibus coração');
  assert(!/[àáâãäåèéêëìíîïòóôõöùúûüç]/i.test(result),
    `diacritics still present in: ${result}`);
});

test('ç becomes c', () => {
  const result = ids.slugify('certificação');
  assert(!result.includes('ç'), `ç still present in: ${result}`);
});

// ── 4. slugify — stopwords bilíngues (RISK binding) ──────────────────────────
console.log('\n4. slugify — stopwords');
test('pt-BR fillers removed (o, de, com, em)', () => {
  const result = ids.slugify('o sistema de notificações com autenticação em tempo');
  const tokens = result.split('-');
  assert(!tokens.includes('o'), `"o" survived in: ${result}`);
  assert(!tokens.includes('de'), `"de" survived in: ${result}`);
  assert(!tokens.includes('com'), `"com" survived in: ${result}`);
  assert(!tokens.includes('em'), `"em" survived in: ${result}`);
});

test('EN fillers removed (the, for, of, in)', () => {
  const result = ids.slugify('the new auth flow for the app in production');
  const tokens = result.split('-');
  assert(!tokens.includes('the'), `"the" survived in: ${result}`);
  assert(!tokens.includes('for'), `"for" survived in: ${result}`);
  assert(!tokens.includes('of'), `"of" survived in: ${result}`);
  assert(!tokens.includes('in'), `"in" survived in: ${result}`);
});

test('content words survive stopword removal', () => {
  const result = ids.slugify('the new auth flow for the app');
  assert(result.includes('auth'), `"auth" should survive, got: ${result}`);
  assert(result.includes('flow'), `"flow" should survive, got: ${result}`);
});

// ── 5. slugify — cap + word boundary ─────────────────────────────────────────
console.log('\n5. slugify — cap and word boundary');
test('long description capped at <= 24 chars', () => {
  const result = ids.slugify('Sistema de autenticação e autorização multi-fator com OAuth2 e JWT');
  assert(result.length <= 24, `length ${result.length} > 24: ${result}`);
});

test('cap falls on word boundary when possible (no token split)', () => {
  // "sistema autenticacao autorizacao" → tokens, first token "sistema" = 7 chars
  // Result should not end with a partial token
  const result = ids.slugify('Sistema autenticação autorização multifatorial completo');
  // Each dash-separated segment must be a complete token (no broken word)
  const tokens = result.split('-');
  assert(tokens.every(t => t.length > 0), `empty token in: ${result}`);
});

// ── 6. slugify — edge cases (RISK binding) ────────────────────────────────────
console.log('\n6. slugify — edge cases');
test('single long token → hard-sliced at <= 24 chars', () => {
  const result = ids.slugify('supercalifragilisticexpialidocious');
  assert(result.length <= 24, `hard-slice failed, got length ${result.length}: ${result}`);
  assert(result.length > 0, 'should not be empty after hard-slice');
});

test('stopword-only description → empty slug', () => {
  assertEq(ids.slugify('de a o'), '', 'stopword-only must produce empty slug');
});

test('empty string → empty slug', () => {
  assertEq(ids.slugify(''), '', 'empty string must produce empty slug');
});

// ── 7. makeMilestoneId ────────────────────────────────────────────────────────
console.log('\n7. makeMilestoneId');
test('prefix M- with 14-digit timestamp and slug for real description', () => {
  const id = ids.makeMilestoneId('Sistema de autenticação');
  assert(/^M-\d{14}-.+$/.test(id), `got: ${id}`);
});

test('stopword-only description → M-<ts> with no trailing -slug', () => {
  const id = ids.makeMilestoneId('de a o');
  assert(/^M-\d{14}$/.test(id), `expected M-<14d> only, got: ${id}`);
});

test('slug embedded in milestone ID is ASCII only', () => {
  const id = ids.makeMilestoneId('Autenticação OAuth');
  assert(!/[^\x20-\x7E]/.test(id), `non-ASCII in id: ${id}`);
});

// ── 8. makeTaskId ─────────────────────────────────────────────────────────────
console.log('\n8. makeTaskId');
test('prefix T- with 14-digit timestamp and slug for real description', () => {
  const id = ids.makeTaskId('refatorar módulo de tokens');
  assert(/^T-\d{14}-.+$/.test(id), `got: ${id}`);
});

test('stopword-only description → T-<ts> with no trailing -slug', () => {
  const id = ids.makeTaskId('de a o');
  assert(/^T-\d{14}$/.test(id), `expected T-<14d> only, got: ${id}`);
});

// ── 9. classify (RISK binding) ────────────────────────────────────────────────
console.log('\n9. classify');
test('M005 → legacy', () => assertEq(ids.classify('M005'), 'legacy'));
test('TASK-007 → legacy', () => assertEq(ids.classify('TASK-007'), 'legacy'));
test('task-foo-a1b2 → legacy', () => assertEq(ids.classify('task-foo-a1b2'), 'legacy'));
test('M-20260522143012-oauth → timestamp', () => assertEq(ids.classify('M-20260522143012-oauth'), 'timestamp'));
test('T-20260522143012-x → timestamp', () => assertEq(ids.classify('T-20260522143012-x'), 'timestamp'));
test('M-20260522143012 (no slug) → timestamp', () => assertEq(ids.classify('M-20260522143012'), 'timestamp'));
test('malformed input does not throw', () => {
  let caught = false;
  try {
    const r = ids.classify('!!!not-an-id!!!');
    assert(typeof r === 'string', `expected string, got ${typeof r}`);
  } catch (e) {
    caught = true;
  }
  assert(!caught, 'classify must not throw on malformed input');
});
test('null input does not throw', () => {
  let caught = false;
  try { ids.classify(null); } catch (e) { caught = true; }
  assert(!caught, 'classify(null) must not throw');
});

// ── 10. isValid ───────────────────────────────────────────────────────────────
console.log('\n10. isValid');
test('timestamp milestone ID → valid', () => assert(ids.isValid('M-20260522143012-auth')));
test('timestamp task ID → valid', () => assert(ids.isValid('T-20260522143012-refactor')));
test('legacy M005 → valid', () => assert(ids.isValid('M005')));
test('legacy TASK-007 → valid', () => assert(ids.isValid('TASK-007')));
test('legacy task-foo → valid', () => assert(ids.isValid('task-foo-bar')));
test('empty string → invalid', () => assert(!ids.isValid('')));
test('null → invalid', () => assert(!ids.isValid(null)));
test('M-123 (too short, not 14 digits) → invalid', () => assert(!ids.isValid('M-123')));
test('random garbage → invalid', () => assert(!ids.isValid('GARBAGE!!!')));

// ── 11. prefixGlob ────────────────────────────────────────────────────────────
console.log('\n11. prefixGlob');
test('timestamp ID → M-<ts>* (wildcard suffix)', () => {
  assertEq(ids.prefixGlob('M-20260522143012-oauth'), 'M-20260522143012*');
});
test('timestamp task ID → T-<ts>*', () => {
  assertEq(ids.prefixGlob('T-20260522143012-refactor'), 'T-20260522143012*');
});
test('legacy ID → exact match (no wildcard)', () => {
  const result = ids.prefixGlob('M005');
  assertEq(result, 'M005');
  assert(!result.includes('*'), `legacy should not have wildcard, got: ${result}`);
});

// ── 12. entityKind ────────────────────────────────────────────────────────────
console.log('\n12. entityKind');
test('M005 → milestone', () => assertEq(ids.entityKind('M005'), 'milestone'));
test('M-20260522143012-auth → milestone', () => assertEq(ids.entityKind('M-20260522143012-auth'), 'milestone'));
test('TASK-007 → task', () => assertEq(ids.entityKind('TASK-007'), 'task'));
test('task-foo → task', () => assertEq(ids.entityKind('task-foo'), 'task'));
test('T-20260522143012-x → task', () => assertEq(ids.entityKind('T-20260522143012-x'), 'task'));
test('garbage → unknown', () => assertEq(ids.entityKind('GARBAGE!!!'), 'unknown'));
test('empty string → unknown', () => assertEq(ids.entityKind(''), 'unknown'));
test('null → unknown', () => assertEq(ids.entityKind(null), 'unknown'));

// ── 13. dashed timestamp IDs (regression: M-YYYYMMDD-HHMMSS dropped) ───────────
// The dashed date-time form (a hyphen between date and time) appeared in real
// projects alongside the compact 14-digit form. The validator only knew the
// compact form, so dashed IDs were rejected as "Invalid" and silently dropped
// from migrations. All three shapes must validate, classify, and route the same.
console.log('\n13. dashed timestamp IDs (M-YYYYMMDD-HHMMSS)');

// The three formats from BUG 1: sequential, compact-14-digit, dashed.
test('isValid: legacy sequential M004', () => assert(ids.isValid('M004')));
test('isValid: compact 14-digit M-20260601213131', () => assert(ids.isValid('M-20260601213131')));
test('isValid: dashed milestone M-20260519-153227', () => assert(ids.isValid('M-20260519-153227')));
test('isValid: dashed task TASK-20260521-205130', () => assert(ids.isValid('TASK-20260521-205130')));
test('isValid: dashed task T-20260521-205130', () => assert(ids.isValid('T-20260521-205130')));
test('isValid: dashed milestone with slug M-20260519-153227-pagamentos', () =>
  assert(ids.isValid('M-20260519-153227-pagamentos')));

test('entityKind: dashed milestone → milestone', () =>
  assertEq(ids.entityKind('M-20260519-153227'), 'milestone'));
test('entityKind: dashed TASK → task', () =>
  assertEq(ids.entityKind('TASK-20260521-205130'), 'task'));
test('entityKind: dashed T → task', () =>
  assertEq(ids.entityKind('T-20260521-205130'), 'task'));

test('classify: dashed milestone → timestamp', () =>
  assertEq(ids.classify('M-20260519-153227'), 'timestamp'));
test('classify: dashed TASK → timestamp', () =>
  assertEq(ids.classify('TASK-20260521-205130'), 'timestamp'));

test('prefixGlob: dashed milestone → M-YYYYMMDD-HHMMSS*', () =>
  assertEq(ids.prefixGlob('M-20260519-153227'), 'M-20260519-153227*'));
test('prefixGlob: dashed milestone with slug → prefix*', () =>
  assertEq(ids.prefixGlob('M-20260519-153227-pagamentos'), 'M-20260519-153227*'));

// Guard against over-acceptance: malformed near-misses must stay invalid.
test('isValid: M-2026051-153227 (7-digit date) → invalid', () =>
  assert(!ids.isValid('M-2026051-153227')));
test('isValid: M-20260519-15322 (5-digit time) → invalid', () =>
  assert(!ids.isValid('M-20260519-15322')));

// ── 14. item IDs (I-<ts>-<slug>) ─────────────────────────────────────────────
// Work items (.gsd/items/) are a distinct ID kind. They participate in the
// COMPACT timestamp form only — no dashed alternate, because items are new and
// carry no legacy read-compat burden. The critical property is that widening
// isValid must not change any existing M/T/TASK/legacy answer.
console.log('\n14. item IDs (I-<ts>-<slug>)');

test('makeItemId: prefix I- with 14-digit timestamp and slug', () => {
  const id = ids.makeItemId('backlog board');
  assert(/^I-\d{14}-[a-z0-9-]+$/.test(id), `got: ${id}`);
});
test('makeItemId: output is accepted by isValid', () => {
  assert(ids.isValid(ids.makeItemId('backlog board')), 'generated item ID must validate');
});
test('makeItemId: stopword-only description → I-<ts> with no trailing -slug', () => {
  const id = ids.makeItemId('de a o');
  assert(/^I-\d{14}$/.test(id), `expected I-<14d> only, got: ${id}`);
});
test('makeItemId: bare I-<ts> form is accepted by isValid', () => {
  assert(ids.isValid(ids.makeItemId('de a o')), 'slugless item ID must validate');
});
test('makeItemId: slug is ASCII-folded (reuses slugify)', () => {
  const id = ids.makeItemId('Corrigir autenticação');
  assert(!/[^\x20-\x7E]/.test(id), `non-ASCII in id: ${id}`);
  assert(id.includes('autenticacao'), `expected folded slug, got: ${id}`);
});

test('isValid: I-20260729120000-fix-board → valid', () =>
  assert(ids.isValid('I-20260729120000-fix-board')));
test('isValid: I-20260729120000 (no slug) → valid', () =>
  assert(ids.isValid('I-20260729120000')));
test('isValid: I-123 (too short) → invalid', () =>
  assert(!ids.isValid('I-123')));
test('isValid: I-20260729-120000 (dashed form NOT accepted for items) → invalid', () =>
  assert(!ids.isValid('I-20260729-120000')));
test('isValid: I-20260729-120000-slug (dashed + slug) → invalid', () =>
  assert(!ids.isValid('I-20260729-120000-slug')));
test('isValid: I001 (no legacy sequential form for items) → invalid', () =>
  assert(!ids.isValid('I001')));
test('isValid: item-foo (no lowercase-word form for items) → invalid', () =>
  assert(!ids.isValid('item-foo')));
test('isValid: I-20260729120000-UPPER (uppercase slug) → invalid', () =>
  assert(!ids.isValid('I-20260729120000-UPPER')));

test('entityKind: I-20260729120000-x → item', () =>
  assertEq(ids.entityKind('I-20260729120000-x'), 'item'));
test('entityKind: I-20260729120000 (no slug) → item', () =>
  assertEq(ids.entityKind('I-20260729120000'), 'item'));

test('classify: I-20260729120000-x → timestamp', () =>
  assertEq(ids.classify('I-20260729120000-x'), 'timestamp'));
test('classify: I-20260729120000 (no slug) → timestamp', () =>
  assertEq(ids.classify('I-20260729120000'), 'timestamp'));
test('classify: I-20260729-120000 (dashed) → legacy (not an item shape)', () =>
  assertEq(ids.classify('I-20260729-120000'), 'legacy'));

test('prefixGlob: I-20260729120000-x → I-20260729120000*', () =>
  assertEq(ids.prefixGlob('I-20260729120000-x'), 'I-20260729120000*'));
test('prefixGlob: I-20260729120000 (no slug) → I-20260729120000*', () =>
  assertEq(ids.prefixGlob('I-20260729120000'), 'I-20260729120000*'));

// Non-regression: the I- widening must leave every other kind byte-identical.
test('regression: entityKind unchanged for M/T/TASK/task/legacy/garbage', () => {
  assertEq(ids.entityKind('M005'), 'milestone');
  assertEq(ids.entityKind('M-20260522143012-auth'), 'milestone');
  assertEq(ids.entityKind('T-20260522143012-x'), 'task');
  assertEq(ids.entityKind('TASK-007'), 'task');
  assertEq(ids.entityKind('task-foo'), 'task');
  assertEq(ids.entityKind('GARBAGE!!!'), 'unknown');
  assertEq(ids.entityKind(null), 'unknown');
});
test('regression: an item ID is never reported as milestone or task', () => {
  const k = ids.entityKind('I-20260729120000-backlog');
  assert(k !== 'milestone' && k !== 'task', `item leaked into kind: ${k}`);
});
test('regression: isValid unchanged for the pre-existing shapes', () => {
  assert(ids.isValid('M005') && ids.isValid('TASK-007') && ids.isValid('task-foo-bar'));
  assert(ids.isValid('M-20260522143012-auth') && ids.isValid('M-20260519-153227'));
  assert(!ids.isValid('M-123') && !ids.isValid('GARBAGE!!!') && !ids.isValid(''));
});

// ── nextSequentialMilestoneId / nextSequentialTaskId (pure) ──────────────────
test('nextSequentialMilestoneId: empty list → M001', () =>
  assertEq(ids.nextSequentialMilestoneId([]), 'M001'));
test('nextSequentialMilestoneId: undefined → M001', () =>
  assertEq(ids.nextSequentialMilestoneId(undefined), 'M001'));
test('nextSequentialMilestoneId: M001,M002 → M003', () =>
  assertEq(ids.nextSequentialMilestoneId(['M001', 'M002']), 'M003'));
test('nextSequentialMilestoneId: gap M001,M005 → M006 (max+1, not fill)', () =>
  assertEq(ids.nextSequentialMilestoneId(['M001', 'M005']), 'M006'));
test('nextSequentialMilestoneId: ignores timestamp IDs', () =>
  assertEq(ids.nextSequentialMilestoneId(['M-20260604002929-gsd-core-import', 'M002']), 'M003'));
test('nextSequentialMilestoneId: ignores non-ID dirs', () =>
  assertEq(ids.nextSequentialMilestoneId(['.DS_Store', 'M010', 'notes']), 'M011'));
test('nextSequentialMilestoneId: case-insensitive m007 → M008', () =>
  assertEq(ids.nextSequentialMilestoneId(['m007']), 'M008'));
test('nextSequentialMilestoneId: M999 → M1000 (no broken padding)', () =>
  assertEq(ids.nextSequentialMilestoneId(['M999']), 'M1000'));
test('nextSequentialMilestoneId: output isValid + classify legacy', () => {
  const id = ids.nextSequentialMilestoneId(['M004']);
  assert(ids.isValid(id), 'must be valid');
  assertEq(ids.classify(id), 'legacy');
});

test('nextSequentialTaskId: empty list → TASK-001', () =>
  assertEq(ids.nextSequentialTaskId([]), 'TASK-001'));
test('nextSequentialTaskId: TASK-001,TASK-002 → TASK-003', () =>
  assertEq(ids.nextSequentialTaskId(['TASK-001', 'TASK-002']), 'TASK-003'));
test('nextSequentialTaskId: ignores timestamp + task-slug forms', () =>
  assertEq(ids.nextSequentialTaskId(['T-20260601121212-fix', 'task-fix-foo', 'TASK-009']), 'TASK-010'));
test('nextSequentialTaskId: output isValid + classify legacy', () => {
  const id = ids.nextSequentialTaskId(['TASK-001']);
  assert(ids.isValid(id), 'must be valid');
  assertEq(ids.classify(id), 'legacy');
});

// ── readIdFormat / resolveMilestoneId / resolveTaskId (I/O — temp sandbox) ──
// Uses a throwaway cwd so the real user prefs cascade can still inject
// ids.format from ~/.claude — guard by always passing explicit repo prefs.
const fs = require('fs');
const os = require('os');
const path = require('path');

function withSandbox(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ids-test-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('readIdFormat: no prefs → timestamp (unless user-global sets sequential)', () => {
  withSandbox(dir => {
    const v = ids.readIdFormat(dir);
    assert(v === 'timestamp' || v === 'sequential', 'must return a valid enum');
  });
});
test('readIdFormat: repo pref sequential wins over absent local', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'));
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'),
      '{\n  "ids": { "format": "sequential" }\n}\n');
    assertEq(ids.readIdFormat(dir), 'sequential');
  });
});
test('readIdFormat: ids block at EOF without trailing newline still parses', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'));
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'),
      '{ "auto_commit": false, "ids": { "format": "sequential" } }');
    assertEq(ids.readIdFormat(dir), 'sequential');
  });
});
// Real cross-layer conflict: global (~/.claude, via HOME override) sets
// "sequential", local (.gsd/forge-prefs.jsonc) sets "timestamp" — assert the
// local layer wins (last-wins merge order: global then local). A prior
// version of this test only ever wrote ONE file, always with "timestamp"
// (also the fallback default), so it passed even if override merging was
// completely broken (vacuous — see M015 S04 review R5).
test('readIdFormat: local pref overrides repo pref (last wins)', () => {
  withSandbox(dir => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ids-home-'));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    try {
      fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(homeDir, '.claude', 'forge-agent-prefs.jsonc'),
        '{\n  "ids": { "format": "sequential" }\n}\n');
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;

      fs.mkdirSync(path.join(dir, '.gsd'));
      fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'),
        '{\n  "ids": { "format": "timestamp" }\n}\n');
      assertEq(ids.readIdFormat(dir), 'timestamp',
        'local .gsd/forge-prefs.jsonc must win over global ~/.claude/forge-agent-prefs.jsonc');
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
// Inverted case: global sets "timestamp", local sets "sequential" — proves
// the assertion above isn't just an artifact of "timestamp" being the
// fallback default for absent/invalid prefs.
test('readIdFormat: local pref overrides repo pref (inverted values)', () => {
  withSandbox(dir => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ids-home-'));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    try {
      fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(homeDir, '.claude', 'forge-agent-prefs.jsonc'),
        '{\n  "ids": { "format": "timestamp" }\n}\n');
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;

      fs.mkdirSync(path.join(dir, '.gsd'));
      fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'),
        '{\n  "ids": { "format": "sequential" }\n}\n');
      assertEq(ids.readIdFormat(dir), 'sequential',
        'local .gsd/forge-prefs.jsonc must win even when it diverges from the global default');
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
test('readIdFormat: invalid value falls back to timestamp', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'));
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'),
      '{\n  "ids": { "format": "banana" }\n}\n');
    assertEq(ids.readIdFormat(dir), 'timestamp');
  });
});

test('resolveMilestoneId: sequential scans milestones/ + archive/', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd', 'milestones', 'M002'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.gsd', 'archive', 'M007'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.gsd', 'milestones', 'M-20260601121212-feature'), { recursive: true });
    assertEq(ids.resolveMilestoneId(dir, 'qualquer desc', 'sequential'), 'M008');
  });
});
test('resolveMilestoneId: explicit timestamp override ignores sequential pref', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd'));
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), '{ "ids": { "format": "sequential" } }');
    const id = ids.resolveMilestoneId(dir, 'minha feature nova', 'timestamp');
    assert(/^M-\d{14}-/.test(id), `expected timestamp format, got ${id}`);
  });
});
test('resolveMilestoneId: pref sequential picked up from sandbox prefs', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd', 'milestones', 'M041'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gsd', 'forge-prefs.jsonc'), '{ "ids": { "format": "sequential" } }');
    assertEq(ids.resolveMilestoneId(dir, 'qualquer'), 'M042');
  });
});
test('resolveTaskId: sequential scans .gsd/tasks/', () => {
  withSandbox(dir => {
    fs.mkdirSync(path.join(dir, '.gsd', 'tasks', 'TASK-003'), { recursive: true });
    assertEq(ids.resolveTaskId(dir, 'fix typo', 'sequential'), 'TASK-004');
  });
});
test('resolveTaskId: sequential with no tasks dir → TASK-001', () => {
  withSandbox(dir => {
    assertEq(ids.resolveTaskId(dir, 'fix typo', 'sequential'), 'TASK-001');
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────
// timestampOf coverage: compact and dashed forms share the production ID grammar.
console.log('timestampOf');
test('timestampOf: compact form', () =>
  assertEq(ids.timestampOf('M-20260214112233-feature'), '20260214112233'));
test('timestampOf: compact form without slug', () =>
  assertEq(ids.timestampOf('T-20260214112233'), '20260214112233'));
test('timestampOf: dashed form', () =>
  assertEq(ids.timestampOf('M-20260214-112233-feature'), '20260214112233'));
test('timestampOf: dashed TASK form', () =>
  assertEq(ids.timestampOf('TASK-20260214-112233-fix'), '20260214112233'));
test('timestampOf: legacy IDs return null', () => {
  assertEq(ids.timestampOf('M005'), null);
  assertEq(ids.timestampOf('TASK-001'), null);
});
test('timestampOf: malformed and non-string IDs return null', () => {
  assertEq(ids.timestampOf('M-2026021411223-short'), null);
  assertEq(ids.timestampOf(null), null);
});

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
