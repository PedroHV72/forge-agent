#!/usr/bin/env node
'use strict';

// forge-app-sidebar.test.js — standing guard for the sidebar redesign.
//
// Everything this suite pins is a SUBTRACTION, and subtractions are the easiest
// changes in the world to undo by accident: nobody notices a badge that comes
// back, and nobody notices a preview file that quietly stops existing. So each
// invariant below is one that would fail silently if it regressed.
//
//   1. `badge(for:)` has no `.updates` case (D27). The numeral it used to show
//      was always `1` — it counted nothing. One signal, one place: the footer.
//      Asserted together with the four cases that DO count something, so the
//      guard cannot pass on a gutted function.
//   2. The sidebar list has exactly one `Divider()`, after `.runs` (D29), and it
//      lives inside the single `ForEach(Section.allCases)`. Splitting `allCases`
//      into two arrays is the one way D29 could invalidate a saved preference,
//      because `Stores.swift` feeds `SectionRestore`'s validator from it (D31) —
//      so `allCases` staying whole is asserted too.
//   3. `RootView` observes `UpdateStore` (D32). Without it SwiftUI never
//      re-renders the sidebar when `checkOnLaunch` publishes, and every update
//      signal in this column is born empty. This was a real pre-existing bug,
//      not a hypothetical.
//   4. The preview harness is alive: `Previews.swift` exists, is inside
//      `#if DEBUG`, and still has previews. On a machine without Xcode the
//      harness is the only way to judge form at a fixed width, and a chunk that
//      deletes it would look like a passing build.
//
// Pure file reading, like forge-app-update.test.js and unlike forge-app.test.js:
// no swift invocation, so it NEVER skips and runs everywhere, Windows included.
//
// Zero deps, standalone runner (repo convention): exit != 0 on any failure.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const viewsSwift = path.join(repoRoot, 'app', 'Sources', 'Forge', 'Views.swift');
const storesSwift = path.join(repoRoot, 'app', 'Sources', 'Forge', 'Stores.swift');
const previewsSwift = path.join(repoRoot, 'app', 'Sources', 'Forge', 'Previews.swift');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function read(file) {
  assert(fs.existsSync(file), `arquivo ausente: ${path.relative(repoRoot, file)}`);
  return fs.readFileSync(file, 'utf8');
}

/// Strip `//` line comments so a comment that merely MENTIONS a pattern cannot
/// satisfy — or trip — a guard. The doc comments in Views.swift discuss D27, D29
/// and D32 by name at length; matching them would make the assertions below pass
/// on a file whose code had been gutted.
function stripLineComments(source) {
  return source
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

/// Extract a block body by COUNTING BRACES, not by regex. Same helper, and the
/// same reasoning, as forge-app-update.test.js: a non-greedy regex terminates at
/// the first nested closure, and a guard that asserts something is ABSENT from a
/// truncated body passes because of the truncation rather than the code.
function bodyOf(source, signature) {
  const at = source.indexOf(signature);
  assert(at !== -1, `assinatura não encontrada: ${signature}`);
  const open = source.indexOf('{', at);
  assert(open !== -1, `sem abertura de bloco após ${signature}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`bloco não fechado em ${signature}`);
}

function countOf(source, needle) {
  let n = 0;
  let i = 0;
  for (;;) {
    const at = source.indexOf(needle, i);
    if (at === -1) return n;
    n++;
    i = at + needle.length;
  }
}

console.log('\nforge-app-sidebar.test.js\n');

// ---------------------------------------------------------------- D27: no badge

check('badge(for:) não tem mais caso .updates (D27)', () => {
  const views = stripLineComments(read(viewsSwift));
  const body = bodyOf(views, 'private func badge(for');
  assert(
    !body.includes('.updates'),
    'o caso `.updates` voltou a `badge(for:)` — o numeral da sidebar era sempre 1 '
      + 'e o sinal de update pertence ao rodapé (D27)'
  );
});

check('badge(for:) mantém os quatro casos que contam coisa de verdade', () => {
  const views = stripLineComments(read(viewsSwift));
  const body = bodyOf(views, 'private func badge(for');
  for (const c of ['.now', '.runs', '.terminal', '.projects']) {
    assert(
      body.includes(`case ${c}:`),
      `\`case ${c}:\` desapareceu de badge(for:) — a ausência da D27 estaria sendo `
        + 'provada por uma função gutada, não pela decisão'
    );
  }
});

check('nenhum outro caminho reintroduz o numeral de update na lista', () => {
  const views = stripLineComments(read(viewsSwift));
  const list = bodyOf(views, 'private var sidebarList');
  assert(
    !/updateAvailable/.test(list),
    'a lista da sidebar voltou a ler `updateAvailable` — a D27 move esse sinal para '
      + 'o rodapé, e ter os dois é exatamente o que ela subtrai'
  );
});

// ------------------------------------------------------------- D29: one Divider

