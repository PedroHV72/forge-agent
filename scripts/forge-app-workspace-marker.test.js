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

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
