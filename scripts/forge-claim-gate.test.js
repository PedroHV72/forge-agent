#!/usr/bin/env node
'use strict';

// forge-claim-gate.test.js — the decision core never refuses the wrong side,
// never substitutes one cause for the other, and never lets a `defer` with
// nowhere to go degrade into proceeding.
//
// Properties carried here (S04/T01 must_haves, one block each):
//
//   G1  D1 own side, BOTH branches with SEPARATE asserts: ineligible own claim
//       WITH a counterpart in scope -> `refuse`/`undeclared-writes`; the same
//       claim with NOBODY in scope -> `proceed`/`no-active-counterpart`.
//   G2  D1 counterpart side: the counterpart is the one that did not declare ->
//       the decision follows the POSTURE (never `refuse`), cause
//       `undeclared-writes`, `undeclared_side: 'counterpart'`.
//   G3  `overlap` and `undeclared-writes` are never reported one for the other —
//       asserted in BOTH senses.
//   G4  no collision with >= 1 counterpart confronted -> `proceed`/`no-conflict`,
//       distinct from `no-active-counterpart` by its own assert.
//   G5  D7: a conceded item with no path -> `pathless-conceded-item`, carrying
//       the R#s that lack a path; with a counterpart in scope -> `refuse`.
//   G6  D3 floor: `defer` + `ready_alternatives === 0` -> `block` with
//       `floor: 'defer-floor'`. Proved by an EXECUTED bite on a throwaway copy.
//   G7  scope fails CLOSED (W2/contract #5): `unknown` STAYS in scope with the
//       note attached; only a MEASURED `different` leaves, named.
//   G8  the S06/D8 seam receives BOTH complete RunRecords — the counterpart's
//       `isolation_mode` included.
//   G9  closed sets crossed in BOTH directions.
//   G10 `not_covered` (3 boundaries) and the census ride on EVERY result,
//       `proceed` included.
//   G11 the source never names `writesConflict` — positive AND negative control;
//       the two S03 polarity suites stay green BY SPAWN, without edition.
//   G12 CLI posture: exit 0 when it evaluated (any decision), 2 on usage, != 0
//       on an internal error — this gate is ENFORCING, not advisory.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-claim-gate.js');
const POLARITY_TEST = path.join(__dirname, 'forge-claim-polarity.test.js');
const OVERLAP_TEST = path.join(__dirname, 'forge-claim-overlap.test.js');

const gate = require('./forge-claim-gate.js');
const {
  deriveClaimFromPlan, deriveClaimFromConcededItems, resolvePosture, evaluateGate,
  GATE_DECISIONS, GATE_CAUSES, PROCEED_REASONS, GATE_SKIP_REASONS, GATE_NOTE_REASONS,
  UNCOVERED_BOUNDARIES,
} = gate;
const { CLAIM_NOTE_REASONS } = require('./forge-claim-overlap.js');

// ── Runner ─────────────────────────────────────────────────────────────────
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claim-gate-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A claim in the persisted shape (no disk). */
function claim(paths, codeDir, extra) {
  return Object.assign({
    at: 1785763253000,
    unit: 'execute-task/T01',
    source: 'manual',
    code_dir: codeDir === undefined ? '/code/dir' : codeDir,
    paths: paths === null ? [] : paths,
  }, extra || {});
}

/**
 * Synthetic registry `.gsd/forge/runs/<id>.json` — mould of
 * forge-claim-overlap.test.js. The LIVE registry under the workspace is never
 * read or written by this suite.
 */
function makeFixture(specs) {
  const tmp = mktmp();
  const wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(wsDir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');

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
      isolation_mode: spec.isolation_mode || 'branch',
      milestone_dir: `.gsd/milestones/${spec.id}/`,
      cwd: wsDir,
    }, spec.write_claim === undefined ? {} : { write_claim: spec.write_claim }), null, 2), 'utf8');
  }
  return wsDir;
}

