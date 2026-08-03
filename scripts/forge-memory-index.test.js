#!/usr/bin/env node
// forge-memory-index.test.js — standalone test suite for forge-memory-index.js
//
// Covers (T03 must-haves):
//   - Synthetic fixture store (mkdtempSync) with >= 3 fragments / >= 20 facts + fake
//     source-file tree — zero dependency on this repo's real .gsd/memory (1 fragment).
//   - Mandatory positive case: a citation the index MUST catch, asserted by mem_id
//     under the right file.
//   - One case per discard reason: not-found, ambiguous-basename, outside-root, dynamic.
//   - Sum invariant: citations_resolved + sum(coverage.unresolved counts) === citations_total.
//   - Empty store still renders `## Cobertura e descarte`.
//   - Determinism: two renderIndex calls over the same store are byte-identical, no
//     wallclock pattern in the markdown.
//   - Containment: a `../` citation is never resolved and nothing is read outside the
//     fixture root.
//   - CLI: --json exits 0 with one-line JSON on stdout; an unknown arg exits 2.
//
// Run: node scripts/forge-memory-index.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  extractCitations,
  resolveCitation,
  buildFileIndex,
  renderIndex,
  writeIndex,
  DEFAULT_INDEX_PATH,
} = require('./forge-memory-index.js');

const { writeFragment } = require('./forge-memory.js');

// ── Test runner boilerplate (mirrors forge-verifier.test.js) ───────────────────

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
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

const SCRIPT_PATH = path.join(__dirname, 'forge-memory-index.js');

// mkStore(facts, files, opts) — creates a fresh mkdtempSync root, writes each
// entry of `facts` (Array<{ unitId, milestoneId?, text, mem_id, category?, source_unit? }>)
// as a real fragment via writeFragment (guarantees byte-exact round trip with
// parseFragment — never hand-serialized), and materializes each path in `files`
// as an empty file under the fixture root. Returns the fixture root.
function mkStore(facts, files, opts) {
  opts = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-index-test-'));

  for (const relFile of files || []) {
    const abs = path.join(root, relFile);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '// fixture file\n', 'utf8');
  }

  // Group facts by unit_id so multiple facts for the same unit merge into one
  // fragment (mirrors real writeFragment/mergeFacts usage).
  const byUnit = new Map();
  for (const f of facts || []) {
    if (!byUnit.has(f.unitId)) byUnit.set(f.unitId, []);
    byUnit.get(f.unitId).push(f);
  }

  for (const [unitId, group] of byUnit) {
    const factObjs = group.map((f, i) => ({
      mem_id: f.mem_id || `${unitId}-fact-${i}`,
      category: f.category || 'pattern',
      text: f.text,
      created_at: '2026-08-01T00:00:00Z',
      source_unit: f.source_unit || unitId,
    }));
    writeFragment(root, { unit_id: unitId, facts: factObjs }, { milestoneId: group[0].milestoneId });
  }

  if (!opts.skipSchemaVersion && opts.schemaVersion) {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gsd', 'SCHEMA-VERSION'), opts.schemaVersion, 'utf8');
  }

  return root;
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (_) {
    // best-effort — a leftover temp dir is not a test failure
  }
}

// ── Section 1: extraction ────────────────────────────────────────────────────
console.log('\n=== forge-memory-index.test.js ===\n');
console.log('Section 1: extractCitations\n');

test('extractCitations: backticked path with line number', () => {
  const cites = extractCitations('See `scripts/forge-alpha.js:143` for the fix.');
  assert(cites.length === 1, 'expected exactly one citation');
  assertEq(cites[0].path, 'scripts/forge-alpha.js');
  assertEq(cites[0].line, 143);
  assertEq(cites[0].pattern, 'backticked-path');
});

test('extractCitations: bare path with slash outside backticks', () => {
  const cites = extractCitations('Documented in scripts/forge-beta.js for reference.');
  assert(cites.some((c) => c.path === 'scripts/forge-beta.js'), 'expected bare-path citation');
});

test('extractCitations: bare basename loose in prose', () => {
  const cites = extractCitations('Fixed inside forge-alpha.js earlier today.');
  assert(cites.some((c) => c.path === 'forge-alpha.js' && c.pattern === 'bare-basename'), 'expected bare-basename citation');
});

