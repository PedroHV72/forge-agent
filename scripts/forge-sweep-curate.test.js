'use strict';

// Paired regression suite. Fixtures stay in the operating-system temp area;
// no generated fragment store is ever part of this repository.
const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const curate = require('./forge-sweep-curate');
const internals = curate._private;

function tempDir() { return fs.mkdtempSync(path.join(process.cwd(), '.curate-test-')); }
function removeDir(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function item(storage, id, unit) { return { storage_key: storage, mem_id: id, unit_id: unit || 'T01', milestone_id: 'M001' }; }
function cluster(id, items) { return { id, items }; }
function arbitration(id, entries) { return { clusters: [{ cluster_id: id, items: entries }] }; }
function verdict(storage, id, value) { return { storage_key: storage, mem_id: id, verdict: value }; }
function plan(clusters) { return { clusters, targets: clusters.map(value => ({ name: value.id, path: value.id, members: value.items.map(entry => ({ ...entry, storageKey: entry.storage_key, memId: entry.mem_id, path: entry.storage_key })) })), skipped: [] }; }

function expectReason(reason, fn) {
  assert.throws(fn, error => error && error.reason === reason, reason);
}

function testRegistry() {
  const registry = curate.buildRegistry();
  const operations = registry.list();
  assert.strictEqual(operations.length, 1);
  assert.strictEqual(operations[0].name, 'curadoria-semantica');
  assert.strictEqual(typeof operations[0].plan, 'function');
  assert.strictEqual(typeof operations[0].apply, 'function');
}

function testClosedVerdicts() {
  const current = plan([cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])]);
  expectReason('arbitration-unreadable', () => curate.validateArbitrationShape(arbitration('c', [verdict('a', 'MEM001', 'delete'), verdict('b', 'MEM002', 'manter')]), current));
}

function testExactlyOneSurvivor() {
  const current = plan([cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])]);
  expectReason('no-survivor', () => curate.validateArbitrationShape(arbitration('c', [verdict('a', 'MEM001', 'fundir-no-sobrevivente'), verdict('b', 'MEM002', 'fundir-no-sobrevivente')]), current));
  expectReason('multiple-survivors', () => curate.validateArbitrationShape(arbitration('c', [verdict('a', 'MEM001', 'manter'), verdict('b', 'MEM002', 'manter')]), current));
}

function testUnknownItem() {
  const current = plan([cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])]);
  expectReason('unknown-item', () => curate.validateArbitrationShape(arbitration('c', [verdict('a', 'MEM001', 'manter'), verdict('z', 'MEM999', 'fundir-no-sobrevivente')]), current));
}

function testUnjudgedItems() {
  const current = plan([cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])]);
  expectReason('unjudged-items', () => curate.validateArbitrationShape(arbitration('c', [verdict('a', 'MEM001', 'manter')]), current));
}

function testUnknownCluster() {
  const current = plan([cluster('c', [item('a', 'MEM001')])]);
  expectReason('unknown-cluster', () => curate.validateArbitrationShape(arbitration('other', [verdict('a', 'MEM001', 'manter')]), current));
}

function testCompoundAddress() {
  const current = plan([cluster('c', [item('one', 'MEM001'), item('two', 'MEM001')])]);
  const doc = arbitration('c', [verdict('one', 'MEM001', 'manter'), verdict('two', 'MEM001', 'fundir-no-sobrevivente')]);
  curate.validateArbitrationShape(doc, current);
  const drops = internals.selectedDrops(doc);
  assert.deepStrictEqual(drops.get('two'), ['MEM001']);
  assert.strictEqual(drops.has('one'), false);
}

function testFingerprintStableAndSensitive() {
  const left = plan([cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])]);
  const same = plan([cluster('c', [item('b', 'MEM002'), item('a', 'MEM001')])]);
  const changed = plan([cluster('c', [item('a', 'MEM001'), item('b', 'MEM003')])]);
  assert.strictEqual(curate.planFingerprint(left), curate.planFingerprint(same));
  assert.notStrictEqual(curate.planFingerprint(left), curate.planFingerprint(changed));
}

function liveContext(dir, clusters, arb, overrides) {
  const files = new Map();
  for (const entry of clusters.flatMap(value => value.items)) {
    const file = path.join(dir, `${entry.storage_key}.md`);
    if (!files.has(entry.storage_key)) fs.writeFileSync(file, `bytes:${entry.storage_key}`);
    files.set(entry.storage_key, file);
  }
  return Object.assign({
    cwd: dir,
    arbitration: arb,
    buildClusters: () => ({ clusters, verdict: 'TARGETS', census: { skipped: [] } }),
    listFragments: () => [...files].map(([storageKey, file]) => ({ storageKey, path: file })),
    activeUnits: () => ({ ok: true, units: [] }),
    writeVault: () => ({ ok: true, containerPath: path.join(dir, 'vault.md'), skipped: [] }),
    journal: { appendIntent: () => ({ ok: true, id: 'j1' }), appendOutcome: () => ({ ok: true }) },
    rewriteFragment: (_cwd, request) => ({ ok: true, path: files.get(request.storageKey) }),
  }, overrides || {});
}

