#!/usr/bin/env node
'use strict';

// forge-workspace-registry.test.js — the versioned registry: codec, kind
// derivation, and the loader that reads both shapes.
//
// Two defects give this suite its shape, and both are on disk right now.
//
// The first is portability. The live registry is nineteen absolute strings
// beginning `/Users/matheustelles/…`, which means it is not a registry of
// projects, it is a registry of projects *on one machine*. So the load-bearing
// test here is not a round-trip against the real home — that would pass even if
// every function closed over `os.homedir()` — but a write under one synthetic
// `$HOME` resolved under another. Nothing in this file may consult the ambient
// home; `home` is always passed.
//
// The second is silence. `Stores.swift:24` decodes `[String]` and returns `[]`
// on any other shape, so a registry the reader cannot parse and a machine with
// no projects look identical. Several tests below assert a *throw*, and they
// are the ones that matter most: they fail if anyone ever "fixes" a parse error
// by falling back to empty.
//
// Fixtures live in mkdtemp. The real `~/.claude/` is never read or written.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  REGISTRY_VERSION,
  REGISTRY_FILENAME,
  registryPath,
  encodeEntryPath,
  resolveEntryPath,
  deriveEntryKind,
  normalizeRegistry,
  loadRegistry,
} = require('./forge-workspace.js');

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

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn, re, msg) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  assert(threw, `${msg || 'esperado throw'} — nada foi lançado`);
  if (re) {
    assert(re.test(threw.message),
      `${msg || 'mensagem'} não casa ${re}: ${threw.message}`);
  }
}

