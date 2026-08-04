#!/usr/bin/env node
// forge-schema-guard-wiring.test.js — wiring suite for the directional schema
// guard across the 4 fragment-store readers (M-S01 T04).
//
// T03 shipped the seam (scripts/forge-schema-guard.js) and its own unit suite.
// This suite covers the WIRING: that forge-projection.js, forge-ledger.js,
// forge-decisions.js and forge-memory.js actually consult it, on both the CLI
// boundary and the in-process module boundary.
//
// Sections:
//   1. Fail-open — no .gsd/SCHEMA-VERSION → no warning, writes succeed
//   2. Major equal / behind — @1.0.0 and @0.9.0 → same as section 1
//   3. Major ahead, READ — exit 0, warning on stderr, envelope marked partial,
//      `--read` and `--render` stdout unchanged (no new field, no new text)
//   4. Major ahead, WRITE — exit != 0 AND the target file is absent/unchanged
//      on disk (content assert, not just the exit code)
//   5. Module boundary — queryRelevant warns, writeFragment throws
//   6. Dedupe — two guarded reads in one process emit ONE warning
//
// Run: node scripts/forge-schema-guard-wiring.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = __dirname;
const LEDGER_CLI     = path.join(SCRIPTS, 'forge-ledger.js');
const DECISIONS_CLI  = path.join(SCRIPTS, 'forge-decisions.js');
const MEMORY_CLI     = path.join(SCRIPTS, 'forge-memory.js');
const PROJECTION_CLI = path.join(SCRIPTS, 'forge-projection.js');

// The major this tooling understands. Fixtures are built relative to it so the
// suite survives a future CURRENT_SCHEMA bump.
const { CURRENT_SCHEMA } = require('./forge-doctor.js');
const TOOLING_MAJOR = Number(String(CURRENT_SCHEMA).match(/@(\d+)\./)[1]);
const AHEAD_SCHEMA  = `fragment-store@${TOOLING_MAJOR + 1}.0.0`;
const BEHIND_SCHEMA = TOOLING_MAJOR > 0 ? `fragment-store@${TOOLING_MAJOR - 1}.9.0` : 'fragment-store@0.9.0';

// ── Test runner boilerplate (mirrors forge-verifier.test.js) ──────────────────

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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-schema-wiring-'));
const FIXTURES = [];

// ── Fixture builder ───────────────────────────────────────────────────────────
// A workspace with one fragment in each of the 3 stores, plus the 3 monoliths
// (so writeAll's unmigrated data-loss guard is not what blocks the write in
// section 4 — the schema guard must be the thing that refuses).
const LEDGER_ID    = 'M-20260101000000-wiring';
const DECISIONS_ID = 'M-20260101000000-wiring';
const MEMORY_ID    = 'M-20260101000000-wiring';

function makeFixture(label, schemaVersion) {
  const cwd = path.join(ROOT, label);
  fs.mkdirSync(path.join(cwd, '.gsd', 'ledger'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.gsd', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.gsd', 'memory'), { recursive: true });

  fs.writeFileSync(path.join(cwd, '.gsd', 'ledger', `${LEDGER_ID}.md`),
    `---\nid: ${LEDGER_ID}\ntitle: Wiring fixture\ncompleted_at: 2026-01-01T00:00:00Z\nslices: [S01]\nkey_files: [scripts/forge-ledger.js]\nkey_decisions: [none]\n---\n\nBody.\n`, 'utf8');

  fs.writeFileSync(path.join(cwd, '.gsd', 'decisions', `${DECISIONS_ID}.md`),
    `---\nunit_id: ${DECISIONS_ID}\ndecisions:\n  - when: 2026-01-01\n    scope: wiring\n    decision: guard\n    choice: yes\n    rationale: fixture\n    revisable: no\n---\n`, 'utf8');

  fs.writeFileSync(path.join(cwd, '.gsd', 'memory', `${MEMORY_ID}.md`),
    `---\nunit_id: ${MEMORY_ID}\nfacts:\n  - mem_id: WIRE-001\n    category: gotcha\n    text: schema guard wiring fixture entry\n    created_at: 2026-01-01\n    source_unit: ${MEMORY_ID}\nstats: []\n---\n`, 'utf8');

  if (schemaVersion) {
    fs.writeFileSync(path.join(cwd, '.gsd', 'SCHEMA-VERSION'), `${schemaVersion}\n`, 'utf8');
  }
  FIXTURES.push({ label, cwd, schemaVersion });
  return cwd;
}

