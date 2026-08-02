#!/usr/bin/env node
// forge-items.test.js — contract test suite for forge-items.js
// Covers merge-safety (real git merge demo), prefix resolution, closed status,
// dual-regime provenance, promoted_to validation, per-project cwd isolation and
// round-trip serialization. Every fixture lives under a temp dir removed in a
// `finally` — nothing ever touches the live repo .gsd/.
// Run: node scripts/forge-items.test.js  (exits 0 = all pass, 1 = any fail)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const items = require('./forge-items.js');
const CLI = path.join(__dirname, 'forge-items.js');

// ── Harness ───────────────────────────────────────────────────────────────────
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

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-items-test-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, opts) {
  opts = opts || {};
  const spawnOpts = { cwd: opts.cwd, encoding: 'utf8' };
  // Only set `input` when a caller supplies it — passing `input: undefined`
  // would change stdin handling for every existing call site.
  if (opts.input !== undefined) spawnOpts.input = opts.input;
  return spawnSync(process.execPath, [CLI, ...args], spawnOpts);
}

function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'forge-test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}

function gitCommit(dir, message) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

console.log('\n=== forge-items.js — contract test suite ===\n');

// ── 1. Merge-safety (the roadmap demo) ───────────────────────────────────────
console.log('1. Merge-safety — real two-branch git merge');
test('two branches each add one item merge with zero conflicts, both fragments present', () => {
  withTmpDir(dir => {
    gitInit(dir);
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
    gitCommit(dir, 'base');
    const baseBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
      .toString().trim();

    execFileSync('git', ['checkout', '-q', '-b', 'branch-a'], { cwd: dir });
    const a = items.addItem(dir, { title: 'Branch A item', origin: 'human' });
    gitCommit(dir, 'add item A');

    execFileSync('git', ['checkout', '-q', baseBranch], { cwd: dir });
    execFileSync('git', ['checkout', '-q', '-b', 'branch-b'], { cwd: dir });
    // Force a distinct ID even if minted in the same wall-clock second as A.
    const b = items.addItem(dir, { title: 'Branch B item', origin: 'human', id: a.id + '-b' });
    gitCommit(dir, 'add item B');

    // Merge branch-a into branch-b.
    const mergeResult = spawnSync('git', ['merge', 'branch-a', '--no-edit'], { cwd: dir, encoding: 'utf8' });
    assert(mergeResult.status === 0, `merge should exit 0, got ${mergeResult.status}: ${mergeResult.stderr}`);
    assert(!/^<{7}|^={7}|^>{7}/m.test(mergeResult.stdout + mergeResult.stderr), 'no conflict markers expected');

    assert(fs.existsSync(a.path), 'item A fragment must exist after merge');
    assert(fs.existsSync(b.path), 'item B fragment must exist after merge');
    assert(a.path !== b.path, 'the two-files property: distinct fragment files, not one shared index');
  });
});

// ── 2. Prefix resolution ─────────────────────────────────────────────────────
console.log('\n2. Prefix resolution');
test('unique prefix resolves to full ID', () => {
  withTmpDir(dir => {
    const dirItems = items.itemsDir(dir);
    fs.mkdirSync(dirItems, { recursive: true });
    const id = 'I-20260729120000-unique-one';
    fs.writeFileSync(path.join(dirItems, `${id}.md`), items.serializeItem({
      id, title: 'Unique', status: 'inbox', origin: 'human',
      created: new Date().toISOString(), updated: new Date().toISOString(),
    }));
    assertEq(items.resolveItemId(dir, 'I-20260729120000-unique'), id);
  });
});

test('ambiguous prefix — CLI --resolve exits non-zero and stderr names both candidates', () => {
  withTmpDir(dir => {
    const dirItems = items.itemsDir(dir);
    fs.mkdirSync(dirItems, { recursive: true });
    const idA = 'I-20260729120000-alphaone';
    const idB = 'I-20260729120000-alphatwo';
    for (const id of [idA, idB]) {
      fs.writeFileSync(path.join(dirItems, `${id}.md`), items.serializeItem({
        id, title: id, status: 'inbox', origin: 'human',
        created: new Date().toISOString(), updated: new Date().toISOString(),
      }));
    }
    const result = runCli(['--resolve', 'I-20260729120000-alpha', '--cwd', dir]);
    assert(result.status !== 0, `expected non-zero exit, got ${result.status}`);
    assert(result.stderr.includes(idA), `stderr must name ${idA}: ${result.stderr}`);
    assert(result.stderr.includes(idB), `stderr must name ${idB}: ${result.stderr}`);
  });
});

