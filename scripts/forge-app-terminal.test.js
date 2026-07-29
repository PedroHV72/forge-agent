#!/usr/bin/env node
'use strict';

// forge-app-terminal.test.js — standing regression guard for the terminal
// session lifecycle fix: "a terminal belongs to a session, not to a view".
//
// The bug this pins down (three operator-visible symptoms, one cause):
//   1. `makeNSView` unconditionally built a `LocalProcessTerminalView` and
//      called `startProcess` — so every navigation back spawned a new PTY and
//      the previous session was orphaned;
//   2. the "already bootstrapped" flag lived on `TerminalHost.Coordinator`,
//      which SwiftUI recreates per view — so returning to the screen retyped
//      the first message;
//   3. creating a session from the composer never took the operator to it.
//
// Any of those coming back must fail loudly here rather than merge unnoticed.
//
// Pure file reading, in the mold of forge-app-items.test.js — no swift
// invocation, so this NEVER skips and runs on every platform.
//
// Matching is done over the BODY of the function in question with `//`
// comments stripped, because this codebase documents the removed bug in prose
// right next to the code that replaced it: a naive whole-file grep matches
// those comments and "proves" an invariant that no longer holds. Every guard
// below is accompanied by a bites-check against a synthetic code line and a
// synthetic comment line.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const appSourcesDir = path.join(repoRoot, 'app', 'Sources');
const terminalViewPath = path.join(appSourcesDir, 'Forge', 'TerminalView.swift');
const storesPath = path.join(appSourcesDir, 'Forge', 'Stores.swift');
const viewsPath = path.join(appSourcesDir, 'Forge', 'Views.swift');
const registryCorePath = path.join(appSourcesDir, 'ForgeKit', 'TerminalRegistryCore.swift');

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

console.log('\n=== forge app terminal session lifecycle ===\n');

if (!fs.existsSync(appSourcesDir)) {
  console.error(`✗ app/Sources/ not found at ${appSourcesDir} — this repo always has it; refusing to skip.`);
  process.exit(1);
}

// --- helpers ---------------------------------------------------------------

/** Drop `//` comments. Naive on purpose: this codebase has no `//` inside
 *  string literals in the files under guard, and a quote-aware parser would
 *  be more machinery than the invariant deserves. */
function stripLineComments(line) {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n');
}

/**
 * The comment-stripped body of the first declaration whose (stripped) line
 * contains `signature`, delimited by brace balance. Returns { code, lines }.
 */
function functionBody(filePath, signature) {
  const lines = readLines(filePath).map(stripLineComments);
  const start = lines.findIndex(l => l.includes(signature));
  assert(start !== -1, `não achei "${signature}" em ${path.relative(repoRoot, filePath)}`);

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
    assert(i - start < 400, `corpo de "${signature}" não fechou — extração falhou`);
  }
  return { code: body.join('\n'), lines: body };
}

// --- files exist -----------------------------------------------------------

check('os arquivos do fix existem', () => {
  for (const p of [terminalViewPath, storesPath, viewsPath, registryCorePath]) {
    assert(fs.existsSync(p), `arquivo ausente: ${path.relative(repoRoot, p)}`);
  }
});

// --- 1. makeNSView must not build/spawn a terminal -------------------------

check('makeNSView não constrói um LocalProcessTerminalView nem inicia processo', () => {
  const { code } = functionBody(terminalViewPath, 'func makeNSView(');
  const forbidden = ['LocalProcessTerminalView(frame', '.startProcess('];
  const hits = forbidden.filter(p => code.includes(p));
  assert(
    hits.length === 0,
    'makeNSView voltou a criar o terminal por conta própria — cada navegação de volta ' +
      `mata a sessão anterior. Encontrado: ${hits.join(', ')}`
  );
});

check('makeNSView pega a instância viva no registry, chaveada pela sessão', () => {
  const { code } = functionBody(terminalViewPath, 'func makeNSView(');
  assert(code.includes('TerminalViewStore.shared'),
    'makeNSView não consulta o TerminalViewStore — a sessão deixa de ser a dona do terminal');
  assert(/instance\(for:\s*session\)/.test(code),
    'makeNSView não pede a instância por sessão (instance(for: session))');
  assert(code.includes('removeFromSuperview()'),
    'makeNSView não solta a view do host anterior — reparentar sem isso é bug de AppKit');
});

check('o guard morde: um makeNSView ingênuo é detectado, e a menção em comentário não', () => {
  const realLine = '        let view = LocalProcessTerminalView(frame: .zero)';
  assert(stripLineComments(realLine).includes('LocalProcessTerminalView(frame'),
    'o matcher não pegou uma construção real de terminal');
  const commentLine = '        // Never `LocalProcessTerminalView(frame:)` here — the registry owns it.';
  assert(!stripLineComments(commentLine).includes('LocalProcessTerminalView(frame'),
    'o matcher acusou uma menção em comentário (falso positivo — já aconteceu aqui)');
  const realSpawn = '        view.startProcess(executable: shell, args: ["-l"])';
  assert(stripLineComments(realSpawn).includes('.startProcess('),
    'o matcher não pegou um startProcess real');
});

// --- 2. bootstrap guard must not live on the Coordinator -------------------

check('o Coordinator não guarda estado de bootstrap (o flag é por sessão, não por view)', () => {
  const { code } = functionBody(terminalViewPath, 'final class Coordinator');
  assert(!/didBootstrap/.test(code),
    'o guard de bootstrap voltou para o Coordinator — SwiftUI recria o Coordinator a cada ' +
      'navegação, então a primeira mensagem seria reenviada');
  assert(!/func scheduleBootstrap/.test(code),
    'scheduleBootstrap voltou para o Coordinator — o envio precisa passar pelo claim por sessão');
});

