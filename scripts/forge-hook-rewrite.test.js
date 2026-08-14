#!/usr/bin/env node
// forge-hook-rewrite.test.js — standalone zero-dep suite for the S03/T03
// command-rewrite branch wired into forge-hook.js (PreToolUse Bash path).
//
// Every test spawns the REAL hook CLI as a child process (never require()s
// forge-hook.js — the hook is a process, tested as one, per T03-PLAN
// key_links). Every test that touches the resource pool points
// FORGE_RESOURCE_POOL_DIR at a fresh temp dir — the real
// ~/.claude/forge/resource-pool is never touched (mandatory per S02).
//
// Covers:
//  - guard ordering: a blocked command is never rewritten
//  - B1: zero fs/pool/resolver work for a non-candidate command (counting shim)
//  - B2: exception injection at each stage (tokenizer/resolver/pool/emission)
//    falls through byte-identical, exit 0, no rewrite stdout
//  - W5: release-on-error (leaked-lease proof) + normal-path release via the
//    PostToolUse bridge match
//  - census: rewrite-applied / rewrite-skipped events sum to candidates seen
//  - permission-hazard: no chain segment is ever auto-allowed
//  - single-stdout invariant on the rewritten path

'use strict';

const { spawnSync } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOOK_PATH = path.join(__dirname, 'forge-hook.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  pass: ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`  FAIL: ${name}\n    ${error.message}`);
  }
}

function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhrewrite-'));
  fs.mkdirSync(path.join(dir, '.gsd', 'forge'), { recursive: true });
  return dir;
}

function tmpPoolDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fhrewrite-pool-'));
}