test('unknown prefix — CLI --resolve exits non-zero', () => {
  withTmpDir(dir => {
    fs.mkdirSync(items.itemsDir(dir), { recursive: true });
    const result = runCli(['--resolve', 'I-99999999999999', '--cwd', dir]);
    assert(result.status !== 0, `expected non-zero exit, got ${result.status}`);
  });
});

// ── 3. Closed status ──────────────────────────────────────────────────────────
console.log('\n3. Closed status');
test('CLI --set-status <id> foo exits 1', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Status item', origin: 'human' });
    const result = runCli(['--set-status', created.id, 'foo', '--cwd', dir]);
    assertEq(result.status, 1);
  });
});

test('each of the five valid statuses exits 0 via CLI', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Status item', origin: 'human' });
    for (const status of items.STATUSES) {
      const result = runCli(['--set-status', created.id, status, '--cwd', dir]);
      assertEq(result.status, 0, `status "${status}" should exit 0: ${result.stderr}`);
    }
  });
});

test('library setStatus throws on invalid status', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Status item', origin: 'human' });
    let threw = null;
    try { items.setStatus(dir, created.id, 'foo'); } catch (e) { threw = e; }
    assert(threw !== null, 'setStatus("foo") must throw');
  });
});

// ── 4. Provenance dual-regime ────────────────────────────────────────────────
console.log('\n4. Provenance dual-regime');
test('origin auto without source — CLI --validate exits 1', () => {
  withTmpDir(dir => {
    const dirItems = items.itemsDir(dir);
    fs.mkdirSync(dirItems, { recursive: true });
    const id = 'I-20260729120000-auto-nosrc';
    fs.writeFileSync(path.join(dirItems, `${id}.md`), items.serializeItem({
      id, title: 'Auto no source', status: 'inbox', origin: 'auto',
      created: new Date().toISOString(), updated: new Date().toISOString(),
    }));
    const result = runCli(['--validate', id, '--cwd', dir]);
    assertEq(result.status, 1);
  });
});

test('origin auto with source — CLI --validate exits 0', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Auto with source', origin: 'auto', source: 'review/S02/R1' });
    const result = runCli(['--validate', created.id, '--cwd', dir]);
    assertEq(result.status, 0, result.stderr);
  });
});

test('origin human without source — CLI --validate exits 0', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Human item', origin: 'human' });
    const result = runCli(['--validate', created.id, '--cwd', dir]);
    assertEq(result.status, 0, result.stderr);
  });
});

// ── 5. promoted_to ────────────────────────────────────────────────────────────
console.log('\n5. promoted_to');
test('--promote with a timestamp milestone target writes promoted_to', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Promotable', origin: 'human' });
    const result = runCli(['--promote', created.id, 'M-20260729120000-x', '--cwd', dir]);
    assertEq(result.status, 0, result.stderr);
    const fragment = fs.readFileSync(created.path, 'utf8');
    assert(fragment.includes('promoted_to: M-20260729120000-x'), `fragment should contain promoted_to:\n${fragment}`);
  });
});

test('--promote with a garbage target exits 1', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Not promotable', origin: 'human' });
    const result = runCli(['--promote', created.id, 'GARBAGE', '--cwd', dir]);
    assertEq(result.status, 1);
  });
});

test('--promote target validated via forge-ids: legacy M005 target accepted', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Legacy target', origin: 'human' });
    const result = runCli(['--promote', created.id, 'M005', '--cwd', dir]);
    assertEq(result.status, 0, result.stderr);
    const fragment = fs.readFileSync(created.path, 'utf8');
    assert(fragment.includes('promoted_to: M005'), `fragment should contain promoted_to: M005:\n${fragment}`);
  });
});

// ── 6. Per-project scope ─────────────────────────────────────────────────────
console.log('\n6. Per-project scope');
test('--add in project A does not leak into --list --cwd B', () => {
  withTmpDir(dirA => {
    withTmpDir(dirB => {
      items.addItem(dirA, { title: 'Only in A', origin: 'human' });
      const result = runCli(['--list', '--json', '--cwd', dirB]);
      assertEq(result.status, 0, result.stderr);
      const listed = JSON.parse(result.stdout);
      assertEq(listed, [], 'project B should see zero items created in project A');
    });
  });
});

// ── 7. Round-trip ─────────────────────────────────────────────────────────────
console.log('\n7. Round-trip (multi-line body + colon-leading title)');
test('multi-line body and colon-leading title survive add → read', () => {
  withTmpDir(dir => {
    const title = ': Item with a colon-leading title';
    const body = 'Line one\nLine two: with a colon\nLine three';
    const created = items.addItem(dir, { title, origin: 'human', body });
    const readBack = items.readItem(dir, created.id);
    assertEq(readBack.title, title, 'title must round-trip losslessly');
    assertEq(readBack.body, body, 'body must round-trip losslessly');
  });
});

