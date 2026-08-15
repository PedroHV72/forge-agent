#!/usr/bin/env node
'use strict';

// forge-app-workspace-marker.test.js — keeps the two halves of one rule in step.
//
// "What makes a directory a Forge project" is implemented twice, because two
// runtimes need it: `scripts/forge-workspace.js` (the scripts that write state)
// and `app/Sources/ForgeKit/ProjectMarker.swift` (the app that lists projects).
// Two hand-maintained lists drift — someone adds `followups` to the JS side
// after seeing it in a real `.gsd/`, and the app quietly keeps calling that
// project "tocado". Nothing in either file would fail.
//
// So this suite compares the two literals directly. That is not the tautology
// the launch-parity suite warns about: there, both sides *computed* the same
// answer and comparing them would prove nothing. Here the values are a shared
// constant maintained by hand in two places, and drift between them is exactly
// the failure being guarded.
//
// It also pins the call site. Discovery used to ask `fileExists(".gsd")`
// directly, which is the bug that started this; if someone inlines that check
// again, the predicate becomes decorative.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const path = require('path');

const { WORK_ENTRIES, DASHBOARD_MARKER } = require('./forge-workspace.js');

const repoRoot = path.resolve(__dirname, '..');
const markerSwift = path.join(repoRoot, 'app/Sources/ForgeKit/ProjectMarker.swift');
const gitCoreSwift = path.join(repoRoot, 'app/Sources/ForgeKit/GitCore.swift');

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

const swift = fs.readFileSync(markerSwift, 'utf8');

/** Extract the string literals of `public static let workEntries: [String] = [...]`. */
function swiftWorkEntries(src) {
  const m = src.match(/public static let workEntries: \[String\] = \[([\s\S]*?)\n {4}\]/);
  if (!m) throw new Error('workEntries não encontrado em ProjectMarker.swift');
  // Strip // comments before harvesting literals, so a name mentioned in prose
  // is never mistaken for an entry.
  const body = m[1].split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  return [...body.matchAll(/"([^"]+)"/g)].map(x => x[1]);
}

console.log('\nParidade do marcador de projeto (JS ⇄ Swift)');

test('as duas listas de artefatos de trabalho são idênticas', () => {
  const fromSwift = swiftWorkEntries(swift);
  const a = [...new Set(WORK_ENTRIES)].sort();
  const b = [...new Set(fromSwift)].sort();

  const onlyJs = a.filter(x => !b.includes(x));
  const onlySwift = b.filter(x => !a.includes(x));
  assert(onlyJs.length === 0 && onlySwift.length === 0,
         `listas divergiram — só no JS: [${onlyJs}] · só no Swift: [${onlySwift}]`);
  assert(a.length > 10, `lista suspeitosamente curta (${a.length}) — regex quebrou?`);
});

test('o marcador do dashboard é a mesma string dos dois lados', () => {
  const m = swift.match(/public static let dashboardMarker = "([^"]+)"/);
  assert(m, 'dashboardMarker não encontrado em ProjectMarker.swift');
  assert(m[1] === DASHBOARD_MARKER,
         `divergiu: Swift "${m[1]}" ≠ JS "${DASHBOARD_MARKER}"`);
});

test('o marcador casa com o cabeçalho que o dashboard realmente escreve', () => {
  // Compares against the writer, not against another copy of the constant: if
  // forge-dashboard.js changes its header, both sides go blind at once and
  // every dashboard STATE.md starts counting as work.
  const dash = fs.readFileSync(path.join(repoRoot, 'scripts/forge-dashboard.js'), 'utf8');
  assert(dash.includes(DASHBOARD_MARKER),
         'forge-dashboard.js não escreve mais esse cabeçalho — o predicado ficou cego');
});

console.log('\nO predicado é de fato quem decide');

