#!/usr/bin/env node
'use strict';

/*
 * Behavioural EOL differential.  This deliberately decides from assertion
 * sets printed by a suite, rather than treating a process exit status as a
 * diagnosis.  It is also intentionally dependency-free: it is useful while
 * investigating a checkout before its package manager is available.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { childEnv, discoverTests } = require('./run-tests');
const { INTERCEPTED_APIS, OBSERVED_APIS } = require('./forge-eol-preload');

const scriptsDir = __dirname;
const repoRoot = path.resolve(scriptsDir, '..');
const preloadPath = path.resolve(scriptsDir, 'forge-eol-preload.js');
// An unattended sweep of 155 suites cannot be held hostage by one hung child.
const DEFAULT_TIMEOUT_MS = 600000;

function usage() {
  return [
    'Usage: node scripts/forge-eol-differential.js [--json] [--control]',
    '       [--match <substring>]... [--state <outside-repo-jsonl>] [--resume]',
    '       [--timeout <ms>]   per-suite wall clock (default 600000)',
    '       [--whole-tree]     fingerprint ignored paths too (default: honour .gitignore)',
    '',
    'Runs each selected standalone test in LF and CRLF source-read modes.',
  ].join('\n');
}

function parseArgs(argv) {
  const result = { json: false, control: false, matches: [], resume: false, state: null, injectReconciliationFailure: false, timeoutMs: DEFAULT_TIMEOUT_MS, wholeTree: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') result.json = true;
    else if (arg === '--control') result.control = true;
    else if (arg === '--resume') result.resume = true;
    else if (arg === '--whole-tree') result.wholeTree = true;
    else if (arg === '--inject-reconciliation-failure') result.injectReconciliationFailure = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--timeout') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--timeout requires a value');
      const milliseconds = Number(value);
      if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error('--timeout requires a positive number of milliseconds');
      result.timeoutMs = milliseconds;
      index += 1;
    } else if (arg === '--match' || arg === '--state') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--match') result.matches.push(value.toLowerCase());
      else result.state = path.resolve(value);
      index += 1;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (result.resume && !result.state) throw new Error('--resume requires an explicit --state file');
  return result;
}

// The output is scanned in every case, including a zero exit status.  Trusting
// a zero exit would be the very exit-code shortcut D8 forbids, applied one
// level up: a harness that forgets `process.exitCode`, or that rejects a
// promise after printing its summary, prints failing asserts and still exits 0.
// Such a suite is not evidence of cleanliness, so it becomes `unproven` with a
// named reason rather than `stable`.
function parseSuiteOutput({ stdout, stderr, exitCode }) {
  const output = `${stdout || ''}${stdout && stderr ? '\n' : ''}${stderr || ''}`;
  const names = new Set();
  let summaryFailed = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const summary = line.match(/^\s*\d+\s+passed\s*,\s*(\d+)\s+failed\s*$/i);
    if (summary) summaryFailed = Number(summary[1]);
    // Test files use \"✗ name\" and some print a final \"✗ name: error\" recap.
    const failed = line.match(/^\s*✗\s+(.+?)\s*$/);
    if (failed) names.add(failed[1].replace(/:\s+.*$/, '').trim());
  }
  const failedAsserts = [...names].filter(Boolean).sort((a, b) => a.localeCompare(b, 'en'));
  if (exitCode === 0) {
    // A green process that reported failures — or a summary line that disagrees
    // with the asserts parsed out of the same output — is self-contradictory.
    if (failedAsserts.length > 0 || (summaryFailed != null && summaryFailed > 0)) {
      return {
        parseOk: false, failedAsserts, summaryFailed, summaryCount: summaryFailed,
        reason: 'exit-contradicts-asserts',
      };
    }
    return { parseOk: true, failedAsserts: [], summaryFailed: 0, summaryCount: summaryFailed || 0 };
  }
  if (summaryFailed == null || failedAsserts.length === 0) {
    return { parseOk: false, failedAsserts, summaryFailed, summaryCount: summaryFailed, reason: 'output-not-parseable' };
  }
  if (failedAsserts.length !== summaryFailed) {
    return { parseOk: false, failedAsserts, summaryFailed, summaryCount: summaryFailed, reason: 'assert-parse-mismatch' };
  }
  return { parseOk: true, failedAsserts, summaryFailed, summaryCount: summaryFailed };
}

function sameSet(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function difference(left, right) {
  const other = new Set(right);
  return left.filter(item => !other.has(item));
}

function directionFor(lf, crlf) {
  const lfOnly = difference(lf, crlf);
  const crlfOnly = difference(crlf, lf);
  if (lfOnly.length === 0 && crlfOnly.length > 0) return 'lf-pass/crlf-fail';
  if (crlfOnly.length === 0 && lfOnly.length > 0) return 'lf-fail/crlf-pass';
  return 'assert-set-differed';
}

function classify(pair, retryPair, observedApis) {
  const lf = pair.lf;
  const crlf = pair.crlf;
  if (!lf || !crlf) return { bucket: 'unproven', reason: 'missing-mode-record' };
  const unIntercepted = [...new Set(observedApis || [])].find(api => !INTERCEPTED_APIS.includes(api));
  // parse_ok is consulted before any path may reach `stable`, so a zero exit
  // can no longer bypass the assert sets it is supposed to be judged by.
  if (!lf.parse_ok || !crlf.parse_ok) {
    return { bucket: 'unproven', reason: (!lf.parse_ok ? lf.reason : crlf.reason) || 'output-not-parseable' };
  }
  if (sameSet(lf.failed_asserts, crlf.failed_asserts)) {
    return unIntercepted
      ? { bucket: 'unproven', reason: `read-api-not-intercepted:${unIntercepted}` }
      : { bucket: 'stable', detail: lf.exit === 0 && crlf.exit === 0 ? 'pass-pass' : 'fail-fail-same-set' };
  }
  if (!retryPair || !retryPair.lf || !retryPair.crlf || !retryPair.lf.parse_ok || !retryPair.crlf.parse_ok) {
    return { bucket: 'unproven', reason: 'flip-not-reproducible' };
  }
  const initialFlipped = new Set([...difference(lf.failed_asserts, crlf.failed_asserts), ...difference(crlf.failed_asserts, lf.failed_asserts)]);
  const retryFlipped = new Set([
    ...difference(retryPair.lf.failed_asserts, retryPair.crlf.failed_asserts),
    ...difference(retryPair.crlf.failed_asserts, retryPair.lf.failed_asserts),
  ]);
  const assertsFlipped = [...initialFlipped].filter(name => retryFlipped.has(name)).sort((a, b) => a.localeCompare(b, 'en'));
  const assertsNotReproducible = [...initialFlipped].filter(name => !retryFlipped.has(name))
    .sort((a, b) => a.localeCompare(b, 'en'));
  if (assertsFlipped.length === 0) return { bucket: 'unproven', reason: 'flip-not-reproducible' };
  return {
    bucket: 'confirmed',
    asserts_flipped: assertsFlipped,
    asserts_stable_failing: lf.failed_asserts.filter(name => crlf.failed_asserts.includes(name)),
    asserts_not_reproducible: assertsNotReproducible.map(assert => ({ assert, reason: 'flip-not-reproducible' })),
    direction: directionFor(lf.failed_asserts, crlf.failed_asserts),
  };
}

// Ignored paths, asked of git once per fingerprint rather than re-implemented.
// `--directory` collapses a wholly ignored directory into one entry, so the
// walk can skip it without listing what is inside it.  Returning null means
// "git could not answer" and the caller degrades to the whole-tree walk: the
// stronger invariant is the safe direction to fail towards.
function ignoredPaths(root) {
  const result = spawnSync('git', ['-C', root, '-c', 'core.quotepath=off', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const files = new Set();
  const directories = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry) continue;
    if (entry.endsWith('/')) directories.add(entry.slice(0, -1));
    else files.add(entry);
  }
  return { files, directories };
}

// Whole-tree vs ignore-aware fingerprint — a considered tradeoff, not an
// oversight.  The guard exists to catch mutations that this differential, or
// the suites it runs, cause in content the run is judged by.  Two scopes:
//
//   default (.gitignore honoured): paths git reports as ignored are skipped,
//     so an unrelated concurrent build writing under app/.build/, node_modules/
//     or .gsd/ cannot abort a 155-suite sweep with `tree-mutated`.  Cost: a
//     suite side effect that lands under an ignored path goes unnoticed.
//   { wholeTree: true } (--whole-tree): every regular file except .git is
//     hashed.  Stronger invariant — it also covers ignored artifacts — at the
//     cost of aborting on regeneration that nothing here observes.
//
// The default buys the ability to run unattended on a working box; the flag
// keeps the stronger invariant reachable on demand.  When git cannot answer
// (no repository, no git binary) the walk degrades to whole-tree.
function fingerprint(root, options) {
  const hash = crypto.createHash('sha256');
  const ignored = options && options.wholeTree ? null : ignoredPaths(root);
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name === '.git') continue;
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (ignored && (entry.isDirectory() ? ignored.directories.has(relative) : ignored.files.has(relative))) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        hash.update(`F ${relative}\0`);
        hash.update(fs.readFileSync(full));
        hash.update('\0');
      }
    }
  }
  walk(root);
  return hash.digest('hex');
}

function readState(stateFile) {
  const records = new Map();
  if (!fs.existsSync(stateFile)) return records;
  for (const line of fs.readFileSync(stateFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (!record.suite || !record.mode || !Array.isArray(record.failed_asserts)) continue;
      const key = `${record.suite}\0${record.round || 1}\0${record.mode}`;
      records.set(key, record);
    } catch (_) { /* A partial final line is not a usable measurement. */ }
  }
  return records;
}