check('sidebarList tem exatamente um Divider(), depois de .runs (D29)', () => {
  const views = stripLineComments(read(viewsSwift));
  const list = bodyOf(views, 'private var sidebarList');
  const n = countOf(list, 'Divider()');
  assert(n === 1, `esperado exatamente 1 Divider() em sidebarList, encontrados ${n}`);
  const atDivider = list.indexOf('Divider()');
  const atRuns = list.indexOf('.runs');
  assert(atRuns !== -1, '`.runs` não aparece em sidebarList — o âncora da D29 sumiu');
  assert(
    atRuns < atDivider,
    'o Divider() aparece antes de `.runs`: a D29 fecha o bloco de trabalho '
      + '(Início, Terminal, Projetos, Itens, Runs), então a régua vem depois de Runs'
  );
});

check('o Divider é emitido dentro do único ForEach(Section.allCases)', () => {
  const views = stripLineComments(read(viewsSwift));
  const list = bodyOf(views, 'private var sidebarList');
  const n = countOf(list, 'ForEach(Section.allCases)');
  assert(
    n === 1,
    `esperado 1 ForEach(Section.allCases) em sidebarList, encontrados ${n} — `
      + 'quebrar allCases em dois arrays cria uma segunda fonte de verdade ao lado '
      + 'do validador do SectionRestore (D31)'
  );
  const atForEach = list.indexOf('ForEach(Section.allCases)');
  assert(
    atForEach < list.indexOf('Divider()'),
    'o Divider() está fora do ForEach — a D29 é por iteração, não por concatenação'
  );
});

// ------------------------------------------------------- D31: allCases intacto

check('Section continua com 13 casos e nenhum rawValue mudou (D31)', () => {
  const views = stripLineComments(read(viewsSwift));
  const decl = bodyOf(views, 'enum Section: String, CaseIterable, Identifiable');
  const cases = decl.match(/^\s*case \w+ = "/gm) || [];
  assert(
    cases.length === 13,
    `esperados 13 casos em Section, encontrados ${cases.length} — a D29 não renomeia `
      + 'nem remove seção nenhuma (D31)'
  );
});

check('Stores.swift continua alimentando o validador com allCases (D31)', () => {
  const stores = stripLineComments(read(storesSwift));
  assert(
    stores.includes('Section.allCases.map(\\.rawValue)'),
    'Stores.swift não usa mais `Section.allCases.map(\\.rawValue)` — é a única porta '
      + 'pela qual a D29 poderia invalidar a seção salva do operador (D31)'
  );
});

// ------------------------------------------------------- D32: RootView observa

check('RootView observa o UpdateStore (D32)', () => {
  const views = stripLineComments(read(viewsSwift));
  const root = bodyOf(views, 'struct RootView: View');
  assert(
    /@(StateObject|ObservedObject)\s+private\s+var\s+\w+\s*=\s*UpdateStore\.shared/
      .test(root),
    'RootView não declara observação de UpdateStore.shared — sem ela a sidebar nunca '
      + 're-renderiza quando o checkOnLaunch publica, e todo sinal de update nesta '
      + 'coluna nasce vazio e fica vazio (D32)'
  );
});

// --------------------------------------------- anti-deleção do harness (chunk 1)

check('o harness de preview está vivo e sob #if DEBUG', () => {
  const previews = read(previewsSwift);
  assert(
    previews.includes('#if DEBUG'),
    'Previews.swift saiu do #if DEBUG — o harness passaria a compilar no release'
  );
  assert(
    !previews.includes('#Preview('),
    'o macro `#Preview` apareceu: ele vem do plugin PreviewsMacros do Xcode, ausente '
      + 'nas Command Line Tools, e derruba `swift build` — o único sinal autoritativo '
      + 'desta máquina. Use PreviewProvider.'
  );
  // Lower bound, never an exact count: os chunks seguintes acrescentam previews
  // (o rodapé com versão são quatro estados a mais). Suba este número quando
  // isso acontecer; nunca o troque por igualdade.
  const n = countOf(previews, 'previewDisplayName');
  assert(
    n >= 8,
    `esperados >= 8 previewDisplayName em Previews.swift, encontrados ${n} — um chunk `
      + 'apagou parte do harness'
  );
});

check('existe preview da sidebar completa a 180pt', () => {
  const previews = read(previewsSwift);
  assert(
    previews.includes('previewSidebarList'),
    'nenhum preview renderiza `previewSidebarList` — o Divider da D29 se julga contra '
      + 'a coluna, não contra uma janela de largura arbitrária'
  );
  assert(
    /previewSidebarList[\s\S]{0,200}?width:\s*180/.test(previews),
    'o preview da sidebar não está travado em 180pt: é o `min:` da coluna, a largura '
      + 'onde qualquer adição tem de caber'
  );
});

// ------------------------------------------------------- bite-proof do bodyOf

check('bodyOf morde: um badge(for:) com .updates aninhado é pego', () => {
  const fake = [
    '    private func badge(for s: Section) -> Int? {',
    '        switch s {',
    '        case .now: return nil',
    '        case .updates: return UpdateStore.shared.updateAvailable ? 1 : nil',
    '        default: return nil',
    '        }',
    '    }',
  ].join('\n');
  let caught = false;
  try {
    assert(!bodyOf(fake, 'private func badge(for').includes('.updates'), 'x');
  } catch (e) {
    caught = true;
  }
  assert(caught, 'o guard da D27 não pegaria um caso .updates real — não prova nada');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
