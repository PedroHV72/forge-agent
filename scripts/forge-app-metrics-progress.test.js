#!/usr/bin/env node
'use strict';

// forge-app-metrics-progress.test.js — standing guard for the progress panel
// inside MetricsView (S03).
//
// Nobody on this machine sees the screen — no Xcode, no canvas. Criteria #7,
// #8, #9 and #11 of this milestone are properties of TEXT (three separate
// counts never combined into one score, a coverage label glued to the first
// count, a divergence sentence rendered only via optional binding, zero new
// sidebar sections) and the only remaining proof is this guard. If it does
// not bite, "it renders correctly" and "it silently regressed" print the same
// green.
//
// Separate suite from forge-app-progress.test.js on purpose (DS3-4): that
// suite has its own single premise (the file_audit.ignore_list drift between
// GitActivity.swift and forge-completer.md) declared in its own header, and
// folding view asserts into it would erase that premise.
//
// Criterion #11 here is COUNT ONLY. The strong rename proof (the ordered list
// of Section.rawValue) already lives in forge-app-sidebar.test.js (guard D31,
// MEM004) — a count alone cannot detect a rename, and duplicating that proof
// here would be dead weight, not a stronger guard.
//
// Pure file reading, like forge-app-progress.test.js and forge-app-sidebar.test.js:
// no swift invocation, so it NEVER skips and runs everywhere, Windows included.
//
// Zero deps, standalone runner (repo convention): exit != 0 on any failure.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const metricsViewSwift = path.join(repoRoot, 'app', 'Sources', 'Forge', 'MetricsView.swift');
const viewsSwift = path.join(repoRoot, 'app', 'Sources', 'Forge', 'Views.swift');

const REL_METRICS = path.relative(repoRoot, metricsViewSwift);
const REL_VIEWS = path.relative(repoRoot, viewsSwift);

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

/// Strip `//` line comments so a doc comment that merely DISCUSSES the
/// forbidden vocabulary (explaining what the panel does NOT do) cannot trip a
/// guard by accident, and — symmetrically — so the anti-vocabulary check (A),
/// which intentionally runs on the RAW file, is the only assert here allowed
/// to see comments at all.
function stripLineComments(source) {
  return source
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

/// Extract a block body by COUNTING BRACES, not by a non-greedy regex — the
/// same helper and the same reasoning as forge-app-sidebar.test.js: a
/// regex like `.*?}` truncates at the first nested closure, and an assertion
/// that something is ABSENT from a truncated body passes because of the
/// truncation, not because of the code.
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

console.log('\nforge-app-metrics-progress.test.js\n');

// ------------------------------------------- A: anti-índice-composto (#7)

check('nenhum vocabulário de índice composto em MetricsView.swift (#7)', () => {
  // RAW file, no comment stripping: a comment that says "índice composto" (to
  // explain what the panel refuses to do) reintroduces exactly the vocabulary
  // this milestone bans — the presence of the word anywhere in the file is
  // the thing being guarded, not just in executable code.
  const src = read(metricsViewSwift);
  const re = /\b(score|média|peso|índice|composto)\b/i;
  const m = src.match(re);
  assert(
    m === null,
    `vocabulário de índice composto encontrado em ${REL_METRICS}: "${m ? m[0] : ''}" — `
      + 'a fatia proíbe qualquer número único que combine as três fontes (D2, critério #7); '
      + 'se o termo casou dentro de um identificador legítimo, ajuste o regex com fronteira '
      + 'de palavra em vez de relaxá-lo em silêncio'
  );
});

// ------------------------------------------- B: três fontes separadas (#7)

check('as três leituras (closedItems.closed, ledger.count, gitCommits) estão presentes e nunca combinadas por aritmética (#7)', () => {
  const src = stripLineComments(read(metricsViewSwift));
  const NEEDLES = ['closedItems.closed', 'ledger.count', 'gitCommits'];
  for (const n of NEEDLES) {
    assert(
      src.includes(n),
      `\`${n}\` não aparece mais em ${REL_METRICS} — uma das três fontes separadas do painel `
        + 'de progresso sumiu (D2, critério #7)'
    );
  }
  // Line-by-line scan: no single line may cite two of the three sources
  // joined by arithmetic. This is exactly the combination the slice bans —
  // a single "score" born from mixing sources instead of naming a constant.
  const lines = src.split('\n');
  const ARITH = /[+\-*/]/;
  lines.forEach((line, idx) => {
    const hits = NEEDLES.filter((n) => line.includes(n));
    if (hits.length >= 2 && ARITH.test(line)) {
      throw new Error(
        `linha ${idx + 1} de ${REL_METRICS} combina duas fontes separadas por aritmética `
          + `(${hits.join(', ')}): "${line.trim()}" — a fatia proíbe exatamente essa combinação `
          + '(D2, critério #7)'
      );
    }
  });
});

// ------------------------------------------- C: cobertura declarada (#8)

check('coverageLabel é renderizado em MetricsView.swift (#8)', () => {
  const src = stripLineComments(read(metricsViewSwift));
  assert(
    src.includes('coverageLabel'),
    `\`coverageLabel\` não aparece mais em ${REL_METRICS} — o rótulo de cobertura colado na `
      + 'primeira contagem sumiu (critério #8)'
  );
});

// ------------------------------------------- D: divergência condicional (#9)

check('divergence é renderizado via optional binding, nunca com fallback `??` (#9)', () => {
  const src = stripLineComments(read(metricsViewSwift));
  assert(
    src.includes('divergence'),
    `\`divergence\` não aparece mais em ${REL_METRICS} — a frase de divergência sumiu (critério #9)`
  );
  const hasOptionalBinding = /if\s+let\s+\w*\s*=?\s*summary\.divergence|if\s+let\s+d\s*=\s*summary\.divergence/.test(src)
    || /if\s+let\s+divergence\s*=/.test(src);
  assert(
    hasOptionalBinding,
    `\`divergence\` não é lido via optional binding (\`if let\`) em ${REL_METRICS} — sem isso a `
      + 'frase pode acabar renderizando incondicionalmente (D3, critério #9)'
  );
  const lines = src.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('divergence') && line.includes('??')) {
      throw new Error(
        `linha ${idx + 1} de ${REL_METRICS} dá fallback (\`??\`) a \`divergence\`: "${line.trim()}" — `
          + 'a D3 proíbe fallback: a frase deve renderizar SÓ quando as fontes discordam, nunca '
          + 'sempre com um texto substituto (critério #9)'
      );
    }
  });
});

