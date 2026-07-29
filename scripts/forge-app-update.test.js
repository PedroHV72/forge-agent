#!/usr/bin/env node
'use strict';

// forge-app-update.test.js — standing regression guard for self-update.
//
// The app can detect a new release (UpdateStore.check compares git tags) and
// run the installer for you. What it could not do, until v3.1.0, was update
// ITSELF: `runUpdate()` shelled out to `install.sh --update`, and the app build
// lives behind `--with-app`. So the button refreshed every agent, skill, script
// and hook, printed success, and left the one binary the operator was looking
// at on the old version. Nothing failed — which is exactly why it survived.
//
// Two invariants, both cheap to check and both silent when they break:
//
//   1. `runUpdate()` passes `--with-app`. Without it the installer skips the
//      Swift build entirely (install.sh gates it on WITH_APP) and the update
//      appears to have worked.
//   2. Replacing the bundle does not replace the running process, so the app
//      must offer a relaunch after an update rather than letting a stale window
//      look current. `needsRelaunch` + `relaunch()` are that affordance.
//
// It also pins the gating itself: if `install.sh` ever stopped gating the app
// build on `--with-app`, invariant 1 would be vacuous and this suite would be
// guarding nothing — so the gate is asserted rather than assumed.
//
// Like forge-app-workspace.test.js and unlike forge-app.test.js, this is pure
// file reading — no swift invocation — so it NEVER skips and runs everywhere,
// including CI and Windows.
//
// Zero deps, standalone runner (repo convention): exit != 0 on any failure.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const updatesSwift = path.join(repoRoot, 'app', 'Sources', 'Forge', 'Updates.swift');
const forgeAppSwift = path.join(repoRoot, 'app', 'Sources', 'Forge', 'ForgeApp.swift');
const installSh = path.join(repoRoot, 'install.sh');

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
/// satisfy — or trip — a guard. The doc comments in Updates.swift deliberately
/// discuss `--with-app` at length; matching them would make every assertion
/// below pass on a file whose code had been gutted.
function stripLineComments(source) {
  return source
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

/// Extract a function body by COUNTING BRACES, not by regex.
///
/// The previous version matched `/func runUpdate\(\)\s*\{[\s\S]*?\n    \}/` — non
/// greedy up to the first line that is four spaces and a closing brace. Once
/// `runUpdate()` gained closures (`onLine:`/`onExit:`, whose closing lines are
/// `    }, onExit: { code in` and `    })`), that regex truncated the body at the
/// first nested closure — and a guard asserting something is ABSENT from the body
/// would then pass because of the truncation rather than the code. See the
/// bite-proof case at the bottom.
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

/// The text preceding the `{` that opens the block containing `index` — i.e. the
/// condition an assignment sits under. Used to prove WHERE `needsRelaunch = true`
/// happens, instead of hoping it is near the right line.
function enclosingBlockHeader(source, index) {
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    const c = source[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) return source.slice(source.lastIndexOf('\n', i) + 1, i);
      depth--;
    }
  }
  return null;
}

function indexesOf(source, re) {
  const out = [];
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = rx.exec(source)) !== null) out.push(m.index);
  return out;
}

console.log('\n=== forge app · self-update ===\n');

const updatesSource = read(updatesSwift);
const updatesCode = stripLineComments(updatesSource);
const appCode = stripLineComments(read(forgeAppSwift));
const installSource = read(installSh);

check('install.sh ainda gateia o build do app atrás de --with-app', () => {
  // If this stops being true the flag is no longer load-bearing and invariant 1
  // below is guarding nothing. Assert the gate rather than assuming it.
  assert(
    /--with-app\)\s*WITH_APP=true/.test(installSource),
    'install.sh não mapeia mais --with-app para WITH_APP=true'
  );
  assert(
    /^if \$WITH_APP; then/m.test(installSource),
    'o build do app não está mais gated em `if $WITH_APP`'
  );
});

const runUpdateBody = bodyOf(updatesCode, 'func runUpdate()');

check('runUpdate() invoca install.sh com --update E --with-app', () => {
  assert(
    runUpdateBody.includes('--update'),
    'runUpdate() não passa --update'
  );
  assert(
    runUpdateBody.includes('--with-app'),
    'runUpdate() não passa --with-app — o app atualizaria tudo menos ele mesmo ' +
      '(install.sh gateia o build do app em WITH_APP)'
  );
});

