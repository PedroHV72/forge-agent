#!/usr/bin/env node
'use strict';

// In-process suite for scripts/forge-command-rewrite.js. Table-driven:
// tokenizer accept/refuse per construct, insertion-only property, per-manager
// `--` rule, per-runner flag/env mapping, chain segmentation, no-false-
// negative gate proof, D10 zero-sizing grep assert.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  tokenizeCommand,
  looksLikeRunnerCommand,
  planRewrite,
  REWRITE_REASON_CODES,
  TOKENIZE_REFUSAL_REASONS,
} = require('./forge-command-rewrite.js');

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

const BUDGET = { admit: true, workers: 4, heapMb: 2048, playwrightWorkers: 2 };

// ── Tokenizer: refusal table — every construct, exact reason ──────────────
const REFUSAL_TABLE = [
  { cmd: 'echo $(whoami)', reason: TOKENIZE_REFUSAL_REASONS.COMMAND_SUBSTITUTION, name: 'command substitution $()' },
  { cmd: 'echo `whoami`', reason: TOKENIZE_REFUSAL_REASONS.BACKTICK, name: 'backtick substitution' },
  { cmd: 'cat a | grep b', reason: TOKENIZE_REFUSAL_REASONS.SINGLE_PIPE, name: 'single pipe' },
  { cmd: 'npm test < input.txt', reason: TOKENIZE_REFUSAL_REASONS.REDIRECTION, name: 'redirection <' },
  { cmd: 'npm test > out.txt', reason: TOKENIZE_REFUSAL_REASONS.REDIRECTION, name: 'redirection >' },
  { cmd: 'npm test << EOF', reason: TOKENIZE_REFUSAL_REASONS.REDIRECTION, name: 'heredoc <<' },
  { cmd: 'npm test &', reason: TOKENIZE_REFUSAL_REASONS.BACKGROUND, name: 'background &' },
  { cmd: '(npm test)', reason: TOKENIZE_REFUSAL_REASONS.SUBSHELL, name: 'subshell ( )' },
  { cmd: 'npm test \\; echo done', reason: TOKENIZE_REFUSAL_REASONS.BACKSLASH_ESCAPE, name: 'backslash escape outside quotes' },
  { cmd: 'npm test\nnpm run build', reason: TOKENIZE_REFUSAL_REASONS.NEWLINE, name: 'embedded newline' },
  { cmd: "npm test 'unterminated", reason: TOKENIZE_REFUSAL_REASONS.UNTERMINATED_QUOTE, name: 'unterminated single quote' },
  { cmd: 'npm test "unterminated', reason: TOKENIZE_REFUSAL_REASONS.UNTERMINATED_QUOTE, name: 'unterminated double quote' },
  { cmd: 'echo "$HOME"', reason: TOKENIZE_REFUSAL_REASONS.COMMAND_SUBSTITUTION, name: 'interpolation inside double quotes ($)' },
  { cmd: 'echo "`x`"', reason: TOKENIZE_REFUSAL_REASONS.BACKTICK, name: 'backtick inside double quotes' },
  { cmd: 'echo "a\\"b"', reason: TOKENIZE_REFUSAL_REASONS.BACKSLASH_ESCAPE, name: 'backslash inside double quotes' },
  { cmd: '', reason: TOKENIZE_REFUSAL_REASONS.EMPTY_OR_INVALID, name: 'empty string' },
];

for (const c of REFUSAL_TABLE) {
  test(`tokenizeCommand refuses: ${c.name}`, () => {
    const result = tokenizeCommand(c.cmd);
    assert.strictEqual(result.ok, false, `expected refusal for: ${c.cmd}`);
    assert.strictEqual(result.reason, c.reason, `wrong reason for: ${c.cmd}`);
  });
}