// ------------------------------------------- E: quatro casos de janela (DS3-3)

check('o mapeamento MetricsStore.Window -> ProgressWindow cobre os quatro casos, sem `default:` (DS3-3)', () => {
  const src = stripLineComments(read(metricsViewSwift));
  const body = bodyOf(src, 'var progressWindow');
  const EXPECTED = ['.day24h', '.week', '.month', '.all'];
  for (const c of EXPECTED) {
    assert(
      body.includes(c),
      `o mapeamento de janela em ${REL_METRICS} perdeu o caso \`${c}\` — os quatro casos de `
        + '`ProgressWindow` têm de estar presentes (DS3-3), o mapeamento não é testável por '
        + 'ForgeKitTests (ForgeKit não importa Forge) e este guard textual é a única prova'
    );
  }
  assert(
    !body.includes('default:'),
    `o mapeamento de janela em ${REL_METRICS} usa \`default:\` — um \`default\` transforma uma `
      + 'janela nova em janela errada silenciosamente; o switch precisa ser exaustivo (DS3-3)'
  );
});

// ------------------------------------------- F: zero seções novas (#11)

check('o enum Section em Views.swift continua com 13 casos (#11)', () => {
  // Count only. The strong proof — the ORDERED list of rawValue, which
  // detects a RENAME that a count alone would miss — already lives in
  // forge-app-sidebar.test.js (guard D31, MEM004) and is intentionally not
  // duplicated here.
  const src = stripLineComments(read(viewsSwift));
  const decl = bodyOf(src, 'enum Section: String, CaseIterable, Identifiable');
  const cases = decl.match(/^\s*case \w+ = "([^"]*)"/gm) || [];
  assert(
    cases.length === 13,
    `esperados 13 casos em Section (${REL_VIEWS}), encontrados ${cases.length} — esta fatia não `
      + 'abre nenhuma seção nova na sidebar (critério #11); o rename é coberto separadamente pelo '
      + 'guard D31 de forge-app-sidebar.test.js'
  );
});

// ------------------------------------------- G: geração nunca é matada por `guard !loading` (review R1, S03)

check('ProgressStore.load(project:window:) nunca descarta uma requisição sem avançar a geração (review R1)', () => {
  // review R1 (S03 dialectic review): `guard !loading else { return }` drops
  // a newer request WITHOUT calling `generation.start()`, so an in-flight
  // older request still passes `generation.isCurrent(gen)` and overwrites
  // `summary` with stale data while the picker already shows the new
  // project. The fix removes the loading guard entirely — every call must
  // advance the generation, including the `project.isEmpty` branch.
  const src = stripLineComments(read(metricsViewSwift));
  const body = bodyOf(src, 'func load(project: String, window: MetricsStore.Window)');
  assert(
    !/guard\s+!loading\s+else/.test(body),
    `\`ProgressStore.load\` em ${REL_METRICS} ainda tem \`guard !loading\` — isso descarta uma `
      + 'requisição mais nova sem avançar a geração, deixando uma requisição antiga em voo vencer '
      + 'a corrida e escrever \`summary\` errado (review R1, S03)'
  );
  assert(
    body.includes('generation.start()'),
    `\`ProgressStore.load\` em ${REL_METRICS} não chama \`generation.start()\` — sem isso a `
      + 'geração nunca avança e o guard \`isCurrent\` vira código morto (review R1, S03)'
  );
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