function appendState(stateFile, record) {
  fs.appendFileSync(stateFile, `${JSON.stringify(record)}\n`, 'utf8');
}

// A state log is evidence, not an input fixture.  Keeping it outside the tree
// makes the before/after fingerprint sensitive only to suite side effects.
function isOutsideRepository(filename) {
  // Roots are compared first because path.relative across devices returns the
  // absolute target unchanged (C:\repo -> D:\tmp\x yields 'D:\tmp\x'), which
  // has no '..' prefix and would answer "inside" for a path that is plainly
  // outside — refusing to run on any box whose TEMP sits on another drive.
  const resolved = path.resolve(filename);
  const targetRoot = path.parse(resolved).root;
  const ownRoot = path.parse(repoRoot).root;
  if (targetRoot.toLowerCase() !== ownRoot.toLowerCase()) return true;
  const relative = path.relative(repoRoot, resolved);
  return relative !== '' && (relative.startsWith(`..${path.sep}`) || relative === '..');
}

function traceApis(traceFile) {
  if (!fs.existsSync(traceFile)) return [];
  const found = new Set();
  for (const line of fs.readFileSync(traceFile, 'utf8').split(/\r?\n/)) {
    try { const value = JSON.parse(line); if (value && typeof value.api === 'string') found.add(value.api); } catch (_) { /* ignore malformed observation */ }
  }
  return [...found].sort();
}

