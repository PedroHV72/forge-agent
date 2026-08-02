#!/usr/bin/env node
'use strict';

// forge-app-items.test.js — standing regression guard for S05 (backlog board
// in the app): "the CLI is the only write path to the item store".
//
// This suite pins the invariant that sustains the whole slice: the app talks
// to `.gsd/items/` **only** through `scripts/forge-items.js` (shelled out via
// ForgeCore); no status semantics are reimplemented in Swift; and the board
// is actually wired into the sidebar (Section.items) and the card
// (ProjectCard's item Stat) — so an "optimization" that reads `.gsd/items/`
// directly, or a wiring regression that silently drops the Section/Stat,
// fails loudly instead of merging unnoticed.
//
// Like forge-app-workspace.test.js (the mold this is copied from), this
// suite is pure file reading — no swift invocation — so it NEVER skips and
// runs on every platform, including CI.
//
// Zero deps, standalone runner (repo convention): exit != 0 on any failure.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const appSourcesDir = path.join(repoRoot, 'app', 'Sources');
const itemsViewPath = path.join(appSourcesDir, 'Forge', 'ItemsView.swift');
const viewsPath = path.join(appSourcesDir, 'Forge', 'Views.swift');
const projectsPath = path.join(appSourcesDir, 'Forge', 'Projects.swift');
const forgeKitItemsPath = path.join(appSourcesDir, 'ForgeKit', 'Items.swift');
const previewsPath = path.join(appSourcesDir, 'Forge', 'Previews.swift');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n  ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log('\n=== forge app items board ===\n');

// Guard the whole suite on app/Sources/ existing — a missing app dir is a
// real problem in this repo, not a platform difference, so we fail loudly
// rather than skip like forge-app.test.js does for the Swift build.
if (!fs.existsSync(appSourcesDir)) {
  console.error(`✗ app/Sources/ not found at ${appSourcesDir} — this repo always has it; refusing to skip.`);
  process.exit(1);
}

// Strip `//` line comments before matching so legitimate comment mentions
// (this file's own header, `ItemsView.swift`'s doc comments explaining the
// single-write-path rule) do not false-positive the guard. Only a real code
// reference must fail the build.
function stripLineComments(line) {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

// `stripLineComments` opera linha a linha; para varrer um corpo inteiro de
// struct precisamos da versao multi-linha.
function stripAllComments(source) {
  return source.split('\n').map(stripLineComments).join('\n');
}

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n');
}

function findForbiddenPattern(filePath, pattern) {
  const hits = [];
  readLines(filePath).forEach((line, i) => {
    if (stripLineComments(line).includes(pattern)) {
      hits.push(`${path.relative(repoRoot, filePath)}:${i + 1}`);
    }
  });
  return hits;
}

check('ItemsView.swift and Views.swift and Projects.swift and ForgeKit/Items.swift and Previews.swift exist', () => {
  for (const p of [itemsViewPath, viewsPath, projectsPath, forgeKitItemsPath, previewsPath]) {
    assert(fs.existsSync(p), `not found: ${path.relative(repoRoot, p)}`);
  }
});

// --- Single write path: no direct .gsd write in ItemsView.swift ----------

check('ItemsView.swift shells out to forge-items.js via ForgeCore, never writes .gsd/ directly', () => {
  const src = fs.readFileSync(itemsViewPath, 'utf8');
  assert(src.includes('forge-items.js'), 'ItemsView.swift does not reference forge-items.js — store may be unwired');
  assert(src.includes('ForgeCore.'), 'ItemsView.swift does not call ForgeCore — shell-out layer may be bypassed');

  const forbidden = ['FileManager.default.createFile', '.write(toFile:', '.write(to:'];
  const hits = [];
  for (const pattern of forbidden) {
    hits.push(...findForbiddenPattern(itemsViewPath, pattern));
  }
  assert(
    hits.length === 0,
    'forbidden direct file write found in ItemsView.swift (the CLI must be the only write path ' +
      'to .gsd/items/ — ROADMAP Note 5):\n' + hits.map(h => `    ${h}`).join('\n')
  );
});

check('guard actually bites — a real (non-comment) direct write is detected', () => {
  // Prove the comment-stripping is not a blanket false-negative: a synthetic
  // in-memory line with a real (non-comment) occurrence must be caught by
  // the same matching logic used above.
  const fakeLine1 = '        try? contents.write(toFile: itemsPath, atomically: true, encoding: .utf8)';
  assert(stripLineComments(fakeLine1).includes('.write(toFile:'),
    'matcher failed to catch a real, non-comment .write(toFile: reference');
  const fakeLine2 = '        FileManager.default.createFile(atPath: p, contents: data)';
  assert(stripLineComments(fakeLine2).includes('FileManager.default.createFile'),
    'matcher failed to catch a real, non-comment FileManager.default.createFile reference');
  // And prove a comment-only mention is correctly ignored.
  const commentLine = '    // never call .write(toFile: here — forge-items.js owns .gsd/items/';
  assert(!stripLineComments(commentLine).includes('.write(toFile:'),
    'matcher incorrectly flagged a comment-only .write(toFile: mention');
});

// --- No store semantics reimplemented in Swift ----------------------------

check('the five status literals appear only in ForgeKit/Items.swift, not in ItemsView.swift', () => {
  const statusLiterals = ['"inbox"', '"triaged"', '"doing"', '"done"', '"dropped"'];
  const viewSrc = fs.readFileSync(itemsViewPath, 'utf8');
  const hits = statusLiterals.filter(lit => viewSrc.includes(lit));
  assert(
    hits.length === 0,
    'ItemsView.swift contains raw status string literal(s) ' + JSON.stringify(hits) +
      ' — status semantics must live only in ForgeKit/Items.swift (ItemStatus enum); the engine ' +
      '(scripts/forge-items.js) owns the closed set, Swift only labels it'
  );
});

check('guard actually bites — a real (non-comment) status literal in ItemsView.swift would be caught', () => {
  const fakeLine = '        if status == "inbox" { self.tag = "new" }';
  assert(fakeLine.includes('"inbox"'), 'matcher failed to catch a real status literal');
});

