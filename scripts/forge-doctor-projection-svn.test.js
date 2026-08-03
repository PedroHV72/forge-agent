#!/usr/bin/env node
'use strict';

// Layer 3 (projection-versioned) against a REAL SVN working copy.
//
// The check used to read `svn status <path>` textually and got the answer
// backwards in both directions, so one assertion cannot pin it: a test that only
// proves "ignored → passes" is satisfied by a check that never accuses anyone.
// Both directions are asserted here, plus the committed-and-clean case the old
// oracle silently missed (`svn status` prints nothing for it).
//
// Counterfactual by construction — pre-fix, case (a) fails (the ignored
// projections are reported as tracked) and case (c) fails (a genuinely
// versioned projection is reported as clean).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const { checkProjectionVersioned } = require('./forge-doctor.js');
const { isTracked } = require('./forge-vcs.js');
const { detectVcs } = require('./forge-ignore.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL ${name}\n    ${error && error.message}\n`);
  }
}

// ── Gate — mirrors forge-smoke.js § svnGateDecision ─────────────────────────
// A runner that is SUPPOSED to have SVN (CI on Linux installs it) must fail
// rather than skip: a silently skipped SVN suite is how an SVN regression ships.
function binaryPresent(bin) {
  try {
    const r = spawnSync(bin, ['--version', '--quiet'], { encoding: 'utf8' });
    return r.status === 0;
  } catch { return false; }
}

