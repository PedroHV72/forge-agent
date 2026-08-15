#!/usr/bin/env node
'use strict';

/*
 * Paired regression suite for the permanent guard.  The table below is the
 * only source of anchors: paths and declarations, never source positions.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const guard = require('./forge-eol-guard');
const anchors = require('./forge-eol-anchors');
const protectedRoster = require('./forge-eol-protected');

const repoRoot = path.resolve(__dirname, '..');
const guardCli = path.join(__dirname, 'forge-eol-guard.js');
const preload = path.join(__dirname, 'forge-eol-preload.js');
const started = Date.now();
let passed = 0;
let failed = 0;
const failures = [];

// Every probe is a {file, symbol} pair.  `symbol: null` deliberately denotes
// a module scope; the resolver below converts it to the roster's file kind.
const ANCHORS = Object.freeze([
  { file: 'scripts/forge-repair.js', symbol: 'normalizePlanText', form: 'A-inplace' },
  { file: 'scripts/forge-app-items.test.js', symbol: null, form: 'B' },
  { file: 'scripts/forge-app-workspace-marker.test.js', symbol: 'jsDefaultCandidates', form: 'A-funnel' },
  { file: 'scripts/forge-dashboard.js', symbol: 'render', form: 'B' },
  { file: 'scripts/forge-app-workspace-marker.test.js', symbol: 'projectRoleBody', form: 'A-inplace' },
]);

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  + ${name}\n`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error: error.message });
    process.stderr.write(`  x ${name}: ${error.message}\n`);
  }
}

function sanitizedEnv(extra) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) {
    if (key.startsWith('FORGE_EOL_')) delete env[key];
  }
  return { ...env, ...(extra || {}) };
}

function spawn(command, args, extraEnv) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    env: sanitizedEnv(extraEnv),
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function gitAvailable() {
  const result = spawn('git', ['--version']);
  return !result.error && result.status === 0;
}

function runGitShow(ref, file) {
  const result = spawn('git', ['show', `${ref}:${file}`]);
  if (result.error || result.status !== 0 || !result.stdout) {
    const detail = result.error ? result.error.message : `status=${result.status}`;
    throw new Error(`git-show-unavailable:${ref}:${file} (${detail})`);
  }
  return result.stdout;
}

function resolveAnchor(anchor, content) {
  const rosterEntry = protectedRoster.PROTECTED.find((entry) =>
    entry.file === anchor.file && (entry.symbol || null) === anchor.symbol);
  const entry = rosterEntry || {
    file: anchor.file,
    symbol: anchor.symbol,
    kind: anchor.symbol ? protectedRoster.SCOPE_KINDS.SYMBOL : protectedRoster.SCOPE_KINDS.FILE,
    form: anchor.form,
  };
  const resolution = protectedRoster.resolveScope(content, entry);
  assert.strictEqual(resolution.ok, true, `${anchor.file}::${anchor.symbol || '(file)'} must resolve`);
  return { entry, resolution };
}

function readHead(anchor) {
  return fs.readFileSync(path.join(repoRoot, anchor.file), 'utf8');
}

function targetFailure(result, entry) {
  return result.enforcing.failures.find((failure) =>
    failure.file === entry.file && failure.symbol === (entry.symbol || null));
}

function verdictFor(entry, content, extraRoster) {
  return guard.checkEolGuard({
    cwd: repoRoot,
    records: [{ path: entry.file, content }],
    roster: [...protectedRoster.PROTECTED, ...(extraRoster || [])],
  });
}

function countsFor(entry, content) {
  const scan = anchors.scanEolAnchors([{ path: entry.file, content }], { inMemory: true });
  const measured = guard._private.measureScope(entry, content, scan.call_sites || []);
  assert.strictEqual(measured.ok, true, `${entry.file}::${entry.symbol || '(file)'} must be measured`);
  return measured;
}

function blind(text, scope) {
  const { resolution } = resolveAnchor(scope, text);
  const before = text.slice(0, resolution.start);
  const body = text.slice(resolution.start, resolution.end);
  const after = text.slice(resolution.end);
  // Build scanner specimens from strings so the operation is constrained to
  // the resolved scope rather than accidentally changing a neighbouring one.
  const tolerantBreak = String.raw`\r?\n`;
  const blindBreak = String.raw`\n`;
  const tolerantNormalizer = String.raw`\r\n?`;
  const blindNormalizer = String.raw`\r\n`;
  const tolerantAlternation = String.raw`\r\n|\n|\r`;
  const blindedBody = body.split(tolerantBreak).join(blindBreak)
    .split(tolerantNormalizer).join(blindNormalizer)
    .split(tolerantAlternation).join(blindBreak);
  return `${before}${blindedBody}${after}`;
}

function failureKeys(result) {
  return result.enforcing.failures.map((failure) =>
    `${failure.file}::${failure.symbol || '(file)'}::${failure.reason}`).sort();
}

function parseGuardJson(result, label) {
  assert.strictEqual(result.error, undefined, `${label}: ${result.error && result.error.message}`);
  assert.strictEqual(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function recordsForProtectedRoster() {
  const files = new Set(protectedRoster.PROTECTED.map((entry) => entry.file));
  files.add('scripts/forge-must-haves.js');
  return [...files].sort().map((file) => ({
    path: file,
    content: fs.readFileSync(path.join(repoRoot, file), 'utf8'),
  }));
}

const ALLOW_NO_GIT = process.env.FORGE_ALLOW_NO_GIT === '1';
const GIT_OK = gitAvailable();
if (!GIT_OK) {
  const message = 'forge-eol-guard.test.js: git indisponível no PATH — FORGE_ALLOW_NO_GIT=1 ';
  if (ALLOW_NO_GIT) {
    process.stderr.write(`${message}setado; pulando explicitamente a mordida histórica (opt-out deliberado).\n`);
  } else {
    process.stderr.write(`${message}é obrigatório para pular explicitamente; sem essa variável a suíte sai não-zero.\n`);
    process.exitCode = 1;
  }
}

process.stdout.write('\n=== forge-eol-guard.js — paired bite suite ===\n\n');

test('all table anchors resolve without a line-number field', () => {
  for (const anchor of ANCHORS) {
    assert.deepStrictEqual(Object.keys(anchor).sort(), ['file', 'form', 'symbol']);
    assert.strictEqual(Object.values(anchor).some((value) => typeof value === 'number'), false);
    resolveAnchor(anchor, readHead(anchor));
  }
});

test('sanitized child environments cannot inherit this suite instrumentation', () => {
  const env = sanitizedEnv();
  assert.strictEqual(Object.prototype.hasOwnProperty.call(env, 'NODE_OPTIONS'), false);
  assert.strictEqual(Object.keys(env).some((key) => key.startsWith('FORGE_EOL_')), false);
});

if (GIT_OK) {
  test('historical bite: 3d00aca and HEAD have opposite guard verdicts', () => {
    const anchor = ANCHORS[0];
    const oldContent = runGitShow('3d00aca', anchor.file);
    const headContent = runGitShow('HEAD', anchor.file);
    const { entry } = resolveAnchor(anchor, headContent);
    const headCounts = countsFor(entry, headContent);
    const historicalEntry = {
      ...entry,
      baseline_exposed: headCounts.exposed,
      baseline_tolerant: headCounts.tolerant,
    };
    const oldResult = verdictFor(entry, oldContent, [historicalEntry]);
    const headResult = verdictFor(entry, headContent, [historicalEntry]);
    assert.strictEqual(oldResult.ok, false);
    assert(targetFailure(oldResult, historicalEntry), 'historical failure must name the protected scope');
    assert.strictEqual(headResult.ok, true);
  });

  test('git-show errors are named and never silently skipped', () => {
    assert.throws(() => runGitShow('not-a-real-eol-revision', ANCHORS[0].file), /git-show-unavailable/);
  });
} else if (ALLOW_NO_GIT) {
  process.stdout.write('  - historical bite skipped: git unavailable with FORGE_ALLOW_NO_GIT=1\n');
}

test('synthetic bites cover B, A-funnel, A-inplace, source, and test families', () => {
  const probes = ANCHORS.slice(1);
  const forms = new Set(probes.map((probe) => probe.form));
  assert.deepStrictEqual([...forms].sort(), ['A-funnel', 'A-inplace', 'B']);
  assert(probes.some((probe) => probe.file.endsWith('.test.js')));
  assert(probes.some((probe) => probe.file.endsWith('.js') && !probe.file.endsWith('.test.js')));
  for (const probe of probes) {
    const original = readHead(probe);
    const { entry } = resolveAnchor(probe, original);
    const blinded = blind(original, entry);
    const originalCounts = countsFor(entry, original);
    const blindedCounts = countsFor(entry, blinded);
    // The bite-of-the-bite is deliberately before either verdict assertion.
    assert.notStrictEqual(blinded, original, `${probe.file}::${probe.symbol || '(file)'} blind must alter text`);
    assert(blindedCounts.tolerant < originalCounts.tolerant,
      `${probe.file}::${probe.symbol || '(file)'} blind must reduce tolerant constructs`);
    const bad = verdictFor(entry, blinded);
    const good = verdictFor(entry, original);
    assert.strictEqual(bad.ok, false, `${probe.file}::${probe.symbol || '(file)'} blind must fail`);
    assert(targetFailure(bad, entry), `${probe.file}::${probe.symbol || '(file)'} failure must be named`);
    assert.strictEqual(good.ok, true, `${probe.file}::${probe.symbol || '(file)'} HEAD must pass`);
  }
});

test('advisory suspects stay inert for real unprotected forge-must-haves exposure', () => {
  const result = guard.checkEolGuard({
    cwd: repoRoot,
    records: recordsForProtectedRoster(),
    completeRecords: true,
  });
  const mustHavesSuspects = result.advisory.suspects.filter((site) => site.file === 'scripts/forge-must-haves.js');
  assert(mustHavesSuspects.length > 0, 'forge-must-haves.js must remain a real advisory specimen');
  assert(result.advisory.suspects.length > 0);
  assert.strictEqual(result.ok, true, 'stable[]-oracle advisory exposure must not leak into enforcement');
});

test('empty and unresolved rosters fail closed with named reasons', () => {
  const empty = guard.checkEolGuard({ cwd: repoRoot, records: [], roster: [] });
  assert.strictEqual(empty.ok, false);
  assert.match(empty.message, /no-protected-scope-resolved/);
  const unresolved = guard.checkEolGuard({
    cwd: repoRoot,
    records: [],
    roster: [protectedRoster.PROTECTED[0]],
  });
  assert.strictEqual(unresolved.ok, false);
  assert.match(unresolved.message, /no-protected-scope-resolved/);
});

test('CLI verdict is invariant under LF and CRLF preload modes', () => {
  const results = ['lf', 'crlf'].map((mode) => parseGuardJson(spawn(process.execPath, [guardCli, '--check', '--json'], {
    FORGE_EOL_MODE: mode,
    NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
  }), `preload ${mode}`));
  assert.strictEqual(results[0].ok, results[1].ok);
  assert.deepStrictEqual(failureKeys(results[0]), failureKeys(results[1]));
});

if (!process.env.FORGE_TEST_NO_RECURSE) {
  test('git-less PATH fails loudly unless FORGE_ALLOW_NO_GIT=1 is explicit', () => {
    const nodeDir = path.dirname(process.execPath);
    const rejected = spawn(process.execPath, [__filename], {
      PATH: nodeDir,
      FORGE_TEST_NO_RECURSE: '1',
    });
    assert.notStrictEqual(rejected.status, 0);
    assert.match(rejected.stderr, /FORGE_ALLOW_NO_GIT=1/);
    const allowed = spawn(process.execPath, [__filename], {
      PATH: nodeDir,
      FORGE_TEST_NO_RECURSE: '1',
      FORGE_ALLOW_NO_GIT: '1',
    });
    assert.strictEqual(allowed.status, 0, allowed.stderr || allowed.stdout);
    assert.match(allowed.stderr, /opt-out deliberado/);
  });
}

const elapsed = (Date.now() - started) / 1000;
process.stdout.write(`forge-eol-guard: ${passed} passed, ${failed} failed in ${elapsed.toFixed(2)}s (limit 90s)\n`);
assert(elapsed <= 90, `suite duration ${elapsed.toFixed(2)}s exceeds 90s`);
if (failed > 0) process.exitCode = 1;
