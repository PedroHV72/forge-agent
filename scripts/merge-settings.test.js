#!/usr/bin/env node
'use strict';

// merge-settings.test.js — the statusline points at a copy somebody maintains.
//
// Defect this suite pins: merge-settings.js wired `statusLine.command` to
// `~/.claude/forge-statusline.js`, a render target of NO source in
// forge-source-manifest.json. Nothing refreshed that copy (not `--update`,
// not `--migrate-legacy`), so it froze across releases — and once
// retireLegacyScripts removed `~/.claude/scripts/`, its `__dirname`
// companions (forge-runs.js, forge-accounts.js, forge-prefs.js,
// forge-usage-poll.js) vanished, silently degrading the account badge, the
// runs indicator and the usage poll. The fix points the statusline at the
// Forge home core (`~/.forge-agent/scripts/`), which the installer recopies
// wholesale on every install/update and where the companions exist as
// siblings. Section 106 of forge-smoke.js owns the static agreement between
// merge-settings.js and the maintained surfaces; THIS suite owns the
// behaviour — enable, migrate, remove — through the real CLI.
//
// R1  enable on empty settings wires the maintained path, and that path's
//     repo counterpart exists (the recopied core can only serve files the
//     repo actually has).
// R2  enable over settings carrying the OLD frozen path migrates it — the
//     unconditional assignment is the migration vehicle for existing
//     installs, asserted rather than narrated.
// R3  remove deletes a statusLine written with EITHER vintage of the path
//     (the basename `.includes('forge-statusline.js')` predicate), and does
//     NOT delete a foreign statusLine — the predicate is scoped, proven in
//     both directions.
// R4  enable is idempotent: a second run leaves settings byte-identical and
//     never duplicates hook entries.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'merge-settings.js');
const REPO_ROOT = path.resolve(__dirname, '..');
const MAINTAINED_COMMAND = 'node ~/.forge-agent/scripts/forge-statusline.js';
const FROZEN_COMMAND = 'node ~/.claude/forge-statusline.js';

// ── Runner ──────────────────────────────────────────────────────────────────
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
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
  }
}

const tmps = [];
function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'merge-settings-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Run the real CLI against a settings file; return { status, settings }. */
function run(settingsFile, extraArgs) {
  const r = spawnSync(process.execPath, [MODULE, settingsFile, ...(extraArgs || [])],
    { encoding: 'utf8', stdio: 'pipe' });
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* asserted by caller */ }
  return { status: r.status, settings, stderr: r.stderr };
}

function seed(dir, data) {
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return file;
}

// ── R1: enable wires the maintained path ────────────────────────────────────

test('R1: enable wires statusLine at the Forge home core, never the frozen flat path', () => {
  const file = seed(mktmp(), {});
  const { status, settings } = run(file);
  assertEqual(status, 0, 'enable exits 0');
  assert(settings && settings.statusLine, 'statusLine was written');
  assertEqual(settings.statusLine.command, MAINTAINED_COMMAND,
    'statusLine.command points at the installer-maintained copy');
  assert(settings.statusLine.command !== FROZEN_COMMAND,
    'the un-maintained ~/.claude flat path is gone from the enable path');
});