// Adversarial: a chain whose SECOND segment is the dangerous one — the
// refusal must still fire (whole command refuses, not just the bad segment).
test('tokenizeCommand refuses on a dangerous SECOND chain segment', () => {
  const result = tokenizeCommand('npm test && rm -rf ~');
  // '~' alone is fine; the danger here is proven via a genuinely unprovable
  // construct in segment 2.
  const withSub = tokenizeCommand('npm test && echo $(whoami)');
  assert.strictEqual(withSub.ok, false);
  assert.strictEqual(withSub.reason, TOKENIZE_REFUSAL_REASONS.COMMAND_SUBSTITUTION);
  assert.strictEqual(result.ok, true); // sanity: the benign twin tokenizes fine
});

// Adversarial: a command that merely MENTIONS a runner name inside a string
// must not be treated as a runner invocation.
test('looksLikeRunnerCommand: false for a runner name merely mentioned in a string', () => {
  assert.strictEqual(looksLikeRunnerCommand("echo 'run vitest later'"), false);
  assert.strictEqual(looksLikeRunnerCommand('echo "npm test is next"'), false);
});

// ── Accept table: recognized forms tokenize successfully ──────────────────
const ACCEPT_TABLE = [
  'vitest',
  'vitest run',
  'jest',
  'jest --coverage',
  'playwright test',
  'npx vitest',
  'npx playwright test',
  'node_modules/.bin/vitest',
  'npm test',
  'npm run build',
  'pnpm test',
  'pnpm run lint',
  'yarn test',
  'yarn run test',
  'npm test && npm run build',
  'vitest ; jest',
  "FOO=bar npm test",
  'echo --foo="bar baz"qux',
];
for (const cmd of ACCEPT_TABLE) {
  test(`tokenizeCommand accepts: ${cmd}`, () => {
    const result = tokenizeCommand(cmd);
    assert.strictEqual(result.ok, true, `expected accept for: ${cmd}`);
  });
}

// ── Chain segmentation ─────────────────────────────────────────────────────
test('chain segmentation: && splits into two segments', () => {
  const result = tokenizeCommand('npm test && npm run build');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.segments.length, 2);
  assert.strictEqual(result.segments[0].map((t) => t.raw).join(' '), 'npm test');
  assert.strictEqual(result.segments[1].map((t) => t.raw).join(' '), 'npm run build');
});
test('chain segmentation: ; and || also split', () => {
  assert.strictEqual(tokenizeCommand('a ; b').segments.length, 2);
  assert.strictEqual(tokenizeCommand('a || b').segments.length, 2);
});

// ── No-false-negative gate proof: the gate must never say false for ───────
// anything planRewrite can actually rewrite.
const REWRITABLE_FIXTURES = [
  'vitest',
  'jest',
  'playwright test',
  'npx vitest',
  'npm test',
  'npm run build',
  'pnpm test',
  'yarn test',
];
for (const cmd of REWRITABLE_FIXTURES) {
  test(`looksLikeRunnerCommand: no false negative for "${cmd}"`, () => {
    assert.strictEqual(looksLikeRunnerCommand(cmd), true);
  });
}

// ── Direct runner rewrite: vitest env, jest argv, playwright argv ─────────
test('planRewrite: vitest direct → env prefix, insertion-only', () => {
  const cmd = 'vitest run';
  const result = planRewrite(cmd, BUDGET);
  assert.strictEqual(result.outcome, 'rewritten');
  assert.strictEqual(result.reason, REWRITE_REASON_CODES.REWRITTEN_VITEST_ENV);
  assert.ok(result.command.includes("VITEST_MAX_FORKS='4'"));
  assert.ok(result.command.includes("VITEST_MAX_THREADS='4'"));
  assert.ok(result.command.includes("NODE_OPTIONS='--max-old-space-size=2048'"));
  assert.ok(result.command.endsWith('vitest run'));
  assertInsertionOnly(cmd, result);
});

test('planRewrite: jest direct → --maxWorkers appended, insertion-only', () => {
  const cmd = 'jest --coverage';
  const result = planRewrite(cmd, BUDGET);
  assert.strictEqual(result.outcome, 'rewritten');
  assert.strictEqual(result.reason, REWRITE_REASON_CODES.REWRITTEN_JEST_ARGV);
  assert.strictEqual(result.command, 'jest --coverage --maxWorkers=4');
  assertInsertionOnly(cmd, result);
});

