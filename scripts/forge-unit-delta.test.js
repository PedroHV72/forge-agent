#!/usr/bin/env node
'use strict';

// forge-unit-delta.test.js — the attribution axis, proved in both directions.
//
// The property this suite exists for is B1: two different milestones carrying
// the SAME `(S04/T01)` pair must come out as two units with disjoint file
// sets, never merged. That is not a hypothetical — 136 of the 154 `(S##/T##)`
// commits in this repo's history belong to pairs that recur across
// milestones, `S04/T01` alone eleven times. So:
//
//   R1  the bait fixture: two `forge/M-*` branches, same pair, distinct files
//   R2  the census reconciles per ref: walked === attributed + unattributed
//   R3  DELTA_REASONS is cross-checked BOTH WAYS against what the code emits
//   R4  a loose-task ref (`forge/T-*`) attributes its whole range, no scope
//   R5  svn: real `svnadmin create` working copy, or a NAMED skip
//   R6  ambiguity on the svn side is refused, never wildcarded
//   R7  MORDIDA: the ref axis is reverted on a throwaway copy of the module
//       and R1's assert is observed RED. A test never seen failing is not
//       coverage (TASK-021).
//
// Every fixture lives in a tmpdir. Zero deps. Repo convention: exit != 0 on
// failure; skips are printed by name, never silent.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-unit-delta.js');
const delta = require('./forge-unit-delta.js');
const {
  listUnitRefs, commitsForRef, attributeCommits, attributeSvnRevisions,
  writtenByUnit, unitKeyFor, DELTA_REASONS,
} = delta;

