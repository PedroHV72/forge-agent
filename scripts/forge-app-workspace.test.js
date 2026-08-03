#!/usr/bin/env node
'use strict';

// forge-app-workspace.test.js — standing regression guard for the b992edf
// invariant (S04 T06).
//
// Commit b992edf deliberately removed the implicit `workspaces.first`
// fallback from the composer because it dispatched `/forge-auto` into the
// wrong repo indistinguishably from a correct dispatch — a wrong-repo
// dispatch and a correct one looked exactly the same to the operator. This
// suite pins that invariant permanently and cheaply:
//
//   1. No `.swift` file under app/Sources/ contains a real (non-comment)
//      `workspaces.first` reference — the fallback must never come back.
//   2. The prefs schema declares the two knobs that replaced it
//      (app.default_workspace, app.session_root_dir) with a string type, an
//      empty-string default and a non-empty description.
//   3. The pure resolver (WorkspaceDefaults.swift) exists and is actually
//      wired into the two view files and the store — so deleting the
//      resolver, or unplugging it, cannot pass silently.
//
// Unlike forge-app.test.js (which runs the Swift test suite and therefore
// skips off-darwin and on CI, because building SwiftTerm from cold is slow),
// this suite is pure file reading — no swift invocation — so it NEVER skips
// and runs on every platform, including CI.
//
// Zero deps, standalone runner (repo convention): exit != 0 on any failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSchema, readPrefs } = require('./forge-prefs.js');

const repoRoot = path.resolve(__dirname, '..');
const appSourcesDir = path.join(repoRoot, 'app', 'Sources');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n  ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log('\n=== forge app workspace defaults ===\n');

// Guard the whole suite on app/Sources/ existing — a missing app dir is a
// real problem in this repo, not a platform difference, so we fail loudly
// rather than skip like forge-app.test.js does for the Swift build.
if (!fs.existsSync(appSourcesDir)) {
  console.error(`✗ app/Sources/ not found at ${appSourcesDir} — this repo always has it; refusing to skip.`);
  process.exit(1);
}

function listSwiftFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSwiftFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.swift')) out.push(full);
  }
  return out;
}

// Strip `//` line comments before matching so that comment mentions that
// explain *why* the fallback is forbidden (there are legitimate ones, by
// design — e.g. WorkspaceDefaults.swift's own header, Stores.swift's two
// call-site comments, Views.swift's composer comment) do not false-positive
// the guard. Only a real code reference must fail the build.
function stripLineComments(line) {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

function findForbiddenPattern(files, pattern) {
  const hits = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (stripLineComments(line).includes(pattern)) {
        hits.push(`${path.relative(repoRoot, file)}:${i + 1}`);
      }
    });
  }
  return hits;
}

const swiftFiles = listSwiftFiles(appSourcesDir);

check('no real (non-comment) workspaces.first reference under app/Sources/', () => {
  const hits = findForbiddenPattern(swiftFiles, 'workspaces.first');
  assert(
    hits.length === 0,
    'forbidden `workspaces.first` reference found (b992edf: a wrong-repo dispatch is ' +
      'indistinguishable from a correct one — the fallback must never come back):\n' +
      hits.map(h => `    ${h}`).join('\n')
  );
});

check('guard actually bites — a real (non-comment) reference is detected', () => {
  // Prove the comment-stripping is not a blanket false-negative: a
  // synthetic in-memory line with a real (non-comment) occurrence must be
  // caught by the same matching logic used above.
  const fakeLine = '        let w = state.workspaces.first ?? ""';
  assert(stripLineComments(fakeLine).includes('workspaces.first'),
    'matcher failed to catch a real, non-comment workspaces.first reference');
  // And prove a comment-only mention is correctly ignored.
  const commentLine = '    // guess. `state.workspaces.first` is still never consulted here.';
  assert(!stripLineComments(commentLine).includes('workspaces.first'),
    'matcher incorrectly flagged a comment-only workspaces.first mention');
});

check('schema declares app.default_workspace (string, default "", described)', () => {
  const schema = loadSchema();
  const leaf = schema && schema.properties && schema.properties.app &&
    schema.properties.app.properties && schema.properties.app.properties.default_workspace;
  assert(leaf, 'forge-prefs.schema.json is missing properties.app.properties.default_workspace');
  assert(leaf.type === 'string', `default_workspace.type must be "string", got ${JSON.stringify(leaf.type)}`);
  assert(leaf.default === '', `default_workspace.default must be "", got ${JSON.stringify(leaf.default)}`);
  assert(typeof leaf.description === 'string' && leaf.description.length > 0,
    'default_workspace.description must be a non-empty string');
});

check('schema declares app.session_root_dir (string, default "", described)', () => {
  const schema = loadSchema();
  const leaf = schema && schema.properties && schema.properties.app &&
    schema.properties.app.properties && schema.properties.app.properties.session_root_dir;
  assert(leaf, 'forge-prefs.schema.json is missing properties.app.properties.session_root_dir');
  assert(leaf.type === 'string', `session_root_dir.type must be "string", got ${JSON.stringify(leaf.type)}`);
  assert(leaf.default === '', `session_root_dir.default must be "", got ${JSON.stringify(leaf.default)}`);
  assert(typeof leaf.description === 'string' && leaf.description.length > 0,
    'session_root_dir.description must be a non-empty string');
});

check('WorkspaceDefaults.swift exists and defines preselect + sessionRoot', () => {
  const resolverPath = path.join(appSourcesDir, 'ForgeKit', 'WorkspaceDefaults.swift');
  assert(fs.existsSync(resolverPath), `resolver not found at ${path.relative(repoRoot, resolverPath)}`);
  const src = fs.readFileSync(resolverPath, 'utf8');
  assert(src.includes('preselect'), 'WorkspaceDefaults.swift does not mention "preselect"');
  assert(src.includes('sessionRoot'), 'WorkspaceDefaults.swift does not mention "sessionRoot"');
});

