#!/usr/bin/env node
'use strict';

// S05/T02 — `forge-doctor --check resources`: live pressure + pool occupancy +
// T01 census, advisory by construction (molde: forge-doctor-run-overlap.test.js).
//
//   1. exit 0 across every fixture condition — spawn real, never source read.
//   2. `--check all` stays exit 0 with resources included, degraded present.
//   3. checkResources returns ok:true unconditionally, including internal error.
//   4. forced platform degradation names `platform-unsupported:linux`.
//   5. pool ceiling/held/free when present; pool-unavailable-fail-open absent.
//   6. T01 census + skip enumeration printed; zero events -> inconclusive, never clean.
//   7. checkResources never writes to events.jsonl (noEvents:true proven byte-identical).
//   8. 'resources' in VALID_CHECKS, derived into --help / unknown-check message.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { checkResources, VALID_CHECKS, CURRENT_SCHEMA } = require('./forge-doctor.js');

const DOCTOR_CLI = path.join(__dirname, 'forge-doctor.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL ${name}\n    ${error && error.stack}\n`);
  }
}

function mkTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `forge-${label}-`));
}

function eventsPath(root) {
  return path.join(root, '.gsd', 'forge', 'events.jsonl');
}

function writeEventsLine(root, obj) {
  const dir = path.join(root, '.gsd', 'forge');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(eventsPath(root), `${JSON.stringify(obj)}\n`, 'utf8');
}

