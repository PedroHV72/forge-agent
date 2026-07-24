#!/usr/bin/env node
'use strict';

/**
 * Cross-platform, zero-dependency runner for the repository's standalone
 * scripts/*.test.js suites.
 *
 * Tests run sequentially because a few legacy suites exercise process-global
 * configuration and filesystem fixtures. Each child receives an isolated home
 * directory by default so developer preferences cannot change test outcomes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptsDir = __dirname;
const repoRoot = path.resolve(scriptsDir, '..');

function usage() {
  return [
    'Usage: node scripts/run-tests.js [options]',
    '',
    'Options:',
    '  --list             List discovered suites without running them',
    '  --match <text>     Run suites whose filename contains text (repeatable)',
    '  --fail-fast        Stop after the first failing suite',
    '  --verbose          Print output from successful suites too',
    '  --inherit-home     Do not isolate HOME/USERPROFILE for child suites',
    '  --help             Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    list: false,
    matches: [],
    failFast: false,
    verbose: false,
    inheritHome: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--list') options.list = true;
    else if (arg === '--fail-fast') options.failFast = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--inherit-home') options.inheritHome = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--match') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--match requires a filename substring');
      options.matches.push(value.toLowerCase());
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function discoverTests(matches) {
  return fs.readdirSync(scriptsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .map(entry => entry.name)
    .filter(name => matches.length === 0 || matches.some(match => name.toLowerCase().includes(match)))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function isolatedEnv(root, filename) {
  const stem = filename.replace(/\.test\.js$/, '').replace(/[^A-Za-z0-9._-]/g, '_');
  const home = path.join(root, stem);
  const config = path.join(home, '.config');
  const roaming = path.join(home, 'AppData', 'Roaming');
  const local = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(roaming, { recursive: true });
  fs.mkdirSync(local, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    FORGE_TEST: '1',
  };
}

function writeCaptured(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) process.stderr.write(`${result.error.stack || result.error.message}\n`);
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const tests = discoverTests(options.matches);
  if (options.list) {
    process.stdout.write(tests.length ? `${tests.join('\n')}\n` : '');
    return 0;
  }
  if (tests.length === 0) {
    process.stderr.write('No test suites matched.\n');
    return 2;
  }

  const isolatedRoot = options.inheritHome
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tests-'));
  const failures = [];
  let executed = 0;
  const started = Date.now();

  process.stdout.write(`Running ${tests.length} test suite${tests.length === 1 ? '' : 's'} sequentially...\n`);
  try {
    for (const filename of tests) {
      executed += 1;
      const suiteStarted = Date.now();
      const result = spawnSync(process.execPath, [path.join(scriptsDir, filename)], {
        cwd: repoRoot,
        env: isolatedRoot ? isolatedEnv(isolatedRoot, filename) : process.env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const elapsed = ((Date.now() - suiteStarted) / 1000).toFixed(2);
      const passed = result.status === 0 && !result.error;

      process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${filename} (${elapsed}s)\n`);
      if (options.verbose || !passed) writeCaptured(result);

      if (!passed) {
        failures.push({ filename, status: result.status, signal: result.signal });
        if (options.failFast) break;
      }
    }
  } finally {
    if (isolatedRoot) fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(2);
  if (failures.length === 0) {
    process.stdout.write(`\nAll ${executed} suites passed in ${elapsed}s.\n`);
    return 0;
  }

  process.stderr.write(`\n${failures.length} of ${executed} executed suite${executed === 1 ? '' : 's'} failed in ${elapsed}s:\n`);
  for (const failure of failures) {
    const detail = failure.signal ? `signal ${failure.signal}` : `exit ${failure.status == null ? 'unknown' : failure.status}`;
    process.stderr.write(`  - ${failure.filename} (${detail})\n`);
  }
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { discoverTests, isolatedEnv, main, parseArgs };
