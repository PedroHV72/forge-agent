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
  // Aberta ou fechada, a pasta diz quanto representa. No rewrite `apps`
  // renderizou pelado onde antes lia `apps 5`: uma pasta que não diz quanto
  // esconde é justamente o roll-up que esta tela existe para dar.
  assert(/rollup\.projects\s*>\s*0[\s\S]{0,200}?Text\("\\\(rollup\.projects\)"\)/.test(body),
    'o header da pasta não imprime mais a contagem de projetos ao lado do nome — `apps 5` ' +
    'voltou a ser só `apps`');
  assert(!/state\.pending\.filter/.test(body),
    'o header voltou a somar state.pending direto — esse era o roll-up parcial que só contava ' +
    'perguntas e perdia todo o resto');
});

// --- 3b. Git: the card may not claim a measurement it does not have ---------

test('o card nunca imprime "sem git" — a ausência medida vem nomeada do ForgeKit', () => {
  // Dois repositórios REAIS (`feirao-do-lu`, `lookchina/apps/fenrir`) leram
  // "sem git" na tela do operador enquanto `git status` os respondia em
  // milissegundos no shell. "sem git" é a ausência NOMEADA — quer dizer
  // "medido, e não há". O card estava fazendo uma afirmação falsa confiante
  // sobre o disco do operador, que é a classe de falha que esta base inteira
  // caça. A frase só pode nascer no `ProjectDigest.loadGit`, de um caso só.
  assert(!/"sem git"/.test(code),
    'Projects.swift escreve a string "sem git" — a view voltou a decidir sozinha o que é ' +
    'ausência de repositório; essa frase pertence a ProjectDigest.loadGit(.notARepository)');

  // A distinção MUDOU DE LUGAR, não afrouxou: quando a linha de git ganhou
  // ícone, a regra de composição desceu para `GitGlyph.of` no ForgeKit — onde
  // `ForgeKitTests` alcança e prova o comportamento, em vez de um regex sobre a
  // view provar a forma. Estes asserts seguem a lógica até lá e acrescentam o
  // que antes não dava para exigir: que a view não possa mais re-derivar nada.
  const i = code.indexOf('private var gitLine');
  assert(i >= 0, 'gitLine não encontrado em Projects.swift');
  // Só o corpo do `gitLine`: o `gitStyle` logo abaixo abre o enum de TOM, que
  // é outro tipo — incluí-lo faria este assert acusar a tradução tom→cor, que é
  // exatamente o que a view ainda pode fazer.
  const end = code.indexOf('private func gitStyle', i);
  assert(end > i, 'gitStyle não encontrado depois de gitLine — a fatia abaixo perdeu o fim');
  const body = code.slice(i, end);
  assert(/GitGlyph\.of\(gitField\b/.test(body),
    'gitLine não delega mais a GitGlyph.of — a regra de composição da linha de git voltou ' +
    'para dentro da view, fora do alcance do ForgeKitTests');
  // Este pin FICOU MAIS APERTADO quando a linha ganhou a marca do host, não mais
  // frouxo: a chamada deixou de ser `of(gitField)` exata, então em lugar de
  // relaxar o regex ele passou a exigir também DE ONDE vem o remoto. A view
  // repassa o que o digest mediu e não lê `.git/config` por conta própria —
  // senão haveria um segundo leitor de remoto, fora do alcance do ForgeKitTests
  // e livre para desenhar um logo que ninguém mediu.
  // Apertou de novo quando a linha ganhou SEGMENTOS: o parâmetro deixou de ser
  // só o host e passou a ser o `GitOrigin` inteiro (host + NOME do repositório,
  // de uma leitura só de `.git/config`). O nome do repositório é uma medição
  // como qualquer outra — se a view pudesse derivá-lo, o candidato óbvio seria
  // o nome da PASTA, que já é o título do card: dois fatos aparentes, uma
  // medição só.
  assert(/GitGlyph\.of\(gitField,\s*origin:\s*digest\?\.origin\)/.test(body),
    'gitLine não repassa mais `digest?.origin` — ou a view parou de informar host e nome do ' +
    'repositório, ou passou a derivá-los sozinha; ambos são AFIRMAÇÕES e têm de vir de uma ' +
    'medição do digest');
  assert(!/lastPathComponent|URL\(fileURLWithPath/.test(body),
    'gitLine deriva um nome de caminho — o nome da pasta se passando por nome do repositório é ' +
    'exatamente a afirmação falsa que esta linha vem removendo');
  assert(!/GitRemoteHost|GitHostKind|\.git\/config/.test(body),
    'gitLine lê o remoto por conta própria — um segundo leitor é como os dois divergem, e este ' +
    'desenha um logo');
  // A marca só pode ser desenhada quando o ForgeKit disse que HÁ marca. Um `if`
  // sobre o host cru na view seria a view decidindo o que foi medido.
  assert(/g\.host\.mark/.test(body),
    'gitLine não consulta mais `g.host.mark` — a decisão de desenhar o logo saiu do ForgeKit');
  assert(!/case\s+\.(state|absent|unavailable)\b/.test(body),
    'gitLine voltou a abrir o DigestGitField sozinha — com o campo em mãos ela pode desenhar ' +
    'branch para um diretório que não é repositório, que é exatamente o bug');
  assert(!/Image\(systemName:\s*"/.test(body),
    'gitLine desenha um símbolo LITERAL — todo glifo desta linha tem de vir do GitGlyph, senão ' +
    'existe um nome de SF Symbol que o harness nunca valida (e um inválido é um quadrado branco)');

  const digest = stripComments(fs.readFileSync(
    path.join(repoRoot, 'app/Sources/ForgeKit/ProjectDigest.swift'), 'utf8'));
  // Prefixo sem o parêntese de fecho: a regra ganhou um segundo parâmetro
  // (`remote:`) e uma âncora que exigisse `)` acusaria a assinatura em vez da
  // regra. O que este teste protege são os quatro casos abaixo, não a aridade.
  const j = digest.indexOf('static func of(_ field: DigestGitField?');
  assert(j >= 0, 'GitGlyph.of não encontrado — a regra de composição da linha de git sumiu');
  const rule = digest.slice(j, j + 1800);
  for (const [caso, porque] of [
    ['.state', 'o estado medido com repositório'],
    ['.absent', 'a ausência MEDIDA — a única que pode ler "sem git"'],
    ['.unavailable', 'a medição que FALHOU, que não é uma ausência'],
    ['.none', 'o "ainda não perguntado" — git roda fora do ciclo de recarga'],
  ]) {
    assert(new RegExp(`case\\s+\\${caso}\\b`).test(rule),
      `GitGlyph.of não distingue mais ${caso}: perdeu ${porque}`);
  }
  for (const tom of ['.clean', '.dirty', '.absent', '.failed', '.pending']) {
    // `tone: X`, ou os dois ramos do ternário limpo/sujo (`? .dirty : .clean`).
    assert(new RegExp(`(tone:|\\?|:)\\s*\\${tom}\\b`).test(rule),
      `GitGlyph.of não emite mais o tom ${tom} — dois estados passaram a desenhar igual`);
  }
});

test('a divergência da branch padrão vem pronta do ForgeKit — a view não a re-deriva', () => {
  // O quinto fato da linha de git: quanto este branch andou em relação à
  // padrão do projeto (`main` na maioria dos projetos do operador, `master`
  // neste). É medido contra um ref DIFERENTE do upstream, então tem tom próprio
  // — e é justamente por precisar de cor própria que ele existe como marca
  // separada em vez de mais um `·` no texto.
  //
  // A mesma disciplina do assert acima vale aqui: se a view puder abrir o
  // `GitBaseline`, ela pode desenhar "= main" para um repositório cuja padrão
  // nunca foi resolvida — a afirmação fabricada que este trabalho remove.
  const i = code.indexOf('private var gitLine');
  const end = code.indexOf('private func gitStyle', i);
  assert(end > i, 'gitLine/gitStyle não encontrados em Projects.swift');
  const body = code.slice(i, end);

  // A presença do nome não basta, e isso foi VISTO: `if let b = g.baseline,
  // false {` mantém a string no arquivo e apaga a marca da tela. O pino exige a
  // condição SEM cláusula extra, e o texto de fato desenhado.
  assert(/if let b = g\.baseline \{/.test(body),
    'gitLine não desenha mais g.baseline sem condição extra — a marca pode ter sido ' +
    'apagada por uma cláusula, e um segmento omitido é indistinguível de "em dia com a padrão"');
  assert(/Text\(b\.text\)/.test(body),
    'gitLine não imprime mais b.text — a marca ficou sem palavra nenhuma');
  assert(!/GitBaselineMark\.of\(|case\s+\.(measured|unknown)\b/.test(body),
    'gitLine abre o GitBaseline sozinha — a regra de composição da marca tem de morar no ' +
    'ForgeKit, onde ForgeKitTests alcança');
  assert(!/\b(ahead|behind|onDefault|defaultBranch)\b/.test(body),
    'gitLine toca os números da divergência — com eles em mãos ela pode inverter frente/atrás, ' +
    'que é o erro plausível e invisível desta feature');

  // E a view continua tendo UMA opinião só: tom → cor, para todos os tons.
  const styleEnd = code.indexOf('\n    }', code.indexOf('private func gitStyle'));
  const style = code.slice(code.indexOf('private func gitStyle'), styleEnd);
  for (const tom of ['.level', '.ahead', '.behind', '.diverged', '.undetermined']) {
    assert(new RegExp(`case\\s[^:]*\\${tom}\\b`).test(style),
      `gitStyle não mapeia o tom ${tom} — um tom sem cor desenha como o vizinho, e dois ` +
      `fatos viram um`);
  }

  const digest = stripComments(fs.readFileSync(
    path.join(repoRoot, 'app/Sources/ForgeKit/ProjectDigest.swift'), 'utf8'));
  const j = digest.indexOf('static func of(_ baseline: GitBaseline?)');
  assert(j >= 0, 'GitBaselineMark.of não encontrado — a regra de composição da marca sumiu');
  const rule = digest.slice(j, j + 2200);
  // Os dois não-medidos precisam existir separados: `.unknown` é "medido e
  // irresolúvel", `.none` é "ainda não medido". Colapsá-los é a regressão.
  assert(/case\s+\.unknown\b/.test(rule), 'GitBaselineMark.of perdeu o caso .unknown');
  assert(/case\s+\.none\b/.test(rule), 'GitBaselineMark.of perdeu o caso .none (não medido)');
  assert(/onDefault/.test(rule),
    'GitBaselineMark.of não distingue mais "você ESTÁ na padrão" de "nivelado com ela"');
});

test('a linha de git é uma LISTA de segmentos vinda do ForgeKit, não uma string na view', () => {
  // O pedido do operador: nome do repo ao lado do ícone do host, branch ao lado
  // do ícone de branch, alterações com cor, e à-frente/atrás com cor. Nada disso
  // é expressável sobre um `Text` só — a estrutura tem de existir no modelo. E
  // tem de existir no ForgeKit: `ForgeKitTests` não importa o alvo `Forge`, então
  // uma linha montada na view seria verificável só olhando para uma tela.
  const i = code.indexOf('private var gitLine');
  const end = code.indexOf('private func gitStyle', i);
  assert(end > i, 'gitLine/gitStyle não encontrados em Projects.swift');
  const body = code.slice(i, end);

  assert(/ForEach\(g\.segments/.test(body),
    'gitLine não desenha mais g.segments — a linha voltou a ser um run só, onde nada pode ter ' +
    'ícone próprio nem cor própria');
  assert(/Text\(seg\.text\)/.test(body) && /gitStyle\(seg\.tone\)/.test(body),
    'o segmento perdeu a palavra ou o tom — um par ícone+texto sem uma das duas metades');
  assert(!/GitRowSegment\.compose\(/.test(body),
    'gitLine compõe os segmentos sozinha — a regra tem de morar no ForgeKit, onde o ' +
    'ForgeKitTests alcança');
  assert(!/\bdirty\b|\bahead\b|\bbehind\b|\bupstream\b/.test(body),
    'gitLine toca os fatos do git direto — com eles em mãos ela pode desenhar "0 à frente" para ' +
    'uma branch que nunca teve upstream');
  assert(/seg\.kind/.test(body),
    'a view não distingue mais os segmentos por `kind` — se passar a casar por PALAVRA, o ' +
    'layout quebra na primeira mudança de texto em pt-BR');

  const digest = stripComments(fs.readFileSync(
    path.join(repoRoot, 'app/Sources/ForgeKit/ProjectDigest.swift'), 'utf8'));
  const j = digest.indexOf('static func compose(_ s: GitStatusSnapshot');
  assert(j >= 0, 'GitRowSegment.compose sumiu — a regra de composição da linha não existe mais');
  const rule = digest.slice(j, j + 3000);
  for (const [k, why] of [
    ['.repo', 'o nome do repositório, que é o fato novo desta linha'],
    ['.branch', 'a branch'],
    ['.changes', 'as alterações não commitadas'],
    ['.upstream', 'a divergência do upstream'],
  ]) {
    assert(rule.includes('kind: ' + k), `compose não emite mais o segmento ${k}: perdeu ${why}`);
  }
  // O caso que não pode calar: sem upstream é um `else`, não uma omissão. Se
  // virar omissão, ele desenha igual a "em dia" — dois fatos diferentes.
  assert(/\}\s*else\s*\{[\s\S]{0,400}?kind:\s*\.upstream/.test(rule),
    'o ramo "sem upstream" sumiu de compose — um fato NÃO medido passou a desenhar como o ' +
    'zero medido de "em dia com o upstream"');
});

test('o git é re-perguntado quando falhou, e nunca quando foi medido', () => {
  const i = code.indexOf('private func refresh()');
  const body = code.slice(i, i + 2600);
  assert(/isUnavailable\s*==\s*true/.test(body),
    'refresh() não re-tenta mais o git não-medido — um card fica 15 s sem saber nada do ' +
    'próprio repositório depois de uma falha transitória');
  assert(!/\.absent[\s\S]{0,40}Task\.sleep/.test(body),
    'refresh() parece re-perguntar uma ausência medida — só a falha de medição é retentável');
});

test('Git.invoke não estaciona o chamador num semáforo — foi isso que apagou o git da tela', () => {
  const git = stripComments(fs.readFileSync(
    path.join(repoRoot, 'app/Sources/ForgeKit/GitCore.swift'), 'utf8'));
  const i = git.indexOf('static func invoke(');
  assert(i >= 0, 'Git.invoke não encontrado — a chamada de processo foi renomeada ou removida');
  const body = git.slice(i, git.indexOf('static func run(', i));

  // Todo chamador é um `Task.detached`, isto é, uma thread do pool COOPERATIVO,
  // que tem uma thread por core e não cresce. A versão anterior lia o pipe em
  // `DispatchQueue.global()` e bloqueava o chamador num semáforo até essa
  // leitura sinalizar — com uma tela cheia de cards, todas as threads
  // cooperativas ficavam paradas no `wait()` e o trabalho que as acordaria não
  // tinha onde ser agendado. Medido com 40 sondas concorrentes de um repo real:
  // 32/40 devolviam nil em 20,10 s; lendo antes de esperar, 0/40 em 0,29 s.
  assert(!/DispatchSemaphore/.test(body),
    'Git.invoke voltou a bloquear o chamador num DispatchSemaphore — com uma tela de cards ' +
    'isso trava o pool cooperativo e todo git vira timeout, que é o "sem git" de volta');
  assert(/readDataToEndOfFile\(\)[\s\S]{0,200}?waitUntilExit\(\)/.test(body),
    'Git.invoke não drena mais o pipe ANTES de reapear — a ordem inversa é o deadlock que o ' +
    'timeout existia para sobreviver');
  assert(/case\s+\.timedOut|return\s+\.timedOut/.test(body),
    'Git.invoke não distingue mais timeout de saída não-zero — sem isso o classificador não ' +
    'consegue recusar "sem git" para um repo que só não respondeu');
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

// --- 5. Marcas vendorizadas: o caminho do arquivo até a tela ---------------
//
// `ForgeKitTests` prova o que dá para provar de dentro do processo de teste:
// que toda `BrandMark` resolve, carrega, é template e rasteriza. O que ele NÃO
// alcança é a montagem do `.app` — e é justamente ali que mora a falha
// invisível: `swift run` acha o resource bundle ao lado do executável, então a
// suíte inteira fica verde enquanto o `.app` montado pelo `build.sh`, cujo
// binário mora em `Contents/MacOS` sem bundle nenhum ao lado, não acha nada.
// Estes pins existem porque essa lacuna não aparece em teste nem em crash: o
// app abre normalmente e desenha o fallback (ou, sem fallback, nada).

test('as marcas vendorizadas estão no repositório, com a licença que exigem', () => {
  const dir = path.join(repoRoot, 'app/Sources/ForgeKit/Resources/icons');
  assert(fs.existsSync(dir), 'a pasta de ícones vendorizados sumiu');
  const svgs = fs.readdirSync(dir).filter(f => f.endsWith('.svg')).sort();
  assert(svgs.length > 0, 'nenhum SVG vendorizado — pin cego');

  // Todo caso do enum tem arquivo. O sentido inverso (arquivo sem caso) é
  // conferido pelo ForgeKitTests contra o BUNDLE, que é onde ele importa.
  const brand = fs.readFileSync(
    path.join(repoRoot, 'app/Sources/ForgeKit/BrandMark.swift'), 'utf8');
  const casos = [...brand.matchAll(/case\s+\w+\s*=\s*"([^"]+)"/g)].map(m => m[1]);
  assert(casos.length > 0, 'nenhum caso de BrandMark encontrado — o regex quebrou');
  for (const c of casos) {
    assert(svgs.includes(c + '.svg'),
      `BrandMark.${c} não tem arquivo — um nome que não resolve é um quadrado em branco`);
  }

  // MIT exige o aviso JUNTO das cópias. É a única parte deste trabalho em que
  // um descuido seria uma violação de licença e não um bug.
  const lic = path.join(dir, 'LICENSE-octicons.txt');
  assert(fs.existsSync(lic), 'a licença MIT dos Octicons não viaja com as cópias');
  assert(/MIT License/.test(fs.readFileSync(lic, 'utf8')), 'LICENSE-octicons.txt não é o MIT');
  // Simple Icons é CC0 e não exige aviso, mas a procedência tem de ser
  // rastreável: sem ela, ninguém sabe o que são estes arquivos nem como
  // re-obtê-los.
  const prov = path.join(dir, 'PROVENANCE.md');
  assert(fs.existsSync(prov), 'PROVENANCE.md sumiu — os arquivos viraram anônimos');
  const provText = fs.readFileSync(prov, 'utf8');
  for (const fonte of ['simpleicons.org', 'octicons', 'CC0']) {
    assert(provText.includes(fonte), `PROVENANCE.md não cita mais ${fonte}`);
  }
  for (const c of casos) {
    assert(provText.includes(c + '.svg'), `PROVENANCE.md não registra a origem de ${c}.svg`);
  }
});

test('os recursos chegam ao .app — a lacuna que nenhum teste Swift alcança', () => {
  const pkg = fs.readFileSync(path.join(repoRoot, 'app/Package.swift'), 'utf8');
  assert(/name:\s*"ForgeKit"[\s\S]{0,200}?resources:\s*\[[^\]]*Resources\/icons/.test(pkg),
    'ForgeKit não declara mais os ícones como resources — sem isso não existe bundle nenhum ' +
    'e `Bundle.module` não acha os arquivos em lugar algum');

  const build = fs.readFileSync(path.join(repoRoot, 'app/build.sh'), 'utf8');
  const iBin = build.indexOf('Contents/MacOS/Forge"');
  const iBundle = build.indexOf('*.bundle');
  const iSign = build.indexOf('codesign --force');
  assert(iBundle > 0,
    'build.sh não copia mais os *.bundle — o app montado perde os recursos e a lacuna é ' +
    'INVISÍVEL: os testes passam (swift run acha o bundle ao lado do binário) e o app abre');
  assert(/cp -R "\$\{BIN_DIR\}\/"\*\.bundle "\$\{BUNDLE\}\/Contents\/Resources\/"/.test(build),
    'o destino da cópia mudou — Contents/Resources é onde o acessor gerado pelo SwiftPM procura ' +
    '(Bundle.main.resourceURL); em Contents/MacOS ele não olha');
  assert(iBin < iBundle && iBundle < iSign,
    'a cópia dos bundles saiu da ordem: precisa vir DEPOIS do binário (o bin path só é conhecido ' +
    'ali) e ANTES do codesign (a assinatura cobre o conteúdo do bundle)');
});

test('a marca nunca é desenhada sem piso — um recurso ausente custa o ícone antigo, não um vazio', () => {
  // A degradação é a razão de `brandOrSymbol` ser uma função e não dois call
  // sites: `BrandArt.image` devolve nil exatamente na condição que nenhum teste
  // alcança (bundle fora do .app). Desenhar a marca sem `else` transformaria
  // essa condição no quadrado em branco que este trabalho inteiro remove.
  const i = code.indexOf('private func brandOrSymbol');
  assert(i >= 0, 'brandOrSymbol sumiu — a degradação para SF Symbol saiu da view');
  const body = code.slice(i, i + 700);
  assert(/if let mark,\s*let img = BrandArt\.image\(mark\)/.test(body),
    'brandOrSymbol não checa mais se a imagem carregou — um `!` ali é o quadrado em branco');
  assert(/else\s*\{[\s\S]{0,120}Image\(systemName:\s*symbol\)/.test(body),
    'brandOrSymbol perdeu o ramo de fallback — sem ele, um bundle sem recursos desenha NADA');
  assert(/renderingMode\(\.template\)/.test(body),
    'a marca deixou de ser template — para de tingir com o tom do card e ignora o modo escuro');

  // E o ícone do projeto passa pela mesma função, em vez de desenhar a marca
  // direto (que seria o mesmo furo, num segundo lugar).
  const j = code.indexOf('private var projectIcon');
  assert(j >= 0, 'projectIcon sumiu');
  const icon = code.slice(j, code.indexOf('private func brandOrSymbol', j) + 1);
  assert(/brandOrSymbol\(glyph\?\.mark,\s*symbol:/.test(icon),
    'projectIcon não usa mais brandOrSymbol — ou voltou ao SF Symbol puro, ou desenha a marca ' +
    'sem piso');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
