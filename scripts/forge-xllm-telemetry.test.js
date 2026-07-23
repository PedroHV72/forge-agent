#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { normalizeDispatchId, buildPlanPrompt } = require('./forge-xllm.js');
const { countTokens } = require('./forge-tokens.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

test('sidecar dispatch IDs are generated and collision-resistant in shape', () => {
  const first = normalizeDispatchId(null, 'execute');
  const second = normalizeDispatchId(null, 'execute');
  assert.match(first, /^xllm-execute-\d+-[a-f0-9]{10}$/);
  assert.notStrictEqual(first, second);
});

test('caller-provided safe dispatch ID round-trips exactly', () => {
  assert.strictEqual(normalizeDispatchId('execute-task-T03-a2', 'execute'), 'execute-task-T03-a2');
});

test('unsafe dispatch IDs are rejected before process creation', () => {
  assert.throws(() => normalizeDispatchId('../escape', 'plan'), /invalid --dispatch-id/);
  assert.throws(() => normalizeDispatchId('has space', 'plan'), /invalid --dispatch-id/);
});

test('sidecar input telemetry counts the actual built prompt', () => {
  const prompt = buildPlanPrompt('milestone context');
  assert(Number.isInteger(countTokens(prompt)) && countTokens(prompt) > 0);
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