function runCli(args) {
  const res = spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Direction 1 of every crossing, applied to EVERY result that passes through:
// nothing this code emits may fall outside the declared sets.
const decisionsSeen = new Set();
const causesSeen = new Set();
const proceedReasonsSeen = new Set();
const skipsSeen = new Set();
const notesSeen = new Set();

function record(result) {
  assert(GATE_DECISIONS.includes(result.decision), `decisão fora de GATE_DECISIONS: ${result.decision}`);
  decisionsSeen.add(result.decision);
  if (result.cause !== null && result.cause !== undefined) {
    assert(GATE_CAUSES.includes(result.cause), `causa fora de GATE_CAUSES: ${result.cause}`);
    causesSeen.add(result.cause);
  }
  if (result.reason !== null && result.reason !== undefined) {
    assert(PROCEED_REASONS.includes(result.reason), `razão fora de PROCEED_REASONS: ${result.reason}`);
    proceedReasonsSeen.add(result.reason);
  }
  for (const s of result.census.skipped) {
    assert(GATE_SKIP_REASONS.includes(s.reason) || CLAIM_SKIP_REASONS_OK(s.reason),
      `skip fora de GATE_SKIP_REASONS: ${s.reason}`);
    skipsSeen.add(s.reason);
  }
  for (const n of result.census.notes) {
    assert(GATE_NOTE_REASONS.includes(n.reason) || CLAIM_NOTE_REASONS.includes(n.reason),
      `note fora de GATE_NOTE_REASONS ∪ CLAIM_NOTE_REASONS: ${n.reason}`);
    notesSeen.add(n.reason);
  }
  // G10, checked on EVERY result rather than in one dedicated test: a census or
  // an enumeration that is present only where someone remembered to look is
  // exactly the silence this milestone exists to remove.
  assert(result.census && typeof result.census.runs_examined === 'number',
    'resultado sem censo — decisão sem censo não existe');
  assertEqual(result.not_covered.length, 3, 'not_covered deve enumerar 3 fronteiras');
  return result;
}
// Skips inherited from S03's collector (e.g. `run-inactive`) travel verbatim.
function CLAIM_SKIP_REASONS_OK(reason) {
  return require('./forge-claim-overlap.js').CLAIM_SKIP_REASONS.includes(reason);
}

console.log('\n=== forge-claim-gate.test.js ===\n');

// ── G1: D1 own side, both branches, separate asserts ───────────────────────
console.log('G1: D1 lado próprio — refuse com counterpart, proceed sem counterpart');
{
  test('G1a: claim próprio vazio + 1 counterpart em escopo -> refuse/undeclared-writes', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim([]) },
      { id: 'M-other', write_claim: claim(['src/a.ts']) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim([]), posture: 'defer', readyAlternatives: 3,
    }));
    assertEqual(r.decision, 'refuse');
    assertEqual(r.cause, 'undeclared-writes');
    assertEqual(r.undeclared_side, 'own');
    assertEqual(r.census.counterparts_in_scope, 1);
  });

  test('G1b: MESMO claim vazio, ZERO counterparts -> proceed/no-active-counterpart', () => {
    const ws = makeFixture([{ id: 'M-own', write_claim: claim([]) }]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim([]), posture: 'defer', readyAlternatives: 0,
    }));
    assertEqual(r.decision, 'proceed', 'sem counterpart, não declarar não é incidente (D1)');
    assertEqual(r.reason, 'no-active-counterpart');
    assertEqual(r.cause, null);
    assert(r.census.notes.some((n) => n.reason === 'own-claim-ineligible-no-counterpart'),
      'a inelegibilidade própria deve ficar VISÍVEL como note, mesmo sem punição');
  });

  test('G1c: claim próprio ausente (null) + counterpart -> refuse (mesma polaridade de D1)', () => {
    const ws = makeFixture([
      { id: 'M-own' },
      { id: 'M-other', write_claim: claim(['src/a.ts']) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: null, posture: 'block', readyAlternatives: 1,
    }));
    assertEqual(r.decision, 'refuse');
    assertEqual(r.cause, 'undeclared-writes');
  });

  test('G1d: os dois lados sem declarar -> refuse com undeclared_side "both"', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim([]) },
      { id: 'M-other', write_claim: claim([]) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim([]), posture: 'defer', readyAlternatives: 2,
    }));
    assertEqual(r.decision, 'refuse');
    assertEqual(r.undeclared_side, 'both');
  });
}

