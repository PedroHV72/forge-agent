#!/usr/bin/env node
'use strict';

/**
 * forge-app-projects-digest.test.js — source pins for the Projects screen.
 *
 * WHY PINS AND NOT TESTS. `ForgeKitTests` cannot import the `Forge` executable
 * target, so no SwiftUI view in `app/Sources/Forge/` is reachable from the
 * Swift suite. The behaviour that IS pure — the rollup, the comparator, the
 * weight scale, the collapse codec — is tested for real in
 * `Sources/ForgeKitTests/main.swift`; what remains here is the WIRING: whether
 * the view actually calls that pure layer and whether the two properties this
 * change exists for survive an edit. These are structural assertions over
 * source text, and they are stated as such rather than dressed up as coverage.
 *
 * The two properties:
 *
 *   1. THE ALWAYS-ZERO COUNTER ROW IS GONE. On the operator's machine every
 *      registered project rendered "0 perguntas · 0 runs · 0 sessões · 0
 *      itens" — correct, useless, and the whole area of the card. A count may
 *      only be drawn when it is non-zero.
 *
 *   2. GIT IS NOT ON THE RELOAD PATH. Git costs ~102 ms per card (measured in
 *      `ProjectDigest`) and the screen reloads every 15 s plus on FSEvents; 20
 *      projects would be ~2 s of blocking git per reload. The cheap digest
 *      must be loaded with `git: .none` and git filled in separately.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const projectsPath = path.join(repoRoot, 'app/Sources/Forge/Projects.swift');
const attentionPath = path.join(repoRoot, 'app/Sources/ForgeKit/ProjectAttention.swift');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push({ name, error: e.message }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const src = fs.readFileSync(projectsPath, 'utf8');

/** Drop `//` comments so prose describing the old behaviour is never matched. */
function stripComments(text) {
  return text.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}
const code = stripComments(src);

// --- 1. The counters -------------------------------------------------------

