#!/usr/bin/env node
// forge-claim-fence-halt.test.js — guard do ramo fail-closed do claim gate nas duas skills
// (triagem S04/R3 da milestone M-20260813133328-lease-escrita-cross-run).
//
// O que está sendo guardado, e por quê ele é frágil:
//
//   `forge-auto` mantém a task em BATCH por DEFAULT (só `defer`/`block`/`refuse` a derrubam), então
//   um ramo de falha do gate que apenas ecoa e cai fora DESPACHA. A correção arbitrada é sentinela
//   (`CLAIM_GATE_DECISION=block` + causa nomeada) mais DROP EXPLÍCITO (`BATCH=()`), porque comentário
//   não executa — precedente da própria skill ("NOT a bare comment").
//
//   `forge-next` tem a polaridade OPOSTA (S04/R4, retirada em debate): o dispatch é gateado
//   afirmativamente pela linha `proceed`, e o ramo fail-closed deixa `DECISION` NÃO-ATRIBUÍDA de
//   propósito. Achatar as duas formas apagaria uma distinção de desenho real, então este guard
//   asserta as DUAS polaridades — a presença da sentinela no auto e a AUSÊNCIA dela no next.
//
// Regra de método desta milestone: o assert é sobre o texto QUE CARREGA COMPORTAMENTO (atribuição
// executável dentro do corpo do ramo, comentários removidos), nunca sobre a presença de uma
// palavra-chave em qualquer lugar do arquivo. Cada assert positivo tem mordida sintética provando
// que ele fica vermelho quando a correção é revertida, e há controle positivo provando que o
// scanner não é cego.

'use strict';

const fs = require('fs');
const path = require('path');

const AUTO_SKILL = path.join(__dirname, '..', 'skills', 'forge-auto', 'SKILL.md');
const NEXT_SKILL = path.join(__dirname, '..', 'skills', 'forge-next', 'SKILL.md');

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

// ── Scanner ────────────────────────────────────────────────────────────────
//
// A marca de um ramo fail-closed do gate é o echo `⛔ Claim gate indisponível`. O corpo do ramo vai
// desse echo até o `fi`/`else` que o fecha. `executable` = linhas do corpo com o comentário removido
// (comentário de linha inteira some; comentário de fim-de-linha é cortado). É sobre `executable`,
// e só sobre ele, que os asserts de comportamento rodam.

const FAILURE_ECHO = /⛔ Claim gate indispon[ií]vel/;

function stripInlineComment(line) {
  // Sem string literal contendo `#` nestes fences; corte simples é suficiente e é o que queremos:
  // qualquer coisa depois de `#` NÃO executa.
  const i = line.indexOf('#');
  return (i === -1 ? line : line.slice(0, i)).trim();
}

function failureBranches(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FAILURE_ECHO.test(lines[i])) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === 'fi' || t === 'else' || t === '```') break;
      body.push(lines[j]);
    }
    out.push({
      line: i + 1,
      echo: lines[i].trim(),
      raw: body.join('\n'),
      executable: body.map(stripInlineComment).filter(Boolean),
    });
  }
  return out;
}

// `hardened` é a definição operacional da correção arbitrada: sentinela atribuída E drop explícito,
// as duas como STATEMENT, não como comentário.
function hardened(branch) {
  const ex = branch.executable;
  const hasSentinel = ex.some((l) => /^CLAIM_GATE_DECISION=block$/.test(l));
  const hasCause = ex.some((l) => /^CLAIM_GATE_CAUSE=gate-unavailable$/.test(l));
  const hasDrop = ex.some((l) => /(^|;\s*)BATCH=\(\)/.test(l));
  return { hasSentinel, hasCause, hasDrop, ok: hasSentinel && hasCause && hasDrop };
}

const autoMd = fs.readFileSync(AUTO_SKILL, 'utf8');
const nextMd = fs.readFileSync(NEXT_SKILL, 'utf8');

console.log('\n=== A — controle positivo: o scanner enxerga o que deve enxergar ===\n');

const autoBranches = failureBranches(autoMd);

test('o scanner encontra os ramos fail-closed do forge-auto (piso anti-silêncio)', () => {
  assert(autoBranches.length >= 3,
    `esperava >= 3 ramos fail-closed no forge-auto, achei ${autoBranches.length} — ` +
    'scanner cego ou fence renomeado (ausência de padrão NÃO é passe limpo)');
});

test('o scanner separa comentário de statement (prova de que não conta palavra solta)', () => {
  const fake = [
    'if [ x ]; then',
    '  echo "⛔ Claim gate indisponível (fake)" >&2',
    '  # CLAIM_GATE_DECISION=block, CLAIM_GATE_CAUSE=gate-unavailable, BATCH=() — STOP.',
    'fi',
  ].join('\n');
  const b = failureBranches(fake);
  assertEq(b.length, 1, 'o scanner deveria achar o ramo sintético');
  assertEq(b[0].executable, [], 'linha de comentário NUNCA pode virar executável');
  assertEq(hardened(b[0]).ok, false,
    'um corpo só-comentário citando as três marcas NÃO pode contar como endurecido — ' +
    'esta é a forma exata do defeito S04/R3');
});

console.log('\n=== B — forge-auto: todo ramo fail-closed carrega sentinela + drop explícito ===\n');