// ── 8. Round-trip byte-idêntico (legado) ─────────────────────────────────────
// These fixtures are embedded verbatim (not read from .gsd/items/, which is
// gitignored and absent in other checkouts) so this section is an unconditional
// guard on any machine. They are copies of the three legacy fragments that lived
// under .gsd/items/ at the time this task was written — none carries closed_at,
// labels or priority, which is the exact shape T02/T03 are about to touch.
console.log('\n8. Round-trip byte-idêntico (legado)');

const LEGACY_FIXTURES = [
  {
    name: 'I-20260729235447-aceitacao-gui.md (auto, no promoted_to, code fence body)',
    text: "---\nid: I-20260729235447-aceitacao-gui\ntitle: Aceitação de GUI da atualização in-app (D13) — observar os cinco pontos no próximo release\nstatus: inbox\norigin: auto\ncreated: 2026-07-29T23:54:47.803Z\nupdated: 2026-07-30T05:18:44.091Z\nsource: task/T-20260729191241-atualizacao-barra\nfile: app/Sources/Forge/Updates.swift\nsha: fced4574c5e1ad405f08ffc14750baa8abfcf7dd\n---\n\nA must-have D13 da task T-20260729191241-atualizacao-barra não foi verificada — decisão do operador em 2026-07-29 de deferir, não uma alegação de que passou.\n\n**Atualização 2026-07-30:** o texto original dizia \"no próximo release\", o que deixou de ser verdade. A afordance \"Reinstalar\" (T-20260730004115) tornou a barra alcançável **a qualquer momento**, sem depender de release pendente. E a task T-20260730020639 acrescentou `build.sh --debug`, que monta e roda o app em ~2s.\n\nComo observar agora, sem esperar release nenhum:\n```\ncd app && ./build.sh --debug --run\n```\nSeção Atualizações → **Reinstalar** → observar os cinco pontos:\n1. a barra aparece e o rótulo de fase muda ao longo do run, inclusive durante o `swift build`;\n2. o log expansível mostra a saída crua do instalador;\n3. \"Reabrir na nova versão\" só aparece no exit 0, nunca durante o build;\n4. clicar produz UM modal, não dois, e reabre o app;\n5. a seção selecionada antes do relaunch volta selecionada.\n\nJunto disso, valem as 10 propriedades visuais não-verificadas de T-20260730020639 (ver o SUMMARY dela) e a objeção aberta R5 (`I-20260730051419-divider-sidebar-vira-row`).\n",
  },
  {
    name: 'I-20260729235457-barra-progresso.md (done, promoted_to present, no sha)',
    text: "---\nid: I-20260729235457-barra-progresso\ntitle: Barra de progresso da atualização é inalcançável sem release pendente — considerar afordance de reinstalar\nstatus: done\norigin: auto\ncreated: 2026-07-29T23:54:57.708Z\nupdated: 2026-07-30T01:58:14.033Z\nsource: task/T-20260729191241-atualizacao-barra\nfile: app/Sources/Forge/Updates.swift\npromoted_to: T-20260730004115-afordance-reinstalar\n---\n\nGap de testabilidade descoberto ao fechar T-20260729191241-atualizacao-barra: a UI de progresso só existe atrás do botão \"Atualizar\", que só renderiza quando `updateAvailable` (Updates.swift:329). Consequência: um recurso que só se vê quando calha de haver release pendente é um recurso que não se consegue verificar sob demanda — a mesma classe de buraco que deixou o `env: node` da v3.1.3 passar.\n\nProposta (recusada em 2026-07-29 por escopo, não por mérito): um \"Verificar e reinstalar\" que roda o instalador mesmo estando na versão atual, com rótulo distinto de \"Atualizar\" para não inventar update inexistente. Torna a barra alcançável e testável a qualquer momento, e alinha com o comportamento de apps macOS (Sparkle deixa checar quando o usuário quiser).\n\nO operador pediu explicitamente atualização \"dentro do próprio app ou o padrão do macOS\" — esta afordance é o que fecha essa frase por completo.\n",
  },
  {
    name: 'I-20260730051419-divider-sidebar-vira-row.md (inbox, sha present, no promoted_to)',
    text: "---\nid: I-20260730051419-divider-sidebar-vira-row\ntitle: Divider da sidebar vira uma row do List, não 1pt — julgar com tela (R5 aberta)\nstatus: inbox\norigin: auto\ncreated: 2026-07-30T05:14:19.492Z\nupdated: 2026-07-30T05:14:19.492Z\nsource: review/T-20260730020639-sidebar-secao/R5\nfile: app/Sources/Forge/Views.swift\nsha: b000f3c4d7ef28bffd6ee8aa17ebb5b5acde4656\n---\n\nObjeção R5 do challenger codex, **aberta** — não refutada e não concedida, porque não se resolve sem tela e nenhum agente tem uma (esta máquina não tem Xcode).\n\nO `Divider()` é emitido como filho do `List` dentro do `ForEach`, então o SwiftUI o trata como **uma row própria** — com insets de row de sidebar e altura mínima de row, não os 1pt que o comentário do código afirma. O advogado concordou que o comentário exagera, e apontou dois contra-pontos: a row não tem `.tag`, logo não é selecionável (o \"gap selecionável\" é no máximo impressão de hover); e a posição dentro do `ForEach` é load-bearing para os guards da D29/D31 — mover para overlay/background da row de Runs troca este problema por separador colado na row.\n\nComo julgar: `cd app && ./build.sh --debug --run`, olhar a sidebar entre Runs e Contas, e arrastar a coluna para 180pt. Se o vão parecer uma linha vazia em vez de uma divisão, a correção honesta é remover a regra (a D33 já proíbe compensar com chrome), não empilhar mais.\n\nFaz parte do conjunto de 10 propriedades visuais não-verificadas listadas em `T-20260730020639-sidebar-secao-SUMMARY.md § O conjunto NÃO VERIFICADO`.\n",
  },
];