test('R1: the wired path has a repo counterpart the core recopy can serve', () => {
  // The installer recopies the repo's `scripts/` tree verbatim into
  // `~/.forge-agent/scripts/` (forge-installer.js MANAGED_CORE). A wired path
  // with no repo counterpart would freeze exactly like the old one — so the
  // correspondence is asserted, not assumed.
  // The correspondence is forge-home-relative, not home-relative: `~/.forge-agent`
  // IS the copied core, so the repo counterpart of `~/.forge-agent/scripts/x.js`
  // is `<repo>/scripts/x.js`. Stripping only `node ~/` leaves the `.forge-agent`
  // segment in and looks for it inside the repo, where it never exists.
  const FORGE_HOME_PREFIX = 'node ~/.forge-agent/';
  assert(MAINTAINED_COMMAND.startsWith(FORGE_HOME_PREFIX),
    `wired path left the forge home — this check can no longer derive a repo counterpart: ${MAINTAINED_COMMAND}`);
  const rel = MAINTAINED_COMMAND.slice(FORGE_HOME_PREFIX.length).split('/');
  assert(fs.existsSync(path.join(REPO_ROOT, ...rel)),
    `repo counterpart missing for wired path: ${rel.join('/')}`);
  // Companion floor: the modules the statusline resolves as __dirname
  // siblings must live in the same repo directory, or the recopied core
  // reproduces the post-retireLegacyScripts degradation.
  for (const companion of ['forge-runs.js', 'forge-accounts.js', 'forge-prefs.js', 'forge-usage-poll.js']) {
    assert(fs.existsSync(path.join(REPO_ROOT, 'scripts', companion)),
      `companion module missing next to the statusline in the repo: ${companion}`);
  }
});

// ── R2: existing installs migrate on the next merge ─────────────────────────

test('R2: enable over the OLD frozen path migrates it to the maintained one', () => {
  const file = seed(mktmp(), {
    statusLine: { type: 'command', command: FROZEN_COMMAND, refreshInterval: 1 },
  });
  const { status, settings } = run(file);
  assertEqual(status, 0, 'enable exits 0 over pre-existing settings');
  assertEqual(settings.statusLine.command, MAINTAINED_COMMAND,
    'the unconditional assignment migrates a settings.json written before the fix');
});

// ── R3: remove matches both vintages, and only ours ─────────────────────────

test('R3: remove deletes a statusLine written with the NEW path', () => {
  const file = seed(mktmp(), {
    statusLine: { type: 'command', command: MAINTAINED_COMMAND, refreshInterval: 1 },
  });
  const { status, settings } = run(file, ['--remove']);
  assertEqual(status, 0, 'remove exits 0');
  assert(settings && !('statusLine' in settings), 'statusLine removed (new path vintage)');
});

test('R3: remove deletes a statusLine written with the OLD path (basename match)', () => {
  const file = seed(mktmp(), {
    statusLine: { type: 'command', command: FROZEN_COMMAND, refreshInterval: 1 },
  });
  const { status, settings } = run(file, ['--remove']);
  assertEqual(status, 0, 'remove exits 0');
  assert(settings && !('statusLine' in settings),
    'statusLine removed (old path vintage) — the .includes(basename) predicate covers both');
});

test('R3: remove does NOT delete a foreign statusLine — the predicate is scoped', () => {
  const foreign = { type: 'command', command: 'node ~/my-own-statusline.js', refreshInterval: 5 };
  const file = seed(mktmp(), { statusLine: foreign });
  const { status, settings } = run(file, ['--remove']);
  assertEqual(status, 0, 'remove exits 0 with a foreign statusLine present');
  assert(settings && settings.statusLine
    && settings.statusLine.command === foreign.command,
  'a statusLine that is not ours survives --remove untouched');
});

// ── R4: idempotence ─────────────────────────────────────────────────────────

test('R4: enable twice is byte-identical and never duplicates hook entries', () => {
  const file = seed(mktmp(), {});
  run(file);
  const once = fs.readFileSync(file, 'utf8');
  const { status, settings } = run(file);
  assertEqual(status, 0, 'second enable exits 0');
  assertEqual(fs.readFileSync(file, 'utf8'), once, 'second enable changes nothing');
  const postAgent = (settings.hooks.PostToolUse || []).find((e) => e.matcher === 'Agent');
  assert(postAgent && postAgent.hooks.filter((h) => (h.command || '').includes('forge-hook.js')).length === 1,
    'exactly one forge hook per matcher entry after two enables');
});

// ── summary ─────────────────────────────────────────────────────────────────
cleanup();
console.log(`\nmerge-settings.test.js: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  FAILED: ${f.name} — ${f.error}`);
  process.exit(1);
}
