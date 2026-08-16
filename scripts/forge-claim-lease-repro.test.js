#!/usr/bin/env node
'use strict';

// forge-claim-lease-repro.test.js — o incidente que originou a milestone, rodado
// ponta a ponta PELAS CLIs REAIS (S05/T05).
//
// ── Por que por spawn, e não por require ───────────────────────────────────
//
// As quatro tasks anteriores provaram peças ISOLADAS, cada uma chamando a
// função dona em processo. Isso é necessário e não é suficiente: um repro que
// passa chamando internals não prova que o OPERADOR consegue reproduzir. Aqui
// tudo passa por `spawnSync` das CLIs reais — `forge-claim-gate.js`,
// `forge-claim-release.js`, `forge-write-claim.js` — com `--cwd` apontando para
// o WORKSPACE da fixture e `--code-dir` para o repo git, que é a separação que o
// gate exige (B2) e que nenhuma chamada em processo exercita.
//
// ── As quatro fases ────────────────────────────────────────────────────────
//
//   F1  run A escreve e NÃO commita  -> B é recusada (block|defer), cause overlap
//   F2  ÚNICO delta = `git commit`   -> a MESMA invocação de B vira proceed,
//                                       e A sai do universo com skip NOMEADO
//   F4  claim vencido, A ATIVA       -> B SEGUE bloqueada  (controle negativo)
//   F3  mesmo relógio, A INATIVA     -> o TTL libera, com a expiração NOMEADA
//                                       lida do events.jsonl
//
// F4 roda ANTES de F3, sobre a MESMA fixture e o MESMO relógio: sem ele um TTL
// que liberasse tudo passaria nas outras três fases. É a exigência de D2 — o
// relógio é rede, nunca critério de posse.
//
// ── Fronteira desta repro, declarada e não omitida ─────────────────────────
//
// O eixo GIT é real (repositórios de verdade, `git` por `execFileSync`). O eixo
// SVN NÃO é exercitado aqui e não depende de `svn` instalado: ele é coberto pela
// suíte da T02 através do seam público de `forge-vcs.js` (`baselineId`,
// `workingStatus`), que é o mesmo ponto por onde o git passa. Esta repro roda em
// win32 sem nenhum binário além de `git` e `node`.
//
// ── Achado MEDIDO nesta task, e por que ele não vira assert de fantasia ────
//
// `claim-released:ttl-expired` NÃO é alcançável pelo caminho real do gate:
// `collectRunClaims` pula toda run com `active !== true` (skip `run-inactive`)
// ANTES de qualquer sonda de release, e `isHolderRunActive` — o predicado que a
// rede do TTL exige INATIVO — lê exatamente o mesmo campo `active`. As duas
// condições são mutuamente exclusivas por construção. Logo, na F3, o `proceed`
// de B é explicado pela INATIVIDADE de A, e a expiração nomeada vive na linha
// `claim-release` do `events.jsonl` (escrita pela CLI de release, que é onde a
// T04 pendurou o release: fronteira de unidade). Este arquivo assere as duas
// coisas SEPARADAMENTE e não finge que a linha `claim-gate` carrega o que ela
// não pode carregar. Ressuscitar a run para fabricar um assert verde seria
// exatamente o defeito que esta milestone existe para fechar.
//
// Zero deps. Runner standalone, convenção do repo: exit != 0 em falha.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const GATE_CLI = path.join(__dirname, 'forge-claim-gate.js');
const RELEASE_CLI = path.join(__dirname, 'forge-claim-release.js');
const WRITE_CLAIM_CLI = path.join(__dirname, 'forge-write-claim.js');
const RELEASE_MODULE = path.join(__dirname, 'forge-claim-release.js');
const SPEC = path.join(__dirname, '..', 'shared', 'forge-claim-gate.md');

const { CLAIM_RELEASE_REASONS, DEFAULT_TTL_MS, DEFAULT_GRACE_MS } = require('./forge-claim-release.js');
const { GATE_SKIP_REASONS, GATE_DECISIONS, GATE_CAUSES } = require('./forge-claim-gate.js');

