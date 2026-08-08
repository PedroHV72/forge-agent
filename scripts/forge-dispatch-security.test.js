#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const runtime = require('./forge-runtime.js');
const policy = require('./forge-dispatch-policy.js');
const { nextInChain } = require('./forge-routing.js');

const fixtureDir = path.join(__dirname, 'fixtures', 'dispatch-security');
const taxonomy = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'failure-taxonomy.json'), 'utf8'));
const fakeWorker = path.join(fixtureDir, 'fake-dispatch-worker.js');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dispatch-matrix Ω '));
const bySignal = new Map(taxonomy.failures.map((entry) => [entry.signal, entry]));

function decision(signal, state) {
  const failure = bySignal.get(signal);
  assert(failure, `unknown signal ${signal}`);
  if (failure.retry === 'same-attempt-bounded' && state.transient_retry_count < state.max_retries) {
    return { action: 'retry-same-member', sidecar_attempt: state.sidecar_attempt, transient_retry_count: state.transient_retry_count + 1 };
  }
  if (failure.next === 'configured-member') {
    const next = nextInChain(state.chain, state.fallback, state.current);
    return next ? { action: 'advance-configured', next } : { action: 'stop-human', next: '' };
  }
  return { action: 'stop-human' };
}

function telemetry(input) {
  const event = {};
  for (const key of taxonomy.required_event_fields) event[key] = input[key];
  return event;
}

try {
  assert.strictEqual(taxonomy.protocol_version, runtime.PROTOCOL_VERSION);
  assert.strictEqual(new Set(taxonomy.failures.map((entry) => entry.reason_code)).size, taxonomy.failures.length);
  for (const failure of taxonomy.failures) {
    assert(['transient', 'terminal'].includes(failure.error_class));
    assert(Array.isArray(failure.legacy_reason_codes) && failure.legacy_reason_codes.length > 0);
    if (['timeout', 'orphan', 'output-invalid', 'protected-state', 'capability-denied', 'reset-overlap', 'verification-failed'].includes(failure.signal)) {
      assert.strictEqual(failure.error_class, 'terminal');
      assert.strictEqual(failure.retry, 'none');
    }
  }

  const chain = [
    { id: 'gpt-5.6-sol', engine: 'gpt' },
    { id: 'claude-opus-5', engine: 'claude' },
    { id: 'gpt-5.6-terra', engine: 'gpt' },
  ];
  assert(chain.filter((member) => member.engine === 'gpt').length <= taxonomy.max_codex_members);
  const state = { chain, fallback: { id: 'claude-fable-5' }, current: chain[0].id, sidecar_attempt: 1, transient_retry_count: 0, max_retries: 2 };
  assert.deepStrictEqual(decision('provider-transient', state), { action: 'retry-same-member', sidecar_attempt: 1, transient_retry_count: 1 });
  assert.deepStrictEqual(decision('provider-transient', { ...state, transient_retry_count: 2 }), { action: 'advance-configured', next: 'claude-opus-5' });
  assert.deepStrictEqual(decision('timeout', state), { action: 'advance-configured', next: 'claude-opus-5' });
  assert.deepStrictEqual(decision('reset-overlap', state), { action: 'stop-human' });
  assert.strictEqual(nextInChain(chain, { id: 'claude-fable-5' }, 'claude-fable-5'), '');

  let matrixRows = 0;
  for (const platform of ['win32', 'darwin', 'linux']) for (const host of ['claude', 'codex']) for (const worker of ['native', 'claude', 'codex']) for (const role of ['orchestrator', 'worker', 'reviewer']) for (const sandbox of ['read-only', 'workspace-write']) {
    matrixRows += 1;
    const resolvedEngine = worker === 'native' ? host : worker;
    const workerMode = worker === 'native' || resolvedEngine === host ? 'native' : 'sidecar';
    const resolved = runtime.resolveWorker({ host_runtime: host, worker_engine: worker, worker_mode: workerMode, sidecar_declared: workerMode === 'sidecar' });
    assert.strictEqual(resolved.host_runtime, host, `${platform} host is immutable`);
    assert.strictEqual(resolved.resolved_engine, resolvedEngine, `${platform} worker is explicit`);
    const requestRole = role === 'reviewer' ? 'reviewer' : role;
    const verdict = policy.decide({
      role: requestRole, host_runtime: host, worker_engine: worker, worker_mode: workerMode,
      sidecar_declared: workerMode === 'sidecar', operation: 'spawn', sandbox_mode: sandbox,
      required_capabilities: ['process.spawn'], available_capabilities: ['process.spawn'],
      workspace_root: workspace, spawn_cwd: workspace, platform,
    });
    if (role === 'reviewer') {
      assert.strictEqual(verdict.decision, 'deny');
      assert.strictEqual(verdict.permissions.workspace_write, false);
      assert.strictEqual(verdict.permissions.spawn, false);
    } else {
      assert.strictEqual(verdict.decision, 'allow');
      assert.strictEqual(verdict.permissions.workspace_write, sandbox === 'workspace-write');
      assert.strictEqual(verdict.permissions.credential_env, false);
      assert.deepStrictEqual(verdict.grants, []);
    }
  }
  assert.strictEqual(matrixRows, 108);

  for (const scenario of ['success', 'transient', 'terminal', 'malformed', 'capability-denied']) {
    const marker = `space %PATH% & ; quote\" Unicode Ω CRLF\r\n${scenario}`;
    const child = spawnSync(process.execPath, [fakeWorker, scenario, marker], { cwd: workspace, shell: false, encoding: 'utf8', timeout: 3000 });
    assert.strictEqual(child.status, 0);
    if (scenario === 'malformed') assert.throws(() => JSON.parse(child.stdout));
    else assert.strictEqual(JSON.parse(child.stdout).argv[1], marker);
  }

  const event = telemetry({
    protocol_version: taxonomy.protocol_version, dispatch_id: crypto.randomUUID(), engine: 'codex',
    reason_code: 'provider-transient', error_class: 'transient', security_decision: 'allow',
    attempt: 1, state_snapshot: { sidecar_attempt: 1, transient_retry_count: 1, current_member: 'gpt-5.6-sol' },
    credential: 'secret', env: { OPENAI_API_KEY: 'secret' }, prompt: 'private', transcript: 'private', token: 'secret',
  });
  assert.deepStrictEqual(Object.keys(event), taxonomy.required_event_fields);
  for (const key of taxonomy.forbidden_event_fields) assert.strictEqual(Object.prototype.hasOwnProperty.call(event, key), false);
  assert.strictEqual(event.dispatch_id.length > 20, true);

  console.log(`forge-dispatch security matrix passed (${matrixRows} rows; ${taxonomy.failures.length} failure classes)`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