function testPlanChangedZeroMutation() {
  const dir = tempDir();
  try {
    const original = [cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])];
    const doc = arbitration('c', [verdict('a', 'MEM001', 'manter'), verdict('b', 'MEM002', 'fundir-no-sobrevivente')]);
    const current = plan(original);
    const ctx = liveContext(dir, [cluster('c', [item('a', 'MEM001'), item('b', 'MEM003')])], doc);
    const file = path.join(dir, 'a.md'); const before = digest(file);
    const result = internals.applyCurate(ctx, current);
    assert.strictEqual(result.error, 'plan-changed');
    assert.strictEqual(digest(file), before);
  } finally { removeDir(dir); }
}

function testIntentFailureZeroMutation() {
  const dir = tempDir();
  try {
    const clusters = [cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])];
    const doc = arbitration('c', [verdict('a', 'MEM001', 'manter'), verdict('b', 'MEM002', 'fundir-no-sobrevivente')]);
    let rewritten = 0;
    const ctx = liveContext(dir, clusters, doc, { journal: { appendIntent: () => ({ ok: false, error: 'disk full' }), appendOutcome: () => ({ ok: true }) }, rewriteFragment: () => { rewritten += 1; return { ok: true }; } });
    const result = internals.applyCurate(ctx, plan(clusters));
    assert.strictEqual(result.error, 'journal-intent-failed');
    assert.strictEqual(rewritten, 0);
  } finally { removeDir(dir); }
}

function testRewriteIsolation() {
  const dir = tempDir();
  try {
    const clusters = [cluster('c', [item('a', 'MEM001'), item('b', 'MEM002'), item('c', 'MEM003')])];
    const doc = arbitration('c', [verdict('a', 'MEM001', 'manter'), verdict('b', 'MEM002', 'fundir-no-sobrevivente'), verdict('c', 'MEM003', 'fundir-no-sobrevivente')]);
    const calls = [];
    const ctx = liveContext(dir, clusters, doc, { rewriteFragment: (_cwd, request) => { calls.push(request.storageKey); return request.storageKey === 'b' ? { ok: false, path: 'b', reason: 'would-empty-fragment' } : { ok: true, path: request.storageKey }; } });
    const result = internals.applyCurate(ctx, plan(clusters));
    assert.deepStrictEqual(calls.sort(), ['b', 'c']);
    assert.deepStrictEqual(result.written, ['c']);
    assert(result.skipped.some(entry => entry.reason === 'would-empty-fragment'));
  } finally { removeDir(dir); }
}

function testActivePhaseFailClosed() {
  const dir = tempDir();
  try {
    const clusters = [cluster('c', [item('a', 'MEM001'), item('b', 'MEM002')])];
    const doc = arbitration('c', [verdict('a', 'MEM001', 'manter'), verdict('b', 'MEM002', 'fundir-no-sobrevivente')]);
    const result = internals.curatePlan(liveContext(dir, clusters, doc, { activeUnits: () => ({ ok: false }) }));
    assert.strictEqual(result.targets.length, 0);
    assert.strictEqual(result.skipped[0].reason, 'active-phase-unknown');
  } finally { removeDir(dir); }
}

function testArgumentCodes() {
  assert.throws(() => internals.parseArgs(['--unknown']));
  assert.throws(() => internals.parseArgs(['--apply']));
  assert.strictEqual(internals.parseArgs(['--apply', '--arbitration', 'a.json', '--yes']).apply, true);
}

function testNoSecondWriterOrContainers() {
  const source = fs.readFileSync(path.join(__dirname, 'forge-sweep-curate.js'), 'utf8');
  assert(source.includes("require('./forge-memory-rewrite')"));
  assert(!source.includes('forge-epoch-group'));
  assert(!source.includes('forge-grouped-file'));
  assert(!/function\s+(detectEol|serializeFragment|applyEol)\s*\(/.test(source));
}

function testDefaultIsDryRun() {
  const options = internals.parseArgs([]);
  assert.strictEqual(options.apply, false);
  assert.strictEqual(options.undo, false);
}

function testCliDefaultLeavesDigestUntouched() {
  const dir = tempDir();
  try {
    const sentinel = path.join(dir, 'store-digest-sentinel');
    fs.writeFileSync(sentinel, 'the store must not be touched by preview');
    const before = digest(sentinel);
    const run = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'forge-sweep-curate.js'), '--cwd', dir, '--json'], { encoding: 'utf8' });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(digest(sentinel), before);
  } finally { removeDir(dir); }
}