// ── Runner ─────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
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
function skip(name, reason) {
  skipped++;
  console.log(`  ⊘ ${name} — SKIP (${reason})`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
}
function assertDeep(actual, expected, msg) {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'mismatch'}: esperado ${b}, veio ${a}`);
}

// Reasons observed firing during this run — cross-checked against the declared
// set at the end (R3). Collected, not predicted.
const reasonsSeen = new Set();
function observe(list) {
  for (const r of (list || [])) if (r && r.reason) reasonsSeen.add(r.reason);
}

// ── git fixture helpers ────────────────────────────────────────────────────
function g(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function commitFile(repo, file, content, msg) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  g(repo, ['add', '--', file]);
  g(repo, ['commit', '-m', msg]);
}

const ID_A = 'M-20990101000000-aaa';
const ID_B = 'M-20990102000000-bbb';
const ID_C = 'M-20990103000000-ccc';   // ref with no scoped commit
const ID_D = 'M-20990104000000-ddd';   // orphan branch — unrelated history
const ID_T = 'T-20990105000000-loose'; // loose task ref

/**
 * The bait fixture.
 *
 * Two milestone branches carrying the IDENTICAL `feat(S04/T01):` scope and
 * touching DIFFERENT files. Plus, on branch A, the shapes a real range
 * contains and that must land in `unattributed[]` by name rather than vanish:
 * a `fix(review):` commit, a side commit merged in, and the merge itself.
 */
function makeGitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-delta-git-'));
  g(root, ['init', '-q', '--initial-branch=master', '.']);
  g(root, ['config', 'user.email', 't@example.com']);
  g(root, ['config', 'user.name', 'T']);
  g(root, ['config', 'commit.gpgsign', 'false']);
  commitFile(root, 'README.md', 'base\n', 'chore: base');

  // side branch (merged into A below)
  g(root, ['checkout', '-q', '-b', 'side']);
  commitFile(root, 'side.txt', 's\n', 'chore: side work');

  // Branch A: the pair, a non-unit commit, and a merge.
  g(root, ['checkout', '-q', 'master']);
  g(root, ['checkout', '-q', '-b', `forge/${ID_A}`]);
  commitFile(root, 'a1.txt', 'a\n', 'feat(S04/T01): trabalho da milestone A');
  commitFile(root, 'r1.txt', 'r\n', 'fix(review): objeção concedida');
  g(root, ['merge', '--no-ff', '-m', 'merge: side', 'side']);

  // Branch B: the SAME pair, different file.
  g(root, ['checkout', '-q', 'master']);
  g(root, ['checkout', '-q', '-b', `forge/${ID_B}`]);
  commitFile(root, 'b1.txt', 'b\n', 'feat(S04/T01): trabalho da milestone B');

  // Branch C: exists, but carries no unit scope at all.
  g(root, ['checkout', '-q', 'master']);
  g(root, ['checkout', '-q', '-b', `forge/${ID_C}`]);
  commitFile(root, 'c1.txt', 'c\n', 'chore: batch de várias tasks');

  // Branch D: orphan — no merge base with master.
  g(root, ['checkout', '-q', '--orphan', `forge/${ID_D}`]);
  fs.writeFileSync(path.join(root, 'd1.txt'), 'd\n');
  g(root, ['add', '--', 'd1.txt']);
  g(root, ['commit', '-m', 'feat(S01/T01): órfã']);

  // Loose task ref: one commit, no unit scope (the measured real shape).
  g(root, ['checkout', '-q', 'master']);
  g(root, ['checkout', '-q', '-b', `forge/${ID_T}`]);
  commitFile(root, 'loose.txt', 'l\n', 'chore: task solta faz trabalho');

  g(root, ['checkout', '-q', 'master']);
  return root;
}

function unitBy(rep, key) {
  return rep.units.find((u) => u.unit === key) || null;
}

// ── R1 / R2 / R4 ───────────────────────────────────────────────────────────
const REPO = makeGitFixture();
const REPORT = writtenByUnit(REPO, { defaultBranch: 'master' });
observe(REPORT.unattributed);
observe(REPORT.skipped);

console.log('\nR1 — a isca: mesmo par (S04/T01) em duas milestones');

test('as duas milestones saem como DUAS unidades distintas', () => {
  const ua = unitBy(REPORT, `${ID_A}::S04/T01`);
  const ub = unitBy(REPORT, `${ID_B}::S04/T01`);
  assert(ua, `unidade de A ausente; unidades=${REPORT.units.map((u) => u.unit).join(',')}`);
  assert(ub, `unidade de B ausente; unidades=${REPORT.units.map((u) => u.unit).join(',')}`);
  assert(ua.unit !== ub.unit, 'as duas unidades colapsaram na mesma chave');
});

// THE bait assert — the one R7 reverts the axis to make red.
function assertBaitFileSets(rep) {
  const ua = unitBy(rep, `${ID_A}::S04/T01`);
  const ub = unitBy(rep, `${ID_B}::S04/T01`);
  if (!ua || !ub) throw new Error('par recorrente não produziu duas unidades distintas');
  if (ua.files.join(',') !== 'a1.txt') throw new Error(`A deveria ter só a1.txt, veio ${ua.files.join(',')}`);
  if (ub.files.join(',') !== 'b1.txt') throw new Error(`B deveria ter só b1.txt, veio ${ub.files.join(',')}`);
}

test('os conjuntos de arquivos nunca se misturam (assert-isca)', () => {
  assertBaitFileSets(REPORT);
});

test('a chave de unidade carrega o dono — não é só o par', () => {
  assertEqual(unitKeyFor(ID_A, 'S04', 'T01'), `${ID_A}::S04/T01`, 'chave composta');
  assert(unitKeyFor(ID_A, 'S04', 'T01') !== unitKeyFor(ID_B, 'S04', 'T01'), 'donos diferentes → chaves diferentes');
});

console.log('\nR2 — censo que reconcilia por ref');

test('walked === attributed + unattributed (branch A isolada)', () => {
  const got = commitsForRef(REPO, `forge/${ID_A}`, { defaultBranch: 'master' });
  assert(got.ok, `commitsForRef falhou: ${got.reason}`);
  const a = attributeCommits(got.commits, ID_A, 'milestone');
  assertEqual(a.walked, a.attributed + a.unattributed.length, 'reconciliação da branch A');
  assertEqual(a.attributed, 1, 'só o commit scoped é atribuído');
  observe(a.unattributed);
  const reasons = a.unattributed.map((u) => u.reason).sort();
  assertDeep(reasons, ['merge-commit', 'no-unit-marker', 'no-unit-marker'],
    'fix(review), chore: side e o merge caem nomeados');
});

test('walked === attributed + unattributed (relatório inteiro)', () => {
  assertEqual(REPORT.commits_walked, REPORT.attributed + REPORT.unattributed.length, 'reconciliação global');
  assert(REPORT.commits_walked > 0, 'o walker não andou');
});

test('fix(review) e merges aparecem NOMEADOS, nunca somem', () => {
  const rev = REPORT.unattributed.find((u) => u.subject.startsWith('fix(review)'));
  assert(rev, 'fix(review) sumiu do censo');
  assertEqual(rev.reason, 'no-unit-marker', 'razão do fix(review)');
  const mg = REPORT.unattributed.find((u) => u.subject.startsWith('merge:'));
  assert(mg, 'o merge sumiu do censo');
  assertEqual(mg.reason, 'merge-commit', 'razão do merge');
});

test('ref sem commit scoped → no-attributed-commits (nem 0%, nem 100%)', () => {
  const s = REPORT.skipped.find((x) => x.unit === ID_C);
  assert(s, `ID_C não apareceu em skipped: ${JSON.stringify(REPORT.skipped)}`);
  assertEqual(s.reason, 'no-attributed-commits', 'razão do ref sem scope');
  assert(!unitBy(REPORT, `${ID_C}::S01/T01`), 'ID_C não pode ter produzido unidade');
});

test('branch órfã → no-merge-base, nomeada, sem inventar range', () => {
  const got = commitsForRef(REPO, `forge/${ID_D}`, { defaultBranch: 'master' });
  assertEqual(got.ok, false, 'órfã não pode resolver range');
  assertEqual(got.reason, 'no-merge-base', 'razão da órfã');
  reasonsSeen.add(got.reason);
});

test('diretório que não é repo → git-command-failed (≠ no-merge-base)', () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-delta-norepo-'));
  const got = commitsForRef(notRepo, 'forge/whatever', { defaultBranch: 'master' });
  assertEqual(got.ok, false, 'não-repo não pode responder');
  assertEqual(got.reason, 'git-command-failed', 'não-repo tem razão própria');
  reasonsSeen.add(got.reason);
});

console.log('\nR4 — ref de task solta atribui o range inteiro');

test('forge/T-* não exige scope S##/T##', () => {
  const u = unitBy(REPORT, ID_T);
  assert(u, `task solta ausente; unidades=${REPORT.units.map((x) => x.unit).join(',')}`);
  assertEqual(u.owner_kind, 'task', 'kind do dono');
  assertEqual(u.slice, null, 'task solta não tem slice');
  assertDeep(u.files, ['loose.txt'], 'arquivos da task solta');
});

test('listUnitRefs classifica pelo NOME do ref, dedup preferindo local', () => {
  const refs = listUnitRefs(REPO);
  const ids = refs.map((r) => r.id).sort();
  assertDeep(ids, [ID_A, ID_B, ID_C, ID_D, ID_T].sort(), 'ids dos refs forge/*');
  assert(refs.every((r) => r.scope === 'local'), 'fixture só tem refs locais');
  assertEqual(refs.find((r) => r.id === ID_T).kind, 'task', 'T- é task');
  assertEqual(refs.find((r) => r.id === ID_A).kind, 'milestone', 'M- é milestone');
});

// ── R6 — svn: ambiguidade é recusada, nunca curinga ────────────────────────
console.log('\nR6 — svn: dono ambíguo é recusado');

const SVN_REVS = [
  { rev: 2, msg: 'feat(S04/T01): svn work', paths: [{ action: 'M', path: '/trunk/x.txt' }] },
  { rev: 3, msg: 'chore: sem scope', paths: [{ action: 'A', path: '/trunk/y.txt' }] },
];

test('1 candidata → dono resolvido', () => {
  const a = attributeSvnRevisions(SVN_REVS, { milestoneCandidates: [ID_A] });
  assertEqual(a.walked, a.attributed + a.unattributed.length, 'reconciliação svn');
  const u = a.units.find((x) => x.unit === `${ID_A}::S04/T01`);
  assert(u, `unidade svn ausente: ${JSON.stringify(a.units)}`);
  assertDeep(u.files, ['/trunk/x.txt'], 'paths da revisão');
  observe(a.unattributed);
});

test('2 candidatas sem id na mensagem → ambiguous-unit-owner, zero unidades', () => {
  const a = attributeSvnRevisions(SVN_REVS, { milestoneCandidates: [ID_A, ID_B] });
  assertEqual(a.units.length, 0, 'nenhuma unidade pode nascer de dono ambíguo');
  const s = a.skipped.find((x) => x.reason === 'ambiguous-unit-owner');
  assert(s, `esperava ambiguous-unit-owner: ${JSON.stringify(a.skipped)}`);
  assertEqual(a.walked, a.attributed + a.unattributed.length, 'reconciliação sob ambiguidade');
  observe(a.skipped);
});

test('2 candidatas MAS id completo na mensagem → resolve pelo id', () => {
  const revs = [{ rev: 4, msg: `feat(S04/T01): trabalho de ${ID_B}`, paths: [{ action: 'M', path: '/trunk/z.txt' }] }];
  const a = attributeSvnRevisions(revs, { milestoneCandidates: [ID_A, ID_B] });
  assertEqual(a.units.length, 1, 'id na mensagem desambigua');
  assertEqual(a.units[0].unit, `${ID_B}::S04/T01`, 'dono vem do id citado');
});

test('svn log ilegível → svn-log-failed, nunca "medido e vazio"', () => {
  const rep = writtenByUnit(REPO, { vcs: 'svn', svnLog: () => ({ ok: false, error: 'svn-log-failed' }) });
  assertEqual(rep.units_measured, 0, 'sem log não há medição');
  assertEqual(rep.skipped[0].reason, 'svn-log-failed', 'razão nomeada');
  observe(rep.skipped);
});

test('vcs desconhecido → vcs-unsupported', () => {
  const rep = writtenByUnit(REPO, { vcs: 'hg' });
  assertEqual(rep.skipped[0].reason, 'vcs-unsupported', 'razão nomeada');
  observe(rep.skipped);
});

// ── R5 — svn real (svnadmin create) ou skip NOMEADO ────────────────────────
console.log('\nR5 — svn real: working copy criada por svnadmin');

function hasBin(bin) {
  const r = spawnSync(bin, ['--version', '--quiet'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

if (!hasBin('svn') || !hasBin('svnadmin')) {
  skip('svn end-to-end (svnadmin create + checkout + log --xml -v)', 'svn-unavailable');
} else {
  const svnRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-delta-svn-'));
  const repoDir = path.join(svnRoot, 'repo');
  const wc = path.join(svnRoot, 'wc');
  const url = `file:///${repoDir.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const sv = (cwd, args) => execFileSync('svn', ['--non-interactive', ...args], { cwd, encoding: 'utf8' });

  execFileSync('svnadmin', ['create', repoDir], { encoding: 'utf8' });
  execFileSync('svn', ['--non-interactive', 'checkout', url, wc], { encoding: 'utf8' });

  fs.writeFileSync(path.join(wc, 'x.txt'), 'x\n');
  sv(wc, ['add', 'x.txt']);
  sv(wc, ['commit', '-m', 'feat(S04/T01): svn escreve x']);
  fs.writeFileSync(path.join(wc, 'y.txt'), 'y\n');
  sv(wc, ['add', 'y.txt']);
  sv(wc, ['commit', '-m', 'chore: sem scope de unidade']);

  const { svnLogChangedPaths, parseSvnLogXml } = require('./forge-vcs.js');

  test('svnLogChangedPaths lê paths por revisão de uma working copy real', () => {
    const log = svnLogChangedPaths(wc, {});
    assert(log.ok, `svn log falhou: ${JSON.stringify(log)}`);
    assertEqual(log.revisions.length, 2, 'duas revisões');
    const r1 = log.revisions.find((r) => r.rev === 1);
    assert(r1.msg.startsWith('feat(S04/T01):'), `msg r1: ${r1.msg}`);
    assertDeep(r1.paths.map((p) => p.path), ['/x.txt'], 'paths de r1');
  });

  test('writtenByUnit sobre svn real atribui os paths à unidade', () => {
    const rep = writtenByUnit(wc, { vcs: 'svn', milestoneCandidates: [ID_A] });
    const u = rep.units.find((x) => x.unit === `${ID_A}::S04/T01`);
    assert(u, `unidade svn ausente: ${JSON.stringify(rep.units)}`);
    assertDeep(u.files, ['/x.txt'], 'arquivos escritos via svn');
    assertEqual(rep.commits_walked, rep.attributed + rep.unattributed.length, 'reconciliação svn real');
    observe(rep.unattributed);
  });

  test('parseSvnLogXml é fail-closed: entry sem revisão não vira entry vazia', () => {
    const bad = '<log><logentry><msg>x</msg></logentry></log>';
    assertDeep(parseSvnLogXml(bad), { ok: false, error: 'svn-log-malformed' }, 'xml malformado');
  });
}