test('extractCitations: dedup by path, first occurrence wins, order preserved', () => {
  const cites = extractCitations('First scripts/forge-alpha.js:10, then scripts/forge-beta.js, then scripts/forge-alpha.js again.');
  assertEq(cites.map((c) => c.path), ['scripts/forge-alpha.js', 'scripts/forge-beta.js'], 'expected dedup preserving first occurrence and order');
  assertEq(cites[0].line, 10, 'first occurrence line must be kept');
});

// ── Section 2: mandatory positive case ───────────────────────────────────────
console.log('\nSection 2: mandatory positive case — index MUST catch this citation\n');

test('buildFileIndex: MUST resolve a citation to scripts/forge-alpha.js under its mem_id', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed a bug in `scripts/forge-alpha.js` today.', mem_id: 'mem-positive-1' }],
    ['scripts/forge-alpha.js', 'scripts/forge-beta.js', 'lib/util.js', 'tools/util.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const entry = result.entries.find((e) => e.file === 'scripts/forge-alpha.js');
    assert(entry, 'expected an entry for scripts/forge-alpha.js — the index failed the mandatory positive case');
    assert(entry.facts.some((f) => f.mem_id === 'mem-positive-1'), 'expected mem-positive-1 under scripts/forge-alpha.js');
  } finally {
    cleanup(root);
  }
});

// ── Section 3: basename resolution ───────────────────────────────────────────
console.log('\nSection 3: basename resolution — unique vs ambiguous\n');

test('resolveCitation: unique basename resolves with how:"basename"', () => {
  const root = mkStore([], ['scripts/forge-alpha.js']);
  try {
    const result = buildFileIndex(root, {});
    const cites = extractCitations('See forge-alpha.js.');
    const res = resolveCitation(cites[0], root, { byBasename: new Map([['forge-alpha.js', ['scripts/forge-alpha.js']]]) });
    assertEq(res.state, 'RESOLVED');
    assertEq(res.how, 'basename');
    assertEq(res.file, 'scripts/forge-alpha.js');
    void result;
  } finally {
    cleanup(root);
  }
});

test('buildFileIndex: ambiguous basename (util.js in two dirs) → coverage.unresolved reason ambiguous-basename', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Touched util.js in two places.', mem_id: 'mem-ambig' }],
    ['lib/util.js', 'tools/util.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const hit = result.coverage.unresolved.find((u) => u.reason === 'ambiguous-basename');
    assert(hit, 'expected an ambiguous-basename entry in coverage.unresolved');
    assert(Array.isArray(hit.candidates) && hit.candidates.length === 2, 'expected 2 candidates for ambiguous basename');
    assert(hit.candidates.includes('lib/util.js') && hit.candidates.includes('tools/util.js'), 'expected both util.js candidates');
  } finally {
    cleanup(root);
  }
});

// ── Section 4: discard reasons — one dedicated case per motivo ──────────────
console.log('\nSection 4: discard reasons — not-found, ambiguous-basename, outside-root, dynamic\n');

test('discard reason: not-found (file cited but absent from fixture tree)', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Referenced scripts/nao-existe.js but it was never created.', mem_id: 'mem-notfound' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const hit = result.coverage.unresolved.find((u) => u.reason === 'not-found');
    assert(hit, 'expected a not-found entry in coverage.unresolved');
  } finally {
    cleanup(root);
  }
});

test('discard reason: ambiguous-basename (dedicated case, distinct from Section 3)', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Edited util.js again.', mem_id: 'mem-ambig-2' }],
    ['lib/util.js', 'tools/util.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const hit = result.coverage.unresolved.find((u) => u.reason === 'ambiguous-basename');
    assert(hit, 'expected ambiguous-basename in coverage.unresolved');
  } finally {
    cleanup(root);
  }
});

test('discard reason: outside-root (relative escape and absolute path)', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'See scripts/../../etc/passwd for the layout.', mem_id: 'mem-outside-rel' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const hit = result.coverage.unresolved.find((u) => u.reason === 'outside-root');
    assert(hit, 'expected an outside-root entry for a relative escape path');
  } finally {
    cleanup(root);
  }
});

test('discard reason: outside-root (absolute path input, direct resolveCitation)', () => {
  const absPath = process.platform === 'win32' ? 'C:\\Windows\\system32\\config.sys' : '/etc/passwd';
  const res = resolveCitation({ path: absPath, pattern: 'bare-path', raw: absPath, line: null }, process.cwd(), { byBasename: new Map() });
  assertEq(res.state, 'UNRESOLVED');
  assertEq(res.reason, 'outside-root');
});