function runPre(stdinObj, { cwd, env = {}, sessionId } = {}) {
  const payload = Object.assign({ session_id: sessionId || 'sess-1', cwd }, stdinObj);
  const result = spawnSync(process.execPath, [HOOK_PATH, 'pre'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: cwd || os.tmpdir(),
    env: Object.assign({}, process.env, env),
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function runPost(stdinObj, { cwd, env = {}, sessionId } = {}) {
  const payload = Object.assign({ session_id: sessionId || 'sess-1', cwd }, stdinObj);
  const result = spawnSync(process.execPath, [HOOK_PATH, 'post'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: cwd || os.tmpdir(),
    env: Object.assign({}, process.env, env),
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function bashPre(command, opts) {
  return runPre({ tool_name: 'Bash', tool_input: { command } }, opts);
}

function readEvents(cwd) {
  const p = path.join(cwd, '.gsd', 'forge', 'events.jsonl');
  try {
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function bridgePathFor(sessionId) {
  const sanitized = String(sessionId || 'nosession').replace(/[^\w.\-]/g, '_');
  return path.join(os.tmpdir(), `forge-rewrite-grant-${sanitized}.json`);
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Guard ordering — a blocked command is NEVER rewritten
// ═══════════════════════════════════════════════════════════════════════

test('guard ordering: git push --force is blocked, not rewritten (no rewrite event, exit 2)', () => {
  const cwd = tmpWorkspace();
  const poolDir = tmpPoolDir();
  const res = bashPre('git push --force && vitest run', { cwd, env: { FORGE_RESOURCE_POOL_DIR: poolDir } });
  assert.strictEqual(res.status, 2, 'blocked commands exit 2');
  assert.ok(/Bloqueado/.test(res.stdout), 'block message emitted');
  const events = readEvents(cwd);
  assert.ok(!events.some((e) => e.event === 'rewrite-applied' || e.event === 'rewrite-skipped'),
    'no rewrite event for a blocked command — the branch never engaged');
});

// ═══════════════════════════════════════════════════════════════════════
// 2. B1 — lexical short-circuit, zero fs/pool/resolver work for non-candidates
// ═══════════════════════════════════════════════════════════════════════

test('B1: non-runner command (ls) writes ZERO rewrite-stage counter lines', () => {
  const cwd = tmpWorkspace();
  const poolDir = tmpPoolDir();
  const counterFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fhrewrite-ctr-')), 'counters.txt');
  const res = bashPre('ls -la', {
    cwd,
    env: { FORGE_RESOURCE_POOL_DIR: poolDir, FORGE_REWRITE_TEST_COUNTERS: counterFile },
  });
  assert.strictEqual(res.status, 0, 'ls is allowed');
  assert.strictEqual(res.stdout, '', 'no stdout for a non-candidate command');
  assert.ok(!fs.existsSync(counterFile), 'counter file never created — zero fs/pool/resolver stages reached');
});

test('B1: a real runner candidate DOES reach the resolver/pool stages (control — proves the shim itself works)', () => {
  const cwd = tmpWorkspace();
  const poolDir = tmpPoolDir();
  const counterFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fhrewrite-ctr-')), 'counters.txt');
  const res = bashPre('vitest run', {
    cwd,
    env: { FORGE_RESOURCE_POOL_DIR: poolDir, FORGE_REWRITE_TEST_COUNTERS: counterFile },
  });
  assert.strictEqual(res.status, 0);
  const lines = fs.readFileSync(counterFile, 'utf8').trim().split('\n');
  assert.ok(lines.includes('resolver-require'), 'resolver stage reached for a candidate');
  assert.ok(lines.includes('resolver-acquire'), 'pool acquire stage reached for a candidate');
});

// ═══════════════════════════════════════════════════════════════════════
// 3. B2 — exception injection at each stage, byte-identical fallthrough
// ═══════════════════════════════════════════════════════════════════════

for (const stage of ['tokenizer', 'resolver', 'pool', 'emission']) {
  test(`B2: fault at stage "${stage}" → command proceeds byte-identical, exit 0, no rewrite stdout`, () => {
    const cwd = tmpWorkspace();
    const poolDir = tmpPoolDir();
    const res = bashPre('vitest run', {
      cwd,
      env: { FORGE_RESOURCE_POOL_DIR: poolDir, FORGE_REWRITE_FAULT: stage },
    });
    assert.strictEqual(res.status, 0, `stage ${stage}: hook still exits 0`);
    assert.strictEqual(res.stdout, '', `stage ${stage}: no rewrite JSON emitted on stdout`);
    const events = readEvents(cwd);
    assert.ok(!events.some((e) => e.event === 'rewrite-applied'),
      `stage ${stage}: no rewrite-applied event recorded`);
  });
}

test('W5: fault at stage "pool" (after acquire, before rewrite) releases the lease (no leaked slot)', () => {
  const cwd = tmpWorkspace();
  const poolDir = tmpPoolDir();
  const poolMod = require('./forge-resource-pool.js');

  // First call with no fault: acquire+rewrite normally to learn the ceiling
  // via a real grant, then release it so the pool is back to full capacity.
  const baseline = bashPre('vitest run', { cwd, env: { FORGE_RESOURCE_POOL_DIR: poolDir } });
  assert.strictEqual(baseline.status, 0);
  // Drain the bridge (simulate Claude running the rewritten command) so the
  // lease from the baseline call is released and doesn't pollute the count.
  const bridgeFile = bridgePathFor('sess-1');
  if (fs.existsSync(bridgeFile)) {
    const bridge = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'));
    poolMod.releaseSlots(bridge.grant.slots, { poolDir });
    fs.unlinkSync(bridgeFile);
  }
  const statusBefore = poolMod.poolStatus({ poolDir });

  // Second call: fault AFTER pool acquire (stage 'pool') — must release
  // before falling through.
  const faulted = bashPre('vitest run', {
    cwd,
    env: { FORGE_RESOURCE_POOL_DIR: poolDir, FORGE_REWRITE_FAULT: 'pool' },
  });
  assert.strictEqual(faulted.status, 0);
  assert.strictEqual(faulted.stdout, '', 'faulted call emits no rewrite stdout');

  const statusAfter = poolMod.poolStatus({ poolDir });
  assert.strictEqual(statusAfter.held, statusBefore.held,
    'pool held-slot count is restored after the faulted acquire — release-on-error worked (W5)');
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Rewritten path — single stdout invariant, event, bridge persisted
// ═══════════════════════════════════════════════════════════════════════

test('rewritten path: single stdout JSON with updatedInput, no permissionDecision field, rewrite-applied event', () => {
  const cwd = tmpWorkspace();
  const poolDir = tmpPoolDir();
  const sessionId = 'sess-rewrite-1';
  const res = bashPre('vitest run', { cwd, sessionId, env: { FORGE_RESOURCE_POOL_DIR: poolDir } });
  assert.strictEqual(res.status, 0);

  const lines = res.stdout.trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, 'exactly one stdout line — single-stdout invariant');
  const parsed = JSON.parse(lines[0]);
  assert.ok(parsed.hookSpecificOutput, 'hookSpecificOutput present');
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(parsed.hookSpecificOutput.updatedInput && parsed.hookSpecificOutput.updatedInput.command,
    'updatedInput.command present');
  assert.ok(!('permissionDecision' in parsed.hookSpecificOutput),
    'permissionDecision is NEVER emitted — T02 measured it is not required (no permission-widening)');
  assert.notStrictEqual(parsed.hookSpecificOutput.updatedInput.command, 'vitest run',
    'the emitted command is the REWRITTEN one, not the original');

  const events = readEvents(cwd);
  const applied = events.find((e) => e.event === 'rewrite-applied');
  assert.ok(applied, 'rewrite-applied event recorded');
  assert.strictEqual(applied.runner, 'vitest');
  assert.ok(Number.isFinite(applied.workers) && applied.workers > 0, 'workers field present and derived from grant.granted');

  // Bridge persisted for PostToolUse release.
  const bridgeFile = bridgePathFor(sessionId);
  assert.ok(fs.existsSync(bridgeFile), 'bridge file persisted');
  const bridge = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'));
  const expectedHash = crypto.createHash('sha256').update(parsed.hookSpecificOutput.updatedInput.command).digest('hex');
  assert.strictEqual(bridge.cmdHash, expectedHash, 'bridge cmdHash matches sha256 of the REWRITTEN command');

  // PostToolUse with the matching (rewritten) command releases + deletes bridge.
  const post = runPost(
    { tool_name: 'Bash', tool_input: { command: parsed.hookSpecificOutput.updatedInput.command } },
    { cwd, sessionId, env: { FORGE_RESOURCE_POOL_DIR: poolDir } }
  );
  assert.strictEqual(post.status, 0);
  assert.ok(!fs.existsSync(bridgeFile), 'bridge deleted after a matching PostToolUse release');
});

test('rewritten path: PostToolUse with a NON-matching command (Claude ignored the rewrite) leaves the bridge for TTL reap', () => {
  const cwd = tmpWorkspace();
  const poolDir = tmpPoolDir();
  const sessionId = 'sess-rewrite-2';
  const res = bashPre('jest', { cwd, sessionId, env: { FORGE_RESOURCE_POOL_DIR: poolDir } });
  assert.strictEqual(res.status, 0);
  const bridgeFile = bridgePathFor(sessionId);
  assert.ok(fs.existsSync(bridgeFile), 'bridge persisted after rewrite');

  const post = runPost(
    { tool_name: 'Bash', tool_input: { command: 'jest' } }, // the ORIGINAL, not the rewritten command
    { cwd, sessionId, env: { FORGE_RESOURCE_POOL_DIR: poolDir } }
  );
  assert.strictEqual(post.status, 0);
  assert.ok(fs.existsSync(bridgeFile), 'bridge left in place on mismatch — never deleted, never released here (TTL reap only)');
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Intact path — census, no lease held, no stdout
// ═══════════════════════════════════════════════════════════════════════

test('intact path: a candidate with --shard already set is left intact (never overrides a human choice) — rewrite-skipped event, no stdout', () => {
  const cwd = tmpWorkspace();
  const poolDir = tmpPoolDir();
  const res = bashPre('vitest run --shard=1/2', { cwd, env: { FORGE_RESOURCE_POOL_DIR: poolDir } });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '', 'no rewrite stdout for an intact outcome');
  const events = readEvents(cwd);
  const skipped = events.find((e) => e.event === 'rewrite-skipped');
  assert.ok(skipped, 'rewrite-skipped event recorded');
  assert.ok(typeof skipped.reason === 'string' && skipped.reason.length > 0, 'reason is a named enum member');
  assert.strictEqual(skipped.reason, 'intact:vitest-shard');
});

test('census: every LEXICAL-GATE candidate sums to exactly one of rewrite-applied | rewrite-skipped, no remainder (non-candidates like a subshell never engage the branch at all — B1/W3)', () => {
  const cwd = tmpWorkspace();
  const poolDir = tmpPoolDir();
  const candidates = ['vitest run', 'jest', 'vitest run --shard=1/2'];
  for (const cmd of candidates) {
    const res = bashPre(cmd, { cwd, env: { FORGE_RESOURCE_POOL_DIR: poolDir }, sessionId: `census-${cmd.length}-${Math.random()}` });
    assert.strictEqual(res.status, 0);
  }
  const events = readEvents(cwd).filter((e) => e.event === 'rewrite-applied' || e.event === 'rewrite-skipped');
  assert.strictEqual(events.length, candidates.length, 'exactly one outcome event per candidate — no remainder');
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Permission-widening hazard — dangerous chain never auto-allowed
// ═══════════════════════════════════════════════════════════════════════

test('permission hazard: a dangerous non-benign chain segment (rm -rf <path> && npm test) is NEVER auto-allowed and passes intact', () => {
  const cwd = tmpWorkspace();
  const poolDir = tmpPoolDir();
  const dangerous = 'rm -rf /tmp/some-build-dir && npm test';
  const res = bashPre(dangerous, { cwd, env: { FORGE_RESOURCE_POOL_DIR: poolDir } });
  assert.strictEqual(res.status, 0);
  if (res.stdout.trim()) {
    const parsed = JSON.parse(res.stdout.trim());
    assert.ok(!('permissionDecision' in (parsed.hookSpecificOutput || {})),
      'permissionDecision is never emitted by this branch under any circumstance');
  }
  // Whether the chain rewrites the npm-test segment or refuses outright, the
  // branch NEVER emits permissionDecision:'allow' anywhere (T02 finding —
  // this branch structurally cannot widen permission since it never emits
  // the field at all).
});

// ═══════════════════════════════════════════════════════════════════════
// 7. Absent module — inert branch (key_links contract)
// ═══════════════════════════════════════════════════════════════════════

test('absent forge-command-rewrite.js module → branch is inert, command passes intact, exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhrewrite-noshim-'));
  const scriptsDir = path.join(dir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  // Copy every scripts/*.js EXCEPT forge-command-rewrite.js into an isolated
  // scripts dir, then run a copy of forge-hook.js from that dir.
  const srcScripts = __dirname;
  for (const f of fs.readdirSync(srcScripts)) {
    if (f === 'forge-command-rewrite.js') continue;
    if (!f.endsWith('.js')) continue;
    fs.copyFileSync(path.join(srcScripts, f), path.join(scriptsDir, f));
  }
  const hookCopy = path.join(dir, 'forge-hook.js');
  fs.copyFileSync(HOOK_PATH, hookCopy);

  const cwd = tmpWorkspace();
  const poolDir = tmpPoolDir();
  const result = spawnSync(process.execPath, [hookCopy, 'pre'], {
    input: JSON.stringify({ session_id: 'sess-noshim', cwd, tool_name: 'Bash', tool_input: { command: 'vitest run' } }),
    encoding: 'utf8',
    cwd,
    env: Object.assign({}, process.env, { FORGE_RESOURCE_POOL_DIR: poolDir }),
  });
  assert.strictEqual(result.status, 0, 'inert branch still exits 0');
  assert.strictEqual(result.stdout, '', 'no rewrite stdout when the module is absent');
});

console.log(`\n${passed + failed} assertions/tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`);
  process.exit(1);
}