// ── R7 — MORDIDA: reverter o eixo de ref e ver o assert-isca vermelho ──────
console.log('\nR7 — mordida: eixo de ref revertido na cópia descartável');

test('com o eixo de ref removido, o assert-isca FALHA (mordida provada)', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  const ORIGINAL = '  return `${ownerId}::${slice}/${task}`;';
  const REVERTED = '  return `${slice}/${task}`;';
  assert(src.includes(ORIGINAL), 'a linha do eixo de ref mudou de forma — a mordida ficaria inerte');
  const mutated = src.replace(ORIGINAL, REVERTED);
  assert(mutated !== src, 'a mutação não aplicou — o teste seria um no-op');

  // A cópia vive ao lado do original de propósito: o módulo faz require
  // relativo de forge-isolation/forge-vcs/forge-ids, e num tmpdir esses
  // requires quebrariam — a suíte mediria o erro de require, não o eixo.
  const baitPath = path.join(__dirname, '.forge-unit-delta.bait.tmp.js');
  try {
    fs.writeFileSync(baitPath, mutated);
    const bait = require(baitPath);
    const baitReport = bait.writtenByUnit(REPO, { defaultBranch: 'master' });

    let red = null;
    try { assertBaitFileSets(baitReport); } catch (e) { red = e.message; }
    assert(red, 'o assert-isca PASSOU com o eixo revertido — ele não mede o que diz medir');
    console.log(`      mordida: assert-isca vermelho sob reversão → "${red}"`);

    // A FORMA da contaminação, medida (não prevista): a agregação acontece
    // por ref, então remover o dono da chave não produz um balde fundido —
    // produz DUAS entradas com a MESMA chave `S04/T01`, uma por milestone.
    // Isso é pior que a fusão, não melhor: a chave deixa de identificar uma
    // unidade, e qualquer consumidor a jusante que indexe por ela
    // (`find`, `Map.set`, um join de T03) fica com uma milestone e descarta a
    // outra em silêncio — sem nenhum sinal de que houve colisão.
    const collided = baitReport.units.filter((u) => u.unit === 'S04/T01');
    assertEqual(collided.length, 2, `esperava a chave colidida duas vezes: ${baitReport.units.map((u) => u.unit).join(',')}`);
    const spanned = collided.flatMap((u) => u.files).sort();
    assertDeep(spanned, ['a1.txt', 'b1.txt'], 'a chave colidida cobre as escritas das duas milestones');
    // E o descarte silencioso é literal: indexar por chave perde uma delas.
    assertEqual(new Map(collided.map((u) => [u.unit, u])).size, 1, 'indexar por chave colapsa as duas milestones em uma');
  } finally {
    try { delete require.cache[require.resolve(baitPath)]; } catch {}
    try { fs.unlinkSync(baitPath); } catch {}
  }
  // Restaurado: o original nunca foi tocado (a mutação viveu só na cópia).
  assertEqual(fs.readFileSync(MODULE, 'utf8'), src, 'o módulo original mudou — a mordida não pode escrever nele');
});