function run(cli, args, cwd, stdin) {
  const opts = { encoding: 'utf8', cwd: ROOT };
  if (stdin !== undefined) opts.input = stdin;
  return spawnSync(process.execPath, [cli, ...args, '--cwd', cwd], opts);
}

// Marker unique to the guard warning (formatSchemaWarning header).
function hasWarning(stderr) {
  return /schema do Forge à frente da tooling local/.test(String(stderr || ''));
}

const VALID_LEDGER_ENTRY = JSON.stringify({
  id: 'M-20260202000000-written', title: 'Written', completed_at: '2026-02-02T00:00:00Z',
  slices: ['S01'], key_files: [], key_decisions: [], body: 'x',
});
const VALID_DECISIONS_ENTRY = JSON.stringify({
  unit_id: 'M-20260202000000-written',
  decisions: [{ when: '2026-02-02', scope: 'x', decision: 'd', choice: 'c', rationale: 'r', revisable: 'no' }],
});
const VALID_MEMORY_ENTRY = JSON.stringify({
  unit_id: 'M-20260202000000-written',
  facts: [{ mem_id: 'W-1', category: 'gotcha', text: 'written', created_at: '2026-02-02', source_unit: 'M-20260202000000-written' }],
  stats: [],
});

// Where each --write lands, so section 4 can assert on-disk absence.
function writeTargets(cwd) {
  return [
    path.join(cwd, '.gsd', 'ledger', 'M-20260202000000-written.md'),
    path.join(cwd, '.gsd', 'decisions', 'M-20260202000000-written.md'),
    path.join(cwd, '.gsd', 'memory', 'M-20260202000000-written.md'),
  ];
}

// ── Section 1 + 2: fail-open and non-ahead majors ─────────────────────────────
// Same expectations, so they share one body run over three fixtures.

console.log('\n=== Sections 1-2: fail-open (absent / equal / behind major) ===\n');

const CLEAN_CASES = [
  ['no-schema-version', null],
  ['equal-major', CURRENT_SCHEMA],
  ['behind-major', BEHIND_SCHEMA],
];