// ── G2: D1 counterpart side — posture, never refuse ────────────────────────
console.log('\nG2: D1 lado alheio — postura, nunca refuse do plano próprio');
{
  function counterpartUndeclared(posture, ready) {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['src/a.ts']) },
      { id: 'M-other', write_claim: claim([]) },
    ]);
    return record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['src/a.ts']), posture, readyAlternatives: ready,
    }));
  }

  test('G2a: counterpart não declarou, postura defer + alternativa -> defer/undeclared-writes', () => {
    const r = counterpartUndeclared('defer', 2);
    assertEqual(r.decision, 'defer');
    assertEqual(r.cause, 'undeclared-writes');
    assertEqual(r.undeclared_side, 'counterpart',
      'o lado alheio é nomeado — o plano próprio declarou e não pode ser recusado por isso');
    assert(r.decision !== 'refuse', 'refuse é do lado próprio, nunca do alheio');
  });

  test('G2b: mesma colisão, postura block -> block (a postura decide, não o gate)', () => {
    const r = counterpartUndeclared('block', 5);
    assertEqual(r.decision, 'block');
    assertEqual(r.cause, 'undeclared-writes');
    assertEqual(r.floor, null, 'com alternativa ready, o piso D3 não é a razão do block');
  });
}

// ── G3: as duas causas, nunca uma no lugar da outra ────────────────────────
console.log('\nG3: overlap × undeclared-writes — nos dois sentidos');
{
  test('G3a: dois lados declarados que colidem -> cause overlap, com os paths', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
    }));
    assertEqual(r.cause, 'overlap');
    assert(r.cause !== 'undeclared-writes', 'overlap NUNCA reportado como undeclared-writes');
    assert(r.paths.length >= 1, 'a colisão medida deve nomear os caminhos');
    assertEqual(r.undeclared_side, null);
  });

  test('G3b: lado alheio sem declarar -> cause undeclared-writes, NUNCA overlap', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim([]) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
    }));
    assertEqual(r.cause, 'undeclared-writes');
    assert(r.cause !== 'overlap', 'undeclared-writes NUNCA reportado como overlap');
  });
}

// ── G4: proceed que CONFRONTOU ─────────────────────────────────────────────
console.log('\nG4: proceed/no-conflict — distinto de no-active-counterpart');
{
  test('G4: counterpart declarado sem sobreposição -> proceed/no-conflict com escopo >= 1', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/a.js']) },
      { id: 'M-other', write_claim: claim(['scripts/b.js']) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/a.js']), posture: 'defer', readyAlternatives: 0,
    }));
    assertEqual(r.decision, 'proceed');
    assertEqual(r.reason, 'no-conflict');
    assert(r.census.counterparts_in_scope >= 1,
      'um proceed que não confrontou nada não pode se vestir de confronto limpo');
    assert(r.reason !== 'no-active-counterpart', 'as duas razões de proceed são distintas');
  });
}

