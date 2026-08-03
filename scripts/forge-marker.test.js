#!/usr/bin/env node
'use strict';

// forge-marker.test.js — the codec, the walk-up, and the one property that
// D3 actually cares about: precedence.
//
// The precedence tests (R5) are the load-bearing ones. Everything else here
// (JSONC parsing, walk-up, malformed refusal, write idempotency) is table
// stakes for a fallback source to exist at all; the precedence tests are what
// prove the fallback stays a fallback — that a present-but-disagreeing
// registry always wins, and that a present-but-EMPTY registry is a miss, not
// a door to the marker. Get that second distinction wrong and I-20260803025613
// reopens on the JS side even though the marker "works".
//
// Every fixture lives in a tmpdir with a SYNTHETIC $HOME. Nothing here reads
// or writes the operator's real `~/.claude/forge-gate-workspaces.json`, and
// no marker fixture is ever written into a real working tree — `mktmp`.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MARKER_FILENAMES,
  parseJsonc,
  findMarker,
  readMarker,
  writeMarker,
} = require('./forge-marker.js');

const { resolveRepoName } = require('./forge-repo-index.js');

// ── Runner ──────────────────────────────────────────────────────────────────

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

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn, msg) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  assert(threw, msg || 'esperava lançar, não lançou');
  return threw;
}

const tmps = [];

function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-marker-'));
  tmps.push(d);
  return fs.realpathSync(d);
}

function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function mkdirs(...dirs) {
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

function writeRegistry(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    roots: [],
    entries,
    quarantine: [],
  }, null, 2));
}

// ── R1: JSONC codec ─────────────────────────────────────────────────────────

console.log('R1 — parseJsonc');

test('comentário de linha é removido', () => {
  const out = parseJsonc('{\n  "a": 1, // trailing note\n  "b": 2\n}');
  assertEqual(out.a, 1, 'a');
  assertEqual(out.b, 2, 'b');
});

test('comentário de bloco é removido', () => {
  const out = parseJsonc('{ /* header\n   spanning lines */ "a": 1 }');
  assertEqual(out.a, 1, 'a');
});

test('vírgula final antes de } e ] é aceita', () => {
  const out = parseJsonc('{\n  "list": [1, 2, 3,],\n  "a": 1,\n}');
  assertEqual(out.a, 1, 'a');
  assertEqual(out.list.length, 3, 'list.length');
});

test('comentário dentro de uma string NÃO é removido — "https://x" sobrevive intacto', () => {
  const out = parseJsonc('{ "url": "https://x", "a": 1 } // trailing');
  assertEqual(out.url, 'https://x', 'url');
  assertEqual(out.a, 1, 'a');
});

test('JSON puro sem comentários continua parseando normalmente', () => {
  const out = parseJsonc('{"a":1,"b":[1,2]}');
  assertEqual(out.a, 1, 'a');
  assertEqual(out.b.length, 2, 'b.length');
});

test('JSONC malformado lança um erro legível', () => {
  assertThrows(() => parseJsonc('{ "a": , }'), 'JSON inválido deveria lançar');
});

// ── R2: findMarker (walk-up) ─────────────────────────────────────────────────

console.log('\nR2 — findMarker');

test('sobe a árvore e encontra o marcador 3 níveis acima', () => {
  const root = mktmp('forge-marker-walkup-');
  const top = path.join(root, 'ws');
  const deep = path.join(top, 'a', 'b', 'c');
  mkdirs(deep);
  fs.writeFileSync(path.join(top, 'forge-workspace.jsonc'), '{ "kind": "workspace", "name": "ws", "repos": [] }\n');
  const found = findMarker(deep);
  assert(found, 'deveria encontrar');
  assertEqual(found.dir, top, 'dir');
  assertEqual(found.name, 'forge-workspace.jsonc', 'name');
});

test('sem marcador algum devolve null sem lançar', () => {
  const root = mktmp('forge-marker-none-');
  const deep = path.join(root, 'a', 'b');
  mkdirs(deep);
  const found = findMarker(deep, { stopAt: root });
  assertEqual(found, null, 'found');
});

test('stopAt é respeitado — não sobe além dele', () => {
  const root = mktmp('forge-marker-stopat-');
  const outer = root; // marker sits ABOVE stopAt
  const boundary = path.join(root, 'boundary');
  const deep = path.join(boundary, 'x', 'y');
  mkdirs(deep);
  fs.writeFileSync(path.join(outer, 'forge-workspace.jsonc'), '{ "kind": "workspace", "name": "outer", "repos": [] }\n');
  const found = findMarker(deep, { stopAt: boundary });
  assertEqual(found, null, 'não deveria enxergar o marcador acima de stopAt');
});

