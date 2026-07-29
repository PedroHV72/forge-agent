#!/usr/bin/env node
'use strict';

// Standalone contract suite for environment-claim corroboration.

const { corroborates, checkEnvPromotion } = require('./forge-env-promote.js');

let passes = 0;
let fails = 0;

function assert(value, name, detail) {
  if (value) { passes += 1; process.stdout.write(`  ✓ ${name}\n`); }
  else { fails += 1; process.stdout.write(`  ✗ ${name}${detail ? `: ${detail}` : ''}\n`); }
}

function entry(overrides) {
  return {
    item: 'environment-constrained must-have', status: 'unmet', scope: 'environment',
    reason: 'git-commit-required', note: '', ...overrides,
  };
}

function promotes(value, planText = '') {
  return checkEnvPromotion({ status: 'partial', must_haves_status: [value] }, planText);
}

const m017Note = 'Not run: this test file intentionally invokes git in its existing fixture helper, and the task prohibits running any git command. Static inspection confirms 25 tests.';
const contrafactual = entry({ note: m017Note });
assert(typeof corroborates(contrafactual, '') === 'string' && promotes(contrafactual).promote === false,
  'git mention without a write operation is rejected (M017 contrafactual)');

const honest = entry({ note: 'proving the second revision requires `git commit`; auto_commit:false forbids committing' });
assert(corroborates(honest, '') === null && promotes(honest).promote === true,
  'a genuine required git commit remains accepted');

const washed = entry({ item: 'must run git commit to prove this', note: '' });
assert(typeof corroborates(washed, '') === 'string' && promotes(washed).promote === false,
  'item-only git write evidence is rejected (wash-proof)');

const neighbors = [
  [entry({ reason: 'gsd-write-refused', note: 'refused .gsd/STATE.md' }), '', true],
  [entry({ reason: 'out-of-scope-test-failure', note: 'existing tests/foo.test.js fails' }), 'writes:\n - src/example.js', true],
  [entry({ reason: 'network-required', note: 'must install package from network registry' }), '', true],
  [entry({ reason: 'sandbox-exec-blocked', note: 'ran `npm test`: EPERM: operation not permitted' }), '', true],
];
for (const [neighbor, planText, expected] of neighbors) {
  assert(promotes(neighbor, planText).promote === expected,
    `${neighbor.reason} retains its existing corroboration verdict`);
}

process.stdout.write(`Results: ${passes} passed, ${fails} failed\n`);
process.exitCode = fails ? 1 : 0;