for (const b of autoBranches) {
  test(`ramo (linha ${b.line}) tem CLAIM_GATE_DECISION=block, causa nomeada e BATCH=()`, () => {
    const h = hardened(b);
    assert(h.hasSentinel, `sentinela ausente como statement no ramo da linha ${b.line}`);
    assert(h.hasCause, `causa gate-unavailable ausente como statement no ramo da linha ${b.line}`);
    assert(h.hasDrop, `drop explícito BATCH=() ausente como statement no ramo da linha ${b.line}`);
  });
}

test('o ramo por-task ainda impede que os SOBREVIVENTES carreguem a task caída', () => {
  // O ramo por-task é o único dentro do laço: identificado pelo eco com ${ENTRY_ID}.
  const perTask = autoBranches.filter((b) => b.echo.includes('ENTRY_ID'));
  assertEq(perTask.length, 1, 'esperava exatamente 1 ramo fail-closed por-task');
  const ex = perTask[0].executable;
  assert(ex.some((l) => /SURVIVOR_IDS=\(\)/.test(l)),
    'o ramo por-task precisa zerar SURVIVOR_IDS — senão o drop do BATCH é desfeito na re-gravação');
  assert(ex.some((l) => /^break$/.test(l)),
    'o ramo por-task precisa sair do laço (break) — sem isso as demais tasks seguem sendo avaliadas ' +
    'por um gate que já se declarou indisponível');
});

console.log('\n=== C — mordida sintética nas duas direções (permanente, roda toda execução) ===\n');

test('MORDIDA 1 — revertendo a sentinela, o guard fica vermelho', () => {
  const reverted = autoMd.replace(/^\s*CLAIM_GATE_DECISION=block$/gm, '  # CLAIM_GATE_DECISION=block');
  assert(reverted !== autoMd, 'a mordida não alterou nada — o alvo mudou de forma');
  const bs = failureBranches(reverted);
  assert(bs.length >= 3, 'a mordida não pode reduzir o número de ramos achados');
  assert(bs.every((b) => !hardened(b).ok),
    'com a sentinela revertida a comentário, NENHUM ramo pode continuar contando como endurecido');
});

test('MORDIDA 2 — revertendo o drop do BATCH, o guard fica vermelho', () => {
  // Comenta a LINHA INTEIRA que carrega o drop — o drop por-task vem no fim de uma linha composta
  // (`SURVIVOR_IDS=(); …; BATCH=()`), então ancorar em início de linha erraria justamente o ramo mais
  // perigoso. (Ancoragem ingênua tentada primeiro e medida vermelha por 1 ramo — mordida da mordida.)
  const reverted = autoMd.replace(/^(\s*)(.*BATCH=\(\).*)$/gm, '$1# $2');
  assert(reverted !== autoMd, 'a mordida não alterou nada — o alvo mudou de forma');
  const bs = failureBranches(reverted);
  const withDrop = bs.filter((b) => hardened(b).hasDrop);
  assertEq(withDrop.length, 0,
    'com o drop revertido a comentário, nenhum ramo pode reportar drop explícito');
  assert(bs.every((b) => !hardened(b).ok), 'nenhum ramo pode continuar endurecido sem o drop');
});

test('MORDIDA 3 — o texto original (só echo + comentário STOP) seria reprovado', () => {
  // Reconstrução literal do ramo por-task ANTES da correção, tal como o review o encontrou.
  const before = [
    '  if [ "$GATE_EXIT" -ne 0 ]; then',
    '    echo "⛔ Claim gate indisponível (exit $GATE_EXIT) para ${ENTRY_ID}." >&2',
    '    # 3-decision -> block: checkpoint + deactivate this run, per § Step 4 below. STOP.',
    '  fi',
  ].join('\n');
  const b = failureBranches(before);
  assertEq(b.length, 1, 'o scanner deveria achar o ramo pré-correção');
  assertEq(hardened(b[0]), { hasSentinel: false, hasCause: false, hasDrop: false, ok: false },
    'o texto pré-correção NÃO pode passar — se passasse, o guard nasceria inerte');
});

console.log('\n=== D — forge-next: polaridade OPOSTA preservada, não achatada ===\n');

const nextBranches = failureBranches(nextMd);

test('o scanner encontra o ramo fail-closed do forge-next', () => {
  assertEq(nextBranches.length, 1, `esperava 1 ramo fail-closed no forge-next, achei ${nextBranches.length}`);
});

test('o ramo do forge-next NÃO atribui DECISION — o gateamento é afirmativo (S04/R4, retirada)', () => {
  const ex = nextBranches[0].executable;
  assert(!ex.some((l) => /^DECISION=/.test(l)),
    'atribuir DECISION no ramo fail-closed do forge-next importaria a forma do forge-auto e ' +
    'apagaria a distinção de polaridade que o review estabeleceu');
  assert(!ex.some((l) => /CLAIM_GATE_DECISION=/.test(l)),
    'a sentinela do forge-auto não pertence ao forge-next — lá o default já é não-despachar');
});

test('forge-next: DECISION só nasce no ramo de sucesso, e o dispatch só pende de `proceed`', () => {
  assert(/^\s*DECISION=\$\(node -e/m.test(nextMd),
    'DECISION precisa continuar sendo atribuída (só) a partir do JSON do gate');
  assert(/`proceed` → dispatch normal/.test(nextMd),
    'a linha afirmativa `proceed` → dispatch precisa continuar sendo a única porta de dispatch');
  assert(/gateamento aqui é \*\*afirmativo\*\*/.test(nextMd),
    'a explicitação da polaridade afirmativa (esclarecimento desta triagem) precisa estar presente');
});

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
