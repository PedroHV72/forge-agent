'use strict';

// Standalone suite: run directly with Node.  It measures the actual scripts/
// tree; no fixture can make coverage appear better than the repository is.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  VERDICTS,
  WRAPPER_DIR_READERS,
  unlearnedReaders,
} = require('./forge-wrapper-readers');

const SCRIPTS_DIR = __dirname;
const ROOT_DIR_PATTERN = /path\.join\([\s\S]{0,160}?['"]\.gsd['"][\s\S]{0,80}?['"](?:milestones|tasks)['"]|\.gsd[\\/]\s*(?:milestones|tasks)/;
const ENUMERATION_PATTERN = /(?:fs\.)?readdirSync\s*\(/;
const D11_NAMED_READERS = Object.freeze([
  'forge-dashboard.js', 'forge-runs.js', 'forge-state.js', 'forge-verifier.js',
  'forge-route-audit.js', 'forge-statusline.js', 'forge-surgical-reset.js',
  'forge-status.js', 'forge-ids.js',
]);

function sourceOf(file) {
  return fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
}

function scriptFiles() {
  return fs.readdirSync(SCRIPTS_DIR)
    .filter(file => file.endsWith('.js'))
    // Explicit exclusion: test sources write fixtures containing .gsd paths.
    .filter(file => !file.endsWith('.test.js'))
    .sort();
}

function hasDirectRootEnumeration(source) {
  if (!ENUMERATION_PATTERN.test(source)) return false;
  return ROOT_DIR_PATTERN.test(source);
}

function hasD11ReaderShape(file, source) {
  // D11's previously identified callers include scripts which select a single
  // unit, or delegate enumeration to a helper.  Keep them in the measured set
  // only while their concrete source evidence remains present.
  if (!D11_NAMED_READERS.includes(file)) return false;
  return /\.gsd[\\/]|['"]milestones['"]|['"]tasks['"]|\bmilestones\b|\btasks\b/.test(source);
}

function scanWrapperDirReaders() {
  return scriptFiles().filter(file => {
    const source = sourceOf(file);
    return hasDirectRootEnumeration(source) || hasD11ReaderShape(file, source);
  });
}

function setDifference(left, right) {
  return [...left].filter(value => !right.has(value)).sort();
}

function assertNamedFiles(label, files) {
  assert.strictEqual(files.length, 0, `${label}: ${files.join(', ')}`);
}

function testCoverageIsMeasuredBothWays() {
  const discovered = new Set(scanWrapperDirReaders());
  const registered = new Set(WRAPPER_DIR_READERS.map(reader => reader.file));
  assertNamedFiles('unclassified wrapper directory reader(s)', setDifference(discovered, registered));
  assertNamedFiles('obsolete inventory entry or no longer a wrapper reader', setDifference(registered, discovered));
}

function testEntriesRemainConcreteAndClosed() {
  for (const reader of WRAPPER_DIR_READERS) {
    assert(reader.file.endsWith('.js') && !reader.file.endsWith('.test.js'), `test file entered inventory: ${reader.file}`);
    assert(fs.existsSync(path.join(SCRIPTS_DIR, reader.file)), `inventory file is missing: ${reader.file}`);
    assert(Array.isArray(reader.dirs) && reader.dirs.length > 0, `missing dirs for ${reader.file}`);
    assert(reader.dirs.every(dir => dir === '.gsd/milestones' || dir === '.gsd/tasks'), `invalid dir in ${reader.file}`);
    assert(VERDICTS.has(reader.verdict), `unknown verdict in ${reader.file}: ${reader.verdict}`);
    assert(typeof reader.evidence === 'string' && reader.evidence.trim(), `missing evidence for ${reader.file}`);
    assert(typeof reader.why === 'string' && reader.why.trim(), `missing why for ${reader.file}`);
    if (reader.verdict === 'safe-by-construction') {
      assert(/filter|no .*readdir|never enumerat|specific/i.test(reader.why), `safe reader lacks named filter: ${reader.file}`);
    }
  }
}

function testD11FloorAndUnlearnedProjection() {
  const registered = new Set(WRAPPER_DIR_READERS.map(reader => reader.file));
  assertNamedFiles('D11 reader missing from inventory', D11_NAMED_READERS.filter(file => !registered.has(file)));
  const expected = WRAPPER_DIR_READERS.filter(reader => reader.verdict === 'breaks');
  assert.deepStrictEqual(unlearnedReaders(), expected, 'unlearnedReaders must return exactly the breaks entries');
}

function testRegistryIsFrozenData() {
  assert(Object.isFrozen(WRAPPER_DIR_READERS), 'registry array must be frozen');
  assert(Object.isFrozen(VERDICTS), 'verdict set must be frozen');
  for (const reader of WRAPPER_DIR_READERS) {
    assert(Object.isFrozen(reader.dirs), `dirs must be frozen: ${reader.file}`);
  }
}

function run() {
  testCoverageIsMeasuredBothWays();
  testEntriesRemainConcreteAndClosed();
  testD11FloorAndUnlearnedProjection();
  testRegistryIsFrozenData();
  process.stdout.write('forge-wrapper-readers.test.js: ok\n');
}

if (require.main === module) run();

module.exports = { scanWrapperDirReaders, scriptFiles };