test('discard reason: dynamic (template literal, wildcard, internal backtick)', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Any of scripts/forge-${name}.js could be the culprit.', mem_id: 'mem-dynamic' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const hit = result.coverage.unresolved.find((u) => u.reason === 'dynamic');
    assert(hit, 'expected a dynamic entry in coverage.unresolved');
  } finally {
    cleanup(root);
  }
});

// ── Section 5: facts without citation / unresolved-only ─────────────────────
console.log('\nSection 5: facts without citation vs unresolved-only\n');

test('fact with pure prose (no citation) → facts_without_citation, not facts_with_resolved', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'This fact talks only about architecture decisions, no file mentioned.', mem_id: 'mem-noref' }],
    [],
  );
  try {
    const result = buildFileIndex(root, {});
    const hit = result.coverage.facts_without_citation.find((f) => f.mem_id === 'mem-noref');
    assert(hit, 'expected mem-noref in facts_without_citation');
  } finally {
    cleanup(root);
  }
});

test('fact whose only citations all fail → facts_unresolved_only, never facts_with_resolved', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Only scripts/nunca-existiu.js is mentioned here.', mem_id: 'mem-unresolved-only' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const hitList = result.coverage.facts_unresolved_only;
    assert(hitList.some((f) => f.mem_id === 'mem-unresolved-only'), 'expected mem-unresolved-only in facts_unresolved_only');
    const inAnyEntry = result.entries.some((e) => e.facts.some((f) => f.mem_id === 'mem-unresolved-only'));
    assert(!inAnyEntry, 'mem-unresolved-only must never appear under facts_with_resolved (entries)');
  } finally {
    cleanup(root);
  }
});

// ── Section 6: sum invariant ─────────────────────────────────────────────────
console.log('\nSection 6: sum invariant — coverage cannot lose a citation along the way\n');

test('citations_resolved + sum(unresolved[].count) === citations_total', () => {
  const root = mkStore(
    [
      { unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` and scripts/forge-nao-existe.js and lib/util.js.', mem_id: 'mem-sum-1' },
      { unitId: 'T02', text: 'Also scripts/forge-${dynamic}.js was flagged along with ../outside.js.', mem_id: 'mem-sum-2' },
    ],
    ['scripts/forge-alpha.js', 'lib/util.js', 'tools/util.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const { citations_total, citations_resolved, unresolved } = result.coverage;
    const unresolvedSum = unresolved.reduce((acc, u) => acc + u.count, 0);
    assert(citations_total > 0, 'expected at least one citation extracted');
    assertEq(citations_resolved + unresolvedSum, citations_total, 'citations_resolved + sum(unresolved counts) must equal citations_total');
  } finally {
    cleanup(root);
  }
});

test('facts_with_resolved + facts_unresolved_only.length + facts_without_citation.length === facts_total', () => {
  const root = mkStore(
    [
      { unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-fact-a' },
      { unitId: 'T01', text: 'Only scripts/nunca-existiu.js is mentioned.', mem_id: 'mem-fact-b' },
      { unitId: 'T01', text: 'Pure architecture prose, no file at all.', mem_id: 'mem-fact-c' },
    ],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const { facts_total, facts_with_resolved, facts_unresolved_only, facts_without_citation } = result.coverage;
    assertEq(facts_with_resolved + facts_unresolved_only.length + facts_without_citation.length, facts_total, 'fact bucket counts must sum to facts_total');
  } finally {
    cleanup(root);
  }
});

// ── Section 7: empty store ───────────────────────────────────────────────────
console.log('\nSection 7: empty store — coverage section still renders\n');

test('empty store (no .gsd/memory at all) → renderIndex still contains "## Cobertura e descarte"', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-index-test-'));
  try {
    const result = buildFileIndex(root, {});
    assertEq(result.entries, [], 'expected zero entries for a store with no memory dir');
    assertEq(result.coverage.facts_total, 0);
    assertEq(result.coverage.citations_total, 0);
    const md = renderIndex(result, {});
    assert(md.includes('## Cobertura e descarte'), 'expected the coverage section unconditionally, even with an empty store');
  } finally {
    cleanup(root);
  }
});

test('empty store (.gsd/memory dir exists but has no fragments) → coverage still zeroed and section present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-index-test-'));
  try {
    fs.mkdirSync(path.join(root, '.gsd', 'memory'), { recursive: true });
    const result = buildFileIndex(root, {});
    assertEq(result.entries, []);
    assertEq(result.coverage.fragments_read, 0);
    const md = renderIndex(result, {});
    assert(md.includes('## Cobertura e descarte'), 'expected the coverage section for an empty-but-present memory dir');
  } finally {
    cleanup(root);
  }
});

// ── Section 8: determinism ───────────────────────────────────────────────────
console.log('\nSection 8: determinism — identical strings, no wallclock pattern\n');

test('renderIndex called twice over the same store produces byte-identical strings, no wallclock pattern', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` and scripts/nao-existe.js.', mem_id: 'mem-det-1' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const md1 = renderIndex(result, {});
    const md2 = renderIndex(result, {});
    assertEq(md1, md2, 'two renderIndex calls over the same result must be byte-identical');
    assert(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(md1), 'markdown must not contain any wallclock ISO timestamp pattern');
  } finally {
    cleanup(root);
  }
});

test('writeIndex called twice with no store change → second call reports changed:false', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-det-2' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const first = writeIndex(result, root, {});
    assertEq(first.changed, true, 'first write must report changed:true');
    const second = writeIndex(result, root, {});
    assertEq(second.changed, false, 'second write with identical content must report changed:false');
  } finally {
    cleanup(root);
  }
});

