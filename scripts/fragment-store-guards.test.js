#!/usr/bin/env node
// fragment-store-guards.test.js — regression suite for the fragment-store
// migration guards (docs/fragment-store-migration-bugs.md):
//   Issue 1 — forge-projection writeAll() refuses to overwrite a populated
//             monolith from an empty store (data-loss guard).
//   Issue 2 — forge-doctor --fix refuses to stamp SCHEMA-VERSION on an
//             unmigrated store unless --migrate is given.
//   Issue 3 — forge-ignore SVN apply/validate tolerate a child directory that
//             is ignored wholesale by an ancestor (no E155010 crash; no
//             false-positive "missing" in validate).
//
// Run: node scripts/fragment-store-guards.test.js  (exit 0 = all pass, 1 = fail)

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const projection = require('./forge-projection');
const storeState = require('./forge-store-state');
const ignore     = require('./forge-ignore');

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

// ── Fixtures ────────────────────────────────────────────────────────────────────
const LEDGER_POPULATED = [
  '# Forge Project Ledger',
  '',
  '> Compact record of completed milestones. Append-only. Never deleted.',
  '',
  '## M-20260101000000-teste — Milestone de teste',
  'Completed: 2026-01-01',
  '**Slices:** S01, S02',
  '',
].join('\n');

const DECISIONS_POPULATED = [
  '# Forge Decisions Log',
  '',
  '| # | When | Scope | Decision | Choice | Rationale | Revisable |',
  '|---|------|-------|----------|--------|-----------|-----------|',
  '| 1 | 2026-01-01 | milestone | Usar fragment store | sim | escala | no |',
  '',
].join('\n');

const MEMORY_POPULATED = [
  '# Forge Auto-Memory',
  '',
  '- [MEM001] (convention) confidence:0.80 hits:3 — Sempre excluir .gsd do stage',
  '',
].join('\n');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-guard-'));
}