test('o card não desenha mais a fileira de contadores sempre-zero', () => {
  // The two counts that were zero for every project on the operator's real
  // machine and had no guard at all.
  assert(!/Stat\(value:\s*runsHere\.count/.test(code),
    'Projects.swift ainda desenha Stat(value: runsHere.count) — a fileira de zeros voltou; ' +
    'um run ativo é o ponto verde no header, não um número "1 run" ao lado de três zeros');

  // Every remaining Stat( must sit behind a non-zero guard. Checked
  // structurally: the `signals` block is what holds them.
  const i = code.indexOf('private var signals');
  assert(i >= 0, 'o bloco `signals` sumiu de Projects.swift — regex quebrou ou a fiação mudou');
  const body = code.slice(i, i + 1400);
  assert(/if\s+!gatesHere\.isEmpty\s*\|\|\s*openItems\s*>\s*0/.test(body),
    '`signals` não está mais atrás de uma guarda de não-vazio — pode ter voltado a imprimir zeros');
  for (const guard of ['!gatesHere.isEmpty', 'openItems > 0', '!sessionsHere.isEmpty']) {
    assert(body.includes(guard), `\`signals\` perdeu a guarda \`${guard}\``);
  }
});

test('o sinal vivo é um ponto, e as perguntas continuam gritando', () => {
  assert(/if\s+!runsHere\.isEmpty\s*\{[\s\S]{0,200}?Circle\(\)/.test(code),
    'o ponto verde de run ativa sumiu do card — o sinal vivo que substituiu o contador ' +
    'não pode desaparecer junto com ele');
  assert(/Stat\(value:\s*gatesHere\.count[^)]*accent:\s*true/.test(code),
    'a contagem de perguntas perdeu o destaque — atenção nunca pode ficar silenciosa');
});

// --- 2. The digest, and git off the reload path -----------------------------

test('o card carrega o digest barato primeiro e o git fora do caminho de reload', () => {
  const i = code.indexOf('private func refresh()');
  assert(i >= 0, 'refresh() não encontrado em Projects.swift');
  const body = code.slice(i, i + 2000);

  assert(/ProjectDigest\.load\(path:[\s\S]{0,160}?git:\s*\.none\)/.test(body),
    'o digest barato não é mais carregado com `git: .none` — a carga de ~102 ms/card entrou ' +
    'no caminho que roda a cada 15 s e a cada FSEvent');
  assert(/gitField\s*=\s*await\s+Task\.detached[\s\S]{0,200}?ProjectDigest\.loadGit\(/.test(body),
    'o git deixou de ser preenchido num Task.detached separado — ou voltou para dentro da ' +
    'carga barata, ou saiu da tela');

  // The cache that was rejected upstream and must not come back: .git/HEAD and
  // .git/index do not move when an untracked file appears, so a dirty-state
  // cache keyed on them prints "limpo" for a tree that is not.
  assert(!/\.git\/HEAD|\.git\/index/.test(code),
    'Projects.swift referencia .git/HEAD ou .git/index — sinal do cache de git que foi ' +
    'recusado: esses mtimes não se movem quando um arquivo não rastreado aparece');
});

test('nenhum campo do digest é impresso cru — toda ausência vem nomeada do ForgeKit', () => {
  assert(/identity\.display/.test(code) && /identity\.isPresent/.test(code),
    'a linha de identidade não usa mais DigestText.display/isPresent — pode ter virado uma ' +
    'string vazia quando não há PROJECT.md');
  assert(/case\s+\.absent\(let\s+why\)/.test(code),
    'o card não renderiza mais o texto de ausência dos campos do digest — uma linha em branco ' +
    'é indistinguível de um bug de renderização');
  assert(/digest\?\.roleLine/.test(code),
    'o card não usa mais ProjectDigest.roleLine — "0 repos" pode ter voltado para o projeto ' +
    'mais denso em repos registrado');
  assert(!/repos\s*\?\?\s*0/.test(code),
    'Projects.swift colapsa uma contagem de repos ausente em 0 — ausência de medição não é ' +
    'um zero medido');
});

// --- 3. The tree: rollup, order, weight, collapse ---------------------------

test('a árvore consome a camada pura em vez de reimplementá-la', () => {
  for (const [symbol, why] of [
    ['ProjectTreeAttention.rollup(', 'o roll-up nos ancestrais saiu da árvore'],
    ['ProjectTreeAttention.ordered(', 'a ordenação por relevância saiu da árvore'],
    ['ProjectWeight.of(', 'o peso visual por nível saiu da árvore'],
    ['CollapseStore.decode(', 'a memória de colapso saiu da árvore'],
  ]) {
    assert(code.includes(symbol), `Projects.swift não chama mais ${symbol} — ${why}`);
  }
  assert(/@AppStorage\("projectsCollapsed"\)/.test(code),
    'o conjunto de pastas fechadas não é mais persistido em @AppStorage — o colapso volta a ' +
    'esquecer a cada lançamento');
  assert(!/@State\s+private\s+var\s+collapsed:\s*Set<String>\s*=\s*\[\]/.test(code),
    'o `collapsed` voltou a ser @State puro — memória de colapso perdida entre lançamentos');
});

test('a ordem da árvore não é mais o caminho, e o comparador é único', () => {
  // The flat list must go through the same function as the tree. If `ordered`
  // grows a second sorted{} body here, the two modes can disagree about which
  // project comes first — which is what the operator saw before.
  const i = code.indexOf('private func ordered(');
  assert(i >= 0, 'ordered() não encontrado em Projects.swift');
  const body = code.slice(i, i + 400);
  assert(/ProjectTreeAttention\.ordered\(paths:/.test(body),
    'ordered() não delega mais a ProjectTreeAttention — um segundo comparador nasceu na view');
  assert(!/\.sorted\s*\{/.test(body),
    'ordered() voltou a ordenar sozinha — a lista e a árvore podem discordar de novo');
});

test('a pasta fechada diz o que esconde, não só quantos projetos', () => {
  const i = code.indexOf('private var header: some View');
  assert(i >= 0, 'o header da pasta não foi encontrado em Projects.swift');
  const body = code.slice(i, i + 2200);
  assert(/isCollapsed\s*\{[\s\S]{0,200}?rollup\.summary/.test(body),
    'a pasta fechada não imprime mais rollup.summary — voltou a esconder runs e sujeira atrás ' +
    'de uma contagem de projetos');
  assert(/rollup\.runs\s*>\s*0/.test(body),
    'o header da pasta não sinaliza mais run ativa lá dentro — colapsar volta a apagar da tela ' +
    'um run em execução');
  assert(!/state\.pending\.filter/.test(body),
    'o header voltou a somar state.pending direto — esse era o roll-up parcial que só contava ' +
    'perguntas e perdia todo o resto');
});

// --- 4. The pure layer is where the logic lives -----------------------------

test('a lógica pura mora no ForgeKit, testável, e a view só desenha', () => {
  const attn = fs.readFileSync(attentionPath, 'utf8');
  for (const decl of ['struct ProjectAttention', 'struct ProjectRollup',
                      'enum ProjectTreeAttention', 'enum ProjectWeight', 'enum CollapseStore']) {
    assert(attn.includes(decl), `ProjectAttention.swift não declara mais ${decl}`);
  }
  assert(!/import SwiftUI|import AppKit/.test(attn),
    'ProjectAttention.swift importa SwiftUI/AppKit — a camada pura deixaria de ser exercitável ' +
    'por ForgeKitTests');
  assert(!/FileManager|ProcessInfo|homeDirectory/.test(attn),
    'ProjectAttention.swift toca o filesystem ou o ambiente — a pureza é o que permite testar ' +
    'a mesma coisa duas vezes (o $HOME difere entre `swift run` e run-tests.js)');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