check('runUpdate() roda o instalador headless, não num Terminal', () => {
  assert(
    !/openTerminal/.test(runUpdateBody),
    'runUpdate() ainda abre um Terminal — o progresso tem que ser exibido pelo app'
  );
  // A ausência sozinha passaria num corpo vazio: exigir a prova positiva.
  assert(
    /ForgeCore\.stream\(/.test(runUpdateBody),
    'runUpdate() não chama ForgeCore.stream — sem streaming a barra fica parada ' +
      'durante os minutos de swift build'
  );
});

check('needsRelaunch só é setado depois do exit 0 do instalador', () => {
  // Invertido de propósito: até a v3.1.4 este guard exigia a atribuição DENTRO
  // de runUpdate(), que é justamente o bug — o botão aparecia enquanto o
  // instalador ainda compilava, e clicar nele matava o build.
  assert(
    !/needsRelaunch\s*=\s*true/.test(runUpdateBody),
    'runUpdate() seta needsRelaunch — o botão apareceria com o instalador ainda ' +
      'rodando, e clicar nele mata o build'
  );
  const sites = indexesOf(updatesCode, /needsRelaunch\s*=\s*true/);
  assert(
    sites.length > 0,
    'ninguém seta needsRelaunch — a janela ficaria no binário antigo sem afordance'
  );
  for (const at of sites) {
    const header = enclosingBlockHeader(updatesCode, at);
    assert(header !== null, 'atribuição fora de qualquer bloco');
    assert(
      /canRelaunch|==\s*0/.test(header),
      'needsRelaunch = true não está sob uma condição de exit code zero: ' +
        `\`${header.trim()}\``
    );
  }
});

check('existe o afordance de reabrir (needsRelaunch + relaunch())', () => {
  assert(
    /@Published\s+var\s+needsRelaunch/.test(updatesCode),
    'needsRelaunch não é @Published — a view não reagiria a ele'
  );
  assert(
    /func relaunch\(\)/.test(updatesCode),
    'relaunch() não existe'
  );
  const relaunchBody = bodyOf(updatesCode, 'func relaunch()');
  assert(
    /terminate/.test(relaunchBody),
    'relaunch() não encerra a instância antiga'
  );
  // `open -n` mudou de lugar: dispará-lo antes da confirmação de término deixava
  // duas instâncias quando o alerta de sessões vivas era cancelado.
  assert(
    !relaunchBody.includes('"-n"'),
    'relaunch() ainda sobe a nova cópia antes da confirmação de término'
  );
  const launchBody = bodyOf(updatesCode, 'func launchNewInstance()');
  assert(
    launchBody.includes('"-n"'),
    'launchNewInstance() não usa `open -n` — sem isso a nova cópia não sobe antes desta sair'
  );
});

check('a nova instância só sobe depois de o término ser confirmado', () => {
  const body = bodyOf(appCode, 'func applicationShouldTerminate(');
  assert(
    /relaunchPending/.test(appCode),
    'ForgeApp não consulta relaunchPending'
  );
  assert(
    /launchNewInstance\(\)/.test(body) ||
      /launchNewInstance\(\)/.test(bodyOf(appCode, 'func terminateNow()')),
    'applicationShouldTerminate não dispara launchNewInstance() — a ordenação ' +
      'corrigida (terminar → relançar) não está garantida'
  );
});

check('a UI expõe o botão de reabrir quando needsRelaunch', () => {
  assert(
    /store\.needsRelaunch/.test(updatesCode),
    'nenhuma view lê store.needsRelaunch — o estado existiria sem afordance'
  );
  assert(
    /store\.relaunch\(\)/.test(updatesCode),
    'nenhuma view chama store.relaunch()'
  );
});

// Bite-proof: the comment-stripping must not be the reason a guard passes.
check('o matcher ignora menções em comentário (bite-proof)', () => {
  const onlyComment = '// runUpdate() should pass --with-app and set needsRelaunch = true\nfunc x() {}';
  const stripped = stripLineComments(onlyComment);
  assert(
    !stripped.includes('--with-app'),
    'stripLineComments deixou passar uma menção em comentário'
  );
  assert(
    !/needsRelaunch\s*=\s*true/.test(stripped),
    'stripLineComments deixou passar uma atribuição comentada'
  );
});

// Bite-proof II: a mention in a comment must not SATISFY the "someone sets it
// under exit 0" half of the guard either. Absence proofs and presence proofs
// need the same matcher.
check('atribuição só em comentário não satisfaz a prova positiva (bite-proof)', () => {
  const fake = [
    'func finishUpdate(exitCode: Int32) {',
    '    if UpdateOutcome.canRelaunch(exitCode: exitCode) {',
    '        // needsRelaunch = true',
    '    }',
    '}',
  ].join('\n');
  assert(
    indexesOf(stripLineComments(fake), /needsRelaunch\s*=\s*true/).length === 0,
    'um fonte que só menciona a atribuição em comentário contaria como prova'
  );
});

// Bite-proof III: the reason the regex had to go. This is the shape runUpdate()
// actually has now — closures whose closing lines start with four spaces.
check('bodyOf não trunca em closure aninhada (bite-proof)', () => {
  const fake = [
    'func runUpdate() {',
    '    ForgeCore.stream(cwd: r, command: c, onLine: { line in',
    '        keep(line)',
    '    }, onExit: { code in',
    '        needsRelaunch = true',
    '    })',
    '}',
  ].join('\n');

  const body = bodyOf(fake, 'func runUpdate()');
  assert(
    /needsRelaunch\s*=\s*true/.test(body),
    'bodyOf perdeu a atribuição dentro da closure — o guard de ausência passaria ' +
      'por truncamento, não por mérito'
  );

  // And the matcher that used to be here would have missed it, silently.
  const old = fake.match(/func runUpdate\(\)\s*\{[\s\S]*?\n    \}/);
  assert(
    old && !/needsRelaunch\s*=\s*true/.test(old[0]),
    'o regex antigo deveria truncar aqui — se não trunca, este caso não prova nada'
  );

  // The header walk must find the closure's condition, not the function's.
  const at = indexesOf(fake, /needsRelaunch\s*=\s*true/)[0];
  assert(
    /onExit/.test(enclosingBlockHeader(fake, at) || ''),
    'enclosingBlockHeader não achou o bloco imediato da atribuição'
  );
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