function seedUnmigrated(cwd) {
  fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.gsd', 'LEDGER.md'),      LEDGER_POPULATED,    'utf8');
  fs.writeFileSync(path.join(cwd, '.gsd', 'DECISIONS.md'),   DECISIONS_POPULATED, 'utf8');
  fs.writeFileSync(path.join(cwd, '.gsd', 'AUTO-MEMORY.md'), MEMORY_POPULATED,    'utf8');
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== fragment-store migration guards — regression suite ===\n');

// ── Issue 1: writeAll data-loss guard ───────────────────────────────────────────
console.log('Issue 1 — forge-projection writeAll() guard');

test('storeState reports unmigrated for populated monolith + empty store', () => {
  const tmp = mkTmp();
  try {
    seedUnmigrated(tmp);
    const st = storeState.storeState(tmp);
    assert(st.ledger.state === 'unmigrated',    `ledger: ${st.ledger.state}`);
    assert(st.decisions.state === 'unmigrated', `decisions: ${st.decisions.state}`);
    assert(st.memory.state === 'unmigrated',    `memory: ${st.memory.state}`);
    assert(storeState.isUnmigrated(tmp) === true, 'isUnmigrated should be true');
  } finally { rmrf(tmp); }
});

test('writeAll without force BLOCKS all targets and leaves monoliths intact', () => {
  const tmp = mkTmp();
  try {
    seedUnmigrated(tmp);
    const before = {
      ledger:    fs.readFileSync(path.join(tmp, '.gsd', 'LEDGER.md'), 'utf8'),
      decisions: fs.readFileSync(path.join(tmp, '.gsd', 'DECISIONS.md'), 'utf8'),
      memory:    fs.readFileSync(path.join(tmp, '.gsd', 'AUTO-MEMORY.md'), 'utf8'),
    };
    const res = projection.writeAll(tmp);
    assert(res.written.length === 0, `expected 0 written, got ${res.written.length}`);
    assert(res.blocked.length === 3, `expected 3 blocked, got ${res.blocked.length}`);
    // Monoliths byte-identical after the (refused) write
    assert(fs.readFileSync(path.join(tmp, '.gsd', 'LEDGER.md'), 'utf8') === before.ledger, 'LEDGER.md changed');
    assert(fs.readFileSync(path.join(tmp, '.gsd', 'DECISIONS.md'), 'utf8') === before.decisions, 'DECISIONS.md changed');
    assert(fs.readFileSync(path.join(tmp, '.gsd', 'AUTO-MEMORY.md'), 'utf8') === before.memory, 'AUTO-MEMORY.md changed');
  } finally { rmrf(tmp); }
});

test('writeAll with force OVERWRITES (skeleton) — escape hatch works', () => {
  const tmp = mkTmp();
  try {
    seedUnmigrated(tmp);
    const res = projection.writeAll(tmp, { force: true });
    assert(res.blocked.length === 0, `expected 0 blocked, got ${res.blocked.length}`);
    assert(res.written.length === 3, `expected 3 written, got ${res.written.length}`);
    // After forced overwrite the ledger no longer parses any milestone entries
    const after = fs.readFileSync(path.join(tmp, '.gsd', 'LEDGER.md'), 'utf8');
    assert(/No completed milestones yet/.test(after), 'expected empty-skeleton ledger after force');
  } finally { rmrf(tmp); }
});

test('writeAll on a fresh project (empty store, no monolith) writes skeletons', () => {
  const tmp = mkTmp();
  try {
    fs.mkdirSync(path.join(tmp, '.gsd'), { recursive: true });
    const st = storeState.storeState(tmp);
    assert(st.ledger.state === 'empty', `ledger: ${st.ledger.state}`);
    const res = projection.writeAll(tmp);
    assert(res.blocked.length === 0, `expected 0 blocked, got ${res.blocked.length}`);
    assert(res.written.length === 3, `expected 3 written, got ${res.written.length}`);
  } finally { rmrf(tmp); }
});

// ── Issue 2: doctor --fix migration gate ─────────────────────────────────────────
console.log('\nIssue 2 — forge-doctor --fix migration gate');

const DOCTOR = path.resolve(__dirname, 'forge-doctor.js');

function runDoctor(args) {
  try {
    const out = execFileSync(process.execPath, [DOCTOR].concat(args), { encoding: 'utf8' });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status == null ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

test('--fix refuses to stamp SCHEMA-VERSION on an unmigrated store (exit 1)', () => {
  const tmp = mkTmp();
  try {
    seedUnmigrated(tmp);
    const r = runDoctor(['--fix', '--cwd', tmp]);
    assert(r.status === 1, `expected exit 1, got ${r.status}`);
    assert(!fs.existsSync(path.join(tmp, '.gsd', 'SCHEMA-VERSION')), 'SCHEMA-VERSION should NOT be created');
    assert(/not migrated|Refusing to stamp/i.test(r.out), `expected refusal message, got: ${r.out}`);
  } finally { rmrf(tmp); }
});

test('--fix --migrate runs the migration and THEN stamps SCHEMA-VERSION', () => {
  const tmp = mkTmp();
  try {
    seedUnmigrated(tmp);
    const r = runDoctor(['--fix', '--migrate', '--cwd', tmp]);
    assert(r.status === 0, `expected exit 0, got ${r.status} — ${r.out}`);
    const schemaPath = path.join(tmp, '.gsd', 'SCHEMA-VERSION');
    assert(fs.existsSync(schemaPath), 'SCHEMA-VERSION should be created');
    assert(fs.readFileSync(schemaPath, 'utf8').trim() === 'fragment-store@1.0.0', 'wrong schema version');
    // Fragments populated + monolith backed up to .bak
    const ledgerFrags = fs.existsSync(path.join(tmp, '.gsd', 'ledger'))
      ? fs.readdirSync(path.join(tmp, '.gsd', 'ledger')).filter(f => f.endsWith('.md'))
      : [];
    assert(ledgerFrags.length >= 1, 'expected ≥1 ledger fragment after migration');
    assert(fs.existsSync(path.join(tmp, '.gsd', 'LEDGER.md.bak')), 'expected LEDGER.md.bak');
  } finally { rmrf(tmp); }
});

test('--fix stamps normally on a fresh project (no monolith, empty store)', () => {
  const tmp = mkTmp();
  try {
    fs.mkdirSync(path.join(tmp, '.gsd'), { recursive: true });
    const r = runDoctor(['--fix', '--cwd', tmp]);
    assert(r.status === 0, `expected exit 0, got ${r.status} — ${r.out}`);
    assert(fs.existsSync(path.join(tmp, '.gsd', 'SCHEMA-VERSION')), 'SCHEMA-VERSION should be created');
  } finally { rmrf(tmp); }
});

// ── Issue 3: forge-ignore SVN wholesale-ignore tolerance ─────────────────────────
console.log('\nIssue 3 — forge-ignore SVN wholesale-ignore tolerance');

// Builds a mock execFileSync where `versionedDirs` are the only paths `svn info`
// succeeds on; everything else throws (E155010-style). propget returns no props;
// propset records the dirs it was asked to write.
function makeSvnMock(versionedAbs, propsetCalls) {
  const versionedSet = new Set(versionedAbs.map(p => path.resolve(p)));
  return function mockExec(file, args /*, opts */) {
    assert(file === 'svn', `unexpected exec: ${file}`);
    const sub = args[0];
    const target = args[args.length - 1];
    if (sub === 'info') {
      if (versionedSet.has(path.resolve(target))) return '';
      const err = new Error('svn info failed');
      err.stderr = "svn: warning: W155010: The node was not found.";
      err.status = 1;
      throw err;
    }
    if (sub === 'propget') return ''; // no svn:ignore set
    if (sub === 'propset') { propsetCalls.push(path.resolve(target)); return ''; }
    return '';
  };
}

function seedSvnTree(cwd) {
  fs.mkdirSync(path.join(cwd, '.svn'), { recursive: true });          // detectVcs → 'svn'
  fs.mkdirSync(path.join(cwd, '.gsd', 'forge'), { recursive: true }); // .gsd versioned, .gsd/forge ignored wholesale
}

test('applyIgnore does NOT throw when .gsd/forge is ignored wholesale (no E155010)', () => {
  const tmp = mkTmp();
  const propsetCalls = [];
  const restore = ignore.__setExecFileSync(makeSvnMock([path.join(tmp, '.gsd')], propsetCalls));
  try {
    seedSvnTree(tmp);
    assert(ignore.detectVcs(tmp) === 'svn', 'expected svn vcs');
    let res;
    assert((() => { try { res = ignore.applyIgnore(tmp); return true; } catch (_) { return false; } })(),
      'applyIgnore threw (regression — should tolerate non-versioned child)');
    // .gsd was versioned → propset was called for it; .gsd/forge was skipped
    assert(propsetCalls.some(p => p === path.resolve(path.join(tmp, '.gsd'))), 'expected propset on .gsd');
    assert(!propsetCalls.some(p => p === path.resolve(path.join(tmp, '.gsd', 'forge'))), 'propset should NOT touch .gsd/forge');
    assert(res.notes && res.notes.some(n => /not versioned/.test(n)), 'expected a wholesale-ignore note');
    assert(res.skipped.some(p => p.startsWith('.gsd/forge/')), 'forge children should be skipped');
  } finally { ignore.__setExecFileSync(restore); rmrf(tmp); }
});

test('validateIgnore does NOT report wholesale-covered children as missing', () => {
  const tmp = mkTmp();
  const restore = ignore.__setExecFileSync(makeSvnMock([path.join(tmp, '.gsd')], []));
  try {
    seedSvnTree(tmp);
    const res = ignore.validateIgnore(tmp);
    // The bug: every .gsd/forge/* child reported missing. The fix: they are covered.
    assert(!res.missing.some(p => p.startsWith('.gsd/forge/')), `false-positive missing: ${res.missing.join(', ')}`);
    assert(res.covered && res.covered.some(p => p.startsWith('.gsd/forge/')), 'forge children should be covered');
  } finally { ignore.__setExecFileSync(restore); rmrf(tmp); }
});

// ── Summary ─────────────────────────────────────────────────────────────────────
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
