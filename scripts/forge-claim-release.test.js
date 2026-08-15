#!/usr/bin/env node
'use strict';

// forge-claim-release.test.js — o release só acontece com prova.
//
// Propriedades que esta suíte carrega:
//
//   R1  as DUAS sondas são conjuntas. Par de testes em repositório git REAL
//       provando que cada sonda SOZINHA não libera:
//         (a) commit de OUTRO arquivo avança o baseline com os paths do claim
//             ainda sujos                                 -> held-uncommitted
//         (b) paths limpos porque o worker nunca escreveu, baseline parado
//                                                          -> held-uncommitted
//       e o caso conjunto (edição + commit dos paths do claim)
//                                                          -> released-committed
//   R2  o caminho SVN passa pelo MESMO seam público (`baselineId`/`workingStatus`
//       com `{vcs:'svn'}`), exercitado com o seam substituído — svn não está
//       instalado no ambiente — e o módulo NÃO ramifica em comando próprio,
//       provado por varredura do fonte com CONTROLE POSITIVO.
//   R3  sonda impossível MANTÉM o claim: nenhuma das quatro entradas
//       (`{ok:false}`, `code_dir:null`, `vcs_baseline:null`, vcs desconhecido)
//       produz uma razão `released-*`.
//   R4  TTL é rede, nunca critério (D2): par comportamental com o MESMO `at` e
//       o MESMO relógio — run dona ATIVA -> held-uncommitted; INATIVA ->
//       released-ttl-expired. A idade sozinha nunca libera.
//   R5  TTL/grace e o predicado de run inativa vêm por REUSO — identidade com a
//       origem asserida, nunca literal duplicado.
//   R6  `CLAIM_RELEASE_REASONS` é conjunto fechado, cruzado nos DOIS sentidos.
//   R7  precedência FIXA, um caso construído POR FRONTEIRA.
//   R8  `--release` é PEDIDO: não observável -> recusa `not-observable`,
//       exit 0, NADA gravado (claim relido campo a campo).
//   R9  o evento `claim-release` é lido DO ARQUIVO, nunca narrado.
//   R10 `classifyRelease` é PURA — decidida com fatos sintéticos, sem fixture,
//       e provada não tocar o disco.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-claim-release.js');
const rel = require('./forge-claim-release.js');
const {
  measureBaseline, probeClaim, classifyRelease, releaseIfObservable, statusOf,
  emitReleaseEvent, CLAIM_RELEASE_REASONS,
} = rel;
const runs = require('./forge-runs.js');
const { recordClaim, readClaim } = require('./forge-write-claim.js');
const unitLease = require('./forge-unit-lease.js');
const filelock = require('./forge-filelock.js');

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-claim-release-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// Razões vistas ao longo da suíte — cruzadas contra CLAIM_RELEASE_REASONS no fim.
const reasonsSeen = new Set();
function noteReason(r) { if (r) reasonsSeen.add(r); }