for (const [label, schema] of CLEAN_CASES) {
  const cwd = makeFixture(label, schema);

  test(`[${label}] ledger --list: exit 0, array, no warning, no new key`, () => {
    const r = run(LEDGER_CLI, ['--list'], cwd);
    assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    assert(!hasWarning(r.stderr), `unexpected warning: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert(Array.isArray(parsed), 'ledger --list must stay a JSON array');
    assert(parsed.length === 1, `expected 1 fragment, got ${parsed.length}`);
    assertEq(Object.keys(parsed[0]).sort(), ['id', 'path'], 'ledger list row keys unchanged');
  });

  test(`[${label}] decisions --list: exit 0, no warning`, () => {
    const r = run(DECISIONS_CLI, ['--list'], cwd);
    assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    assert(!hasWarning(r.stderr), `unexpected warning: ${r.stderr}`);
    assert(Array.isArray(JSON.parse(r.stdout)), 'decisions --list must stay a JSON array');
  });

  test(`[${label}] memory --list: exit 0, no warning`, () => {
    const r = run(MEMORY_CLI, ['--list'], cwd);
    assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    assert(!hasWarning(r.stderr), `unexpected warning: ${r.stderr}`);
    assert(Array.isArray(JSON.parse(r.stdout)), 'memory --list must stay a JSON array');
  });

  test(`[${label}] projection --stale: exit 0, no schema_partial key`, () => {
    const r = run(PROJECTION_CLI, ['--stale'], cwd);
    assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    assert(!hasWarning(r.stderr), `unexpected warning: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assertEq(Object.keys(parsed).sort(), ['decisions', 'ledger', 'memory'],
      '--stale envelope must be byte-identical when not partial');
  });

  test(`[${label}] projection --render ledger: exit 0, no warning`, () => {
    const r = run(PROJECTION_CLI, ['--render', 'ledger'], cwd);
    assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    assert(!hasWarning(r.stderr), `unexpected warning: ${r.stderr}`);
    assert(r.stdout.includes(LEDGER_ID), 'rendered ledger should contain the fixture id');
  });

  test(`[${label}] writes succeed on all 3 stores`, () => {
    const rl = run(LEDGER_CLI, ['--write'], cwd, VALID_LEDGER_ENTRY);
    assert(rl.status === 0, `ledger --write exit ${rl.status}: ${rl.stderr}`);
    const rd = run(DECISIONS_CLI, ['--write'], cwd, VALID_DECISIONS_ENTRY);
    assert(rd.status === 0, `decisions --write exit ${rd.status}: ${rd.stderr}`);
    const rm = run(MEMORY_CLI, ['--write'], cwd, VALID_MEMORY_ENTRY);
    assert(rm.status === 0, `memory --write exit ${rm.status}: ${rm.stderr}`);
    for (const target of writeTargets(cwd)) {
      assert(fs.existsSync(target), `expected written fragment at ${target}`);
    }
  });

  test(`[${label}] projection --write-all succeeds`, () => {
    const r = run(PROJECTION_CLI, ['--write-all', '--force'], cwd);
    assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    assert(!hasWarning(r.stderr), `unexpected warning: ${r.stderr}`);
    assert(fs.existsSync(path.join(cwd, '.gsd', 'LEDGER.md')), 'LEDGER.md should have been written');
  });
}

// ── Section 3: major ahead, READ side ─────────────────────────────────────────

console.log('\n=== Section 3: major ahead — reads warn, stay exit 0, mark envelopes ===\n');

const AHEAD = makeFixture('ahead-read', AHEAD_SCHEMA);

test('[ahead] ledger --list: exit 0 + warning on stderr, array shape intact', () => {
  const r = run(LEDGER_CLI, ['--list'], AHEAD);
  assert(r.status === 0, `read must not block; exit ${r.status}`);
  assert(hasWarning(r.stderr), `expected schema warning on stderr, got: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert(Array.isArray(parsed), 'array-shaped stdout must not become an object');
});

test('[ahead] decisions --list: exit 0 + warning', () => {
  const r = run(DECISIONS_CLI, ['--list'], AHEAD);
  assert(r.status === 0, `exit ${r.status}`);
  assert(hasWarning(r.stderr), 'expected schema warning on stderr');
  assert(Array.isArray(JSON.parse(r.stdout)), 'array shape intact');
});

test('[ahead] memory --list: exit 0 + warning', () => {
  const r = run(MEMORY_CLI, ['--list'], AHEAD);
  assert(r.status === 0, `exit ${r.status}`);
  assert(hasWarning(r.stderr), 'expected schema warning on stderr');
  assert(Array.isArray(JSON.parse(r.stdout)), 'array shape intact');
});

test('[ahead] --read carries NO new field (data, not envelope)', () => {
  const r = run(LEDGER_CLI, ['--read', LEDGER_ID], AHEAD);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  assert(hasWarning(r.stderr), 'expected schema warning on stderr');
  const parsed = JSON.parse(r.stdout);
  assert(parsed && parsed.id === LEDGER_ID, 'fragment should still parse');
  assert(!('schema_partial' in parsed), '--read output must not gain schema_partial');
  assert(!('schema_warning' in parsed), '--read output must not gain schema_warning');
});

test('[ahead] --render emits NO extra text on stdout', () => {
  const clean = run(PROJECTION_CLI, ['--render', 'ledger'], path.join(ROOT, 'no-schema-version'));
  const ahead = run(PROJECTION_CLI, ['--render', 'ledger'], AHEAD);
  assert(ahead.status === 0, `exit ${ahead.status}`);
  assert(hasWarning(ahead.stderr), 'expected schema warning on stderr');
  assert(!/schema/i.test(ahead.stdout), 'markdown stdout must not mention the schema warning');
  // Both fixtures hold the same fragment set at this point in the run only for
  // the ledger heading; compare structure rather than bytes across fixtures.
  assert(ahead.stdout.startsWith(clean.stdout.slice(0, 40)),
    'rendered markdown prefix must be unchanged by the guard');
});

test('[ahead] projection --stale envelope gains schema_partial + schema_warning', () => {
  const r = run(PROJECTION_CLI, ['--stale'], AHEAD);
  assert(r.status === 0, `exit ${r.status}`);
  assert(hasWarning(r.stderr), 'expected schema warning on stderr');
  const parsed = JSON.parse(r.stdout);
  assert(parsed.schema_partial === true, 'expected schema_partial:true on --stale');
  assert(typeof parsed.schema_warning === 'string' && parsed.schema_warning.length > 0,
    'expected a non-empty schema_warning string');
  for (const key of ['ledger', 'decisions', 'memory']) {
    assert(typeof parsed[key] === 'boolean', `pre-existing key ${key} must survive`);
  }
});

test('[ahead] memory --query envelope gains schema_partial + schema_warning', () => {
  const r = run(MEMORY_CLI, ['--query', '--text', 'wiring', '--unit-type', 'execute-task'], AHEAD);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  assert(hasWarning(r.stderr), 'expected schema warning on stderr');
  const parsed = JSON.parse(r.stdout);
  assert(parsed.schema_partial === true, 'expected schema_partial:true on --query');
  assert(typeof parsed.schema_warning === 'string', 'expected schema_warning string');
  assert(Array.isArray(parsed.entries), 'entries must survive');
  assert(typeof parsed.markdown === 'string', 'markdown must survive');
  assert(!/schema do Forge/.test(parsed.markdown), 'the warning must not leak into injected markdown');
});

// ── Section 4: major ahead, WRITE side ────────────────────────────────────────

console.log('\n=== Section 4: major ahead — writes refused, nothing lands on disk ===\n');

const AHEAD_W = makeFixture('ahead-write', AHEAD_SCHEMA);

test('[ahead] ledger --write refused: exit != 0 and no file created', () => {
  const target = path.join(AHEAD_W, '.gsd', 'ledger', 'M-20260202000000-written.md');
  const r = run(LEDGER_CLI, ['--write'], AHEAD_W, VALID_LEDGER_ENTRY);
  assert(r.status !== 0, 'write under an ahead schema must exit non-zero');
  assert(hasWarning(r.stderr), `expected the guard message on stderr, got: ${r.stderr}`);
  assert(!fs.existsSync(target), 'refused write must not create the fragment file');
});

test('[ahead] decisions --write refused: exit != 0 and no file created', () => {
  const target = path.join(AHEAD_W, '.gsd', 'decisions', 'M-20260202000000-written.md');
  const r = run(DECISIONS_CLI, ['--write'], AHEAD_W, VALID_DECISIONS_ENTRY);
  assert(r.status !== 0, 'write under an ahead schema must exit non-zero');
  assert(hasWarning(r.stderr), `expected the guard message on stderr, got: ${r.stderr}`);
  assert(!fs.existsSync(target), 'refused write must not create the fragment file');
});

test('[ahead] memory --write refused: exit != 0 and no file created', () => {
  const target = path.join(AHEAD_W, '.gsd', 'memory', 'M-20260202000000-written.md');
  const r = run(MEMORY_CLI, ['--write'], AHEAD_W, VALID_MEMORY_ENTRY);
  assert(r.status !== 0, 'write under an ahead schema must exit non-zero');
  assert(hasWarning(r.stderr), `expected the guard message on stderr, got: ${r.stderr}`);
  assert(!fs.existsSync(target), 'refused write must not create the fragment file');
});

test('[ahead] existing fragment content is untouched by a refused write', () => {
  const existing = path.join(AHEAD_W, '.gsd', 'ledger', `${LEDGER_ID}.md`);
  const before = fs.readFileSync(existing, 'utf8');
  const overwrite = JSON.stringify({
    id: LEDGER_ID, title: 'CLOBBERED', completed_at: '2026-03-03T00:00:00Z',
    slices: [], key_files: [], key_decisions: [], body: 'clobber',
  });
  const r = run(LEDGER_CLI, ['--write'], AHEAD_W, overwrite);
  assert(r.status !== 0, 'overwrite must be refused');
  assertEq(fs.readFileSync(existing, 'utf8'), before, 'fragment bytes must be unchanged');
});

test('[ahead] projection --write-all refused: exit != 0 and no monolith written', () => {
  const target = path.join(AHEAD_W, '.gsd', 'LEDGER.md');
  const r = run(PROJECTION_CLI, ['--write-all'], AHEAD_W);
  assert(r.status !== 0, '--write-all under an ahead schema must exit non-zero');
  assert(hasWarning(r.stderr), `expected the guard message on stderr, got: ${r.stderr}`);
  assert(!fs.existsSync(target), 'refused --write-all must not create LEDGER.md');
});

test('[ahead] projection --write-all --force is ALSO refused', () => {
  // --force overrides the unmigrated data-loss guard, not the schema guard:
  // stale tooling writing over newer data is a different hazard.
  const r = run(PROJECTION_CLI, ['--write-all', '--force'], AHEAD_W);
  assert(r.status !== 0, '--force must not bypass the schema guard');
  assert(!fs.existsSync(path.join(AHEAD_W, '.gsd', 'LEDGER.md')), 'nothing written');
});

// ── Section 5: module boundary (not the CLI) ──────────────────────────────────

console.log('\n=== Section 5: module boundary — queryRelevant warns, writeFragment throws ===\n');

test('[module] memory.queryRelevant emits the warning in-process', () => {
  // Spawned child: guardRead dedupes per process, and this must be measured on
  // a virgin process. forge-prompt.js:306 is the real caller of this seam.
  const src = `
    const mem = require(${JSON.stringify(MEMORY_CLI)});
    const out = mem.queryRelevant({ cwd: ${JSON.stringify(AHEAD)}, unitType: 'execute-task', query: 'wiring' });
    process.stdout.write(JSON.stringify({ partial: out.schema_partial === true, entries: Array.isArray(out.entries) }));
  `;
  const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', cwd: ROOT });
  assert(r.status === 0, `queryRelevant must not throw; exit ${r.status}: ${r.stderr}`);
  assert(hasWarning(r.stderr), `expected warning from the module boundary, got: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert(parsed.partial === true, 'queryRelevant result envelope should be marked partial');
  assert(parsed.entries === true, 'entries array must still be returned (read never blocks)');
});

test('[module] memory.writeFragment throws under an ahead schema', () => {
  const mem = require('./forge-memory.js');
  let threw = false;
  let message = '';
  try {
    mem.writeFragment(AHEAD_W, {
      unit_id: 'M-20260303000000-modboundary',
      facts: [{ mem_id: 'M-1', category: 'gotcha', text: 't', created_at: '2026-03-03', source_unit: 'x' }],
      stats: [],
    });
  } catch (e) {
    threw = true;
    message = e.message;
  }
  assert(threw, 'writeFragment must throw when the data schema major is ahead');
  assert(hasWarning(message), `thrown message should be the guard warning, got: ${message}`);
  assert(!fs.existsSync(path.join(AHEAD_W, '.gsd', 'memory', 'M-20260303000000-modboundary.md')),
    'nothing may be written by a refused module-level write');
});

test('[module] ledger.writeFragment and decisions.writeFragment throw too', () => {
  const led = require('./forge-ledger.js');
  const dec = require('./forge-decisions.js');
  let ledThrew = false;
  let decThrew = false;
  try { led.writeFragment(AHEAD_W, { id: 'M-20260303000001-mod', title: 't' }); } catch (_) { ledThrew = true; }
  try { dec.writeFragment(AHEAD_W, { unit_id: 'M-20260303000001-mod', decisions: [] }); } catch (_) { decThrew = true; }
  assert(ledThrew, 'ledger.writeFragment must throw');
  assert(decThrew, 'decisions.writeFragment must throw');
});

test('[module] projection.writeAll throws and writes nothing', () => {
  const proj = require('./forge-projection.js');
  let threw = false;
  try { proj.writeAll(AHEAD_W, { force: true }); } catch (_) { threw = true; }
  assert(threw, 'writeAll must throw under an ahead schema');
  assert(!fs.existsSync(path.join(AHEAD_W, '.gsd', 'AUTO-MEMORY.md')), 'no monolith written');
});

test('[module] fail-open cwd: writeFragment still succeeds', () => {
  const led = require('./forge-ledger.js');
  const clean = path.join(ROOT, 'no-schema-version');
  const res = led.writeFragment(clean, {
    id: 'M-20260404000000-failopen', title: 'ok', completed_at: '2026-04-04T00:00:00Z',
    slices: [], key_files: [], key_decisions: [], body: 'b',
  });
  assert(res && res.path, 'fail-open write should return a path');
  assert(fs.existsSync(res.path), 'fail-open write should land on disk');
});

// ── Section 6: dedupe ─────────────────────────────────────────────────────────

console.log('\n=== Section 6: one warning per process per cwd ===\n');

test('[dedupe] a render that walks many guarded reads warns exactly once', () => {
  const r = run(PROJECTION_CLI, ['--render', 'memory'], AHEAD);
  assert(r.status === 0, `exit ${r.status}`);
  const count = (String(r.stderr).match(/schema do Forge à frente da tooling local/g) || []).length;
  assertEq(count, 1, 'renderMemory → projectMemoryEntries → memory.listFragments must warn once');
});

test('[dedupe] two successive in-process reads emit one warning', () => {
  const src = `
    const led = require(${JSON.stringify(LEDGER_CLI)});
    led.listFragments(${JSON.stringify(AHEAD)});
    led.listFragments(${JSON.stringify(AHEAD)});
    led.readFragment(${JSON.stringify(AHEAD)}, ${JSON.stringify(LEDGER_ID)});
  `;
  const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', cwd: ROOT });
  assert(r.status === 0, `reads must not fail; ${r.stderr}`);
  const count = (String(r.stderr).match(/schema do Forge à frente da tooling local/g) || []).length;
  assertEq(count, 1, 'three guarded reads on one cwd must emit exactly one warning');
});

test('[dedupe] a second, distinct cwd gets its own warning', () => {
  const src = `
    const led = require(${JSON.stringify(LEDGER_CLI)});
    led.listFragments(${JSON.stringify(AHEAD)});
    led.listFragments(${JSON.stringify(AHEAD_W)});
  `;
  const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', cwd: ROOT });
  const count = (String(r.stderr).match(/schema do Forge à frente da tooling local/g) || []).length;
  assertEq(count, 2, 'dedupe is keyed per resolved cwd, not global');
});

test('[dedupe] guard helper exposes the wiring entry points', () => {
  const guard = require('./forge-schema-guard.js');
  assert(typeof guard.guardReadAndWarn === 'function', 'guardReadAndWarn must be exported');
  assert(typeof guard.assertWriteOrThrow === 'function', 'assertWriteOrThrow must be exported');
  assert(typeof guard.emitSchemaWarningOnce === 'function', 'emitSchemaWarningOnce must be exported');
  // T03 surface must survive unchanged.
  assert(typeof guard.guardRead === 'function', 'guardRead (T03) must still be exported');
  assert(typeof guard.assertWrite === 'function', 'assertWrite (T03) must still be exported');
  assert(typeof guard.formatSchemaWarning === 'function', 'formatSchemaWarning (T03) must still be exported');
});

// ── Section 7: the guard loader only swallows an ABSENT guard ─────────────────
// R1 (review-triage): `catch (_) { return null }` could not tell "guard not
// colocated in this install layout" (legitimate fail-open) from "guard exists
// but threw while initializing" (a real fault that silently disables BOTH the
// read warning and the write refusal). The guard requires forge-migrate, which
// eagerly pulls projection/migrators/store-state/doctor — a broken transitive
// dependency is a realistic case and must NOT look like an absent guard.
//
// Scope note: this covers the CATCH only. The seam stays fail-open on runtime
// errors from checkSchemaDirection — that policy was reviewed and kept.

console.log('\n=== Section 7: guard load errors propagate unless the guard is absent ===\n');

// Runs `body` in a child process with `require('./forge-schema-guard')`
// intercepted to throw `errExpr`. Returns the spawn result.
function withGuardLoadError(errExpr, body) {
  const src = `
    const Module = require('module');
    const orig = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === './forge-schema-guard') { throw (${errExpr}); }
      return orig.apply(this, arguments);
    };
    ${body}
  `;
  return spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', cwd: ROOT });
}

const MODULE_NOT_FOUND_SELF = `(() => { const e = new Error("Cannot find module './forge-schema-guard'"); e.code = 'MODULE_NOT_FOUND'; return e; })()`;
const MODULE_NOT_FOUND_OTHER = `(() => { const e = new Error("Cannot find module './forge-migrate'"); e.code = 'MODULE_NOT_FOUND'; return e; })()`;
const INIT_THROW = `new TypeError('guard blew up at init')`;

const LOADER_SITES = [
  ['ledger', LEDGER_CLI, `require(${JSON.stringify(LEDGER_CLI)}).listFragments(${JSON.stringify(AHEAD)});`],
  ['decisions', DECISIONS_CLI, `require(${JSON.stringify(DECISIONS_CLI)}).listFragments(${JSON.stringify(AHEAD)});`],
  ['memory', MEMORY_CLI, `require(${JSON.stringify(MEMORY_CLI)}).listFragments(${JSON.stringify(AHEAD)});`],
  ['projection', PROJECTION_CLI, `require(${JSON.stringify(PROJECTION_CLI)}).isStale(${JSON.stringify(AHEAD)});`],
];

for (const [label, , call] of LOADER_SITES) {
  test(`[${label}] a non-MODULE_NOT_FOUND load failure propagates`, () => {
    const r = withGuardLoadError(INIT_THROW, call);
    assert(r.status !== 0, `a guard that throws at init must not be swallowed (exit ${r.status})`);
    assert(/guard blew up at init/.test(String(r.stderr)), `expected the original error on stderr, got: ${r.stderr}`);
  });

  test(`[${label}] MODULE_NOT_FOUND naming a DIFFERENT module propagates`, () => {
    const r = withGuardLoadError(MODULE_NOT_FOUND_OTHER, call);
    assert(r.status !== 0, `a broken transitive dependency must not be swallowed (exit ${r.status})`);
    assert(/forge-migrate/.test(String(r.stderr)), `expected the transitive module name on stderr, got: ${r.stderr}`);
  });

  test(`[${label}] MODULE_NOT_FOUND naming the guard itself still fails open`, () => {
    const r = withGuardLoadError(MODULE_NOT_FOUND_SELF, call + ' process.stdout.write("ok");');
    assert(r.status === 0, `an absent guard must stay fail-open; exit ${r.status}: ${r.stderr}`);
    assert(r.stdout.includes('ok'), 'the store call should complete normally');
    assert(!hasWarning(r.stderr), 'no guard → no warning');
  });
}

test('[classifier] isAbsentModuleError distinguishes absent from broken', () => {
  const { isAbsentModuleError, missingModuleId } = require('./forge-optional-require.js');
  const absent = new Error("Cannot find module './forge-schema-guard'");
  absent.code = 'MODULE_NOT_FOUND';
  const other = new Error("Cannot find module './forge-migrate'");
  other.code = 'MODULE_NOT_FOUND';
  assert(isAbsentModuleError(absent, './forge-schema-guard'), 'absent guard must classify as absent');
  assert(isAbsentModuleError(absent, 'forge-schema-guard.js'), 'id normalization: ./ and .js are noise');
  assert(!isAbsentModuleError(other, './forge-schema-guard'), 'a different module is a broken dependency');
  assert(!isAbsentModuleError(new TypeError('boom'), './forge-schema-guard'), 'init errors are never absence');
  assertEq(missingModuleId(other), './forge-migrate', 'missingModuleId reports the unfindable id');
  assertEq(missingModuleId(new TypeError('boom')), null, 'non-resolution errors have no missing id');
});

// ── Cleanup and summary ───────────────────────────────────────────────────────
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}

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