// ── Runner ─────────────────────────────────────────────────────────────────
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
    throw new Error(`${msg || 'divergência'}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
  }
}

// ── Fixture ────────────────────────────────────────────────────────────────

const tmps = [];
function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-lease-repro-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** `git` com `cwd` explícito — nunca herdando o diretório do processo (Windows). */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Repo git real com `src/a.js` JÁ COMMITADO — para que a escrita de A seja `modified`. */
function makeRepo(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['checkout', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
  git(dir, ['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'module.exports = 1;\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

/** Registry real de runs — molde de `forge-claim-gate.test.js::makeFixture`. */
function registerRun(ws, id, opts) {
  const o = opts || {};
  const file = path.join(ws, '.gsd', 'forge', 'runs', `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    kind: 'milestone',
    id,
    session_id: `sess-${id}`,
    active: o.active === undefined ? true : o.active,
    started_at: 1785763253000,
    last_heartbeat: 1785763253000,
    worker: null,
    worker_started: null,
    isolation_mode: 'worktree',
    milestone_dir: `.gsd/milestones/${id}/`,
    cwd: ws,
  }, null, 2), 'utf8');
  return file;
}

function runFile(ws, id) {
  return path.join(ws, '.gsd', 'forge', 'runs', `${id}.json`);
}
function readRun(ws, id) {
  return JSON.parse(fs.readFileSync(runFile(ws, id), 'utf8'));
}
function patchRun(ws, id, patch) {
  const rec = Object.assign(readRun(ws, id), patch);
  fs.writeFileSync(runFile(ws, id), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}
/** Envelhece o claim: o "relógio adiantado" da fase 3/4, como DADO da fixture. */
function ageClaim(ws, id, ms) {
  const rec = readRun(ws, id);
  rec.write_claim.at = Date.now() - ms;
  fs.writeFileSync(runFile(ws, id), JSON.stringify(rec, null, 2), 'utf8');
  return rec.write_claim.at;
}

/** Um T##-PLAN.md de verdade, com `must_haves` estruturado (senão vira legacy). */
function writePlan(ws, taskId, file) {
  const rel = `.gsd/milestones/M-repro/slices/S01/tasks/${taskId}/${taskId}-PLAN.md`;
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, [
    '---', `id: ${taskId}`, 'writes:', `  - "${file}"`,
    'must_haves:', '  truths:', '    - "a task escreve o arquivo"',
    '  artifacts:', `    - path: "${file}"`, '      provides: "algo"', '      min_lines: 1',
    '  key_links: []',
    'expected_output: []', '---', '', `# ${taskId}`, '',
  ].join('\n'), 'utf8');
  return rel;
}