test('planRewrite: playwright test direct → --workers appended, insertion-only', () => {
  const cmd = 'playwright test';
  const result = planRewrite(cmd, BUDGET);
  assert.strictEqual(result.outcome, 'rewritten');
  assert.strictEqual(result.reason, REWRITE_REASON_CODES.REWRITTEN_PLAYWRIGHT_ARGV);
  assert.strictEqual(result.command, 'playwright test --workers=2');
  assertInsertionOnly(cmd, result);
});

test('planRewrite: npx vitest → env prefix inserted before npx', () => {
  const cmd = 'npx vitest';
  const result = planRewrite(cmd, BUDGET);
  assert.strictEqual(result.outcome, 'rewritten');
  assert.ok(result.command.startsWith("VITEST_MAX_FORKS='4'"));
  assert.ok(result.command.endsWith('npx vitest'));
  assertInsertionOnly(cmd, result);
});

// ── Vitest --shard and explicit-concurrency guardrails (never override) ───
test('planRewrite: vitest --shard passes intact, counted reason', () => {
  const result = planRewrite('vitest --shard=1/4', BUDGET);
  assert.strictEqual(result.outcome, 'intact');
  assert.strictEqual(result.reason, REWRITE_REASON_CODES.INTACT_VITEST_SHARD);
});
test('planRewrite: vitest with explicit VITEST_MAX_FORKS passes intact', () => {
  const result = planRewrite("VITEST_MAX_FORKS='8' vitest", BUDGET);
  assert.strictEqual(result.outcome, 'intact');
  assert.strictEqual(result.reason, REWRITE_REASON_CODES.INTACT_EXPLICIT_CONCURRENCY);
});
test('planRewrite: jest with explicit --maxWorkers passes intact', () => {
  const result = planRewrite('jest --maxWorkers=2', BUDGET);
  assert.strictEqual(result.outcome, 'intact');
  assert.strictEqual(result.reason, REWRITE_REASON_CODES.INTACT_EXPLICIT_CONCURRENCY);
});
test('planRewrite: playwright with explicit --workers passes intact', () => {
  const result = planRewrite('playwright test --workers=5', BUDGET);
  assert.strictEqual(result.outcome, 'intact');
  assert.strictEqual(result.reason, REWRITE_REASON_CODES.INTACT_EXPLICIT_CONCURRENCY);
});

// ── Manager indirection + per-manager `--` rule ────────────────────────────
function withFixtureRepo(scripts, fn) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'forge-cmd-rewrite-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  void scripts;
}

function readScriptFrom(scripts) {
  return (cwd, name) => (Object.prototype.hasOwnProperty.call(scripts, name) ? scripts[name] : null);
}

test('planRewrite: npm test → jest script gets --maxWorkers with `--` (npm always)', () => {
  withFixtureRepo({}, (dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const cmd = 'npm test';
    const result = planRewrite(cmd, BUDGET, { cwd: dir, readScript: readScriptFrom({ test: 'jest' }) });
    assert.strictEqual(result.outcome, 'rewritten');
    assert.strictEqual(result.command, 'npm test -- --maxWorkers=4');
    assertInsertionOnly(cmd, result);
  });
});

test('planRewrite: yarn test → jest script gets --maxWorkers WITHOUT `--` (yarn never)', () => {
  withFixtureRepo({}, (dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    const cmd = 'yarn test';
    const result = planRewrite(cmd, BUDGET, { cwd: dir, readScript: readScriptFrom({ test: 'jest' }) });
    assert.strictEqual(result.outcome, 'rewritten');
    assert.strictEqual(result.command, 'yarn test --maxWorkers=4');
    assertInsertionOnly(cmd, result);
  });
});

test('planRewrite: pnpm test (literal test script) gets `--` (pnpm/#5522)', () => {
  withFixtureRepo({}, (dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const cmd = 'pnpm test';
    const result = planRewrite(cmd, BUDGET, { cwd: dir, readScript: readScriptFrom({ test: 'jest' }) });
    assert.strictEqual(result.outcome, 'rewritten');
    assert.strictEqual(result.command, 'pnpm test -- --maxWorkers=4');
  });
});

