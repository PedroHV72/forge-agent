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
//   4. The footer shows the RUNNING version and the sentinel for "unknown" is
//      the ABSENCE of the `ForgeGitDescribe` bundle key — never a comparison
//      against `0.1.0` (D25). `0.1.0` is the placeholder in the versioned
//      Info.plist and also a legitimate version string: filtering it would blank
//      the footer for whoever actually shipped it, with no findable cause. The
//      shortcut is tempting for exactly as long as the placeholder is still
//      there, which is why this is pinned rather than trusted.
//   5. The version label wraps instead of truncating (`fixedSize`, no
//      `lineLimit(1)`). At the 180pt minimum the ellipsis eats the second number,
//      which is the one R9 says must be legible.
//   6. The preview harness is alive: `Previews.swift` exists, is inside
//      `#if DEBUG`, and still has previews. On a machine without Xcode the
//      harness is the only way to judge form at a fixed width, and a chunk that
//      deletes it would look like a passing build.
//   7. `build.sh` stamps the bundle copy of Info.plist, and stamps it strictly
//      BETWEEN the plist copy and `codesign` (D25, R8). Both fronteiras are
//      invisible at runtime — out of order, the build still exits 0 and the app
//      still launches — while one order dirties the versioned file on every build
//      and the other invalidates the signature. Nothing but a guard notices.
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
const updatesSwift = path.join(repoRoot, 'app', 'Sources', 'Forge', 'Updates.swift');
const updateCoreSwift = path.join(repoRoot, 'app', 'Sources', 'ForgeKit', 'UpdateCore.swift');
const buildSh = path.join(repoRoot, 'app', 'build.sh');

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
  // Lower bound, never an exact count: os chunks seguintes acrescentam previews.
  // Subiu de 8 para 12 no chunk 3 (seis estados do rótulo de versão a mais, hoje
  // 14 no total). Suba este número quando isso acontecer de novo; nunca o troque
  // por igualdade — foi um must-have de contagem EXATA que impediu o chunk 1 de
  // proteger o próprio harness.
  const n = countOf(previews, 'previewDisplayName');
  assert(
    n >= 12,
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

// -------------------------------------------- D25/D26: o rodapé mostra a versão

check('o rodapé monta o SidebarVersionLabel numa linha própria (D26)', () => {
  const views = stripLineComments(read(viewsSwift));
  const footer = bodyOf(views, 'private var sidebarFooter');
  assert(
    footer.includes('SidebarVersionLabel('),
    'o rodapé não monta mais o SidebarVersionLabel — a versão em execução voltou a '
      + 'não ser visível de nenhuma tela (D25/D26)'
  );
  assert(
    footer.includes('Adicionar projeto'),
    'o botão "Adicionar projeto" saiu do rodapé: a versão foi ACRESCENTADA numa '
      + 'segunda linha, não trocada pelo que já estava lá'
  );
  // A linha própria é a decisão de largura, não estética: a 180pt sobram 152pt
  // úteis e "Adicionar projeto" já toma ~100pt. Se os dois voltarem para o mesmo
  // HStack, o texto da versão trunca — e a elipse come justamente o segundo
  // número (R9).
  const atButton = footer.indexOf('Adicionar projeto');
  const atLabel = footer.indexOf('SidebarVersionLabel(');
  assert(
    atButton < atLabel,
    'o SidebarVersionLabel aparece antes do "Adicionar projeto": a versão é a '
      + 'segunda linha do rodapé'
  );
  assert(
    /VStack\(alignment:\s*\.leading/.test(footer),
    'o rodapé não empilha mais em VStack(alignment: .leading) — sem isso as duas '
      + 'linhas voltam a competir pela mesma largura'
  );
});

check('o rótulo de versão deriva o texto de VersionFooter.display (D25)', () => {
  const views = stripLineComments(read(viewsSwift));
  const label = bodyOf(views, 'struct SidebarVersionLabel');
  assert(
    label.includes('VersionFooter.display('),
    'SidebarVersionLabel não chama VersionFooter.display — os quatro estados do '
      + 'rodapé (e a decisão de divergência) são lógica pura testada em ForgeKit, '
      + 'e reimplementá-los na view os tira do alcance dos testes'
  );
});

check('a versão do rodapé leva à seção Atualizações em um clique (D26)', () => {
  const views = stripLineComments(read(viewsSwift));
  const footer = bodyOf(views, 'private var sidebarFooter');
  assert(
    /state\.section\s*=\s*\.updates/.test(footer),
    'clicar a versão não seleciona mais a seção Atualizações: `state.section` é '
      + '@Published e o binding de List(selection:) é bidirecional, então essa '
      + 'atribuição é o que também acende a linha na sidebar (D26)'
  );
});

check('o rótulo quebra em duas linhas em vez de truncar a 180pt', () => {
  const views = stripLineComments(read(viewsSwift));
  const label = bodyOf(views, 'struct SidebarVersionLabel');
  assert(
    /fixedSize\(horizontal:\s*false,\s*vertical:\s*true\)/.test(label),
    'SidebarVersionLabel perdeu `.fixedSize(horizontal: false, vertical: true)` — '
      + 'sem isso o Text é comprimido verticalmente e o pior caso a 180pt trunca'
  );
  assert(
    !/lineLimit\(1\)/.test(label),
    'apareceu `lineLimit(1)` no rótulo de versão: a 180pt o pior caso tem de '
      + 'QUEBRAR, e a elipse esconde justamente o segundo número (R9)'
  );
});

check('o único sinal de update no rodapé é laranja com ponto (D26/D27)', () => {
  const views = stripLineComments(read(viewsSwift));
  const label = bodyOf(views, 'struct SidebarVersionLabel');
  assert(
    label.includes('updateAvailable'),
    'SidebarVersionLabel não lê mais `updateAvailable` — a D27 tirou o numeral da '
      + 'lista prometendo que o sinal viveria aqui; sem isso o app perdeu o sinal'
  );
  assert(
    label.includes('accentOrange'),
    'o rótulo não usa mais Color.accentOrange: laranja = "precisa de você" é a '
      + 'regra visual 1 do arquivo, e o rodapé é agora o único lugar que a exerce'
  );
  assert(
    /circle\.fill|Circle\(\)/.test(label),
    'o ponto de update desapareceu do rótulo — cor sozinha é sinal frágil'
  );
});

// ------------------------------- a sentinela é a AUSÊNCIA da chave, não o 0.1.0

check('a versão em execução vem da chave ForgeGitDescribe do bundle (D25)', () => {
  const updates = stripLineComments(read(updatesSwift));
  assert(
    /Bundle\.main\.object\(forInfoDictionaryKey:\s*"ForgeGitDescribe"\)/.test(updates),
    'o store não lê mais `ForgeGitDescribe` do bundle — voltaria a exibir a tag do '
      + 'repo como se fosse a versão em execução, que é a mentira que a D25 conserta'
  );
  assert(
    /VersionFooter\.stamped\(/.test(updates),
    'a leitura do bundle não passa mais por VersionFooter.stamped — a decisão '
      + '"o que conta como não estampado" é pura e testada; duplicá-la na view a '
      + 'tira do alcance dos testes'
  );
});

check('nada trata o literal 0.1.0 como sentinela de "não estampado"', () => {
  // A sentinela é a AUSÊNCIA da chave custom. `0.1.0` é o placeholder do
  // Info.plist versionado E uma versão perfeitamente legítima: filtrá-la
  // apagaria o rodapé de quem a publicasse de verdade, e a causa seria
  // inachável. Este guard existe porque o atalho é tentador exatamente enquanto
  // o placeholder ainda está lá.
  for (const [name, file] of [
    ['Updates.swift', updatesSwift],
    ['UpdateCore.swift', updateCoreSwift],
    ['Views.swift', viewsSwift],
  ]) {
    const src = stripLineComments(read(file));
    assert(
      !src.includes('0.1.0'),
      `${name} compara com o literal 0.1.0: a sentinela de "build não estampado" `
        + 'é a ausência da chave ForgeGitDescribe, nunca um valor de versão'
    );
  }
});

check('VersionFooter existe em ForgeKit, com os quatro estados alcançáveis', () => {
  const core = stripLineComments(read(updateCoreSwift));
  const decl = bodyOf(core, 'public enum VersionFooter');
  for (const sig of ['static func stamped(', 'static func short(', 'static func display(']) {
    assert(decl.includes(sig), `VersionFooter perdeu \`${sig}\` — é a lógica que o `
      + 'rodapé exibe, e ela mora em ForgeKit porque o target Forge não é '
      + 'importável por target de teste');
  }
  for (const field of ['let text', 'let detail', 'let diverged', 'let known']) {
    assert(
      decl.includes(field),
      `VersionFooter.Display perdeu \`${field}\` — o rodapé precisa dos quatro: `
        + 'texto curto, frase inteira para o .help(), divergência e "sei ou não"'
    );
  }
});

check('divergência é decidida no describe completo, não na forma curta', () => {
  const core = stripLineComments(read(updateCoreSwift));
  const decl = bodyOf(core, 'public enum VersionFooter');
  const body = bodyOf(decl, 'static func display(');
  // A comparação tem de ser entre os valores crus (`r == p`), nunca entre
  // `short(r) == short(p)`: mesma tag e mesma contagem com shas diferentes é
  // justo o caso "commitei e não recompilei" que o rodapé existe para mostrar.
  assert(
    !/short\([^)]*\)\s*==\s*short\(/.test(body),
    'display() compara formas curtas: dois describes com a mesma tag e a mesma '
      + 'contagem de commits seriam lidos como "em dia" mesmo apontando para '
      + 'commits diferentes'
  );
});

// -------------------------------------- previews dos estados do rodapé (chunk 3)

check('os quatro estados do rótulo de versão têm preview a 180pt', () => {
  const previews = read(previewsSwift);
  assert(
    previews.includes('SidebarVersionLabel('),
    'nenhum preview renderiza SidebarVersionLabel — os estados dele não são '
      + 'alcançáveis por navegação (exigem um bundle estampado e um repo que andou)'
  );
  const n = countOf(previews, 'SidebarVersionLabel(');
  assert(
    n >= 5,
    `esperados >= 5 previews de SidebarVersionLabel (em dia, divergente, não `
      + `estampado, desconhecido, update disponível), encontrados ${n}`
  );
  // O estado não estampado é o que se pode rodar HOJE, antes de existir
  // estampagem nenhuma — e o que `swift run Forge` mostra para sempre.
  assert(
    /SidebarVersionLabel\(running:\s*nil/.test(previews),
    'nenhum preview cobre `running: nil` — é o estado real de todo build feito '
      + 'antes da estampagem e de qualquer `swift run`, não um caso hipotético'
  );
});

// ------------------------------------- D25/R8: build.sh estampa o bundle (chunk 4)

/// Strip WHOLE-LINE `#` comments from a shell script, and only those. Stripping
/// from the first `#` anywhere would mangle `sed 's/^# \{0,1\}//'`, which is real
/// code; and NOT stripping at all would let the long comment block that explains
/// the stamp ordering — it names `codesign`, `PlistBuddy` and `app/Info.plist` —
/// satisfy or trip every guard below on prose instead of on behaviour.
function stripShellComments(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

check('build.sh estampa as três chaves via plutil -replace (D25)', () => {
  const sh = stripShellComments(read(buildSh));
  assert(
    sh.includes('plutil -replace'),
    'a estampagem desapareceu de build.sh — sem ela `ForgeGitDescribe` nunca '
      + 'chega ao bundle e o rodapé volta a dizer "repo vX" para sempre (D25)'
  );
  for (const key of ['ForgeGitDescribe', 'CFBundleShortVersionString', 'CFBundleVersion']) {
    assert(
      new RegExp(`plutil -replace ${key}\\b`).test(sh),
      `build.sh não estampa ${key} — as três chaves têm consumidores diferentes: `
        + 'a custom alimenta o rodapé, e as duas da Apple são o que o Finder e o '
        + 'próprio macOS mostram'
    );
  }
  assert(
    !/PlistBuddy/.test(sh),
    'build.sh usa PlistBuddy: `-c "Set …"` numa chave AUSENTE sai 1, e sob '
      + '`set -euo pipefail` isso mata o build no primeiro uso. `plutil -replace` '
      + 'cria a chave e sai 0'
  );
});

check('a estampagem acontece entre o cp do plist e o codesign', () => {
  const sh = stripShellComments(read(buildSh));
  const copiedPlist = sh.indexOf('cp "${APP_DIR}/Info.plist"');
  const stamp = sh.indexOf('plutil -replace');
  const sign = sh.indexOf('codesign --force');
  assert(copiedPlist !== -1, 'o cp do Info.plist para o bundle desapareceu de build.sh');
  assert(stamp !== -1, 'nenhum `plutil -replace` em build.sh');
  assert(sign !== -1, 'o `codesign --force` desapareceu de build.sh');
  // Esta é a razão de existir deste guard: as duas fronteiras são INVISÍVEIS em
  // runtime. Fora de ordem, o build continua saindo 0 e o app continua abrindo.
  assert(
    copiedPlist < stamp,
    'a estampagem vem ANTES do `cp` do Info.plist — nessa ordem ela edita o '
      + 'app/Info.plist VERSIONADO, e cada build passa a sujar a árvore. A '
      + 'pré-checagem do atualizador in-app recusa árvore suja, então buildar '
      + 'bloquearia a própria atualização que a estampagem serve (R8)'
  );
  assert(
    stamp < sign,
    'a estampagem vem DEPOIS do `codesign` — a assinatura cobre o Info.plist, '
      + 'então nessa ordem `codesign --verify` deixa de dizer "valid on disk" e '
      + 'passa a dizer "invalid Info.plist (plist or signature have been '
      + 'modified)". Probado, não suposto'
  );
});

check('nenhuma escrita de plist tem o arquivo versionado como destino (R8)', () => {
  const sh = stripShellComments(read(buildSh));
  for (const line of sh.split('\n')) {
    if (!line.includes('plutil')) continue;
    assert(
      !line.includes('${APP_DIR}/Info.plist'),
      `uma escrita de plist tem o arquivo versionado como destino: ${line.trim()}`
    );
    assert(
      line.includes('${BUNDLE}/Contents/Info.plist'),
      `uma escrita de plist não tem a cópia do bundle como destino: ${line.trim()}`
    );
  }
});

check('o --install copia o bundle já assinado e já estampado', () => {
  const sh = stripShellComments(read(buildSh));
  const sign = sh.indexOf('codesign --force');
  const install = sh.indexOf('if $DO_INSTALL');
  assert(install !== -1, 'o bloco `if $DO_INSTALL` desapareceu de build.sh');
  assert(
    sign < install,
    'a instalação acontece antes de assinar. Mover a estampagem para depois do '
      + '`--install` "para pegar as duas cópias" pega ZERO cópias corretamente '
      + 'assinadas: /Applications recebe uma cópia do bundle já pronto'
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
