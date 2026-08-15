#!/usr/bin/env node
// forge-claim-polarity.test.js — firewall executável das duas polaridades (D1,
// M-20260813133328-lease-escrita-cross-run S03/T03).
//
// Quatro blocos, cada um provando uma parte da promessa mais fácil de quebrar
// desta milestone: as duas polaridades coexistem e NUNCA se "unificam" num
// refactor futuro.
//
//   A — intra-slice inalterada (writesConflict/pathsOverlap de forge-parallelism.js)
//   B — cross-run invertida (claimsConflict de forge-claim-overlap.js)
//   C — as duas suítes intra-slice existentes rodam por SPAWN, sem edição
//   D — guard de fonte: writesConflict nunca aparece em forge-claim-overlap.js,
//       com controle positivo provando que o guard morde
//
// Veredito por CONJUNTO de asserts, nunca por exit code de suíte (decisão da
// milestone varredura-classe-eol).

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { pathsOverlap, writesConflict } = require('./forge-parallelism.js');
const { claimsConflict } = require('./forge-claim-overlap.js');

const PARALLELISM_JS = path.join(__dirname, 'forge-parallelism.js');
const CLAIM_OVERLAP_JS = path.join(__dirname, 'forge-claim-overlap.js');
const PARALLELISM_TEST = path.join(__dirname, 'forge-parallelism.test.js');
const PARALLELISM_EXPORTS_TEST = path.join(__dirname, 'forge-parallelism-exports.test.js');

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
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

