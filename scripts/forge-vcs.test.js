#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ignore = require('./forge-ignore.js');
const vcs = require('./forge-vcs.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}
function run(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
}
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-'));
  run(cwd, ['init', '-q']);
  fs.writeFileSync(path.join(cwd, 'modified.txt'), 'before\n');
  fs.writeFileSync(path.join(cwd, 'deleted.txt'), 'delete me\n');
  run(cwd, ['add', '.']);
  run(cwd, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid', 'commit', '-qm', 'init']);
  return cwd;
}

// ── S02 review R1 — parseSvnLogXml fail-closed, the four measured inputs ────
//
// These four inputs were EXECUTED during the S02 review and all four answered
// `{ ok: true }` with a silently shrunken answer. Each assert below names the
// input it exists for; the fix in forge-vcs.js names the guard that closes it.
// A well-formed log is asserted alongside, so a parser that simply refuses
// everything cannot pass this block.
//
// Placed HERE, ahead of the git fixtures, deliberately: this suite aborts on
// the first throw (no per-test catch), and it carries a PRE-EXISTING failure
// further down (the CRLF/EOL class, red on HEAD too). Appended at the end,
// these asserts would never execute — a test that cannot run is not coverage.

const WELL_FORMED = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<log>',
  '<logentry revision="12">',
  '<msg>feat(S04/T01): trabalho</msg>',
  '<paths><path action="M">/trunk/a.txt</path><path action="A">/trunk/b.txt</path></paths>',
  '</logentry>',
  '</log>',
].join('\n');

test('R1 log bem-formado continua parseando (os guards não são recusa geral)', () => {
  const got = vcs.parseSvnLogXml(WELL_FORMED);
  assert.strictEqual(got.ok, true, JSON.stringify(got));
  assert.strictEqual(got.revisions.length, 1);
  assert.strictEqual(got.revisions[0].rev, 12);
  assert.deepStrictEqual(got.revisions[0].paths.map((p) => p.path), ['/trunk/a.txt', '/trunk/b.txt']);
});

test('R1 log vazio é um vazio honesto, nunca malformed', () => {
  assert.deepStrictEqual(vcs.parseSvnLogXml('<?xml version="1.0"?>\n<log>\n</log>\n'), { ok: true, revisions: [] });
});

test('R1 <path> não fechado dentro de <paths> fechado é malformed, não revisão com zero paths', () => {
  // Medido ANTES do fix: { ok: true, revisions: [{ rev: 1, paths: [] }] } —
  // um arquivo escrito vira um arquivo que ninguém escreveu.
  const bad = '<log><logentry revision="1"><paths><path action="M">/trunk/a.txt</paths></logentry></log>';
  assert.deepStrictEqual(vcs.parseSvnLogXml(bad), { ok: false, error: 'svn-log-malformed' });
});

test('R1 revision="12junk" é malformed, não a revisão 12', () => {
  // Medido ANTES do fix: rev 12 — parseInt faz prefix-parse e Number.isFinite nunca dispara.
  const bad = '<log><logentry revision="12junk"><msg>x</msg></logentry></log>';
  assert.deepStrictEqual(vcs.parseSvnLogXml(bad), { ok: false, error: 'svn-log-malformed' });
});

test('R1 stream truncado é malformed — "não consegui perguntar" nunca vira "não há"', () => {
  const bad = '<?xml version="1.0"?>\n<log>\n<logentry revision="1">\n<msg>feat(S04/T01): x</msg>\n<paths><path action="M">/tr';
  assert.deepStrictEqual(vcs.parseSvnLogXml(bad), { ok: false, error: 'svn-log-malformed' });
});

test('R1 lixo puro é malformed, nunca um log vazio', () => {
  assert.deepStrictEqual(vcs.parseSvnLogXml('total garbage not xml'), { ok: false, error: 'svn-log-malformed' });
});

test('R1 entry deixada FORA de todo bloco casado é resíduo, não uma resposta mais curta', () => {
  // Uma entry completa mais uma não fechada: devolver `revisions.length === 1`
  // aqui é exatamente o encolhimento silencioso que este parser diz não fazer.
  const bad = [
    '<log>',
    '<logentry revision="1"><msg>ok</msg></logentry>',
    '<logentry revision="2"><msg>truncada',
    '</log>',
  ].join('\n');
  assert.deepStrictEqual(vcs.parseSvnLogXml(bad), { ok: false, error: 'svn-log-malformed' });
});

