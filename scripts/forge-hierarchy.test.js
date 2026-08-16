#!/usr/bin/env node
'use strict';

// forge-hierarchy.test.js — the position axis: `role`, transitive
// containment, and the CLI reporting `workspace` for a directory that
// contains other registered directories.
//
// `role` is deliberately not `kind`. `classify().kind` is `project|touched|
// none` (substance, pinned by the JS<->Swift parity guard in
// forge-app-workspace-marker.test.js) and the registry's own `kind` is
// `project|workspace` (position, but only two states). `role` adds the third
// state a registered *and* an unregistered directory both need — `folder`,
// a synthesised display node with the negative property that defines it:
// never registrable, never launchable, never a card.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  ROLE_KINDS,
  REGISTRABLE_ROLES,
  containmentCounts,
  resolveRole,
  REGISTRY_FILENAME,
  encodeEntryPath,
  writeRegistry,
} = require('./forge-workspace.js');

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

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
  }
}

const tmpRoots = [];
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `forge-hierarchy-${prefix}-`));
  tmpRoots.push(d);
  return d;
}
function cleanup() {
  for (const d of tmpRoots) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Fixture-path lens. The code under test canonicalises every path through
// `path.resolve` (containmentCounts keys, resolveRole/deriveEntryKind's
// `self`), and on Windows `path.resolve('/a')` anchors on the current drive
// (`D:\a` on the CI runner) — so a POSIX literal used as an object key or
// compared byte-for-byte only matches on POSIX, where resolve is the
// identity. Passing fixtures through the same lens proves the same thing on
// both platforms.
const P = (s) => path.resolve(s);

// ── Constants ───────────────────────────────────────────────────────────────

console.log('\nROLE_KINDS / REGISTRABLE_ROLES');

test('ROLE_KINDS contém folder', () => {
  assert(ROLE_KINDS.includes('folder'), 'folder ausente de ROLE_KINDS');
  assert(ROLE_KINDS.includes('workspace'), 'workspace ausente de ROLE_KINDS');
  assert(ROLE_KINDS.includes('project'), 'project ausente de ROLE_KINDS');
});

test('REGISTRABLE_ROLES não contém folder', () => {
  assert(!REGISTRABLE_ROLES.includes('folder'), 'folder não pode ser registrável');
  assert(REGISTRABLE_ROLES.includes('workspace'), 'workspace deve ser registrável');
  assert(REGISTRABLE_ROLES.includes('project'), 'project deve ser registrável');
});

// ── containmentCounts: transitividade, guarda de separador, ordem ──────────

console.log('\ncontainmentCounts');

test('transitividade: avô conta o neto', () => {
  // Lookup keys go through P too: containmentCounts keys its result by the
  // RESOLVED path, so `counts['/a']` is undefined on Windows (real key: D:\a).
  const counts = containmentCounts([P('/a'), P('/a/b'), P('/a/b/c')]);
  assertEq(counts[P('/a')], 2, 'avô conta filho e neto');
  assertEq(counts[P('/a/b')], 1, 'pai conta só o filho direto');
  assertEq(counts[P('/a/b/c')], 0, 'folha não conta ninguém');
});

test('guarda de separador: prefixo de string comum não conta', () => {
  const counts = containmentCounts([P('/a/Dev'), P('/a/Development')]);
  assertEq(counts[P('/a/Dev')], 0, '/a/Dev não contém /a/Development (mero prefixo de string)');
  assertEq(counts[P('/a/Development')], 0, 'nem o inverso');
});

test('independência de ordem', () => {
  const list = ['/a', '/a/b', '/a/b/c', '/a/x'];
  const reversed = list.slice().reverse();
  const sortEntries = (obj) => JSON.stringify(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
  assertEq(
    sortEntries(containmentCounts(list)),
    sortEntries(containmentCounts(reversed)),
    'contagem depende da ordem de entrada'
  );
});

// ── resolveRole: os quatro casos, classifyFn injetado, zero disco ──────────

console.log('\nresolveRole (classifyFn puro, sem disco)');

// The maps handed to pureClassify must be keyed by the RESOLVED spelling:
// resolveRole calls classifyFn with `path.resolve(absPath)`, so on Windows a
// map keyed '/a' misses (`D:\a` arrives), the miss degrades to 'none' and the
// role silently downgrades — the drive-anchoring trap again.
function pureClassify(map) {
  return (dir) => ({ kind: map[dir] || 'none', signals: [], entries: [] });
}

test('workspace: projeto que contém outro ativo em qualquer profundidade', () => {
  const cls = pureClassify({ [P('/a')]: 'project', [P('/a/b/c')]: 'project' });
  assertEq(resolveRole(P('/a'), [P('/a'), P('/a/b/c')], cls), 'workspace', 'avô-projeto com neto ativo');
});

test('project: projeto folha, sem descendente ativo', () => {
  const cls = pureClassify({ [P('/a/b/c')]: 'project' });
  assertEq(resolveRole(P('/a/b/c'), [P('/a/b/c')], cls), 'project', 'folha sem filhos ativos');
});

test('folder: não-projeto ancestral estrito de pelo menos um ativo', () => {
  const cls = pureClassify({ [P('/a')]: 'none', [P('/a/b/c')]: 'project' });
  assertEq(resolveRole(P('/a'), [P('/a/b/c')], cls), 'folder', 'diretório neutro ancestral de um ativo');
});

test('folder: caso decisivo — touched com ativo abaixo é folder, não workspace (forma de lookchina/services)', () => {
  const cls = pureClassify({ [P('/lookchina/services')]: 'touched', [P('/lookchina/services/freyr')]: 'project' });
  assertEq(
    resolveRole(P('/lookchina/services'), [P('/lookchina/services'), P('/lookchina/services/freyr')], cls),
    'folder',
    'touched com filho ativo não é workspace'
  );
});

test('null: resto — não-projeto sem nenhum descendente ativo', () => {
  const cls = pureClassify({ [P('/a/x')]: 'none' });
  assertEq(resolveRole(P('/a/x'), [P('/a/b/c')], cls), null, 'diretório sem relação com nenhum ativo');
});

// ── CLI end-to-end contra um registry-fixture ───────────────────────────────

console.log('\nCLI --json reportando role');

const CLI = path.join(__dirname, 'forge-workspace.js');

function mkProject(dir) {
  fs.mkdirSync(path.join(dir, '.gsd', 'milestones'), { recursive: true });
  return dir;
}

function runCli(home, file, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--home', home, '--file', file], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function buildFixture(prefix) {
  const home = mkTmp(prefix + '-home');
  const workRoot = mkTmp(prefix + '-work');
  // A workspace root with members in apps/ and services/ — the lookchina shape.
  const root = path.join(workRoot, 'lookchina');
  const appsMember = path.join(root, 'apps', 'odin');
  const servicesMember = path.join(root, 'services', 'freyr');
  const sibling = path.join(workRoot, 'sibling-with-no-active-descendant');

  mkProject(root);
  mkProject(appsMember);
  mkProject(servicesMember);
  fs.mkdirSync(sibling, { recursive: true });

  // Reuse the codec — do not hand-write the on-disk shape (T02-PLAN §6).
  // The root itself cannot be "under" a root (isStrictlyUnder(self, self) is
  // false), so it round-trips rootless (root: null), same as any path outside
  // every declared root; the two members round-trip root-relative.
  const roots = [{ path: root, primary: true }];
  const encRoot = encodeEntryPath(root, roots, home);
  const encApps = encodeEntryPath(appsMember, roots, home);
  const encServices = encodeEntryPath(servicesMember, roots, home);

  const registry = {
    version: 1,
    roots,
    entries: [
      { path: encRoot.path, root: encRoot.root, kind: null, repos: [] },
      { path: encApps.path, root: encApps.root, kind: null, repos: [] },
      { path: encServices.path, root: encServices.root, kind: null, repos: [] },
    ],
    quarantine: [],
  };
  const file = path.join(home, '.claude', REGISTRY_FILENAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeRegistry(file, registry);

  return { home, file, root, appsMember, servicesMember, appsDir: path.join(root, 'apps'), sibling };
}

test('registry-fixture forma do lookchina: raiz é workspace, membro é project, intermediário sem .gsd/ é folder', () => {
  const fx = buildFixture('lookchina');

  const rootRes = runCli(fx.home, fx.file, [fx.root, '--json']);
  assertEq(JSON.parse(rootRes.out).role, 'workspace', `raiz devia ser workspace: ${rootRes.out}`);

  const memberRes = runCli(fx.home, fx.file, [fx.appsMember, '--json']);
  assertEq(JSON.parse(memberRes.out).role, 'project', `membro devia ser project: ${memberRes.out}`);

  const intermediateRes = runCli(fx.home, fx.file, [fx.appsDir, '--json']);
  assertEq(JSON.parse(intermediateRes.out).role, 'folder', `apps/ devia ser folder: ${intermediateRes.out}`);

  const siblingRes = runCli(fx.home, fx.file, [fx.sibling, '--json']);
  assertEq(JSON.parse(siblingRes.out).role, null, `irmão sem ativo abaixo devia ser null: ${siblingRes.out}`);
});

test('kind permanece intocado no --json (project|touched|none)', () => {
  const fx = buildFixture('kind-intact');
  const rootRes = JSON.parse(runCli(fx.home, fx.file, [fx.root, '--json']).out);
  assert(['project', 'touched', 'none'].includes(rootRes.kind), `kind fora do vocabulário: ${rootRes.kind}`);
  assertEq(rootRes.kind, 'project', 'raiz da fixture tem .gsd/milestones');
});

test('coluna role aparece na saída não-json', () => {
  const fx = buildFixture('non-json');
  const rootRes = runCli(fx.home, fx.file, [fx.root]);
  assert(rootRes.out.includes('workspace'), `saída não-json sem a coluna role: ${rootRes.out}`);
});

test('CLI sem registry legível: role é null, processo não lança', () => {
  const home = mkTmp('no-registry-home');
  const target = mkTmp('no-registry-target');
  const missingFile = path.join(home, '.claude', REGISTRY_FILENAME);

  const r = runCli(home, missingFile, [target, '--json']);
  assert(r.code === 0 || r.code === 1, `CLI não devia crashar (código ${r.code}): ${r.err}`);
  assert(!/at\s+\S+\.js:\d+/.test(r.err), `stderr parece um stack trace não tratado: ${r.err}`);
  const parsed = JSON.parse(r.out);
  assertEq(parsed.role, null, 'sem registry legível, role deve ser null');
});

// ── deriveEntryKind não regride (a suíte irmã já o cobre; smoke aqui) ───────

console.log('\nsmoke: deriveEntryKind ainda exportado e coerente com resolveRole');

test('deriveEntryKind e resolveRole concordam quando self é projeto', () => {
  const { deriveEntryKind } = require('./forge-workspace.js');
  // Same lens as above: both functions classify the resolved self.
  const cls = pureClassify({ [P('/a')]: 'project', [P('/a/b')]: 'project' });
  assertEq(deriveEntryKind(P('/a'), [P('/a'), P('/a/b')], cls), 'workspace');
  assertEq(resolveRole(P('/a'), [P('/a'), P('/a/b')], cls), 'workspace');
});

// ── Report ────────────────────────────────────────────────────────────────

cleanup();

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