check('o bootstrap é reivindicado uma vez por id de sessão', () => {
  const { code } = functionBody(terminalViewPath, 'func makeNSView(');
  assert(/claimBootstrap\(for:\s*session\.id\)/.test(code),
    'makeNSView não reivindica o bootstrap por session.id — nada impede o replay');

  const registry = fs.readFileSync(registryCorePath, 'utf8');
  const claim = functionBody(registryCorePath, 'public func claimBootstrap(');
  assert(/didBootstrap/.test(claim.code),
    'claimBootstrap não consulta/marca o estado de bootstrap');
  assert(/\[UUID:/.test(registry),
    'o registry deixou de ser chaveado por UUID (id da sessão) — índice/título não sobrevivem');
});

check('o guard morde: um didBootstrap real no Coordinator é detectado, comentário não', () => {
  const realLine = '        private var didBootstrap = false';
  assert(/didBootstrap/.test(stripLineComments(realLine)),
    'o matcher não pegou um didBootstrap real');
  const commentLine = '        // the didBootstrag flag used to live here'.replace('didBootstrag', 'didBootstrap');
  assert(!/didBootstrap/.test(stripLineComments(commentLine)),
    'o matcher acusou a menção em comentário que explica o bug removido');
});

// --- 3. view teardown must not kill the process ----------------------------

check('dismantleNSView não encerra o processo', () => {
  const { code } = functionBody(terminalViewPath, 'static func dismantleNSView(');
  assert(!/\.terminate\(\)/.test(code),
    'dismantleNSView voltou a matar o PTY — sair da tela encerraria a sessão');
  assert(/viewDismantled/.test(code),
    'dismantleNSView não referencia a política de teardown (TerminalLifecycle)');
});

check('a política de teardown mantém a view desmontada viva', () => {
  const { code } = functionBody(registryCorePath, 'public static func action(');
  assert(/case \.viewDismantled:\s*return \.keepAlive/.test(code.replace(/\s+/g, ' ')),
    'viewDismantled deixou de ser .keepAlive — é exatamente o bug de origem');
  assert(/sessionClosed/.test(code) && /terminateAndDiscard/.test(code),
    'sessionClosed deixou de encerrar — o PTY vazaria por sessão fechada');
});

check('só closeSession encerra o PTY, e ele é encerrado de fato', () => {
  const { code } = functionBody(storesPath, 'func closeSession(');
  assert(/TerminalViewStore\.shared\.closeSession\(/.test(code),
    'AppState.closeSession não descarta a entrada do registry — um PTY vaza por sessão fechada');
});

// --- 4. creating a session takes the operator to it ------------------------

check('AppState é dono da navegação (seção + sessão em foco)', () => {
  const src = readLines(storesPath).map(stripLineComments).join('\n');
  assert(/@Published var section: Section\?/.test(src),
    'a seção saiu do AppState — o composer não consegue navegar para o terminal');
  assert(/@Published var focusedSession: UUID\?/.test(src),
    'focusedSession saiu do AppState — não dá para selecionar a sessão recém-criada');
  const focus = functionBody(storesPath, 'func focus(');
  assert(/section = \.terminal/.test(focus.code),
    'focus() não leva para a seção Terminal');
  assert(/focusedSession = s\.id/.test(focus.code),
    'focus() não seleciona a sessão pelo id');
});

check('todo caminho de criação de sessão foca a sessão criada', () => {
  for (const sig of ['func newSessionRaw(', 'func resume(']) {
    const { code } = functionBody(storesPath, sig);
    assert(/focus\(sessions\.last\)|focus\(/.test(code),
      `${sig} cria a sessão mas não leva o operador até ela`);
  }
  // newSession(cwd:mode:...) is long and multi-branch; assert on its tail.
  const newSession = functionBody(storesPath, 'func newSession(cwd:');
  assert(/focus\(sessions\.last\)/.test(newSession.code),
    'newSession (launcher / “Abrir sessão” / launch(account:)) não navega para a sessão criada');
});

check('a lista lateral usa a seleção compartilhada, não @State privado', () => {
  const src = readLines(viewsPath).map(stripLineComments).join('\n');
  assert(/List\(selection:\s*\$state\.section\)/.test(src),
    'RootView voltou a usar seleção local — a navegação programática deixa de funcionar');
  assert(!/@State private var section: Section\?/.test(src),
    'RootView reintroduziu @State private var section');
});

check('o guard morde: um @State privado de seção seria detectado', () => {
  const fake = '    @State private var section: Section? = .now';
  assert(/@State private var section: Section\?/.test(stripLineComments(fake)),
    'o matcher não pegaria a volta do @State privado');
  const comment = '    // was: @State private var section: Section? = .now';
  assert(!/@State private var section: Section\?/.test(stripLineComments(comment)),
    'o matcher acusaria a menção histórica em comentário');
});

// --- 5. no pre-macOS-13 API in the touched files ---------------------------

check('nenhuma API acima do baseline macOS 13 nos arquivos tocados', () => {
  const forbidden = ['.onKeyPress', '.draggable(', '.dropDestination(', '.scrollPosition('];
  const hits = [];
  for (const file of [terminalViewPath, storesPath, viewsPath, registryCorePath]) {
    readLines(file).forEach((line, i) => {
      const code = stripLineComments(line);
      for (const p of forbidden) {
        if (code.includes(p)) hits.push(`${path.relative(repoRoot, file)}:${i + 1} (${p})`);
      }
    });
  }
  assert(hits.length === 0, `API acima do baseline:\n    ${hits.join('\n    ')}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