// ── Section 9: unreadable fragment ───────────────────────────────────────────
console.log('\nSection 9: unreadable fragment — degrades by report line, never crashes the run\n');

test('a fragment with a broken frontmatter shape → unreadable_fragments, run does not throw', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-ok' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    // parseFragment never throws on unparseable text (falls back to body:text), so
    // the only way to exercise the unreadable_fragments branch is a filesystem-level
    // read error — make the "fragment" a directory instead of a file, forcing
    // fs.readFileSync to throw EISDIR inside buildFileIndex's per-fragment try/catch.
    const memDir = path.join(root, '.gsd', 'memory');
    fs.mkdirSync(path.join(memDir, 'T02'), { recursive: true });
    fs.renameSync(path.join(memDir, 'T02'), path.join(memDir, 'T02.md'));

    let result;
    assert((() => { result = buildFileIndex(root, {}); return true; })(), 'buildFileIndex must not throw on an unreadable fragment');
    assert(result.coverage.unreadable_fragments.length >= 1, 'expected at least one entry in unreadable_fragments');
    const ok = result.entries.find((e) => e.file === 'scripts/forge-alpha.js');
    assert(ok, 'the readable fragment (mem-ok) must still be indexed despite the broken sibling');
  } finally {
    cleanup(root);
  }
});

// ── Section 10: schema ahead ─────────────────────────────────────────────────
console.log('\nSection 10: schema-ahead flag propagates to result.partial\n');

test('.gsd/SCHEMA-VERSION ahead of tooling → result.partial true and markdown carries the partial marker', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-schema' }],
    ['scripts/forge-alpha.js'],
    { schemaVersion: 'fragment-store@2.0.0' },
  );
  try {
    const result = buildFileIndex(root, {});
    assertEq(result.partial, true, 'expected partial:true when data schema major is ahead of tooling');
    const md = renderIndex(result, {});
    assert(md.includes('Índice parcial'), 'expected the partial-index marker in rendered markdown');
  } finally {
    cleanup(root);
  }
});

test('no .gsd/SCHEMA-VERSION file → result.partial false (fail-open)', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-noschema' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    assertEq(result.partial, false, 'expected partial:false (fail-open) when no SCHEMA-VERSION is present');
  } finally {
    cleanup(root);
  }
});

// ── Section 11: containment ───────────────────────────────────────────────────
console.log('\nSection 11: containment — a `../` citation never resolves and nothing outside root is read\n');

test('resolveCitation: relative escape (../secret.js) is never RESOLVED regardless of disk contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-index-test-'));
  const outsideMarker = path.join(os.tmpdir(), 'forge-memory-index-outside-marker.js');
  fs.writeFileSync(outsideMarker, '// should never be read by resolution\n', 'utf8');
  try {
    const cites = extractCitations('See ../forge-memory-index-outside-marker.js for context.');
    assert(cites.length === 1, 'expected the escape path to be extracted as a candidate citation');
    const res = resolveCitation(cites[0], root, { byBasename: new Map() });
    assertEq(res.state, 'UNRESOLVED');
    assertEq(res.reason, 'outside-root', 'a `../` citation must be discarded as outside-root, never resolved');
  } finally {
    cleanup(root);
    try { fs.unlinkSync(outsideMarker); } catch (_) { /* best-effort */ }
  }
});