// ── R8 — as objeções concedidas do review de S02 (R2, R4, R5) ─────────────
//
// Cada teste aqui nasce de uma medição do review, não de uma hipótese; o
// comentário de cada um diz o que a versão anterior devolvia.
console.log('\nR8 — review de S02: reader que lança, paths por NUL, refs por ancestralidade');

// R2 — o reader svn LANÇA. Antes: a exceção escapava de writtenByUnit inteira
// (sem skipped, sem relatório), e o main a engolia em exit 0.
test('R2 reader svn que LANÇA degrada para svn-log-failed com detail — nunca escapa', () => {
  let rep;
  try {
    rep = writtenByUnit(REPO, { vcs: 'svn', svnLog: () => { throw new Error('spawn svn ENOENT'); } });
  } catch (e) {
    throw new Error(`a exceção escapou de writtenByUnit: ${e.message}`);
  }
  assertEqual(rep.units_measured, 0, 'sem log não há medição');
  assertEqual(rep.skipped[0].reason, 'svn-log-failed', 'razão nomeada');
  assert(/ENOENT/.test(rep.skipped[0].detail), `a mensagem do throw precisa chegar ao detail: ${rep.skipped[0].detail}`);
  observe(rep.skipped);
});

// R2 (metade CLI) — um run que NÃO produziu relatório não pode sair 0. O throw
// é injetado numa CÓPIA descartável (mesma técnica do R7): a única forma de
// exercitar o catch do main de fora do processo.
test('R2 sem relatório o PROCESSO sai não-zero (e a mordida do exit code)', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  const CALL = '    const rep = writtenByUnit(cwd, {});';
  assert(src.includes(CALL), 'a chamada do main mudou de forma — a mordida ficaria inerte');
  const THROW = "    const rep = (() => { throw new Error('boom sem relatorio'); })();";
  const boomPath = path.join(path.dirname(MODULE), '__boom-unit-delta.js');
  const boomZeroPath = path.join(path.dirname(MODULE), '__boom-zero-unit-delta.js');
  try {
    fs.writeFileSync(boomPath, src.replace(CALL, THROW));
    const r = spawnSync(process.execPath, [boomPath, '--cwd', REPO, '--json'], { encoding: 'utf8' });
    assertEqual(r.status, 2, `exit do PROCESSO com relatório ausente; stderr=${r.stderr}`);
    assert(/boom sem relatorio/.test(r.stderr), 'a causa vai nomeada ao stderr');
    assertEqual(r.stdout.trim(), '', 'nenhum relatório foi emitido');

    // MORDIDA: com `return 2` revertido para `return 0`, o assert acima fica verde
    // sobre um run que não mediu nada — que é exatamente o defeito de origem.
    const reverted = src.replace(CALL, THROW).replace(
      "    process.stderr.write(`forge-unit-delta: ${e.message}\\n`);\n    return 2;",
      "    process.stderr.write(`forge-unit-delta: ${e.message}\\n`);",
    );
    assert(reverted !== src.replace(CALL, THROW), 'a reversão do exit code não aplicou — a mordida seria no-op');
    fs.writeFileSync(boomZeroPath, reverted);
    const r0 = spawnSync(process.execPath, [boomZeroPath, '--cwd', REPO, '--json'], { encoding: 'utf8' });
    assertEqual(r0.status, 0, 'a reversão precisa reproduzir o exit 0 antigo (senão a mordida não mordeu)');
  } finally {
    try { fs.unlinkSync(boomPath); } catch {}
    try { fs.unlinkSync(boomZeroPath); } catch {}
  }
  assertEqual(fs.readFileSync(MODULE, 'utf8'), src, 'o módulo original mudou — a mordida não pode escrever nele');
});