// None of the embedded fixtures may carry the three fields T02/T03 are about to
// introduce — if one did, this guard would stop distinguishing "legacy shape"
// from "future shape" and the whole point of running T01 first would be lost.
for (const fixture of LEGACY_FIXTURES) {
  for (const forbidden of ['closed_at:', 'labels:', 'priority:']) {
    if (fixture.text.includes(forbidden)) {
      throw new Error(
        `Fixture "${fixture.name}" contains "${forbidden}" — this section must stay ` +
        'byte-for-byte legacy-shaped. Pick a different fixture.'
      );
    }
  }
}

// assertByteIdentical — parses then re-serializes `text` and fails with the
// first divergent byte index + surrounding context, so a real regression is
// diagnosable from the test output alone instead of a raw string diff.
function assertByteIdentical(text, label) {
  const out = items.serializeItem(items.parseItem(text));
  const bufOut = Buffer.from(out, 'utf8');
  const bufIn = Buffer.from(text, 'utf8');
  if (Buffer.compare(bufOut, bufIn) === 0) return;

  const minLen = Math.min(bufOut.length, bufIn.length);
  let firstDiff = minLen;
  for (let i = 0; i < minLen; i++) {
    if (bufOut[i] !== bufIn[i]) { firstDiff = i; break; }
  }
  const ctx = 40;
  const start = Math.max(0, firstDiff - ctx);
  const inCtx = bufIn.slice(start, firstDiff + ctx).toString('utf8');
  const outCtx = bufOut.slice(start, firstDiff + ctx).toString('utf8');
  throw new Error(
    `${label || 'round-trip'}: byte mismatch at index ${firstDiff} ` +
    `(input length ${bufIn.length}, output length ${bufOut.length})\n` +
    `     input  around byte ${firstDiff}: ${JSON.stringify(inCtx)}\n` +
    `     output around byte ${firstDiff}: ${JSON.stringify(outCtx)}`
  );
}

for (const fixture of LEGACY_FIXTURES) {
  test(`round-trip byte-identical: ${fixture.name}`, () => {
    assertByteIdentical(fixture.text, fixture.name);
  });
}

// Sweep: if .gsd/items/ exists in this checkout, round-trip every real fragment
// too (read-only, bonus coverage). If it does not exist (any other checkout —
// the directory is gitignored), the loop simply iterates zero files; the three
// embedded fixtures above remain the unconditional guard.
test('sweep: every real fragment under .gsd/items/ (if present) round-trips byte-identically', () => {
  const realItemsDir = path.join(__dirname, '..', '.gsd', 'items');
  let files = [];
  if (fs.existsSync(realItemsDir)) {
    files = fs.readdirSync(realItemsDir).filter(f => f.endsWith('.md'));
  }
  for (const f of files) {
    const text = fs.readFileSync(path.join(realItemsDir, f), 'utf8');
    assertByteIdentical(text, `sweep: ${f}`);
  }
});

// ── 9. closed_at (D4) ─────────────────────────────────────────────────────────
// closed_at is stamped by the STATUS TRANSITION and removed on reopen. These
// tests assert against the bytes on disk, not against the returned object: the
// removal path works by assigning null and relying on serializeItem skipping it,
// so an in-memory assertion would pass even if the key were still written out.
console.log('\n9. closed_at (D4)');

