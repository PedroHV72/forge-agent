#!/usr/bin/env node
'use strict';

// forge-repo-index.test.js — the resolver, and the one property that matters.
//
// TASK-021's `repo: freyr` failed under isolation `worktree`, where the unit's
// cwd is `<root>/.forge-worktrees/{RUN}/<repo>` — a path that is NOT contained
// in the workspace tree. That detail is the whole test plan: a resolver that
// walks up from cwd passes every test written from inside the workspace and
// fails the one place the incident actually happened.
//
// So the load-bearing case here (R1) resolves the SAME name from four cwds —
// the workspace root, a repo inside it, the filesystem root, and a worktree
// directory that lives outside the workspace — and asserts the four answers
// are byte-identical. It is not a convenience check; it is the contract.
//
// Every fixture lives in a tmpdir with a SYNTHETIC $HOME. Nothing in this file
// reads or writes the operator's real `~/.claude/forge-gate-workspaces.json`.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  buildRepoIndex,
  resolveRepoName,
  availableNames,
  containsOrEquals,
} = require('./forge-repo-index.js');

const { writeMarker } = require('./forge-marker.js');

const CLI = path.join(__dirname, 'forge-repo-index.js');

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-repo-index-'));
  tmps.push(d);
  return fs.realpathSync(d);
}

function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── Fixture ─────────────────────────────────────────────────────────────────
//
// Shape mirrors the operator's measured disk: a workspace holding repos two
// levels down (`services/freyr` — the depth `forge-repos.discoverRepos` could
// not see), a name that collides across two workspaces (`norns` really does
// exist at both `apps/norns` and `services/norns`), and a worktree directory
// that sits OUTSIDE every workspace.

function writeRegistry(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    roots: [],
    entries,
    quarantine: [],
  }, null, 2));
}