// ── G5: D7 — item concedido sem path ───────────────────────────────────────
console.log('\nG5: D7 — derivação de itens concedidos');
{
  test('G5a: itens com path -> elegível, com o :line removido e sem duplicatas', () => {
    const d = deriveClaimFromConcededItems([
      { r: 'R1', path: 'scripts/a.js:12' },
      { r: 'R2', path: 'scripts/a.js:88' },
      { r: 'R3', path: 'scripts/b.js' },
    ]);
    assertEqual(d.eligible, true);
    assertEqual(JSON.stringify(d.paths), JSON.stringify(['scripts/a.js', 'scripts/b.js']));
    assertEqual(d.source, 'review-fix-paths');
  });

  test('G5b: >= 1 item sem path -> pathless-conceded-item carregando os R#s (fixture sintético)', () => {
    const d = deriveClaimFromConcededItems([
      { r: 'R1', path: 'scripts/a.js:12' },
      { r: 'R7' },
      { r: 'R9', path: '' },
    ]);
    assertEqual(d.eligible, false);
    assertEqual(d.cause, 'pathless-conceded-item');
    assertEqual(JSON.stringify(d.pathless), JSON.stringify(['R7', 'R9']));
    assert(d.detail.includes('R7'), 'o detalhe deve nomear os itens sem path');
  });

  test('G5c: derivação pathless + counterpart em escopo -> refuse/pathless-conceded-item', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/a.js']) },
      { id: 'M-other', write_claim: claim(['scripts/z.js']) },
    ]);
    const d = deriveClaimFromConcededItems([{ r: 'R7' }]);
    const own = claim(d.paths, undefined, { eligible: d.eligible, cause: d.cause });
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: own, posture: 'defer', readyAlternatives: 4,
    }));
    assertEqual(r.decision, 'refuse');
    assertEqual(r.cause, 'pathless-conceded-item');
    assertEqual(r.undeclared_side, null, 'pathless não é "não declarou" — a causa é própria');
  });
}

// ── G6: D3 floor, with an EXECUTED bite ────────────────────────────────────
console.log('\nG6: piso D3 — defer sem alternativa vira block, com mordida executada');
{
  function deferNoAlternative(cwd) {
    return evaluateGate({
      cwd, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'defer', readyAlternatives: 0,
    });
  }

  const ws = makeFixture([
    { id: 'M-own', write_claim: claim(['scripts/x.js']) },
    { id: 'M-other', write_claim: claim(['scripts/x.js']) },
  ]);

  test('G6a: defer + ready_alternatives 0 -> block com floor "defer-floor"', () => {
    const r = record(deferNoAlternative(ws));
    assertEqual(r.decision, 'block');
    assertEqual(r.floor, 'defer-floor');
    assert(r.decision !== 'proceed', 'o piso NUNCA degrada para prosseguir (D3)');
  });

  test('G6b: defer + 1 alternativa ready -> defer (o piso só morde sem alternativa)', () => {
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'defer', readyAlternatives: 1,
    }));
    assertEqual(r.decision, 'defer');
    assertEqual(r.floor, null);
  });

  test('G6c: MORDIDA — neutralizar o piso numa cópia descartável deixa o assert vermelho', () => {
    const src = fs.readFileSync(MODULE, 'utf8');
    const needle = "if (decision === 'defer' && readyAlternatives === 0) {";
    const occurrences = src.split(needle).length - 1;
    assertEqual(occurrences, 1, 'a mordida precisa casar EXATAMENTE o piso — 0 ou 2 casamentos a tornariam vazia');

    // Copy lives beside the original so its relative `require`s still resolve.
    const biteFile = path.join(__dirname, 'forge-claim-gate.__bite__.js');
    fs.writeFileSync(biteFile, src.replace(needle, 'if (false) {'), 'utf8');
    try {
      // eslint-disable-next-line global-require
      const bitten = require(biteFile);
      const r = bitten.evaluateGate({
        cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'defer', readyAlternatives: 0,
      });
      assertEqual(r.decision, 'defer', 'com o piso neutralizado a decisão deixa de ser block — a mordida morde');
      assertEqual(r.floor, null);
      // And the real module, on the SAME input, still blocks:
      assertEqual(deferNoAlternative(ws).decision, 'block', 'o módulo real permanece intacto após a mordida');
    } finally {
      delete require.cache[require.resolve(biteFile)];
      fs.rmSync(biteFile, { force: true });
    }
  });
}

