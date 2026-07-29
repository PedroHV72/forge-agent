#!/usr/bin/env node
'use strict';

/* Policy tests for the VCS-aware surgical-reset guard. The VCS seam is patched
 * in-place because forge-surgical-reset and this suite share its module object. */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const reset = require('./forge-surgical-reset.js');
const vcs = require('./forge-vcs.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
}

function gitFixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reset-guard-'));
  git(cwd, ['init', '-q']);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'before\n');
  git(cwd, ['add', 'tracked.txt']);
  git(cwd, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid', 'commit', '-qm', 'init']);
  return cwd;
}

function stateFile(cwd, state) {
  const file = path.join(cwd, 'state.json');
  fs.writeFileSync(file, JSON.stringify({
    attempt: 1,
    start_sha: 'unused',
    pre_dirty: [],
    reason: '',
    result_file: '',
    code_dir: cwd,
    transient_retry_count: 0,
    ...state,
  }), 'utf8');
  return file;
}

function patchVcs(patches, fn) {
  const originals = {};
  for (const [key, value] of Object.entries(patches)) {
    originals[key] = vcs[key];
    vcs[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) vcs[key] = value;
  }
}

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('parseSvnBaseline normalizes accepted revisions and discards working-copy flags', () => {
  const cases = [
    ['1', '1'],
    ['1M', '1'],
    ['1:2M', '1:2'],
    ['1P', '1'],
    ['1S', '1'],
    ['2M', '2'],
  ];
  for (const [raw, range] of cases) assert.deepStrictEqual(reset.parseSvnBaseline(raw), { ok: true, range });
  assert.notStrictEqual(reset.parseSvnBaseline('2M').range, '1');
});

test('parseSvnBaseline rejects zero revisions and svnversion prose with named errors', () => {
  for (const raw of ['0', '0:1', '1:0']) {
    assert.deepStrictEqual(reset.parseSvnBaseline(raw), { ok: false, error: 'svn-baseline-zero-revision' });
  }
  for (const raw of ['Unversioned directory', '']) {
    assert.deepStrictEqual(reset.parseSvnBaseline(raw), { ok: false, error: 'svn-baseline-unparseable' });
  }
});