test('planRewrite: pnpm run lint (non-test script) gets NO `--`', () => {
  withFixtureRepo({}, (dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'jest --testPathPattern=lint' } }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const cmd = 'pnpm run lint';
    const result = planRewrite(cmd, BUDGET, { cwd: dir, readScript: readScriptFrom({ lint: 'jest --testPathPattern=lint' }) });
    assert.strictEqual(result.outcome, 'rewritten');
    assert.strictEqual(result.command, 'pnpm run lint --maxWorkers=4');
  });
});

test('planRewrite: npm test with vitest script → env prefix, no `--` needed for env vars', () => {
  withFixtureRepo({}, (dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const cmd = 'npm test';
    const result = planRewrite(cmd, BUDGET, { cwd: dir, readScript: readScriptFrom({ test: 'vitest run' }) });
    assert.strictEqual(result.outcome, 'rewritten');
    assert.ok(result.command.startsWith("VITEST_MAX_FORKS='4'"));
    assert.ok(result.command.endsWith('npm test'));
    assertInsertionOnly(cmd, result);
  });
});

test('planRewrite: unknown manager (no lockfile) → intact, counted reason (W2)', () => {
  withFixtureRepo({}, (dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    // No lockfile written — resolvePackageManager(dir) returns null.
    const result = planRewrite('npm test', BUDGET, { cwd: dir, readScript: readScriptFrom({ test: 'jest' }) });
    assert.strictEqual(result.outcome, 'intact');
    assert.strictEqual(result.reason, REWRITE_REASON_CODES.INTACT_UNKNOWN_MANAGER);
  });
});

test('planRewrite: unresolvable script (no package.json / missing script) → intact, counted', () => {
  withFixtureRepo({}, (dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const result = planRewrite('npm run missing', BUDGET, { cwd: dir, readScript: readScriptFrom({}) });
    assert.strictEqual(result.outcome, 'intact');
    assert.strictEqual(result.reason, REWRITE_REASON_CODES.INTACT_SCRIPT_UNRESOLVABLE);
  });
});

test('planRewrite: script body that itself refuses tokenization → intact, counted (never guessed)', () => {
  withFixtureRepo({}, (dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest && echo $(whoami)' } }));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const result = planRewrite('npm test', BUDGET, { cwd: dir, readScript: readScriptFrom({ test: 'jest && echo $(whoami)' }) });
    assert.strictEqual(result.outcome, 'intact');
    assert.strictEqual(result.reason, REWRITE_REASON_CODES.INTACT_SCRIPT_UNRESOLVABLE);
  });
});

// ── Non-runner and unrecognized-form commands ──────────────────────────────
test('planRewrite: not a runner command at all → intact:not-runner-command', () => {
  const result = planRewrite('git status', BUDGET);
  assert.strictEqual(result.outcome, 'intact');
  assert.strictEqual(result.reason, REWRITE_REASON_CODES.INTACT_NOT_RUNNER);
});
test('planRewrite: tokenize-refused wraps the tokenizer reason, distinct vocabulary', () => {
  const result = planRewrite('npm test && echo $(whoami)', BUDGET);
  assert.strictEqual(result.outcome, 'intact');
  assert.strictEqual(result.reason, REWRITE_REASON_CODES.INTACT_TOKENIZE_REFUSED);
  assert.strictEqual(result.detail, TOKENIZE_REFUSAL_REASONS.COMMAND_SUBSTITUTION);
  // Vocabularies stay disjoint — no shared string values between the two enums.
  const tokenizeValues = new Set(Object.values(TOKENIZE_REFUSAL_REASONS));
  for (const value of Object.values(REWRITE_REASON_CODES)) {
    assert.strictEqual(tokenizeValues.has(value), false, `${value} leaked across enum vocabularies`);
  }
});

