#!/usr/bin/env node
'use strict';

// Contract tests for forge-tokens.js CLI. Run with:
//   node scripts/forge-tokens.test.js

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'forge-tokens.js');
let passed = 0;
let failed = 0;

function run(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input: input === undefined ? '' : input,
  });
}

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed++;
    process.stderr.write(`  ✗ ${name}: ${err.message}\n`);
  }
}

process.stdout.write('\n=== forge-tokens.js — contract tests ===\n\n');

test('--inline emits the raw integer only', () => {
  const res = run(['--inline', 'abcde']);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '2\n');
  assert.strictEqual(res.stderr, '');
});

test('--inline preserves multiline, unicode and shell metacharacters as data', () => {
  const text = 'linha 1\ná $(echo nope) "quoted" & | ;';
  const res = run(['--inline', text]);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, `${Math.ceil(text.length / 4)}\n`);
  assert.strictEqual(res.stderr, '');
});

test('--inline accepts an empty string and returns zero', () => {
  const res = run(['--inline', '']);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '0\n');
});

test('--inline treats help-looking text as data', () => {
  const res = run(['--inline', '--help']);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '2\n');
  assert.strictEqual(res.stderr, '');
});

test('--inline without a value exits 2', () => {
  const res = run(['--inline']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /--inline requires exactly one text argument/);
  assert.strictEqual(res.stdout, '');
});

test('--inline cannot be combined with another argument', () => {
  const res = run(['--inline', 'abc', '--mandatory']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /cannot be combined/);
  assert.strictEqual(res.stdout, '');
});

test('--scalar reads arbitrary text from stdin and emits the raw integer', () => {
  const text = 'resultado\ncom unicode á e $(metacaracteres)';
  const res = run(['--scalar'], text);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, `${Math.ceil(text.length / 4)}\n`);
  assert.strictEqual(res.stderr, '');
});

test('--scalar cannot be combined with another flag', () => {
  const res = run(['--scalar', '--mandatory'], 'abc');
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /cannot be combined/);
  assert.strictEqual(res.stdout, '');
});

test('unknown arguments fail instead of silently counting empty stdin', () => {
  const res = run(['--unknown']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /unknown argument/);
  assert.strictEqual(res.stdout, '');
});

test('--file without a path exits 2', () => {
  const res = run(['--file']);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /--file requires a path argument/);
  assert.strictEqual(res.stdout, '');
});

test('stdin mode retains the structured JSON contract', () => {
  const res = run([], 'hello world');
  assert.strictEqual(res.status, 0);
  assert.deepStrictEqual(JSON.parse(res.stdout), {
    tokens: 3,
    chars: 11,
    method: 'heuristic',
  });
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