test('forge-workspace.jsonc precede forge-root.jsonc no mesmo diretório', () => {
  const dir = mktmp('forge-marker-precedence-');
  fs.writeFileSync(path.join(dir, 'forge-root.jsonc'), '{ "kind": "root", "name": "r", "repos": [] }\n');
  fs.writeFileSync(path.join(dir, 'forge-workspace.jsonc'), '{ "kind": "workspace", "name": "w", "repos": [] }\n');
  const found = findMarker(dir);
  assertEqual(found.name, 'forge-workspace.jsonc', 'name');
});

// ── R3: readMarker ────────────────────────────────────────────────────────

console.log('\nR3 — readMarker');

test('lê um marcador válido e resolve repos[].path para absoluto', () => {
  const dir = mktmp('forge-marker-read-');
  fs.writeFileSync(path.join(dir, 'forge-workspace.jsonc'), JSON.stringify({
    kind: 'workspace',
    name: 'lookchina',
    repos: [
      { name: 'freyr', path: 'services/freyr' },
      { name: 'lookchina', path: '.' },
    ],
  }, null, 2));
  const data = readMarker(path.join(dir, 'forge-workspace.jsonc'));
  assertEqual(data.kind, 'workspace', 'kind');
  assertEqual(data.name, 'lookchina', 'name');
  assertEqual(data.repos.length, 2, 'repos.length');
  assertEqual(data.repos[0].path, path.join(dir, 'services', 'freyr'), 'freyr abs path');
  assertEqual(data.repos[1].path, dir, 'self abs path');
});

test('marcador malformado (JSON inválido) lança com o nome do arquivo na mensagem', () => {
  const dir = mktmp('forge-marker-bad-json-');
  const file = path.join(dir, 'forge-workspace.jsonc');
  fs.writeFileSync(file, '{ this is not json');
  const err = assertThrows(() => readMarker(file));
  assert(err.message.includes('forge-workspace.jsonc'), `mensagem deveria citar o arquivo: ${err.message}`);
});

test('marcador com kind inválido lança com o nome do arquivo na mensagem', () => {
  const dir = mktmp('forge-marker-bad-kind-');
  const file = path.join(dir, 'forge-workspace.jsonc');
  fs.writeFileSync(file, JSON.stringify({ kind: 'nonsense', name: 'x', repos: [] }));
  const err = assertThrows(() => readMarker(file));
  assert(err.message.includes('forge-workspace.jsonc'), `mensagem deveria citar o arquivo: ${err.message}`);
});

test('repos[] com elemento sem "path" lança', () => {
  const dir = mktmp('forge-marker-bad-repo-');
  const file = path.join(dir, 'forge-workspace.jsonc');
  fs.writeFileSync(file, JSON.stringify({ kind: 'workspace', name: 'x', repos: [{ name: 'a' }] }));
  assertThrows(() => readMarker(file));
});

test('repos[].path com ".." que escapa o diretório do marcador lança (containment guard)', () => {
  const root = mktmp('forge-marker-escape-');
  const dir = path.join(root, 'ws');
  mkdirs(dir);
  const file = path.join(dir, 'forge-workspace.jsonc');
  fs.writeFileSync(file, JSON.stringify({
    kind: 'workspace',
    name: 'ws',
    repos: [{ name: 'outside', path: '../../etc' }],
  }));
  const err = assertThrows(() => readMarker(file), 'path fora do diretório do marcador deveria lançar');
  assert(err.message.includes('escapes'), `mensagem deveria descrever o escape: ${err.message}`);
});

test('repos[].path absoluto que aponta fora do diretório do marcador lança (containment guard)', () => {
  const root = mktmp('forge-marker-escape-abs-');
  const dir = path.join(root, 'ws');
  const outside = path.join(root, 'elsewhere');
  mkdirs(dir, outside);
  const file = path.join(dir, 'forge-workspace.jsonc');
  fs.writeFileSync(file, JSON.stringify({
    kind: 'workspace',
    name: 'ws',
    repos: [{ name: 'outside', path: outside }],
  }));
  assertThrows(() => readMarker(file), 'path absoluto fora do diretório do marcador deveria lançar');
});

test('repos[].path que usa ".." mas permanece contido no diretório do marcador continua funcionando', () => {
  const root = mktmp('forge-marker-contained-');
  const dir = path.join(root, 'ws');
  mkdirs(path.join(dir, 'services', 'freyr'), path.join(dir, 'services', 'other'));
  const file = path.join(dir, 'forge-workspace.jsonc');
  fs.writeFileSync(file, JSON.stringify({
    kind: 'workspace',
    name: 'ws',
    // "services/other/../freyr" round-trips through ".." without ever
    // leaving `dir` — the guard must not reject relative navigation that
    // stays contained, only navigation that actually escapes.
    repos: [{ name: 'freyr', path: 'services/other/../freyr' }],
  }));
  const data = readMarker(file);
  assertEqual(data.repos[0].path, path.join(dir, 'services', 'freyr'), 'caminho contido deveria resolver normalmente');
});