function cli(module, args) {
  const r = spawnSync(process.execPath, [module, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** Roda a CLI e devolve o JSON DO STDOUT DO PROCESSO — nunca um require. */
function cliJson(module, args) {
  const r = cli(module, args);
  assertEqual(r.status, 0, `CLI ${path.basename(module)} deveria avaliar (stderr: ${r.stderr})`);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch (e) {
    throw new Error(`stdout não-JSON de ${path.basename(module)}: ${r.stdout.slice(0, 200)}`);
  }
  return parsed;
}

/** Linhas do events.jsonl da fixture, filtradas por evento — LIDAS DO ARQUIVO. */
function readEvents(ws, eventName) {
  const file = path.join(ws, '.gsd', 'forge', 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
    .filter((l) => !eventName || l.event === eventName);
}

const RUN_A = 'M-run-a';
const RUN_B = 'M-run-b';

/**
 * Fixture completa e no MESMO estado inicial das duas metades da repro:
 * workspace real com registry real, repo git real, claim de A gravado PELA CLI
 * do gate (baseline medido no instante do claim) e `src/a.js` sujo, não commitado.
 */
function buildFixture() {
  const tmp = mktmp();
  const ws = path.join(tmp, 'ws');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(ws, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');
  makeRepo(repo);

  // A é registrada e reivindica ANTES de B existir: assim o próprio gate de A
  // não confronta ninguém e o único claim em jogo na F1 é o dela.
  registerRun(ws, RUN_A, { active: true });
  const aGate = cliJson(GATE_CLI, [
    '--claim-and-check', '--paths', 'src/a.js', '--run', RUN_A,
    '--unit', 'execute-task/T01', '--code-dir', repo, '--cwd', ws, '--json',
  ]);

  // A escreve — e NÃO commita.
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 2; // trabalho de A\n', 'utf8');

  registerRun(ws, RUN_B, { active: true });
  const planRel = writePlan(ws, 'T01', 'src/a.js');

  // A invocação de B, LITERAL e reusada byte a byte entre F1 e F2.
  const bArgs = [
    '--claim-and-check', '--plan', planRel, '--run', RUN_B,
    '--unit', 'execute-task/T01', '--code-dir', repo, '--cwd', ws, '--json',
  ];
  return { tmp, ws, repo, aGate, planRel, bArgs };
}

// ══════════════════════════════════════════════════════════════════════════
// F1 + F2 — a única diferença entre "recusada" e "passa" é o commit
// ══════════════════════════════════════════════════════════════════════════
console.log('\nF1/F2: o incidente e o commit que o encerra — mesma fixture, mesma invocação');

const fx = buildFixture();
let f1 = null;
let f2 = null;

test('F0: o claim de A foi gravado pela CLI com o baseline MEDIDO no instante do claim', () => {
  const claim = cliJson(WRITE_CLAIM_CLI, ['--show', RUN_A, '--cwd', fx.ws, '--json']);
  assert(claim !== null, 'o claim de A tem de estar persistido — cerca invisível não cerca');
  assertEqual(claim.code_dir, fx.repo, '--code-dir é fato DADO, gravado verbatim');
  assert(claim.vcs_baseline && claim.vcs_baseline.vcs === 'git' && /^[0-9a-f]{40}$/.test(claim.vcs_baseline.id),
    `o baseline "antes" precisa existir e ser um sha real, veio ${JSON.stringify(claim.vcs_baseline)}`);
  assertEqual(claim.released, null, 'nascer liberado tornaria toda a repro vazia');
  // A separação workspace × code_dir: o registry vive no WORKSPACE, não no repo.
  assert(fs.existsSync(runFile(fx.ws, RUN_A)), 'o registry vive sob --cwd (workspace)');
  assert(!fs.existsSync(path.join(fx.repo, '.gsd')), 'nada de .gsd é criado dentro do CODE_DIR');
});

test('F1: A escreveu e NÃO commitou -> B é recusada, com cause overlap, lida do stdout do processo', () => {
  f1 = cliJson(GATE_CLI, fx.bArgs);
  assert(['block', 'defer'].includes(f1.decision),
    `a decisão precisa ser bloqueante, veio ${f1.decision}`);
  assertEqual(f1.cause, 'overlap', 'a colisão é MEDIDA — nunca reportada como undeclared-writes');
  assert(f1.paths.includes('src/a.js'), `o path em disputa é nomeado, veio ${JSON.stringify(f1.paths)}`);
  assertEqual(f1.census.counterparts_in_scope, 1, 'A tem de estar EM ESCOPO — mesmo code_dir medido');
  assertEqual(f1.released_counterparts.length, 0, 'nada foi liberado ainda');
  assert(!f1.census.skipped.some((s) => String(s.reason).startsWith('claim-released:')),
    'nenhum skip de release na F1 — o simétrico da F2 sobre a MESMA fixture');
});

test('F2: ÚNICO delta = git commit -> a MESMA invocação passa, e A sai com skip NOMEADO', () => {
  const headBefore = git(fx.repo, ['rev-parse', 'HEAD']).trim();
  git(fx.repo, ['add', 'src/a.js']);
  git(fx.repo, ['commit', '-q', '-m', 'A commita seu trabalho']);
  const headAfter = git(fx.repo, ['rev-parse', 'HEAD']).trim();
  assert(headBefore !== headAfter, 'o commit precisa ter acontecido de verdade');
  assertEqual(git(fx.repo, ['status', '--porcelain']).trim(), '', 'depois do commit a árvore está limpa');

  f2 = cliJson(GATE_CLI, fx.bArgs); // args LITERALMENTE os mesmos da F1
  assertEqual(f2.decision, 'proceed', 'depois do commit de A, B passa');
  assertEqual(f2.census.counterparts_in_scope, 0, 'A saiu do universo');
  const rel = f2.released_counterparts.find((r) => r.id === RUN_A);
  assert(rel, `A precisa aparecer em released_counterparts, veio ${JSON.stringify(f2.released_counterparts)}`);
  assertEqual(rel.mechanism, 'committed');
  assertEqual(rel.reason, 'released-committed');
  assert(f2.census.skipped.some((s) => s.id === RUN_A && s.reason === 'claim-released:committed'),
    `o skip precisa ser NOMEADO no censo, veio ${JSON.stringify(f2.census.skipped)}`);
  assert(!f2.census.notes.some((n) => n.id === RUN_A && n.reason === 'claim-absent'),
    'um claim liberado JAMAIS pode virar claim-absent (contrato #6) — release não é undeclared-writes');
});

test('F1×F2: o delta entre as duas é o commit e NADA MAIS — args idênticos, fixture idêntica', () => {
  assert(f1 && f2, 'as duas fases precisam ter rodado');
  assert(f1.decision !== f2.decision, 'sem mudança de decisão a repro não prova nada');
  assertEqual(f1.run, f2.run, 'mesma run própria');
  assertEqual(JSON.stringify(f1.claim.paths), JSON.stringify(f2.claim.paths), 'mesmo claim derivado do MESMO plano');
  assertEqual(f1.claim.code_dir, f2.claim.code_dir, 'mesmo code_dir');
  assertEqual(f1.census.counterparts_considered, f2.census.counterparts_considered,
    'o universo considerado é o mesmo: o que mudou foi o que a sonda MEDIU nele');
});

test('F2b: a linha claim-gate da F2 no events.jsonl carrega o counterpart liberado, lida do arquivo', () => {
  const gateLines = readEvents(fx.ws, 'claim-gate').filter((l) => l.run === RUN_B);
  assert(gateLines.length >= 2, `as duas avaliações de B precisam ter deixado evento, vieram ${gateLines.length}`);
  const last = gateLines[gateLines.length - 1];
  assertEqual(last.decision, 'proceed');
  assert((last.released_counterparts || []).some((r) => r.id === RUN_A && r.mechanism === 'committed'),
    'o evento precisa registrar QUEM saiu e por qual mecanismo');
  const first = gateLines[gateLines.length - 2];
  assertEqual(first.cause, 'overlap', 'o simétrico: a linha da F1 registra a colisão');
});

// ══════════════════════════════════════════════════════════════════════════
// MORDIDA contra o MÓDULO REAL — sem ela a F2 poderia estar verde por acidente
// ══════════════════════════════════════════════════════════════════════════
console.log('\nMordida: neutralizar a conjunção das duas sondas deixa a F2 VERMELHA');
{
  test('BITE: com a prova de commit neutralizada no módulo REAL, a F2 volta a bloquear', () => {
    const original = fs.readFileSync(RELEASE_MODULE, 'utf8');
    const hashBefore = sha256(RELEASE_MODULE);
    const needle = 'if (f.baseline_advanced === true && f.paths_in_flight === false) {';
    assertEqual(original.split(needle).length - 1, 1,
      'a mordida precisa casar EXATAMENTE a conjunção — 0 ou 2 casamentos a tornariam vazia');

    // Fixture NOVA, e isso é o ponto: desde S05/review R3 o gate PERSISTE o
    // veredito `committed` que corroborou, então a `fx` da F2 já carrega o
    // envelope e uma reavaliação ali sairia por `released-explicit` — a prova
    // neutralizada nunca seria consultada e a mordida ficaria VAZIA (verde por
    // ausência de premissa, não por mérito). A mordida precisa de um mundo onde
    // nenhuma avaliação anterior persistiu nada.
    const bfx = buildFixture();
    git(bfx.repo, ['add', 'src/a.js']);
    git(bfx.repo, ['commit', '-q', '-m', 'A commita seu trabalho']);
    assertEqual(git(bfx.repo, ['status', '--porcelain']).trim(), '', 'a fixture da mordida está commitada');
    assertEqual(readRun(bfx.ws, RUN_A).write_claim.released, null,
      'a fixture da mordida NÃO pode nascer com envelope — senão a mordida é vazia');

    let bitten = null;
    try {
      fs.writeFileSync(RELEASE_MODULE, original.replace(needle, 'if (false) {'), 'utf8');
      bitten = cliJson(GATE_CLI, bfx.bArgs);
    } finally {
      fs.writeFileSync(RELEASE_MODULE, original, 'utf8');
    }
    assertEqual(sha256(RELEASE_MODULE), hashBefore,
      'o módulo real precisa voltar byte-idêntico — sha256 conferido, não presumido');

    assert(bitten && bitten.decision !== 'proceed',
      `com a prova neutralizada a F2 tem de ficar vermelha, veio ${bitten && bitten.decision}`);
    assertEqual(bitten.cause, 'overlap');
    assertEqual(bitten.released_counterparts.length, 0, 'sem prova, ninguém sai do universo');
    assertEqual(readRun(bfx.ws, RUN_A).write_claim.released, null,
      'sem veredito corroborado, NADA pode ter sido persistido no claim alheio');

    // E o módulo restaurado volta a decidir como antes — controle positivo da restauração.
    assertEqual(cliJson(GATE_CLI, bfx.bArgs).decision, 'proceed',
      'restaurado, o mesmo comando volta a passar');
  });

  // ── S05/review R3, sobre git REAL: o veredito vivo virou registro ─────────
  test('R3: o `committed` que a F2 corroborou foi PERSISTIDO no claim de A (release monotônico)', () => {
    const claimA = readRun(fx.ws, RUN_A).write_claim;
    assert(claimA.released, 'o envelope tem de existir — sem persistência o release re-bloqueia na próxima unidade');
    assertEqual(claimA.released.mechanism, 'committed');
    assertEqual(claimA.released.evidence.observed_by, 'claim-gate',
      'a origem do envelope é nomeada: quem observou foi o gate de B, não o dono');
    assertEqual(claimA.paths.includes('src/a.js'), true, 'persistir NUNCA apaga o claim — só acrescenta o envelope');
    const rel = f2.released_counterparts.find((r) => r.id === RUN_A);
    assertEqual(rel.persisted, true, 'o resultado diz que o REGISTRO passou a concordar com o veredito');

    // A monotonicidade, medida: sujar o path de novo (trabalho NÃO relacionado)
    // não pode ressuscitar o bloqueio — que era exatamente a objeção R3.
    fs.writeFileSync(path.join(fx.repo, 'src', 'a.js'), '// trabalho novo, alheio ao claim de A\n', 'utf8');
    assert(git(fx.repo, ['status', '--porcelain']).trim() !== '', 'a árvore precisa estar suja de novo');
    const after = cliJson(GATE_CLI, fx.bArgs);
    assertEqual(after.decision, 'proceed',
      'REGRESSÃO R3: o path sujo re-bloqueou um counterpart já provado committed — release não-monotônico');
    const rel2 = after.released_counterparts.find((r) => r.id === RUN_A);
    assertEqual(rel2.mechanism, 'explicit', 'a segunda avaliação sai pelo ENVELOPE persistido, não por sondar de novo');
  });
}

// ══════════════════════════════════════════════════════════════════════════
// F4 + F3 — o relógio é REDE, nunca critério de posse (D2)
// ══════════════════════════════════════════════════════════════════════════
console.log('\nF4/F3: mesmo relógio, duas respostas — o que decide é a run estar viva');

const fx2 = buildFixture();
const AGED_MS = DEFAULT_TTL_MS + DEFAULT_GRACE_MS + 60000;
const agedAt = ageClaim(fx2.ws, RUN_A, AGED_MS);
let f4status = null;
let f3status = null;

test('F4 (controle negativo): claim vencido + run A ATIVA -> claim MANTIDO e B segue bloqueada', () => {
  assertEqual(readRun(fx2.ws, RUN_A).active, true, 'a fase 4 exige A viva');
  f4status = cliJson(RELEASE_CLI, ['--status', RUN_A, '--cwd', fx2.ws, '--json']);
  assertEqual(f4status.facts.ttl_expired, true, 'a janela ttl+grace precisa estar vencida — senão o controle é vazio');
  assertEqual(f4status.facts.owner_active, true, 'A está ativa');
  assertEqual(f4status.held, true, 'uma run viva NUNCA perde o claim para o relógio (D2)');
  assertEqual(f4status.reason, 'held-uncommitted');

  const b = cliJson(GATE_CLI, fx2.bArgs);
  assert(['block', 'defer'].includes(b.decision), `B segue bloqueada, veio ${b.decision}`);
  assertEqual(b.cause, 'overlap');
  assertEqual(b.census.counterparts_in_scope, 1, 'A continua em escopo — nada expirou');
});

test('F4b: o pedido de release é RECUSADO e nada é gravado enquanto A está viva', () => {
  const r = cliJson(RELEASE_CLI, ['--release', RUN_A, '--cwd', fx2.ws, '--json']);
  assertEqual(r.released, false);
  assertEqual(r.refusal, 'not-observable', 'a recusa é NOMEADA');
  assertEqual(readRun(fx2.ws, RUN_A).write_claim.released, null, 'nada foi gravado no claim');
});

test('F3: ÚNICO delta = A marcada inativa (mesmo relógio) -> TTL libera, expiração NOMEADA', () => {
  patchRun(fx2.ws, RUN_A, { active: false });
  assertEqual(readRun(fx2.ws, RUN_A).write_claim.at, agedAt, 'o relógio da F3 é o MESMO da F4');

  f3status = cliJson(RELEASE_CLI, ['--release', RUN_A, '--cwd', fx2.ws, '--json']);
  assertEqual(f3status.released, true, 'com a run morta a rede tem de recolher o claim');
  assertEqual(f3status.reason, 'released-ttl-expired');
  assertEqual(f3status.mechanism, 'ttl-expired');
  assertEqual(f3status.facts.owner_active, false, 'o delta medido é a inatividade');
  assertEqual(f3status.facts.ttl_expired, true);
  // O simétrico, sobre a MESMA fixture: F4 disse held com os MESMOS fatos de relógio.
  assertEqual(f4status.facts.ttl_expired, f3status.facts.ttl_expired,
    'a idade é idêntica nas duas fases — o que mudou foi a posse, não o relógio');
  assert(f4status.held !== f3status.held, 'sem inversão de veredito o par não prova nada');

  const envelope = readRun(fx2.ws, RUN_A).write_claim.released;
  assert(envelope && envelope.mechanism === 'ttl-expired', 'o envelope persistido nomeia o mecanismo');
});

test('F3b: a expiração NOMEADA está no events.jsonl da fixture, lida do arquivo', () => {
  const lines = readEvents(fx2.ws, 'claim-release').filter((l) => l.run === RUN_A);
  assert(lines.length >= 2, `o pedido recusado (F4b) e o concedido (F3) deixam evento, vieram ${lines.length}`);
  const last = lines[lines.length - 1];
  assertEqual(last.reason, 'released-ttl-expired', 'a expiração é NOMEADA no evento, não inferida');
  assertEqual(last.mechanism, 'ttl-expired');
  assertEqual(last.held, false);
  const refused = lines[lines.length - 2];
  assertEqual(refused.held, true, 'o simétrico: o pedido recusado também deixou linha');
  assertEqual(refused.reason, 'held-uncommitted');
});

test('F3c: B passa — e o censo diz POR QUE, sem atribuir ao release o que a inatividade fez', () => {
  const b = cliJson(GATE_CLI, fx2.bArgs);
  assertEqual(b.decision, 'proceed', 'com A morta e o claim recolhido, B passa');
  assertEqual(b.reason, 'no-active-counterpart');
  // O achado medido, asserido em vez de narrado: uma run inativa é pulada como
  // `run-inactive` ANTES de qualquer sonda de release, então o `proceed` de B
  // NÃO é obra do TTL. `claim-released:ttl-expired` continua sendo o registro
  // correto do que aconteceu — na linha `claim-release`, escrita pela CLI de
  // release na fronteira de unidade (T04), que é onde a rede realmente atua.
  assert(b.census.skipped.some((s) => s.id === RUN_A && s.reason === 'run-inactive'),
    `A precisa aparecer pulada por inatividade, veio ${JSON.stringify(b.census.skipped)}`);
  assertEqual(b.released_counterparts.length, 0,
    'nenhum release é atribuído ao gate nesta fase — a sonda nem foi feita');
});

// ══════════════════════════════════════════════════════════════════════════
// O spec — a afirmação de over-block não pode ter sobrevivido à S05
// ══════════════════════════════════════════════════════════════════════════
console.log('\nSPEC: § Release lifecycle substituiu a afirmação de over-block (com controle positivo)');
{
  // Predicado ÚNICO, aplicado ao arquivo real E ao texto pré-S05 embutido: um
  // predicado que só é rodado contra o alvo que se espera limpo é um detector
  // que nunca foi visto morder.
  const FORBIDDEN = [
    { re: /claims are not released/i, what: 'a afirmação de que claims nunca são liberados' },
    { re: /§ Over-block/, what: 'a referência à seção § Over-block' },
    { re: /Over-block between S04 and S05/, what: 'o título da seção de over-block' },
    { re: /em S04 o claim NÃO é liberado pelo commit/, what: 'o aviso do § Step 4' },
  ];
  const REQUIRED = /^## Release lifecycle/m;

  // Literal PRÉ-S05 (extraído do que a T04 removeu) — o controle positivo.
  const PRE_S05 = [
    '### Over-block between S04 and S05 is design, not a bug',
    '',
    'Between this gate going live (S04) and release-on-commit (S05), **claims are not released**. A',
    'counterpart that already committed and finished still holds its claim.',
    '',
    '   1. Aguardar o commit da run counterpart e re-rodar esta unidade.',
    '      (Atenção: em S04 o claim NÃO é liberado pelo commit — ver § Over-block abaixo.)',
  ].join('\n');

  function offendersIn(text) {
    return FORBIDDEN.filter((f) => f.re.test(text)).map((f) => f.what);
  }

  test('SPEC-a: o arquivo real NÃO carrega mais nenhuma das afirmações de over-block', () => {
    const text = fs.readFileSync(SPEC, 'utf8');
    const hits = offendersIn(text);
    assertEqual(hits.length, 0, `o spec ainda afirma over-block: ${hits.join('; ')}`);
  });

  test('SPEC-b: o arquivo real contém o § Release lifecycle', () => {
    const text = fs.readFileSync(SPEC, 'utf8');
    assert(REQUIRED.test(text), 'o § Release lifecycle precisa existir — remover a afirmação sem pôr o contrato no lugar é meia entrega');
  });

  test('SPEC-c: CONTROLE POSITIVO — o MESMO predicado acusa os 4 padrões no texto pré-S05', () => {
    const hits = offendersIn(PRE_S05);
    assertEqual(hits.length, FORBIDDEN.length,
      `todo padrão precisa morder no texto antigo (senão é detector cego), acusou ${hits.length} de ${FORBIDDEN.length}`);
    assert(!REQUIRED.test(PRE_S05), 'o texto antigo não tem § Release lifecycle — a checagem de presença também morde');
  });

  test('SPEC-d: o spec real linka a CLI de release (o contrato aponta para código que existe)', () => {
    const text = fs.readFileSync(SPEC, 'utf8');
    assert(text.includes('forge-claim-release.js'), 'o § Release lifecycle sem a CLI seria contrato sem implementação');
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Conjuntos fechados — direção 1 sobre TUDO que esta repro observou
// ══════════════════════════════════════════════════════════════════════════
console.log('\nSETS: nada que esta repro observou cai fora dos conjuntos fechados');
{
  test('SETS-a: razões de release observadas ⊂ CLAIM_RELEASE_REASONS', () => {
    const seen = [f4status.reason, f3status.reason].filter(Boolean);
    assert(seen.length >= 2, 'as duas fases do par precisam ter razão');
    for (const r of seen) {
      assert(CLAIM_RELEASE_REASONS.includes(r), `razão fora do conjunto fechado: ${r}`);
    }
  });

  test('SETS-b: decisões, causas e skips observados ⊂ conjuntos do gate', () => {
    const results = [f1, f2].filter(Boolean);
    for (const r of results) {
      assert(GATE_DECISIONS.includes(r.decision), `decisão fora do conjunto: ${r.decision}`);
      if (r.cause) assert(GATE_CAUSES.includes(r.cause), `causa fora do conjunto: ${r.cause}`);
      for (const s of r.census.skipped) {
        if (s.reason === 'run-inactive') continue; // vem do conjunto da S03, não do gate
        assert(GATE_SKIP_REASONS.includes(s.reason), `skip fora do conjunto: ${s.reason}`);
      }
    }
  });
}

// ── Fecho ──────────────────────────────────────────────────────────────────
cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFalhas:');
  for (const f of failures) console.log(`  · ${f.name}: ${f.error}`);
  process.exit(1);
}