// ── Chain: rewrite a runner segment, leave a non-runner segment intact ────
test('planRewrite: chain rewrites the runner segment, leaves the other byte-intact', () => {
  const cmd = 'echo hello && jest';
  const result = planRewrite(cmd, BUDGET);
  assert.strictEqual(result.outcome, 'rewritten');
  assert.strictEqual(result.command, 'echo hello && jest --maxWorkers=4');
  assertInsertionOnly(cmd, result);
});

// ── Frozen enums ────────────────────────────────────────────────────────────
test('REWRITE_REASON_CODES is frozen', () => {
  assert.strictEqual(Object.isFrozen(REWRITE_REASON_CODES), true);
});
test('TOKENIZE_REFUSAL_REASONS is frozen', () => {
  assert.strictEqual(Object.isFrozen(TOKENIZE_REFUSAL_REASONS), true);
});

// ── D10: zero sizing rules — the module never references pressure/sizing ──
test('D10: module source contains zero sizing-rule references', () => {
  const source = fs.readFileSync(path.join(__dirname, 'forge-command-rewrite.js'), 'utf8');
  assert.strictEqual(/sysctl/i.test(source), false, 'must not reference sysctl');
  assert.strictEqual(/os\.freemem/i.test(source), false, 'must not reference os.freemem');
  assert.strictEqual(/pressure/i.test(source), false, 'must not reference pressure thresholds');
  // budget fields are read, never hardcoded as a numeric worker default.
  assert.strictEqual(/workers\s*[:=]\s*\d/i.test(source), false, 'must not hardcode a numeric worker default');
});

// ── Real-tokenizer proof: no regex applied to the whole command string to ──
// make a rewrite decision. tokenizeCommand's own body must not contain a
// regex test/match/exec against the full `cmd` parameter — only single-
// character comparisons and indexOf for quote-closing.
test('grep proof: tokenizeCommand never regex-tests the whole command string', () => {
  const source = fs.readFileSync(path.join(__dirname, 'forge-command-rewrite.js'), 'utf8');
  const fnStart = source.indexOf('function tokenizeCommand(cmd) {');
  assert.ok(fnStart >= 0, 'tokenizeCommand not found');
  const fnEnd = source.indexOf('\n// ── Lexical helpers', fnStart);
  const body = source.slice(fnStart, fnEnd >= 0 ? fnEnd : fnStart + 4000);
  assert.strictEqual(/\bcmd\.(test|match|matchAll|exec)\(/.test(body), false, 'tokenizeCommand must never regex the whole command string');
});

// ── Insertion-only property helper ─────────────────────────────────────────
// Removing the recorded insertion spans from the output reconstructs the
// byte-identical original. `at` offsets are ORIGINAL-string coordinates, so
// the cumulative shift is tracked while walking insertions in order.
function assertInsertionOnly(original, result) {
  assert.strictEqual(result.outcome, 'rewritten');
  let rebuilt = '';
  let origCursor = 0;
  let outCursor = 0;
  for (const ins of result.insertions) {
    const chunk = original.slice(origCursor, ins.at);
    assert.strictEqual(
      result.command.slice(outCursor, outCursor + chunk.length),
      chunk,
      'untouched bytes between insertions must be byte-identical to the original',
    );
    outCursor += chunk.length;
    assert.strictEqual(
      result.command.slice(outCursor, outCursor + ins.text.length),
      ins.text,
      'inserted text must appear verbatim at the recorded output position',
    );
    outCursor += ins.text.length;
    origCursor = ins.at;
  }
  const tailOriginal = original.slice(origCursor);
  assert.strictEqual(result.command.slice(outCursor), tailOriginal, 'trailing untouched bytes must be byte-identical');
  // Full round-trip: removing every inserted span yields the original exactly.
  let reconstructedOriginal = '';
  let cursor2 = 0;
  for (const ins of result.insertions) {
    reconstructedOriginal += original.slice(cursor2, ins.at);
    cursor2 = ins.at;
  }
  reconstructedOriginal += original.slice(cursor2);
  assert.strictEqual(reconstructedOriginal, original, 'insertion offsets must reconstruct the byte-identical original');
}

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
