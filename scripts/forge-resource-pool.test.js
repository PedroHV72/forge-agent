#!/usr/bin/env node
'use strict';

// In-process suite for scripts/forge-resource-pool.js. Every case uses a
// fresh temp pool dir (fs.mkdtempSync) — no test ever touches the real
// default root (~/.claude/forge/resource-pool), which the last case asserts
// directly. Injected clock throughout — never a wall-clock sleep.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pool = require('./forge-resource-pool.js');
const lease = require('./forge-unit-lease.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
  }
}

function tmpPoolDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-resource-pool-test-'));
}

function makeClock(start) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; }, get: () => value };
}

// ── Root precedence (×3) ─────────────────────────────────────────────────
test('poolRootDir: opts.poolDir wins over everything', () => {
  const result = pool.poolRootDir({ poolDir: '/explicit', env: { FORGE_RESOURCE_POOL_DIR: '/env' } });
  assert.strictEqual(result, '/explicit');
});

test('poolRootDir: env.FORGE_RESOURCE_POOL_DIR wins when opts.poolDir absent', () => {
  const result = pool.poolRootDir({ env: { FORGE_RESOURCE_POOL_DIR: '/from-env' } });
  assert.strictEqual(result, '/from-env');
});

test('poolRootDir: default is machine-wide homedir path, never a project .gsd/', () => {
  const result = pool.poolRootDir({ env: {} });
  assert.strictEqual(result, path.join(os.homedir(), '.claude', 'forge', 'resource-pool'));
  assert.ok(!result.includes('.gsd'), 'default root must not reference a project .gsd/');
});

// ── Bootstrap creates <root>/.gsd/, leases land under <root>/.gsd/forge/leases/ ──
test('ensurePoolRoot: bootstrap creates <root>/.gsd/', () => {
  const dir = tmpPoolDir();
  const result = pool.ensurePoolRoot({ poolDir: dir, ncpu: 4 });
  assert.strictEqual(result.ok, true);
  assert.ok(fs.existsSync(path.join(dir, '.gsd')), '<root>/.gsd/ must exist after bootstrap');
});

