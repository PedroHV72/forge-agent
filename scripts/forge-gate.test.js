#!/usr/bin/env node
// forge-gate.test.js — contract test suite for forge-gate.js
//
// Covers the mailbox lifecycle (open → wait → answer), and the two properties
// the protocol actually stakes its safety on:
//   1. a gate NEVER blocks forever — it expires into its declared default
//   2. a human answer NEVER loses to an expiry race
//
// Run: node scripts/forge-gate.test.js   (exit 0 = all pass, 1 = any fail)

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const gate = require('./forge-gate.js');

// Notifications are a side effect on the developer's desktop — never fire them
// from the suite.
process.env.FORGE_GATE_NO_NOTIFY = '1';

const ENGINE = path.join(__dirname, 'forge-gate.js');

// ── Harness ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-'));
  try {
    fn(cwd);
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
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

const SPEC = {
  run_id: 'M008', unit_id: 'S02', origin: 'test',
  question: 'Seguir com o plano?',
  options: [
    { key: 'treat', label: 'Tratar agora', description: 'adiciona task' },
    { key: 'skip',  label: 'Seguir assim' },
  ],
};

function runCli(cwd, args) {
  return spawnSync(process.execPath, [ENGINE, ...args, '--cwd', cwd], {
    encoding: 'utf8',
    env: { ...process.env, FORGE_GATE_NO_NOTIFY: '1' },
  });
}

console.log('\n=== forge-gate.js — contract test suite ===\n');

// ── 1. Open ──────────────────────────────────────────────────────────────────
console.log('open');

test('openGate writes a pending gate to .gsd/forge/gates', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  assert(/^G-\d{14}-[0-9a-f]{4}$/.test(g.id), `unexpected id: ${g.id}`);
  assertEq(g.status, 'pending', 'status');
  assert(fs.existsSync(gate.gateFile(cwd, g.id)), 'gate file missing on disk');
  const onDisk = JSON.parse(fs.readFileSync(gate.gateFile(cwd, g.id), 'utf8'));
  assertEq(onDisk.question, SPEC.question, 'question round-trip');
});

test('default falls back to the LAST option when unspecified', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  assertEq(g.default, 'skip', 'conservative default');
});

test('explicit default wins', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, default: 'treat' });
  assertEq(g.default, 'treat', 'explicit default');
});

test('openGate rejects a spec with no question', (cwd) => {
  let threw = false;
  try { gate.openGate(cwd, { options: SPEC.options }); } catch { threw = true; }
  assert(threw, 'expected a throw for missing question');
});

test('openGate rejects a spec with no options', (cwd) => {
  let threw = false;
  try { gate.openGate(cwd, { question: 'x', options: [] }); } catch { threw = true; }
  assert(threw, 'expected a throw for empty options');
});

test('string options are normalized', (cwd) => {
  const g = gate.openGate(cwd, { question: 'q', options: ['a', 'b'] });
  assertEq(g.options.map(o => o.key), ['a', 'b'], 'normalized keys');
  assertEq(g.options[0].label, 'a', 'label defaults to key');
});

test('two gates opened back-to-back get distinct ids', (cwd) => {
  const a = gate.openGate(cwd, SPEC);
  const b = gate.openGate(cwd, SPEC);
  assert(a.id !== b.id, `collision: ${a.id}`);
});

// ── 2. Answer ────────────────────────────────────────────────────────────────
console.log('\nanswer');

test('answerGate records the choice and flips status', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  const r = gate.answerGate(cwd, g.id, 'treat', { notes: 'porque sim' });
  assert(r.ok, `answer failed: ${r.reason}`);
  assertEq(r.gate.status, 'answered', 'status');
  assertEq(r.gate.answer.key, 'treat', 'choice');
  assertEq(r.gate.answer.label, 'Tratar agora', 'label resolved');
  assertEq(r.gate.answer.source, 'human', 'source');
  assertEq(r.gate.answer.notes, 'porque sim', 'notes');
});

test('choice matching is case-insensitive', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  const r = gate.answerGate(cwd, g.id, 'TREAT');
  assert(r.ok, 'expected case-insensitive match');
  assertEq(r.gate.answer.key, 'treat', 'canonical key stored');
});

