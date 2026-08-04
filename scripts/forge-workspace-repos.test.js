#!/usr/bin/env node
'use strict';

// forge-workspace-repos.test.js — bounded-depth repo discovery per workspace,
// and the `--sync-repos` CLI that turns it into the registry's `repos[]`.
//
// This suite exists because a number was measured, not assumed: today every
// one of the 14 live registry entries carries `repos: []` — the field S01
// created and nothing ever populated — and `forge-repos.discoverRepos`
// (unrelated, untouched by this file) walks one level deep, so
// `lookchina/services/freyr` was never reachable from it. That is the
// mechanical second fault behind TASK-021's `sidecar-code-dir-undeclared`.
//
// `discoverWorkspaceRepos`/`syncWorkspaceRepos` do not widen isolation — they
// give `repos[]` real content as an addressing index. Nothing here asserts a
// literal repo count borrowed from planning prose; every count below is
// derived from what the fixture actually contains.
//
// Fixtures live in mkdtemp under a synthetic $HOME. The real
// `~/.claude/forge-gate-workspaces.json` is never read or written by this
// suite — that is the one thing this task must not do.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  REGISTRY_FILENAME,
  registryPath,
  loadRegistry,
  writeRegistry,
  REPO_SCAN_MAX_DEPTH,
  REPO_SCAN_SKIP_DIRS,
  discoverWorkspaceRepos,
  syncWorkspaceRepos,
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `forge-wsrepos-${prefix}-`));
  tmpRoots.push(d);
  return d;
}
function cleanup() {
  for (const d of tmpRoots) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** A directory that classifies as a Forge project (work artifact present). */
function mkProject(dir) {
  fs.mkdirSync(path.join(dir, '.gsd', 'milestones'), { recursive: true });
  return dir;
}

/** A `.git` *directory* — the ordinary "this is a repo root" marker. */
function mkGitDir(dir) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

/** A `.git` *file* — the worktree-pointer shape, must count exactly like a dir. */
function mkGitFile(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  return dir;
}

// ── discoverWorkspaceRepos: constants ────────────────────────────────────────

console.log('\nrepo scan constants');

test('REPO_SCAN_SKIP_DIRS cobre node_modules/.git/.forge-worktrees/.gsd', () => {
  assert(REPO_SCAN_SKIP_DIRS.has('node_modules'), 'node_modules ausente');
  assert(REPO_SCAN_SKIP_DIRS.has('.git'), '.git ausente');
  assert(REPO_SCAN_SKIP_DIRS.has('.forge-worktrees'), '.forge-worktrees ausente');
  assert(REPO_SCAN_SKIP_DIRS.has('.gsd'), '.gsd ausente');
});

test('REPO_SCAN_MAX_DEPTH alcança profundidade 2 com folga', () => {
  assert(typeof REPO_SCAN_MAX_DEPTH === 'number' && REPO_SCAN_MAX_DEPTH >= 3,
    `esperado >= 3 para alcançar services/freyr (profundidade 2) com folga, veio ${REPO_SCAN_MAX_DEPTH}`);
});

// ── discoverWorkspaceRepos: the TASK-021 shape ───────────────────────────────

console.log('\ndiscoverWorkspaceRepos — a dois níveis, com engodos e poda');

test('encontra repo a DOIS níveis (services/freyr) — a profundidade que forge-repos.discoverRepos não alcança', () => {
  const ws = mkTmp('depth2');
  mkGitDir(path.join(ws, 'services', 'freyr'));

  const found = discoverWorkspaceRepos(ws);
  assert(found.includes('services/freyr'), `esperado "services/freyr" em ${JSON.stringify(found)}`);
});

test('.git como ARQUIVO (worktree pointer) conta igual a .git como diretório', () => {
  const ws = mkTmp('gitfile');
  mkGitFile(path.join(ws, 'apps', 'odin'));

  const found = discoverWorkspaceRepos(ws);
  assertEq(found.length, 1, 'exatamente um repo encontrado');
  assertEq(found[0], 'apps/odin', 'caminho relativo');
});

test('node_modules NUNCA é descido', () => {
  const ws = mkTmp('nodemodules');
  mkGitDir(path.join(ws, 'node_modules', 'algum-pacote'));
  mkGitDir(path.join(ws, 'services', 'freyr')); // control: this one must still be found

  const found = discoverWorkspaceRepos(ws);
  assert(!found.some(r => r.includes('node_modules')), `node_modules vazou: ${JSON.stringify(found)}`);
  assert(found.includes('services/freyr'), 'o repo de controle desapareceu junto — engodo quebrou algo além do esperado');
});

test('diretório oculto NUNCA é descido', () => {
  const ws = mkTmp('hidden');
  mkGitDir(path.join(ws, '.oculto', 'repo'));
  mkGitDir(path.join(ws, 'services', 'freyr'));

  const found = discoverWorkspaceRepos(ws);
  assert(!found.some(r => r.includes('.oculto')), `.oculto vazou: ${JSON.stringify(found)}`);
  assert(found.includes('services/freyr'), 'controle desapareceu');
});

test('.forge-worktrees NUNCA é descido', () => {
  const ws = mkTmp('worktrees');
  mkGitDir(path.join(ws, '.forge-worktrees', 'RUN', 'x'));
  mkGitDir(path.join(ws, 'services', 'freyr'));

  const found = discoverWorkspaceRepos(ws);
  assert(!found.some(r => r.includes('.forge-worktrees')), `.forge-worktrees vazou: ${JSON.stringify(found)}`);
  assert(found.includes('services/freyr'), 'controle desapareceu');
});

test('repo dentro de repo NÃO gera duas entradas — a varredura poda ao achar .git', () => {
  const ws = mkTmp('nested');
  mkGitDir(path.join(ws, 'nested-repo'));
  mkGitDir(path.join(ws, 'nested-repo', 'vendored', 'submodule-like'));

  const found = discoverWorkspaceRepos(ws);
  assertEq(found.length, 1, `esperado só o repo externo, veio ${JSON.stringify(found)}`);
  assertEq(found[0], 'nested-repo', 'repo aninhado vazou como entrada própria');
});

test('workspace que É ele próprio um repo (caso single-repo) é registrado como "."', () => {
  const ws = mkTmp('selfrepo');
  mkGitDir(ws);
  mkGitDir(path.join(ws, 'services', 'freyr')); // must NOT be found: root prunes first

  const found = discoverWorkspaceRepos(ws);
  assertEq(found.length, 1, `esperado só ".", veio ${JSON.stringify(found)}`);
  assertEq(found[0], '.', 'workspace-repo não virou "."');
});

test('caminho COM ESPAÇOS no nome é descoberto e gravado corretamente', () => {
  const ws = mkTmp('spaces');
  mkGitDir(path.join(ws, 'team space', 'a repo'));

  const found = discoverWorkspaceRepos(ws);
  assert(found.includes('team space/a repo'), `espaço perdido: ${JSON.stringify(found)}`);
});

test('resultado é determinístico: ordenado, sem duplicatas', () => {
  const ws = mkTmp('sorted');
  mkGitDir(path.join(ws, 'services', 'zzz-last'));
  mkGitDir(path.join(ws, 'apps', 'aaa-first'));
  mkGitDir(path.join(ws, 'libs', 'mid'));

  const found = discoverWorkspaceRepos(ws);
  const sorted = found.slice().sort();
  assertEq(JSON.stringify(found), JSON.stringify(sorted), 'não veio ordenado');
  assertEq(new Set(found).size, found.length, 'duplicatas no resultado');
});

test('todos os caminhos retornados ficam sob o workspace (containment via isStrictlyUnder)', () => {
  const ws = mkTmp('containment');
  mkGitDir(path.join(ws, 'a', 'b', 'c')); // depth 3, inside default maxDepth

  const found = discoverWorkspaceRepos(ws);
  for (const rel of found) {
    assert(!rel.startsWith('..'), `caminho escapou do workspace: ${rel}`);
    assert(!path.isAbsolute(rel), `caminho voltou absoluto, não workspace-relative: ${rel}`);
  }
});

test('respeita maxDepth quando sobrescrito por opts', () => {
  const ws = mkTmp('maxdepth');
  mkGitDir(path.join(ws, 'a', 'b', 'c', 'd')); // depth 4

  const shallow = discoverWorkspaceRepos(ws, { maxDepth: 2 });
  assertEq(shallow.length, 0, 'profundidade 4 não deveria ser alcançada com maxDepth=2');

  const deep = discoverWorkspaceRepos(ws, { maxDepth: 4 });
  assertEq(deep.length, 1, 'profundidade 4 deveria ser alcançada com maxDepth=4');
});

// ── syncWorkspaceRepos: purity ───────────────────────────────────────────────

console.log('\nsyncWorkspaceRepos — pura, gather/transform/write separados');

test('syncWorkspaceRepos() é pura — nenhuma chamada de escrita a fs no corpo da função', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-workspace.js'), 'utf8');
  const start = src.indexOf('function syncWorkspaceRepos(');
  assert(start > 0, 'syncWorkspaceRepos() não encontrada');
  const nextFn = src.indexOf('\nfunction ', start + 10);
  const nextExports = src.indexOf('\nmodule.exports', start + 10);
  const candidates = [nextFn, nextExports].filter(n => n > 0);
  const end = candidates.length ? Math.min(...candidates) : src.length;
  const body = src.slice(start, end);
  assert(!/fs\.write/.test(body), 'syncWorkspaceRepos() chamou fs.write*');
  assert(!/fs\.mkdir/.test(body), 'syncWorkspaceRepos() chamou fs.mkdir*');
  assert(!/fs\.copy/.test(body), 'syncWorkspaceRepos() chamou fs.copy*');
  assert(!/fs\.rename/.test(body), 'syncWorkspaceRepos() chamou fs.rename*');
});