function mkdirs(...dirs) {
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

/** Workspace `ws` with `services/freyr` + `apps/norns`, plus a worktree outside it. */
function makeFixture(opts) {
  const o = opts || {};
  const root = mktmp(o.prefix);
  const home = path.join(root, 'home');
  const ws = path.join(root, o.wsName || 'lookchina');
  const freyr = path.join(ws, 'services', 'freyr');
  const norns = path.join(ws, 'apps', 'norns');
  const worktree = path.join(root, '.forge-worktrees', 'RUN-1', 'freyr');

  mkdirs(home, ws, freyr, norns, worktree);

  const file = path.join(home, '.claude', 'forge-gate-workspaces.json');
  const entries = [
    { path: ws, root: null, kind: 'workspace', repos: ['apps/norns', 'services/freyr'] },
  ].concat(o.extraEntries || []);
  writeRegistry(file, entries);

  return { root, home, file, ws, freyr, norns, worktree };
}

/** Two workspaces that each contain a repo called `norns`. */
function makeCollisionFixture() {
  const root = mktmp('forge-repo-index-collide-');
  const home = path.join(root, 'home');
  const wsA = path.join(root, 'alpha');
  const wsB = path.join(root, 'beta');
  const nornsA = path.join(wsA, 'apps', 'norns');
  const nornsB = path.join(wsB, 'services', 'norns');
  const worktree = path.join(root, '.forge-worktrees', 'RUN-2', 'norns');

  mkdirs(home, nornsA, nornsB, worktree);

  const file = path.join(home, '.claude', 'forge-gate-workspaces.json');
  writeRegistry(file, [
    { path: wsA, root: null, kind: 'workspace', repos: ['apps/norns'] },
    { path: wsB, root: null, kind: 'workspace', repos: ['services/norns'] },
  ]);

  return { root, home, file, wsA, wsB, nornsA, nornsB, worktree };
}

// ── R1: cwd-invariance — the contract ───────────────────────────────────────

console.log('\nR1 — invariância por cwd (o caso da TASK-021)');

test('resolveRepoName("freyr") devolve o mesmo caminho a partir de 4 cwds, um deles numa worktree fora do workspace', () => {
  const f = makeFixture();
  const cwds = [
    f.ws,                       // dentro do workspace
    f.freyr,                    // dentro de um repo membro
    path.sep,                   // raiz do filesystem
    f.worktree,                 // worktree — caminho FORA do workspace
  ];

  const results = cwds.map(cwd => resolveRepoName('freyr', { home: f.home, registryFile: f.file, cwd }));

  for (let i = 0; i < results.length; i++) {
    assertEqual(results[i].status, 'ok', `status a partir de ${cwds[i]}`);
    assertEqual(results[i].path, f.freyr, `path a partir de ${cwds[i]}`);
  }

  const unique = new Set(results.map(r => r.path));
  assertEqual(unique.size, 1, 'os quatro cwds devem produzir exatamente um caminho');
});

test('a worktree fora do workspace resolve — o cwd do incidente não é caso especial', () => {
  const f = makeFixture();
  assert(!f.worktree.startsWith(f.ws + path.sep), 'fixture inválida: a worktree deve estar FORA do workspace');
  const r = resolveRepoName('freyr', { home: f.home, registryFile: f.file, cwd: f.worktree });
  assertEqual(r.status, 'ok', 'status a partir da worktree');
  assertEqual(r.path, f.freyr, 'path a partir da worktree');
});

test('um match único nunca reporta desempate — cwd não participou', () => {
  const f = makeFixture();
  for (const cwd of [f.ws, f.freyr, path.sep, f.worktree]) {
    const r = resolveRepoName('freyr', { home: f.home, registryFile: f.file, cwd });
    assertEqual(r.tiebreak, null, `tiebreak a partir de ${cwd}`);
  }
});

test('resolução sem nenhum cwd fornecido é idêntica à resolução com cwd', () => {
  const f = makeFixture();
  const semCwd = resolveRepoName('freyr', { home: f.home, registryFile: f.file });
  const comCwd = resolveRepoName('freyr', { home: f.home, registryFile: f.file, cwd: f.worktree });
  assertEqual(semCwd.path, comCwd.path, 'omitir cwd não pode mudar o caso único');
  assertEqual(semCwd.status, 'ok', 'status sem cwd');
});

// ── R2: three declaration forms ─────────────────────────────────────────────

console.log('\nR2 — três formas de declaração');

test('nome curto, caminho workspace-relative e caminho absoluto resolvem para o mesmo path', () => {
  const f = makeFixture();
  const forms = ['freyr', 'services/freyr', f.freyr];
  const out = forms.map(v => resolveRepoName(v, { home: f.home, registryFile: f.file, cwd: f.worktree }));
  for (let i = 0; i < forms.length; i++) {
    assertEqual(out[i].status, 'ok', `status para "${forms[i]}"`);
    assertEqual(out[i].path, f.freyr, `path para "${forms[i]}"`);
  }
});

test('o registro carrega workspace e relative junto com o path', () => {
  const f = makeFixture();
  const r = resolveRepoName('freyr', { home: f.home, registryFile: f.file });
  assertEqual(r.workspace, f.ws, 'workspace');
  assertEqual(r.relative, 'services/freyr', 'relative');
  assertEqual(r.source, 'registry', 'source');
});

test('caminho workspace-relative de um repo que não existe não vira caminho inventado', () => {
  const f = makeFixture();
  const r = resolveRepoName('services/inexistente', { home: f.home, registryFile: f.file });
  assertEqual(r.status, 'unknown', 'status');
  assertEqual(r.path, '', 'path deve ser vazio, nunca um join especulativo');
});

test('nome com caixa diferente resolve apenas como último recurso, e se declara', () => {
  const f = makeFixture();
  const r = resolveRepoName('FREYR', { home: f.home, registryFile: f.file });
  assertEqual(r.status, 'ok', 'status');
  assertEqual(r.path, f.freyr, 'path');
  assertEqual(r.tiebreak, 'case-insensitive', 'o match por caixa precisa ficar visível');
});

// ── R3: ambiguity ───────────────────────────────────────────────────────────

console.log('\nR3 — ambiguidade e desempate');

test('dois workspaces com o mesmo nome de repo produzem "ambiguous" com ambos os candidatos', () => {
  const c = makeCollisionFixture();
  const r = resolveRepoName('norns', { home: c.home, registryFile: c.file, cwd: path.sep });
  assertEqual(r.status, 'ambiguous', 'status');
  assertEqual(r.path, '', 'ambiguidade nunca devolve um path');
  assertEqual(r.candidates.length, 2, 'candidatos');
  assert(r.candidates.includes(c.nornsA), 'candidato A ausente');
  assert(r.candidates.includes(c.nornsB), 'candidato B ausente');
});

test('cwd sob exatamente um candidato desempata, e o desempate é rotulado', () => {
  const c = makeCollisionFixture();
  const r = resolveRepoName('norns', { home: c.home, registryFile: c.file, cwd: c.nornsB });
  assertEqual(r.status, 'ok', 'status');
  assertEqual(r.path, c.nornsB, 'path');
  assertEqual(r.tiebreak, 'cwd', 'tiebreak');
});

test('cwd na raiz do workspace também desempata', () => {
  const c = makeCollisionFixture();
  const r = resolveRepoName('norns', { home: c.home, registryFile: c.file, cwd: c.wsA });
  assertEqual(r.status, 'ok', 'status');
  assertEqual(r.path, c.nornsA, 'path');
});

test('cwd de worktree não está sob workspace nenhum — permanece ambíguo, sem pick silencioso', () => {
  const c = makeCollisionFixture();
  const r = resolveRepoName('norns', { home: c.home, registryFile: c.file, cwd: c.worktree });
  assertEqual(r.status, 'ambiguous', 'status');
  assertEqual(r.candidates.length, 2, 'ambos os candidatos devem sobreviver');
});

test('ambiguidade resolvida pelo caminho completo, que é o conserto que o hint vai mandar fazer', () => {
  const c = makeCollisionFixture();
  const r = resolveRepoName(c.nornsB, { home: c.home, registryFile: c.file, cwd: c.worktree });
  assertEqual(r.status, 'ok', 'status');
  assertEqual(r.path, c.nornsB, 'path');
});

test('containsOrEquals recusa irmão de prefixo comum (nunca startsWith cru)', () => {
  assert(containsOrEquals('/w/api', '/w/api/src'), '/w/api contém /w/api/src');
  assert(containsOrEquals('/w/api', '/w/api'), 'igualdade conta');
  assert(!containsOrEquals('/w/api', '/w/api-v2'), '/w/api NÃO contém /w/api-v2');
});

// ── R4: unknown ─────────────────────────────────────────────────────────────

console.log('\nR4 — desconhecido');

test('nome inexistente devolve "unknown" com a lista de nomes disponíveis', () => {
  const f = makeFixture();
  const r = resolveRepoName('nao-existe', { home: f.home, registryFile: f.file, cwd: f.ws });
  assertEqual(r.status, 'unknown', 'status');
  assertEqual(r.path, '', 'path');
  assert(r.available.length > 0, 'a lista de nomes disponíveis não pode ser vazia');
  assert(r.available.includes('freyr'), 'freyr deveria constar como disponível');
});

test('nome vazio é unknown, nunca um caminho', () => {
  const f = makeFixture();
  for (const v of ['', '   ', null, undefined]) {
    const r = resolveRepoName(v, { home: f.home, registryFile: f.file });
    assertEqual(r.status, 'unknown', `status para ${JSON.stringify(v)}`);
    assertEqual(r.path, '', `path para ${JSON.stringify(v)}`);
  }
});

test('registry ausente devolve índice vazio e unknown — não inventa e não explode', () => {
  const root = mktmp('forge-repo-index-noreg-');
  const home = path.join(root, 'home');
  mkdirs(home);
  const file = path.join(home, '.claude', 'forge-gate-workspaces.json');
  const idx = buildRepoIndex({ home, registryFile: file });
  assertEqual(idx.missing, true, 'missing');
  assertEqual(idx.entries.length, 0, 'entries');
  const r = resolveRepoName('freyr', { home, registryFile: file });
  assertEqual(r.status, 'unknown', 'status');
});

// ── R5: index shape and reuse ───────────────────────────────────────────────

console.log('\nR5 — forma do índice e reuso do codec');

test('buildRepoIndex indexa por nome e por caminho, com paths absolutos', () => {
  const f = makeFixture();
  const idx = buildRepoIndex({ home: f.home, registryFile: f.file });
  assertEqual(idx.entries.length, 2, 'entries');
  assert(idx.byName.has('freyr'), 'byName deve conter freyr');
  assert(idx.byPath.has(f.freyr.split(path.sep).join('/')), 'byPath deve conter o caminho absoluto');
  for (const e of idx.entries) assert(path.isAbsolute(e.path), `path não absoluto: ${e.path}`);
  assertEqual(availableNames(idx).join(','), 'freyr,norns', 'nomes disponíveis ordenados');
});

test('um entry sem repos[] é endereçável por si mesmo (projeto solto não regride)', () => {
  const root = mktmp('forge-repo-index-solo-');
  const home = path.join(root, 'home');
  const solo = path.join(root, 'projeto-solto');
  mkdirs(home, solo);
  const file = path.join(home, '.claude', 'forge-gate-workspaces.json');
  writeRegistry(file, [{ path: solo, root: null, kind: 'project', repos: [] }]);
  const r = resolveRepoName('projeto-solto', { home, registryFile: file });
  assertEqual(r.status, 'ok', 'status');
  assertEqual(r.path, solo, 'path');
});

test('repos[] com "." registra o próprio workspace sob o nome dele', () => {
  const root = mktmp('forge-repo-index-dot-');
  const home = path.join(root, 'home');
  const ws = path.join(root, 'single');
  mkdirs(home, ws);
  const file = path.join(home, '.claude', 'forge-gate-workspaces.json');
  writeRegistry(file, [{ path: ws, root: null, kind: 'workspace', repos: ['.'] }]);
  const r = resolveRepoName('single', { home, registryFile: file });
  assertEqual(r.status, 'ok', 'status');
  assertEqual(r.path, ws, 'path');
  assertEqual(r.relative, '.', 'relative');
});

test('o resolvedor lê o registry via loadRegistry e não reimplementa o codec', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert(/require\('\.\/forge-workspace\.js'\)/.test(src), 'deve requerer forge-workspace.js');
  for (const fn of ['loadRegistry', 'isStrictlyUnder', 'resolveEntryPath']) {
    assert(src.includes(fn), `deve reusar ${fn}`);
  }
  assert(!/JSON\.parse\(/.test(src), 'não pode parsear o registry por conta própria');
  assert(!/function\s+expandTilde/.test(src), 'não pode reimplementar a expansão de ~');
});

test('caminho de workspace com espaço resolve (caso-limite real deste ecossistema)', () => {
  const root = mktmp('forge-repo-index-space-');
  const home = path.join(root, 'home');
  const ws = path.join(root, 'Application Support', 'meu workspace');
  const repo = path.join(ws, 'services', 'freyr');
  mkdirs(home, repo);
  const file = path.join(home, '.claude', 'forge-gate-workspaces.json');
  writeRegistry(file, [{ path: ws, root: null, kind: 'workspace', repos: ['services/freyr'] }]);
  const r = resolveRepoName('freyr', { home, registryFile: file, cwd: path.sep });
  assertEqual(r.status, 'ok', 'status');
  assertEqual(r.path, repo, 'path');
});

// ── R6: CLI ─────────────────────────────────────────────────────────────────

console.log('\nR6 — CLI e exit codes');

function runCli(args) {
  const res = spawnSync(process.execPath, [CLI].concat(args), { encoding: 'utf8' });
  return { code: res.status, out: res.stdout || '', err: res.stderr || '' };
}

test('--resolve --json imprime status/path/workspace/source e sai 0', () => {
  const f = makeFixture();
  const r = runCli(['--resolve', 'freyr', '--json', '--home', f.home, '--file', f.file, '--cwd', f.worktree]);
  assertEqual(r.code, 0, `exit (stderr: ${r.err})`);
  const j = JSON.parse(r.out);
  assertEqual(j.status, 'ok', 'status');
  assertEqual(j.path, f.freyr, 'path');
  assertEqual(j.workspace, f.ws, 'workspace');
  assertEqual(j.source, 'registry', 'source');
});

test('a CLI imprime o mesmo path a partir de cwds diferentes', () => {
  const f = makeFixture();
  const paths = [f.ws, path.sep, f.worktree].map(cwd => {
    const r = runCli(['--resolve', 'freyr', '--json', '--home', f.home, '--file', f.file, '--cwd', cwd]);
    assertEqual(r.code, 0, `exit para cwd ${cwd}`);
    return JSON.parse(r.out).path;
  });
  assertEqual(new Set(paths).size, 1, `a CLI variou por cwd: ${JSON.stringify(paths)}`);
});

test('nome desconhecido sai 1', () => {
  const f = makeFixture();
  const r = runCli(['--resolve', 'nao-existe', '--json', '--home', f.home, '--file', f.file]);
  assertEqual(r.code, 1, 'exit');
  assertEqual(JSON.parse(r.out).status, 'unknown', 'status');
});

test('--cwd é encaminhado à descoberta de marcador (registry ausente) — sem isso o fallback busca a partir de process.cwd()', () => {
  // Registry absent entirely — the ONLY door `buildRepoIndex` walks through
  // to the marker (D3). A marker is written under its own tmpdir, well away
  // from wherever this test process's cwd happens to be, so the marker is
  // only reachable when the CLI's `--cwd` is actually forwarded into
  // `buildRepoIndex` (and therefore into `findMarker`) instead of being
  // dropped after the tiebreak, as it was before this fix.
  const root = mktmp('forge-repo-index-cwd-fwd-');
  const home = path.join(root, 'home'); // no .claude/forge-gate-workspaces.json here
  const ws = path.join(root, 'markerws');
  const deep = path.join(ws, 'nested', 'deep');
  mkdirs(home, deep);
  writeMarker(ws, { kind: 'workspace', name: 'markerws', repos: [{ name: 'freyr', path: '.' }] });

  const withCwd = runCli(['--resolve', 'freyr', '--json', '--home', home, '--cwd', deep]);
  assertEqual(withCwd.code, 0, `--cwd apontando para dentro do marcador deveria resolver (stderr: ${withCwd.err})`);
  const j = JSON.parse(withCwd.out);
  assertEqual(j.status, 'ok', 'status com --cwd correto');
  assertEqual(j.source, 'marker', 'source deveria vir do marcador (registry ausente)');
  assertEqual(j.path, ws, 'path deveria ser o diretório do marcador');

  // A cwd elsewhere (no marker reachable by walk-up) must MISS — proving the
  // result actually depends on which --cwd was forwarded, not on some other
  // ambient default.
  const elsewhere = path.join(root, 'nowhere-near-a-marker');
  mkdirs(elsewhere);
  const withoutMarker = runCli(['--resolve', 'freyr', '--json', '--home', home, '--cwd', elsewhere]);
  assertEqual(withoutMarker.code, 1, 'sem marcador alcançável, deveria sair 1');
  assertEqual(JSON.parse(withoutMarker.out).status, 'unknown', 'status sem marcador alcançável');
});

test('nome ambíguo sai 1 e lista os candidatos', () => {
  const c = makeCollisionFixture();
  const r = runCli(['--resolve', 'norns', '--json', '--home', c.home, '--file', c.file, '--cwd', c.worktree]);
  assertEqual(r.code, 1, 'exit');
  const j = JSON.parse(r.out);
  assertEqual(j.status, 'ambiguous', 'status');
  assertEqual(j.candidates.length, 2, 'candidatos');
});

test('uso inválido sai 2', () => {
  const f = makeFixture();
  assertEqual(runCli([]).code, 2, 'sem argumentos');
  assertEqual(runCli(['--resolve']).code, 2, '--resolve sem valor');
  assertEqual(runCli(['--nope', '--home', f.home]).code, 2, 'flag desconhecida');
});

test('--list --json imprime o índice inteiro', () => {
  const f = makeFixture();
  const r = runCli(['--list', '--json', '--home', f.home, '--file', f.file]);
  assertEqual(r.code, 0, 'exit');
  const j = JSON.parse(r.out);
  assertEqual(j.count, 2, 'count');
  assertEqual(j.repos.map(x => x.name).join(','), 'freyr,norns', 'nomes');
});

test('saída humana de --resolve é o caminho puro (consumível por $( ))', () => {
  const f = makeFixture();
  const r = runCli(['--resolve', 'freyr', '--home', f.home, '--file', f.file]);
  assertEqual(r.code, 0, 'exit');
  assertEqual(r.out.trim(), f.freyr, 'stdout');
});

// ── Summary ─────────────────────────────────────────────────────────────────

cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFalhas:');
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.error}`);
  process.exit(1);
}