// R4 — path com LF. Git C-QUOTA esse path na saída não-`-z` (o mecanismo é
// mangling, não split), então sem `-z` ele chega como literal escapado que não
// casa nenhum path declarado. O arquivo é criado pelo ÍNDICE (update-index
// --cacheinfo), nunca pelo working tree: Win32 proíbe LF em nome de arquivo, e
// esperar a máquina permitir seria não testar.
test('R4 path com LF sobrevive: diff-tree -z entrega o nome exato, sem trim', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-delta-lf-'));
  const ID_LF = 'M-20990106000000-lf';
  try {
    g(root, ['init', '-q', '--initial-branch=master', '.']);
    g(root, ['config', 'user.email', 't@example.com']);
    g(root, ['config', 'user.name', 'T']);
    g(root, ['config', 'commit.gpgsign', 'false']);
    g(root, ['config', 'core.quotepath', 'true']);
    // Win32 rejects LF in a path name, and git enforces that with protectNTFS.
    // Disabled HERE ONLY, on a throwaway fixture, so the parser can be exercised
    // against the shape it exists to survive — the alternative is a test that
    // silently never runs on the platform this repo is developed on.
    g(root, ['config', 'core.protectNTFS', 'false']);
    commitFile(root, 'README.md', 'base\n', 'chore: base');
    const weird = 'src/a\nb.txt';
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'x\n', encoding: 'utf8' }).trim();
    g(root, ['update-index', '--add', '--cacheinfo', `100644,${sha},${weird}`]);
    const tree = g(root, ['write-tree']).trim();
    const parent = g(root, ['rev-parse', 'HEAD']).trim();
    const commit = execFileSync('git', ['commit-tree', tree, '-p', parent, '-m', 'feat(S01/T01): escreve path com LF'], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' },
    }).trim();
    g(root, ['update-ref', `refs/heads/forge/${ID_LF}`, commit]);
    g(root, ['read-tree', 'HEAD']); // deixa o índice consistente com master

    const rep = writtenByUnit(root, { defaultBranch: 'master' });
    const u = rep.units.find((x) => x.unit === `${ID_LF}::S01/T01`);
    assert(u, `unidade ausente: ${JSON.stringify(rep.units.map((x) => x.unit))}`);
    assertDeep(u.files, [weird], 'o path com LF chega inteiro — sem C-quoting, sem split, sem trim');
    observe(rep.skipped);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// R5 — o desempate local × origin. Medido no forge-agent real:
