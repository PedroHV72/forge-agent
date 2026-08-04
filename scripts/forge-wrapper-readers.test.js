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
const INVENTORY_SOURCE_FILE = 'forge-wrapper-readers.js';
// The trigger is deliberately coarse: any enumeration in a file that also
// names a wrapper root.  A proximity pattern let path.join(gsdDir,'milestones')
// escape, and this scan is what unlocks a destructive opt-in.
const ROOT_DIR_PATTERN = /['"]milestones['"]|['"]tasks['"]/;
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

function isInventorySource(file) {
  // The registry quotes the scan vocabulary as data. Exclude only this exact
  // source file; a name or pattern rule here could hide a real future reader.
  return file === INVENTORY_SOURCE_FILE;
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
    if (isInventorySource(file)) return false;
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
      assert(/filter|no (?:.*readdir|directory enumeration)|never enumerat|specific/i.test(reader.why), `safe reader lacks named filter: ${reader.file}`);
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
  assert(Object.isFrozen(VERDICTS), 'verdict vocabulary must be frozen');
  for (const reader of WRAPPER_DIR_READERS) {
    assert(Object.isFrozen(reader), `entry must be frozen: ${reader.file}`);
    assert(Object.isFrozen(reader.dirs), `dirs must be frozen: ${reader.file}`);
  }
}

function testMutationAttemptsDoNotChangeTheCriterion() {
  // Behavioural, not structural: freezing the array still left every entry
  // mutable, and Object.freeze over a Set never blocked .add().
  const before = unlearnedReaders().length;
  const entry = WRAPPER_DIR_READERS[1];
  const originalVerdict = entry.verdict;
  try { entry.verdict = 'learned'; } catch (error) { /* strict mode throws; either way the value must hold */ }
  assert.strictEqual(entry.verdict, originalVerdict, 'a verdict was mutated in runtime');
  assert.strictEqual(unlearnedReaders().length, before, 'the opt-in criterion moved after a mutation attempt');

  assert.strictEqual(typeof VERDICTS.add, 'undefined', 'VERDICTS must not expose a mutator');
  try { VERDICTS.add('bogus'); } catch (error) { /* expected: not a function */ }
  assert.strictEqual(VERDICTS.has('bogus'), false, 'the verdict vocabulary accepted a new value');
}

function testSelfExclusionCannotHideAnotherReader() {
  assert.strictEqual(isInventorySource(INVENTORY_SOURCE_FILE), true, 'registry source must be excluded exactly');
  assert.strictEqual(isInventorySource('forge-smoke.js'), false, 'self exclusion must not hide a real reader');
  assert.strictEqual(isInventorySource('forge-wrapper-readers-copy.js'), false, 'self exclusion must be exact, not a filename pattern');
}

function run() {
  testCoverageIsMeasuredBothWays();
  testEntriesRemainConcreteAndClosed();
  testD11FloorAndUnlearnedProjection();
  testRegistryIsFrozenData();
  testMutationAttemptsDoNotChangeTheCriterion();
  testSelfExclusionCannotHideAnotherReader();
  process.stdout.write('forge-wrapper-readers.test.js: ok\n');
}

if (require.main === module) run();

module.exports = { scanWrapperDirReaders, scriptFiles };
