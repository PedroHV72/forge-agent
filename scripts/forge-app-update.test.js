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

console.log('\n=== forge app · self-update ===\n');

const updatesSource = read(updatesSwift);
const updatesCode = stripLineComments(updatesSource);
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

check('runUpdate() invoca install.sh com --update E --with-app', () => {
  const m = updatesCode.match(/func runUpdate\(\)\s*\{[\s\S]*?\n    \}/);
  assert(m, 'não encontrei o corpo de runUpdate()');
  const body = m[0];
  assert(
    body.includes('--update'),
    'runUpdate() não passa --update'
  );
  assert(
    body.includes('--with-app'),
    'runUpdate() não passa --with-app — o app atualizaria tudo menos ele mesmo ' +
      '(install.sh gateia o build do app em WITH_APP)'
  );
});

check('runUpdate() marca que a janela em execução ficou obsoleta', () => {
  const m = updatesCode.match(/func runUpdate\(\)\s*\{[\s\S]*?\n    \}/);
  assert(m, 'não encontrei o corpo de runUpdate()');
  assert(
    /needsRelaunch\s*=\s*true/.test(m[0]),
    'runUpdate() não seta needsRelaunch — o processo em execução continua no ' +
      'binário antigo e a janela pareceria atualizada'
  );
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
  const m = updatesCode.match(/func relaunch\(\)\s*\{[\s\S]*?\n    \}/);
  assert(m, 'não encontrei o corpo de relaunch()');
  assert(
    m[0].includes('"-n"'),
    'relaunch() não usa `open -n` — sem isso a nova cópia não sobe antes desta sair'
  );
  assert(
    /terminate/.test(m[0]),
    'relaunch() não encerra a instância antiga'
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

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