test('ProjectDiscovery pergunta ao ProjectMarker, não ao FileManager', () => {
  const src = fs.readFileSync(gitCoreSwift, 'utf8');
  const walk = src.slice(src.indexOf('static func walk('));
  assert(/ProjectMarker\.isProject\(/.test(walk),
         'walk() não usa ProjectMarker — a descoberta voltou a ser "tem .gsd/"');
  assert(!/fileExists\(atPath: dir\.appendingPathComponent\("\.gsd"\)/.test(walk),
         'walk() voltou a testar presença de .gsd/ diretamente');
});

test('nenhum script cria .gsd/ a caminho de outra pasta', () => {
  // The two mkdir -p calls that enrolled 5 of 18 projects. forge-doctor.js is
  // exempt on purpose: `--fix` is an explicit operator request to repair a
  // project, and it stamps SCHEMA-VERSION right after.
  const offenders = [];
  for (const f of ['forge-verify.js', 'forge-lock.js', 'forge-dashboard.js']) {
    const src = fs.readFileSync(path.join(repoRoot, 'scripts', f), 'utf8');
    const lines = src.split('\n');
    lines.forEach((l, i) => {
      if (l.includes('//')) return;                       // prose about the bug
      if (!/mkdirSync/.test(l)) return;
      if (!/recursive:\s*true/.test(l)) return;
      // Creating something *inside* an existing .gsd is fine; creating a path
      // that contains '.gsd' as a segment to be made is not.
      if (/['"`]\.gsd['"`]/.test(l)) offenders.push(`${f}:${i + 1}: ${l.trim()}`);
    });
  }
  assert(offenders.length === 0,
         `mkdir -p atravessando .gsd/:\n    ${offenders.join('\n    ')}`);
});

// ───────────────────────────────────────────────────────────────────────────
// S02 · Shared-literal anchors (SCOPE #15)
//
// S01 introduced three literal families that now exist in both runtimes: the
// registry filename/version, the schema keys/kinds/reasons, and the discovery
// seed roots. Same failure mode as the marker above — two hand-maintained
// copies, and drift between them is silent.
//
// One deliberate difference from the marker anchors: the schema family is NOT
// compared against a second JS constants object. A constants object nobody
// consumes is itself a hand-copy, and comparing hand-copies is decoration. The
// Swift constants are compared against the shape `migrate()` **actually
// writes** — so a rename on either side, in the literal or in the writer, is
// caught by the same assertion.
//
// Every comparator here is a pure `(swiftSrc, jsValue) -> {ok, diff}` function
// for one reason: it lets the suite prove, on every single run, that the
// comparator can be made to fail from either side (see "auto-verificação de
// mutação" below). A guard nobody has seen failing is not coverage.
//
// FUTURE SLICES: when you introduce a new literal shared between
// `scripts/forge-workspace.js` and the Swift sources, add its anchor here — in
// the same task that introduces it — with a guarantor and both mutation
// self-checks. Do not start a second parity suite.
// ───────────────────────────────────────────────────────────────────────────

const {
  REGISTRY_FILENAME, REGISTRY_VERSION, DISCOVERY_ROOT_NAMES, migrate,
  ROLE_KINDS, REGISTRABLE_ROLES,
} = require('./forge-workspace.js');

const registrySwiftPath = path.join(repoRoot, 'app/Sources/ForgeKit/WorkspaceRegistry.swift');
const storesSwiftPath = path.join(repoRoot, 'app/Sources/Forge/Stores.swift');
const projectsSwiftPath = path.join(repoRoot, 'app/Sources/Forge/Projects.swift');

const registrySwift = fs.readFileSync(registrySwiftPath, 'utf8');
const gitCoreSrc = fs.readFileSync(gitCoreSwift, 'utf8');

/** Drop `//` comments so prose is never harvested as a literal. */
function stripLineComments(text) {
  return text.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

function setDiff(a, b) {
  const A = [...new Set(a)].sort();
  const B = [...new Set(b)].sort();
  return { onlyA: A.filter(x => !B.includes(x)), onlyB: B.filter(x => !A.includes(x)) };
}

// ── Anchor (a): registry filename + schema version ──────────────────────────

function compareFilename(swiftSrc, jsFilename) {
  const m = swiftSrc.match(/public static let filename = "([^"]+)"/);
  if (!m) throw new Error('filename não encontrado em WorkspaceRegistry.swift — regex quebrou?');
  return m[1] === jsFilename
    ? { ok: true, diff: '' }
    : { ok: false, diff: `Swift "${m[1]}" ≠ JS "${jsFilename}"` };
}

function compareVersion(swiftSrc, jsVersion) {
  const m = swiftSrc.match(/public static let version = (\d+)/);
  if (!m) throw new Error('version não encontrado em WorkspaceRegistry.swift — regex quebrou?');
  return Number(m[1]) === jsVersion
    ? { ok: true, diff: '' }
    : { ok: false, diff: `Swift ${m[1]} ≠ JS ${jsVersion}` };
}

// ── Anchor (b): schema keys / kinds / reasons, against migrate()'s output ───

/** Harvest `keyX`/`kindX`/`reasonX` literal *values* from the Swift source. */
function swiftSchemaLiterals(swiftSrc) {
  const body = stripLineComments(swiftSrc);
  const grab = prefix => [...body.matchAll(
    new RegExp(`public static let ${prefix}[A-Za-z0-9_]* = "([^"]+)"`, 'g'))].map(x => x[1]);
  const keys = grab('key');
  const kinds = grab('kind');
  const reasons = grab('reason');
  if (keys.length < 8) {
    throw new Error(`só ${keys.length} chaves colhidas de WorkspaceRegistry.swift (piso 8) — regex quebrou?`);
  }
  if (kinds.length === 0 || reasons.length === 0) {
    throw new Error('kinds/reasons não colhidos de WorkspaceRegistry.swift — regex quebrou?');
  }
  return { keys, kinds, reasons };
}

/**
 * A synthetic `facts` object (the shape `gatherFacts` returns) crafted to drive
 * `migrate()` through every branch whose literals the Swift side names: an
 * active entry, a promoted workspace, a `touched` quarantine and a `scratch`
 * one. No disk is touched — `migrate` is pure by design.
 */
function syntheticRegistry() {
  const home = '/tmp/forge-parity-fixture-home';
  const at = rel => `${home}/${rel}`;
  const oldPaths = [
    at('Development/ws/app'),
    at('Development/tocado'),
    at('Library/Application Support/Forge/scratch-run'),
  ];
  const facts = {
    home,
    stopAt: home,
    entries: [
      { path: oldPaths[0], exists: true, kind: 'project' },
      { path: oldPaths[1], exists: true, kind: 'touched' },
      { path: oldPaths[2], exists: true, kind: 'project' },
    ],
    ancestors: [{ path: at('Development/ws'), kind: 'project' }],
    roots: [
      { name: 'Development', path: at('Development'), exists: true },
      { name: 'Desktop', path: at('Desktop'), exists: false },
    ],
  };
  const { registry } = migrate(oldPaths, facts, { home });
  return registry;
}

/** Keys/kinds/reasons the JS writer actually emitted, harvested from output. */
function jsSchemaLiterals(registry) {
  // Tolerant on purpose: a writer that renamed a key must produce a *diff*,
  // not a crash — a comparator that throws instead of reporting is unusable as
  // the mutation self-check below.
  const entries = Array.isArray(registry.entries) ? registry.entries : [];
  const quarantine = Array.isArray(registry.quarantine) ? registry.quarantine : [];
  const keys = new Set(Object.keys(registry));
  for (const r of [...entries, ...quarantine]) for (const k of Object.keys(r)) keys.add(k);
  const strings = xs => xs.filter(v => typeof v === 'string');
  return {
    keys: [...keys],
    kinds: strings(entries.map(e => e.kind)),
    reasons: strings(quarantine.map(q => q.reason)),
  };
}

function compareSchema(swiftSrc, registry) {
  const s = swiftSchemaLiterals(swiftSrc);
  const j = jsSchemaLiterals(registry);
  if (j.keys.length < 8) {
    throw new Error(`migrate() emitiu só ${j.keys.length} chaves (piso 8) — a fixture parou de exercitar o schema`);
  }
  const parts = [];
  for (const [label, a, b] of [
    ['chaves', s.keys, j.keys], ['kinds', s.kinds, j.kinds], ['reasons', s.reasons, j.reasons],
  ]) {
    const d = setDiff(a, b);
    if (d.onlyA.length || d.onlyB.length) {
      parts.push(`${label} — só no Swift: [${d.onlyA}] · só no que o JS escreve: [${d.onlyB}]`);
    }
  }
  return { ok: parts.length === 0, diff: parts.join(' | ') };
}

// ── Anchor (c): discovery seed roots ────────────────────────────────────────

function swiftDiscoveryRoots(swiftSrc) {
  const m = swiftSrc.match(/public static let roots = \[([\s\S]*?)\]/);
  if (!m) throw new Error('ProjectDiscovery.roots não encontrado em GitCore.swift — regex quebrou?');
  const names = [...stripLineComments(m[1]).matchAll(/"([^"]+)"/g)].map(x => x[1]);
  if (names.length < 5) {
    throw new Error(`só ${names.length} roots colhidos de GitCore.swift (piso 5) — regex quebrou?`);
  }
  return names;
}

function compareRoots(swiftSrc, jsRoots) {
  const fromSwift = swiftDiscoveryRoots(swiftSrc);
  if (jsRoots.length < 5) {
    throw new Error(`DISCOVERY_ROOT_NAMES com só ${jsRoots.length} nomes (piso 5) — export quebrou?`);
  }
  const d = setDiff(fromSwift, jsRoots);
  return d.onlyA.length || d.onlyB.length
    ? { ok: false, diff: `só no Swift: [${d.onlyA}] · só no JS: [${d.onlyB}]` }
    : { ok: true, diff: '' };
}

// ── Anchor (d): the position axis — ProjectRole ⇄ ROLE_KINDS (S03) ──────────
//
// S03 introduced `role` as an axis separate from `kind`: where a directory sits
// (workspace / project / folder) rather than what it is. The JS half landed in
// T02 (`ROLE_KINDS`, `REGISTRABLE_ROLES`); the Swift mirror (`ProjectRole`,
// `isRegistrable`) lands in T03 — so the anchor lands here, in the same task
// that completes the constant, as SCOPE #15 requires.
//
// `folder` is the member that makes this worth guarding. It is defined by a
// negative — never registrable, never launchable, never a card — and a negative
// that drifts is silent by construction: a Swift side that quietly started
// accepting `folder` as registrable would put a synthesised display node into
// the registry, and nothing else in either runtime would notice.

/** Body of `public enum ProjectRole … { … }`, comments stripped. */
function projectRoleBody(swiftSrc) {
  const m = swiftSrc.match(/public enum ProjectRole:[^{]*\{([\s\S]*?)\n\}/);
  if (!m) throw new Error('enum ProjectRole não encontrado em ProjectMarker.swift — regex quebrou?');
  return stripLineComments(m[1]);
}

/** The `case` names, harvested line-anchored so prose can never be a case. */
function swiftRoleCases(swiftSrc) {
  const names = [...projectRoleBody(swiftSrc).matchAll(/^\s*case\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/gm)]
    .map(x => x[1]);
  if (names.length < 3) {
    throw new Error(`só ${names.length} casos colhidos de ProjectRole (piso 3) — regex quebrou?`);
  }
  return names;
}

/**
 * The set the Swift predicate *accepts*, derived from the predicate itself:
 * `self != .folder` means "every case except folder". Derived rather than
 * re-listed on purpose — a second hand-written list here would be one more copy
 * to drift, which is the failure this file exists to end.
 */
function swiftRegistrableRoles(swiftSrc) {
  const body = projectRoleBody(swiftSrc);
  const m = body.match(/var isRegistrable: Bool \{ self != \.([A-Za-z_][A-Za-z0-9_]*) \}/);
  if (!m) {
    throw new Error('predicado isRegistrable não encontrado em ProjectRole — o folder pode ter virado registrável');
  }
  return swiftRoleCases(swiftSrc).filter(c => c !== m[1]);
}

function compareRoleKinds(swiftSrc, jsRoles) {
  // Tolerant on the JS side for the same reason as `jsSchemaLiterals`: a
  // comparator that throws instead of reporting cannot serve as the subject of
  // its own mutation self-check.
  const js = Array.isArray(jsRoles) ? jsRoles.filter(v => typeof v === 'string') : [];
  if (js.length < 3) {
    throw new Error(`ROLE_KINDS com só ${js.length} valores (piso 3) — export quebrou?`);
  }
  const d = setDiff(swiftRoleCases(swiftSrc), js);
  return d.onlyA.length || d.onlyB.length
    ? { ok: false, diff: `só no Swift: [${d.onlyA}] · só no JS: [${d.onlyB}]` }
    : { ok: true, diff: '' };
}

function compareRegistrableRoles(swiftSrc, jsRegistrable) {
  const js = Array.isArray(jsRegistrable) ? jsRegistrable.filter(v => typeof v === 'string') : [];
  if (js.length < 2) {
    throw new Error(`REGISTRABLE_ROLES com só ${js.length} valores (piso 2) — export quebrou?`);
  }
  const fromSwift = swiftRegistrableRoles(swiftSrc);
  const parts = [];
  const d = setDiff(fromSwift, js);
  if (d.onlyA.length || d.onlyB.length) {
    parts.push(`só no Swift: [${d.onlyA}] · só no JS: [${d.onlyB}]`);
  }
  // The defining negative, asserted on both sides rather than inferred.
  if (fromSwift.includes('folder')) parts.push('Swift aceita folder como registrável');
  if (js.includes('folder')) parts.push('JS aceita folder como registrável');
  return { ok: parts.length === 0, diff: parts.join(' | ') };
}

console.log('\nParidade dos literais compartilhados do registro (JS ⇄ Swift)');

test('o nome do arquivo do registro é o mesmo dos dois lados', () => {
  const r = compareFilename(registrySwift, REGISTRY_FILENAME);
  assert(r.ok, `filename divergiu — ${r.diff}`);
});

test('a versão do schema é a mesma dos dois lados', () => {
  const r = compareVersion(registrySwift, REGISTRY_VERSION);
  assert(r.ok, `version divergiu — ${r.diff}`);
});

test('as constantes Swift casam com o que migrate() de fato escreve', () => {
  const r = compareSchema(registrySwift, syntheticRegistry());
  assert(r.ok, `schema divergiu — ${r.diff}`);
});

test('os roots-semente da descoberta são os mesmos dos dois lados', () => {
  const r = compareRoots(gitCoreSrc, DISCOVERY_ROOT_NAMES);
  assert(r.ok, `roots divergiram — ${r.diff}`);
});

test('os papéis de posição são os mesmos dos dois lados (ProjectRole ⇄ ROLE_KINDS)', () => {
  const r = compareRoleKinds(swift, ROLE_KINDS);
  assert(r.ok, `papéis divergiram — ${r.diff}`);
});

test('o conjunto registrável derivado do predicado Swift bate com REGISTRABLE_ROLES', () => {
  const r = compareRegistrableRoles(swift, REGISTRABLE_ROLES);
  assert(r.ok, `registráveis divergiram — ${r.diff}`);
});

console.log('\nAuto-verificação de mutação — cada comparador é visto falhando');

// The point of this block: a comparator that cannot be made to fail is
// verde-inerte, and indistinguishable from one that holds. Each anchor is
// mutated in memory from BOTH sides on every run, so "já foi visto falhar"
// stays an executable property instead of an anecdote in a summary.

test('filename: mutar o Swift derruba o comparador', () => {
  const mutated = registrySwift.replace(
    /public static let filename = "[^"]+"/,
    'public static let filename = "forge-gate-workspaces2.json"');
  assert(mutated !== registrySwift, 'a mutação não entrou na string — prova inválida');
  assert(compareFilename(mutated, REGISTRY_FILENAME).ok === false, 'comparador não mordeu');
});

test('filename: mutar o JS derruba o comparador', () => {
  assert(compareFilename(registrySwift, REGISTRY_FILENAME + '.bak').ok === false,
         'comparador não mordeu');
});

test('version: mutar qualquer um dos lados derruba o comparador', () => {
  const mutated = registrySwift.replace(/public static let version = \d+/,
                                        'public static let version = 99');
  assert(mutated !== registrySwift, 'a mutação não entrou na string — prova inválida');
  assert(compareVersion(mutated, REGISTRY_VERSION).ok === false, 'comparador não mordeu (Swift)');
  assert(compareVersion(registrySwift, REGISTRY_VERSION + 1).ok === false,
         'comparador não mordeu (JS)');
});

test('schema: mutar o Swift derruba o comparador', () => {
  const mutated = registrySwift.replace(/public static let kindWorkspace = "[^"]+"/,
                                        'public static let kindWorkspace = "wkspc"');
  assert(mutated !== registrySwift, 'a mutação não entrou na string — prova inválida');
  assert(compareSchema(mutated, syntheticRegistry()).ok === false, 'comparador não mordeu');
});

test('schema: mutar a saída do JS derruba o comparador', () => {
  // Um writer que renomeasse `kind` para `type` nos registros: o schema segue
  // com 9 chaves (o piso não mascara nada), mas a chave divergiu.
  const reg = syntheticRegistry();
  const mutated = {
    ...reg,
    entries: reg.entries.map(e => {
      const { kind, ...rest } = e;
      return { ...rest, type: kind };
    }),
  };
  assert(!('kind' in mutated.entries[0]) && mutated.entries[0].type,
         'a mutação não entrou no objeto — prova inválida');
  assert(compareSchema(registrySwift, mutated).ok === false, 'comparador não mordeu');
});

test('roots: mutar o Swift derruba o comparador', () => {
  // Injeta um nome inexistente em vez de remover um existente: a mutação
  // precisa valer independentemente do conteúdo das duas listas. Remover
  // "Desktop" vira no-op se alguém já o tiver tirado — e um self-check que
  // silenciosamente não muda nada é a própria falha verde-inerte.
  const mutated = gitCoreSrc.replace(/public static let roots = \[/,
                                     'public static let roots = ["ZZNaoExiste", ');
  assert(mutated !== gitCoreSrc, 'a mutação não entrou na string — prova inválida');
  assert(compareRoots(mutated, DISCOVERY_ROOT_NAMES).ok === false, 'comparador não mordeu');
});

test('roots: mutar o JS derruba o comparador', () => {
  assert(compareRoots(gitCoreSrc, [...DISCOVERY_ROOT_NAMES, 'Extra']).ok === false,
         'comparador não mordeu');
});

// Mutação ADITIVA, nunca subtrativa — a lição que S02 mediu e S03 herda:
// remover um elemento que já pode estar ausente por outro motivo vira no-op, o
// self-check passa sem ter provado nada, e a guarda fica verde-inerte. Isso é
// exatamente o defeito que o critério #15 existe para impedir. `ghost` é um
// sentinela que não pode já estar presente, e injetá-lo só faz o conjunto
// crescer — nenhum piso de tamanho pode ser quem produz a falha.

test('papéis: injetar um case só no Swift derruba o comparador', () => {
  const mutated = swift.replace(/(public enum ProjectRole:[^{]*\{\n)/,
                                '$1    case ghost\n');
  assert(mutated !== swift, 'a mutação não entrou na string — prova inválida');
  assert(swiftRoleCases(mutated).includes('ghost'), 'a mutação não foi colhida — prova inválida');
  assert(compareRoleKinds(mutated, ROLE_KINDS).ok === false, 'comparador não mordeu (Swift)');
  assert(compareRegistrableRoles(mutated, REGISTRABLE_ROLES).ok === false,
         'o predicado derivado não mordeu (Swift)');
});

test('papéis: injetar um valor só no JS derruba o comparador', () => {
  assert(compareRoleKinds(swift, [...ROLE_KINDS, 'ghost']).ok === false,
         'comparador não mordeu (JS)');
  assert(compareRegistrableRoles(swift, [...REGISTRABLE_ROLES, 'ghost']).ok === false,
         'o predicado derivado não mordeu (JS)');
});

test('registrável: folder virar registrável de qualquer um dos lados derruba', () => {
  // O caso que motiva a âncora: um nó de display sintetizado entrando no
  // registro. Do lado Swift a mutação troca o predicado; do lado JS, acrescenta
  // folder à lista. Ambas aditivas em conjunto.
  const mutated = swift.replace(/self != \.folder/, 'self != .ZZNaoExiste');
  assert(mutated !== swift, 'a mutação não entrou na string — prova inválida');
  assert(swiftRegistrableRoles(mutated).includes('folder'),
         'a mutação não mudou o conjunto derivado — prova inválida');
  assert(compareRegistrableRoles(mutated, REGISTRABLE_ROLES).ok === false,
         'comparador não mordeu (Swift)');
  assert(compareRegistrableRoles(swift, [...REGISTRABLE_ROLES, 'folder']).ok === false,
         'comparador não mordeu (JS)');
});

// ───────────────────────────────────────────────────────────────────────────
// Anchor (e): which branch is the DEFAULT — `main` or `master`
//
// Now implemented twice, for the same reason as the marker: two runtimes need
// it. `gitDefaultBranch()` in `scripts/forge-isolation.js` is load-bearing —
// `setupWorktreeOne` branches from `origin/<def>`, and the last milestone paid
// for getting that name wrong with a worktree 13 commits behind. `GitDefaultBranch`
// in `app/Sources/ForgeKit/GitCore.swift` is what the Projects card draws.
//
// Drift here is silent in the worst way: both sides keep answering, they just
// answer differently, and the card confidently reports divergence against a
// branch the isolation machinery does not consider the default.
//
// Unlike the anchors above, the JS half is EXECUTABLE (it is exported), so the
// precedence is pinned by running it against real repositories in a temp dir
// rather than by reading its source. The Swift half is pinned by its literals —
// and by ONE deliberate difference that must never be "fixed" into agreement.
// ───────────────────────────────────────────────────────────────────────────

const os = require('os');
const { execFileSync } = require('child_process');
const { gitDefaultBranch } = require('./forge-isolation.js');

const gitCoreForDefault = fs.readFileSync(gitCoreSwift, 'utf8');

/** Ordered fallback names from `GitDefaultBranch.candidates`. */
function swiftDefaultCandidates(swiftSrc) {
  const m = swiftSrc.match(/public static let candidates = \[([\s\S]*?)\]/);
  if (!m) throw new Error('GitDefaultBranch.candidates não encontrado em GitCore.swift — regex quebrou?');
  const names = [...stripLineComments(m[1]).matchAll(/"([^"]+)"/g)].map(x => x[1]);
  if (names.length < 2) {
    throw new Error(`só ${names.length} candidatos colhidos (piso 2) — regex quebrou?`);
  }
  return names;
}

/** The same ordered names as spelled in `gitDefaultBranch()`'s own source. */
function jsDefaultCandidates() {
  const src = fs.readFileSync(path.join(repoRoot, 'scripts/forge-isolation.js'), 'utf8');
  const i = src.indexOf('function gitDefaultBranch(');
  if (i < 0) throw new Error('gitDefaultBranch() sumiu de forge-isolation.js');
  const body = stripLineComments(src.slice(i, src.indexOf('\n}', i)));
  const m = body.match(/for \(const b of \[([^\]]+)\]\)/);
  if (!m) throw new Error('a lista de fallback de gitDefaultBranch() não foi colhida — regex quebrou?');
  return [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(x => x[1] || x[2]);
}

function compareDefaultCandidates(swiftSrc, jsNames) {
  const a = swiftDefaultCandidates(swiftSrc);
  if (jsNames.length < 2) throw new Error(`JS com só ${jsNames.length} candidatos (piso 2)`);
  // ORDER matters here, unlike the set-comparisons above: `["master","main"]`
  // is the same set and a different answer for every repo that has both.
  return a.join(',') === jsNames.join(',')
    ? { ok: true, diff: '' }
    : { ok: false, diff: `Swift [${a}] ≠ JS [${jsNames}]` };
}

/** Throwaway repo in tmp. Never touches the operator's repos. */
function tmpRepo(tag, init) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-gitdef-${tag}-`));
  // `git` resolvido pelo PATH, nunca um caminho POSIX absoluto: `/usr/bin/git`
  // não existe no Windows e derrubava esta suíte inteira com ENOENT no CI.
  const git = (...args) => execFileSync('git', ['-C', dir, ...args],
                                        { stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', init, dir], { stdio: 'ignore' });
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  git('add', 'a.txt'); git('commit', '-qm', 'x');
  return { dir, git };
}

console.log('\nQual branch é a padrão — main ou master (âncora e)');

test('a ordem de fallback é a mesma dos dois lados', () => {
  const r = compareDefaultCandidates(gitCoreForDefault, jsDefaultCandidates());
  assert(r.ok, `candidatos divergiram — ${r.diff}`);
});

test('a precedência do JS é a que o Swift documenta: origin/HEAD antes de main/master', () => {
  // Executável, não lido: se alguém reordenar gitDefaultBranch() para preferir
  // um `main` local ao que o remoto declara, a máquina de isolamento passa a
  // ramificar de outra base e o card passa a comparar contra outra branch.
  const { dir, git } = tmpRepo('prec', 'master');
  try {
    // Sem origin nenhum: cai no primeiro candidato que EXISTE (master, aqui).
    assert(gitDefaultBranch(dir) === 'master',
           `sem origin, esperava master, veio ${gitDefaultBranch(dir)}`);

    // Com origin/HEAD apontando para develop, e um `main` local presente: o
    // remoto ganha dos dois.
    git('branch', 'main');
    git('branch', 'develop');
    git('remote', 'add', 'origin', dir);
    git('update-ref', 'refs/remotes/origin/develop', 'refs/heads/develop');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    assert(gitDefaultBranch(dir) === 'develop',
           `origin/HEAD perdeu para o fallback: veio ${gitDefaultBranch(dir)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('o palpite final do JS é REAL, e o Swift deliberadamente NÃO o copia', () => {
  // A única diferença intencional entre os dois. O JS termina em `return
  // 'main'` porque um script que precisa dar checkout precisa de um nome de
  // qualquer jeito; um card não pode adivinhar, porque imprimir "main" para um
  // repo sem main é a afirmação falsa confiante que esta tela já teve uma vez.
  //
  // Pinado dos DOIS lados para que ninguém "conserte" a divergência: se o JS
  // parar de palpitar, esta primeira asserção cai e a decisão volta à mesa.
  const { dir } = tmpRepo('trunk', 'trunk');
  try {
    assert(gitDefaultBranch(dir) === 'main',
           `o palpite final do JS mudou (veio ${gitDefaultBranch(dir)}) — reavaliar a diferença`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // E o Swift não tem esse palpite: `resolve` devolve `String?`.
  const i = gitCoreForDefault.indexOf('public static func resolve(repoPath:');
  assert(i >= 0, 'GitDefaultBranch.resolve não encontrado — regex quebrou?');
  const body = stripLineComments(gitCoreForDefault.slice(i, gitCoreForDefault.indexOf('\n    }', i)));
  assert(/-> String\?/.test(body), 'resolve() deixou de ser opcional — o palpite voltou');
  assert(!/return "(main|master)"/.test(body),
         'resolve() passou a devolver um nome fixo — o card voltou a adivinhar');
});

test('candidatos: mutar qualquer um dos lados derruba o comparador', () => {
  // Aditiva de um lado, reordenação do outro — as duas formas reais de drift.
  const mutated = gitCoreForDefault.replace(/public static let candidates = \[/,
                                            'public static let candidates = ["trunk", ');
  assert(mutated !== gitCoreForDefault, 'a mutação não entrou na string — prova inválida');
  assert(swiftDefaultCandidates(mutated).includes('trunk'), 'mutação não colhida — prova inválida');
  assert(compareDefaultCandidates(mutated, jsDefaultCandidates()).ok === false,
         'comparador não mordeu (Swift)');
  const js = jsDefaultCandidates();
  assert(compareDefaultCandidates(gitCoreForDefault, [...js].reverse()).ok === false,
         'comparador não mordeu a INVERSÃO — a ordem não estava sendo comparada');
});

console.log('\nPinos anti-regressão (S02)');

test('add/remove escrevem sobre loadAllResolved(), nunca sobre load()', () => {
  // RISK blocker 1: `load()` is the fileExists-filtered view. Building a save
  // on it drops every entry whose directory is momentarily unreachable —
  // an unmounted volume would silently delete the operator's registry.
  const src = fs.readFileSync(storesSwiftPath, 'utf8');
  const lines = stripLineComments(src).split('\n')
    .filter(l => /static func (add|remove)\(/.test(l));
  assert(lines.length === 2,
         `esperava as definições de add/remove em Stores.swift, achei ${lines.length} — regex quebrou?`);
  for (const l of lines) {
    assert(/loadAllResolved\(\)/.test(l), `perdeu loadAllResolved(): ${l.trim()}`);
    assert(!/(?<!AllResolved)\bload\(\)/.test(l.replace(/loadAllResolved\(\)/g, '')),
           `voltou a usar load() filtrado: ${l.trim()}`);
  }
});

test('scan() consulta os roots declarados no registro', () => {
  // S02's own wiring: discovery walks what the registry declares. The
  // hardcoded name list is a seed default, not the scan source.
  const src = fs.readFileSync(projectsSwiftPath, 'utf8');
  const i = src.indexOf('private func scan()');
  assert(i >= 0, 'scan() não encontrado em Projects.swift — regex quebrou?');
  const body = src.slice(i, i + 1200);
  assert(/declaredRoots/.test(body),
         'scan() não consulta mais declaredRoots — a varredura voltou à lista fixa');
  assert(/ProjectDiscovery\.scan\(declaredRoots:/.test(body),
         'scan() não chama mais ProjectDiscovery.scan(declaredRoots:)');
});

test('Projects.swift desenha ProjectTree.build, não ProjectOrganiser.groups', () => {
  // T04's own wiring: the byFolder mode renders the transitive tree T03 built,
  // not the flat immediate-parent grouping it replaces. A regression here
  // would silently put `lookchina`, `apps/` and `services/` back as three
  // unrelated headers with no line connecting them.
  const src = fs.readFileSync(projectsSwiftPath, 'utf8');
  assert(/ProjectTree\.build\(/.test(src),
         'Projects.swift não chama mais ProjectTree.build( — a fiação da árvore sumiu');
  assert(!/ProjectOrganiser\.groups\(/.test(src),
         'Projects.swift ainda chama ProjectOrganiser.groups( — a árvore transitiva foi ' +
         'substituída de volta pelo agrupamento por pai imediato');
});

test('a decisão card-ou-pasta é o role do nó, nunca uma heurística de caminho', () => {
  // The whole point of `ProjectRole.folder`: whether a node draws a
  // `ProjectCard` has to read `node.role.isRegistrable`, not a string check
  // like `path.contains("/apps")`. If that symbol disappears from the tree
  // row, the guard silently regresses to the fragile heuristic T04 exists to
  // remove.
  const src = fs.readFileSync(projectsSwiftPath, 'utf8');
  const i = src.indexOf('struct ProjectTreeRow');
  assert(i >= 0, 'ProjectTreeRow não encontrado em Projects.swift — regex quebrou?');
  const body = src.slice(i, i + 3000);
  assert(/role\.isRegistrable/.test(body),
         'ProjectTreeRow não consulta mais role.isRegistrable — a decisão card/pasta ' +
         'pode ter voltado a ser uma heurística de caminho');
  assert(!/path\.contains\(/.test(body),
         'ProjectTreeRow contém path.contains( — sinal de heurística de caminho no lugar ' +
         'da checagem de role');
});

// ───────────────────────────────────────────────────────────────────────────
// S05 · Anchor (e) — JS-only containment guard (SCOPE #15, permanent)
//
// S05's on-disk marker (`forge-workspace.jsonc`/`forge-root.jsonc`, T03) is a
// JS-only fallback (D3): CI, a container, a fresh machine — contexts the app
// GUI never runs in, because the app already reads the authoritative
// registry. SCOPE #15's permanent parity obligation is discharged here by
// CONTAINMENT, not by a second Swift copy of the marker literals: this
// anchor scans every `.swift` file under `app/Sources/ForgeKit/` for the two
// marker filenames and FAILS the moment either one appears there.
//
// If this guard ever goes red because the app legitimately starts reading
// markers: add a real parity anchor in THIS SAME TASK — a green guard that
// does not cover the new constant is a defect, not coverage.
// ───────────────────────────────────────────────────────────────────────────

const { MARKER_FILENAMES } = require('./forge-marker.js');

const forgeKitDir = path.join(repoRoot, 'app/Sources/ForgeKit');

/** Every `.swift` file under `dir` (recursive) that mentions a marker literal. */
function scanForMarkerLiterals(dir) {
  const offenders = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return offenders; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { offenders.push(...scanForMarkerLiterals(full)); continue; }
    if (!ent.name.endsWith('.swift')) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const literal of MARKER_FILENAMES) {
      if (text.includes(literal)) offenders.push(`${full}: "${literal}"`);
    }
  }
  return offenders;
}

console.log('\nContenção JS-only do marcador (SCOPE #15, S05)');

test('nenhum arquivo Swift sob ForgeKit menciona os literais do marcador', () => {
  assert(MARKER_FILENAMES.length >= 2, `MARKER_FILENAMES suspeitosamente curto (${MARKER_FILENAMES.length})`);
  const offenders = scanForMarkerLiterals(forgeKitDir);
  assert(offenders.length === 0,
    'literal(s) do marcador JS-only apareceram em Swift — se o app passar a ler marcadores, ' +
    'acrescente uma âncora de paridade NESTA MESMA TASK; um guard verde que não cobre a ' +
    'constante nova é defeito, não cobertura:\n    ' + offenders.join('\n    '));
});

test('mordida ADITIVA — inserir o literal num .swift temporário torna o guard vermelho', () => {
  // Deliberately additive, never subtractive: S02 lost a real diagnosis to a
  // removal-based self-check that could no-op silently when the element it
  // removed was already absent for an unrelated reason. Injecting a literal
  // that provably was NOT there before is the only mutation that proves this
  // scanner actually looks, rather than merely returning an empty list.
  const before = scanForMarkerLiterals(forgeKitDir);
  assert(before.length === 0, 'pré-condição: o guard já deveria estar limpo antes da mordida');

  const tmpSwift = path.join(forgeKitDir, `__T06MutationProbe_${process.pid}.swift`);
  assert(!fs.existsSync(tmpSwift), 'arquivo de mutação já existia — prova inválida');
  try {
    fs.writeFileSync(tmpSwift,
      `// probe — must never survive this test run\nlet probe = "${MARKER_FILENAMES[0]}"\n`, 'utf8');
    const after = scanForMarkerLiterals(forgeKitDir);
    assert(after.length === 1 && after[0].includes(MARKER_FILENAMES[0]),
      `a mordida aditiva não derrubou o guard — prova inválida (got ${JSON.stringify(after)})`);
  } finally {
    fs.rmSync(tmpSwift, { force: true });
  }
  const afterCleanup = scanForMarkerLiterals(forgeKitDir);
  assert(afterCleanup.length === 0, 'o arquivo de mutação temporário não foi removido no finally');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