// ── fim do bloco R1; o restante da suíte segue byte-idêntico ──────────────

test('baselineId succeeds in a fixture and failures are normalized', () => {
  const cwd = fixture();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-empty-'));
  try {
    const baseline = vcs.baselineId(cwd);
    assert.strictEqual(baseline.ok, true);
    assert.match(baseline.id, /^[0-9a-f]{40}$/);
    const failed = vcs.baselineId(empty);
    assert.deepStrictEqual(failed.vcs, 'git');
    assert.strictEqual(failed.ok, false);
    assert(failed.error.length > 0);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(empty, { recursive: true, force: true }); }
});

test('captureDirty includes gsd by default and excludes it by predicate', () => {
  const cwd = fixture();
  try {
    fs.mkdirSync(path.join(cwd, '.gsd'));
    fs.writeFileSync(path.join(cwd, '.gsd', 'x.json'), '{}\n');
    assert(vcs.captureDirty(cwd).entries.some(entry => entry.path === '.gsd/x.json'));
    assert(!vcs.captureDirty(cwd, { exclude: vcs.isGsdPath }).entries.some(entry => entry.path === '.gsd/x.json'));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('postChanges classifies added modified and deleted files', () => {
  const cwd = fixture();
  try {
    const baseline = vcs.baselineId(cwd).id;
    fs.writeFileSync(path.join(cwd, 'modified.txt'), 'after\n');
    fs.unlinkSync(path.join(cwd, 'deleted.txt'));
    fs.writeFileSync(path.join(cwd, 'new.txt'), 'new\n');
    const entries = new Map(vcs.postChanges(cwd, baseline).entries.map(entry => [entry.path, entry.status]));
    assert.strictEqual(entries.get('modified.txt'), 'M');
    assert.strictEqual(entries.get('deleted.txt'), 'D');
    assert.strictEqual(entries.get('new.txt'), 'A');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('hashPath preserves missing-file sentinel', () => {
  const cwd = fixture();
  try { assert.deepStrictEqual(vcs.hashPath(cwd, 'absent.txt'), { vcs: 'git', ok: true, hash: null }); }
  finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('restoreAndRemove restores modifications, removes additions, and guards overlap', () => {
  const cwd = fixture();
  try {
    const baseline = vcs.baselineId(cwd).id;
    fs.writeFileSync(path.join(cwd, 'modified.txt'), 'changed\n');
    fs.writeFileSync(path.join(cwd, 'new.txt'), 'new\n');
    const done = vcs.restoreAndRemove(cwd, baseline, { restore: ['modified.txt'], remove: ['new.txt'], overlap: [] });
    assert.deepStrictEqual(done, { vcs: 'git', ok: true, restored: ['modified.txt'], removed: ['new.txt'] });
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'modified.txt'), 'utf8'), 'before\n');
    assert.strictEqual(fs.existsSync(path.join(cwd, 'new.txt')), false);
    assert.throws(() => vcs.restoreAndRemove(cwd, baseline, { restore: [], remove: [], overlap: ['modified.txt'] }), /overlap is non-empty/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('captureDirty degrades a single failed hash-object to null instead of aborting the snapshot (R1)', () => {
  const cwd = fixture();
  const subCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-sub-'));
  try {
    run(subCwd, ['init', '-q']);
    fs.writeFileSync(path.join(subCwd, 'sub.txt'), 'sub\n');
    run(subCwd, ['add', '.']);
    run(subCwd, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid', 'commit', '-qm', 'sub']);
    // A submodule gitlink is a real-world path where `git hash-object -- <dir>` fails
    // (it is a directory, not a blob) while `git status` still reports it dirty —
    // exactly the per-path failure R1 guards against.
    const add = spawnSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subCwd, 'sub'], { encoding: 'utf8' });
    assert.strictEqual(add.status, 0, add.stderr || 'submodule add failed');
    fs.writeFileSync(path.join(cwd, 'modified.txt'), 'also dirty\n');
    const result = vcs.captureDirty(cwd);
    assert.strictEqual(result.ok, true);
    const byPath = new Map(result.entries.map((entry) => [entry.path, entry.hash]));
    // The unhashable gitlink path degrades to null, but does NOT abort the snapshot —
    // the sibling dirty file is still present (this is what R1 restores).
    assert.strictEqual(byPath.get('sub'), null);
    assert(byPath.has('modified.txt'), 'sibling dirty path must survive the failed path');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(subCwd, { recursive: true, force: true });
  }
});

test('gitPostChanges treats copy differently from rename per copyOriginDeleted (R4)', () => {
  const cwd = fixture();
  try {
    run(cwd, ['config', 'diff.renames', 'copies']);
    // Copy detection needs a large-enough source AND the source modified in the same
    // diff (git's copy detector only searches modified/added files in the changeset,
    // not the whole tree, without --find-copies-harder — which the seam intentionally
    // does not pass).
    const big = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '\n';
    fs.writeFileSync(path.join(cwd, 'modified.txt'), big);
    run(cwd, ['add', '.']);
    run(cwd, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid', 'commit', '-qm', 'big-source']);
    const baseline = vcs.baselineId(cwd).id;
    fs.copyFileSync(path.join(cwd, 'modified.txt'), path.join(cwd, 'zcopy.txt'));
    fs.appendFileSync(path.join(cwd, 'modified.txt'), 'changed\n');
    run(cwd, ['add', '.']);
    const withDelete = new Map(vcs.postChanges(cwd, baseline).entries.map((entry) => [entry.path, entry.status]));
    assert.strictEqual(withDelete.get('zcopy.txt'), 'A');
    // Default (copyOriginDeleted unset -> true) matches the reset-engine semantics:
    // the copy origin is marked 'D' (inert there — restored identically from baseline).
    assert.strictEqual(withDelete.get('modified.txt'), 'D');
    const withoutDelete = new Map(
      vcs.postChanges(cwd, baseline, { copyOriginDeleted: false }).entries.map((entry) => [entry.path, entry.status])
    );
    assert.strictEqual(withoutDelete.get('zcopy.txt'), 'A');
    // Report-only consumers (xllm) must not see the copy origin falsely marked deleted.
    assert.notStrictEqual(withoutDelete.get('modified.txt'), 'D');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('unsupported vcs returns the normalized sentinel for every primitive', () => {
  const cwd = fixture();
  try {
    // Total return shapes are the R2 resolution from S02-REVIEW: even an
    // unsupported backend provides the primitive's data sentinel.
    const opts = { vcs: 'other' };
    assert.deepStrictEqual(vcs.baselineId(cwd, opts), { vcs: 'other', ok: false, id: null, error: 'vcs-unsupported:other' });
    assert.deepStrictEqual(vcs.hashPath(cwd, 'modified.txt', opts), { vcs: 'other', ok: false, hash: null, error: 'vcs-unsupported:other' });
    assert.deepStrictEqual(vcs.captureDirty(cwd, opts), { vcs: 'other', ok: false, entries: [], error: 'vcs-unsupported:other' });
    assert.deepStrictEqual(vcs.postChanges(cwd, 'HEAD', opts), { vcs: 'other', ok: false, entries: [], error: 'vcs-unsupported:other' });
    assert.deepStrictEqual(
      vcs.restoreAndRemove(cwd, 'HEAD', { restore: [], remove: [], overlap: [] }, opts),
      { vcs: 'other', ok: false, restored: [], removed: [], error: 'vcs-unsupported:other' }
    );
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('SVN XML entity decoding is single-pass and supports named and numeric entities', () => {
  assert.strictEqual(vcs.decodeXmlEntities('&amp;&lt;&gt;&quot;&apos;'), '&<>"\'');
  assert.strictEqual(vcs.decodeXmlEntities('&amp;lt;'), '&lt;');
  assert.strictEqual(vcs.decodeXmlEntities('a&#10;b&#x2f;c'), 'a\nb/c');
});

test('SVN XML parser accepts reordered multiline attributes and ignores nested commit revision', () => {
  const xml = `<status><target path="."><entry path="dir/&amp;lt;name&gt;&#10;x"><wc-status\n props="modified"\n item="normal"\n revision="7"><commit revision="999"/></wc-status></entry></target></status>`;
  const parsed = vcs.parseSvnStatusXml(xml);
  assert.deepStrictEqual(parsed, { ok: true, entries: [{ path: 'dir/&lt;name>\nx', item: 'normal', props: 'modified' }] });
});

test('SVN XML parser decodes quotes and apostrophes in paths', () => {
  const xml = '<status><target path="."><entry path="a&amp;quot;b&amp;apos;c"><wc-status item="modified" props="none"/></entry></target></status>';
  assert.deepStrictEqual(vcs.parseSvnStatusXml(xml).entries[0], { path: 'a&quot;b&apos;c', item: 'modified', props: 'none' });
});

test('SVN XML parser rejects entries without an opening wc-status tag', () => {
  const xml = '<status><target path="."><entry path="x"><commit revision="9"/></entry></target></status>';
  assert.deepStrictEqual(vcs.parseSvnStatusXml(xml), { ok: false, error: 'svn-status-malformed' });
});

test('SVN item map classifies content and property modifications', () => {
  assert.strictEqual(vcs.mapSvnItem('modified', 'none'), 'M');
  assert.strictEqual(vcs.mapSvnItem('replaced', 'none'), 'M');
  assert.strictEqual(vcs.mapSvnItem('normal', 'modified'), 'M');
  assert.deepStrictEqual(vcs.mapSvnItem('normal', 'none'), { skip: true });
});

test('SVN item map classifies adds and deletes', () => {
  assert.strictEqual(vcs.mapSvnItem('added', 'none'), 'A');
  assert.strictEqual(vcs.mapSvnItem('unversioned', 'none'), 'A');
  assert.strictEqual(vcs.mapSvnItem('deleted', 'none'), 'D');
  assert.strictEqual(vcs.mapSvnItem('missing', 'none'), 'D');
});

test('SVN external and ignored records are skipped', () => {
  assert.deepStrictEqual(vcs.mapSvnItem('external', 'none'), { skip: true });
  assert.deepStrictEqual(vcs.mapSvnItem('ignored', 'none'), { skip: true });
});

test('SVN unknown item is fail-closed rather than treated as modified', () => {
  assert.deepStrictEqual(vcs.mapSvnItem('conflicted', 'none'), { failClosed: 'conflicted' });
});

test('SVN parser keeps a newline-containing path as exactly one entry', () => {
  const xml = '<status><entry path="one&#10;two"><wc-status item="unversioned" props="none"/></entry></status>';
  const result = vcs.parseSvnStatusXml(xml);
  assert.strictEqual(result.entries.length, 1);
  assert.strictEqual(result.entries[0].path, 'one\ntwo');
  assert.strictEqual(vcs.mapSvnItem(result.entries[0].item, result.entries[0].props), 'A');
});

test('SVN parser reads item and props only from wc-status opening tag', () => {
  const xml = '<status><entry path="x"><wc-status item="deleted" props="none"><commit item="modified" props="modified" revision="42"/></wc-status></entry></status>';
  assert.deepStrictEqual(vcs.parseSvnStatusXml(xml).entries, [{ path: 'x', item: 'deleted', props: 'none' }]);
});

test('SVN parser accepts a quoted path with a numeric hex entity', () => {
  const xml = '<status><entry path="q&#x22;z"><wc-status props="none" item="modified"/></entry></status>';
  assert.strictEqual(vcs.parseSvnStatusXml(xml).entries[0].path, 'q"z');
});

test('SVN normal with non-none property state remains a modification', () => {
  for (const props of ['modified', 'conflicted', 'unknown']) {
    assert.strictEqual(vcs.mapSvnItem('normal', props), 'M');
  }
});

test('SVN parser reports multiple status entries without cross-contamination', () => {
  const xml = '<status><entry path="a"><wc-status item="added" props="none"/></entry><entry path="b"><wc-status item="missing" props="none"/></entry></status>';
  assert.deepStrictEqual(vcs.parseSvnStatusXml(xml).entries, [
    { path: 'a', item: 'added', props: 'none' },
    { path: 'b', item: 'missing', props: 'none' },
  ]);
});

test('SVN working-copy root guard is zero-spawn and preserves capture sentinel', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-no-svn-'));
  try {
    assert.deepStrictEqual(vcs.captureDirty(cwd, { vcs: 'svn' }), {
      vcs: 'svn', ok: false, entries: [], error: 'svn-wcroot-mismatch: run primitives from the working-copy root',
    });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('SVN captureDirty converts an unknown XML item into a primitive-level failure', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-svn-wc-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-svn-bin-'));
  try {
    fs.mkdirSync(path.join(cwd, '.svn'));
    const mock = path.join(bin, 'svn');
    // The process stub is only a known XML producer: this exercises the public
    // primitive's fail-closed propagation without requiring a real SVN client.
    fs.writeFileSync(mock, '#!/bin/sh\nprintf "%s\\n" \'<status><entry path="unsafe"><wc-status item="conflicted" props="none"/></entry></status>\'\n');
    fs.chmodSync(mock, 0o755);
    const result = vcs.captureDirty(cwd, { vcs: 'svn', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.deepStrictEqual(result, { vcs: 'svn', ok: false, entries: [], error: 'svn-status-unhandled:conflicted' });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('SVN hashPath uses distinct null and directory sentinels', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-svn-hash-'));
  try {
    fs.mkdirSync(path.join(cwd, '.svn'));
    fs.mkdirSync(path.join(cwd, 'a-dir'));
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'contents');
    const directory = vcs.hashPath(cwd, 'a-dir', { vcs: 'svn' });
    const absent = vcs.hashPath(cwd, 'absent', { vcs: 'svn' });
    const file = vcs.hashPath(cwd, 'file.txt', { vcs: 'svn' });
    assert.deepStrictEqual(directory, { vcs: 'svn', ok: true, hash: 'dir' });
    assert.deepStrictEqual(absent, { vcs: 'svn', ok: true, hash: null });
    assert.match(file.hash, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(file.hash, directory.hash);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('isTracked answers membership in git and separates "no" from "could not ask"', () => {
  const cwd = fixture();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-untracked-'));
  try {
    fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'new\n');
    assert.deepStrictEqual(vcs.isTracked(cwd, 'modified.txt'), { vcs: 'git', ok: true, tracked: true });
    assert.deepStrictEqual(vcs.isTracked(cwd, 'untracked.txt'), { vcs: 'git', ok: true, tracked: false });
    // Outside a repository git exits non-zero: an ANSWER ("no"), not a failure.
    assert.deepStrictEqual(vcs.isTracked(empty, 'anything.txt'), { vcs: 'git', ok: true, tracked: false });
    // A tracked path deleted from the worktree is still under version control.
    fs.rmSync(path.join(cwd, 'deleted.txt'));
    assert.strictEqual(vcs.isTracked(cwd, 'deleted.txt').tracked, true);
    assert.deepStrictEqual(vcs.isTracked(cwd, 'modified.txt', { vcs: 'hg' }),
      { vcs: 'hg', ok: false, tracked: false, error: 'vcs-unsupported:hg' });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('svnPegSafe escapes every target so a path containing @ is not read as a peg revision', () => {
  // Unconditional: SVN strips one trailing @, so an ordinary path is unaffected
  // and `services@1.2.0` stops parsing as revision "1.2.0" (E205000).
  assert.strictEqual(vcs.svnPegSafe('.gsd/LEDGER.md'), '.gsd/LEDGER.md@');
  assert.strictEqual(vcs.svnPegSafe('SERVICES/services@1.2.0'), 'SERVICES/services@1.2.0@');
});

test('all primitives use explicit vcs and do not call detectVcs', () => {
  const cwd = fixture();
  let probes = 0;
  const previous = ignore.__setExecFileSync(() => { probes += 1; throw new Error('probe'); });
  try {
    const baseline = vcs.baselineId(cwd);
    vcs.hashPath(cwd, 'modified.txt');
    vcs.captureDirty(cwd);
    vcs.postChanges(cwd, baseline.id);
    vcs.restoreAndRemove(cwd, baseline.id, { restore: [], remove: [], overlap: [] });
    assert.strictEqual(probes, 0);
  } finally {
    ignore.__setExecFileSync(previous);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