// Strip line comments and block comments from a JS source string.
function stripComments(src) {
  // Block comments first (non-greedy, dotall via [\s\S]), then line comments.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

console.log('\n=== forge-claim-polarity.test.js ===\n');

// ── Bloco A — intra-slice inalterada ───────────────────────────────────────
//
// A assimetria entre `pathsOverlap('', 'x') === true` e `writesConflict([], ['x']) === false`
// é A INCONSISTÊNCIA QUE D1 NOMEIA — e ela permanece porque a semântica
// intra-slice está correta e testada (Out of Scope do SCOPE proíbe mexer nela).
// Empty-list em `writesConflict` significa "esta task genuinamente não declara
// writes" (ambos os lados vêm do frontmatter que o planner acabou de escrever);
// um path vazio isolado em `pathsOverlap` é defensivo — "caminho desconhecido =
// conflito". As duas coisas nunca deveriam concordar; este bloco prova que não
// concordam, ao vivo, e não por comentário.
console.log('Bloco A: intra-slice inalterada (forge-parallelism.js)');
{
  test('writesConflict([], ["x"]) === false', () => assertEq(writesConflict([], ['x']), false));
  test('writesConflict(["x"], []) === false', () => assertEq(writesConflict(['x'], []), false));
  test('writesConflict([], []) === false', () => assertEq(writesConflict([], []), false));
  test('pathsOverlap("", "x") === true — a assimetria que D1 nomeia', () => {
    assertEq(pathsOverlap('', 'x'), true);
  });
}

// ── Bloco B — cross-run invertida ──────────────────────────────────────────
//
// Mesma forma vazia/ausente, polaridade OPOSTA: uma run que não declarou
// claim (ou declarou paths vazio) é sempre CONFLITO cross-run, causa
// 'undeclared-writes' — "ausência de declaração nunca é evidência de
// segurança" (D1). Asserts SEPARADOS por direção — assumir simetria é como um
// bug de direção sobrevive.
console.log('\nBloco B: cross-run invertida (forge-claim-overlap.js)');
{
  test('A={paths:[]} × B={paths:["x"]} → conflito, causa undeclared-writes', () => {
    const r = claimsConflict({ paths: [] }, { paths: ['x'] });
    assert(r !== null, 'expected conflict, got null (clean)');
    assertEq(r.cause, 'undeclared-writes');
  });
  test('A={paths:["x"]} × B={paths:[]} → conflito, causa undeclared-writes (direção oposta)', () => {
    const r = claimsConflict({ paths: ['x'] }, { paths: [] });
    assert(r !== null, 'expected conflict, got null (clean)');
    assertEq(r.cause, 'undeclared-writes');
  });
  test('A=null (nunca reivindicado) × B={paths:["x"]} → conflito', () => {
    const r = claimsConflict(null, { paths: ['x'] });
    assert(r !== null, 'expected conflict, got null (clean)');
    assertEq(r.cause, 'undeclared-writes');
  });
  test('A={paths:["x"]} × B=null → conflito (direção oposta)', () => {
    const r = claimsConflict({ paths: ['x'] }, null);
    assert(r !== null, 'expected conflict, got null (clean)');
    assertEq(r.cause, 'undeclared-writes');
  });
  test('duas declarações reais que colidem → causa overlap, distinta de undeclared-writes', () => {
    const r = claimsConflict({ paths: ['src/a.ts'] }, { paths: ['src/a.ts'] });
    assert(r !== null, 'expected conflict, got null (clean)');
    assertEq(r.cause, 'overlap');
  });
}

// ── Bloco C — as suítes intra-slice, por spawn, sem edição ────────────────
//
// Tradução executável do critério do ROADMAP ("seguem verdes sem edição").
// `scripts/forge-parallelism.js` NÃO foi tocado por esta task — se algum
// assert aqui ficar vermelho, a causa está em T01/T02, não aqui.
console.log('\nBloco C: suítes intra-slice por spawn, sem edição de forge-parallelism.js');
{
  test('forge-parallelism.test.js passa (spawn, exit 0)', () => {
    const r = spawnSync(process.execPath, [PARALLELISM_TEST], { encoding: 'utf8' });
    assertEq(r.status, 0, `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  });
  test('forge-parallelism-exports.test.js passa (spawn, exit 0)', () => {
    const r = spawnSync(process.execPath, [PARALLELISM_EXPORTS_TEST], { encoding: 'utf8' });
    assertEq(r.status, 0, `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  });
}

// ── Bloco D — guard de fonte, com controle positivo ────────────────────────
//
// Sem o controle positivo o guard pode estar cego à própria palavra-alvo —
// precedente medido neste repo (o scanner da S06 com \b depois de "é"). Por
// isso o MESMO predicado é aplicado (a) ao fonte real, que deve PASSAR
// (não conter "writesConflict"), e (b) a uma cópia sintética com a chamada
// injetada, que deve ser REPROVADA pelo predicado idêntico.
console.log('\nBloco D: guard de fonte (writesConflict nunca em forge-claim-overlap.js), com controle positivo');
{
  const realSource = fs.readFileSync(CLAIM_OVERLAP_JS, 'utf8');

  function guardPasses(src) {
    return !stripComments(src).includes('writesConflict');
  }

  test('fonte real de forge-claim-overlap.js, sem comentários, NÃO contém "writesConflict"', () => {
    assert(guardPasses(realSource), 'guard failed on the real source — writesConflict leaked in');
  });

  test('controle positivo: cópia sintética com writesConflict injetado é REPROVADA pelo mesmo predicado', () => {
    const injected = `${realSource}\n// injected for the positive control below\nconst x = writesConflict(a, b);\n`;
    assert(!guardPasses(injected), 'guard did not bite the injected call — positive control failed');
  });

  test('controle negativo: injetar dentro de um comentário NÃO deve enganar o guard (comentário é removido antes)', () => {
    const injectedInComment = `${realSource}\n// writesConflict mentioned only in a comment\n`;
    // The mention lives ONLY inside a comment — after stripping comments it
    // must be gone, so the guard must still PASS (the mention in prose here,
    // in THIS test file, is exactly that: prose, never a call).
    assert(guardPasses(injectedInComment), 'guard false-positived on a comment-only mention');
  });
}

// ── Mordida registrada nas duas direções (Step 4 do plano) ─────────────────
//
// Já executada acima pelos testes "controle positivo" (Bloco D) e pelos
// asserts direcionais do Bloco B, que são as duas mordidas exigidas:
//   (a) inverter a polaridade do ramo vazio de claimsConflict → Bloco B fica
//       vermelho (provado manualmente durante o desenvolvimento desta task —
//       ver T03-SUMMARY.md § Mordida);
//   (b) injetar writesConflict numa cópia de forge-claim-overlap.js → Bloco D
//       fica vermelho (teste "controle positivo" acima, que roda a cada
//       execução da suíte — a mordida (b) é permanente, não um evento único).

// --- Summary ---
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`      ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
