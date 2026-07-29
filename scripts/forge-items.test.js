#!/usr/bin/env node
// forge-items.test.js — contract test suite for forge-items.js
// Covers merge-safety (real git merge demo), prefix resolution, closed status,
// dual-regime provenance, promoted_to validation, per-project cwd isolation and
// round-trip serialization. Every fixture lives under a temp dir removed in a
// `finally` — nothing ever touches the live repo .gsd/.
// Run: node scripts/forge-items.test.js  (exits 0 = all pass, 1 = any fail)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const items = require('./forge-items.js');
const CLI = path.join(__dirname, 'forge-items.js');

// ── Harness ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-items-test-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, opts) {
  opts = opts || {};
  return spawnSync(process.execPath, [CLI, ...args], { cwd: opts.cwd, encoding: 'utf8' });
}

function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}

function gitCommit(dir, message) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

console.log('\n=== forge-items.js — contract test suite ===\n');

// ── 1. Merge-safety (the roadmap demo) ───────────────────────────────────────
console.log('1. Merge-safety — real two-branch git merge');
test('two branches each add one item merge with zero conflicts, both fragments present', () => {
  withTmpDir(dir => {
    gitInit(dir);
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
    gitCommit(dir, 'base');
    const baseBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
      .toString().trim();

    execFileSync('git', ['checkout', '-q', '-b', 'branch-a'], { cwd: dir });
    const a = items.addItem(dir, { title: 'Branch A item', origin: 'human' });
    gitCommit(dir, 'add item A');

    execFileSync('git', ['checkout', '-q', baseBranch], { cwd: dir });
    execFileSync('git', ['checkout', '-q', '-b', 'branch-b'], { cwd: dir });
    // Force a distinct ID even if minted in the same wall-clock second as A.
    const b = items.addItem(dir, { title: 'Branch B item', origin: 'human', id: a.id + '-b' });
    gitCommit(dir, 'add item B');

    // Merge branch-a into branch-b.
    const mergeResult = spawnSync('git', ['merge', 'branch-a', '--no-edit'], { cwd: dir, encoding: 'utf8' });
    assert(mergeResult.status === 0, `merge should exit 0, got ${mergeResult.status}: ${mergeResult.stderr}`);
    assert(!/^<{7}|^={7}|^>{7}/m.test(mergeResult.stdout + mergeResult.stderr), 'no conflict markers expected');

    assert(fs.existsSync(a.path), 'item A fragment must exist after merge');
    assert(fs.existsSync(b.path), 'item B fragment must exist after merge');
    assert(a.path !== b.path, 'the two-files property: distinct fragment files, not one shared index');
  });
});

// ── 2. Prefix resolution ─────────────────────────────────────────────────────
console.log('\n2. Prefix resolution');
test('unique prefix resolves to full ID', () => {
  withTmpDir(dir => {
    const dirItems = items.itemsDir(dir);
    fs.mkdirSync(dirItems, { recursive: true });
    const id = 'I-20260729120000-unique-one';
    fs.writeFileSync(path.join(dirItems, `${id}.md`), items.serializeItem({
      id, title: 'Unique', status: 'inbox', origin: 'human',
      created: new Date().toISOString(), updated: new Date().toISOString(),
    }));
    assertEq(items.resolveItemId(dir, 'I-20260729120000-unique'), id);
  });
});

test('ambiguous prefix — CLI --resolve exits non-zero and stderr names both candidates', () => {
  withTmpDir(dir => {
    const dirItems = items.itemsDir(dir);
    fs.mkdirSync(dirItems, { recursive: true });
    const idA = 'I-20260729120000-alphaone';
    const idB = 'I-20260729120000-alphatwo';
    for (const id of [idA, idB]) {
      fs.writeFileSync(path.join(dirItems, `${id}.md`), items.serializeItem({
        id, title: id, status: 'inbox', origin: 'human',
        created: new Date().toISOString(), updated: new Date().toISOString(),
      }));
    }
    const result = runCli(['--resolve', 'I-20260729120000-alpha', '--cwd', dir]);
    assert(result.status !== 0, `expected non-zero exit, got ${result.status}`);
    assert(result.stderr.includes(idA), `stderr must name ${idA}: ${result.stderr}`);
    assert(result.stderr.includes(idB), `stderr must name ${idB}: ${result.stderr}`);
  });
});

test('unknown prefix — CLI --resolve exits non-zero', () => {
  withTmpDir(dir => {
    fs.mkdirSync(items.itemsDir(dir), { recursive: true });
    const result = runCli(['--resolve', 'I-99999999999999', '--cwd', dir]);
    assert(result.status !== 0, `expected non-zero exit, got ${result.status}`);
  });
});

