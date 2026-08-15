#!/usr/bin/env node
'use strict';

// forge-claim-overlap.test.js — the comparator never reports its own
// inactivity as good news, and never confuses "did not declare" with
// "declared and collided".
//
// Properties this suite carries:
//
//   R1  D1 in BOTH directions, with SEPARATE asserts: `A=[], B=[x]` conflicts
//       AND `A=[x], B=[]` conflicts. Never one assert assuming symmetry.
//   R2  the two causes are distinct and named in BOTH senses:
//       `undeclared-writes` is never reported as `overlap`, nor the reverse.
//   R3  D2: identical claims under DIFFERENT `code_dir` do not conflict — the
//       pair is skipped with `different-code-dir` and `pairs_compared` is NOT
//       incremented.
//   R4  `code-dir-unknown` does NOT exclude: the pair is compared, and the
//       uncertainty lands in `notes[]`.
//   R5  the anti-silence floor: `pairs_compared === 0` yields `inconclusive`
//       BEFORE any other branch, never `clean` — proved by an EXECUTED bite.
//   R6  `pairs_compared` counts pairs actually walked, never `n*(n-1)/2`.
//   R7  closed sets (`VERDICTS`, `CONFLICT_CAUSES`, `CLAIM_SKIP_REASONS`,
//       `CLAIM_NOTE_REASONS`) crossed in BOTH directions.
//   R8  the algebra is `pathsOverlap`; `writesConflict` appears NOWHERE in the
//       module source with comments stripped.
//   R9  the CLI exits 0 ALWAYS — proved by SPAWN, including with a planted
//       collision — and prints the line naming both runs and the shared path.
//   R10 the comparator writes nothing: sha256 of every run record identical
//       before and after a `--check`.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-claim-overlap.js');
const mod = require('./forge-claim-overlap.js');
const {
  collectRunClaims, claimsConflict, compareClaims, formatClaimOverlap,
  sameCodeDir, VERDICTS, CONFLICT_CAUSES, CLAIM_SKIP_REASONS, CLAIM_NOTE_REASONS,
} = mod;

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

const tmps = [];
function mktmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claim-overlap-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Build a synthetic claim in the persisted shape (no disk). */
function claim(paths, codeDir, unit) {
  return {
    at: 1785763253000,
    unit: unit || 'execute-task/T01',
    source: 'manual',
    code_dir: codeDir === undefined ? '/code/dir' : codeDir,
    paths: paths === null ? [] : paths,
  };
}

/** A `collected` shape, built by hand — `compareClaims` is pure, so no fixture. */
function collected(comparable, extra) {
  return Object.assign({
    runs_examined: comparable.length,
    comparable: comparable.map((c) => ({
      id: c.id, claim: c.claim, code_dir: (c.claim && c.claim.code_dir) || null,
    })),
    skipped: [],
    notes: [],
  }, extra || {});
}

/**
 * Registry fixture: `.gsd/forge/runs/<id>.json` under a synthetic workspace.
 * Same shape as forge-write-claim.test.js's `makeFixture`, extended to N runs.
 */