// --- Sidebar wiring: Section.items + switch branch ------------------------

check('Views.swift declares case items in the Section enum and routes to ItemsView(state: in the detail switch', () => {
  const src = fs.readFileSync(viewsPath, 'utf8');
  assert(/case\s+items\b/.test(src), 'Views.swift is missing `case items` in the Section enum');
  assert(src.includes('ItemsView(state:'), 'Views.swift detail switch is missing the ItemsView(state: branch');
});

// --- Card wiring: ProjectCard Stat for open items --------------------------

check('Projects.swift references ItemBoard.openCount and renders a Stat( for items', () => {
  const src = fs.readFileSync(projectsPath, 'utf8');
  assert(src.includes('ItemBoard.openCount'), 'Projects.swift does not reference ItemBoard.openCount — card Stat may be unwired');
  assert(/Stat\(\s*value:\s*openItems/.test(src) || /Stat\(/.test(src),
    'Projects.swift does not render a Stat( for items');
  assert(src.includes('label: "item"') || src.includes("label: \"item\""),
    'Projects.swift is missing the item-labelled Stat entry');
});

// --- Pure layer exists and is substantive ----------------------------------

check('ForgeKit/Items.swift exists, declares ItemBoard and ItemStatus, and is a plausible size', () => {
  const src = fs.readFileSync(forgeKitItemsPath, 'utf8');
  assert(src.includes('enum ItemStatus') || src.includes('ItemStatus'), 'Items.swift does not declare ItemStatus');
  assert(src.includes('enum ItemBoard') || src.includes('ItemBoard'), 'Items.swift does not declare ItemBoard');
  const lineCount = src.split('\n').length;
  assert(lineCount >= 40, `Items.swift looks too small to be the real pure layer (${lineCount} lines)`);
});

// --- No pre-macOS-13 APIs in the new/changed slice files -------------------

// O piso NAO e mais hardcoded aqui. Ele era `13`, e quando o operador decidiu
// subir para 26 (para habilitar drag entre colunas) este guard reprovou uma
// mudanca legitima enquanto afirmava uma baseline que o Package.swift ja nao
// tinha. Um guard que mente sobre a configuracao e pior que nenhum: agora ele
// LE o piso da fonte da verdade e so proibe o que estiver de fato acima dela.
function packageFloorMajor() {
  const pkg = fs.readFileSync(path.join(repoRoot, 'app', 'Package.swift'), 'utf8');
  const m = pkg.match(/platforms:\s*\[\s*\.macOS\(\s*(?:\.v(\d+)|"(\d+)(?:\.\d+)?")/);
  assert(m, 'nao consegui ler o piso de plataforma do app/Package.swift');
  return Number(m[1] || m[2]);
}

// API -> versao minima de macOS que a suporta.
const API_FLOOR = Object.freeze({
  '.onKeyPress': 14,
  '.draggable(': 14,
  '.dropDestination(': 14,
});

check('nenhuma API acima do piso declarado no Package.swift', () => {
  const floor = packageFloorMajor();
  const files = [itemsViewPath, projectsPath, viewsPath, forgeKitItemsPath];
  const hits = [];
  for (const [pattern, needs] of Object.entries(API_FLOOR)) {
    if (needs <= floor) continue;   // permitida pelo piso atual
    for (const file of files) hits.push(...findForbiddenPattern(file, pattern));
  }
  assert(
    hits.length === 0,
    `API acima do piso macOS ${floor} declarado em app/Package.swift:\n` +
      hits.map(h => `    ${h}`).join('\n')
  );
});

check('o guard de piso acompanha o Package.swift — piso lido e >= 13', () => {
  const floor = packageFloorMajor();
  assert(Number.isInteger(floor) && floor >= 13,
    `piso lido do Package.swift veio invalido: ${floor}`);
});

check('guard actually bites — a real (non-comment) above-baseline API is detected', () => {
  const fakeLine = '        content.onKeyPress(.return) { .handled }';
  assert(stripLineComments(fakeLine).includes('.onKeyPress'),
    'matcher failed to catch a real, non-comment .onKeyPress reference');
  const commentLine = '    // .onKeyPress is not available on macOS 13, do not use it here';
  assert(!stripLineComments(commentLine).includes('.onKeyPress'),
    'matcher incorrectly flagged a comment-only .onKeyPress mention');
});

// --- S04: o card se lê como issue ---

// --- 7-element card: one check per element, so a break names the culprit ---
//
// Scoped to the `ItemCard` struct body specifically — several of these names
// (item.title, item.id, item.source, ItemPriority, closedDay) also appear in
// `ItemDetailSheet`, so a whole-file `includes` would stay green even if the
// element vanished from the card itself.

function itemCardBody() {
  const src = fs.readFileSync(itemsViewPath, 'utf8');
  const m = src.match(/struct\s+ItemCard\s*:[\s\S]*?\n\}\n/);
  assert(m, 'could not locate the ItemCard struct body in ItemsView.swift');
  return m[0];
}

check('ItemCard draws the title (ItemCardPresentation.displayTitle)', () => {
  // S04 review (R2): the raw `item.title ?? "(sem título)"` moved into
  // ForgeKit so both the card and the detail sheet share one whitespace-safe
  // rule. The guard follows the code — it now looks for the call, not the
  // raw property, so a regression back to a bare `item.title` in the card
  // would NOT satisfy this check (proven by mutation below).
  assert(itemCardBody().includes('ItemCardPresentation.displayTitle'),
    'ItemCard does not call ItemCardPresentation.displayTitle — the title element may be missing or reading item.title raw again');
});

// --- Card denso: o que saiu do card tem de estar no sheet -----------------
//
// O card foi de 7 elementos para 3 (título, labels, prioridade) por decisão do
// operador, depois de ver o board real: a 268pt, corpo de 3 linhas + id de 40
// caracteres + origem + data viram parágrafo e cabiam ~3 cards na tela.
//
// Os quatro que saíram — id, origem, corpo, data — NÃO podem simplesmente
// desaparecer. Apagar os checks antigos e seguir em frente seria o mesmo erro
// que a `## Correção de critério` do SCOPE registra: um critério que passa pelo
// motivo errado. Então cada um vira um par: ausente do card, PRESENTE no
// destino (sheet e/ou tooltip).

function itemDetailSheetBody() {
  const src = fs.readFileSync(itemsViewPath, 'utf8');
  const m = src.match(/struct\s+ItemDetailSheet\s*:[\s\S]*?\n\}\n/);
  assert(m, 'could not locate the ItemDetailSheet struct body in ItemsView.swift');
  return m[0];
}

check('card denso: em repouso o card não desenha origem nem data', () => {
  const body = itemCardBody();
  for (const [needle, label] of [['item.source', 'origem'], ['closedDay', 'data de fechamento']]) {
    assert(!body.includes(needle),
      `ItemCard voltou a desenhar ${label} (${needle}) — em repouso o card mostra título, `
      + 'labels e prioridade; se a decisão mudou, mude os testes do contrato em ForgeKitTests junto');
  }
  // `item.id` recebe tratamento proprio: o card nao pode DESENHA-LO, mas pode
  // usa-lo para o clipboard (o botao "copiar id" ao lado da data). A proibicao
  // e sobre RENDERIZACAO — `Text(...)`/`Label(...)` recebendo o id.
  assert(!/(?:Text|Label)\(\s*(?:item\.id|ItemCardPresentation\.shortID)/.test(body),
    'ItemCard voltou a DESENHAR o id — usar item.id para clipboard/tooltip é permitido, renderizá-lo não');
});

check('o corpo só aparece expandido — nunca em repouso', () => {
  // `bodyPreview` voltou ao card DE PROPOSITO (o operador pediu que o mouse
  // expandisse o resumo). O que a densidade exige e que ele NAO esteja presente
  // em repouso: se alguem tirar a condicao, o card volta a ser o de 7 elementos
  // em silencio.
  const body = itemCardBody();
  const lines = body.split('\n').map(stripLineComments);
  const idx = lines.findIndex((l) => l.includes('bodyPreview'));
  assert(idx !== -1, 'ItemCard não referencia bodyPreview — a expansão sumiu');
  const window = lines.slice(Math.max(0, idx - 3), idx + 1).join('\n');
  assert(/if\s+expanded\s*,/.test(window),
    'bodyPreview no ItemCard não está atrás de `if expanded,` — o corpo voltou a ser '
    + 'desenhado em repouso e o card denso deixou de ser denso');
});

check('a expansão exige DWELL, não hover cru', () => {
  // A diferenca nao e cosmetica: com expansao instantanea, arrastar o ponteiro
  // por uma coluna reflui todo card que ele cruza e o board inteiro ondula
  // enquanto o operador so esta viajando ate outro lugar.
  const body = itemCardBody();
  const src = stripAllComments(body);
  assert(/\.onHover\s*\{/.test(src), 'ItemCard não tem .onHover — a expansão perdeu o gatilho');
  assert(/Task\.sleep/.test(src),
    'o handler de hover não dorme antes de expandir — `expanded` estaria sendo ligado no hover cru, '
    + 'sem o dwell de ItemCardPresentation.hoverExpandDelaySeconds');
  assert(/hoverExpandDelaySeconds/.test(src),
    'o atraso não vem de ItemCardPresentation.hoverExpandDelaySeconds — um literal enterrado na view '
    + 'é exatamente o que a constante nomeada existe para evitar');
  assert(/dwell\?\.cancel\(\)/.test(src),
    'o dwell não é cancelado — um card por onde o ponteiro só passou expandiria um segundo depois, '
    + 'pelas costas do operador');
});

check('os ícones de ação têm caixa fixa — nenhum fica maior por ter glifo mais largo', () => {
  const src = fs.readFileSync(itemsViewPath, 'utf8');
  const m = src.match(/struct\s+IconAction[\s\S]*?\n\}\n/);
  assert(m, 'não encontrei a struct IconAction — o wrapper dos ícones de ação sumiu');
  const body = stripAllComments(m[0]);
  assert(/\.frame\(\s*width:\s*\d+\s*,\s*height:\s*\d+\s*\)/.test(body),
    'IconAction não fixa a caixa do glifo — sem isso o badge fica tão largo quanto o símbolo que '
    + 'carrega, e arrow.left.arrow.right (dois glifos lado a lado) parece maior que terminal na '
    + 'mesma fonte. A caixa fixa é o que permite escolher o ícone por significado, não por largura');
});

check('linha de metadados: todo badge usa o mesmo modificador de tamanho', () => {
  // "tudo do mesmo tamanho" so continua verdade se for propriedade do codigo.
  // Antes havia tres alturas na mesma linha: capsulas 5/1, Labels sem padding e
  // icones sem caixa.
  const body = stripAllComments(itemCardBody());
  const badgeCarriers = ['systemImage: "lock"', 'systemImage: "checklist"',
                         'systemImage: "clock"', 'systemImage: "doc.on.doc"',
                         'systemImage: "arrow.left.arrow.right"', 'systemImage: "terminal"'];
  // Cada readout/acao da linha tem de estar a <= 4 linhas de um .metaBadge(.
  const lines = body.split('\n');
  for (const carrier of badgeCarriers) {
    const i = lines.findIndex((l) => l.includes(carrier));
    if (i === -1) continue;   // elemento pode ter saido do card por decisao
    const window = lines.slice(Math.max(0, i - 3), i + 5).join('\n');
    assert(/\.metaBadge\(|IconAction\(/.test(window),
      `o badge com ${carrier} não passa por .metaBadge( — ele voltou a ter altura própria, `
      + 'e a linha de metadados volta a ter tamanhos diferentes');
  }
  assert(/func metaBadge\(/.test(fs.readFileSync(itemsViewPath, 'utf8')),
    'o modificador metaBadge sumiu — não há mais uma métrica única para os badges');
});

check('o id continua alcançável do card — pelo botão de copiar', () => {
  const body = itemCardBody();
  assert(/NSPasteboard[\s\S]{0,200}item\.id/.test(body),
    'o card não copia o id para o clipboard — com o hover expandindo o resumo em vez de mostrar '
    + 'dados, este botão passou a ser o único caminho do id a partir do card');
});

check('guard morde — bodyPreview solto (sem hover) é pego', () => {
  const fake = ['                let x = 1', '                ItemCardPresentation.bodyPreview(item.body)'];
  const idx = fake.findIndex((l) => l.includes('bodyPreview'));
  const window = fake.slice(Math.max(0, idx - 3), idx + 1).join('\n');
  assert(!/if\s+hovering\s*,/.test(window),
    'matcher falharia em detectar um bodyPreview fora de uma condição de hover');
});

check('o que saiu do card está no ItemDetailSheet — id, origem, corpo e data', () => {
  const sheet = itemDetailSheetBody();
  assert(sheet.includes('item.id'), 'o id sumiu do card E do sheet — isso é perda, não densidade');
  assert(sheet.includes('item.source'), 'a origem sumiu do card E do sheet');
  // `includes('item.body')` NÃO serve aqui, e isso foi provado por mutação: o
  // sheet mencionava `item.body` numa condição de estilo, então apagar a
  // renderização deixava o guard verde com o corpo fora da tela. O que importa
  // é que o corpo chegue a um RENDERIZADOR, não que seja mencionado.
  //
  // Dois renderizadores são aceitos porque os dois de fato desenham o corpo:
  // `MarkdownBody(source:)` (atual — parseia blocos via MarkdownDoc) e
  // `Text(item.body)` (o anterior, texto cru). Fixar só o primeiro amarraria o
  // guard à implementação de hoje pela segunda vez.
  assert(/MarkdownBody\(\s*source:\s*item\.body/.test(sheet) || /Text\(\s*item\.body/.test(sheet),
    'o sheet não entrega item.body a um renderizador (MarkdownBody ou Text) — o corpo '
    + 'sumiu do card E do sheet, que era o destino declarado por D8 '
    + '(mencionar item.body numa condição não conta)');
  assert(sheet.includes('closedDay'), 'a data de fechamento sumiu do card E do sheet');
});

check('guard morde — um sheet sem item.body é pego', () => {
  const fake = 'struct ItemDetailSheet: View {\n  var body: some View { Text(item.id) }\n}\n';
  assert(!fake.includes('item.body'),
    'matcher falharia em detectar um sheet que perdeu o corpo');
});

// --- No priority literal in ItemsView.swift, same rule as status ----------

check('the four priority literals appear only in the pure layer, not in ItemsView.swift', () => {
  const priorityLiterals = ['"p0"', '"p1"', '"p2"', '"p3"'];
  const hits = [];
  for (const lit of priorityLiterals) {
    hits.push(...findForbiddenPattern(itemsViewPath, lit));
  }
  assert(
    hits.length === 0,
    'ItemsView.swift contains raw priority string literal(s):\n' + hits.map(h => `    ${h}`).join('\n') +
      ' — the closed set (p0..p3) is the engine\'s (S01/D7); Swift only labels it'
  );
});

check('guard actually bites — a real (non-comment) priority literal in ItemsView.swift would be caught', () => {
  const fakeLine = '        if raw == "p1" { self.mark = "!" }';
  assert(stripLineComments(fakeLine).includes('"p1"'), 'matcher failed to catch a real priority literal');
  const commentLine = '    // priority values are "p0".."p3", the engine owns the set';
  assert(!stripLineComments(commentLine).includes('"p1"'),
    'matcher incorrectly flagged a comment-only priority literal mention');
});

// --- Pure presentation layer: the view must not truncate/cut on its own ---

check('ItemsView.swift references ItemCardPresentation — truncation/cuts stay in ForgeKit', () => {
  const src = fs.readFileSync(itemsViewPath, 'utf8');
  assert(
    src.includes('ItemCardPresentation'),
    'ItemsView.swift no longer references ItemCardPresentation — if the view started truncating/cutting ' +
      'on its own, the rule stopped being testable headless, which is exactly why T01 exists'
  );
});

// --- Preview: PreviewProvider, never #Preview -------------------------------

check('Previews.swift declares ItemCardPreviews as a PreviewProvider, and never uses the #Preview macro', () => {
  const raw = fs.readFileSync(previewsPath, 'utf8');
  const strippedLines = raw.split('\n').map(stripLineComments).join('\n');
  assert(raw.includes('ItemCardPreviews'), 'Previews.swift is missing ItemCardPreviews');
  assert(/struct\s+ItemCardPreviews\s*:\s*PreviewProvider/.test(raw),
    'ItemCardPreviews does not conform to PreviewProvider');
  assert(
    !strippedLines.includes('#Preview'),
    'Previews.swift contains the #Preview macro outside a comment — this repo builds against Command Line ' +
      'Tools, where #Preview does not compile (PreviewsMacros plugin unavailable); use PreviewProvider'
  );
});

check('guard actually bites — a real (non-comment) #Preview usage would be caught, a header mention would not', () => {
  const fakeLine = '#Preview("card") { ItemCard(item: .init()) }';
  assert(stripLineComments(fakeLine).includes('#Preview'), 'matcher failed to catch a real #Preview usage');
  const commentLine = '// WHY PreviewProvider AND NOT #Preview';
  assert(!stripLineComments(commentLine).includes('#Preview'),
    'matcher incorrectly flagged a comment-only #Preview mention (Previews.swift header prose)');
});

// --- Detail sheet: present, and rendering the full body, not the preview ---

check('ItemsView.swift wires ItemDetailSheet via .sheet(item:', () => {
  const src = fs.readFileSync(itemsViewPath, 'utf8');
  assert(src.includes('ItemDetailSheet'), 'ItemsView.swift does not reference ItemDetailSheet — the detail sheet may be missing');
  assert(src.includes('.sheet(item:'), 'ItemsView.swift does not present a sheet via .sheet(item: — the detail sheet may not be wired');
});

check('ItemDetailSheet body renders the whole item.body, not bodyPreview', () => {
  const src = fs.readFileSync(itemsViewPath, 'utf8');
  const structMatch = src.match(/struct\s+ItemDetailSheet\s*:[\s\S]*?\n\}\n/);
  assert(structMatch, 'could not locate the ItemDetailSheet struct body in ItemsView.swift');
  const body = structMatch[0];
  assert(body.includes('item.body'), 'ItemDetailSheet does not reference item.body — the full body may be missing');
  assert(
    !body.includes('bodyPreview'),
    'ItemDetailSheet references bodyPreview — the detail sheet must render the whole body, not the truncated ' +
      'preview (that would reintroduce the problem D8 was written to fix)'
  );
});

check('guard actually bites — bodyPreview inside ItemDetailSheet would be caught', () => {
  const fakeStruct = 'struct ItemDetailSheet: View {\n' +
    '    var body: some View {\n' +
    '        Text(ItemCardPresentation.bodyPreview(item.body)?.text ?? "")\n' +
    '    }\n}\n';
  const structMatch = fakeStruct.match(/struct\s+ItemDetailSheet\s*:[\s\S]*?\n\}\n/);
  assert(structMatch && structMatch[0].includes('bodyPreview'),
    'matcher failed to catch a real bodyPreview reference inside a synthetic ItemDetailSheet body');
});

// --- S05: filtro por label ---
//
// Scoped to the `ItemsView` struct body, the same technique as
// itemCardBody() above: a whole-file `includes` would stay green even if
// `ItemBoard.columns`/`.unknown` moved back to reading `store.items`
// directly, or `ItemLabelFilter.apply` vanished from the view, because both
// `store.items` and `ItemLabelFilter` also appear elsewhere in this file
// (inside `ItemsStore`). One check per property, so a break names the
// culprit (D-S05-2, LOCKED).

function itemsViewBody() {
  const src = fs.readFileSync(itemsViewPath, 'utf8');
  const m = src.match(/struct\s+ItemsView\s*:[\s\S]*?\n\}\n/);
  assert(m, 'could not locate the ItemsView struct body in ItemsView.swift');
  return m[0];
}

check('ItemsView delega o casamento a ForgeKit, nunca reimplementa', () => {
  // Era `includes('ItemLabelFilter.apply')`. Isso fixava QUAL funcao, nao a
  // propriedade: quando o campo passou a buscar titulo/id/label (porque um
  // filtro so-de-label devolve vazio em board sem labels), a view trocou para
  // `ItemSearch.apply` e este guard reprovou uma delegacao perfeitamente
  // correta. O que importa e que a regra viva em ForgeKit, onde e testavel sem
  // tela — qual das duas regras a view usa e decisao de produto.
  const body = itemsViewBody();
  assert(/ItemSearch\.apply|ItemLabelFilter\.apply/.test(body),
    'ItemsView não chama nenhuma regra de casamento de ForgeKit (ItemSearch.apply ou '
    + 'ItemLabelFilter.apply) — o casamento pode ter sido reimplementado na view ou perdido');
});

check('guard morde — uma ItemsView sem regra de ForgeKit é pega', () => {
  const fakeBody = 'struct ItemsView: View {\n    var body: some View { Text("x") }\n}\n';
  assert(!/ItemSearch\.apply|ItemLabelFilter\.apply/.test(fakeBody),
    'matcher failed to catch the absence of ItemLabelFilter.apply in a synthetic body lacking it');
});

check('ItemBoard.columns and ItemBoard.unknown both read the filtered list, not store.items directly', () => {
  const body = itemsViewBody();
  const strippedBody = body.split('\n').map(stripLineComments).join('\n');
  const forbidden = ['ItemBoard.columns(store.items)', 'ItemBoard.unknown(store.items)'];
  const hits = forbidden.filter(p => strippedBody.includes(p));
  assert(
    hits.length === 0,
    'ItemsView feeds ' + JSON.stringify(hits) + ' from store.items directly — the "Desconhecido" column ' +
      'would then disagree with the visible-card count (D-S05-2, LOCKED; S05 Acceptance Criteria #5)'
  );
});

check('guard actually bites — a real (non-comment) store.items regression in ItemBoard.unknown would be caught', () => {
  const fakeLine = '                    let unknown = ItemBoard.unknown(store.items)';
  assert(stripLineComments(fakeLine).includes('ItemBoard.unknown(store.items)'),
    'matcher failed to catch a real, non-comment ItemBoard.unknown(store.items) regression');
  const commentLine = '                    // never call ItemBoard.unknown(store.items) here, use visibleItems';
  assert(!stripLineComments(commentLine).includes('ItemBoard.unknown(store.items)'),
    'matcher incorrectly flagged a comment-only ItemBoard.unknown(store.items) mention');
});

check('a busca da view é ItemSearch, e a regra exata de label continua existindo', () => {
  // O campo passou a buscar titulo/id/label (substring) porque um filtro que so
  // casa label devolve vazio em todo board sem labels. A regra EXATA do
  // criterio #5 nao foi afrouxada: ela continua em ItemLabelFilter, com o
  // fixture de paridade contra o `jq` intacto. As duas coexistem de proposito —
  // confundi-las faria "ui" casar "ui-bug", que e a divergencia de 1 card que o
  // criterio chama de falha.
  const view = stripAllComments(fs.readFileSync(itemsViewPath, 'utf8'));
  assert(/ItemSearch\.apply/.test(view),
    'a view não usa ItemSearch.apply — o campo voltou a filtrar só por label e fica inerte '
    + 'em qualquer board cujos itens não tenham labels');
  const kit = fs.readFileSync(path.join(appSourcesDir, 'ForgeKit', 'ItemFilter.swift'), 'utf8');
  assert(/enum ItemLabelFilter/.test(kit),
    'ItemLabelFilter sumiu — a regra exata que o critério #5 prova contra o jq foi apagada junto '
    + 'com a troca do campo, e a paridade deixou de ter dono');
  assert(/enum ItemSearch/.test(kit), 'ItemSearch não está em ForgeKit — a regra de busca voltou para a view');
});

check('a contagem de cards visíveis está na tela (D-S05-3)', () => {
  // Antes este guard exigia a struct `LabelFilterField`, que hospedava o
  // numero. Ela deixou de existir: o filtro virou `.searchable` nativo e a
  // contagem foi para `.navigationSubtitle`. O guard fixava o ENDERECO; o que
  // o criterio #5 exige e a PROPRIEDADE — que o numero que a UAT compara com o
  // `jq` continue visivel em algum lugar da tela.
  const src = stripAllComments(fs.readFileSync(itemsViewPath, 'utf8'));
  assert(/visibleItems\.count/.test(src),
    'ItemsView não referencia visibleItems.count — a contagem de cards visíveis sumiu, e com ela '
    + 'a paridade tela↔CLI que o critério #5 exige (D-S05-3)');
  assert(/\bcards\b/.test(src),
    'a palavra "cards" não aparece junto do número — o valor estaria na tela mas sem rótulo, '
    + 'e a UAT compara um número com o jq, não um número anônimo');
});

check('guard morde — uma ItemsView sem visibleItems.count é pega', () => {
  const fake = 'struct ItemsView: View { var body: some View { Text("Tarefas") } }';
  assert(!/visibleItems\.count/.test(fake),
    'matcher falharia em detectar a ausência da contagem de cards visíveis');
});


// `\.labels\b` (word boundary after "labels") deliberately does not match
// `.labelsHidden(` — a Picker modifier already in this struct that has
// nothing to do with reading an item's labels — while still matching
// `item.labels` and `item.labels?`.
const LABELS_READ_RE = /\.labels\b(?!Hidden)/;

check('ItemsView does not reimplement label matching by hand — no .labels read inside the struct', () => {
  const strippedBody = itemsViewBody().split('\n').map(stripLineComments).join('\n');
  assert(
    !LABELS_READ_RE.test(strippedBody),
    'ItemsView struct body reads .labels directly — label matching would be reimplemented in the view instead ' +
      'of delegated to ItemLabelFilter (the only legitimate .labels read outside the pure layer is inside ' +
      'ItemDetailSheet, a separate struct, out of this scope)'
  );
});

check('guard actually bites — a real (non-comment) .labels read inside ItemsView would be caught', () => {
  const fakeLine = '            if item.labels?.contains(query) == true { adjust() }';
  assert(LABELS_READ_RE.test(stripLineComments(fakeLine)),
    'matcher failed to catch a real, non-comment .labels reference');
  const commentLine = '            // .labels is read in ItemDetailSheet, not here';
  assert(!LABELS_READ_RE.test(stripLineComments(commentLine)),
    'matcher incorrectly flagged a comment-only .labels mention');
  const noiseLine = '                .labelsHidden().frame(width: 190)';
  assert(!LABELS_READ_RE.test(stripLineComments(noiseLine)),
    'matcher incorrectly flagged .labelsHidden( as a .labels read');
});

check('the label menu suggestions come from the pure layer (ItemLabelFilter.availableLabels)', () => {
  const src = fs.readFileSync(itemsViewPath, 'utf8');
  assert(src.includes('ItemLabelFilter.availableLabels'),
    'ItemsView.swift does not call ItemLabelFilter.availableLabels — the label menu suggestions may be ' +
      'missing or reimplemented by hand');
});

check('guard actually bites — a synthetic line without ItemLabelFilter.availableLabels would be caught', () => {
  const fakeSrc = 'let labels: [String] = computeLabelsByHand(store.items)\n';
  assert(!fakeSrc.includes('ItemLabelFilter.availableLabels'),
    'matcher failed to catch the absence of ItemLabelFilter.availableLabels in a synthetic line lacking it');
});

// --- S06: o board origina trabalho, e só pelo botão ---
//
// D9/F7 (LOCKED): mover um card nunca abre `/forge-task`; só o botão
// "Começar" pode, e só depois de passar por `ItemLaunch.decide` (a camada
// pura de T01). Os guards abaixo pinam que a view não tem como burlar essa
// regra: existe exatamente UM call site de `newSession(` no arquivo inteiro,
// ele mora dentro de `startWork`, e o caminho de mover (`onMove:`) não o
// alcança — mesmo que alguém "otimize" e chame `newSession` direto de outro
// lugar. Todo casamento é feito sobre fonte com `//` já removido
// (stripLineComments), no mesmo molde de todo o resto deste arquivo — um
// grep ingênuo sobre o texto cru "provaria" um invariante que já não vale.

function itemsViewStrippedLines() {
  return readLines(itemsViewPath).map(stripLineComments);
}

/**
 * The comment-stripped body of the first declaration whose (stripped) line
 * contains `signature`, delimited by brace balance — same technique as
 * forge-app-terminal.test.js's functionBody(), reimplemented here rather than
 * shared across files because this repo's suites are standalone (zero deps,
 * no cross-file require).
 */
function bodyFrom(lines, signature) {
  const start = lines.findIndex(l => l.includes(signature));
  assert(start !== -1, `could not locate "${signature}" in ItemsView.swift`);
  let depth = 0;
  let started = false;
  const body = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') depth--;
    }
    body.push(line);
    if (started && depth === 0) break;
    assert(i - start < 400, `body of "${signature}" never closed — extraction failed`);
  }
  return { code: body.join('\n'), startLine: start, endLine: start + body.length - 1 };
}

/** All occurrences of a brace-delimited body starting with `signature`, in file order. */
function allBodiesFrom(lines, signature) {
  const bodies = [];
  let searchStart = 0;
  while (searchStart < lines.length) {
    const rel = lines.slice(searchStart).findIndex(l => l.includes(signature));
    if (rel === -1) break;
    const start = searchStart + rel;
    let depth = 0;
    let started = false;
    const body = [];
    let end = start;
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') depth--;
      }
      body.push(line);
      end = i;
      if (started && depth === 0) break;
    }
    bodies.push(body.join('\n'));
    searchStart = end + 1;
  }
  return bodies;
}

check('newSession( occurs exactly once (non-comment) in ItemsView.swift', () => {
  const lines = itemsViewStrippedLines();
  const count = lines.filter(l => l.includes('newSession(')).length;
  assert(
    count === 1,
    `newSession( occurs ${count} times in ItemsView.swift (non-comment), expected exactly 1 — a ` +
      'second path to /forge-task is exactly how the D9/F7 counter-criterion becomes violable again'
  );
});

check('guard actually bites — a second real newSession( call site is caught, a comment mention is not', () => {
  const fakeLines = [
    '    state.newSession(cwd: project, mode: .task, text: req.taskArgument, account: "")',
    '    // never call state.newSession(cwd: here a second time',
    '    state.newSession(cwd: project, mode: .plain, text: "", account: "")',
  ].map(stripLineComments);
  const count = fakeLines.filter(l => l.includes('newSession(')).length;
  assert(count === 2, 'matcher failed to distinguish two real call sites from one commented-out mention');
});

check('the newSession( call site sits inside startWork, and nowhere else in the file', () => {
  const lines = itemsViewStrippedLines();
  const { code, startLine, endLine } = bodyFrom(lines, 'private func startWork(');
  assert(code.includes('newSession('), 'startWork does not call newSession( — the launch may have moved elsewhere');
  const outside = lines.filter((_, i) => i < startLine || i > endLine).join('\n');
  assert(
    !outside.includes('newSession('),
    'newSession( appears outside startWork — a second call site bypasses ItemLaunch.decide entirely'
  );
});

check('guard actually bites — newSession( outside startWork is caught', () => {
  const lines = [
    'private func startWork(_ item: Item) {',
    '    guard let req = ItemLaunch.decide(.start(item)) else { return }',
    '}',
    'private func somethingElse() {',
    '    state.newSession(cwd: project, mode: .task, text: "x", account: "")',
    '}',
  ];
  const { startLine, endLine } = bodyFrom(lines, 'private func startWork(');
  const outside = lines.filter((_, i) => i < startLine || i > endLine).join('\n');
  assert(outside.includes('newSession('), 'matcher failed to catch newSession( living outside startWork');
});

check('startWork calls ItemLaunch.decide before newSession — the pure layer decides, this only executes', () => {
  const lines = itemsViewStrippedLines();
  const { code } = bodyFrom(lines, 'private func startWork(');
  const decideIdx = code.indexOf('ItemLaunch.decide');
  const sessionIdx = code.indexOf('newSession(');
  assert(decideIdx !== -1, 'startWork does not call ItemLaunch.decide — the launch decision may have been reimplemented here');
  assert(sessionIdx !== -1, 'startWork does not call newSession(');
  assert(
    decideIdx < sessionIdx,
    'startWork calls newSession( before (or without going through) ItemLaunch.decide — the pure layer must decide first'
  );
});

check('guard actually bites — newSession( before ItemLaunch.decide is caught', () => {
  const code = 'state.newSession(cwd: project, mode: .task, text: item.id, account: "")\n' +
    'guard let req = ItemLaunch.decide(.start(item)) else { return }';
  const decideIdx = code.indexOf('ItemLaunch.decide');
  const sessionIdx = code.indexOf('newSession(');
  assert(sessionIdx < decideIdx, 'matcher failed to catch newSession( occurring before ItemLaunch.decide');
});

check('startWork forwards req.taskArgument to text:, never item.id or a title concatenation (D-S06-4)', () => {
  const lines = itemsViewStrippedLines();
  const { code } = bodyFrom(lines, 'private func startWork(');
  assert(code.includes('text: req.taskArgument'),
    'startWork does not pass text: req.taskArgument — D-S06-4 requires the pure LaunchRequest.taskArgument, not a value recomputed here');
  assert(!code.includes('text: item.id'),
    'startWork passes text: item.id directly — this bypasses LaunchRequest.taskArgument (D-S06-4)');
  assert(!code.includes('item.title'),
    'startWork references item.title — a title concatenation into text: is exactly what D-S06-4 forbids');
});

check('guard actually bites — text: item.id or a title concatenation is caught', () => {
  const codeA = 'state.newSession(cwd: project, mode: .task, text: item.id, account: "")';
  assert(codeA.includes('text: item.id'), 'matcher failed to catch text: item.id');
  const codeB = 'state.newSession(cwd: project, mode: .task, text: "/forge-task \\(item.title)", account: "")';
  assert(codeB.includes('item.title'), 'matcher failed to catch an item.title concatenation');
});

check('every onMove: closure calls only store.setStatus — never newSession or ItemLaunch.decide', () => {
  const lines = itemsViewStrippedLines();
  const bodies = allBodiesFrom(lines, 'onMove: {');
  // Was `=== 2` (one closure per column). That pinned an implementation detail,
  // not the property: factoring columnView + unknownColumn onto a shared
  // `boardColumn` helper dropped the count to 1 and failed a guard whose whole
  // subject — "a move never originates work" — had gotten STRONGER, since one
  // shared closure cannot drift from its twin. The property is "at least one
  // move path exists, and EVERY one of them is clean"; `forEach` below already
  // covers every closure however many there are.
  assert(bodies.length >= 1, `expected at least one onMove: closure, found ${bodies.length}`);
  // Duas formas legitimas coexistem desde que a coluna virou `BoardColumnView`:
  // a TERMINAL (`store.setStatus`, em ItemsView) e a de ENCAMINHAMENTO
  // (`onMove(item, $0)`, dentro da coluna, que so repassa para cima). Exigir
  // `store.setStatus` de todas reprovava o encaminhamento, que nao e um caminho
  // novo — e o mesmo caminho, com um salto a mais. A proibicao dura (nunca
  // newSession, nunca ItemLaunch.decide) continua valendo para TODAS.
  let terminals = 0;
  bodies.forEach((body, i) => {
    const terminal = body.includes('store.setStatus');
    if (terminal) terminals++;
    assert(terminal || /onMove\(/.test(body),
      `onMove: closure #${i + 1} nao chama store.setStatus nem encaminha para onMove( — `
      + 'um caminho de mover que nao faz nem uma coisa nem outra e um gesto morto ou um caminho novo nao auditado');
    assert(!body.includes('newSession'),
      `onMove: closure #${i + 1} reaches newSession — a drag-move must never originate work (D9/F7, LOCKED)`);
    assert(!body.includes('ItemLaunch.decide'),
      `onMove: closure #${i + 1} reaches ItemLaunch.decide — moving a card is not a launch gesture`);
  });
  // Se TODAS encaminharem, o gesto nao chega ao engine: mover pararia de mover
  // e a suite ficaria verde porque nenhuma closure individual violou nada.
  assert(terminals >= 1,
    'nenhuma closure onMove: chega a store.setStatus — o gesto de mover nao alcanca o engine');
});

check('guard actually bites — an onMove: closure reaching newSession is caught', () => {
  const fakeBody = 'onMove: { status in\n    state.newSession(cwd: project, mode: .task, text: item.id, account: "")\n}';
  assert(fakeBody.includes('newSession'), 'matcher failed to catch newSession inside a synthetic onMove: closure');
});

check('ItemCard still offers "Mover para", and its body only calls onMove(', () => {
  const lines = itemsViewStrippedLines();
  const { code: cardCode } = bodyFrom(lines, 'struct ItemCard');
  const cardLines = cardCode.split('\n');
  const { code: menuCode } = bodyFrom(cardLines, 'Menu("Mover para")');
  assert(menuCode.includes('onMove('), 'Menu("Mover para") body does not call onMove( — the move gesture may have been dropped');
  assert(!menuCode.includes('onStart'),
    'Menu("Mover para") body calls onStart — moving a card must never be able to trigger a launch');
  assert(!menuCode.includes('newSession'),
    'Menu("Mover para") body reaches newSession — the counter-criterion this menu exercises would go empty');
});

check('guard actually bites — a "Mover para" menu calling onStart is caught', () => {
  const fakeCard = [
    'Menu("Mover para") {',
    '    ForEach(otherStatuses, id: \\.self) { s in',
    '        Button(s.label) { onStart() }',
    '    }',
    '}',
  ];
  const { code } = bodyFrom(fakeCard, 'Menu("Mover para")');
  assert(code.includes('onStart'), 'matcher failed to catch onStart inside a synthetic "Mover para" menu body');
});

check('the "Começar" button keeps .buttonStyle(.borderless), so it does not also open the detail sheet (D-S06-5)', () => {
  // Comment-stripped, unlike itemCardBody(): the struct's own doc-comment
  // explains .buttonStyle(.borderless) in prose right above the line that
  // applies it, so a raw (non-stripped) `includes` would stay green even if
  // the modifier were deleted from the real code and only the comment
  // survived — proven by mutation during T03 execution.
  const lines = itemsViewStrippedLines();
  const { code } = bodyFrom(lines, 'struct ItemCard');
  assert(code.includes('Começar'), 'ItemCard no longer has a "Começar" button');
  assert(code.includes('.buttonStyle(.borderless)'),
    'ItemCard\'s "Começar" button lost .buttonStyle(.borderless) — it now fires alongside the card\'s own ' +
      '.onTapGesture, so clicking it also pops the detail sheet (D-S06-5)');
});

check('guard actually bites — a "Começar" button without .buttonStyle(.borderless) is caught, a comment mention is not', () => {
  const fakeLines = [
    'Button("Começar") { onStart() }',
    '    .font(.caption2)',
    '    // .buttonStyle(.borderless) used to be here, removed by mistake',
  ].map(stripLineComments);
  const code = fakeLines.join('\n');
  assert(!code.includes('.buttonStyle(.borderless)'),
    'matcher failed to catch the absence of .buttonStyle(.borderless) in a synthetic body lacking it ' +
      '(a comment-only mention must not satisfy the guard)');
});

check('ItemsStore never references newSession or AppState — it only talks to the engine', () => {
  const lines = itemsViewStrippedLines();
  const { code } = bodyFrom(lines, 'final class ItemsStore');
  assert(!code.includes('newSession'),
    'ItemsStore references newSession — the store must never talk to the terminal/session layer, only forge-items.js');
  assert(!code.includes('AppState'),
    'ItemsStore references AppState — the store must stay UI-agnostic, only ItemsView (the view) may hold an AppState');
});

check('guard actually bites — an ItemsStore referencing AppState is caught', () => {
  const fakeBody = 'final class ItemsStore: ObservableObject {\n    let state: AppState\n}';
  assert(fakeBody.includes('AppState'), 'matcher failed to catch a synthetic ItemsStore body referencing AppState');
});

// --- S06 review R2: the context-menu "Começar" must not lie about ---
// eligibility. The inline button already carries
// `.disabled(!ItemLaunch.canStart(item))`; the context menu's own
// "Começar" needs the same guard, sourced from the same pure layer,
// so an ineligible item cannot present an action that silently no-ops.

check('context menu\'s "Começar" carries .disabled(!ItemLaunch.canStart(item)), same as the inline button', () => {
  const lines = itemsViewStrippedLines();
  const { code } = bodyFrom(lines, '.contextMenu {');
  assert(code.includes('Começar'), 'contextMenu no longer has a "Começar" button');
  assert(code.includes('.disabled(!ItemLaunch.canStart(item))'),
    'contextMenu\'s "Começar" button lost .disabled(!ItemLaunch.canStart(item)) — an ineligible item would ' +
      'show a menu action that silently no-ops (review R2)');
});

check('guard actually bites — a context-menu "Começar" without .disabled is caught, a comment mention is not', () => {
  const fakeLines = [
    'Button("Começar") { onStart() }',
    '    // .disabled(!ItemLaunch.canStart(item)) used to be here, removed by mistake',
    'Button("Ver detalhe") { onOpenDetail() }',
  ].map(stripLineComments);
  const code = fakeLines.join('\n');
  assert(!code.includes('.disabled(!ItemLaunch.canStart(item))'),
    'matcher failed to catch the absence of .disabled(!ItemLaunch.canStart(item)) in a synthetic context ' +
      'menu body lacking it (a comment-only mention must not satisfy the guard)');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
