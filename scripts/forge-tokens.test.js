#!/usr/bin/env node
'use strict';

// Contract tests for forge-tokens.js CLI. Run with:
//   node scripts/forge-tokens.test.js

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'forge-tokens.js');
const { truncateAtSectionBoundary } = require('./forge-tokens.js');
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

// ── truncateAtSectionBoundary(content, budgetChars, opts) — marker + budget ceiling ──

function multiSectionContent(n) {
  let out = '';
  for (let i = 0; i < n; i++) {
    out += `## Section ${i}\ncontent for section ${i} with some padding text here\n`;
  }
  return out;
}

test('with opts.source, marker names the source pointer', () => {
  const content = multiSectionContent(20);
  const result = truncateAtSectionBoundary(content, 200, { source: '.gsd/CODING-STANDARDS.md § Lint' });
  assert.match(result, /\[\.\.\.truncated \d+ sections — see \.gsd\/CODING-STANDARDS\.md § Lint\]$/);
});

test('without opts.source, marker is byte-identical to the historical format', () => {
  const content = multiSectionContent(20);
  const result = truncateAtSectionBoundary(content, 200);
  assert.match(result, /\n\n\[\.\.\.truncated \d+ sections\]$/);
  // The exact literal string the self-test and legacy prefix-based callers depend on.
  const droppedMatch = result.match(/\[\.\.\.truncated (\d+) sections\]$/);
  assert.ok(droppedMatch, 'marker must match legacy literal shape');
});

test('result never exceeds budgetChars across a sweep of small budgets, with and without source', () => {
  const content = multiSectionContent(30);
  const budgets = [10, 20, 40, 80];
  const sources = [undefined, '.gsd/CODING-STANDARDS.md § Somewhat Long Section Name'];
  for (const budgetChars of budgets) {
    for (const source of sources) {
      const opts = source !== undefined ? { source } : undefined;
      const result = truncateAtSectionBoundary(content, budgetChars, opts);
      assert.ok(
        result.length <= budgetChars,
        `budget=${budgetChars} source=${source}: result.length=${result.length} exceeds budgetChars`
      );
    }
  }
});

test('an absurdly long opts.source never blows the budget', () => {
  const content = multiSectionContent(10);
  const absurdSource = 'x'.repeat(5000);
  const result = truncateAtSectionBoundary(content, 100, { source: absurdSource });
  assert.ok(result.length <= 100, `result.length=${result.length} exceeds budget 100`);
});

test('opts.mandatory still throws with the same message, before any marker calculation', () => {
  assert.throws(
    () => truncateAtSectionBoundary('x'.repeat(1000), 100, { mandatory: true, label: 'test-label' }),
    /Context budget exceeded for mandatory section test-label/
  );
});

test('opts.mandatory throws even when opts.source is also present', () => {
  assert.throws(
    () => truncateAtSectionBoundary('x'.repeat(1000), 100, { mandatory: true, label: 'test-label', source: 'foo.md' }),
    /Context budget exceeded for mandatory section test-label/
  );
});

test('content that fits returns verbatim, unaffected by opts.source', () => {
  const content = 'short content that fits easily';
  const result = truncateAtSectionBoundary(content, 1000, { source: 'irrelevant.md' });
  assert.strictEqual(result, content);
});

test('fallback mid-content branch (zero boundaries) also respects opts.source and the budget ceiling', () => {
  const content = 'a'.repeat(500); // no "## " boundaries at all -> fallback branch
  const result = truncateAtSectionBoundary(content, 60, { source: 'fallback-source.md' });
  assert.ok(result.length <= 60, `result.length=${result.length} exceeds budget 60`);
  assert.match(result, /\[\.\.\.truncated 1 sections/);
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