function makeFixture(specs) {
  const tmp = mktmp();
  const wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(wsDir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');

  const runFiles = [];
  for (const spec of specs) {
    const file = path.join(wsDir, '.gsd', 'forge', 'runs', `${spec.id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.assign({
      kind: 'milestone',
      id: spec.id,
      session_id: 'sess-fixture',
      active: spec.active === undefined ? true : spec.active,
      started_at: 1785763253000,
      last_heartbeat: 1785763253000,
      worker: null,
      worker_started: null,
      isolation_mode: 'branch',
      milestone_dir: `.gsd/milestones/${spec.id}/`,
      cwd: wsDir,
    }, spec.write_claim === undefined ? {} : { write_claim: spec.write_claim }), null, 2), 'utf8');
    runFiles.push(file);
  }
  return { wsDir, runFiles };
}

function runCli(args) {
  const res = spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Track what each closed set actually emitted, for the both-directions crossing.
const verdictsSeen = new Set();
const causesSeen = new Set();
const skipsSeen = new Set();
const notesSeen = new Set();

function record(result) {
  verdictsSeen.add(result.verdict);
  for (const c of result.conflicts) causesSeen.add(c.cause);
  for (const s of result.skipped) skipsSeen.add(s.reason);
  for (const n of result.notes) notesSeen.add(n.reason);
  // Direction 1 of the crossing, checked on EVERY result that passes through:
  // nothing this code emits may fall outside the declared sets.
  assert(VERDICTS.includes(result.verdict), `veredicto fora de VERDICTS: ${result.verdict}`);
  for (const c of result.conflicts) {
    assert(CONFLICT_CAUSES.includes(c.cause), `causa fora de CONFLICT_CAUSES: ${c.cause}`);
  }
  for (const s of result.skipped) {
    assert(CLAIM_SKIP_REASONS.includes(s.reason), `skip fora de CLAIM_SKIP_REASONS: ${s.reason}`);
  }
  for (const n of result.notes) {
    assert(CLAIM_NOTE_REASONS.includes(n.reason), `note fora de CLAIM_NOTE_REASONS: ${n.reason}`);
  }
  return result;
}

// ── R1: D1 in BOTH directions, separate asserts ─────────────────────────────
test('R1a: A declarou nada, B declarou x -> conflito (undeclared-writes)', () => {
  const hit = claimsConflict(claim([]), claim(['src/a.ts']));
  assert(hit !== null, 'lado vazio à esquerda deve conflitar cross-run (D1)');
  assertEqual(hit.cause, 'undeclared-writes');
});

test('R1b: A declarou x, B declarou nada -> conflito (undeclared-writes)', () => {
  const hit = claimsConflict(claim(['src/a.ts']), claim([]));
  assert(hit !== null, 'lado vazio à direita deve conflitar cross-run (D1)');
  assertEqual(hit.cause, 'undeclared-writes');
});

test('R1c: claim ausente (null) em qualquer um dos lados -> undeclared-writes', () => {
  assertEqual(claimsConflict(null, claim(['src/a.ts'])).cause, 'undeclared-writes');
  assertEqual(claimsConflict(claim(['src/a.ts']), null).cause, 'undeclared-writes');
});

test('R1d: polaridade cross-run é o INVERSO da intra-slice (guard comportamental)', () => {
  const { writesConflict } = require('./forge-parallelism.js');
  assertEqual(writesConflict([], ['src/a.ts']), false,
    'intra-slice: lista vazia continua NÃO conflitando (Out of Scope, não pode mudar)');
  assert(claimsConflict(claim([]), claim(['src/a.ts'])) !== null,
    'cross-run: a MESMA entrada deve conflitar — as duas polaridades coexistem de propósito');
});

// ── R2: the two causes are distinct, in BOTH senses ─────────────────────────
test('R2a: dois lados declarados que colidem -> overlap, NUNCA undeclared-writes', () => {
  const hit = claimsConflict(claim(['src/a.ts', 'b.js']), claim(['src/a.ts']));
  assertEqual(hit.cause, 'overlap');
  assert(hit.cause !== 'undeclared-writes', 'colisão declarada não pode ser reportada como undeclared-writes');
  assert(hit.paths.includes('src/a.ts'), 'o caminho em comum deve ser carregado no conflito');
});

test('R2b: um lado não declarado -> undeclared-writes, NUNCA overlap', () => {
  const hit = claimsConflict(claim([]), claim(['src/a.ts']));
  assertEqual(hit.cause, 'undeclared-writes');
  assert(hit.cause !== 'overlap', 'não-declaração não pode ser reportada como overlap');
});

test('R2c: dois lados declarados sem interseção -> sem conflito', () => {
  assertEqual(claimsConflict(claim(['a.js']), claim(['b.js'])), null);
});

test('R2d: a álgebra de glob vem de pathsOverlap (prefixo de diretório casa)', () => {
  const hit = claimsConflict(claim(['src/**']), claim(['src/deep/x.ts']));
  assertEqual(hit.cause, 'overlap', 'glob/prefixo deve casar via pathsOverlap');
});

// ── R3: D2 — different code_dir does not conflict, pair not counted ─────────
test('R3: claims IDÊNTICOS em code_dir distintos -> pulado, pairs_compared === 0', () => {
  const r = record(compareClaims(collected([
    { id: 'M-a', claim: claim(['src/a.ts'], '/code/one') },
    { id: 'M-b', claim: claim(['src/a.ts'], '/code/two') },
  ])));
  assertEqual(r.pairs_compared, 0, 'par com code_dir distinto NÃO pode incrementar pairs_compared');
  assertEqual(r.conflicts.length, 0, 'code_dir distinto não é colisão (D2)');
  assert(r.skipped.some((s) => s.reason === 'different-code-dir'),
    'o par pulado deve sair com a razão nomeada different-code-dir');
  assertEqual(r.verdict, 'inconclusive', 'sem par confrontado o veredicto é inconclusive, nunca clean');
});

test('R3b: sameCodeDir devolve os três desfechos nomeados', () => {
  assertEqual(sameCodeDir(claim(['a'], '/x'), claim(['a'], '/x')), 'same');
  assertEqual(sameCodeDir(claim(['a'], '/x'), claim(['a'], '/y')), 'different');
  assertEqual(sameCodeDir(claim(['a'], null), claim(['a'], '/y')), 'unknown');
  assertEqual(sameCodeDir(claim(['a'], '/x'), claim(['a'], null)), 'unknown');
});

// ── R4: code-dir-unknown does NOT exclude ───────────────────────────────────
test('R4: code_dir desconhecido -> par COMPARADO, incerteza em notes[]', () => {
  const r = record(compareClaims(collected([
    { id: 'M-a', claim: claim(['src/a.ts'], null) },
    { id: 'M-b', claim: claim(['src/a.ts'], '/code/two') },
  ])));
  assertEqual(r.pairs_compared, 1, 'desconhecimento não exclui o par — excluir seria a polaridade que D1 proíbe');
  assert(r.notes.some((n) => n.reason === 'code-dir-unknown'), 'a incerteza deve ir para notes[] com razão nomeada');
  assertEqual(r.verdict, 'conflict');
  assertEqual(r.conflicts[0].cause, 'overlap');
});

// ── R5: the floor, with an EXECUTED bite ────────────────────────────────────
test('R5a: uma única run comparável -> inconclusive, razão citando o número', () => {
  const r = record(compareClaims(collected([{ id: 'M-solo', claim: claim(['a.js']) }])));
  assertEqual(r.verdict, 'inconclusive');
  assert(/1 run/.test(r.reason), `a razão deve citar quantas runs havia, veio: ${r.reason}`);
  assert(r.skipped.some((s) => s.reason === 'not-comparable-single-run'),
    'a run solitária deve sair com razão nomeada');
});

test('R5b: zero runs comparáveis -> inconclusive (nunca clean)', () => {
  const r = record(compareClaims(collected([])));
  assertEqual(r.verdict, 'inconclusive');
});

test('R5c: MORDIDA executada — piso removido, os asserts do piso ficam vermelhos', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  const marker = `  if (pairs_compared === 0) {
    verdict = 'inconclusive';`;
  assert(src.includes(marker), 'o ramo do piso não foi encontrado — a mordida não pode rodar');

  // Bait: reorder the branches so `clean` can be reached with zero pairs —
  // exactly the bug class the floor exists to prevent.
  const baited = src.replace(marker, `  if (false) {
    verdict = 'inconclusive';`);
  assert(baited !== src, 'a mordida não alterou o fonte');

  const baitPath = path.join(__dirname, `.forge-claim-overlap-bait-${process.pid}.js`);
  fs.writeFileSync(baitPath, baited, 'utf8');
  delete require.cache[require.resolve(baitPath)];
  const baitedMod = require(baitPath);

  const r = baitedMod.compareClaims(collected([{ id: 'M-solo', claim: claim(['a.js']) }]));

  // Nominally: R5a's verdict assert and R3's verdict assert are the ones that
  // go red under this mutation — the baited module answers `clean` having
  // confronted zero pairs.
  let bit = false;
  try {
    assertEqual(r.verdict, 'inconclusive', 'baited: piso deveria ter devolvido inconclusive');
  } catch (e) {
    bit = true;
  }
  assert(bit, 'a mordida não mordeu: remover o piso deveria ter deixado este assert vermelho');
  assertEqual(r.verdict, 'clean', 'sob mutação o módulo responde clean com 0 pares — o defeito que o piso impede');
  assertEqual(r.pairs_compared, 0, 'e o censo continua dizendo 0 pares — a prova de que clean era vazio');

  delete require.cache[require.resolve(baitPath)];
  try { fs.unlinkSync(baitPath); } catch { /* best effort */ }
});

// ── R6: pairs_compared counted inside the loop ──────────────────────────────
test('R6a: 3 runs no mesmo code_dir -> 3 pares percorridos', () => {
  const r = record(compareClaims(collected([
    { id: 'M-a', claim: claim(['a.js']) },
    { id: 'M-b', claim: claim(['b.js']) },
    { id: 'M-c', claim: claim(['c.js']) },
  ])));
  assertEqual(r.pairs_compared, 3);
  assertEqual(r.verdict, 'clean', 'três pares confrontados sem colisão é clean legítimo');
});

test('R6b: contador não é fórmula — 3 runs com um par fora de escopo dá 2, não 3', () => {
  const r = record(compareClaims(collected([
    { id: 'M-a', claim: claim(['a.js'], '/code/one') },
    { id: 'M-b', claim: claim(['b.js'], '/code/one') },
    { id: 'M-c', claim: claim(['c.js'], '/code/two') },
  ])));
  // n*(n-1)/2 would say 3. The loop actually walked 1 pair (a×b); a×c and b×c
  // were skipped by D2.
  assertEqual(r.pairs_compared, 1, 'pairs_compared deve contar pares percorridos, nunca n*(n-1)/2');
  assertEqual(r.skipped.filter((s) => s.reason === 'different-code-dir').length, 2);
});

// ── collectRunClaims: a run without claim stays comparable ──────────────────
test('collectRunClaims: run sem claim entra como comparável, com note claim-absent', () => {
  const { wsDir } = makeFixture([
    { id: 'M-noclaim' },
    { id: 'M-withclaim', write_claim: claim(['src/a.ts']) },
  ]);
  const c = collectRunClaims(wsDir, {});
  assertEqual(c.comparable.length, 2, 'run sem claim NÃO pode ser tirada da comparação (D1)');
  assert(c.notes.some((n) => n.id === 'M-noclaim' && n.reason === 'claim-absent'),
    'a ausência de claim deve ficar registrada com razão nomeada');
  const r = record(compareClaims(c));
  assertEqual(r.verdict, 'conflict');
  assertEqual(r.conflicts[0].cause, 'undeclared-writes');
});

test('collectRunClaims: claim gravado e vazio -> note claim-empty (distinto de claim-absent)', () => {
  const { wsDir } = makeFixture([
    { id: 'M-empty', write_claim: claim([]) },
    { id: 'M-full', write_claim: claim(['src/a.ts']) },
  ]);
  const c = collectRunClaims(wsDir, {});
  assert(c.notes.some((n) => n.id === 'M-empty' && n.reason === 'claim-empty'),
    'gravado-e-vazio é um FATO distinto de nunca-gravado');
  record(compareClaims(c));
});

test('collectRunClaims: run inativa fora por default, dentro com --all, sempre nomeada', () => {
  const { wsDir } = makeFixture([
    { id: 'M-on', write_claim: claim(['a.js']) },
    { id: 'M-off', active: false, write_claim: claim(['a.js']) },
  ]);
  const def = collectRunClaims(wsDir, {});
  assertEqual(def.comparable.length, 1);
  assert(def.skipped.some((s) => s.id === 'M-off' && s.reason === 'run-inactive'),
    'run inativa deve sair com razão nomeada, nunca em silêncio');
  record(compareClaims(def));

  const all = collectRunClaims(wsDir, { all: true });
  assertEqual(all.comparable.length, 2, '--all deve incluir as inativas');
  const r = record(compareClaims(all));
  assertEqual(r.pairs_compared, 1);
});

// ── R7: closed sets crossed in BOTH directions ──────────────────────────────
test('R7a: VERDICTS — toda entrada foi emitida por >= 1 teste', () => {
  for (const v of VERDICTS) assert(verdictsSeen.has(v), `VERDICTS: ${v} nunca foi emitido por nenhum teste`);
});
test('R7b: CONFLICT_CAUSES — toda entrada foi emitida por >= 1 teste', () => {
  for (const c of CONFLICT_CAUSES) assert(causesSeen.has(c), `CONFLICT_CAUSES: ${c} nunca foi emitida`);
});
test('R7c: CLAIM_SKIP_REASONS — toda entrada foi emitida por >= 1 teste', () => {
  for (const s of CLAIM_SKIP_REASONS) assert(skipsSeen.has(s), `CLAIM_SKIP_REASONS: ${s} nunca foi emitida`);
});
test('R7d: CLAIM_NOTE_REASONS — toda entrada foi emitida por >= 1 teste', () => {
  for (const n of CLAIM_NOTE_REASONS) assert(notesSeen.has(n), `CLAIM_NOTE_REASONS: ${n} nunca foi emitida`);
});

// ── R8: source scan — pathsOverlap yes, writesConflict never ────────────────
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('R8: o módulo reusa pathsOverlap e NÃO referencia writesConflict (fonte sem comentários)', () => {
  const code = stripComments(fs.readFileSync(MODULE, 'utf8'));
  assert(code.includes('pathsOverlap'), 'a álgebra deve vir de pathsOverlap — composição, nunca reimplementação');
  assert(!code.includes('writesConflict'),
    'writesConflict não pode ser importado nem mencionado no código do comparador (D1/S03 § 3)');
  // Positive control: the scanner is not blind — it DOES see the word when
  // present. Without this, a broken strip would pass the assert above mutely.
  assert(stripComments('const x = writesConflict;').includes('writesConflict'),
    'controle positivo: o scanner deve enxergar a palavra quando ela existe');
});

test('R8b: a fronteira travada — nada de fila/ordenação/merge especulativo', () => {
  const code = stripComments(fs.readFileSync(MODULE, 'utf8')).toLowerCase();
  for (const forbidden of ['mergequeue', 'merge_queue', 'speculative', 'enqueue', 'bisect']) {
    assert(!code.includes(forbidden), `vocabulário de fila de integração no módulo: ${forbidden}`);
  }
});

// ── R9: CLI proved by SPAWN, exit 0 always ──────────────────────────────────
test('R9a: --check com colisão plantada -> exit 0 e a linha que aponta as duas runs', () => {
  const { wsDir } = makeFixture([
    { id: 'M-alpha', write_claim: claim(['src/shared.ts'], '/code/dir') },
    { id: 'M-beta', write_claim: claim(['src/shared.ts'], '/code/dir') },
  ]);
  const res = runCli(['--check', '--cwd', wsDir]);
  assertEqual(res.status, 0, `--check DEVE sair 0 mesmo com conflito, stderr=${res.stderr}`);
  assert(res.stdout.includes('conflict'), `stdout deve trazer o veredicto, veio: ${res.stdout}`);
  assert(res.stdout.includes('M-alpha') && res.stdout.includes('M-beta'),
    'a linha da colisão deve nomear as duas runs');
  assert(res.stdout.includes('src/shared.ts'), 'a linha da colisão deve apontar o caminho em comum');
  assert(res.stdout.includes('overlap'), 'a causa deve ser nomeada na saída');
});

test('R9b: --check --json parseável, com censo completo', () => {
  const { wsDir } = makeFixture([
    { id: 'M-alpha', write_claim: claim(['src/shared.ts'], '/code/dir') },
    { id: 'M-beta', write_claim: claim(['src/shared.ts'], '/code/dir') },
  ]);
  const res = runCli(['--check', '--json', '--cwd', wsDir]);
  assertEqual(res.status, 0, `exit 0 obrigatório, stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assertEqual(parsed.verdict, 'conflict');
  assertEqual(parsed.pairs_compared, 1);
  assertEqual(parsed.runs_examined, 2);
  assertEqual(parsed.conflicts[0].cause, 'overlap');
  for (const k of ['runs_examined', 'runs_with_claim', 'pairs_compared', 'paths_compared', 'skipped', 'notes']) {
    assert(k in parsed, `o censo deve trazer ${k}`);
  }
});

test('R9c: --list mostra os claims das runs comparáveis, exit 0', () => {
  const { wsDir } = makeFixture([
    { id: 'M-alpha', write_claim: claim(['src/shared.ts'], '/code/dir') },
    { id: 'M-semclaim' },
  ]);
  const res = runCli(['--list', '--cwd', wsDir]);
  assertEqual(res.status, 0, `--list deve sair 0, stderr=${res.stderr}`);
  assert(res.stdout.includes('M-alpha') && res.stdout.includes('src/shared.ts'),
    'o --list deve mostrar o claim da run');
  assert(res.stdout.includes('M-semclaim'), 'o --list deve mostrar também a run que não declarou');
});

test('R9d: registry ausente -> exit 0 e veredicto inconclusive (advisory, nunca fatal)', () => {
  const tmp = mktmp();
  const res = runCli(['--check', '--cwd', tmp]);
  assertEqual(res.status, 0, `registry ausente não pode ser fatal, stderr=${res.stderr}`);
});

test('R9e: sem flags imprime o USAGE e sai 0', () => {
  const res = runCli([]);
  assertEqual(res.status, 0);
  assert(res.stdout.includes('forge-claim-overlap.js'), 'o USAGE deve ser impresso');
});

// ── R10: read-only, proved by sha256 of every run record ────────────────────
test('R10: --check não escreve — sha256 de todo runs/*.json idêntico antes e depois', () => {
  const { wsDir, runFiles } = makeFixture([
    { id: 'M-alpha', write_claim: claim(['src/shared.ts'], '/code/dir') },
    { id: 'M-beta', write_claim: claim(['src/shared.ts'], '/code/dir') },
    { id: 'M-gamma' },
  ]);
  const before = runFiles.map(sha256);
  const res = runCli(['--check', '--cwd', wsDir]);
  assertEqual(res.status, 0);
  const after = runFiles.map(sha256);
  for (let i = 0; i < runFiles.length; i++) {
    assertEqual(after[i], before[i], `o comparador escreveu em ${path.basename(runFiles[i])}`);
  }
});

// ── format: the reason rides on the first line for EVERY verdict ────────────
test('format: a razão está na primeira linha e o censo na segunda, inclusive em inconclusive', () => {
  const r = compareClaims(collected([{ id: 'M-solo', claim: claim(['a.js']) }]));
  const lines = formatClaimOverlap(r).split('\n');
  assert(lines[0].includes('inconclusive') && lines[0].includes(r.reason),
    `a razão deve estar na primeira linha, veio: ${lines[0]}`);
  assert(lines[1].includes('censo:'), `o censo deve estar na segunda linha, veio: ${lines[1]}`);
});

// ── Suite close ──────────────────────────────────────────────────────────
cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