function runMode(suite, mode, isolatedRoot, options, stateFile, round) {
  const traceFile = path.join(path.dirname(stateFile), `${path.basename(suite)}.${round}.${mode}.trace.jsonl`);
  const env = childEnv(isolatedRoot, suite);
  if (!options.control) {
    env.FORGE_EOL_MODE = mode;
    env.FORGE_EOL_TRACE_FILE = traceFile;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--require ${JSON.stringify(preloadPath)}`;
  } else {
    delete env.FORGE_EOL_MODE;
    delete env.FORGE_EOL_TRACE_FILE;
    delete env.NODE_OPTIONS;
  }
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const result = spawnSync(process.execPath, [path.join(scriptsDir, suite)], {
    cwd: repoRoot, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs,
  });
  // A suite that never finished was not proven clean.  It is recorded with a
  // non-zero exit and parse_ok:false so classify() files it as `unproven` with
  // a named reason, participating in bucket reconciliation like any other.
  const timedOut = (result.error && result.error.code === 'ETIMEDOUT')
    || (result.status == null && result.signal != null);
  if (timedOut) {
    return {
      suite, mode, round, exit: 1, parse_ok: false, failed_asserts: [],
      reason: `suite-timed-out:${timeoutMs}ms`, trace_file: traceFile,
    };
  }
  if (result.error) throw result.error;
  const parsed = parseSuiteOutput({ stdout: result.stdout, stderr: result.stderr, exitCode: result.status });
  return {
    suite, mode, round, exit: result.status == null ? 1 : result.status,
    parse_ok: parsed.parseOk, failed_asserts: parsed.failedAsserts,
    ...(parsed.reason ? { reason: parsed.reason } : {}), trace_file: traceFile,
  };
}

function pairFor(records, suite, round) {
  // Round one is the original observation; round two is W1 reproduction.
  // Keeping the two keys distinct preserves the complete evidence in JSONL.
  return {
    lf: records.get(`${suite}\0${round}\0lf`),
    crlf: records.get(`${suite}\0${round}\0crlf`),
  };
}

function emit(value, options) {
  if (options.json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else {
    process.stdout.write(`${value.mode}: ${value.suites_executed} suites; confirmed ${value.confirmed.length}, stable ${value.stable.length}, unproven ${value.unproven.length}\n`);
    for (const item of value.unproven) process.stdout.write(`  ? ${item.suite}: ${item.reason}\n`);
  }
}

function reconcileBuckets(value) {
  const buckets = ['confirmed', 'stable', 'unproven'];
  const total = buckets.reduce((sum, bucket) => sum + (Array.isArray(value[bucket]) ? value[bucket].length : 0), 0);
  return total === value.suites_executed;
}

function runtimeError(reason, options, extra) {
  const output = { mode: options.control ? 'control' : 'differential', error: reason, ...(extra || {}) };
  emit(output, options);
  return 1;
}

function main(argv) {
  let options;
  try { options = parseArgs(argv); } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`); return 2;
  }
  if (options.help) { process.stdout.write(`${usage()}\n`); return 0; }
  const stateFile = options.state || path.join(os.tmpdir(), `forge-eol-differential-${process.pid}-${Date.now()}.jsonl`);
  if (!isOutsideRepository(stateFile)) {
    process.stderr.write('--state must live outside the repository so it cannot affect the tree fingerprint\n'); return 2;
  }
  const suites = discoverTests(options.matches);
  if (suites.length === 0) return runtimeError('no-suites-executed', options, { suites_executed: 0, state_file: stateFile });
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const before = fingerprint(repoRoot, options);
  const records = readState(stateFile);
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-eol-tests-'));
  try {
    for (const suite of suites) {
      for (const mode of ['lf', 'crlf']) {
        const key = `${suite}\0${1}\0${mode}`;
        if (options.resume && records.has(key)) continue;
        const record = runMode(suite, mode, isolatedRoot, options, stateFile, 1);
        appendState(stateFile, record); records.set(key, record);
      }
    }
    const output = {
      mode: options.control ? 'control' : 'differential', suites_executed: suites.length,
      confirmed: [], stable: [], unproven: [], intercepted_apis: [...INTERCEPTED_APIS],
      observed_apis: [...OBSERVED_APIS], tree_hash_before: before, tree_hash_after: null, state_file: stateFile,
    };
    if (options.injectReconciliationFailure) {
      output.stable.push({ suite: '__injected-duplicate__', detail: 'test seam' });
    }
    for (const suite of suites) {
      const initial = pairFor(records, suite, 1);
      const initiallyDifferent = initial.lf && initial.crlf && initial.lf.parse_ok && initial.crlf.parse_ok
        && !sameSet(initial.lf.failed_asserts, initial.crlf.failed_asserts);
      if (initiallyDifferent) {
        for (const mode of ['lf', 'crlf']) {
          const key = `${suite}\0${2}\0${mode}`;
          if (!(options.resume && records.has(key))) {
            const record = runMode(suite, mode, isolatedRoot, options, stateFile, 2);
            appendState(stateFile, record); records.set(key, record);
          }
        }
      }
      const observed = options.control ? [] : [...new Set([
        ...traceApis(initial.lf && initial.lf.trace_file), ...traceApis(initial.crlf && initial.crlf.trace_file),
      ])];
      const verdict = classify(initial, initiallyDifferent ? pairFor(records, suite, 2) : null, observed);
      if (verdict.bucket === 'confirmed') output.confirmed.push({ suite, asserts_flipped: verdict.asserts_flipped, asserts_stable_failing: verdict.asserts_stable_failing, asserts_not_reproducible: verdict.asserts_not_reproducible, direction: verdict.direction });
      else if (verdict.bucket === 'stable') output.stable.push({ suite, detail: verdict.detail });
      else output.unproven.push({ suite, reason: verdict.reason });
    }
    output.tree_hash_after = fingerprint(repoRoot, options);
    if (output.tree_hash_before !== output.tree_hash_after) { emit({ ...output, error: 'tree-mutated' }, options); return 1; }
    if (!reconcileBuckets(output)) {
      return runtimeError('reconciliation-failed', options, { ...output });
    }
    emit(output, options); return 0;
  } catch (error) {
    process.stderr.write(`forge-eol-differential warning: ${error.message}\n`);
    return runtimeError('runtime-error', options, { state_file: stateFile });
  } finally {
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  main,
  _private: { classify, difference, fingerprint, isOutsideRepository, parseArgs, parseSuiteOutput, reconcileBuckets, sameSet, traceApis },
};