// ── R4: writeMarker idempotency ──────────────────────────────────────────────

console.log('\nR4 — writeMarker');

test('escrever duas vezes com os mesmos dados produz bytes idênticos', () => {
  const dir = mktmp('forge-marker-write-');
  const data = { kind: 'workspace', name: 'lookchina', repos: [{ name: 'freyr', path: 'services/freyr' }] };
  const r1 = writeMarker(dir, data);
  const bytes1 = fs.readFileSync(r1.file);
  const r2 = writeMarker(dir, data);
  const bytes2 = fs.readFileSync(r2.file);
  assertEqual(r1.file, r2.file, 'file');
  assert(bytes1.equals(bytes2), 'os bytes deveriam ser idênticos entre as duas escritas');
});

test('writeMarker seguido de readMarker faz round-trip do repos[]', () => {
  const dir = mktmp('forge-marker-roundtrip-');
  const data = { kind: 'workspace', name: 'lookchina', repos: [{ name: 'freyr', path: 'services/freyr' }] };
  const w = writeMarker(dir, data);
  const back = readMarker(w.file);
  assertEqual(back.name, 'lookchina', 'name');
  assertEqual(back.repos[0].name, 'freyr', 'repos[0].name');
  assertEqual(back.repos[0].path, path.join(dir, 'services', 'freyr'), 'repos[0].path');
});

test('MARKER_FILENAMES lista workspace antes de root', () => {
  assertEqual(MARKER_FILENAMES[0], 'forge-workspace.jsonc', 'first');
  assertEqual(MARKER_FILENAMES[1], 'forge-root.jsonc', 'second');
});

// ── R5: precedência via resolveRepoName (o que D3 realmente exige) ──────────

console.log('\nR5 — precedência registry > marcador');

/**
 * A workspace with BOTH a registry (naming `freyr` under `services/freyr`)
 * and a marker sitting right at the workspace root (naming `freyr` under a
 * DIFFERENT, disagreeing path: `other/freyr`). The registry's `freyr` dir
 * exists on disk; the marker's disagreeing path does not need to — the point
 * is which ANSWER wins, not whether both are independently resolvable.
 */
function makePrecedenceFixture() {
  const root = mktmp('forge-marker-precedence-fixture-');
  const home = path.join(root, 'home');
  const ws = path.join(root, 'lookchina');
  const freyrReal = path.join(ws, 'services', 'freyr');
  mkdirs(home, freyrReal);

  const registryFile = path.join(home, '.claude', 'forge-gate-workspaces.json');
  writeRegistry(registryFile, [
    { path: ws, root: null, kind: 'workspace', repos: ['services/freyr'] },
  ]);

  writeMarker(ws, {
    kind: 'workspace',
    name: 'lookchina',
    repos: [{ name: 'freyr', path: 'other/freyr' }],
  });

  return { root, home, registryFile, ws, freyrReal };
}

test('registry presente e discordante do marcador → o registry vence, source: registry', () => {
  const f = makePrecedenceFixture();
  const r = resolveRepoName('freyr', { home: f.home, registryFile: f.registryFile, cwd: f.ws });
  assertEqual(r.status, 'ok', 'status');
  assertEqual(r.source, 'registry', 'source');
  assertEqual(r.path, f.freyrReal, 'path deveria vir do registry, não do marcador');
});

test('registry removido → cai para o marcador, source: marker', () => {
  const f = makePrecedenceFixture();
  fs.rmSync(f.registryFile);
  const r = resolveRepoName('freyr', { home: f.home, registryFile: f.registryFile, cwd: f.ws });
  assertEqual(r.status, 'ok', 'status');
  assertEqual(r.source, 'marker', 'source');
  assertEqual(r.path, path.join(f.ws, 'other', 'freyr'), 'path deveria vir do marcador');
});

test('registry presente com entries: [] → unknown, NUNCA o marcador (ausente ≠ vazio)', () => {
  const f = makePrecedenceFixture();
  writeRegistry(f.registryFile, []); // present, but empty
  const r = resolveRepoName('freyr', { home: f.home, registryFile: f.registryFile, cwd: f.ws });
  assertEqual(r.status, 'unknown', 'status');
  assert(r.source !== 'marker', `source não deveria ser marker num miss de registry vazio, veio ${r.source}`);
  assertEqual(r.source, 'registry', 'source deveria continuar registry — presente, mesmo vazio');
});

test('registry ausente e marcador ausente → unknown, source: none', () => {
  const root = mktmp('forge-marker-neither-');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'nowhere');
  mkdirs(home, cwd);
  const registryFile = path.join(home, '.claude', 'forge-gate-workspaces.json');
  const r = resolveRepoName('freyr', { home, registryFile, cwd });
  assertEqual(r.status, 'unknown', 'status');
  assertEqual(r.source, 'none', 'source');
});

// ── Cleanup + report ──────────────────────────────────────────────────────

cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