// ── G7: scope fails CLOSED ─────────────────────────────────────────────────
console.log('\nG7: escopo fail-closed (W2 / contrato #5)');
{
  test('G7a: counterpart com code_dir desconhecido FICA em escopo, com a note anexada', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js'], null) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
    }));
    assertEqual(r.census.counterparts_in_scope, 1, 'unknown NUNCA sai do escopo — excluir seria "ausência = seguro"');
    assertEqual(r.decision, 'block');
    assert(r.census.notes.some((n) => n.reason === 'code-dir-unknown'), 'a incerteza viaja como note');
    assert(r.counterparts.some((c) => c.scope === 'unknown' && c.note === 'code-dir-unknown'),
      'a note também fica anexada ao counterpart, não só ao censo');
  });

  test('G7b: só um code_dir MEDIDO diferente sai de escopo, com skip nomeado', () => {
    const a = mktmp();
    const b = mktmp();
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js'], a) },
      { id: 'M-other', write_claim: claim(['scripts/x.js'], b) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js'], a), posture: 'block', readyAlternatives: 1,
    }));
    assertEqual(r.census.counterparts_in_scope, 0);
    assert(r.census.skipped.some((s) => s.id === 'M-other' && s.reason === 'different-code-dir'),
      'o par fora de escopo é NOMEADO, nunca descartado em silêncio');
    assertEqual(r.decision, 'proceed');
    assertEqual(r.reason, 'no-active-counterpart');
  });
}

// ── G8: the S06/D8 seam ────────────────────────────────────────────────────
console.log('\nG8: seam de postura (W3/D8) — os DOIS RunRecords chegam');
{
  test('G8a: resolvePosture valida a pref e nomeia o valor fora do conjunto', () => {
    assertEqual(resolvePosture({ pref: 'block' }).posture, 'block');
    assertEqual(resolvePosture({ pref: 'defer' }).posture, 'defer');
    const bad = resolvePosture({ pref: 'sim-por-favor' });
    assertEqual(bad.posture, 'defer');
    assertEqual(bad.note, 'posture-invalid');
    assertEqual(bad.override, null, 'o override é de S06 (D8) — aqui é null por decisão, não por esquecimento');
  });

  test('G8b: o RunRecord da run ALHEIA (com isolation_mode) chega ao seam', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']), isolation_mode: 'branch' },
      { id: 'M-other', write_claim: claim(['scripts/x.js']), isolation_mode: 'worktree' },
    ]);
    const real = gate.resolvePosture;
    const seen = [];
    gate.resolvePosture = (opts) => { seen.push(opts); return real(opts); };
    try {
      evaluateGate({
        cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
      });
    } finally {
      gate.resolvePosture = real;
    }
    assertEqual(seen.length, 1, 'o seam deve ser atravessado exatamente uma vez por decisão de postura');
    const call = seen[0];
    assert(call.ownRun && call.ownRun.id === 'M-own', 'o RunRecord próprio chega ao seam');
    assert(call.counterpartRun && call.counterpartRun.id === 'M-other', 'o RunRecord ALHEIO chega ao seam');
    assertEqual(call.counterpartRun.isolation_mode, 'worktree',
      'o isolation_mode do counterpart é o campo que S06 vai ler — precisa chegar inteiro');
  });

  test('G8c: postura inválida com colisão -> note posture-invalid no censo', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'talvez', readyAlternatives: 2,
    }));
    assert(r.census.notes.some((n) => n.reason === 'posture-invalid'), 'pref inválida é NOMEADA, nunca aceita calada');
    assertEqual(r.decision, 'defer');
  });
}

