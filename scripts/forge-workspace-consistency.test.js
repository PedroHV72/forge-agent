#!/usr/bin/env node
'use strict';

// forge-workspace-consistency.test.js — proves the guard D3 requires: the
// three named divergence classes, `compareSources` purity, absence-of-marker
// never masquerading as divergence, unreadable-marker distinct from
// divergence, exit 0 under divergence (asserted, not assumed), and the
// `forge-doctor` wiring.
//
// Every fixture lives in a tmpdir with a SYNTHETIC $HOME. Nothing here reads
// or writes the operator's real `~/.claude/forge-gate-workspaces.json`, and
// no marker fixture is ever written into a real working tree.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  compareSources,
  auditWorkspaces,
} = require('./forge-workspace-consistency.js');

const { writeMarker } = require('./forge-marker.js');

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
  const comparable = (value) => {
    if (typeof value !== 'string' || !(/^[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value))) return value;
    return path.resolve(value).toLowerCase();
  };
  if (comparable(actual) !== comparable(expected)) {
    throw new Error(`${msg || 'mismatch'}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
  }
}

const tmps = [];

function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-wsc-'));
  tmps.push(d);
  return fs.realpathSync(d);
}

function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function mkdirs(...dirs) {
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

function writeRegistry(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    roots: [],
    entries,
    quarantine: [],
  }, null, 2));
}

function run(args, opts) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', ...opts });
}

// ── R1: compareSources — pure, and the three named diff classes ─────────────

console.log('R1 — compareSources: pureza e as três classes de divergência');

test('compareSources é pura — corpo não contém `fs.`', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-workspace-consistency.js'), 'utf8');
  const fnStart = src.indexOf('function compareSources(');
  assert(fnStart >= 0, 'compareSources não encontrada no arquivo');
  // Find the matching closing brace by simple depth count from the first `{`.
  const braceStart = src.indexOf('{', fnStart);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(braceStart, i + 1);
  assert(!/\bfs\./.test(body), `compareSources contém referência a fs.* — não é pura:\n${body}`);
});

test('mesmo nome, mesmo caminho → ok, diffs: []', () => {
  const r = compareSources({
    workspace: '/ws',
    registryRepos: [{ name: 'freyr', path: '/ws/services/freyr' }],
    markerRepos: [{ name: 'freyr', path: '/ws/services/freyr' }],
  });
  assertEqual(r.ok, true, 'ok');
  assertEqual(r.diffs.length, 0, 'diffs');
});

test('repo só no registry → missing-in-marker', () => {
  const r = compareSources({
    workspace: '/ws',
    registryRepos: [{ name: 'freyr', path: '/ws/services/freyr' }],
    markerRepos: [],
  });
  assertEqual(r.ok, false, 'ok');
  assertEqual(r.diffs.length, 1, 'diffs.length');
  assertEqual(r.diffs[0].kind, 'missing-in-marker', 'kind');
  assertEqual(r.diffs[0].name, 'freyr', 'name');
  assertEqual(r.diffs[0].registry_path, '/ws/services/freyr', 'registry_path');
  assertEqual(r.diffs[0].marker_path, null, 'marker_path');
});

test('repo só no marcador → missing-in-registry', () => {
  const r = compareSources({
    workspace: '/ws',
    registryRepos: [],
    markerRepos: [{ name: 'ghost', path: '/ws/ghost' }],
  });
  assertEqual(r.ok, false, 'ok');
  assertEqual(r.diffs[0].kind, 'missing-in-registry', 'kind');
  assertEqual(r.diffs[0].registry_path, null, 'registry_path');
  assertEqual(r.diffs[0].marker_path, '/ws/ghost', 'marker_path');
});

test('mesmo nome, caminhos diferentes → path-mismatch', () => {
  const r = compareSources({
    workspace: '/ws',
    registryRepos: [{ name: 'freyr', path: '/ws/services/freyr' }],
    markerRepos: [{ name: 'freyr', path: '/ws/other/freyr' }],
  });
  assertEqual(r.ok, false, 'ok');
  assertEqual(r.diffs[0].kind, 'path-mismatch', 'kind');
  assertEqual(r.diffs[0].registry_path, '/ws/services/freyr', 'registry_path');
  assertEqual(r.diffs[0].marker_path, '/ws/other/freyr', 'marker_path');
});

test('fontes vazias → ok, diffs: []', () => {
  const r = compareSources({ workspace: '/ws', registryRepos: [], markerRepos: [] });
  assertEqual(r.ok, true, 'ok');
  assertEqual(r.diffs.length, 0, 'diffs');
});

test('basename duplicado (apps/norns e services/norns) em ambos os lados, idênticos → ok — não pode colapsar num Map name->path', () => {
  // The exact collision `forge-repo-index.js`'s own doc comment cites as
  // real on the operator's disk. Both sides carry BOTH `norns` repos, at
  // matching paths — a name->path `Map` (the pre-fix shape) would silently
  // let the second row win on each side, comparing whatever survived, which
  // happened to still be clean here. This is the control case for the next
  // one, where the two sides diverge on which `norns` survives.
  const r = compareSources({
    workspace: '/ws',
    registryRepos: [
      { name: 'norns', path: '/ws/apps/norns' },
      { name: 'norns', path: '/ws/services/norns' },
    ],
    markerRepos: [
      { name: 'norns', path: '/ws/apps/norns' },
      { name: 'norns', path: '/ws/services/norns' },
    ],
  });
  assertEqual(r.ok, true, 'ok — os dois pares de norns batem');
  assertEqual(r.diffs.length, 0, 'diffs');
});

test('basename duplicado — marcador tem só UM dos dois "norns" → diverge (Map name->path colapsava e comparava CLEAN)', () => {
  // The bite: the registry has both `apps/norns` and `services/norns`; the
  // marker dropped `services/norns` entirely (has only `apps/norns`). A
  // name->path Map keyed purely by "norns" lets the marker's single row
  // overwrite/compare against whichever registry row survived the same
  // collapse — if both collapse to the SAME path (`apps/norns`, first row in
  // insertion order on both sides) the old implementation reported `ok`,
  // hiding that `services/norns` silently vanished from the marker.
  const r = compareSources({
    workspace: '/ws',
    registryRepos: [
      { name: 'norns', path: '/ws/apps/norns' },
      { name: 'norns', path: '/ws/services/norns' },
    ],
    markerRepos: [
      { name: 'norns', path: '/ws/apps/norns' },
    ],
  });
  assertEqual(r.ok, false, 'a ausência de services/norns no marcador deve ser detectada');
  assertEqual(r.diffs.length, 1, 'diffs.length');
  assertEqual(r.diffs[0].name, 'norns', 'name');
  assertEqual(r.diffs[0].kind, 'missing-in-marker', 'kind');
  assertEqual(r.diffs[0].registry_path, '/ws/services/norns', 'o path ausente deve ser o segundo, não um path inventado');
  assertEqual(r.diffs[0].marker_path, null, 'marker_path');
});

test('basename duplicado — mesmos dois nomes, um par com caminho diferente → path-mismatch aponta o par certo', () => {
  const r = compareSources({
    workspace: '/ws',
    registryRepos: [
      { name: 'norns', path: '/ws/apps/norns' },
      { name: 'norns', path: '/ws/services/norns' },
    ],
    markerRepos: [
      { name: 'norns', path: '/ws/apps/norns' },
      { name: 'norns', path: '/ws/services/norns-renamed' },
    ],
  });
  assertEqual(r.ok, false, 'ok');
  assertEqual(r.diffs.length, 1, 'diffs.length — o par idêntico não deve gerar ruído');
  assertEqual(r.diffs[0].name, 'norns', 'name');
  assertEqual(r.diffs[0].kind, 'path-mismatch', 'kind');
  assertEqual(r.diffs[0].registry_path, '/ws/services/norns', 'registry_path');
  assertEqual(r.diffs[0].marker_path, '/ws/services/norns-renamed', 'marker_path');
});

// ── R2: auditWorkspaces — fixtures de disco ──────────────────────────────────

console.log('\nR2 — auditWorkspaces');

function makeFixture() {
  const root = mktmp('forge-wsc-fixture-');
  const home = path.join(root, 'home');
  const ws = path.join(root, 'lookchina');
  const freyrReal = path.join(ws, 'services', 'freyr');
  mkdirs(home, freyrReal);

  const registryFile = path.join(home, '.claude', 'forge-gate-workspaces.json');
  writeRegistry(registryFile, [
    { path: ws, root: null, kind: 'workspace', repos: ['services/freyr'] },
  ]);

  return { root, home, registryFile, ws, freyrReal };
}

test('workspace sem marcador → no-marker, diffs: [] (NUNCA divergência)', () => {
  const f = makeFixture();
  const r = auditWorkspaces({ home: f.home, registryFile: f.registryFile, cwd: f.ws });
  assertEqual(r.workspaces.length, 1, 'workspaces.length');
  assertEqual(r.workspaces[0].status, 'no-marker', 'status');
  assertEqual(r.workspaces[0].diffs.length, 0, 'diffs.length — sem marcador nunca é divergência');
});

test('marcador idêntico ao registry → ok', () => {
  const f = makeFixture();
  writeMarker(f.ws, { kind: 'workspace', name: 'lookchina', repos: [{ name: 'freyr', path: 'services/freyr' }] });
  const r = auditWorkspaces({ home: f.home, registryFile: f.registryFile, cwd: f.ws });
  assertEqual(r.workspaces[0].status, 'ok', 'status');
  assertEqual(r.workspaces[0].diffs.length, 0, 'diffs');
});

test('marcador discordante → divergent, path-mismatch nomeando os dois caminhos', () => {
  const f = makeFixture();
  writeMarker(f.ws, { kind: 'workspace', name: 'lookchina', repos: [{ name: 'freyr', path: 'other/freyr' }] });
  const r = auditWorkspaces({ home: f.home, registryFile: f.registryFile, cwd: f.ws });
  assertEqual(r.workspaces[0].status, 'divergent', 'status');
  assertEqual(r.workspaces[0].diffs.length, 1, 'diffs.length');
  assertEqual(r.workspaces[0].diffs[0].kind, 'path-mismatch', 'kind');
  assertEqual(r.workspaces[0].diffs[0].registry_path, f.freyrReal, 'registry_path');
  assertEqual(r.workspaces[0].diffs[0].marker_path, path.join(f.ws, 'other', 'freyr'), 'marker_path');
});

test('marcador ilegível (JSON quebrado) → marker-unreadable, distinto de divergent, nomeia o arquivo', () => {
  const f = makeFixture();
  fs.writeFileSync(path.join(f.ws, 'forge-workspace.jsonc'), '{ not valid json');
  const r = auditWorkspaces({ home: f.home, registryFile: f.registryFile, cwd: f.ws });
  assertEqual(r.workspaces[0].status, 'marker-unreadable', 'status');
  assert(typeof r.workspaces[0].error === 'string' && r.workspaces[0].error.length > 0, 'error deve existir');
  assert(r.workspaces[0].file.includes('forge-workspace.jsonc'), 'file deve nomear o marcador');
});

test('marcador é procurado só dentro do próprio diretório do workspace — não walk-up', () => {
  // Marker sitting in an ANCESTOR of the workspace must NOT be picked up —
  // that would answer "who governs this cwd", not "does this workspace have
  // its own marker".
  const root = mktmp('forge-wsc-nowalkup-');
  const home = path.join(root, 'home');
  const parent = path.join(root, 'parent');
  const ws = path.join(parent, 'lookchina');
  const freyrReal = path.join(ws, 'services', 'freyr');
  mkdirs(home, freyrReal);
  writeMarker(parent, { kind: 'workspace', name: 'parent', repos: [{ name: 'freyr', path: 'lookchina/services/freyr' }] });

  const registryFile = path.join(home, '.claude', 'forge-gate-workspaces.json');
  writeRegistry(registryFile, [
    { path: ws, root: null, kind: 'workspace', repos: ['services/freyr'] },
  ]);

  const r = auditWorkspaces({ home, registryFile, cwd: ws });
  assertEqual(r.workspaces[0].status, 'no-marker', 'status — o marcador do PAI não conta como marcador do workspace');
});

// ── R3: exit 0 sob divergência (CLI, spawn) ──────────────────────────────────

console.log('\nR3 — CLI: exit 0 sempre, inclusive sob divergência');

test('CLI --check sob divergência sai com exit 0 e reporta diffs', () => {
  const f = makeFixture();
  writeMarker(f.ws, { kind: 'workspace', name: 'lookchina', repos: [{ name: 'freyr', path: 'other/freyr' }] });
  const res = run([
    path.join(__dirname, 'forge-workspace-consistency.js'),
    '--check', '--json', '--home', f.home, '--file', f.registryFile, '--cwd', f.ws,
  ]);
  assertEqual(res.status, 0, `exit code deveria ser 0 mesmo sob divergência (advisory, D3); stderr: ${res.stderr}`);
  const data = JSON.parse(res.stdout);
  assertEqual(data.workspaces[0].status, 'divergent', 'status no JSON');
  assert(data.workspaces[0].diffs.length > 0, 'diffs deve ser não-vazio');
});

test('CLI --check sem divergência (marcador ausente) também sai 0', () => {
  const f = makeFixture();
  const res = run([
    path.join(__dirname, 'forge-workspace-consistency.js'),
    '--check', '--json', '--home', f.home, '--file', f.registryFile, '--cwd', f.ws,
  ]);
  assertEqual(res.status, 0, 'exit code');
  const data = JSON.parse(res.stdout);
  assertEqual(data.workspaces[0].status, 'no-marker', 'status');
});

test('saída humana nomeia repo e os dois caminhos numa divergência', () => {
  const f = makeFixture();
  writeMarker(f.ws, { kind: 'workspace', name: 'lookchina', repos: [{ name: 'freyr', path: 'other/freyr' }] });
  const res = run([
    path.join(__dirname, 'forge-workspace-consistency.js'),
    '--check', '--home', f.home, '--file', f.registryFile, '--cwd', f.ws,
  ]);
  assertEqual(res.status, 0, 'exit code');
  assert(res.stdout.includes('freyr'), 'saída deve nomear o repo');
  const output = res.stdout.replace(/[\\/]/g, path.sep).toLowerCase();
  assert(output.includes(path.normalize(f.freyrReal).toLowerCase()), 'saída deve conter o caminho do registry');
  assert(output.includes(path.normalize(path.join(f.ws, 'other', 'freyr')).toLowerCase()), 'saída deve conter o caminho do marcador');
});

// ── R4: forge-doctor wiring ───────────────────────────────────────────────

console.log('\nR4 — forge-doctor: workspace-consistency wired, advisory, exit 0');

test('forge-doctor.js exporta checkWorkspaceConsistency e lista workspace-consistency em VALID_CHECKS', () => {
  const doctor = require('./forge-doctor.js');
  assert(typeof doctor.checkWorkspaceConsistency === 'function', 'checkWorkspaceConsistency deve ser função');
  assert(doctor.VALID_CHECKS.includes('workspace-consistency'), 'VALID_CHECKS deve incluir workspace-consistency');
});

test('node forge-doctor.js --check workspace-consistency roda e aparece na saída', () => {
  const cwd = mktmp('forge-wsc-doctor-cwd-');
  mkdirs(path.join(cwd, '.gsd'));
  const res = run([path.join(__dirname, 'forge-doctor.js'), '--check', 'workspace-consistency', '--cwd', cwd], {
    env: { ...process.env, HOME: mktmp('forge-wsc-doctor-home-') },
  });
  assert(res.stdout.includes('Workspace registry') || res.stdout.includes('workspace-consistency'),
    `saída deve mencionar o check: ${res.stdout}`);
});

test('node forge-doctor.js --check all inclui o guard e não falha por causa de divergência', () => {
  const f = makeFixture();
  writeMarker(f.ws, { kind: 'workspace', name: 'lookchina', repos: [{ name: 'freyr', path: 'other/freyr' }] });

  // Point forge-doctor's HOME at the fixture home so checkWorkspaceConsistency
  // (which reads process.env.HOME internally, matching forge-marker.js's own
  // CLI convention) picks up the divergent fixture instead of the operator's
  // real registry.
  // Stamp SCHEMA-VERSION so the unrelated `schema` check passes — this test's
  // job is isolating whether the DIVERGENCE flips `--check all`'s exit code,
  // not re-proving the schema check's own behavior.
  const { CURRENT_SCHEMA } = require('./forge-doctor.js');
  const cwd = mktmp('forge-wsc-doctor-all-cwd-');
  mkdirs(path.join(cwd, '.gsd'));
  fs.writeFileSync(path.join(cwd, '.gsd', 'SCHEMA-VERSION'), CURRENT_SCHEMA);
  const res = run([path.join(__dirname, 'forge-doctor.js'), '--check', 'all', '--cwd', cwd], {
    env: { ...process.env, HOME: f.home },
  });
  assertEqual(res.status, 0, `--check all não deveria falhar por causa de divergência advisory; stdout: ${res.stdout} stderr: ${res.stderr}`);
});

// ── R5: zero escrita ─────────────────────────────────────────────────────

console.log('\nR5 — o guard nunca escreve');

test('auditWorkspaces não altera o mtime do registry nem do marcador', () => {
  const f = makeFixture();
  writeMarker(f.ws, { kind: 'workspace', name: 'lookchina', repos: [{ name: 'freyr', path: 'other/freyr' }] });
  const markerFile = path.join(f.ws, 'forge-workspace.jsonc');
  const beforeReg = fs.statSync(f.registryFile).mtimeMs;
  const beforeMarker = fs.statSync(markerFile).mtimeMs;

  auditWorkspaces({ home: f.home, registryFile: f.registryFile, cwd: f.ws });

  assertEqual(fs.statSync(f.registryFile).mtimeMs, beforeReg, 'registry mtime não deveria mudar');
  assertEqual(fs.statSync(markerFile).mtimeMs, beforeMarker, 'marker mtime não deveria mudar');
});

// ── Cleanup + report ────────────────────────────────────────────────────────

cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