test('an invalid choice is rejected and lists valid keys', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  const r = gate.answerGate(cwd, g.id, 'nope');
  assert(!r.ok, 'expected rejection');
  assert(/invalid-choice/.test(r.reason), `reason: ${r.reason}`);
  assert(/treat/.test(r.reason) && /skip/.test(r.reason), `should list valid keys: ${r.reason}`);
});

test('answering an unknown gate reports not-found', (cwd) => {
  const r = gate.answerGate(cwd, 'G-00000000000000-dead', 'treat');
  assert(!r.ok, 'expected failure');
  assertEq(r.reason, 'not-found', 'reason');
});

test('first writer wins — the second answer is refused', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  const a = gate.answerGate(cwd, g.id, 'treat');
  const b = gate.answerGate(cwd, g.id, 'skip');
  assert(a.ok, 'first answer should win');
  assert(!b.ok, 'second answer must be refused');
  assertEq(b.reason, 'already-answered', 'reason');
  assertEq(gate.readGate(cwd, g.id).answer.key, 'treat', 'stored choice unchanged');
});

test('cancelGate marks the gate cancelled', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  const r = gate.cancelGate(cwd, g.id);
  assert(r.ok, 'cancel failed');
  assertEq(r.gate.status, 'cancelled', 'status');
  assert(!gate.answerGate(cwd, g.id, 'treat').ok, 'cancelled gate must not accept answers');
});

// ── 3. Expiry — the safety property ──────────────────────────────────────────
console.log('\nexpiry (never blocks forever)');

test('a lapsed gate reads as expired without anyone watching', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 1 });
  const raw = JSON.parse(fs.readFileSync(gate.gateFile(cwd, g.id), 'utf8'));
  assertEq(raw.status, 'pending', 'not eagerly persisted');
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},20)']); // ~ms of wall clock
  const seen = gate.readGate(cwd, g.id);
  assertEq(seen.status, 'expired', 'computed on read');
});

test('waitForAnswerSync resolves an expired gate to its default', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 1, default: 'skip' });
  const res = gate.waitForAnswerSync(cwd, g.id, { poll_ms: 5 });
  assertEq(res.status, 'expired', 'status');
  assertEq(res.choice, 'skip', 'resolved to declared default');
  assertEq(res.source, 'timeout-default', 'source');
});

test('expiry is persisted so the resolution is auditable afterwards', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 1 });
  gate.waitForAnswerSync(cwd, g.id, { poll_ms: 5 });
  const after = JSON.parse(fs.readFileSync(gate.gateFile(cwd, g.id), 'utf8'));
  assertEq(after.status, 'expired', 'persisted');
  assertEq(after.answer.source, 'timeout-default', 'persisted source');
});

test('an expired gate REFUSES a late answer — the run already moved on', (cwd) => {
  // Deliberate semantics: once the run has taken the default and continued,
  // accepting a late answer would report a decision that never happened.
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 1 });
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},20)']);
  const r = gate.answerGate(cwd, g.id, 'treat');
  assert(!r.ok, 'late answer must be refused');
  assertEq(r.reason, 'already-expired', 'reason names the lapse');
});

test('an answer already on disk survives the waiter, even past expires_at', (cwd) => {
  // The real race: the human answers in the instant the waiter is stamping the
  // expiry. The answer is durable, so status must never regress to expired.
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 60_000 });
  gate.answerGate(cwd, g.id, 'treat');
  // Rewind the deadline: the gate is now answered AND past its expiry.
  const raw = JSON.parse(fs.readFileSync(gate.gateFile(cwd, g.id), 'utf8'));
  raw.expires_at = Date.now() - 1000;
  fs.writeFileSync(gate.gateFile(cwd, g.id), JSON.stringify(raw, null, 2), 'utf8');

  const res = gate.waitForAnswerSync(cwd, g.id, { poll_ms: 5 });
  assertEq(res.status, 'answered', 'human answer must survive');
  assertEq(res.choice, 'treat', 'choice');
  assertEq(res.source, 'human', 'source');
});