test('syncWorkspaceRepos() aceita entradas fabricadas, sem tocar disco', () => {
  const registry = {
    version: 1,
    roots: [],
    entries: [
      { path: 'lookchina', root: null, kind: 'workspace', repos: [], abs: '/synthetic/Development/lookchina' },
      { path: 'solo', root: null, kind: 'project', repos: [], abs: '/synthetic/Development/solo' },
    ],
    quarantine: [],
  };
  const reposByWorkspace = new Map([
    ['/synthetic/Development/lookchina', ['services/freyr', 'apps/odin']],
  ]);

  const { registry: out, report } = syncWorkspaceRepos(registry, { home: '/synthetic', reposByWorkspace });

  const lookchina = out.entries.find(e => e.path === 'lookchina');
  const solo = out.entries.find(e => e.path === 'solo');
  assert(lookchina, 'entry lookchina sumiu');
  assertEq(JSON.stringify(lookchina.repos), JSON.stringify(['apps/odin', 'services/freyr']), 'repos não gravados/ordenados');
  assertEq(solo.repos.length, 0, 'entry kind:project ganhou repos — não deveria');

  const lookchinaReport = report.find(r => r.path === 'lookchina');
  assertEq(lookchinaReport.count, 2, 'contagem do report');
  assertEq(JSON.stringify(lookchinaReport.added.slice().sort()), JSON.stringify(['apps/odin', 'services/freyr']), 'diff "added" incompleto');
});

