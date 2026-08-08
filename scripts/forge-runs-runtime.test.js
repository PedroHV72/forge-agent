#!/usr/bin/env node
'use strict';

// Persistence regression suite. Every assertion reopens the JSON file because
// the public contract is the durable registry, not a returned object.
const fs = require('fs');
const os = require('os');
const path = require('path');
const child = require('child_process');
const runs = require('./forge-runs.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.log(`  ✗ ${name}\n      ${error.message}`); }
}
function assert(value, message) { if (!value) throw new Error(message || 'assertion failed'); }
function equal(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message || 'values differ'}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}
function sandbox(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge runs espaço-'));
  fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
  try { return fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}
function readDisk(cwd, id) { return JSON.parse(fs.readFileSync(runs.runFile(cwd, id), 'utf8')); }
function base(id) { return { id, kind: 'milestone', session_id: `legacy-${id}`, active: true }; }

test('adds a legacy 3.1.4 record without runtime metadata', () => sandbox(cwd => {
  runs.add(cwd, base('M901'));
  const stored = readDisk(cwd, 'M901');
  assert(!Object.prototype.hasOwnProperty.call(stored, 'host_runtime'), 'must not backfill host');
  assert(!Object.prototype.hasOwnProperty.call(stored, 'session'), 'must not backfill neutral session');
  equal(stored.session_id, 'legacy-M901');
}));

test('accepts neutral session in new records while retaining legacy alias', () => sandbox(cwd => {
  runs.add(cwd, { id: 'M902', kind: 'milestone', session: 'opaque value', host_runtime: 'codex', owner: 'o1' });
  const stored = readDisk(cwd, 'M902');
  equal(stored.session, 'opaque value');
  equal(stored.session_id, 'opaque value');
  equal(stored.host_runtime, 'codex');
  equal(stored.owner, 'o1');
}));

test('rejects an unknown supplied host runtime', () => sandbox(cwd => {
  let threw = false;
  try { runs.add(cwd, { id: 'M903', kind: 'milestone', session: 'x', host_runtime: 'gemini' }); }
  catch (error) { threw = error.code === 'invalid-host-runtime'; }
  assert(threw, 'runtime normalizer must reject unknown values');
}));

test('update merges heartbeat and worker patches without changing metadata', () => sandbox(cwd => {
  runs.add(cwd, { ...base('M904'), host_runtime: 'claude', session: 'opaque', owner: 'owner-a' });
  runs.update(cwd, 'M904', { heartbeat: 100, last_heartbeat: 100 });
  runs.update(cwd, 'M904', { worker: 'forge-executor', worker_started: 101 });
  const stored = readDisk(cwd, 'M904');
  equal(stored.heartbeat, 100); equal(stored.worker, 'forge-executor');
  equal(stored.host_runtime, 'claude'); equal(stored.owner, 'owner-a');
}));

test('bump heartbeat preserves independent worker fields', () => sandbox(cwd => {
  runs.add(cwd, { ...base('M905'), worker: 'worker-a', host_runtime: 'codex' });
  runs.bumpHeartbeat(cwd, 'M905', 12345);
  const stored = readDisk(cwd, 'M905');
  equal(stored.last_heartbeat, 12345); equal(stored.worker, 'worker-a'); equal(stored.host_runtime, 'codex');
}));

test('atomic write leaves parseable JSON and no temporary file', () => sandbox(cwd => {
  runs.add(cwd, base('M906'));
  for (let index = 0; index < 10; index++) {
    runs.update(cwd, 'M906', { heartbeat: index });
    assert(typeof readDisk(cwd, 'M906').heartbeat === 'number', 'disk record should parse after each update');
  }
  const names = fs.readdirSync(runs.runsDir(cwd));
  equal(names.filter(name => name.includes('.tmp')).length, 0, 'temporary files should be renamed away');
}));

test('independent processes serialize heartbeat and worker changes', () => sandbox(cwd => {
  runs.add(cwd, base('M907'));
  const script = [
    "const r=require(process.argv[1]); const cwd=process.argv[2]; const patch=JSON.parse(process.argv[3]); r.update(cwd, 'M907', patch);",
  ].join('');
  const modulePath = path.join(__dirname, 'forge-runs.js');
  const first = child.spawnSync(process.execPath, ['-e', script, modulePath, cwd, JSON.stringify({ heartbeat: 77 })], { encoding: 'utf8', shell: false });
  const second = child.spawnSync(process.execPath, ['-e', script, modulePath, cwd, JSON.stringify({ worker: 'parallel-worker' })], { encoding: 'utf8', shell: false });
  assert(first.status === 0, first.stderr); assert(second.status === 0, second.stderr);
  const stored = readDisk(cwd, 'M907'); equal(stored.heartbeat, 77); equal(stored.worker, 'parallel-worker');
}));

test('selection ignores neutral metadata and legacy session aliases', () => sandbox(cwd => {
  runs.add(cwd, { ...base('M908'), started_at: 1, host_runtime: 'claude', session: 'claude-looking' });
  runs.add(cwd, { ...base('M909'), started_at: 2, host_runtime: 'codex', session: 'codex-looking' });
  equal(runs.oldestActive(cwd).id, 'M908');
  equal(runs.resolveBySessionId(cwd, 'legacy-M909').id, 'M909');
}));

test('legacy alias is best effort and atomically parseable', () => sandbox(cwd => {
  runs.add(cwd, base('M910'));
  const alias = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
  equal(JSON.parse(fs.readFileSync(alias, 'utf8')).active, true);
  assert(!fs.readdirSync(path.dirname(alias)).some(name => name.includes('.tmp')), 'alias temp must not survive');
}));

// Field-level cases ensure additive compatibility is intentional rather than
// an accidental consequence of Object.assign in one happy-path test.
test('preserves unknown forward-compatible fields during update', () => sandbox(cwd => {
  runs.add(cwd, { ...base('M911'), future_extension: { generation: 2 } });
  runs.update(cwd, 'M911', { worker: 'worker-b' });
  equal(readDisk(cwd, 'M911').future_extension, { generation: 2 });
}));

test('records all optional neutral metadata when explicitly provided', () => sandbox(cwd => {
  runs.add(cwd, {
    ...base('M912'), owner: 'opaque-owner', host_runtime: 'claude', session: 'any-shape',
    heartbeat: 18, expires_at: 25, worker_engine: 'native',
  });
  const record = readDisk(cwd, 'M912');
  equal(record.owner, 'opaque-owner');
  equal(record.host_runtime, 'claude');
  equal(record.session, 'any-shape');
  equal(record.heartbeat, 18);
  equal(record.expires_at, 25);
  equal(record.worker_engine, 'native');
}));

test('Codex and Claude metadata have the same active selection result', () => sandbox(cwd => {
  runs.add(cwd, { ...base('M913'), started_at: 10, host_runtime: 'claude', session: 'x' });
  runs.add(cwd, { ...base('M914'), started_at: 20, host_runtime: 'codex', session: 'y' });
  const before = runs.listActive(cwd).map(record => record.id);
  runs.update(cwd, 'M913', { heartbeat: 1 });
  runs.update(cwd, 'M914', { heartbeat: 2 });
  equal(runs.listActive(cwd).map(record => record.id), before);
  equal(runs.oldestActive(cwd).id, 'M913');
}));

test('explicit host updates normalize casing without inferring from session', () => sandbox(cwd => {
  runs.add(cwd, { ...base('M915'), session: 'codex-like-but-opaque', host_runtime: 'CODEX' });
  equal(readDisk(cwd, 'M915').host_runtime, 'codex');
  runs.update(cwd, 'M915', { session: 'claude-like-but-still-opaque' });
  equal(readDisk(cwd, 'M915').host_runtime, 'codex');
}));

test('inactive records remain readable with neutral metadata', () => sandbox(cwd => {
  runs.add(cwd, { ...base('M916'), active: false, host_runtime: 'codex', owner: 'dead-owner' });
  equal(runs.get(cwd, 'M916').active, false);
  equal(runs.listActive(cwd).length, 0);
  equal(runs.get(cwd, 'M916').owner, 'dead-owner');
}));

test('cleanup stale removes only the stale canonical record', () => sandbox(cwd => {
  runs.add(cwd, { ...base('M917'), last_heartbeat: 1 });
  runs.add(cwd, { ...base('M918'), last_heartbeat: Date.now() });
  const removed = runs.cleanupStale(cwd, 1000);
  assert(removed.includes('M917'), 'stale record should be selected');
  assert(runs.get(cwd, 'M917') === null, 'stale file should be gone');
  assert(runs.get(cwd, 'M918') !== null, 'fresh file should remain');
}));

test('remove refreshes legacy alias without changing another record', () => sandbox(cwd => {
  runs.add(cwd, { ...base('M919'), started_at: 1 });
  runs.add(cwd, { ...base('M920'), started_at: 2 });
  runs.remove(cwd, 'M919');
  equal(runs.oldestActive(cwd).id, 'M920');
  const alias = JSON.parse(fs.readFileSync(path.join(cwd, '.gsd', 'forge', 'auto-mode.json'), 'utf8'));
  equal(alias.active, true);
  equal(alias.started_at, 2);
}));

test('a task record retains task-only legacy fields after neutral update', () => sandbox(cwd => {
  runs.add(cwd, { id: 'T-1-task', kind: 'task', session_id: 'legacy', task_description: 'do it', pending_decisions: ['d'] });
  runs.update(cwd, 'T-1-task', { host_runtime: 'claude', session: 'neutral' });
  const record = readDisk(cwd, 'T-1-task');
  equal(record.task_description, 'do it');
  equal(record.pending_decisions, ['d']);
  equal(record.session_id, 'legacy');
  equal(record.session, 'neutral');
}));

test('readers observe complete JSON after every worker metadata update', () => sandbox(cwd => {
  runs.add(cwd, base('M921'));
  const patches = [
    { worker: 'a' },
    { worker_started: 2 },
    { owner: 'owner-2' },
    { heartbeat: 3 },
    { expires_at: 4 },
    { session: 'opaque-2' },
  ];
  for (const patch of patches) {
    runs.update(cwd, 'M921', patch);
    const raw = fs.readFileSync(runs.runFile(cwd, 'M921'), 'utf8');
    assert(raw.startsWith('{') && raw.trim().endsWith('}'), 'complete JSON document required');
    JSON.parse(raw);
  }
}));

test('empty optional host patch does not backfill a legacy record', () => sandbox(cwd => {
  runs.add(cwd, base('M922'));
  runs.update(cwd, 'M922', { host_runtime: undefined });
  assert(!Object.prototype.hasOwnProperty.call(readDisk(cwd, 'M922'), 'host_runtime'));
}));

test('metadata values remain opaque across provider-looking session strings', () => sandbox(cwd => {
  const values = ['claude-session/42', 'codex:thread:99', 'unicode sessão ✓'];
  for (let index = 0; index < values.length; index++) {
    const id = `M93${index}`;
    runs.add(cwd, { ...base(id), session: values[index], host_runtime: index % 2 ? 'codex' : 'claude' });
    equal(readDisk(cwd, id).session, values[index]);
  }
  equal(runs.listActive(cwd).length, values.length);
}));

test('ordinary update does not replace canonical session aliases', () => sandbox(cwd => {
  runs.add(cwd, { ...base('M926'), session: 'new-session' });
  runs.update(cwd, 'M926', { worker: 'updated' });
  const record = readDisk(cwd, 'M926');
  equal(record.session_id, 'legacy-M926');
  equal(record.session, 'new-session');
}));

test('all supported hosts can persist the same provider-neutral fields', () => sandbox(cwd => {
  for (const host of ['claude', 'codex']) {
    const id = `M-${host}`;
    runs.add(cwd, { ...base(id), host_runtime: host, owner: `${host}-owner`, session: `${host}-opaque` });
    const record = readDisk(cwd, id);
    equal(record.owner, `${host}-owner`);
    equal(record.session, `${host}-opaque`);
    equal(record.active, true);
  }
}));

test('metadata-only update leaves phase-like run fields untouched', () => sandbox(cwd => {
  runs.add(cwd, { ...base('M-meta'), worker: 'before', isolation_mode: 'worktree' });
  runs.update(cwd, 'M-meta', { heartbeat: 99 });
  const record = readDisk(cwd, 'M-meta');
  equal(record.worker, 'before');
  equal(record.isolation_mode, 'worktree');
  equal(record.heartbeat, 99);
}));

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
if (failed) process.exit(1);