// ── G9/G10: closed sets, both directions; enumeration on every result ──────
console.log('\nG9/G10: conjuntos fechados nos dois sentidos + enumeração em todo resultado');
{
  test('G10a: UNCOVERED_BOUNDARIES tem 3 entradas, cada uma com razão não vazia', () => {
    assertEqual(UNCOVERED_BOUNDARIES.length, 3);
    const names = UNCOVERED_BOUNDARIES.map((b) => b.boundary).sort().join(',');
    assertEqual(names, 'complete-slice,forge-task,orchestrator-writes');
    for (const b of UNCOVERED_BOUNDARIES) {
      assert(typeof b.reason === 'string' && b.reason.length > 10, `fronteira ${b.boundary} sem razão`);
    }
  });

  test('G10b: um resultado PROCEED também carrega not_covered e censo', () => {
    const ws = makeFixture([{ id: 'M-own', write_claim: claim(['scripts/a.js']) }]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/a.js']), posture: 'defer', readyAlternatives: 0,
    }));
    assertEqual(r.decision, 'proceed');
    assertEqual(r.not_covered.length, 3, 'a enumeração não pode sumir justamente no caminho feliz');
    assertEqual(typeof r.census.counterparts_considered, 'number');
  });

  // Direction 2: every declared value was emitted by >= 1 test above.
  test('G9a: toda decisão de GATE_DECISIONS foi emitida por >= 1 teste', () => {
    for (const d of GATE_DECISIONS) assert(decisionsSeen.has(d), `decisão declarada e nunca emitida: ${d}`);
  });
  test('G9b: toda causa de GATE_CAUSES foi emitida por >= 1 teste', () => {
    for (const c of GATE_CAUSES) assert(causesSeen.has(c), `causa declarada e nunca emitida: ${c}`);
  });
  test('G9c: toda razão de PROCEED_REASONS foi emitida por >= 1 teste', () => {
    for (const p of PROCEED_REASONS) assert(proceedReasonsSeen.has(p), `razão declarada e nunca emitida: ${p}`);
  });
  test('G9d: todo skip de GATE_SKIP_REASONS foi emitido por >= 1 teste', () => {
    for (const s of GATE_SKIP_REASONS) assert(skipsSeen.has(s), `skip declarado e nunca emitido: ${s}`);
  });
  test('G9e: toda note de GATE_NOTE_REASONS foi emitida por >= 1 teste', () => {
    for (const n of GATE_NOTE_REASONS) assert(notesSeen.has(n), `note declarada e nunca emitida: ${n}`);
  });
}