// Counts `closed_at:` frontmatter lines in a fragment — the file-level
// equivalent of the `grep -c closed_at` in the acceptance criterion.
function countClosedAt(fpath) {
  const text = fs.readFileSync(fpath, 'utf8');
  return text.split('\n').filter(l => /^closed_at:\s*\S/.test(l)).length;
}

function readClosedAt(fpath) {
  const line = fs.readFileSync(fpath, 'utf8')
    .split('\n').find(l => /^closed_at:\s*\S/.test(l));
  return line ? line.slice('closed_at:'.length).trim() : null;
}

test('--set-status done stamps exactly one closed_at line; --set-status doing removes it', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Closable', origin: 'human' });
    assertEq(countClosedAt(created.path), 0, 'a fresh inbox item must have no closed_at');

    const done = runCli(['--set-status', created.id, 'done', '--cwd', dir]);
    assertEq(done.status, 0, `--set-status done must exit 0 (stderr: ${done.stderr})`);
    assertEq(countClosedAt(created.path), 1, 'done must stamp exactly one closed_at line');
    assert(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(readClosedAt(created.path)),
      `closed_at must be an ISO timestamp, got ${JSON.stringify(readClosedAt(created.path))}`
    );

    const reopen = runCli(['--set-status', created.id, 'doing', '--cwd', dir]);
    assertEq(reopen.status, 0, `--set-status doing must exit 0 (stderr: ${reopen.stderr})`);
    assertEq(countClosedAt(created.path), 0, 'reopening must REMOVE the closed_at key from the file');
  });
});

test('--set-status dropped also stamps closed_at (D4: stamped, not counted)', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Droppable', origin: 'human' });
    const r = runCli(['--set-status', created.id, 'dropped', '--cwd', dir]);
    assertEq(r.status, 0, `--set-status dropped must exit 0 (stderr: ${r.stderr})`);
    assertEq(countClosedAt(created.path), 1, 'dropped must stamp closed_at');
  });
});

test('--update of the title on a done item leaves closed_at byte-identical while updated moves', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Title to edit', origin: 'human' });
    items.setStatus(dir, created.id, 'done');
    const stampBefore = readClosedAt(created.path);
    const updatedBefore = items.readItem(dir, created.id).updated;
    assert(stampBefore, 'precondition: the item must carry a stamp before the patch');

    // Sleep past the ISO millisecond resolution so an unchanged `updated` cannot
    // masquerade as a passing test.
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},5)']);
    const r = runCli(['--update', created.id, '--cwd', dir], {
      input: JSON.stringify({ title: 'Edited title' }),
    });
    assertEq(r.status, 0, `--update must exit 0 (stderr: ${r.stderr})`);

    const after = items.readItem(dir, created.id);
    assertEq(after.title, 'Edited title', 'the patch must have applied');
    assertEq(readClosedAt(created.path), stampBefore, '--update must NEVER touch closed_at');
    assert(after.updated !== updatedBefore, '`updated` must still bump on any mutation');
  });
});

test('--update with {"status":"done"} on stdin stamps closed_at (same transition rule)', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Closed via patch', origin: 'human' });
    const r = runCli(['--update', created.id, '--cwd', dir], {
      input: JSON.stringify({ status: 'done' }),
    });
    assertEq(r.status, 0, `--update must exit 0 (stderr: ${r.stderr})`);
    assertEq(countClosedAt(created.path), 1, 'closing via --update must stamp too');
  });
});

test('done → done does not move an existing stamp', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Repeatedly done', origin: 'human' });
    items.setStatus(dir, created.id, 'done');
    const first = readClosedAt(created.path);
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},5)']);
    items.setStatus(dir, created.id, 'done');
    assertEq(readClosedAt(created.path), first, 'the documented no-op must not rewrite history');
    assertEq(countClosedAt(created.path), 1, 'and must not duplicate the key');
  });
});

test('done → dropped preserves the original closed_at', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Done then dropped', origin: 'human' });
    items.setStatus(dir, created.id, 'done');
    const first = readClosedAt(created.path);
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},5)']);
    items.setStatus(dir, created.id, 'dropped');
    assertEq(readClosedAt(created.path), first, 'closed → closed must preserve the first stamp');
  });
});

test('reopen then close again stamps a NEW time (the key was truly gone, not hidden)', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Reopened', origin: 'human' });
    items.setStatus(dir, created.id, 'done');
    const first = readClosedAt(created.path);
    items.setStatus(dir, created.id, 'doing');
    assertEq(countClosedAt(created.path), 0, 'precondition: reopen removed the key');
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},5)']);
    items.setStatus(dir, created.id, 'done');
    const second = readClosedAt(created.path);
    assertEq(countClosedAt(created.path), 1, 'closing again must stamp exactly one key');
    assert(second !== first, `re-closing must stamp a new time (${first} vs ${second})`);
  });
});