test('timeout_ms: 0 means wait indefinitely (no expiry stamped)', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 0 });
  assertEq(g.expires_at, null, 'no expiry');
  assertEq(gate.readGate(cwd, g.id).status, 'pending', 'stays pending');
});

test('waitForAnswerSync honours max_wait_ms and returns without resolving', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 0 });
  const res = gate.waitForAnswerSync(cwd, g.id, { poll_ms: 5, max_wait_ms: 30 });
  assertEq(res.status, 'pending', 'still pending');
  assertEq(res.source, 'wait-timeout', 'caller-side give-up is distinguishable');
});

test('waitForAnswerSync throws when the gate vanishes', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  fs.unlinkSync(gate.gateFile(cwd, g.id));
  let threw = false;
  try { gate.waitForAnswerSync(cwd, g.id, { poll_ms: 5 }); } catch { threw = true; }
  assert(threw, 'expected a throw for a missing gate');
});

// ── 4. Listing ───────────────────────────────────────────────────────────────
console.log('\nlisting');

test('listPending excludes answered and expired gates', (cwd) => {
  const a = gate.openGate(cwd, SPEC);
  const b = gate.openGate(cwd, SPEC);
  const c = gate.openGate(cwd, { ...SPEC, timeout_ms: 1 });
  gate.answerGate(cwd, b.id, 'skip');
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},20)']);
  const pending = gate.listPending(cwd).map(g => g.id);
  assertEq(pending, [a.id], 'only the open gate is pending');
  assertEq(gate.listGates(cwd).length, 3, 'listGates returns all');
});

test('listGates is empty (not a throw) when no gate ever existed', (cwd) => {
  assertEq(gate.listGates(cwd), [], 'empty workspace');
  assertEq(gate.listPending(cwd), [], 'empty workspace pending');
});

test('a corrupt gate file is skipped, not fatal', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  fs.writeFileSync(path.join(gate.gatesDir(cwd), 'broken.json'), '{not json', 'utf8');
  const all = gate.listGates(cwd);
  assertEq(all.length, 1, 'corrupt entry skipped');
  assertEq(all[0].id, g.id, 'valid entry survives');
});

test('gates sort chronologically', (cwd) => {
  const a = gate.openGate(cwd, SPEC);
  const b = gate.openGate(cwd, SPEC);
  // openGate can stamp both in the same millisecond; separate them explicitly
  // so this asserts ordering rather than clock resolution.
  const raw = JSON.parse(fs.readFileSync(gate.gateFile(cwd, b.id), 'utf8'));
  raw.created_at = a.created_at + 1000;
  fs.writeFileSync(gate.gateFile(cwd, b.id), JSON.stringify(raw, null, 2), 'utf8');
  assertEq(gate.listGates(cwd).map(g => g.id), [a.id, b.id], 'chronological');
});

test('same-millisecond gates still list deterministically', (cwd) => {
  gate.openGate(cwd, SPEC);
  gate.openGate(cwd, SPEC);
  gate.openGate(cwd, SPEC);
  const first = gate.listGates(cwd).map(g => g.id);
  for (let i = 0; i < 5; i++) {
    assertEq(gate.listGates(cwd).map(g => g.id), first, `listing ${i} must not reorder`);
  }
});

// ── 5. Cleanup ───────────────────────────────────────────────────────────────
console.log('\ncleanup');

test('cleanupResolved removes old resolved gates and keeps pending ones', (cwd) => {
  const keep = gate.openGate(cwd, SPEC);
  const old  = gate.openGate(cwd, SPEC);
  gate.answerGate(cwd, old.id, 'skip');
  const r = gate.cleanupResolved(cwd, { max_age_ms: -1 }); // everything resolved is "old"
  assertEq(r.removed, 1, 'one removed');
  assert(fs.existsSync(gate.gateFile(cwd, keep.id)), 'pending gate must survive');
  assert(!fs.existsSync(gate.gateFile(cwd, old.id)), 'resolved gate removed');
});