check('the composer and the launcher consume the AppState preselection API', () => {
  // Both consumers moved when TerminalView.swift was split and the composer
  // was lifted out of Views.swift into a view both screens share. What this
  // guard is about is unchanged: the resolver must have a real reader, or a
  // configured default workspace silently stops preselecting anything.
  const composerPath = path.join(appSourcesDir, 'Forge', 'SessionComposer.swift');
  const launcherPath = path.join(appSourcesDir, 'Forge', 'TerminalLauncher.swift');
  assert(fs.existsSync(composerPath), `not found: ${path.relative(repoRoot, composerPath)}`);
  assert(fs.existsSync(launcherPath), `not found: ${path.relative(repoRoot, launcherPath)}`);
  const composerSrc = fs.readFileSync(composerPath, 'utf8');
  const launcherSrc = fs.readFileSync(launcherPath, 'utf8');
  assert(composerSrc.includes('preselection'),
    'SessionComposer.swift does not reference "preselection" — resolver may be unwired');
  assert(launcherSrc.includes('preselection'),
    'TerminalLauncher.swift does not reference "preselection" — resolver may be unwired');
});

// The other half of b992edf: the session root IS a sanctioned cwd — for a
// shell or a plain conversation. It must never become the cwd of a `/forge-*`
// dispatch, which is the exact class of wrong-repo dispatch that commit
// removed. The composer now falls back to the root, so the split has to be
// pinned where it lives.
check('the composer requires a project for slash commands, and only for those', () => {
  const composerPath = path.join(appSourcesDir, 'Forge', 'SessionComposer.swift');
  const src = fs.readFileSync(composerPath, 'utf8');

  assert(/private var needsProject: Bool/.test(src),
    'SessionComposer lost `needsProject` — without it either every session demands a '
    + 'project (no root-dir shell) or none does (a /forge-* dispatch into the root)');
  assert(/ComposerParser\.split\(text\)\.command != nil/.test(src),
    '`needsProject` no longer keys on there being a slash command — that predicate IS '
    + 'the b992edf boundary');
  assert(/if needsProject && resolvedProject\.isEmpty \{ return false \}/.test(src),
    'canSubmit stopped refusing a slash command with no project — b992edf');
  assert(/resolvedProject\.isEmpty \? state\.resolvedSessionRoot : resolvedProject/.test(src),
    'the project-less cwd is no longer `resolvedSessionRoot` — the only sanctioned '
    + 'non-project directory');
  assert(/if !resolvedProject\.isEmpty \{ state\.rememberWorkspace/.test(src),
    'rememberWorkspace is no longer guarded — writing the session root as the '
    + 'last-used workspace makes the fallback directory masquerade as a chosen project '
    + 'and preselects it from then on');
});

check('Stores.swift references WorkspaceDefaults', () => {
  const storesPath = path.join(appSourcesDir, 'Forge', 'Stores.swift');
  assert(fs.existsSync(storesPath), `not found: ${path.relative(repoRoot, storesPath)}`);
  const src = fs.readFileSync(storesPath, 'utf8');
  assert(src.includes('WorkspaceDefaults'), 'Stores.swift does not reference WorkspaceDefaults — resolver may be unwired');
});

// R3 fix (S04 review): `app.*` prefs (default_workspace, session_root_dir) are
// per-operator, never per-project — `readPrefs(cwd, { globalOnly: true })`
// must resolve strictly from the global layer even when a project-local
// .gsd/ carries a CONFLICTING value for the same key.
check('Stores.swift resolves app.* prefs with --global-only', () => {
  const storesPath = path.join(appSourcesDir, 'Forge', 'Stores.swift');
  const src = fs.readFileSync(storesPath, 'utf8');
  assert(src.includes('--global-only'),
    'Stores.swift loadAppDefaults() does not pass --global-only — a project-local .gsd/ ' +
    'could silently override the operator-wide default_workspace/session_root_dir');
});

check('readPrefs({ globalOnly: true }) ignores a conflicting local layer', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-global-only-'));
  const globalDir = path.join(scratch, 'claude');
  const projectDir = path.join(scratch, 'project');
  const localDir = path.join(projectDir, '.gsd');
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(localDir, { recursive: true });

  fs.writeFileSync(
    path.join(globalDir, 'forge-agent-prefs.jsonc'),
    JSON.stringify({ app: { default_workspace: '/global/repo', session_root_dir: '/global/root' } })
  );
  fs.writeFileSync(
    path.join(localDir, 'forge-prefs.jsonc'),
    JSON.stringify({ app: { default_workspace: '/local/repo', session_root_dir: '/local/root' } })
  );

  const opts = { globalDir, localDir };

  const merged = readPrefs(projectDir, opts);
  assert(merged.prefs.app.default_workspace === '/local/repo',
    'sanity check failed: without globalOnly the local layer should still win');

  const globalOnly = readPrefs(projectDir, { ...opts, globalOnly: true });
  assert(globalOnly.prefs.app.default_workspace === '/global/repo',
    `globalOnly must resolve app.default_workspace from the global layer alone, got ${JSON.stringify(globalOnly.prefs.app)}`);
  assert(globalOnly.prefs.app.session_root_dir === '/global/root',
    `globalOnly must resolve app.session_root_dir from the global layer alone, got ${JSON.stringify(globalOnly.prefs.app)}`);
  assert(globalOnly.layers.local.source === 'absent',
    `globalOnly must report the local layer as absent, got ${JSON.stringify(globalOnly.layers.local)}`);

  fs.rmSync(scratch, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