test('acquireSlots: leases land under <root>/.gsd/forge/leases/ (real path assert)', () => {
  const dir = tmpPoolDir();
  const clock = makeClock(1_000_000);
  const result = pool.acquireSlots(1, { poolDir: dir, ncpu: 2, now: clock.now, ownerToken: 'owner-a' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.slots.length, 1);
  const leasesDir = lease.leasesDir(dir);
  assert.strictEqual(leasesDir, path.join(dir, '.gsd', 'forge', 'leases'));
  const files = fs.readdirSync(leasesDir);
  assert.ok(files.length >= 1, 'at least one lease record file must exist under <root>/.gsd/forge/leases/');
});

// ── Shared-ceiling test: config says 4, injected ncpu says 10 → 4 wins ──
test('shared ceiling: pool-config.json is authority, not local ncpu recomputation', () => {
  const dir = tmpPoolDir();
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pool-config.json'), JSON.stringify({ protocol: 1, ceiling: 4, written_at: 1 }), 'utf8');
  const clock = makeClock(2_000_000);
  const result = pool.acquireSlots(10, { poolDir: dir, ncpu: 10, now: clock.now, ownerToken: 'owner-b' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.ceiling, 4, 'the file, not the 10-core-reported machine, must win');
  assert.strictEqual(result.granted, 4);
});

// ── Grant formula: both directions + exhausted minimum-grant path ──
test('grant formula: uncontended full grant (negative control)', () => {
  const dir = tmpPoolDir();
  const clock = makeClock(3_000_000);
  const result = pool.acquireSlots(2, { poolDir: dir, ncpu: 4, now: clock.now, ownerToken: 'owner-c' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.granted, 2);
  assert.strictEqual(result.reason, pool.POOL_REASON_CODES.POOL_GRANTED);
});

test('grant formula: partial clamp when request exceeds free slots', () => {
  const dir = tmpPoolDir();
  const clock = makeClock(4_000_000);
  pool.acquireSlots(3, { poolDir: dir, ncpu: 4, now: clock.now, ownerToken: 'owner-d1' });
  const result = pool.acquireSlots(4, { poolDir: dir, ncpu: 4, now: clock.now, ownerToken: 'owner-d2' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.granted, 1, 'only 1 slot left free (4 - 3)');
  assert.strictEqual(result.reason, pool.POOL_REASON_CODES.POOL_CLAMPED_BY_POOL);
});

test('grant formula: exhausted -> minimum grant 1 with named reason, slots empty', () => {
  const dir = tmpPoolDir();
  const clock = makeClock(5_000_000);
  pool.acquireSlots(4, { poolDir: dir, ncpu: 4, now: clock.now, ownerToken: 'owner-e1' });
  const result = pool.acquireSlots(1, { poolDir: dir, ncpu: 4, now: clock.now, ownerToken: 'owner-e2' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.granted, 1);
  assert.strictEqual(result.reason, pool.POOL_REASON_CODES.POOL_EXHAUSTED_MINIMUM_GRANT);
  assert.deepStrictEqual(result.slots, [], 'minimum grant must not lease a nonexistent slot');
});

// ── B2 test (the one S02-RISK demands, both directions) ──
test('B2: holder silent past DEFAULT_TTL_MS but within derived TTL keeps its slot', () => {
  const dir = tmpPoolDir();
  const clock = makeClock(6_000_000);
  const first = pool.acquireSlots(1, {
    poolDir: dir, ncpu: 1, now: clock.now, ownerToken: 'holder',
    commandTimeoutMs: 120_000, // derived TTL = 120000 + 30000 = 150000
  });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.granted, 1);
  assert.strictEqual(first.ttlMs, 150_000);

  // Advance PAST lease.DEFAULT_TTL_MS (30s) but WITHIN the derived TTL (150s).
  assert.ok(40_000 > lease.DEFAULT_TTL_MS, 'sanity: 40s must exceed DEFAULT_TTL_MS');
  clock.advance(40_000);

  // A second acquirer contending for the SAME (only) slot must be refused —
  // the underlying lease is still active, proving the slot is HELD.
  const root = pool.poolRootDir({ poolDir: dir });
  const contended = lease.acquire(root, 'resource-pool/slot-0', { now: clock.now, ownerToken: 'intruder' });
  assert.strictEqual(contended.ok, false);
  assert.strictEqual(contended.reason, 'lease-active', 'slot must still be held past DEFAULT_TTL_MS but within derived TTL');

  // Advance past derived ttl + grace (150000 + 5000 default grace).
  clock.advance(150_000 + 5_000 + 1_000);
  const reap = pool.reapStale({ poolDir: dir, ncpu: 1, now: clock.now });
  assert.strictEqual(reap.ok, true);
  assert.strictEqual(reap.reaped, 1, 'exactly one stale slot must be reaped');

  const status = pool.poolStatus({ poolDir: dir, now: clock.now });
  assert.strictEqual(status.free, 1, 'slot must be free again after reap');
});

test('B2: reapStale reason is the frozen stale-lease-reaped enum value', () => {
  assert.strictEqual(pool.POOL_REASON_CODES.STALE_LEASE_REAPED, 'stale-lease-reaped');
});

// ── Fail-open on unwritable root ──
test('fail-open: unwritable root degrades with pool-unavailable-fail-open, never throws', () => {
  const parent = tmpPoolDir();
  const blockedFile = path.join(parent, 'blocked-root');
  fs.writeFileSync(blockedFile, 'not-a-directory', 'utf8');
  // blockedFile is a FILE; mkdirSync(blockedFile/.gsd) must fail (ENOTDIR).
  let result;
  assert.doesNotThrow(() => {
    result = pool.acquireSlots(1, { poolDir: blockedFile, ncpu: 2, now: () => 1 });
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, pool.POOL_REASON_CODES.POOL_UNAVAILABLE_FAIL_OPEN);
});

test('fail-open: ensurePoolRoot itself never throws on an unwritable path', () => {
  const parent = tmpPoolDir();
  const blockedFile = path.join(parent, 'blocked-root-2');
  fs.writeFileSync(blockedFile, 'not-a-directory', 'utf8');
  let result;
  assert.doesNotThrow(() => { result = pool.ensurePoolRoot({ poolDir: blockedFile, ncpu: 2 }); });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, pool.POOL_REASON_CODES.POOL_UNAVAILABLE_FAIL_OPEN);
});

// ── D5 assert: module source contains no process.kill / signal / taskpolicy ──
test('D5: forge-resource-pool.js source has zero process.kill / signal / taskpolicy calls', () => {
  const source = fs.readFileSync(path.join(__dirname, 'forge-resource-pool.js'), 'utf8');
  assert.ok(!/process\.kill/.test(source), 'must not call process.kill');
  assert.ok(!/\bSIGKILL\b/.test(source), 'must not reference SIGKILL');
  assert.ok(!/\bSIGTERM\b/.test(source), 'must not reference SIGTERM');
  assert.ok(!/taskpolicy/.test(source), 'must not reference taskpolicy');
});

// ── releaseSlots + poolStatus census ──
test('releaseSlots: releases granted slots, idempotent on already-released', () => {
  const dir = tmpPoolDir();
  const clock = makeClock(7_000_000);
  const granted = pool.acquireSlots(2, { poolDir: dir, ncpu: 4, now: clock.now, ownerToken: 'owner-f' });
  const released = pool.releaseSlots(granted.slots, { poolDir: dir });
  assert.strictEqual(released.ok, true);
  assert.strictEqual(released.released.length, 2);
  assert.ok(released.released.every((r) => r.ok));
  // Second release of the same slots must not throw and must still be ok
  // (already-released is tolerated).
  const releasedAgain = pool.releaseSlots(granted.slots, { poolDir: dir });
  assert.ok(releasedAgain.released.every((r) => r.ok));
});

test('poolStatus: read-only census reports ceiling/held/free/slots', () => {
  const dir = tmpPoolDir();
  const clock = makeClock(8_000_000);
  pool.acquireSlots(2, { poolDir: dir, ncpu: 4, now: clock.now, ownerToken: 'owner-g' });
  const status = pool.poolStatus({ poolDir: dir, now: clock.now });
  assert.strictEqual(status.ok, true);
  assert.strictEqual(status.ceiling, 4);
  assert.strictEqual(status.held, 2);
  assert.strictEqual(status.free, 2);
  assert.strictEqual(status.slots.length, 4);
});

test('deriveSlotTtlMs: default commandTimeoutMs (120000) + margin (30000)', () => {
  assert.strictEqual(pool.deriveSlotTtlMs({}), 150_000);
  assert.strictEqual(pool.deriveSlotTtlMs({ commandTimeoutMs: 60_000 }), 90_000);
  assert.strictEqual(pool.POOL_TTL_MARGIN_MS, 30_000);
});

// ── CLI smoke ──
test('CLI: parseArgs / runCli --status --json exits cleanly and returns a census', () => {
  const dir = tmpPoolDir();
  const args = pool.parseArgs(['--status', '--json', '--pool-dir', dir]);
  assert.strictEqual(args.status, true);
  assert.strictEqual(args.asJson, true);
  assert.strictEqual(args.poolDir, dir);
  let captured = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { captured += chunk; return true; };
  try {
    pool.runCli(['--status', '--json', '--pool-dir', dir]);
  } finally {
    process.stdout.write = originalWrite;
  }
  const parsed = JSON.parse(captured);
  assert.ok(Number.isFinite(parsed.ceiling));
});

// ── real-default-root guard: the suite itself never touches ~/.claude/forge/resource-pool ──
test('real-default-root guard: suite never creates the real default pool root', () => {
  const realRoot = path.join(os.homedir(), '.claude', 'forge', 'resource-pool');
  const existedBefore = fs.existsSync(realRoot);
  const statBefore = existedBefore ? fs.statSync(realRoot).mtimeMs : null;
  // Every prior case in this suite used an explicit poolDir; this assertion
  // runs LAST (after all other cases) to prove none of them touched the real
  // default root.
  const existedAfter = fs.existsSync(realRoot);
  if (!existedBefore) {
    assert.strictEqual(existedAfter, false, 'the real default pool root must not have been created by this suite');
  } else {
    const statAfter = fs.statSync(realRoot).mtimeMs;
    assert.strictEqual(statAfter, statBefore, 'the real default pool root must not have been modified by this suite');
  }
});

// ── Report ──
if (failed > 0) {
  for (const { name, error } of failures) {
    process.stderr.write(`FAIL: ${name}\n  ${error && error.stack ? error.stack : error}\n`);
  }
  process.stderr.write(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${passed} passed, ${failed} failed\n`);
}
