#!/usr/bin/env node
'use strict';

const assert = require('assert');
const compare = require('./forge-semantic-compare');

try {
  const left = {
    adapter_runtime: 'claude',
    state: { phase: 'execute-task', host_runtime: 'claude', session: 'claude-session', value: 1 },
    events: [
      { event: 'unit-began', host_runtime: 'claude', ts: '2026-08-04T00:00:00.000Z' },
      { event: 'unit-completed', owner: 'sha256:one' },
    ],
  };
  const right = {
    adapter_runtime: 'codex',
    state: { phase: 'execute-task', host_runtime: 'codex', session: 'codex-session', value: 1 },
    events: [
      { event: 'unit-began', host_runtime: 'codex', ts: '2026-08-04T01:00:00.000Z' },
      { event: 'unit-completed', owner: 'sha256:two' },
    ],
  };
  assert.strictEqual(compare.compare(left, right).equal, true);
  assert.strictEqual(compare.assertEquivalent(left, right).equal, true);

  const stateMismatch = compare.compare(left, { ...right, state: { ...right.state, value: 2 } });
  assert.strictEqual(stateMismatch.equal, false);
  assert(stateMismatch.differences.some((item) => item.path === '$.state.value'));

  const orderedMismatch = compare.compare(left, { ...right, events: [...right.events].reverse() });
  assert.strictEqual(orderedMismatch.equal, false);
  assert(orderedMismatch.differences.some((item) => item.path === '$.events[0].event'));

  const unitMismatch = compare.compare({ unit: { type: 'execute-task', id: 'T01', key: 'execute-task/T01' } }, { unit: { type: 'execute-task', id: 'T02', key: 'execute-task/T02' } });
  assert.strictEqual(unitMismatch.equal, false);
  assert(unitMismatch.differences.some((item) => item.path === '$.unit.id'));

  const unknownMetadata = compare.compare({ state: { custom_metadata: 'a' } }, { state: { custom_metadata: 'b' } });
  assert.strictEqual(unknownMetadata.equal, false);
  assert.throws(() => compare.assertEquivalent({ outcome: 'completed' }, { outcome: 'blocked' }), (error) => error.code === 'semantic-mismatch' && error.differences[0].path === '$.outcome');

  const strict = compare.compare({ host_runtime: 'claude' }, { host_runtime: 'codex' }, { ignoreMetadata: false });
  assert.strictEqual(strict.equal, false);
  assert.strictEqual(compare.normalize({ host_runtime: 'claude', value: 1 }).value, 1);
  console.log('forge-semantic-compare tests passed');
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