test('syncWorkspaceRepos() nunca popula repos[] para entries kind:project mesmo se o mapa tiver algo lá', () => {
  const registry = {
    version: 1,
    roots: [],
    entries: [
      { path: 'solo', root: null, kind: 'project', repos: [], abs: '/synthetic/Development/solo' },
    ],
    quarantine: [],
  };
  // Adversarial: the map has an entry for the project path too.
  const reposByWorkspace = new Map([['/synthetic/Development/solo', ['should-not-appear']]]);

  const { registry: out } = syncWorkspaceRepos(registry, { home: '/synthetic', reposByWorkspace });
  assertEq(out.entries[0].repos.length, 0, 'kind:project não pode receber repos[]');
});

test('syncWorkspaceRepos() reporta added/removed contra o repos[] anterior', () => {
  const registry = {
    version: 1,
    roots: [],
    entries: [
      { path: 'lookchina', root: null, kind: 'workspace', repos: ['apps/old-gone'], abs: '/synthetic/Development/lookchina' },
    ],
    quarantine: [],
  };
  const reposByWorkspace = new Map([['/synthetic/Development/lookchina', ['services/freyr']]]);

  const { report } = syncWorkspaceRepos(registry, { home: '/synthetic', reposByWorkspace });
  assertEq(JSON.stringify(report[0].added), JSON.stringify(['services/freyr']), 'added incorreto');
  assertEq(JSON.stringify(report[0].removed), JSON.stringify(['apps/old-gone']), 'removed incorreto');
});