// ── 3. Closed status ──────────────────────────────────────────────────────────
console.log('\n3. Closed status');
test('CLI --set-status <id> foo exits 1', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Status item', origin: 'human' });
    const result = runCli(['--set-status', created.id, 'foo', '--cwd', dir]);
    assertEq(result.status, 1);
  });
});

test('each of the five valid statuses exits 0 via CLI', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Status item', origin: 'human' });
    for (const status of items.STATUSES) {
      const result = runCli(['--set-status', created.id, status, '--cwd', dir]);
      assertEq(result.status, 0, `status "${status}" should exit 0: ${result.stderr}`);
    }
  });
});

test('library setStatus throws on invalid status', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Status item', origin: 'human' });
    let threw = null;
    try { items.setStatus(dir, created.id, 'foo'); } catch (e) { threw = e; }
    assert(threw !== null, 'setStatus("foo") must throw');
  });
});

// ── 4. Provenance dual-regime ────────────────────────────────────────────────
console.log('\n4. Provenance dual-regime');
test('origin auto without source — CLI --validate exits 1', () => {
  withTmpDir(dir => {
    const dirItems = items.itemsDir(dir);
    fs.mkdirSync(dirItems, { recursive: true });
    const id = 'I-20260729120000-auto-nosrc';
    fs.writeFileSync(path.join(dirItems, `${id}.md`), items.serializeItem({
      id, title: 'Auto no source', status: 'inbox', origin: 'auto',
      created: new Date().toISOString(), updated: new Date().toISOString(),
    }));
    const result = runCli(['--validate', id, '--cwd', dir]);
    assertEq(result.status, 1);
  });
});

test('origin auto with source — CLI --validate exits 0', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Auto with source', origin: 'auto', source: 'review/S02/R1' });
    const result = runCli(['--validate', created.id, '--cwd', dir]);
    assertEq(result.status, 0, result.stderr);
  });
});

test('origin human without source — CLI --validate exits 0', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Human item', origin: 'human' });
    const result = runCli(['--validate', created.id, '--cwd', dir]);
    assertEq(result.status, 0, result.stderr);
  });
});

// ── 5. promoted_to ────────────────────────────────────────────────────────────
console.log('\n5. promoted_to');
test('--promote with a timestamp milestone target writes promoted_to', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Promotable', origin: 'human' });
    const result = runCli(['--promote', created.id, 'M-20260729120000-x', '--cwd', dir]);
    assertEq(result.status, 0, result.stderr);
    const fragment = fs.readFileSync(created.path, 'utf8');
    assert(fragment.includes('promoted_to: M-20260729120000-x'), `fragment should contain promoted_to:\n${fragment}`);
  });
});

test('--promote with a garbage target exits 1', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Not promotable', origin: 'human' });
    const result = runCli(['--promote', created.id, 'GARBAGE', '--cwd', dir]);
    assertEq(result.status, 1);
  });
});

test('--promote target validated via forge-ids: legacy M005 target accepted', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Legacy target', origin: 'human' });
    const result = runCli(['--promote', created.id, 'M005', '--cwd', dir]);
    assertEq(result.status, 0, result.stderr);
    const fragment = fs.readFileSync(created.path, 'utf8');
    assert(fragment.includes('promoted_to: M005'), `fragment should contain promoted_to: M005:\n${fragment}`);
  });
});

// ── 6. Per-project scope ─────────────────────────────────────────────────────
console.log('\n6. Per-project scope');
test('--add in project A does not leak into --list --cwd B', () => {
  withTmpDir(dirA => {
    withTmpDir(dirB => {
      items.addItem(dirA, { title: 'Only in A', origin: 'human' });
      const result = runCli(['--list', '--json', '--cwd', dirB]);
      assertEq(result.status, 0, result.stderr);
      const listed = JSON.parse(result.stdout);
      assertEq(listed, [], 'project B should see zero items created in project A');
    });
  });
});

// ── 7. Round-trip ─────────────────────────────────────────────────────────────
console.log('\n7. Round-trip (multi-line body + colon-leading title)');
test('multi-line body and colon-leading title survive add → read', () => {
  withTmpDir(dir => {
    const title = ': Item with a colon-leading title';
    const body = 'Line one\nLine two: with a colon\nLine three';
    const created = items.addItem(dir, { title, origin: 'human', body });
    const readBack = items.readItem(dir, created.id);
    assertEq(readBack.title, title, 'title must round-trip losslessly');
    assertEq(readBack.body, body, 'body must round-trip losslessly');
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`      ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