const tmpRoots = [];
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `forge-registry-${prefix}-`));
  tmpRoots.push(d);
  return d;
}
function cleanup() {
  for (const d of tmpRoots) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Make `dir` classify as `project` (a work artifact, not runtime scratch). */
function mkProject(dir) {
  fs.mkdirSync(path.join(dir, '.gsd', 'milestones'), { recursive: true });
  return dir;
}

// Synthetic homes. Neither is the real one — that is the whole point.
const HOME_A = '/synthetic/homeA';
const HOME_B = '/synthetic/homeB';
const ROOTS = [{ path: '~/Development', primary: true }];

// The pathological live entry: spaces, and under no root — one fixture that
// exercises both the quoting path and the `root: null` branch (RISK blocker 3).
const SANDBOX_REL = '~/Library/Application Support/Forge/Sandbox';

// ── Constants ───────────────────────────────────────────────────────────────

console.log('\nregistry constants');

test('REGISTRY_VERSION/FILENAME/registryPath are the single holders', () => {
  assertEq(REGISTRY_VERSION, 1, 'versão do schema');
  assertEq(REGISTRY_FILENAME, 'forge-gate-workspaces.json', 'nome do arquivo');
  assertEq(registryPath(HOME_A), path.join(HOME_A, '.claude', REGISTRY_FILENAME), 'registryPath');
});

test('registryPath exige home explícito — nunca cai em os.homedir()', () => {
  assertThrows(() => registryPath(), /home must be a non-empty string/, 'home ausente');
});

// ── Codec round-trips: the three path classes ───────────────────────────────

console.log('\ncodec round-trip');

function roundTrip(abs, home, roots) {
  const enc = encodeEntryPath(abs, roots, home);
  return { enc, back: resolveEntryPath(enc, home) };
}

test('under a root → root-relative, and resolves back', () => {
  const abs = path.join(HOME_A, 'Development', 'lookchina', 'services', 'freyr');
  const { enc, back } = roundTrip(abs, HOME_A, ROOTS);
  assertEq(enc.root, '~/Development', 'root escolhido');
  assertEq(enc.path, 'lookchina/services/freyr', 'caminho root-relativo');
  assertEq(back, abs, 'round-trip');
});

test('under $HOME but outside every root → ~-relative, root null', () => {
  const abs = path.join(HOME_A, 'Documents', 'notes');
  const { enc, back } = roundTrip(abs, HOME_A, ROOTS);
  assertEq(enc.root, null, 'sem root inventado');
  assertEq(enc.path, '~/Documents/notes', 'forma ~-relativa');
  assertEq(back, abs, 'round-trip');
});

test('outside $HOME entirely → absolute verbatim, root null', () => {
  const abs = '/opt/work/thing';
  const { enc, back } = roundTrip(abs, HOME_A, ROOTS);
  assertEq(enc.root, null, 'sem root');
  assertEq(enc.path, '/opt/work/thing', 'absoluto preservado');
  assertEq(back, abs, 'round-trip');
});

test('the real spaces path round-trips (Application Support/Forge/Sandbox)', () => {
  const abs = path.join(HOME_A, 'Library', 'Application Support', 'Forge', 'Sandbox');
  const { enc, back } = roundTrip(abs, HOME_A, ROOTS);
  assertEq(enc.root, null, 'Sandbox não está sob root algum');
  assertEq(enc.path, SANDBOX_REL, 'espaços preservados sem escaping');
  assertEq(back, abs, 'round-trip com espaços');
});

test('deepest root wins when roots nest', () => {
  const roots = [{ path: '~/Development', primary: true }, { path: '~/Development/lookchina' }];
  const abs = path.join(HOME_A, 'Development', 'lookchina', 'apps', 'odin');
  const enc = encodeEntryPath(abs, roots, HOME_A);
  assertEq(enc.root, '~/Development/lookchina', 'root mais profundo');
  assertEq(enc.path, 'apps/odin', 'relativo ao root profundo');
});

test('sibling directory is not "under" a root (/a/b does not contain /a/bc)', () => {
  const roots = [{ path: '~/Development' }];
  const enc = encodeEntryPath(path.join(HOME_A, 'Developments', 'x'), roots, HOME_A);
  assertEq(enc.root, null, 'Developments não é Development');
});

test('encodeEntryPath recusa caminho relativo', () => {
  assertThrows(() => encodeEntryPath('relative/thing', ROOTS, HOME_A),
    /needs an absolute path/, 'entrada relativa');
});

// ── Path-traversal guards on the decode side ────────────────────────────────

console.log('\ncodec guards (registry is hand-editable input)');

test('root-relative path escaping its root is refused', () => {
  assertThrows(() => resolveEntryPath({ root: '~/Development', path: '../../etc/passwd' }, HOME_A),
    /escapes its root/, '../ escapando');
});

test('root-relative path that normalises back into the root is accepted', () => {
  const abs = resolveEntryPath({ root: '~/Development', path: 'a/../forge-agent' }, HOME_A);
  assertEq(abs, path.join(HOME_A, 'Development', 'forge-agent'), 'normalização interna é ok');
});

test('absolute path where a root-relative one is declared is refused', () => {
  assertThrows(() => resolveEntryPath({ root: '~/Development', path: '/etc' }, HOME_A),
    /absolute but declares root/, 'absoluto + root');
});

test('~-relative path combined with a root is refused', () => {
  assertThrows(() => resolveEntryPath({ root: '~/Development', path: '~/elsewhere' }, HOME_A),
    /home-relative but declares root/, '~ + root');
});

test('rootless relative path is refused rather than guessed', () => {
  assertThrows(() => resolveEntryPath({ root: null, path: 'lookchina' }, HOME_A),
    /unanchored/, 'relativo sem root');
});

test('rootless ~ path escaping home is refused', () => {
  assertThrows(() => resolveEntryPath({ root: null, path: '~/../../etc' }, HOME_A),
    /escapes home/, '~/../ escapando');
});

test('sibling-prefix root does not admit an escape (/a/b vs /a/bc)', () => {
  assertThrows(() => resolveEntryPath({ root: '/a/b', path: '../bc/x' }, HOME_A),
    /escapes its root/, 'prefixo irmão');
});

// R4 (S01-REVIEW): a root itself must be anchored (absolute or ~-relative), or
// resolveRootPath falls through to path.resolve(process.cwd(), ...) — the
// launch directory decides where the containment check lands, and everything
// under that accident then passes as "inside its root". This mirrors the
// unanchored-*entry* guard just above one level up.
test('R4: relative root is refused, not resolved against process.cwd()', () => {
  assertThrows(() => resolveEntryPath({ root: 'relative/root', path: 'x' }, HOME_A),
    /neither absolute nor ~-anchored/, 'root relativo');
});

test('R4: relative root would otherwise silently admit a cwd-relative escape (proof of the bite)', () => {
  // Before the fix, resolveRootPath('relative/root', HOME_A) resolved against
  // process.cwd() (this test process's cwd, e.g. the repo checkout) rather
  // than throwing — so a path.resolve(cwd, 'relative/root', 'x') would come
  // back as an accepted absolute path with no error at all. Prove the guard
  // actually fires from a cwd where the join would otherwise "succeed".
  const before = process.cwd();
  process.chdir(require('os').tmpdir());
  try {
    assertThrows(() => resolveEntryPath({ root: 'relative/root', path: 'x' }, HOME_A),
      /neither absolute nor ~-anchored/, 'root relativo mesmo a partir de outro cwd');
  } finally {
    process.chdir(before);
  }
});

test('R4: relative root inside roots[] (encodeEntryPath containment scan) is refused too', () => {
  assertThrows(() => encodeEntryPath(path.join(HOME_A, 'Development', 'x'),
    [{ path: 'relative/root', primary: true }], HOME_A),
    /neither absolute nor ~-anchored/, 'roots[] com entrada relativa');
});

// ── Portability: written under homeA, read under homeB (SCOPE #16) ──────────

console.log('\nportability across $HOME');

test('a registry encoded under homeA resolves correctly under homeB', () => {
  const absA = [
    path.join(HOME_A, 'Development', 'forge-agent'),
    path.join(HOME_A, 'Development', 'lookchina', 'services', 'freyr'),
    path.join(HOME_A, 'Library', 'Application Support', 'Forge', 'Sandbox'),
    '/opt/outside/thing',
  ];
  const encoded = absA.map(a => encodeEntryPath(a, ROOTS, HOME_A));

  // Not a single stored string may mention the writing machine's home.
  for (const e of encoded) {
    assert(!e.path.startsWith(HOME_A), `entrada carrega o home de origem: ${e.path}`);
  }

  const backB = encoded.map(e => resolveEntryPath(e, HOME_B));
  assertEq(backB[0], path.join(HOME_B, 'Development', 'forge-agent'), 'root-relativa migra');
  assertEq(backB[1], path.join(HOME_B, 'Development', 'lookchina', 'services', 'freyr'), 'aninhada migra');
  assertEq(backB[2], path.join(HOME_B, 'Library', 'Application Support', 'Forge', 'Sandbox'), 'Sandbox migra');
  assertEq(backB[3], '/opt/outside/thing', 'fora do home permanece literal');
});

// ── Kind derivation ─────────────────────────────────────────────────────────

console.log('\nkind derivation');

const asProject = () => ({ kind: 'project', signals: ['milestones'], entries: [] });
const asTouched = () => ({ kind: 'touched', signals: [], entries: [] });

test('project containing another registered entry → workspace', () => {
  const kind = deriveEntryKind('/w/lookchina',
    ['/w/lookchina', '/w/lookchina/services/freyr'], asProject);
  assertEq(kind, 'workspace', 'contém entrada ativa');
});

test('project containing nothing registered → project', () => {
  assertEq(deriveEntryKind('/w/forge-agent', ['/w/forge-agent', '/w/message'], asProject),
    'project', 'sem contenção');
});

test('non-project never becomes a workspace, however much it contains', () => {
  assertEq(deriveEntryKind('/w/x', ['/w/x/a', '/w/x/b'], asTouched),
    'project', 'touched não vira workspace');
});

test('containment uses the separator: /a/b does not contain /a/bc', () => {
  assertEq(deriveEntryKind('/a/b', ['/a/b', '/a/bc'], asProject), 'project', 'irmão não conta');
});

test('an entry does not contain itself', () => {
  assertEq(deriveEntryKind('/a/b', ['/a/b'], asProject), 'project', 'auto-contenção');
});

// ── normalizeRegistry: both shapes, and the loud refusals ───────────────────

console.log('\nnormalizeRegistry — dual shape');

test('legacy [String] normalises to version 0 with rootless entries', () => {
  const raw = [
    path.join(HOME_A, 'Development', 'forge-agent'),
    path.join(HOME_A, 'Library', 'Application Support', 'Forge', 'Sandbox'),
  ];
  const reg = normalizeRegistry(raw, { home: HOME_A });
  assertEq(reg.version, 0, 'version legado');
  assertEq(reg.legacy, true, 'flag legacy');
  assertEq(reg.roots.length, 0, 'legado não tem roots');
  assertEq(reg.entries.length, 2, 'entradas preservadas');
  assertEq(reg.entries[0].path, '~/Development/forge-agent', '~-relativo');
  assertEq(reg.entries[0].root, null, 'sem root inventado');
  assertEq(reg.entries[0].kind, null, 'kind fica para o recompute');
  assertEq(reg.entries[1].path, SANDBOX_REL, 'Sandbox preservado');
  assertEq(reg.quarantine.length, 0, 'quarentena vazia');
});

test('versioned object passes through, missing arrays default to []', () => {
  const reg = normalizeRegistry({ version: 1, entries: [{ path: 'forge-agent', root: '~/Development' }] },
    { home: HOME_A });
  assertEq(reg.version, 1, 'version');
  assertEq(reg.legacy, false, 'não é legado');
  assertEq(reg.roots.length, 0, 'roots ausente → []');
  assertEq(reg.quarantine.length, 0, 'quarantine ausente → []');
  assertEq(reg.entries[0].repos.length, 0, 'repos semeado vazio');
});

test('roots aceitam string ou {path,primary}', () => {
  const reg = normalizeRegistry({ version: 1, roots: ['~/Development', { path: '~/Code', primary: false }] },
    { home: HOME_A });
  assertEq(reg.roots[0].path, '~/Development', 'root string');
  assertEq(reg.roots[0].primary, true, 'primeiro é primary');
  assertEq(reg.roots[1].primary, false, 'segundo não');
});

test('quarantine records carry reason, never kind', () => {
  const reg = normalizeRegistry({
    version: 1,
    quarantine: [{ path: SANDBOX_REL, root: null, reason: 'scratch' },
                 { path: 'lookchina/services', root: '~/Development' }],
  }, { home: HOME_A });
  assertEq(reg.quarantine[0].reason, 'scratch', 'reason explícito');
  assertEq(reg.quarantine[1].reason, 'touched', 'reason default');
  assert(!('kind' in reg.quarantine[0]), 'quarentena não tem kind');
});

test('version > REGISTRY_VERSION → throw naming file and version, never []', () => {
  assertThrows(() => normalizeRegistry({ version: 2, entries: [] }, { home: HOME_A, file: '/x/reg.json' }),
    /\/x\/reg\.json is version 2/, 'versão futura');
});

test('object without version → throw, never []', () => {
  assertThrows(() => normalizeRegistry({ entries: [] }, { home: HOME_A }),
    /no usable "version"/, 'sem version');
});

test('scalar/null raw → throw, never []', () => {
  assertThrows(() => normalizeRegistry(null, { home: HOME_A }), /neither a legacy array/, 'null');
  assertThrows(() => normalizeRegistry('nope', { home: HOME_A }), /neither a legacy array/, 'string');
});

test('legacy array with a non-string element → throw', () => {
  assertThrows(() => normalizeRegistry(['/a', 42], { home: HOME_A }), /legacy entry \[1\]/, 'elemento inválido');
});

test('malformed entry record → throw', () => {
  assertThrows(() => normalizeRegistry({ version: 1, entries: [{ root: '~/Development' }] }, { home: HOME_A }),
    /entries\[0\] is malformed/, 'entry sem path');
});

// ── loadRegistry ────────────────────────────────────────────────────────────

console.log('\nloadRegistry');

function writeReg(dir, data) {
  const file = path.join(dir, REGISTRY_FILENAME);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

test('missing file → null (absent is not corrupt, and not empty)', () => {
  const dir = mkTmp('absent');
  assertEq(loadRegistry(path.join(dir, REGISTRY_FILENAME), { home: dir }), null, 'ENOENT → null');
});

test('corrupt JSON → throw, never []', () => {
  const dir = mkTmp('corrupt');
  const file = writeReg(dir, '{ this is not json');
  assertThrows(() => loadRegistry(file, { home: dir }),
    /not valid JSON/, 'JSON corrompido');
});

test('version 9 on disk → throw, never []', () => {
  const dir = mkTmp('future');
  const file = writeReg(dir, { version: 9, entries: [] });
  assertThrows(() => loadRegistry(file, { home: dir }), /is version 9/, 'versão futura em disco');
});

test('legacy file loads, resolves absolutes and recomputes kinds from disk', () => {
  const home = mkTmp('legacy-home');
  const ws = mkProject(path.join(home, 'Development', 'lookchina'));
  const child = mkProject(path.join(home, 'Development', 'lookchina', 'services', 'freyr'));
  const solo = mkProject(path.join(home, 'Development', 'forge-agent'));
  const file = writeReg(home, [ws, child, solo]);

  const reg = loadRegistry(file, { home });
  assertEq(reg.version, 0, 'shape legado');
  assertEq(reg.entries.length, 3, 'três entradas');
  assertEq(reg.entries[0].abs, ws, 'abs resolvido');
  assertEq(reg.entries[0].kind, 'workspace', 'contém freyr → workspace');
  assertEq(reg.entries[1].kind, 'project', 'freyr é project');
  assertEq(reg.entries[2].kind, 'project', 'forge-agent é project');
  assertEq(reg.file, file, 'file registrado');
  assert(solo.length > 0, 'fixture usada');
});

test('a stored kind that disagrees with disk facts is corrected on load', () => {
  const home = mkTmp('recompute-home');
  const ws = mkProject(path.join(home, 'Development', 'lookchina'));
  mkProject(path.join(home, 'Development', 'lookchina', 'services', 'freyr'));
  const file = writeReg(home, {
    version: 1,
    roots: [{ path: '~/Development', primary: true }],
    entries: [
      { path: 'lookchina', root: '~/Development', kind: 'project' },            // mente
      { path: 'lookchina/services/freyr', root: '~/Development', kind: 'workspace' }, // mente
    ],
  });

  const reg = loadRegistry(file, { home });
  assertEq(reg.entries[0].kind, 'workspace', 'kind corrigido para workspace');
  assertEq(reg.entries[1].kind, 'project', 'kind corrigido para project');
  assertEq(reg.entries[0].abs, ws, 'abs veio do codec root-relativo');
});

test('recomputeKinds:false preserva o kind armazenado (cache de exibição)', () => {
  const home = mkTmp('nocompute-home');
  mkProject(path.join(home, 'Development', 'lookchina'));
  mkProject(path.join(home, 'Development', 'lookchina', 'services', 'freyr'));
  const file = writeReg(home, {
    version: 1,
    roots: [{ path: '~/Development', primary: true }],
    entries: [{ path: 'lookchina', root: '~/Development', kind: 'project' }],
  });
  const reg = loadRegistry(file, { home, recomputeKinds: false });
  assertEq(reg.entries[0].kind, 'project', 'kind armazenado intacto');
});

test('quarantine entries também resolvem, inclusive Sandbox com espaços', () => {
  const home = mkTmp('quarantine-home');
  const file = writeReg(home, {
    version: 1,
    roots: [{ path: '~/Development', primary: true }],
    entries: [],
    quarantine: [
      { path: 'lookchina/services', root: '~/Development', reason: 'touched' },
      { path: SANDBOX_REL, root: null, reason: 'scratch' },
    ],
  });
  const reg = loadRegistry(file, { home });
  assertEq(reg.quarantine[0].abs, path.join(home, 'Development', 'lookchina', 'services'), 'touched');
  assertEq(reg.quarantine[1].abs,
    path.join(home, 'Library', 'Application Support', 'Forge', 'Sandbox'), 'scratch com espaços');
});

test('a hand-edited traversal in the file surfaces as a throw on load', () => {
  const home = mkTmp('traversal-home');
  const file = writeReg(home, {
    version: 1,
    roots: [{ path: '~/Development', primary: true }],
    entries: [{ path: '../../../../etc', root: '~/Development' }],
  });
  assertThrows(() => loadRegistry(file, { home }), /escapes its root/, 'traversal em disco');
});

// ── Side-effect freedom (must-have: this module writes nothing) ─────────────

console.log('\nno side effects');

test('loading never creates the file, its directory, or ~/.claude', () => {
  const home = mkTmp('sideeffect-home');
  const claude = path.join(home, '.claude');
  const file = registryPath(home);
  assertEq(loadRegistry(file, { home }), null, 'ausente → null');
  assert(!fs.existsSync(claude), 'loadRegistry criou ~/.claude/');
  assert(!fs.existsSync(file), 'loadRegistry criou o registry');
});

// Comentários são removidos antes de qualquer varredura de propósito: o
// cabeçalho do módulo *cita* `mkdirSync` ao narrar o defeito que ele existe para
// matar, e um guard que morde numa citação em prosa quebra ao reescrever
// comentário, não ao mudar comportamento. O que interessa é a chamada, com o
// `fs.` na frente e o parêntese atrás.
function moduleSource() {
  return fs.readFileSync(path.join(__dirname, 'forge-workspace.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MIGRATION_MARKER = 'const DISCOVERY_ROOT_NAMES';

test('classificação e codec continuam sem escrever nada (região acima da migração)', () => {
  const code = moduleSource();
  const cut = code.indexOf(MIGRATION_MARKER);
  assert(cut > 0, 'marcador da seção de migração sumiu do fonte');
  const readOnlyRegion = code.slice(0, cut);
  for (const banned of ['writeFileSync', 'mkdirSync', 'appendFileSync', 'copyFileSync',
                        'rmSync', 'writeSync', 'renameSync', 'unlinkSync']) {
    assert(!new RegExp(`fs\\.${banned}\\s*\\(`).test(readOnlyRegion),
      `classify/codec passaram a chamar fs.${banned}() — essa região é read-only`);
  }
});

test('o módulo nunca cria diretório nem apaga arquivo — nem na seção de escrita', () => {
  // `.gsd/` manufaturado por ferramenta foi o defeito de origem da milestone.
  // A migração pode escrever o registry (temp+rename, cópia do .bak) e nada mais.
  const code = moduleSource();
  for (const banned of ['mkdirSync', 'mkdir', 'rmSync', 'unlinkSync', 'rmdirSync']) {
    assert(!new RegExp(`fs\\.${banned}\\s*\\(`).test(code),
      `forge-workspace.js passou a chamar fs.${banned}() — proibido em qualquer região`);
  }
});

test('load de registry vivo não é exercido: fixtures só em tmpdir', () => {
  for (const d of tmpRoots) {
    assert(d.startsWith(path.resolve(os.tmpdir())), `fixture fora do tmpdir: ${d}`);
  }
});

// ── Migration ───────────────────────────────────────────────────────────────
//
// The fixture below is not an invention: it is the live registry's pathology
// classes, one instance each, rebuilt under a synthetic `$HOME`.
//
//   a standalone project                     → stays active
//   a workspace with real work, UNREGISTERED  → must be promoted (this is
//     `~/Development/lookchina`, absent from the array because the app's scan
//     roots never reached it)
//   a member project under it                 → stays active
//   a directory with only runtime `.gsd/`     → quarantine `touched`
//   a directory with an empty `.gsd/`         → quarantine `touched`
//   the app's own Sandbox, path with spaces   → quarantine `scratch`
//   a registered path no longer on disk       → quarantine `touched`, annotated
//
// Nothing may leave the migration without appearing on one of the two lists.
// The operator cannot rebuild this file from anywhere.

console.log('\nmigration — facts, dispositions, promotion, roots');

const {
  DISCOVERY_ROOT_NAMES,
  gatherFacts,
  migrate,
  formatReport,
  writeRegistry,
} = require('./forge-workspace.js');

/** `.gsd/` with only runtime scratch inside → classifies `touched`. */
function mkTouched(dir) {
  fs.mkdirSync(path.join(dir, '.gsd', 'forge'), { recursive: true });
  return dir;
}
function mkEmptyGsd(dir) {
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  return dir;
}

/**
 * Build the pathology fixture. Returns the synthetic home plus every absolute
 * path by name, and the legacy array in registration order.
 */
function mkPathologyFixture(label) {
  const home = mkTmp(label);
  const dev = path.join(home, 'Development');
  const p = {
    home,
    dev,
    forgeAgent: mkProject(path.join(dev, 'forge-agent')),
    lookchina: mkProject(path.join(dev, 'lookchina')),            // NOT registered
    odin: mkProject(path.join(dev, 'lookchina', 'apps', 'odin')),
    services: mkEmptyGsd(path.join(dev, 'lookchina', 'services')),
    freyr: mkProject(path.join(dev, 'lookchina', 'services', 'freyr')),
    glitnir: mkTouched(path.join(dev, 'lookchina', 'glitnir')),
    sandbox: mkProject(path.join(home, 'Library', 'Application Support', 'Forge', 'Sandbox')),
    gone: path.join(dev, 'projeto-apagado'),                       // never created
  };
  // A discovery-root candidate that exists but holds nothing active: it must
  // NOT be seeded, or every home on earth grows seven roots.
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });

  p.legacy = [p.forgeAgent, p.odin, p.services, p.freyr, p.glitnir, p.sandbox, p.gone];
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  p.file = registryPath(home);
  fs.writeFileSync(p.file, JSON.stringify(p.legacy, null, 2));
  return p;
}

function migrateFixture(fx) {
  const facts = gatherFacts(fx.legacy, { home: fx.home });
  return { facts, ...migrate(fx.legacy, facts, { home: fx.home }) };
}

test('gatherFacts descreve o disco e devolve objeto serializável', () => {
  const fx = mkPathologyFixture('facts');
  const facts = gatherFacts(fx.legacy, { home: fx.home });
  assertEq(JSON.parse(JSON.stringify(facts)).entries.length, fx.legacy.length, 'uma fact por entrada');
  const byPath = new Map(facts.entries.map(e => [e.path, e]));
  assertEq(byPath.get(fx.forgeAgent).kind, 'project', 'projeto');
  assertEq(byPath.get(fx.services).kind, 'touched', '.gsd/ vazio → touched');
  assertEq(byPath.get(fx.glitnir).kind, 'touched', 'só scratch de runtime → touched');
  assertEq(byPath.get(fx.gone).exists, false, 'caminho ausente do disco');
  assert(facts.ancestors.some(a => a.path === fx.lookchina),
    'lookchina não foi descoberto como ancestral não registrado');
  assertEq(facts.roots.length, DISCOVERY_ROOT_NAMES.length, 'candidatos a root espelhados');
});

test('migrate() é puro — nenhuma chamada a fs no corpo da função', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-workspace.js'), 'utf8');
  const start = src.indexOf('function migrate(');
  assert(start > 0, 'migrate() não encontrada');
  const end = src.indexOf('\nfunction ', start + 10);
  const body = src.slice(start, end > 0 ? end : src.length);
  assert(!/\bfs\./.test(body), 'migrate() tocou fs — a migração precisa ser testável sem disco');
  assert(!/require\(/.test(body), 'migrate() passou a exigir um módulo em runtime');
});

test('migrate() aceita fatos fabricados, sem tocar em disco algum', () => {
  const home = '/synthetic/factsonly';
  const dev = home + '/Development';
  const oldPaths = [dev + '/forge-agent', dev + '/lookchina/services'];
  const facts = {
    home,
    entries: [
      { path: dev + '/forge-agent', exists: true, kind: 'project' },
      { path: dev + '/lookchina/services', exists: true, kind: 'touched' },
    ],
    ancestors: [],
    roots: [{ name: 'Development', path: dev, exists: true }],
  };
  const { registry, report } = migrate(oldPaths, facts, { home });
  assertEq(report.inputCount, 2, 'contagem medida da entrada');
  assertEq(registry.entries.length, 1, 'uma ativa');
  assertEq(registry.quarantine[0].reason, 'touched', 'a outra em quarentena');
  assertEq(registry.roots[0].path, '~/Development', 'root semeado');
});

test('cada entrada de entrada vira exatamente uma linha do relatório', () => {
  const fx = mkPathologyFixture('lines');
  const { report } = migrateFixture(fx);
  assertEq(report.inputCount, fx.legacy.length, 'contagem medida, não constante');
  const inputLines = report.lines.filter(l => l.disposition !== 'promoted');
  assertEq(inputLines.length, fx.legacy.length, 'uma linha por entrada — nunca um resumo');
  for (const abs of fx.legacy) {
    assert(report.lines.some(l => l.path === abs), `entrada sem linha no relatório: ${abs}`);
  }
});

test('disposições: projeto ativa, touched/empty em quarentena, Sandbox scratch, ausente anotado', () => {
  const fx = mkPathologyFixture('disp');
  const { registry } = migrateFixture(fx);
  const activeAbs = registry.entries.map(e => resolveEntryPath(e, fx.home));
  const quar = new Map(registry.quarantine.map(q => [resolveEntryPath(q, fx.home), q]));

  assert(activeAbs.includes(fx.forgeAgent), 'forge-agent ativa');
  assert(activeAbs.includes(fx.odin), 'odin ativa');
  assert(activeAbs.includes(fx.freyr), 'freyr ativa');

  assertEq(quar.get(fx.services).reason, 'touched', 'services (peer dos próprios filhos) → touched');
  assertEq(quar.get(fx.glitnir).reason, 'touched', 'glitnir → touched');
  assertEq(quar.get(fx.sandbox).reason, 'scratch', 'Sandbox → scratch, mesmo tendo .gsd/ de verdade');
  assertEq(quar.get(fx.gone).reason, 'touched', 'ausente vai para quarentena');
  assertEq(quar.get(fx.gone).missing, true, 'ausente é anotado, não descartado');
  assert(!activeAbs.includes(fx.services), 'services deixou de ser entrada ativa');
});

test('nada é descartado: toda entrada de entrada sai em entries ∪ quarantine', () => {
  const fx = mkPathologyFixture('nodrop');
  const { registry } = migrateFixture(fx);
  const out = new Set([
    ...registry.entries.map(e => resolveEntryPath(e, fx.home)),
    ...registry.quarantine.map(q => resolveEntryPath(q, fx.home)),
  ]);
  for (const abs of fx.legacy) assert(out.has(abs), `entrada sumiu na migração: ${abs}`);
});

test('o workspace não registrado é promovido a kind: workspace', () => {
  const fx = mkPathologyFixture('promote');
  const { registry, report } = migrateFixture(fx);
  const promoted = registry.entries.find(e => resolveEntryPath(e, fx.home) === fx.lookchina);
  assert(promoted, 'lookchina não foi promovido');
  assertEq(promoted.kind, 'workspace', 'promovido entra como workspace');
  assertEq(report.promotedCount, 1, 'exatamente uma promoção');
  assert(report.lines.some(l => l.path === fx.lookchina && l.disposition === 'promoted'),
    'promoção precisa aparecer no relatório');
});

test('roots semeados só onde existe algo ativo (Documents existe e não entra)', () => {
  const fx = mkPathologyFixture('roots');
  const { registry } = migrateFixture(fx);
  assertEq(registry.roots.length, 1, 'um único root');
  assertEq(registry.roots[0].path, '~/Development', 'Development semeado');
  assertEq(registry.roots[0].primary, true, 'primeiro é primary');
});

test('DISCOVERY_ROOT_NAMES espelha ProjectDiscovery.roots (GitCore.swift:111-112)', () => {
  assertEq(DISCOVERY_ROOT_NAMES.join(','),
    'Development,Documents,Projects,Code,src,repos,Desktop', 'lista espelhada');
});

test('todo caminho gravado passou pelo codec (nenhum absoluto do home vaza)', () => {
  const fx = mkPathologyFixture('codec');
  const { registry } = migrateFixture(fx);
  for (const rec of [...registry.entries, ...registry.quarantine]) {
    assert(!rec.path.startsWith(fx.home), `caminho absoluto do home gravado cru: ${rec.path}`);
  }
  const sandbox = registry.quarantine.find(q => q.reason === 'scratch');
  assertEq(sandbox.root, null, 'Sandbox não pertence a root algum');
  assertEq(sandbox.path, SANDBOX_REL, 'espaços preservados pelo codec');
});

test('o resultado da migração recarrega pelo loader sem perda', () => {
  const fx = mkPathologyFixture('roundtrip');
  const { registry } = migrateFixture(fx);
  const file = path.join(mkTmp('written'), REGISTRY_FILENAME);
  writeRegistry(file, registry);
  const reg = loadRegistry(file, { home: fx.home });
  assertEq(reg.version, REGISTRY_VERSION, 'version 1');
  assertEq(reg.legacy, false, 'não é mais legado');
  assertEq(reg.entries.length, registry.entries.length, 'entradas preservadas');
  const look = reg.entries.find(e => e.abs === fx.lookchina);
  assertEq(look.kind, 'workspace', 'kind recomputado bate com o gravado');
});

test('formatReport imprime uma linha por caminho, não um resumo', () => {
  const fx = mkPathologyFixture('format');
  const { report } = migrateFixture(fx);
  const text = formatReport(report, { file: fx.file });
  for (const abs of fx.legacy) assert(text.includes(abs), `caminho ausente do preview: ${abs}`);
  assert(text.includes(String(report.inputCount)), 'contagem medida impressa');
});

test('writeRegistry é atômico: escreve temp e renomeia, sem deixar sobras', () => {
  const dir = mkTmp('atomic');
  const file = path.join(dir, REGISTRY_FILENAME);
  writeRegistry(file, { version: 1, roots: [], entries: [], quarantine: [] });
  assertEq(fs.readdirSync(dir).length, 1, 'nenhum .tmp sobrou');
  assertEq(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1, 'conteúdo gravado');
});

// ── CLI: preview antes de escrever, .bak write-once ─────────────────────────

console.log('\nmigration CLI');

const { spawnSync } = require('child_process');
const CLI = path.join(__dirname, 'forge-workspace.js');

function runCli(fx, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--home', fx.home, '--file', fx.file], {
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('--migrate --dry-run: preview completo e ZERO escritas (mtime provado)', () => {
  const fx = mkPathologyFixture('dryrun');
  const before = fs.statSync(fx.file);
  const beforeBytes = fs.readFileSync(fx.file);

  const r = runCli(fx, ['--migrate', '--dry-run']);
  assertEq(r.code, 0, `dry-run falhou: ${r.err}`);

  const after = fs.statSync(fx.file);
  assertEq(after.mtimeMs, before.mtimeMs, 'mtime mudou — houve escrita no dry-run');
  assert(fs.readFileSync(fx.file).equals(beforeBytes), 'conteúdo do registry mudou no dry-run');
  assert(!fs.existsSync(fx.file + '.bak'), 'dry-run criou .bak');

  for (const abs of fx.legacy) assert(r.out.includes(abs), `dry-run omitiu ${abs}`);
  assert(r.out.includes(fx.lookchina), 'dry-run omitiu a promoção');
  assert(/dry-run: nenhuma escrita/.test(r.out), 'dry-run precisa dizer que não escreveu');
});

test('--migrate real: .bak byte-idêntico ao original e registry na version 1', () => {
  const fx = mkPathologyFixture('real');
  const original = fs.readFileSync(fx.file);

  const r = runCli(fx, ['--migrate']);
  assertEq(r.code, 0, `migrate falhou: ${r.err}`);

  const bak = fx.file + '.bak';
  assert(fs.existsSync(bak), '.bak não foi criado');
  assert(fs.readFileSync(bak).equals(original), '.bak não é byte-idêntico ao original');

  const now = JSON.parse(fs.readFileSync(fx.file, 'utf8'));
  assertEq(now.version, 1, 'registry migrado');
  assert(Array.isArray(now.roots) && now.roots.length === 1, 'roots gravados');
  assert(r.out.includes('verifique com'), 'a saída precisa dizer como conferir');
});

test('segundo --migrate é no-op explícito: não reescreve o arquivo nem o .bak', () => {
  const fx = mkPathologyFixture('idempotent');
  assertEq(runCli(fx, ['--migrate']).code, 0, 'primeira migração');
  const bak = fx.file + '.bak';
  const fileBefore = fs.statSync(fx.file);
  const bakBefore = fs.readFileSync(bak);

  const second = runCli(fx, ['--migrate']);
  assertEq(second.code, 0, 'segunda invocação sai limpa');
  assert(/already migrated, version 1/.test(second.out), `esperado no-op explícito, veio: ${second.out}`);
  assertEq(fs.statSync(fx.file).mtimeMs, fileBefore.mtimeMs, 'segunda migração escreveu no registry');
  assert(fs.readFileSync(bak).equals(bakBefore), 'segunda migração mexeu no .bak');
});

test('.bak é write-once: com legado de volta e .bak presente, --migrate recusa', () => {
  // O caso destrutivo é justamente este: um registry legado (restaurado à mão,
  // ou um segundo checkout) com um .bak já existente. Sobrescrever o .bak
  // trocaria a única cópia legada por conteúdo já migrado.
  const fx = mkPathologyFixture('bakonce');
  assertEq(runCli(fx, ['--migrate']).code, 0, 'primeira migração');
  const bak = fx.file + '.bak';
  const bakBefore = fs.readFileSync(bak);

  fs.writeFileSync(fx.file, JSON.stringify(fx.legacy, null, 2)); // legado de volta
  const r = runCli(fx, ['--migrate']);
  assert(r.code !== 0, 'esperava recusa, veio sucesso');
  assert(/já existe/.test(r.err), `recusa precisa ser legível: ${r.err}`);
  assert(fs.readFileSync(bak).equals(bakBefore), '.bak foi sobrescrito — dado do operador perdido');
});

test('--registry --json funciona antes (legacy: true) e depois da migração', () => {
  const fx = mkPathologyFixture('registrycmd');

  const before = runCli(fx, ['--registry', '--json']);
  assertEq(before.code, 0, `--registry no legado falhou: ${before.err}`);
  const b = JSON.parse(before.out);
  assertEq(b.legacy, true, 'shape legado sinalizado');
  assertEq(b.version, 0, 'version 0 para o legado');
  // A visão legada é literal: nem sequer o caminho ausente do disco é omitido.
  // Filtrar aqui esconderia da inspeção justamente o que a migração precisa
  // decidir explicitamente.
  assertEq(b.entries.length, fx.legacy.length, 'visão legada mostra todas as entradas');

  assertEq(runCli(fx, ['--migrate']).code, 0, 'migração');

  const after = runCli(fx, ['--registry', '--json']);
  assertEq(after.code, 0, `--registry pós-migração falhou: ${after.err}`);
  const a = JSON.parse(after.out);
  assertEq(a.version, 1, 'version 1');
  assertEq(a.legacy, false, 'não é legado');
  assert(a.roots.length === 1 && a.roots[0].primary === true, 'roots com primary');
  const look = a.entries.find(e => e.abs === fx.lookchina);
  assert(look, 'lookchina ausente pós-migração (SCOPE #1 quebrado)');
  assertEq(look.kind, 'workspace', 'lookchina como workspace');
  assert(a.quarantine.some(q => q.reason === 'scratch'), 'Sandbox visível na quarentena');
});

test('--migrate sem registry: erro legível, exit != 0, nada criado', () => {
  const home = mkTmp('noreg');
  const file = registryPath(home);
  const r = spawnSync(process.execPath, [CLI, '--migrate', '--home', home, '--file', file], { encoding: 'utf8' });
  assert(r.status !== 0, 'esperava falha');
  assert(/nada a migrar/.test(r.stderr), `mensagem: ${r.stderr}`);
  assert(!fs.existsSync(file), 'CLI criou o registry ausente');
  assert(!fs.existsSync(path.dirname(file)), 'CLI criou ~/.claude');
});

test('--migrate sobre registry corrompido falha alto, sem escrever', () => {
  const fx = mkPathologyFixture('corruptcli');
  fs.writeFileSync(fx.file, '{ nao e json');
  const before = fs.statSync(fx.file).mtimeMs;
  const r = runCli(fx, ['--migrate']);
  assert(r.code !== 0, 'esperava falha');
  assert(/not valid JSON/.test(r.err), `mensagem: ${r.err}`);
  assertEq(fs.statSync(fx.file).mtimeMs, before, 'arquivo corrompido foi tocado');
  assert(!fs.existsSync(fx.file + '.bak'), 'criou .bak de um arquivo corrompido');
});

// ── Summary ─────────────────────────────────────────────────────────────────

cleanup();
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