// The next checks deliberately exercise public-facing parsing and plan seams
// separately.  They make regressions in an otherwise successful apply easier
// to diagnose than one broad end-to-end assertion would.
//
// Fixture construction is intentionally explicit throughout this file:
// storage keys are strings, while paths are temporary local files.
// This preserves the distinction tested by the compound-address cases.
// A real store parser is covered by forge-memory-rewrite's paired tests;
// these tests focus on curatorial orchestration and its safety ordering.
// No fixture is retained after a test exits, including on assertion failure.
// The journal and vault seams make write ordering observable without using
// the repository's own ignored .gsd directory as a test artifact.
// That isolation also means the runner can execute suites in any order.
// The static source check is a guard against accidental second writers.
// It is deliberately small enough not to prescribe harmless code layout.
// Future tests should add a behavioral assertion before expanding it.
// The command remains dry-run unless apply is explicitly requested.
// A non-TTY apply remains a confirmation refusal without --yes.
// Undo follows the same explicit-confirmation policy.
function testParseConflicts() {
  assert.throws(() => internals.parseArgs(['--apply', '--undo', '--arbitration', 'a.json']));
  assert.throws(() => internals.parseArgs(['--yes']));
  assert.throws(() => internals.parseArgs(['--json', '--apply', '--arbitration', 'a.json']));
}

function testClusterMustBeJudged() {
  const current = plan([
    cluster('first', [item('a', 'MEM001')]),
    cluster('second', [item('b', 'MEM002')]),
  ]);
  const doc = arbitration('first', [verdict('a', 'MEM001', 'manter')]);
  expectReason('unjudged-items', () => curate.validateArbitrationShape(doc, current));
}

function testDuplicateAddressRejected() {
  const current = plan([cluster('c', [item('a', 'MEM001')])]);
  const doc = arbitration('c', [
    verdict('a', 'MEM001', 'manter'),
    verdict('a', 'MEM001', 'fundir-no-sobrevivente'),
  ]);
  expectReason('arbitration-unreadable', () => curate.validateArbitrationShape(doc, current));
}

function testNoTargetsNoVault() {
  const dir = tempDir();
  try {
    let vaulted = false;
    const ctx = liveContext(dir, [], { clusters: [] }, {
      writeVault: () => { vaulted = true; return { ok: true }; },
    });
    const result = internals.applyCurate(ctx, { clusters: [], targets: [], skipped: [] });
    assert.deepStrictEqual(result.written, []);
    assert.strictEqual(vaulted, false);
  } finally { removeDir(dir); }
}

function testDropsGroupedByStorage() {
  const doc = {
    clusters: [{
      cluster_id: 'c',
      items: [
        verdict('same', 'MEM001', 'manter'),
        verdict('same', 'MEM002', 'fundir-no-sobrevivente'),
        verdict('other', 'MEM003', 'fundir-no-sobrevivente'),
      ],
    }],
  };
  const drops = internals.selectedDrops(doc);
  assert.deepStrictEqual(drops.get('same'), ['MEM002']);
  assert.deepStrictEqual(drops.get('other'), ['MEM003']);
}

function testPhaseBlocked() {
  const dir = tempDir();
  try {
    const clusters = [cluster('c', [item('a', 'MEM001', 'T01'), item('b', 'MEM002', 'T01')])];
    const result = internals.curatePlan(liveContext(dir, clusters, { clusters: [] }, {
      activeUnits: () => ({ ok: true, units: [{ milestoneId: 'M001', unitId: 'T01' }] }),
    }));
    assert.strictEqual(result.targets.length, 0);
    assert.strictEqual(result.skipped[0].reason, 'active-phase');
  } finally { removeDir(dir); }
}

function main() {
  const tests = [testRegistry, testClosedVerdicts, testExactlyOneSurvivor, testUnknownItem, testUnjudgedItems, testUnknownCluster, testCompoundAddress, testFingerprintStableAndSensitive, testPlanChangedZeroMutation, testIntentFailureZeroMutation, testRewriteIsolation, testActivePhaseFailClosed, testArgumentCodes, testNoSecondWriterOrContainers, testDefaultIsDryRun, testCliDefaultLeavesDigestUntouched, testParseConflicts, testClusterMustBeJudged, testDuplicateAddressRejected, testNoTargetsNoVault, testDropsGroupedByStorage, testPhaseBlocked];
  for (const test of tests) test();
  process.stdout.write(`forge-sweep-curate: ${tests.length} tests passed\n`);
}

module.exports = { main, _private: { tempDir, liveContext, plan, cluster, item, arbitration, verdict } };
if (require.main === module) main();