test('cleanupResolved spares recently resolved gates', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  gate.answerGate(cwd, g.id, 'skip');
  assertEq(gate.cleanupResolved(cwd).removed, 0, 'fresh answer retained');
});

// ── 6. Notification ──────────────────────────────────────────────────────────
console.log('\nnotification');

test('notify is suppressed by FORGE_GATE_NO_NOTIFY', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  assertEq(gate.notify(g), false, 'must not fire when opted out');
});

test('notify never throws on a hostile question string', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, question: 'aspas " e barra \\ e $(rm -rf /)' });
  gate.notify(g, { dryRun: true }); // must not throw
  assert(true);
});

// ── 7. CLI ───────────────────────────────────────────────────────────────────
console.log('\ncli');

test('--open --json emits a machine-readable gate', (cwd) => {
  const r = runCli(cwd, ['--open', '--question', 'q?', '--option', 'a:A:desc', '--option', 'b:B', '--json']);
  assertEq(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const g = JSON.parse(r.stdout);
  assertEq(g.status, 'pending', 'status');
  assertEq(g.options.map(o => o.key), ['a', 'b'], 'options parsed from key:Label:Desc');
  assertEq(g.options[0].description, 'desc', 'description parsed');
});

test('--open without --option exits 2', (cwd) => {
  const r = runCli(cwd, ['--open', '--question', 'q?']);
  assertEq(r.status, 2, 'usage error');
});

test('--list --json round-trips a pending gate', (cwd) => {
  runCli(cwd, ['--open', '--question', 'q?', '--option', 'a:A', '--json']);
  const r = runCli(cwd, ['--list', '--json']);
  assertEq(r.status, 0, `exit ${r.status}`);
  const list = JSON.parse(r.stdout);
  assertEq(list.length, 1, 'one pending');
});

test('--answer resolves the gate and --show reflects it', (cwd) => {
  const g = JSON.parse(runCli(cwd, ['--open', '--question', 'q?', '--option', 'a:A', '--option', 'b:B', '--json']).stdout);
  const r = runCli(cwd, ['--answer', g.id, '--choice', 'a', '--json']);
  assertEq(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const shown = JSON.parse(runCli(cwd, ['--show', g.id, '--json']).stdout);
  assertEq(shown.status, 'answered', 'status');
  assertEq(shown.answer.key, 'a', 'choice');
});

test('--answer with a bad choice exits 1', (cwd) => {
  const g = JSON.parse(runCli(cwd, ['--open', '--question', 'q?', '--option', 'a:A', '--json']).stdout);
  const r = runCli(cwd, ['--answer', g.id, '--choice', 'zzz']);
  assertEq(r.status, 1, 'should fail');
  assert(/invalid-choice/.test(r.stderr), `stderr: ${r.stderr}`);
});

test('--show on an unknown id exits 1', (cwd) => {
  assertEq(runCli(cwd, ['--show', 'G-00000000000000-dead']).status, 1, 'not found');
});

test('--help exits 0 and documents the mailbox', (cwd) => {
  const r = runCli(cwd, ['--help']);
  assertEq(r.status, 0, 'exit');
  assert(/--open/.test(r.stdout) && /--answer/.test(r.stdout), 'usage lists core verbs');
});

test('end-to-end: --open --wait blocks, then an --answer from "the app" releases it', (cwd) => {
  // The real loop: orchestrator opens and parks; a separate process answers.
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 30_000 });
  const child = spawnSync(process.execPath, ['-e', `
    const { spawnSync } = require('child_process');
    setTimeout(() => {}, 0);
    spawnSync(process.execPath, [${JSON.stringify(ENGINE)}, '--answer', ${JSON.stringify(g.id)}, '--choice', 'treat', '--cwd', ${JSON.stringify(cwd)}]);
  `], { encoding: 'utf8' });
  assertEq(child.status, 0, `responder failed: ${child.stderr}`);
  const res = gate.waitForAnswerSync(cwd, g.id, { poll_ms: 10 });
  assertEq(res.status, 'answered', 'released by the responder');
  assertEq(res.choice, 'treat', 'choice propagated');
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.error}`);
}
console.log('');
process.exit(failed ? 1 : 0);