function sha256File(p) {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// ── 1/2. exit 0 across fixture conditions, spawn real ───────────────────────

test('--check resources exits 0 with no .gsd/ at all', () => {
  const root = mkTmp('t02-nogsd');
  try {
    const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'resources', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `must exit 0, got ${r.status}: ${r.stderr}`);
    assert.ok(/inconclusive/.test(r.stdout), 'no log at all must read inconclusive, never clean');
    // R5: inconclusive must never render the success glyph.
    assert.ok(/⚠ Advisory — Resource control/.test(r.stdout), 'inconclusive must warn, never show ✓');
    assert.ok(!/✓ Advisory — Resource control/.test(r.stdout), 'inconclusive must not render ✓');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--check resources exits 0 with empty events.jsonl (inconclusive, never clean)', () => {
  const root = mkTmp('t02-empty');
  try {
    fs.mkdirSync(path.join(root, '.gsd', 'forge'), { recursive: true });
    fs.writeFileSync(eventsPath(root), '', 'utf8');
    const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'resources', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `must exit 0, got ${r.status}: ${r.stderr}`);
    assert.ok(/inconclusive/.test(r.stdout), 'zero events must read inconclusive');
    assert.ok(!/\bclean\b/.test(r.stdout), 'zero events must never read clean');
    assert.ok(/⚠ Advisory — Resource control/.test(r.stdout), 'inconclusive must warn, never show ✓');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--check resources exits 0 with a degraded log (platform-unsupported entries)', () => {
  const root = mkTmp('t02-degraded');
  try {
    writeEventsLine(root, { ts: new Date().toISOString(), kind: 'resource-admission', reason: 'platform-unsupported:linux' });
    const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'resources', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `must exit 0 with degradation present, got ${r.status}: ${r.stderr}`);
    assert.ok(/degraded/.test(r.stdout), 'stdout must surface the degraded verdict');
    assert.ok(/⚠ Advisory — Resource control/.test(r.stdout), 'degraded must warn, never show ✓');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--check resources shows ⚠ (never ✓) on the internal-error/skipped result', () => {
  const root = mkTmp('t02-error-glyph');
  try {
    // Directory-as-file trick (same fixture as the internal-error test below)
    // forces checkResources' own try/catch branch — `skipped: error(...)`.
    fs.mkdirSync(eventsPath(root), { recursive: true });
    const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'resources', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `must exit 0, got ${r.status}: ${r.stderr}`);
    assert.ok(/⚠ Advisory — Resource control/.test(r.stdout), 'skipped/error result must warn, never show ✓');
    assert.ok(!/✓ Advisory — Resource control/.test(r.stdout), 'skipped/error result must not render ✓');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--check resources shows ✓ (positive control) on a genuinely clean verdict', () => {
  const root = mkTmp('t02-clean-glyph');
  try {
    writeEventsLine(root, { ts: new Date().toISOString(), kind: 'resource-admission', reason: 'pressure-normal' });
    const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'resources', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `must exit 0, got ${r.status}: ${r.stderr}`);
    assert.ok(/\bclean\b/.test(r.stdout), 'setup: verdict must actually be clean');
    assert.ok(/✓ Advisory — Resource control/.test(r.stdout), 'a real clean verdict DOES still show ✓ (positive control)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkResources ok:true when an internal module throws (fixture with corrupted census input)', () => {
  const root = mkTmp('t02-internal-error');
  try {
    // Make the events.jsonl path a DIRECTORY — readFileSync inside the census
    // reader throws (EISDIR), forcing checkResources' own try/catch branch.
    fs.mkdirSync(eventsPath(root), { recursive: true });
    const r = checkResources(root, {});
    assert.strictEqual(r.ok, true, 'an internal error must still report ok:true (advisory)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--check all stays exit 0 with resources included and degradation present', () => {
  const root = mkTmp('t02-all');
  try {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    // Derived from the module, never hand-written (same rationale as the
    // run-overlap molde: a hand-written stamp goes stale on the next bump).
    fs.writeFileSync(path.join(root, '.gsd', 'SCHEMA-VERSION'), `${CURRENT_SCHEMA}\n`, 'utf8');
    writeEventsLine(root, { ts: new Date().toISOString(), kind: 'resource-admission', reason: 'platform-unsupported:linux' });

    const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'all', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `--check all must stay exit 0, got ${r.status}: ${r.stderr}`);
    assert.ok(/Resource control/.test(r.stdout), '--check all output must include the resources check');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 4. forced platform degradation is NAMED ─────────────────────────────────

test('checkResources({ platform: "linux" }) names platform-unsupported:linux instead of passing clean', () => {
  const root = mkTmp('t02-platform');
  try {
    const r = checkResources(root, { platform: 'linux' });
    assert.strictEqual(r.ok, true);
    assert.ok(/platform-unsupported:linux/.test(r.message), 'live pressure line must name the forced platform degradation');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 5. pool occupancy — never zeros mudos ───────────────────────────────────

test('checkResources reports pool-unavailable-fail-open when the pool dir is absent', () => {
  const root = mkTmp('t02-pool-absent');
  const poolDir = path.join(root, 'no-such-pool');
  try {
    const r = checkResources(root, { poolDir });
    assert.strictEqual(r.ok, true);
    assert.ok(/pool-unavailable-fail-open/.test(r.message), 'absent pool must be named, never silent zeros');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkResources reports ceiling/held/free when the pool exists', () => {
  const root = mkTmp('t02-pool-present');
  const poolDir = mkTmp('t02-pool-root');
  try {
    const { writeConfigOnce } = require('./forge-resource-pool.js');
    fs.mkdirSync(poolDir, { recursive: true });
    writeConfigOnce(poolDir, 4);
    const r = checkResources(root, { poolDir });
    assert.strictEqual(r.ok, true);
    assert.ok(/ceiling=4/.test(r.message), `must print ceiling from config, got: ${r.message}`);
    assert.ok(/held=\d+/.test(r.message) && /free=\d+/.test(r.message), 'must print held/free');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(poolDir, { recursive: true, force: true });
  }
});

// ── 6. T01 census surfaced in full ──────────────────────────────────────────

test('checkResources prints the full T01 census (examined, reasons, skipped, w3)', () => {
  const root = mkTmp('t02-census');
  try {
    writeEventsLine(root, { ts: new Date().toISOString(), kind: 'shadow-wait', reason: 'shadow-wait' });
    writeEventsLine(root, { ts: new Date().toISOString(), kind: 'dispatch', unit: 'execute-task/T01' }); // other stream
    const r = checkResources(root, {});
    assert.strictEqual(r.ok, true);
    assert.ok(/censo: eventos/.test(r.message), 'must print the census summary line');
    assert.ok(/w3:/.test(r.message), 'must print the W3 reconciliation line');
    assert.strictEqual(r.census.events_scanned, 2);
    assert.strictEqual(r.census.resource_events, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 7. no pollution of events.jsonl ─────────────────────────────────────────

test('checkResources never writes to events.jsonl — byte-identical before/after (noEvents:true)', () => {
  const root = mkTmp('t02-nopollute');
  try {
    writeEventsLine(root, { ts: new Date().toISOString(), kind: 'shadow-wait', reason: 'shadow-wait' });
    const before = sha256File(eventsPath(root));

    checkResources(root, {});
    spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'resources', '--cwd', root], { encoding: 'utf8' });

    const after = sha256File(eventsPath(root));
    assert.strictEqual(before, after, 'events.jsonl must be byte-identical before/after --check resources');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 8. VALID_CHECKS / --help derivation ─────────────────────────────────────

test("'resources' is in VALID_CHECKS, and --help / unknown-check message derive from it", () => {
  assert.ok(VALID_CHECKS.includes('resources'));

  const help = spawnSync(process.execPath, [DOCTOR_CLI, '--help'], { encoding: 'utf8' });
  assert.ok(/resources/.test(help.stdout), '--help must list resources');

  const bad = spawnSync(process.execPath, [DOCTOR_CLI, '--check', '__nope__', '--cwd', mkTmp('t02-bad')], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 2);
  assert.ok(/resources/.test(bad.stderr), 'unknown-check message must list resources');
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