test('addItem with status done stamps closed_at at creation', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Born done', origin: 'human', status: 'done' });
    assertEq(countClosedAt(created.path), 1, 'an item born closed must be stamped at creation');
  });
});

test('addItem with an explicit closed_at preserves it (backfill wins over now)', () => {
  withTmpDir(dir => {
    const backfill = '2020-01-02T03:04:05.000Z';
    const created = items.addItem(dir, {
      title: 'Backfilled', origin: 'human', status: 'done', closed_at: backfill,
    });
    assertEq(readClosedAt(created.path), backfill, 'an explicit historical date must survive');
  });
});

test('addItem with an open status stamps nothing', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Born open', origin: 'human', status: 'triaged' });
    assertEq(countClosedAt(created.path), 0, 'an open item must not carry closed_at');
  });
});

// Round-trip with the new field present — section 8 proves KEY_ORDER did not
// disturb the legacy shape; this proves the POPULATED shape round-trips too.
// closed_at sits between `updated` and `source`, matching KEY_ORDER: if the
// constant and this fixture ever disagree, the bytes diverge and this fails.
test('round-trip byte-identical: fragment carrying closed_at', () => {
  assertByteIdentical(
    '---\n' +
    'id: I-20260730101543-com-closed-at\n' +
    'title: Item já fechado\n' +
    'status: done\n' +
    'origin: human\n' +
    'created: 2026-07-30T10:15:43.000Z\n' +
    'updated: 2026-07-30T11:00:00.000Z\n' +
    'closed_at: 2026-07-30T11:00:00.000Z\n' +
    'source: task/T-20260730101543-exemplo\n' +
    '---\n\nCorpo do item.\n',
    'fragment with closed_at'
  );
});

test('a stamped item written by the engine round-trips byte-identically', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Engine written', origin: 'human' });
    items.setStatus(dir, created.id, 'done');
    assertByteIdentical(fs.readFileSync(created.path, 'utf8'), 'engine-written stamped fragment');
  });
});

// ── 10. labels + priority (D6/D7) ─────────────────────────────────────────────
// labels is a comma-separated SCALAR on disk and an array ONLY at the
// --list --json boundary. The negative assertion (`- bug` absent) is the direct
// tripwire for the proven failure: a YAML list parses to `labels = ""` and then
// disappears entirely on the next write, with no error and no exit code.
// priority is a closed set rejected BEFORE disk — asserted on bytes, because
// validating after writing passes an exit-code check and still corrupts a file.
console.log('\n10. labels + priority (D6/D7)');

// Reads one frontmatter line verbatim — assertions here are about the BYTES the
// engine wrote, never about the object it returned.
function readKeyLine(fpath, key) {
  return fs.readFileSync(fpath, 'utf8')
    .split('\n').find(l => l.startsWith(`${key}:`)) || null;
}

test('--add with labels as a JSON ARRAY writes the scalar line, never a YAML list', () => {
  withTmpDir(dir => {
    const r = runCli(['--add', '--cwd', dir], {
      input: JSON.stringify({ title: 'Com labels', origin: 'human', labels: ['bug', 'ui'] }),
    });
    assertEq(r.status, 0, `--add must exit 0 (stderr: ${r.stderr})`);
    const created = JSON.parse(r.stdout);
    const text = fs.readFileSync(created.path, 'utf8');
    assertEq(readKeyLine(created.path, 'labels'), 'labels: bug, ui', 'array must be joined into the scalar');
    assert(!/^- bug$/m.test(text), 'a YAML list item "- bug" must NEVER be written (proven data loss)');
    assert(!/^\s+- /m.test(text), 'no indented YAML list may appear in the frontmatter');
  });
});

test('--add with labels as a STRING produces the identical scalar line', () => {
  withTmpDir(dir => {
    const r = runCli(['--add', '--cwd', dir], {
      input: JSON.stringify({ title: 'Com labels string', origin: 'human', labels: 'bug, ui' }),
    });
    assertEq(r.status, 0, `--add must exit 0 (stderr: ${r.stderr})`);
    const created = JSON.parse(r.stdout);
    assertEq(readKeyLine(created.path, 'labels'), 'labels: bug, ui', 'a string must pass through untouched');
  });
});

test('addItem (library caller, not CLI) also joins an array — normalization is not CLI-only', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Lib caller', origin: 'human', labels: ['a', 'b'] });
    assertEq(readKeyLine(created.path, 'labels'), 'labels: a, b', 'the join must live in addItem, not the CLI');
  });
});