test('legacy state without vcs stays on the git path and never detects a VCS', () => {
  const cwd = gitFixture();
  try {
    const baseline = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    const file = stateFile(cwd, { start_sha: baseline });
    patchVcs({ detectVcs: () => { throw new Error('must not detect'); } }, () => {
      const outcome = reset.resetFromState(file);
      assert.strictEqual(outcome.code, 0);
      assert.strictEqual(outcome.result.ok, true);
    });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('a state VCS mismatch aborts before any destructive operation and preserves dirty content', () => {
  const cwd = gitFixture();
  try {
    const dirty = 'operator work\n';
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), dirty);
    const file = stateFile(cwd, { vcs: 'svn', start_sha: '1' });
    const outcome = reset.resetFromState(file);
    assert.strictEqual(outcome.code, 3);
    assert.strictEqual(outcome.result.abort, 'vcs-state-mismatch');
    assert.deepStrictEqual(outcome.result.overlap, []);
    assert.deepStrictEqual(outcome.result.preserved, []);
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), dirty);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('an SVN revision movement aborts before post-change or reset primitives', () => {
  withTempDir('forge-reset-svn-moved-', (cwd) => {
    const file = stateFile(cwd, { vcs: 'svn', start_sha: '1' });
    patchVcs({
      detectVcs: () => 'svn',
      baselineId: () => ({ vcs: 'svn', ok: true, id: '1:2M' }),
      postChanges: () => { throw new Error('postChanges must not run'); },
      restoreAndRemove: () => { throw new Error('restoreAndRemove must not run'); },
    }, () => {
      const outcome = reset.resetFromState(file);
      assert.deepStrictEqual(outcome, {
        code: 3,
        result: { ok: false, abort: 'svn-revision-moved', baseline: '1', current: '1:2', overlap: [], preserved: [] },
      });
    });
  });
});

test('an SVN M flag alone does not trigger the revision guard', () => {
  withTempDir('forge-reset-svn-flag-', (cwd) => {
    const file = stateFile(cwd, { vcs: 'svn', start_sha: '1' });
    let postCalls = 0;
    patchVcs({
      detectVcs: () => 'svn',
      baselineId: () => ({ vcs: 'svn', ok: true, id: '1M' }),
      postChanges: () => { postCalls += 1; return { vcs: 'svn', ok: true, entries: [] }; },
      restoreAndRemove: () => ({ vcs: 'svn', ok: true, restored: [], removed: [] }),
    }, () => {
      const outcome = reset.resetFromState(file);
      assert.strictEqual(outcome.code, 0);
      assert.strictEqual(postCalls, 2, 'postChanges runs for target calculation and verification');
    });
  });
});

test('a failed SVN restore never returns its misleading restored or removed arrays', () => {
  withTempDir('forge-reset-r2-', (cwd) => {
    patchVcs({
      restoreAndRemove: () => ({ vcs: 'svn', ok: false, restored: ['lie'], removed: ['lie2'], error: 'svn-revert-failed' }),
    }, () => {
      assert.throws(
        () => reset.executeReset(cwd, '1', { restore: [], remove: [], overlap: [], preserved: [] }, 'svn'),
        (error) => !error.message.includes('lie') && !error.message.includes('lie2') && /svn-revert-failed/.test(error.message),
      );
    });
  });
});

test('an unavailable or broken SVN baseline throws rather than impersonating a guard abort', () => {
  withTempDir('forge-reset-svn-broken-', (cwd) => {
    const file = stateFile(cwd, { vcs: 'svn', start_sha: '1' });
    patchVcs({
      detectVcs: () => 'svn',
      baselineId: () => ({ vcs: 'svn', ok: false, id: null, error: 'svn-baseline-failed' }),
    }, () => {
      assert.throws(() => reset.resetFromState(file), /svn-baseline-failed/);
    });
  });
});

test('CLI state-init refuses zero and unparseable SVN baselines with empty stdout', () => {
  for (const raw of ['0', 'Unversioned directory']) {
    withTempDir('forge-reset-state-init-', (cwd) => {
      fs.mkdirSync(path.join(cwd, '.svn'));
      const bin = path.join(cwd, 'bin');
      fs.mkdirSync(bin);
      const fake = path.join(bin, 'svnversion');
      fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' '${raw}'\n`, 'utf8');
      fs.chmodSync(fake, 0o755);
      const file = path.join(cwd, 'state.json');
      const result = spawnSync(process.execPath, [path.join(__dirname, 'forge-surgical-reset.js'), '--state-init', '--state', file, '--cwd', cwd], {
        cwd,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
        encoding: 'utf8',
      });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
      assert.match(result.stderr, raw === '0' ? /svn-baseline-zero-revision/ : /svn-baseline-unparseable/);
      assert.strictEqual(fs.existsSync(file), false);
    });
  }
});

test('R1: a throw-path reset failure emits a leftover diagnostic (same shape as code:2) without changing exit 1 or the original error', () => {
  const cwd = gitFixture();
  try {
    // A pre-existing dirty file: NOT touched by the sidecar, must be preserved
    // and must NEVER be misreported as leftover.
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'operator pre-existing work\n');
    const preHash = spawnSync('git', ['hash-object', 'tracked.txt'], { cwd, encoding: 'utf8' }).stdout.trim();
    // Sidecar wrote a NEW untracked file after the snapshot — this is what the
    // reset is supposed to remove, and what should surface as leftover when
    // the underlying restoreAndRemove primitive fails partway through.
    fs.writeFileSync(path.join(cwd, 'sidecar-added.txt'), 'sidecar output\n');
    const baseline = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    const file = stateFile(cwd, {
      start_sha: baseline,
      pre_dirty: [{ path: 'tracked.txt', hash: preHash }],
    });

    patchVcs({
      restoreAndRemove: () => ({ vcs: 'git', ok: false, restored: [], removed: [], error: 'git-checkout-failed-mid-batch' }),
    }, () => {
      let thrown = null;
      try {
        reset.resetFromState(file);
      } catch (e) {
        thrown = e;
      }
      assert.ok(thrown, 'resetFromState must throw when restoreAndRemove reports ok:false');
      // (c) original error message survives untouched.
      assert.match(thrown.message, /git-checkout-failed-mid-batch/);
      // (b) a leftover diagnostic is attached, re-derived from live state — not
      // from the (untrustworthy per S03/R2) restored/removed arrays.
      assert.ok(Array.isArray(thrown.leftover), 'leftover must be an array');
      assert.ok(thrown.leftover.includes('sidecar-added.txt'), 'the untouched sidecar addition must surface as leftover');
      assert.ok(!thrown.leftover.includes('tracked.txt'), 'the preserved pre-existing file must never appear as leftover');
    });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('R1: the CLI --reset path exits 1 (unchanged) for a genuine restoreAndRemove failure and prints the leftover diagnostic on stdout', () => {
  const cwd = gitFixture();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reset-fakegit-'));
  try {
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'M\n');
    const baseline = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    // sidecar-added.txt is untracked after the snapshot → target.remove, and is
    // exactly what should surface as leftover when the checkout batch fails.
    fs.writeFileSync(path.join(cwd, 'sidecar-added.txt'), 'sidecar output\n');
    const file = stateFile(cwd, { start_sha: baseline });

    // A `git` wrapper that forwards every subcommand to the real binary except
    // `checkout`, which fails — this exercises the real CLI process end to
    // end (not a patched vcs seam) for the restoreAndRemove failure path.
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/git';
    const fakeGit = path.join(binDir, 'git');
    // forge-vcs.js always invokes `git -C <dir> <subcommand> ...`, so the
    // subcommand is argv[3] (1-indexed: $1=-C, $2=<dir>, $3=<subcommand>).
    fs.writeFileSync(fakeGit, [
      '#!/bin/sh',
      'if [ "$3" = "checkout" ]; then',
      '  echo "fatal: forced checkout failed for test" >&2',
      '  exit 1',
      'fi',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeGit, 0o755);

    const cliResult = spawnSync(process.execPath, [path.join(__dirname, 'forge-surgical-reset.js'), '--reset', '--state', file], {
      cwd,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
      encoding: 'utf8',
    });
    // (a) exit code stays 1, never remapped to 2 (verify-failed) or 3 (overlap-abort).
    assert.strictEqual(cliResult.status, 1);
    // (c) the original underlying error is still present.
    assert.match(cliResult.stderr, /checkout failed/);
    // (b) a leftover diagnostic in the code:2 shape is printed to stdout.
    const printed = cliResult.stdout.trim().split('\n').pop();
    const parsed = JSON.parse(printed);
    assert.strictEqual(parsed.ok, false);
    assert.ok(Array.isArray(parsed.leftover), 'CLI stdout must carry a leftover array');
    assert.ok(parsed.leftover.includes('sidecar-added.txt'), 'the untouched sidecar addition must surface as leftover');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