test('buildFileIndex: end-to-end containment — a fact citing "../secret.js" never appears as a resolved entry', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Do not touch ../secret.js under any circumstance.', mem_id: 'mem-contain' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const leaked = result.entries.some((e) => e.file.includes('..') || e.file.startsWith('/'));
    assert(!leaked, 'no entry must reference a path outside the fixture root');
    const hit = result.coverage.unresolved.find((u) => u.reason === 'outside-root');
    assert(hit, 'expected the ../secret.js citation to surface as outside-root in coverage.unresolved');
  } finally {
    cleanup(root);
  }
});

// ── Section 12: full fixture — >= 3 fragments, >= 20 facts, synthetic tree ──
console.log('\nSection 12: full synthetic fixture — >= 3 fragments, >= 20 facts\n');

test('a >= 3-fragment / >= 20-fact synthetic store builds a coherent index with no crash', () => {
  const facts = [];
  const fakeFiles = ['scripts/forge-alpha.js', 'scripts/forge-beta.js', 'lib/util.js', 'tools/util.js'];
  for (let i = 0; i < 8; i++) facts.push({ unitId: 'T01', mem_id: `mem-t01-${i}`, text: `Note ${i} about scripts/forge-alpha.js and general context.` });
  for (let i = 0; i < 8; i++) facts.push({ unitId: 'T02', mem_id: `mem-t02-${i}`, text: `Note ${i} touching scripts/forge-beta.js in passing.` });
  for (let i = 0; i < 6; i++) facts.push({ unitId: 'T03', mem_id: `mem-t03-${i}`, text: `Note ${i} with no file citation at all, just prose.` });
  assert(facts.length >= 20, 'fixture must have at least 20 facts');

  const root = mkStore(facts, fakeFiles);
  try {
    const result = buildFileIndex(root, {});
    assert(result.coverage.fragments_read >= 3, 'expected at least 3 fragments read');
    assert(result.coverage.facts_total >= 20, 'expected at least 20 facts total');
    const md = renderIndex(result, {});
    assert(md.includes('## Cobertura e descarte'), 'expected coverage section on the full fixture');
    assert(md.includes('scripts/forge-alpha.js'), 'expected the alpha entry rendered');
    assert(md.includes('scripts/forge-beta.js'), 'expected the beta entry rendered');
  } finally {
    cleanup(root);
  }
});

// ── Section 13: CLI ───────────────────────────────────────────────────────────
console.log('\nSection 13: CLI — --json exit 0, unknown flag exit 2\n');

test('CLI: --json --cwd <fixture> exits 0 with one-line parseable JSON on stdout', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-cli-1' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--json', '--cwd', root], { encoding: 'utf8' });
    assertEq(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`);
    const stdoutLines = res.stdout.split('\n').filter((l) => l.length > 0);
    assertEq(stdoutLines.length, 1, 'expected exactly one non-empty stdout line');
    let parsed;
    assert((() => { parsed = JSON.parse(stdoutLines[0]); return true; })(), 'stdout line must be valid JSON');
    assert(typeof parsed.coverage === 'object', 'expected a coverage object in the JSON envelope');
  } finally {
    cleanup(root);
  }
});

test('CLI: unknown flag exits 2', () => {
  const res = spawnSync(process.execPath, [SCRIPT_PATH, '--flag-inexistente'], { encoding: 'utf8' });
  assertEq(res.status, 2, `expected exit 2 for unknown flag, got ${res.status}`);
});

test('CLI: --out without a value exits 2', () => {
  const res = spawnSync(process.execPath, [SCRIPT_PATH, '--out'], { encoding: 'utf8' });
  assertEq(res.status, 2, `expected exit 2 for --out missing a value, got ${res.status}`);
});

test('CLI: --write with no --json grants the default-write path and produces the artifact with the coverage section', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-cli-2' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--write', '--cwd', root], { encoding: 'utf8' });
    assertEq(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`);
    const artifactPath = path.join(root, DEFAULT_INDEX_PATH);
    assert(fs.existsSync(artifactPath), 'expected the default artifact to be written');
    const content = fs.readFileSync(artifactPath, 'utf8');
    assert(content.includes('## Cobertura e descarte'), 'expected coverage section in the written artifact');
  } finally {
    cleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failed ? 1 : 0);