// `controle-contexto-gsd` é 0/5 (local ATRÁS), e a regra antiga "local vence"
// descartava cinco commits de escrita daquela unidade, INFLANDO a cobertura.
function makeDupRefFixture(tag, build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `unit-delta-${tag}-`));
  g(root, ['init', '-q', '--initial-branch=master', '.']);
  g(root, ['config', 'user.email', 't@example.com']);
  g(root, ['config', 'user.name', 'T']);
  g(root, ['config', 'commit.gpgsign', 'false']);
  commitFile(root, 'README.md', 'base\n', 'chore: base');
  build(root);
  g(root, ['checkout', '-q', 'master']);
  return root;
}

const ID_BEHIND = 'M-20990107000000-behind';
const ID_DIVERG = 'M-20990108000000-diverg';

test('R5 local ATRÁS de origin: o descendente vence e a escrita do origin é medida', () => {
  const root = makeDupRefFixture('behind', (r) => {
    g(r, ['checkout', '-q', '-b', `forge/${ID_BEHIND}`]);
    commitFile(r, 'local.txt', 'l\n', 'feat(S01/T01): commit que o local tem');
    const localSha = g(r, ['rev-parse', 'HEAD']).trim();
    commitFile(r, 'somente-no-origin.txt', 'o\n', 'feat(S01/T02): commit só no origin');
    const aheadSha = g(r, ['rev-parse', 'HEAD']).trim();
    // origin fica À FRENTE; a branch local recua.
    g(r, ['update-ref', `refs/remotes/origin/forge/${ID_BEHIND}`, aheadSha]);
    g(r, ['checkout', '-q', 'master']);
    g(r, ['update-ref', `refs/heads/forge/${ID_BEHIND}`, localSha]);
  });
  try {
    const refs = listUnitRefs(root);
    const chosen = refs.find((x) => x.id === ID_BEHIND);
    assert(chosen, 'ref não listado');
    assertEqual(chosen.resolution, 'remote-descendant', 'o descendente é o origin, não o local');
    assertEqual(chosen.ref, `refs/remotes/origin/forge/${ID_BEHIND}`, 'ref escolhido');

    const rep = writtenByUnit(root, { defaultBranch: 'master' });
    const t2 = rep.units.find((u) => u.unit === `${ID_BEHIND}::S01/T02`);
    // ESTE é o assert que a regra antiga deixava vermelho: com "local vence",
    // S01/T02 não existe e sua escrita some da medição.
    assert(t2, `a escrita que só o origin carrega sumiu da medição: ${JSON.stringify(rep.units.map((u) => u.unit))}`);
    assertDeep(t2.files, ['somente-no-origin.txt'], 'arquivos da unidade que só o origin carrega');
    observe(rep.skipped);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('R5 refs DIVERGENTES: skip nomeado carregando os DOIS refs — nunca uma escolha silenciosa', () => {
  const root = makeDupRefFixture('diverg', (r) => {
    g(r, ['checkout', '-q', '-b', `forge/${ID_DIVERG}`]);
    commitFile(r, 'so-local.txt', 'l\n', 'feat(S01/T01): só no local');
    const localSha = g(r, ['rev-parse', 'HEAD']).trim();
    g(r, ['checkout', '-q', 'master']);
    g(r, ['checkout', '-q', '-b', 'tmp-origin']);
    commitFile(r, 'so-origin.txt', 'o\n', 'feat(S01/T01): só no origin');
    const remoteSha = g(r, ['rev-parse', 'HEAD']).trim();
    g(r, ['checkout', '-q', 'master']);
    g(r, ['update-ref', `refs/heads/forge/${ID_DIVERG}`, localSha]);
    g(r, ['update-ref', `refs/remotes/origin/forge/${ID_DIVERG}`, remoteSha]);
    g(r, ['branch', '-q', '-D', 'tmp-origin']);
  });
  try {
    const entry = listUnitRefs(root).find((x) => x.id === ID_DIVERG);
    assert(entry, 'ref não listado');
    assertEqual(entry.divergent, true, 'divergência reconhecida');
    assertEqual(entry.ref, null, 'nenhum dos dois pode ser escolhido');
    assertDeep(entry.refs_seen.slice().sort(), [
      `refs/heads/forge/${ID_DIVERG}`,
      `refs/remotes/origin/forge/${ID_DIVERG}`,
    ].sort(), 'os dois refs viajam juntos');

    const rep = writtenByUnit(root, { defaultBranch: 'master' });
    const s = rep.skipped.find((x) => x.unit === ID_DIVERG);
    assert(s, `skip ausente: ${JSON.stringify(rep.skipped)}`);
    assertEqual(s.reason, 'ref-divergent', 'razão nomeada');
    assertEqual((s.refs || []).length, 2, 'o skip carrega os dois refs');
    assertEqual(rep.units.length, 0, 'nenhuma unidade nasce de um par divergente');
    observe(rep.skipped);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('R5 refs idênticos ou ref único não viram divergência', () => {
  const ID_SAME = 'M-20990109000000-same';
  const root = makeDupRefFixture('same', (r) => {
    g(r, ['checkout', '-q', '-b', `forge/${ID_SAME}`]);
    commitFile(r, 'x.txt', 'x\n', 'feat(S01/T01): trabalho');
    const sha = g(r, ['rev-parse', 'HEAD']).trim();
    g(r, ['update-ref', `refs/remotes/origin/forge/${ID_SAME}`, sha]);
  });
  try {
    const entry = listUnitRefs(root).find((x) => x.id === ID_SAME);
    assertEqual(entry.resolution, 'identical', 'refs idênticos');
    assert(!entry.divergent, 'idêntico nunca é divergente');
    const rep = writtenByUnit(root, { defaultBranch: 'master' });
    assert(rep.units.find((u) => u.unit === `${ID_SAME}::S01/T01`), 'a unidade continua medida');
    observe(rep.skipped);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── R3 — DELTA_REASONS cruzado nos dois sentidos ──────────────────────────
console.log('\nR3 — razões: declaradas ⇄ produzidas');

test('toda razão produzida está declarada (nenhum descarte silencioso)', () => {
  const extra = Array.from(reasonsSeen).filter((r) => !DELTA_REASONS.includes(r)).sort();
  assertDeep(extra, [], 'razões produzidas mas não declaradas');
});

test('toda razão declarada foi vista disparar (nenhuma entrada decorativa)', () => {
  const dead = DELTA_REASONS.filter((r) => !reasonsSeen.has(r)).sort();
  assertDeep(dead, [], 'razões declaradas que nenhum cenário produziu');
});

test('postura read-only: o módulo não escreve em lugar nenhum', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  for (const forbidden of ['writeFileSync', 'appendFileSync', "'add'", "'commit'", "'checkout'", "'fetch'"]) {
    assert(!src.includes(forbidden), `o módulo referencia ${forbidden} — a postura read-only quebrou`);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