// ── Fixtures ────────────────────────────────────────────────────────────────

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Repositório git REAL com um commit inicial. Nenhum mock do seam. */
function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['checkout', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
  git(dir, ['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'alvo.txt'), 'v0\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

/** Workspace sintético com um RunRecord — nenhum HOME real é tocado. */
function makeWorkspace(runId, extraRun) {
  const tmp = mktmp();
  const wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(wsDir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');
  writeJson(path.join(wsDir, '.gsd', 'forge', 'runs', `${runId}.json`), Object.assign({
    kind: 'milestone',
    id: runId,
    session_id: 'sess-fixture',
    active: true,
    started_at: 1785763253000,
    last_heartbeat: 1785763253000,
    worker: null,
    worker_started: null,
    isolation_mode: 'worktree',
    milestone_dir: `.gsd/milestones/${runId}/`,
    cwd: wsDir,
  }, extraRun || {}));
  return { tmp, wsDir };
}

/** Workspace + repo git real + claim gravado sobre `alvo.txt`. */
function makeScenario(runId, extraRun) {
  const { tmp, wsDir } = makeWorkspace(runId, extraRun);
  const repo = makeRepo(path.join(tmp, 'code'));
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  recordClaim(wsDir, runId, {
    at: 1785763253000,
    unit: 'execute-task/T02',
    source: 'plan-writes',
    code_dir: repo,
    paths: ['alvo.txt'],
    vcs_baseline: { vcs: 'git', id: head },
  });
  return { wsDir, repo, head };
}

function runCli(args) {
  const res = spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// ════════════════════════════════════════════════════════════════════════════
// R1 — as duas sondas são CONJUNTAS (repositório git real)
// ════════════════════════════════════════════════════════════════════════════

// (a) Sonda A sozinha: o baseline avançou por um commit de OUTRO arquivo — que
//     é o commit do VIZINHO na árvore compartilhada, o cenário SVN/WDMA que
//     originou a milestone — enquanto os paths do claim seguem sujos.
test('R1a: baseline avançado por commit de OUTRO arquivo, paths do claim sujos -> held-uncommitted', () => {
  const { wsDir, repo, head } = makeScenario('M-r1a');
  // o worker DESTE claim escreveu e não commitou
  fs.writeFileSync(path.join(repo, 'alvo.txt'), 'v1-nao-commitado\n', 'utf8');
  // o vizinho commitou outra coisa: o baseline da ÁRVORE avança
  fs.writeFileSync(path.join(repo, 'vizinho.txt'), 'do vizinho\n', 'utf8');
  git(repo, ['add', 'vizinho.txt']);
  git(repo, ['commit', '-q', '-m', 'commit do vizinho']);

  const s = statusOf(wsDir, 'M-r1a');
  assert(s.facts.baseline_advanced === true, 'sonda A deve ter avançado (commit do vizinho)');
  assert(s.facts.paths_in_flight === true, 'sonda B deve acusar path do claim em voo');
  assertEqual(s.reason, 'held-uncommitted', 'sonda A sozinha NÃO pode liberar');
  assertEqual(s.held, true, 'claim deve ser mantido');
  assert(git(repo, ['rev-parse', 'HEAD']).trim() !== head, 'pré-condição: HEAD mudou de fato');
  noteReason(s.reason);
});

// (b) Sonda B sozinha: nenhum path do claim está sujo — porque o worker NEM
//     COMEÇOU a escrever — e o baseline está parado.
test('R1b: paths limpos porque o worker nunca escreveu, baseline parado -> held-uncommitted', () => {
  const { wsDir, repo, head } = makeScenario('M-r1b');
  const s = statusOf(wsDir, 'M-r1b');
  assert(s.facts.paths_in_flight === false, 'sonda B: nada em voo (worker não escreveu)');
  assert(s.facts.baseline_advanced === false, 'sonda A: baseline parado');
  assertEqual(s.reason, 'held-uncommitted', 'sonda B sozinha NÃO pode liberar');
  assertEqual(git(repo, ['rev-parse', 'HEAD']).trim(), head, 'pré-condição: HEAD intocado');
  noteReason(s.reason);
});

// (c) As duas juntas, em repo git REAL (init, commit, edição, commit).
test('R1c: as DUAS sondas satisfeitas em repo git real -> released-committed', () => {
  const { wsDir, repo } = makeScenario('M-r1c');
  fs.writeFileSync(path.join(repo, 'alvo.txt'), 'v1\n', 'utf8');
  git(repo, ['add', 'alvo.txt']);
  git(repo, ['commit', '-q', '-m', 'commit do proprio trabalho']);

  const s = statusOf(wsDir, 'M-r1c');
  assert(s.facts.baseline_advanced === true, 'sonda A satisfeita');
  assert(s.facts.paths_in_flight === false, 'sonda B satisfeita');
  assertEqual(s.reason, 'released-committed', 'as duas sondas juntas liberam');
  assertEqual(s.mechanism, 'committed', 'mecanismo deve ser committed');
  noteReason(s.reason);
});

test('R1d: released-committed grava o envelope via releaseClaim (T01), com evidência', () => {
  const { wsDir, repo } = makeScenario('M-r1d');
  fs.writeFileSync(path.join(repo, 'alvo.txt'), 'v1\n', 'utf8');
  git(repo, ['add', 'alvo.txt']);
  git(repo, ['commit', '-q', '-m', 'commit']);

  const result = releaseIfObservable(wsDir, 'M-r1d');
  assertEqual(result.released, true, 'deve liberar');
  assertEqual(result.refusal, null, 'nenhuma recusa');
  const claim = readClaim(runs.get(wsDir, 'M-r1d'));
  assert(claim.released !== null, 'envelope released deve estar persistido');
  assertEqual(claim.released.mechanism, 'committed', 'mecanismo persistido');
  assert(claim.released.evidence.baseline_advanced === true, 'evidência carrega a sonda A');
  assert(claim.released.evidence.paths_in_flight === false, 'evidência carrega a sonda B');
  assertEqual(claim.paths.length, 1, 'paths do claim preservados pelo release');
});

// ════════════════════════════════════════════════════════════════════════════
// R2 — SVN pelo MESMO seam público, e nenhum comando próprio no módulo
// ════════════════════════════════════════════════════════════════════════════

/**
 * Seam substituído APENAS aqui, e a razão é concreta: `svn` não está instalado
 * no ambiente de teste. O que este cenário prova não é o svn — é que o módulo
 * atravessa `baselineId`/`workingStatus` com `{vcs:'svn'}` sem ramificar em
 * lógica própria.
 */
function svnSeam(calls, opts) {
  return {
    detectVcs(dir) { calls.push(['detectVcs', dir, null]); return 'svn'; },
    baselineId(dir, o) { calls.push(['baselineId', dir, o.vcs]); return { vcs: o.vcs, ok: true, id: opts.nowId }; },
    workingStatus(dir, o) { calls.push(['workingStatus', dir, o.vcs]); return { vcs: o.vcs, ok: true, entries: opts.entries }; },
  };
}

test('R2a: caminho svn atravessa o seam público com {vcs:"svn"} e libera com as duas sondas', () => {
  const { wsDir } = makeWorkspace('M-r2a');
  recordClaim(wsDir, 'M-r2a', {
    at: 1785763253000, unit: 'execute-task/T02', source: 'plan-writes',
    code_dir: path.join(wsDir, 'wc'), paths: ['src/a.ts'],
    vcs_baseline: { vcs: 'svn', id: '41' },
  });
  const calls = [];
  const s = statusOf(wsDir, 'M-r2a', { vcsSeam: svnSeam(calls, { nowId: '42', entries: [] }) });
  assertEqual(s.reason, 'released-committed', 'svn: baseline 41->42 e nada em voo libera');
  assertEqual(s.facts.vcs, 'svn', 'o vcs medido é svn');
  const seen = calls.filter((c) => c[0] !== 'detectVcs');
  assert(seen.length >= 2, 'baselineId e workingStatus devem ter sido chamados');
  for (const [fn, , vcs] of seen) assertEqual(vcs, 'svn', `${fn} deve receber vcs svn pelo seam`);
});

test('R2b: svn com path do claim em voo NÃO libera (mesma conjunção do git)', () => {
  const { wsDir } = makeWorkspace('M-r2b');
  recordClaim(wsDir, 'M-r2b', {
    at: 1785763253000, unit: 'execute-task/T02', source: 'plan-writes',
    code_dir: path.join(wsDir, 'wc'), paths: ['src/a.ts'],
    vcs_baseline: { vcs: 'svn', id: '41' },
  });
  const entries = [{ path: 'src/a.ts', code: 'M', kind: 'modified' }];
  const s = statusOf(wsDir, 'M-r2b', { vcsSeam: svnSeam([], { nowId: '42', entries }) });
  assertEqual(s.reason, 'held-uncommitted', 'baseline avançado sozinho não libera nem em svn');
});

test('R2c: guard de fonte — o módulo não ramifica em git/svn próprio (com controle positivo)', () => {
  const SPAWN_RE = /(execFileSync|spawnSync|execSync|exec)\s*\(\s*['"`](git|svn)/;
  const source = fs.readFileSync(MODULE, 'utf8');
  assert(!SPAWN_RE.test(source), 'o módulo não pode invocar git/svn diretamente — toda interação passa pelo seam');
  // Controle positivo: a varredura ENXERGA o padrão quando ele existe. Um guard
  // que nunca foi visto mordendo não é cobertura (TASK-021).
  const planted = `${source}\n// plantado\nconst x = execFileSync('git', ['status']);\n`;
  assert(SPAWN_RE.test(planted), 'controle positivo: a varredura deve achar o padrão plantado');
  // E o arquivo real segue intacto — a cópia foi só em memória.
  assertEqual(fs.readFileSync(MODULE, 'utf8'), source, 'o fonte não pode ter sido alterado pelo controle');
});

// ════════════════════════════════════════════════════════════════════════════
// R3 — sonda impossível MANTÉM o claim, nunca released-*
// ════════════════════════════════════════════════════════════════════════════

test('R3: nenhuma sonda impossível produz released-* (quatro entradas nomeadas)', () => {
  const base = { at: 1785763253000, unit: 'u', source: 'manual', paths: ['a.txt'] };
  const cases = [];

  // (1) code_dir ausente
  {
    const { wsDir } = makeWorkspace('M-r3-1');
    recordClaim(wsDir, 'M-r3-1', Object.assign({}, base, { code_dir: null, vcs_baseline: { vcs: 'git', id: 'abc' } }));
    cases.push(['code_dir:null', statusOf(wsDir, 'M-r3-1')]);
  }
  // (2) vcs_baseline ausente
  {
    const { wsDir } = makeWorkspace('M-r3-2');
    recordClaim(wsDir, 'M-r3-2', Object.assign({}, base, { code_dir: wsDir, vcs_baseline: null }));
    cases.push(['vcs_baseline:null', statusOf(wsDir, 'M-r3-2')]);
  }
  // (3) seam devolve {ok:false} — binário ausente/diretório sumido
  {
    const { wsDir } = makeWorkspace('M-r3-3');
    recordClaim(wsDir, 'M-r3-3', Object.assign({}, base, { code_dir: wsDir, vcs_baseline: { vcs: 'git', id: 'abc' } }));
    const seam = {
      detectVcs: () => 'git',
      baselineId: () => ({ vcs: 'git', ok: false, id: null, error: 'git-ausente' }),
      workingStatus: () => ({ vcs: 'git', ok: false, entries: [], error: 'git-ausente' }),
    };
    cases.push(['seam {ok:false}', statusOf(wsDir, 'M-r3-3', { vcsSeam: seam })]);
  }
  // (4) vcs desconhecido
  {
    const { wsDir } = makeWorkspace('M-r3-4');
    recordClaim(wsDir, 'M-r3-4', Object.assign({}, base, { code_dir: wsDir, vcs_baseline: { vcs: 'git', id: 'abc' } }));
    const seam = { detectVcs: () => 'hg', baselineId: () => ({ ok: true, id: 'x' }), workingStatus: () => ({ ok: true, entries: [] }) };
    cases.push(['vcs desconhecido', statusOf(wsDir, 'M-r3-4', { vcs: 'hg', vcsSeam: seam })]);
  }

  for (const [label, s] of cases) {
    assertEqual(s.reason, 'held-probe-unavailable', `${label} deve manter o claim`);
    assertEqual(s.held, true, `${label}: held`);
    assert(!String(s.reason).startsWith('released-'), `${label}: NENHUMA entrada impossível pode produzir released-*`);
    assert(typeof s.facts.probe_error === 'string' && s.facts.probe_error !== '', `${label}: o erro deve ser NOMEADO, não silencioso`);
    noteReason(s.reason);
  }
  // O erro nomeado distingue as causas — não colapsa tudo num rótulo só.
  assertEqual(cases[0][1].facts.probe_error, 'code-dir-absent', 'code_dir ausente tem erro próprio');
  assertEqual(cases[1][1].facts.probe_error, 'vcs-baseline-absent', 'vcs_baseline ausente tem erro próprio');
});

test('R3b: measureBaseline nunca lança — um seam que explode vira erro nomeado', () => {
  const seam = { detectVcs: () => 'git', baselineId: () => { throw new Error('boom'); }, workingStatus: () => ({ ok: true, entries: [] }) };
  const m = measureBaseline('/qualquer/dir', { vcs: 'git', vcsSeam: seam });
  assertEqual(m.ok, false, 'deve devolver ok:false, não lançar');
  assert(/baseline-threw:boom/.test(m.error), `erro deve nomear a exceção, veio ${m.error}`);
});

// ════════════════════════════════════════════════════════════════════════════
// R4 — TTL é rede, nunca critério (D2): par ativa/inativa, MESMO relógio
// ════════════════════════════════════════════════════════════════════════════

const TTL_CLOCK = 1785763253000 + unitLease.DEFAULT_TTL_MS + unitLease.DEFAULT_GRACE_MS + 1;

test('R4a: run dona ATIVA com a janela vencida -> held-uncommitted (idade sozinha nunca libera)', () => {
  const { wsDir } = makeScenario('M-r4a', { active: true });
  const s = statusOf(wsDir, 'M-r4a', { now: TTL_CLOCK });
  assert(s.facts.ttl_expired === true, 'pré-condição: a janela ttl+grace venceu');
  assertEqual(s.facts.owner_active, true, 'a run dona está ativa (predicado reusado de forge-filelock)');
  assertEqual(s.reason, 'held-uncommitted', 'run viva NUNCA perde o claim para o relógio');
  noteReason(s.reason);
});

test('R4b: run dona INATIVA, MESMO at e MESMO relógio -> released-ttl-expired', () => {
  const { wsDir } = makeScenario('M-r4b', { active: false });
  const s = statusOf(wsDir, 'M-r4b', { now: TTL_CLOCK });
  assert(s.facts.ttl_expired === true, 'mesma janela vencida do par');
  assertEqual(s.facts.owner_active, false, 'a run dona está inativa');
  assertEqual(s.reason, 'released-ttl-expired', 'a rede pega a run morta');
  assertEqual(s.mechanism, 'ttl-expired', 'mecanismo ttl-expired');
  noteReason(s.reason);
});

test('R4c: o par difere SÓ na atividade da run — mesmo at, mesmo relógio, mesmo repo', () => {
  const a = makeScenario('M-r4c-ativa', { active: true });
  const b = makeScenario('M-r4c-morta', { active: false });
  const sa = statusOf(a.wsDir, 'M-r4c-ativa', { now: TTL_CLOCK });
  const sb = statusOf(b.wsDir, 'M-r4c-morta', { now: TTL_CLOCK });
  assertEqual(sa.facts.age_ms, sb.facts.age_ms, 'a idade é idêntica nos dois lados do par');
  assertEqual(sa.facts.ttl_expired, sb.facts.ttl_expired, 'a expiração é idêntica nos dois lados');
  assert(sa.reason !== sb.reason, 'e ainda assim as decisões divergem — a diferença é a run, não o relógio');
});

test('R4d: run inativa mas DENTRO da janela -> não libera (a rede não é atalho)', () => {
  const { wsDir } = makeScenario('M-r4d', { active: false });
  const s = statusOf(wsDir, 'M-r4d', { now: 1785763253000 + 10 });
  assertEqual(s.facts.ttl_expired, false, 'janela ainda aberta');
  assertEqual(s.reason, 'held-uncommitted', 'run morta com janela aberta segue mantida');
});

// ════════════════════════════════════════════════════════════════════════════
// R5 — reuso por IDENTIDADE com a origem, nunca literal duplicado
// ════════════════════════════════════════════════════════════════════════════

test('R5a: DEFAULT_TTL_MS/DEFAULT_GRACE_MS são os MESMOS de forge-unit-lease.js', () => {
  assertEqual(rel.DEFAULT_TTL_MS, unitLease.DEFAULT_TTL_MS, 'TTL deve ser o da origem, não um literal novo');
  assertEqual(rel.DEFAULT_GRACE_MS, unitLease.DEFAULT_GRACE_MS, 'grace deve ser o da origem');
  // Identidade com a ORIGEM, não com um valor: se a origem mudar, este teste
  // continua verde e o módulo acompanha — que é o ponto do reuso.
  const source = fs.readFileSync(MODULE, 'utf8');
  assert(/require\(['"]\.\/forge-unit-lease\.js['"]\)/.test(source), 'o módulo deve IMPORTAR de forge-unit-lease.js');
});

test('R5b: o predicado de run inativa é o export aditivo de forge-filelock.js', () => {
  assertEqual(typeof filelock.isHolderRunActive, 'function', 'isHolderRunActive deve ser exportado (aditivo)');
  const source = fs.readFileSync(MODULE, 'utf8');
  assert(/isHolderRunActive/.test(source) && /require\(['"]\.\/forge-filelock\.js['"]\)/.test(source),
    'o módulo deve importar isHolderRunActive, nunca reimplementá-lo');
  // Nenhuma terceira cópia: o predicado não é redefinido aqui.
  assert(!/function\s+isHolderRunActive/.test(source), 'o módulo não pode declarar sua própria cópia do predicado');
});

test('R5c: o export aditivo não muda comportamento algum de forge-filelock', () => {
  const tmp = mktmp();
  fs.mkdirSync(path.join(tmp, '.gsd'), { recursive: true });
  // Uma run inexistente responde false (diagnóstico), sem lançar — igual antes.
  assertEqual(filelock.isHolderRunActive(tmp, 'nao-existe'), false, 'run ausente -> false, sem exceção');
  assertEqual(filelock.isHolderRunActive(tmp, null), false, 'runId nulo -> false');
  assertEqual(typeof filelock.acquireFileLock, 'function', 'os exports anteriores continuam presentes');
  assertEqual(typeof filelock.DEFAULT_TTL_MS, 'number', 'os exports anteriores continuam presentes');
});

// ════════════════════════════════════════════════════════════════════════════
// R6 — conjunto fechado, cruzado nos DOIS sentidos (o segundo sentido no fim)
// ════════════════════════════════════════════════════════════════════════════

test('R6a: CLAIM_RELEASE_REASONS tem exatamente as cinco razões do contrato', () => {
  assertEqual(JSON.stringify(CLAIM_RELEASE_REASONS), JSON.stringify([
    'released-explicit', 'released-committed', 'released-ttl-expired',
    'held-probe-unavailable', 'held-uncommitted',
  ]), 'conjunto fechado, na ordem da precedência');
  assert(Object.isFrozen(CLAIM_RELEASE_REASONS), 'o conjunto deve ser congelado');
});

// ════════════════════════════════════════════════════════════════════════════
// R7 — precedência FIXA, um caso por FRONTEIRA
// ════════════════════════════════════════════════════════════════════════════

/** Fatos sintéticos completos — nenhum disco é tocado por classifyRelease. */
function facts(over) {
  return Object.assign({
    claim_present: true, explicit_release: false, code_dir: '/c', vcs: 'git',
    baseline_before: 'a', baseline_now: 'a', baseline_advanced: false,
    dirty_paths: [], paths_in_flight: false, age_ms: 0, ttl_ms: 1, grace_ms: 1,
    ttl_expired: false, owner_active: true, probe_error: null,
  }, over || {});
}

test('R7a: fronteira explicit > committed — o envelope vence a prova de commit', () => {
  const v = classifyRelease(facts({ explicit_release: true, baseline_advanced: true, paths_in_flight: false }));
  assertEqual(v.reason, 'released-explicit', 'explicit tem precedência sobre committed');
  assertEqual(v.mechanism, 'explicit', 'mecanismo explicit');
  noteReason(v.reason);
});

test('R7b: fronteira committed > ttl-expired — a prova vence a rede', () => {
  const v = classifyRelease(facts({ baseline_advanced: true, paths_in_flight: false, ttl_expired: true, owner_active: false }));
  assertEqual(v.reason, 'released-committed', 'committed tem precedência sobre ttl-expired');
});

test('R7c: fronteira ttl-expired > probe-unavailable — run morta com árvore inacessível SAI do caminho', () => {
  const v = classifyRelease(facts({
    baseline_advanced: null, paths_in_flight: null, probe_error: 'code-dir-absent',
    ttl_expired: true, owner_active: false,
  }));
  assertEqual(v.reason, 'released-ttl-expired', 'a rede vem ANTES de probe-unavailable, de propósito');
});

test('R7d: fronteira probe-unavailable > uncommitted — o null nunca vira negativa medida', () => {
  const v = classifyRelease(facts({ baseline_advanced: null, paths_in_flight: false, probe_error: null }));
  assertEqual(v.reason, 'held-probe-unavailable', 'sonda null mantém, mesmo sem probe_error explícito');
  assertEqual(v.mechanism, null, 'razão de manutenção não tem mecanismo');
});

test('R7e: piso — tudo perguntado, prova ausente -> held-uncommitted', () => {
  assertEqual(classifyRelease(facts()).reason, 'held-uncommitted', 'o piso da precedência');
});

test('R7f: null NUNCA satisfaz uma sonda (nem A, nem B)', () => {
  assertEqual(classifyRelease(facts({ baseline_advanced: null, paths_in_flight: false })).reason,
    'held-probe-unavailable', 'A null não libera');
  assertEqual(classifyRelease(facts({ baseline_advanced: true, paths_in_flight: null })).reason,
    'held-probe-unavailable', 'B null não libera');
});

test('R7g: TTL vencido com owner_active NULL não libera — "não perguntei" não é "morta"', () => {
  const v = classifyRelease(facts({ ttl_expired: true, owner_active: null, probe_error: 'x' }));
  assertEqual(v.reason, 'held-probe-unavailable', 'sem prova de inatividade a rede não age');
});

// ════════════════════════════════════════════════════════════════════════════
// R8 — --release é PEDIDO: recusa nomeada, exit 0, NADA gravado
// ════════════════════════════════════════════════════════════════════════════

test('R8a: --release não observável recusa com not-observable, exit 0, e nada é gravado', () => {
  const { wsDir, repo } = makeScenario('M-r8a');
  fs.writeFileSync(path.join(repo, 'alvo.txt'), 'sujo\n', 'utf8');
  const antes = readClaim(runs.get(wsDir, 'M-r8a'));

  const res = runCli(['--release', 'M-r8a', '--cwd', wsDir]);
  assertEqual(res.status, 0, `exit 0 = avaliado; stderr=${res.stderr}`);
  assert(/not-observable/.test(res.stdout), `a recusa deve ser NOMEADA na saída, veio: ${res.stdout}`);

  // Claim relido CAMPO A CAMPO — inalterado.
  const depois = readClaim(runs.get(wsDir, 'M-r8a'));
  assertEqual(depois.at, antes.at, 'at inalterado');
  assertEqual(depois.unit, antes.unit, 'unit inalterado');
  assertEqual(depois.source, antes.source, 'source inalterado');
  assertEqual(depois.code_dir, antes.code_dir, 'code_dir inalterado');
  assertEqual(JSON.stringify(depois.paths), JSON.stringify(antes.paths), 'paths inalterados');
  assertEqual(JSON.stringify(depois.vcs_baseline), JSON.stringify(antes.vcs_baseline), 'vcs_baseline inalterado');
  assertEqual(depois.released, null, 'NADA foi gravado: released segue null');
});

test('R8b: --release observável grava o envelope, exit 0', () => {
  const { wsDir, repo } = makeScenario('M-r8b');
  fs.writeFileSync(path.join(repo, 'alvo.txt'), 'v1\n', 'utf8');
  git(repo, ['add', 'alvo.txt']);
  git(repo, ['commit', '-q', '-m', 'commit']);

  const res = runCli(['--release', 'M-r8b', '--cwd', wsDir, '--json']);
  assertEqual(res.status, 0, `exit 0; stderr=${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assertEqual(out.released, true, 'liberado');
  assertEqual(out.reason, 'released-committed', 'razão nomeada no payload');
  assertEqual(readClaim(runs.get(wsDir, 'M-r8b')).released.mechanism, 'committed', 'envelope persistido');
});

test('R8c: --status nunca grava', () => {
  const { wsDir, repo } = makeScenario('M-r8c');
  fs.writeFileSync(path.join(repo, 'alvo.txt'), 'v1\n', 'utf8');
  git(repo, ['add', 'alvo.txt']);
  git(repo, ['commit', '-q', '-m', 'commit']);
  const res = runCli(['--status', 'M-r8c', '--cwd', wsDir, '--json']);
  assertEqual(res.status, 0, 'exit 0');
  assertEqual(JSON.parse(res.stdout).reason, 'released-committed', 'a sonda vê o release disponível');
  assertEqual(readClaim(runs.get(wsDir, 'M-r8c')).released, null, '--status NÃO grava');
});

test('R8d: invocação malformada -> exit 2; --help -> exit 0', () => {
  assertEqual(runCli([]).status, 2, 'sem comando -> 2');
  assertEqual(runCli(['--status', 'a', '--release', 'b']).status, 2, 'dois comandos -> 2');
  assertEqual(runCli(['--status', 'a', '--vcs', 'hg']).status, 2, '--vcs inválido -> 2');
  assertEqual(runCli(['--help']).status, 0, '--help -> 0');
});

test('R8e: claim já liberado -> released-explicit, sem regravar', () => {
  const { wsDir, repo } = makeScenario('M-r8e');
  fs.writeFileSync(path.join(repo, 'alvo.txt'), 'v1\n', 'utf8');
  git(repo, ['add', 'alvo.txt']);
  git(repo, ['commit', '-q', '-m', 'commit']);
  releaseIfObservable(wsDir, 'M-r8e');
  const primeiro = JSON.stringify(readClaim(runs.get(wsDir, 'M-r8e')).released);

  const segundo = releaseIfObservable(wsDir, 'M-r8e');
  assertEqual(segundo.reason, 'released-explicit', 'o envelope presente é reconhecido');
  assertEqual(segundo.already_released, true, 'marcado como já liberado');
  assertEqual(segundo.released, false, 'nada de novo foi gravado');
  assertEqual(JSON.stringify(readClaim(runs.get(wsDir, 'M-r8e')).released), primeiro, 'envelope idêntico ao primeiro');
});

test('R8f: claim ausente mantém — e o erro é NOMEADO (nunca confundido com liberado)', () => {
  const { wsDir } = makeWorkspace('M-r8f');
  const s = statusOf(wsDir, 'M-r8f');
  assertEqual(s.claim_present, false, 'nunca houve claim');
  assertEqual(s.still_held, false, 'isHeld(null) é false — mas por razão DIFERENTE de released');
  assertEqual(s.reason, 'held-probe-unavailable', 'sem claim não há o que medir: mantém');
  assertEqual(s.facts.probe_error, 'claim-absent', 'o erro distingue ausência de liberação');
});

// ════════════════════════════════════════════════════════════════════════════
// R9 — o evento é lido DO ARQUIVO
// ════════════════════════════════════════════════════════════════════════════

function lastEvent(wsDir) {
  const file = path.join(wsDir, '.gsd', 'forge', 'events.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter((l) => l !== '');
  return JSON.parse(lines[lines.length - 1]);
}

test('R9a: release liberado emite claim-release no events.jsonl, lido do arquivo', () => {
  const { wsDir, repo } = makeScenario('M-r9a');
  fs.writeFileSync(path.join(repo, 'alvo.txt'), 'v1\n', 'utf8');
  git(repo, ['add', 'alvo.txt']);
  git(repo, ['commit', '-q', '-m', 'commit']);
  const r = releaseIfObservable(wsDir, 'M-r9a');
  assertEqual(r.event_written, true, 'o evento deve ter sido escrito');

  const ev = lastEvent(wsDir);
  assertEqual(ev.event, 'claim-release', 'nome do evento');
  assertEqual(ev.run, 'M-r9a', 'run');
  assertEqual(ev.unit, 'execute-task/T02', 'unit');
  assertEqual(ev.held, false, 'held');
  assertEqual(ev.reason, 'released-committed', 'reason');
  assertEqual(ev.mechanism, 'committed', 'mechanism');
  assertEqual(ev.code_dir, repo, 'code_dir');
  assertEqual(ev.probes.baseline_advanced, true, 'probes carrega a sonda A');
  assertEqual(ev.probes.paths_in_flight, false, 'probes carrega a sonda B');
  assert(typeof ev.ts === 'string' && ev.ts.length > 0, 'ts presente');
});

test('R9b: pedido RECUSADO também emite — silêncio aqui seria o defeito que a milestone combate', () => {
  const { wsDir, repo } = makeScenario('M-r9b');
  fs.writeFileSync(path.join(repo, 'alvo.txt'), 'sujo\n', 'utf8');
  releaseIfObservable(wsDir, 'M-r9b');
  const ev = lastEvent(wsDir);
  assertEqual(ev.event, 'claim-release', 'o evento existe mesmo na recusa');
  assertEqual(ev.held, true, 'held: true');
  assertEqual(ev.reason, 'held-uncommitted', 'a razão da recusa viaja no evento');
  assertEqual(ev.mechanism, null, 'sem mecanismo numa recusa');
});

test('R9c: falha de escrita do evento nunca derruba a decisão, e não esconde que falhou', () => {
  // Um cwd impossível: o append falha, mas a função devolve o erro NOMEADO.
  const bogus = path.join(mktmp(), 'arquivo-nao-diretorio');
  fs.writeFileSync(bogus, 'x', 'utf8');
  const out = emitReleaseEvent(bogus, { run: 'r', held: true, reason: 'held-uncommitted' });
  assertEqual(out.event_written, false, 'a escrita falhou');
  assert(typeof out.event_error === 'string' && out.event_error !== '', 'e o erro é reportado, não engolido');
});

// ════════════════════════════════════════════════════════════════════════════
// R10 — classifyRelease é PURA (sem disco, sem git)
// ════════════════════════════════════════════════════════════════════════════

test('R10: classifyRelease decide com fatos sintéticos, sem fixture e sem tocar o disco', () => {
  const tmp = mktmp();
  const antes = fs.readdirSync(tmp);
  // Nenhum cwd, nenhum runId, nenhum path que exista: só fatos.
  const v = classifyRelease({ explicit_release: false, baseline_advanced: true, paths_in_flight: false, probe_error: null });
  assertEqual(v.reason, 'released-committed', 'decide só com os fatos dados');
  assertEqual(JSON.stringify(fs.readdirSync(tmp)), JSON.stringify(antes), 'nada foi escrito no disco');
  // E é total: qualquer entrada, inclusive vazia, produz uma razão do conjunto.
  for (const input of [{}, null, undefined, { probe_error: 'x' }]) {
    const r = classifyRelease(input);
    assert(CLAIM_RELEASE_REASONS.includes(r.reason), `razão fora do conjunto fechado: ${r.reason}`);
  }
});

test('R10b: probeClaim é a ÚNICA função com I/O — measureBaseline delega tudo ao seam', () => {
  const calls = [];
  const seam = {
    detectVcs: (d) => { calls.push('detectVcs'); return 'git'; },
    baselineId: () => { calls.push('baselineId'); return { ok: true, id: 'z' }; },
    workingStatus: () => { calls.push('workingStatus'); return { ok: true, entries: [] }; },
  };
  const m = measureBaseline('/dir', { vcsSeam: seam });
  assertEqual(m.ok, true, 'o seam responde');
  assertEqual(m.vcs, 'git', 'vcs resolvido por detectVcs quando não dado');
  assertEqual(JSON.stringify(calls), JSON.stringify(['detectVcs', 'baselineId']), 'nenhuma chamada além do seam');
});

// ── R6 (segundo sentido): toda entrada do conjunto foi emitida por ≥1 teste ──
test('R6b: cruzamento no segundo sentido — toda razão do conjunto foi observada', () => {
  for (const reason of CLAIM_RELEASE_REASONS) {
    assert(reasonsSeen.has(reason), `razão declarada mas NUNCA emitida por nenhum teste: ${reason}`);
  }
  for (const reason of reasonsSeen) {
    assert(CLAIM_RELEASE_REASONS.includes(reason), `razão emitida fora do conjunto fechado: ${reason}`);
  }
});

// ── Encerramento ────────────────────────────────────────────────────────────
cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