test('--update with an array patch re-joins to the scalar (no list ever reaches disk)', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Patchable', origin: 'human', labels: 'old' });
    const r = runCli(['--update', created.id, '--cwd', dir], {
      input: JSON.stringify({ labels: ['x', 'y'] }),
    });
    assertEq(r.status, 0, `--update must exit 0 (stderr: ${r.stderr})`);
    assertEq(readKeyLine(created.path, 'labels'), 'labels: x, y', 'updateItem must normalize too');
    assert(!/^- x$/m.test(fs.readFileSync(created.path, 'utf8')), 'no YAML list on the update path either');
  });
});

test('--list --json yields an ARRAY for labels, both populated and absent', () => {
  withTmpDir(dir => {
    items.addItem(dir, { title: 'Com', origin: 'human', labels: ['bug', 'ui'] });
    items.addItem(dir, { title: 'Sem', origin: 'human' });
    const r = runCli(['--list', '--json', '--cwd', dir]);
    assertEq(r.status, 0, `--list --json must exit 0 (stderr: ${r.stderr})`);
    const list = JSON.parse(r.stdout);
    assertEq(list.length, 2, 'both items must be listed');
    for (const it of list) {
      assert(Array.isArray(it.labels), `labels must be an array for EVERY item; got ${JSON.stringify(it.labels)}`);
    }
    const com = list.find(it => it.title === 'Com');
    const sem = list.find(it => it.title === 'Sem');
    assertEq(com.labels, ['bug', 'ui'], 'the scalar must split back into its parts');
    assertEq(sem.labels, [], 'an absent key must yield an empty array, not null/undefined');
  });
});

test('--read keeps the RAW store shape — labels stays a scalar (S01-PLAN Nota 1)', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Cru', origin: 'human', labels: ['bug', 'ui'] });
    const r = runCli(['--read', created.id, '--cwd', dir]);
    assertEq(r.status, 0, `--read must exit 0 (stderr: ${r.stderr})`);
    const item = JSON.parse(r.stdout);
    assertEq(item.labels, 'bug, ui', '--read must NOT widen labels — only --list --json does');
    assert(!Array.isArray(item.labels), 'the array shape must not leak past the --list --json boundary');
  });
});

test('--set-priority p1 exits 0 and writes the priority line', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Priorizavel', origin: 'human' });
    const r = runCli(['--set-priority', created.id, 'p1', '--cwd', dir]);
    assertEq(r.status, 0, `--set-priority p1 must exit 0 (stderr: ${r.stderr})`);
    assertEq(readKeyLine(created.path, 'priority'), 'priority: p1', 'the fragment must carry priority: p1');
  });
});

test('--set-priority accepts every member of PRIORITIES and nothing else', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Todas', origin: 'human' });
    for (const p of items.PRIORITIES) {
      const r = runCli(['--set-priority', created.id, p, '--cwd', dir]);
      assertEq(r.status, 0, `--set-priority ${p} must exit 0 (stderr: ${r.stderr})`);
      assertEq(readKeyLine(created.path, 'priority'), `priority: ${p}`, `${p} must be written`);
    }
    assertEq(items.PRIORITIES, ['p0', 'p1', 'p2', 'p3'], 'the closed set is p0..p3');
  });
});

test('--set-priority <lixo> exits 1, lists the valid set, and leaves the file BYTE-identical', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Intocavel', origin: 'human', labels: ['bug'] });
    const before = fs.readFileSync(created.path); // Buffer — bytes, not a parsed object
    const r = runCli(['--set-priority', created.id, 'urgentissimo', '--cwd', dir]);
    assert(r.status !== 0, 'an invalid priority must exit non-zero');
    assertEq(r.status, 1, `runtime rejection is exit 1 (stderr: ${r.stderr})`);
    assert(r.stderr.includes('p0') && r.stderr.includes('p3'), `stderr must list the valid set; got ${JSON.stringify(r.stderr)}`);
    const after = fs.readFileSync(created.path);
    assertEq(
      Buffer.compare(before, after), 0,
      'the fragment must be byte-identical: rejection happens BEFORE disk is touched ' +
      '(the test equivalent of `git status --porcelain .gsd/items/` staying empty)'
    );
  });
});

test('--update with an invalid priority on stdin is also rejected before disk', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Via patch', origin: 'human' });
    const before = fs.readFileSync(created.path);
    const r = runCli(['--update', created.id, '--cwd', dir], {
      input: JSON.stringify({ priority: 'lixo' }),
    });
    assertEq(r.status, 1, `--update with a bad priority must exit 1 (stderr: ${r.stderr})`);
    assertEq(Buffer.compare(before, fs.readFileSync(created.path)), 0, 'no write path may accept an invalid priority');
  });
});