// ── CLI --sync-repos: dry-run zero-write, real write, workspace-only ────────

console.log('\nCLI --sync-repos');

const CLI = path.join(__dirname, 'forge-workspace.js');

function runCli(fx, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--home', fx.home, '--file', fx.file], {
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/**
 * A registry with one `workspace` entry (`lookchina`, made a workspace by
 * containing an active `project` descendant, `freyr`) and one standalone
 * `project` entry (`solo`) — exercises both branches of "só workspaces
 * recebem repos[]". `lookchina` also holds real `.git` fixtures on disk so
 * `discoverWorkspaceRepos` has something to find.
 */
function mkSyncFixture(label) {
  const home = mkTmp(label);
  const dev = path.join(home, 'Development');
  const lookchina = mkProject(path.join(dev, 'lookchina'));
  const freyr = mkProject(path.join(dev, 'lookchina', 'services', 'freyr'));
  mkGitDir(freyr); // the repo discoverWorkspaceRepos must find
  const solo = mkProject(path.join(dev, 'solo-project'));

  const roots = [{ path: '~/Development', primary: true }];
  const entries = [
    { path: 'lookchina', root: '~/Development', kind: null, repos: [] },
    { path: 'lookchina/services/freyr', root: '~/Development', kind: null, repos: [] },
    { path: 'solo-project', root: '~/Development', kind: null, repos: [] },
  ];
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const file = registryPath(home);
  writeRegistry(file, { version: 1, roots, entries, quarantine: [] });

  return { home, file, dev, lookchina, freyr, solo };
}

test('--sync-repos --dry-run: imprime o diff e o mtime/bytes do registry ficam byte-idênticos', () => {
  const fx = mkSyncFixture('dryrun');
  const beforeStat = fs.statSync(fx.file);
  const beforeBytes = fs.readFileSync(fx.file);

  const r = runCli(fx, ['--sync-repos', '--dry-run']);
  assertEq(r.code, 0, `dry-run falhou: ${r.err}`);

  const afterStat = fs.statSync(fx.file);
  assertEq(afterStat.mtimeMs, beforeStat.mtimeMs, 'mtime mudou — houve escrita no dry-run');
  assert(fs.readFileSync(fx.file).equals(beforeBytes), 'conteúdo do registry mudou no dry-run');
  assert(/dry-run: nenhuma escrita/.test(r.out), 'dry-run precisa dizer que não escreveu');
  assert(r.out.includes('services/freyr'), `dry-run omitiu o repo encontrado: ${r.out}`);
});

test('--sync-repos --dry-run --json: relatório contém a contagem medida, não uma constante', () => {
  const fx = mkSyncFixture('dryrun-json');
  const r = runCli(fx, ['--sync-repos', '--dry-run', '--json']);
  assertEq(r.code, 0, `falhou: ${r.err}`);
  const parsed = JSON.parse(r.out);
  const lookchinaReport = parsed.report.find(x => x.path === 'lookchina');
  assert(lookchinaReport, 'relatório sem a entry lookchina');
  assertEq(lookchinaReport.count, 1, 'contagem deveria refletir exatamente o que foi plantado no disco (1 repo)');
  assertEq(JSON.stringify(lookchinaReport.added), JSON.stringify(['services/freyr']), 'added deveria nomear o repo achado');
});

test('--sync-repos real: registry passa a carregar repos[] para o workspace', () => {
  const fx = mkSyncFixture('real');
  const r = runCli(fx, ['--sync-repos']);
  assertEq(r.code, 0, `falhou: ${r.err}`);

  const reg = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
  const lookchina = reg.entries.find(e => e.path === 'lookchina');
  assert(lookchina, 'entry lookchina sumiu do registry escrito');
  assert(Array.isArray(lookchina.repos) && lookchina.repos.includes('services/freyr'),
    `esperado "services/freyr" em ${JSON.stringify(lookchina.repos)}`);
});

test('--sync-repos: entry kind:project (solo-project) permanece com repos: []', () => {
  const fx = mkSyncFixture('project-untouched');
  runCli(fx, ['--sync-repos']);

  const reg = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
  const solo = reg.entries.find(e => e.path === 'solo-project');
  assert(solo, 'entry solo-project sumiu');
  assertEq(solo.repos.length, 0, 'projeto standalone não deveria ganhar repos[]');
});

test('--sync-repos: repos[] gravado workspace-relative, nunca absoluto', () => {
  const fx = mkSyncFixture('relative');
  runCli(fx, ['--sync-repos']);

  const reg = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
  const lookchina = reg.entries.find(e => e.path === 'lookchina');
  for (const rel of lookchina.repos) {
    assert(!path.isAbsolute(rel), `repo gravado como caminho absoluto: ${rel}`);
    assert(!rel.includes(fx.home), `repo vazou o $HOME sintético no caminho: ${rel}`);
  }
});

test('--sync-repos sem registry: erro legível, exit != 0, nada criado', () => {
  const home = mkTmp('missing');
  const file = registryPath(home);
  const r = spawnSync(process.execPath, [CLI, '--sync-repos', '--home', home, '--file', file], { encoding: 'utf8' });
  assert(r.status !== 0, 'deveria falhar sem registry');
  assert(!fs.existsSync(file), 'CLI criou um registry do nada');
});

// ── Regression anchor: the exact TASK-021 shape, reproduced ─────────────────

console.log('\nTASK-021 reproduzida: freyr a dois níveis passa a ser descoberto');

test('cenário TASK-021: workspace com repo a dois níveis (services/freyr) — encontrado end-to-end via --sync-repos', () => {
  const fx = mkSyncFixture('task021');
  runCli(fx, ['--sync-repos']);

  const reg = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
  const lookchina = reg.entries.find(e => e.path === 'lookchina');
  assert(lookchina.repos.includes('services/freyr'),
    'a task existe exatamente para consertar isso: services/freyr precisa aparecer em repos[]');
});

// ── Incident regression: --sync-repos must not lose a row ───────────────────
//
// On 2026-08-03 the operator's live registry went from 14 entries / 6
// quarantine to 13 / 5. The two rows that vanished were exactly the two no
// disk walk can re-derive: the *promoted* `lookchina` workspace entry (a row
// migration synthesised because it contains active entries — it is in no
// legacy input and in no repo scan) and a `touched` quarantine record. A
// `--sync-repos` ran against that file the same morning.
//
// The measurement says the sync was not the writer (it read 13 and wrote 13,
// faithfully). But this suite tested `repos[]` and nothing else: the whole
// preservation half of the contract was unasserted, and the audit that
// followed the incident found two real round-trip losses in that unasserted
// half — a `missing: true` annotation erased by the codec, and the loader's
// derived `abs` persisted into the file. Both are one field away from the
// class of failure this milestone exists to end.
//
// So: preservation is now a test, not an assumption. Every row in, every row
// out, byte-for-byte except the `repos[]` this function exists to touch.

console.log('\nIncidente 2026-08-03: --sync-repos preserva todas as linhas, byte a byte');

/**
 * Like `mkSyncFixture`, plus the two record shapes the incident lost: a
 * promoted `kind: workspace` entry and quarantine rows — one of them carrying
 * the `missing: true` annotation, which no later run can recompute (the
 * directory's absence today says nothing about what migration saw).
 */
function mkPreservationFixture(label) {
  const fx = mkSyncFixture(label);
  const reg = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
  // Kinds are stored already agreeing with what the loader derives from this
  // fixture's disk. `kind` is a display cache the loader recomputes by
  // contract, so leaving it `null` here would make the byte-equivalence
  // assertion below fail on a difference that is correct behaviour — and a
  // test that has to tolerate one kind of drift stops noticing the others.
  reg.entries = reg.entries.map(e =>
    ({ ...e, kind: e.path === 'lookchina' ? 'workspace' : 'project' }));
  reg.quarantine = [
    { path: 'lookchina/apps/glitnir', root: '~/Development', reason: 'touched' },
    { path: 'gone-from-disk', root: '~/Development', reason: 'touched', missing: true },
    { path: '~/Library/Application Support/Forge/Sandbox', root: null, reason: 'scratch' },
  ];
  writeRegistry(fx.file, reg);
  return { ...fx, before: reg };
}

test('--sync-repos preserva toda linha: contagens de entries e quarantine não mudam', () => {
  const fx = mkPreservationFixture('preserve-counts');
  const r = runCli(fx, ['--sync-repos']);
  assertEq(r.code, 0, `sync falhou: ${r.err}`);

  const after = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
  assertEq(after.entries.length, fx.before.entries.length, 'perdeu (ou inventou) uma entry');
  assertEq(after.quarantine.length, fx.before.quarantine.length, 'perdeu (ou inventou) uma linha de quarentena');
});

test('--sync-repos preserva a entry promovida (kind: workspace) — a linha que nenhum disk-walk redescobre', () => {
  const fx = mkPreservationFixture('preserve-promoted');
  runCli(fx, ['--sync-repos']);

  const after = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
  const promoted = after.entries.find(e => e.path === 'lookchina');
  assert(promoted, 'a entry promovida sumiu — exatamente o que o incidente fez');
  assertEq(promoted.kind, 'workspace', 'a entry promovida foi rebaixada a project');
  assertEq(promoted.root, '~/Development', 'o root da entry promovida mudou');
});

test('--sync-repos preserva as linhas de quarentena, `missing: true` incluído', () => {
  const fx = mkPreservationFixture('preserve-quarantine');
  runCli(fx, ['--sync-repos']);

  const after = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
  assertEq(JSON.stringify(after.quarantine), JSON.stringify(fx.before.quarantine),
    'quarentena não sobreviveu ao round trip idêntica');
  const gone = after.quarantine.find(q => q.path === 'gone-from-disk');
  assert(gone && gone.missing === true,
    'a anotação `missing` foi apagada — o operador perde o *porquê* da linha estar em quarentena');
});

test('--sync-repos: tudo byte-idêntico exceto os repos[] que a função existe para tocar', () => {
  const fx = mkPreservationFixture('preserve-bytes');
  runCli(fx, ['--sync-repos']);

  const after = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
  const strip = reg => JSON.stringify({
    ...reg,
    entries: reg.entries.map(({ repos, ...rest }) => rest), // eslint-disable-line no-unused-vars
  });
  assertEq(strip(after), strip(fx.before),
    'algo além de repos[] mudou no round trip');

  // The `repos[]` it *is* allowed to touch, measured from the fixture's disk.
  const ws = after.entries.find(e => e.path === 'lookchina');
  assert(ws.repos.includes('services/freyr'), 'o campo que deveria mudar não mudou');
});

test('--sync-repos não persiste `abs` — o campo derivado pelo loader nunca vira campo do arquivo', () => {
  const fx = mkPreservationFixture('no-abs-leak');
  runCli(fx, ['--sync-repos']);

  const raw = fs.readFileSync(fx.file, 'utf8');
  assert(!/"abs"/.test(raw),
    'o `abs` que `loadRegistry` anexa em memória vazou para o disco — arquivo e loader passam a discordar quando $HOME ou um root mudam');
});

test('guard de contenção: uma projeção que perde uma linha faz syncWorkspaceRepos lançar, não escrever', () => {
  const fx = mkPreservationFixture('containment-guard');
  const reg = loadRegistry(fx.file, { home: fx.home });

  // Inject the exact defect the incident is a member of: a quarantine
  // projection that silently returns fewer rows than it received. An array
  // subclass whose `map` drops the first element is the smallest faithful
  // stand-in for "someone turned this .map() into a filter or a rebuild".
  class LossyArray extends Array {
    map(fn, thisArg) { return Array.prototype.map.call(this, fn, thisArg).slice(1); }
  }
  reg.quarantine = LossyArray.from(reg.quarantine);

  let threw = null;
  try {
    syncWorkspaceRepos(reg, { home: fx.home, reposByWorkspace: new Map() });
  } catch (e) {
    threw = e;
  }
  assert(threw, 'a perda de uma linha passou sem erro — o guard não morde');
  assert(/refusing to write a registry with rows missing/.test(threw.message),
    `mensagem do guard não nomeia a recusa: ${threw && threw.message}`);
});

// ── Summary ───────────────────────────────────────────────────────────────

cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