// ── G11: source guard + the S03 suites, by spawn, unedited ─────────────────
console.log('\nG11: guard de fonte (nunca writesConflict) + suítes de S03 por spawn');
{
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }
  const realSource = fs.readFileSync(MODULE, 'utf8');
  function guardPasses(src) {
    return !stripComments(src).includes('writesConflict');
  }

  test('G11a: o fonte real, sem comentários, NÃO contém "writesConflict"', () => {
    assert(guardPasses(realSource), 'writesConflict vazou para forge-claim-gate.js — a polaridade errada');
  });
  test('G11b: controle positivo — cópia com a chamada injetada é REPROVADA pelo mesmo predicado', () => {
    assert(!guardPasses(`${realSource}\nconst x = writesConflict(a, b);\n`),
      'o guard não mordeu a chamada injetada — controle positivo falhou (guard cego)');
  });
  test('G11c: controle negativo — menção apenas em comentário NÃO reprova', () => {
    assert(guardPasses(`${realSource}\n// writesConflict citado só em prosa\n`),
      'o guard deu falso positivo numa menção que é só comentário');
  });

  test('G11d: forge-claim-polarity.test.js passa por SPAWN, sem edição', () => {
    const r = spawnSync(process.execPath, [POLARITY_TEST], { encoding: 'utf8' });
    assertEqual(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  });
  test('G11e: forge-claim-overlap.test.js passa por SPAWN, sem edição', () => {
    const r = spawnSync(process.execPath, [OVERLAP_TEST], { encoding: 'utf8' });
    assertEqual(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  });
}

// ── G12: CLI posture — enforcing, not advisory ─────────────────────────────
console.log('\nG12: CLI — exit 0 quando avaliou, 2 em usage, != 0 em erro interno');
{
  test('G12a: --evaluate com uma fonte e uma decisão refuse -> exit 0, decisão no JSON', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim([]) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const r = runCli(['--evaluate', '--paths', '', '--run', 'M-own', '--cwd', ws, '--json']);
    assertEqual(r.status, 0, `a decisão viaja no payload, não no exit code\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assertEqual(out.decision, 'refuse');
    assertEqual(out.not_covered.length, 3);
  });

  test('G12b: --evaluate com colisão real -> exit 0 e block impresso na forma legível', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const r = runCli(['--evaluate', '--paths', 'scripts/x.js', '--run', 'M-own', '--cwd', ws, '--posture', 'block']);
    assertEqual(r.status, 0);
    assert(r.stdout.includes('block'), `esperava block no stdout, veio:\n${r.stdout}`);
    assert(r.stdout.includes('fronteira não coberta'), 'a enumeração também é impressa na forma legível');
  });

  test('G12c: duas fontes de claim -> exit 2 (usage), nada avaliado', () => {
    const r = runCli(['--evaluate', '--paths', 'a.js', '--plan', 'x.md', '--run', 'M-own']);
    assertEqual(r.status, 2);
  });

  test('G12d: sem --run -> exit 2 (usage)', () => {
    const r = runCli(['--evaluate', '--paths', 'a.js']);
    assertEqual(r.status, 2);
  });

  test('G12e: erro interno (plano inexistente) -> exit != 0 — este gate falha FECHADO', () => {
    const ws = makeFixture([{ id: 'M-own', write_claim: claim(['a.js']) }]);
    const r = runCli(['--evaluate', '--plan', 'nao/existe/T99-PLAN.md', '--run', 'M-own', '--cwd', ws]);
    assert(r.status !== 0, 'exit 0 num erro interno faria um gate quebrado parecer aprovação');
    assert(r.stderr.includes('forge-claim-gate'), 'o erro é nomeado em stderr');
  });
}

// ── Derivation from a real plan file ───────────────────────────────────────
console.log('\nG13: deriveClaimFromPlan — reuso de declaredFor, legacy ≠ vazio honesto');
{
  function planFixture(body) {
    const tmp = mktmp();
    const rel = '.gsd/milestones/M-x/slices/S01/tasks/T01/T01-PLAN.md';
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
    return { cwd: tmp, rel };
  }

  test('G13a: plano com writes: e expected_output: -> união declarada, elegível', () => {
    const { cwd, rel } = planFixture([
      '---', 'id: T01', 'writes:', '  - "scripts/a.js"',
      'must_haves:', '  truths:', '    - "t"',
      '  artifacts:', '    - path: "scripts/a.js"', '      provides: "algo"', '      min_lines: 1',
      '  key_links: []',
      'expected_output:', '  - scripts/b.js', '---', '', '# T01', '',
    ].join('\n'));
    const d = deriveClaimFromPlan(cwd, rel);
    assertEqual(d.eligible, true);
    assertEqual(d.source, 'plan-writes');
    assertEqual(JSON.stringify(d.paths), JSON.stringify(['scripts/a.js', 'scripts/b.js']));
  });

  test('G13b: plano legacy (sem must_haves estruturado) -> detail legacy-plan-schema, NÃO "vazio honesto"', () => {
    const { cwd, rel } = planFixture('---\nid: T01\n---\n\n# T01 legacy\n');
    const d = deriveClaimFromPlan(cwd, rel);
    assertEqual(d.eligible, false);
    assertEqual(d.cause, 'undeclared-writes');
    assert(d.detail.startsWith('legacy-plan-schema'), `detail deve nomear o schema legacy, veio ${d.detail}`);
  });

  test('G13c: plano estruturado sem nenhum path -> detail declared-empty (fato diferente de legacy)', () => {
    const { cwd, rel } = planFixture([
      '---', 'id: T01',
      'must_haves:', '  truths:', '    - "t"', '  artifacts: []', '  key_links: []',
      'expected_output: []', '---', '', '# T01', '',
    ].join('\n'));
    const d = deriveClaimFromPlan(cwd, rel);
    assertEqual(d.eligible, false);
    assertEqual(d.detail, 'declared-empty');
  });

  test('G13d: plano ilegível LANÇA — nunca vira claim elegível vazio', () => {
    let threw = false;
    try { deriveClaimFromPlan(mktmp(), 'nao/existe.md'); } catch (_) { threw = true; }
    assert(threw, 'um plano ilegível precisa falhar fechado, não degradar para "não declara nada"');
  });
}

// --- Summary ---
cleanup();
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