test('--add with an invalid priority is rejected and creates NO fragment', () => {
  withTmpDir(dir => {
    const r = runCli(['--add', '--cwd', dir], {
      input: JSON.stringify({ title: 'Nao nasce', origin: 'human', priority: 'p9' }),
    });
    assertEq(r.status, 1, `--add with a bad priority must exit 1 (stderr: ${r.stderr})`);
    const dirPath = items.itemsDir(dir);
    const files = fs.existsSync(dirPath) ? fs.readdirSync(dirPath).filter(f => f.endsWith('.md')) : [];
    assertEq(files, [], 'a rejected --add must leave the store empty');
  });
});

test('validateItem rejects a priority outside the set and accepts an absent one', () => {
  const base = {
    id: 'I-20260730101543-valida', title: 'Valida', status: 'inbox', origin: 'human',
  };
  assertEq(items.validateItem(base).valid, true, 'priority is optional');
  assertEq(items.validateItem({ ...base, priority: 'p2' }).valid, true, 'p2 is in the set');
  const bad = items.validateItem({ ...base, priority: 'alta' });
  assertEq(bad.valid, false, 'a value outside the set must be invalid');
  assert(bad.errors.some(e => e.includes('p0, p1, p2, p3')), `the error must name the set; got ${JSON.stringify(bad.errors)}`);
});

// Section 8 proves KEY_ORDER left the LEGACY shape alone; this proves the fully
// POPULATED shape round-trips too. The fixture pins the POSITION of priority and
// labels (after status, before origin) — if KEY_ORDER and this fixture ever
// disagree, the bytes diverge and this test fails.
test('round-trip byte-identical: fragment carrying labels, priority AND closed_at', () => {
  assertByteIdentical(
    '---\n' +
    'id: I-20260730101543-populado\n' +
    'title: Item com tudo preenchido\n' +
    'status: done\n' +
    'priority: p1\n' +
    'labels: bug, ui\n' +
    'origin: human\n' +
    'created: 2026-07-30T10:15:43.000Z\n' +
    'updated: 2026-07-30T11:00:00.000Z\n' +
    'closed_at: 2026-07-30T11:00:00.000Z\n' +
    'source: task/T-20260730101543-exemplo\n' +
    '---\n\nCorpo do item.\n',
    'fragment with labels + priority + closed_at'
  );
});

test('an item written by the engine with labels AND priority round-trips byte-identically', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, {
      title: 'Engine populado', origin: 'human', labels: ['bug', 'ui'],
    });
    items.setPriority(dir, created.id, 'p0');
    items.setStatus(dir, created.id, 'done');
    // write → read → write: the bytes on disk must survive a full cycle.
    const onDisk = fs.readFileSync(created.path, 'utf8');
    assertByteIdentical(onDisk, 'engine-written populated fragment');
  });
});

// ── 10. closed_at forgery rejection (review R1) ─────────────────────────────────
// closed_at must be a MEASUREMENT of a real transition, never a value a caller
// can attach to an open item. Both write paths (--update patch and --add) must
// reject the combination, leaving the fragment on disk byte-identical to
// whatever existed before the attempt (or absent entirely for a failed --add).
console.log('\n10. closed_at forgery rejection (review R1)');

test('--update with closed_at on an OPEN item is rejected and the fragment is untouched', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Still open', origin: 'human' });
    const before = fs.readFileSync(created.path, 'utf8');

    const r = runCli(['--update', created.id, '--cwd', dir], {
      cwd: dir,
      input: JSON.stringify({ closed_at: '2026-07-30T12:00:00.000Z' }),
    });
    assert(r.status !== 0, `expected non-zero exit forging closed_at on an open item, got ${r.status}`);

    const after = fs.readFileSync(created.path, 'utf8');
    assert(
      Buffer.compare(Buffer.from(before), Buffer.from(after)) === 0,
      'a rejected patch must leave the fragment byte-identical to its pre-attempt state'
    );
  });
});

test('addItem with closed_at and an open status throws and writes nothing to disk', () => {
  withTmpDir(dir => {
    let threw = null;
    try {
      items.addItem(dir, {
        title: 'Forged at birth', origin: 'human', status: 'inbox',
        closed_at: '2026-07-30T12:00:00.000Z',
      });
    } catch (e) {
      threw = e;
    }
    assert(threw !== null, 'addItem must throw when closed_at is present on a non-closed status');
    assert(
      /closed_at/.test(threw.message),
      `error must name closed_at; got ${JSON.stringify(threw.message)}`
    );

    const itemsDir = path.join(dir, '.gsd', 'items');
    const files = fs.existsSync(itemsDir) ? fs.readdirSync(itemsDir) : [];
    assertEq(files.length, 0, 'a rejected addItem must not leave any fragment on disk');
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`      ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