const svnPresent = binaryPresent('svn') && binaryPresent('svnadmin');
if (!svnPresent) {
  if (process.env.CI && process.platform === 'linux') {
    process.stdout.write('  FAIL svn/svnadmin missing on a runner that must gate SVN behavior\n');
    process.stdout.write('\n0 passed, 1 failed\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('  skip forge-doctor projection-versioned (SVN) — svn/svnadmin not on PATH\n');
    process.stdout.write('\n0 passed, 0 failed\n');
  }
  return;
}

// ── Fixture ─────────────────────────────────────────────────────────────────
const PROJECTIONS = ['LEDGER.md', 'DECISIONS.md', 'AUTO-MEMORY.md', 'CHECKER-MEMORY.md', 'ITEMS.md'];

function svnWc(label, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `forge-doctor-svn-${label}-`));
  const repo = path.join(root, 'repo');
  const wc = path.join(root, 'wc');
  const configDir = path.join(root, 'svnconfig');
  fs.mkdirSync(configDir, { recursive: true });

  // Fixture-configured client: a developer's global ignores must not be able to
  // change the outcome of a proof about ignore handling.
  const svn = (cwd, args) => {
    const r = spawnSync('svn', ['--non-interactive', '--config-dir', configDir, ...args], { cwd, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };

  try {
    const created = spawnSync('svnadmin', ['create', repo], { encoding: 'utf8' });
    assert.strictEqual(created.status, 0, `svnadmin create failed: ${created.stderr}`);
    assert.strictEqual(svn(root, ['checkout', pathToFileURL(repo).href, wc]).status, 0, 'svn checkout failed');

    // A correctly configured working copy: .gsd/ is versioned, every projection
    // monolith is listed in svn:ignore, and each exists on disk unversioned.
    fs.mkdirSync(path.join(wc, '.gsd'));
    assert.strictEqual(svn(wc, ['add', '--depth', 'empty', '.gsd']).status, 0, 'svn add .gsd failed');
    assert.strictEqual(svn(wc, ['propset', 'svn:ignore', PROJECTIONS.join('\n') + '\n', '.gsd']).status, 0, 'propset failed');
    assert.strictEqual(svn(wc, ['commit', '-m', 'gsd skeleton']).status, 0, 'commit failed');
    for (const name of PROJECTIONS) fs.writeFileSync(path.join(wc, '.gsd', name), `# ${name}\n`, 'utf8');

    fn({ wc, svn, root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── (a) the false positive: ignored projections must NOT be accused ─────────

test('correctly ignored projections pass the check in an SVN working copy', () => {
  svnWc('ignored', ({ wc, svn }) => {
    assert.strictEqual(detectVcs(wc), 'svn', 'fixture must read as an SVN working copy');

    // Ground truth from SVN itself: every projection is ignored, none versioned.
    const status = svn(wc, ['status', '--no-ignore', '.gsd']).stdout;
    for (const name of PROJECTIONS) {
      assert.ok(new RegExp(`^I\\s+.*${name.replace('.', '\\.')}$`, 'm').test(status),
        `${name} must be ignored in the fixture, got:\n${status}`);
    }

    const r = checkProjectionVersioned(wc);
    assert.deepStrictEqual(r.tracked, [], 'an ignored projection is not tracked');
    assert.strictEqual(r.ok, true, `check must pass, got: ${r.message}`);
    assert.strictEqual(r.unreadable, undefined, 'every path must be probeable');
  });
});

// ── (b) a genuinely `svn add`ed projection must still be caught ─────────────

test('an svn-added projection fails the check and is named', () => {
  svnWc('added', ({ wc, svn }) => {
    // Adding an ignored path explicitly is allowed (--force overrides the
    // ignore) — exactly the mistake this layer exists to catch.
    assert.strictEqual(svn(wc, ['add', '--force', path.join('.gsd', 'DECISIONS.md')]).status, 0, 'svn add failed');

    const r = checkProjectionVersioned(wc);
    assert.strictEqual(r.ok, false, 'a versioned projection must fail the check');
    assert.deepStrictEqual(r.tracked, ['.gsd/DECISIONS.md'], 'only the added path is accused');
    assert.ok(r.message.includes('.gsd/DECISIONS.md'), 'the message names the offending path');
    assert.ok(/tracked by SVN/.test(r.message), 'the message names the VCS');
  });
});

// ── (c) committed-and-clean: invisible to `svn status`, caught by `svn info` ─

test('a committed, unmodified projection is still detected as versioned', () => {
  svnWc('committed', ({ wc, svn }) => {
    assert.strictEqual(svn(wc, ['add', '--force', path.join('.gsd', 'LEDGER.md')]).status, 0, 'svn add failed');
    assert.strictEqual(svn(wc, ['commit', '-m', 'oops, versioned a projection']).status, 0, 'commit failed');

    // The old oracle's blind spot: `svn status` says nothing about a clean
    // versioned file, so a status-based check reads it as untracked.
    assert.strictEqual(svn(wc, ['status', path.join('.gsd', 'LEDGER.md')]).stdout.trim(), '',
      'fixture precondition: svn status is silent for a clean versioned file');

    const r = checkProjectionVersioned(wc);
    assert.strictEqual(r.ok, false, 'a committed projection must fail the check');
    assert.deepStrictEqual(r.tracked, ['.gsd/LEDGER.md']);
  });
});

// ── (d) the seam primitive on a real working copy, including peg syntax ─────

test('isTracked reads real SVN membership and survives an @ in the path', () => {
  svnWc('peg', ({ wc, svn }) => {
    fs.writeFileSync(path.join(wc, 'services@1.2.0.txt'), 'x\n', 'utf8');
    // `svn add` needs the same peg escape the primitive applies internally.
    assert.strictEqual(svn(wc, ['add', '--', 'services@1.2.0.txt@']).status, 0, 'svn add of an @ path failed');
    assert.strictEqual(svn(wc, ['commit', '-m', 'peg path']).status, 0, 'commit failed');

    assert.deepStrictEqual(isTracked(wc, 'services@1.2.0.txt', { vcs: 'svn' }),
      { vcs: 'svn', ok: true, tracked: true }, 'an @ path must not be read as a peg revision');
    assert.deepStrictEqual(isTracked(wc, '.gsd/LEDGER.md', { vcs: 'svn' }),
      { vcs: 'svn', ok: true, tracked: false }, 'ignored means not tracked');
    assert.deepStrictEqual(isTracked(wc, '.gsd', { vcs: 'svn' }),
      { vcs: 'svn', ok: true, tracked: true }, 'the versioned .gsd directory itself is tracked');
  });
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
