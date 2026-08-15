#!/usr/bin/env node
'use strict';

// forge-resources-census.test.js — the census that cannot lie about its own work.
//
//   R1  dual-field: a fixture carrying ONLY `event: rewrite-applied` (the
//       forge-hook.js shape) is COUNTED, not discarded. A `kind`-only reader
//       loses 100% of S03's rewrite stream; this is the test that proves the
//       loss does not happen.
//   R2  keyed-by-reason: `kind: resource-admission` + `reason:
//       platform-unsupported:linux` lands as DEGRADATION. Counting by `kind`
//       would see none, because platform degradation is fail-open.
//   R3  an unregistered reason surfaces as `reason-unregistered:<value>` with
//       a count — never dropped.
//   R4  the floor, BOTH halves: zero events AND zero resource-events each
//       yield `inconclusive`, with `verdict !== 'clean'` asserted explicitly.
//   R5  the floor BITES: mutant copies of the source, one per half, make R4's
//       assertions fail. A floor never seen failing is not a floor (TASK-021).
//   R6  `clean` requires real work; `degraded` fires on degradation.
//   R7  W3 in all three states: unreconciled / inconsistent / reconciled, and
//       `non_candidates` is never negative.
//   R8  bounded tail: a fixture LARGER than the window returns only the final
//       event, and the whole file is never read.
//   R9  a malformed JSON line is skipped with a NAME and the remaining lines
//       keep being read.
//   R10 REASON_REGISTRY is enum-derived (crossed against the four sources) and
//       no reason string is retyped as a literal in the module.
//   R11 CENSUS_SKIP_REASONS / CENSUS_VERDICTS crossed in BOTH directions.
//   R12 exit 0 always, asserted by SPAWNING the CLI — including on `degraded`.
//   R13 HARD SAFETY: the operator's live .gsd/forge/events.jsonl was never written.
//
// Every fixture lives in a tmpdir. Zero deps.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-resources-census.js');
const census = require('./forge-resources-census.js');
const {
  collectResourceEvents, buildCensus, reconcileW3, readLastResourceEvent,
  formatCensus, REASON_REGISTRY, REASON_OWNERS, DEGRADATION_REASONS,
  CENSUS_VERDICTS, CENSUS_SKIP_REASONS,
} = census;

const { REASON_CODES } = require('./forge-resources.js');
const { POOL_REASON_CODES } = require('./forge-resource-pool.js');
const {
  TOKENIZE_REFUSAL_REASONS, REWRITE_REASON_CODES,
} = require('./forge-command-rewrite.js');

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

// ── tmp fixtures ────────────────────────────────────────────────────────────
const tmps = [];
function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-census-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Build a fixture cwd with `.gsd/forge/events.jsonl` holding `lines`. */
function fixture(lines, evidence) {
  const root = mktmp();
  const forgeDir = path.join(root, '.gsd', 'forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  const body = (lines || []).map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  fs.writeFileSync(path.join(forgeDir, 'events.jsonl'), body ? `${body}\n` : '');
  if (evidence) {
    const ev = evidence.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
    fs.writeFileSync(path.join(forgeDir, 'evidence-T01.jsonl'), ev ? `${ev}\n` : '');
  }
  return root;
}

function run(cwd) {
  const collected = collectResourceEvents(cwd, {});
  return buildCensus(collected);
}

// ── R13 (opening half) ──────────────────────────────────────────────────────
const LIVE_EVENTS = path.join(__dirname, '..', '.gsd', 'forge', 'events.jsonl');
function liveStamp() {
  try {
    const st = fs.statSync(LIVE_EVENTS);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'absent';
  }
}
const LIVE_BEFORE = liveStamp();

console.log('\nforge-resources-census\n');

// ── R1: dual field ──────────────────────────────────────────────────────────

test('R1: um evento SÓ com `event` (forma do forge-hook) é contado, não descartado', () => {
  const cwd = fixture([
    { ts: '2026-08-14T00:00:00Z', event: 'rewrite-applied', runner: 'vitest', workers: 2 },
  ]);
  const c = collectResourceEvents(cwd, {});
  assertEqual(c.events_scanned, 1, 'events_scanned');
  assertEqual(c.resource_events, 1, 'evento de `event` DEVE ser contado');
  assertEqual(c.entries[0].name, 'rewrite-applied', 'nome vindo de `event`');
});

test('R1: `kind` e `event` convivem no mesmo arquivo, ambos contados', () => {
  const cwd = fixture([
    { ts: 1, kind: 'resource-admission', reason: REASON_CODES.PRESSURE_NORMAL },
    { ts: 2, event: 'rewrite-skipped', reason: REWRITE_REASON_CODES.INTACT_NOT_RUNNER },
  ]);
  const c = collectResourceEvents(cwd, {});
  assertEqual(c.resource_events, 2, 'os dois campos devem ser aceitos');
});

test('R1: `kind` tem precedência quando ambos os campos existem', () => {
  const cwd = fixture([{ kind: 'shadow-wait', event: 'rewrite-applied', reason: REASON_CODES.SHADOW_WAIT }]);
  const c = collectResourceEvents(cwd, {});
  assertEqual(c.entries[0].name, 'shadow-wait', 'kind ?? event');
});

// ── R2: keyed on reason, not kind ───────────────────────────────────────────

test('R2: platform-unsupported:linux sob kind:resource-admission conta como DEGRADAÇÃO', () => {
  const cwd = fixture([
    { kind: 'resource-admission', reason: REASON_CODES.PLATFORM_UNSUPPORTED_LINUX, workers: 1 },
  ]);
  const r = run(cwd);
  assertEqual(r.verdict, 'degraded', 'fail-open não pode esconder a degradação');
  assertEqual(r.degraded_count, 1, 'degraded_count');
  const row = r.reasons.find((x) => x.reason === REASON_CODES.PLATFORM_UNSUPPORTED_LINUX);
  assert(row, 'razão de plataforma presente no censo');
  assertEqual(row.owner, 'resources', 'owner');
  assertEqual(row.registered, true, 'registrada');
  assert(row.kinds.includes('resource-admission'), 'kind entra como dimensão secundária');
});

test('R2: contar por kind NÃO veria a degradação — o kind é de admissão', () => {
  const cwd = fixture([
    { kind: 'resource-admission', reason: REASON_CODES.PLATFORM_UNSUPPORTED_LINUX },
  ]);
  const c = collectResourceEvents(cwd, {});
  assertEqual(c.entries.filter((e) => e.name === 'resource-degradation').length, 0,
    'nenhum kind de degradação — é exatamente por isso que o censo é keyed no reason');
  assertEqual(buildCensus(c).verdict, 'degraded', 'e ainda assim o veredicto é degraded');
});

// ── R3: unregistered reason ─────────────────────────────────────────────────

test('R3: razão fora do registro vira reason-unregistered:<valor> com contagem', () => {
  // `intact:admission-refused-advisory` is a REGISTERED reason (I-20260814120100)
  // — using it here would silently stop testing the fallback. A genuinely
  // bogus reason keeps this test honest about what it proves.
  const cwd = fixture([
    { kind: 'resource-clamp-skipped', reason: 'intact:some-bogus-unregistered-reason' },
    { kind: 'resource-clamp-skipped', reason: 'intact:some-bogus-unregistered-reason' },
  ]);
  const r = run(cwd);
  const row = r.reasons.find((x) => x.reason === 'reason-unregistered:intact:some-bogus-unregistered-reason');
  assert(row, 'razão não registrada deve aparecer, nunca sumir');
  assertEqual(row.count, 2, 'contagem');
  assertEqual(row.registered, false, 'registered:false');
  assertEqual(r.unregistered_reasons, 1, 'unregistered_reasons');
});

test('R3: razão não registrada NÃO inventa degradação (desconhecido ≠ quebrado)', () => {
  const cwd = fixture([{ kind: 'resource-clamp-skipped', reason: 'algo-totalmente-novo' }]);
  const r = run(cwd);
  assertEqual(r.degraded_count, 0, 'nenhuma degradação inventada');
  assertEqual(r.verdict, 'clean', 'mas o stream foi examinado de verdade');
  assertEqual(r.unregistered_reasons, 1, 'e a razão desconhecida está visível no censo');
});

test('R3: evento sem reason usa o nome do evento como chave, marcado from_event_name', () => {
  const cwd = fixture([{ event: 'rewrite-applied', runner: 'jest' }]);
  const r = run(cwd);
  const row = r.reasons.find((x) => x.reason === 'reason-unregistered:rewrite-applied');
  assert(row, 'fallback para o nome do evento');
  assertEqual(row.from_event_name, true, 'distinguível de uma razão desconhecida de verdade');
});

test('R3: stale-lease-reaped — o kind É o reason code, e ele É registrado', () => {
  const cwd = fixture([{ kind: 'stale-lease-reaped', slot: 'resource-pool/slot-1' }]);
  const r = run(cwd);
  const row = r.reasons.find((x) => x.reason === POOL_REASON_CODES.STALE_LEASE_REAPED);
  assert(row, 'stale-lease-reaped resolvido pelo registro mesmo sem campo reason');
  assertEqual(row.registered, true, 'está em POOL_REASON_CODES');
  assertEqual(row.owner, 'pool', 'owner');
  assertEqual(r.verdict, 'degraded', 'lease reapeada é degradação');
});

// ── R4: the floor, both halves ──────────────────────────────────────────────

test('R4a: zero eventos → inconclusive, NUNCA clean', () => {
  const cwd = fixture([]);
  const r = run(cwd);
  assertEqual(r.verdict, 'inconclusive', 'piso');
  assert(r.verdict !== 'clean', 'clean é proibido sem trabalho feito');
  assert(/events-file-empty/.test(r.reason), `razão nomeada, veio: ${r.reason}`);
});

test('R4a: arquivo de eventos AUSENTE → inconclusive com skip nomeado', () => {
  const root = mktmp();
  const r = run(root);
  assertEqual(r.verdict, 'inconclusive', 'piso');
  assertEqual(r.skipped[0].reason, 'events-file-missing', 'skip nomeado');
});

test('R4b: 900 eventos de OUTRO stream, zero de recursos → inconclusive, NUNCA clean', () => {
  const lines = [];
  for (let i = 0; i < 900; i++) lines.push({ ts: i, unit: 'execute-task/T01', agent: 'forge-executor' });
  const cwd = fixture(lines);
  const r = run(cwd);
  assertEqual(r.events_scanned, 900, 'varreu de verdade');
  assertEqual(r.resource_events, 0, 'nenhum de recursos');
  assertEqual(r.verdict, 'inconclusive', 'a metade do piso que este slice existe para ter');
  assert(r.verdict !== 'clean', 'zero de recursos NUNCA é "saúde"');
  assert(/no-resource-events/.test(r.reason), `razão nomeada, veio: ${r.reason}`);
});

test('R4: todo relatório carrega censo completo', () => {
  const cwd = fixture([{ kind: 'resource-admission', reason: REASON_CODES.PRESSURE_NORMAL }]);
  const r = run(cwd);
  for (const k of ['events_scanned', 'resource_events', 'degraded_count', 'reasons', 'skipped', 'sources', 'verdict', 'reason']) {
    assert(Object.prototype.hasOwnProperty.call(r, k), `censo deve carregar ${k}`);
  }
  assertEqual(r.sources.length, 1, 'sources[] nomeia o arquivo lido');
});

// ── R5: the floor BITES ─────────────────────────────────────────────────────

function mutant(find, replace) {
  const src = fs.readFileSync(MODULE, 'utf8');
  assert(src.includes(find), `âncora do mutante não encontrada: ${find}`);
  const dir = mktmp('forge-census-mutant-');
  // Copy the sibling deps' resolution by writing the mutant INTO scripts/ is
  // unsafe; instead point the mutant at the real modules via absolute require.
  const patched = src
    .replace(find, replace)
    .replace(/require\('\.\/(forge-[a-z-]+\.js)'\)/g,
      (_m, f) => `require(${JSON.stringify(path.join(__dirname, '$F').replace('$F', f))})`);
  const p = path.join(dir, 'mutant.js');
  fs.writeFileSync(p, patched);
  return require(p);
}

// A subsumção é deliberada e está documentada no cabeçalho do módulo:
// `events_scanned === 0` implica `resource_events === 0`, então a 2ª metade
// segura o veredicto sozinha. A 1ª metade existe pela RAZÃO que produz. Este
// teste morde exatamente isso — e o teste seguinte morde o veredicto.
test('R5: mutar a 1ª metade do piso degrada a RAZÃO (o que ela realmente compra)', () => {
  const m = mutant(
    "  if (events_scanned === 0) {\n    verdict = 'inconclusive';",
    "  if (false) {\n    verdict = 'inconclusive';",
  );
  const input = { events_scanned: 0, resource_events: 0, entries: [], skipped: [], sources: [] };
  const real = buildCensus(input);
  const mut = m.buildCensus(input);
  assertEqual(real.reason.includes('events-file-empty'), true, 'o real distingue "nada foi escrito"');
  assertEqual(mut.verdict, 'inconclusive', 'a 2ª metade ainda segura o veredicto (subsunção deliberada)');
  assert(!mut.reason.includes('events-file-empty'),
    'sem a 1ª metade a razão degrada para a genérica — a perda que ela previne');
  assert(real.reason !== mut.reason, 'a mordida é sobre a razão, e ela precisa ser visível');
});

test('R5: mutar AS DUAS metades produz o `clean` mentiroso com zero eventos', () => {
  const m = mutant(
    "  if (events_scanned === 0) {\n    verdict = 'inconclusive';",
    "  if (false) {\n    verdict = 'inconclusive';",
  );
  // O módulo mutante já perdeu a 1ª metade; derruba a 2ª no mesmo texto.
  const src = fs.readFileSync(MODULE, 'utf8');
  assert(src.includes("  } else if (resource_events === 0) {"), 'âncora da 2ª metade');
  const both = mutant(
    "  if (events_scanned === 0) {\n    verdict = 'inconclusive';",
    "  if (false) {\n    verdict = 'inconclusive';",
  );
  assert(m && both, 'mutantes construídos');
  const dir = mktmp('forge-census-mutant-both-');
  const patched = src
    .replace("  if (events_scanned === 0) {\n    verdict = 'inconclusive';", "  if (false) {\n    verdict = 'inconclusive';")
    .replace("  } else if (resource_events === 0) {", "  } else if (false) {")
    .replace(/require\('\.\/(forge-[a-z-]+\.js)'\)/g,
      (_x, f) => `require(${JSON.stringify(path.join(__dirname, '$F').replace('$F', f))})`);
  const p = path.join(dir, 'mutant-both.js');
  fs.writeFileSync(p, patched);
  const mb = require(p);
  const r = mb.buildCensus({ events_scanned: 0, resource_events: 0, entries: [], skipped: [], sources: [] });
  assertEqual(r.verdict, 'clean',
    'sem NENHUMA das metades, zero eventos lê como saúde — o piso inteiro é o que impede isso');
});

test('R5: mutar a 2ª metade do piso (resource_events) faz R4b virar RED', () => {
  const m = mutant(
    "  } else if (resource_events === 0) {",
    "  } else if (false) {",
  );
  const r = m.buildCensus({ events_scanned: 900, resource_events: 0, entries: [], skipped: [], sources: [] });
  assertEqual(r.verdict, 'clean', 'sem a 2ª metade, 900 eventos alheios lêem como saúde — o bug que este slice previne');
});

// ── R6: clean and degraded ──────────────────────────────────────────────────

test('R6: stream real sem degradação → clean', () => {
  const cwd = fixture([
    { kind: 'resource-admission', reason: REASON_CODES.PRESSURE_NORMAL },
    { kind: 'resource-pool-granted', reason: POOL_REASON_CODES.POOL_GRANTED },
  ]);
  const r = run(cwd);
  assertEqual(r.verdict, 'clean', 'clean exige trabalho feito — e aqui houve');
  assertEqual(r.resource_events, 2, 'lastro do clean');
  assertEqual(r.degraded_count, 0, 'sem degradação');
});

test('R6: shadow-wait NÃO é degradação (é a postura desenhada, D3)', () => {
  const cwd = fixture([{ kind: 'shadow-wait', reason: REASON_CODES.SHADOW_WAIT, wouldWaitMs: 1000 }]);
  const r = run(cwd);
  assertEqual(r.verdict, 'clean', 'modo sombra é o desenho desta milestone');
});

test('R6: pool-unavailable-fail-open e sysctl-spawn-failed são degradação', () => {
  for (const reason of [POOL_REASON_CODES.POOL_UNAVAILABLE_FAIL_OPEN, REASON_CODES.SYSCTL_SPAWN_FAILED]) {
    const cwd = fixture([{ kind: 'resource-admission', reason }]);
    assertEqual(run(cwd).verdict, 'degraded', `${reason} deve degradar`);
  }
});

// ── R7: W3 ──────────────────────────────────────────────────────────────────

test('R7: sem log de evidência → unreconciled/evidence-log-empty, jamais 100%', () => {
  const cwd = fixture([{ event: 'rewrite-applied' }]);
  const w = reconcileW3(cwd, collectResourceEvents(cwd, {}), {});
  assertEqual(w.status, 'unreconciled', 'status');
  assertEqual(w.reason, 'evidence-log-empty', 'razão nomeada');
  assert(!Object.prototype.hasOwnProperty.call(w, 'non_candidates'), 'não afirma cobertura');
});

test('R7: log de evidência presente mas com zero linhas Bash → unreconciled', () => {
  const cwd = fixture([{ event: 'rewrite-applied' }], [{ tool: 'Write', file: 'a.js', ok: true }]);
  const w = reconcileW3(cwd, collectResourceEvents(cwd, {}), {});
  assertEqual(w.status, 'unreconciled', 'zero Bash é o mesmo vazio');
  assertEqual(w.bash_total, 0, 'bash_total');
});

test('R7: rewrite_events > bash_total → inconsistent, sem aritmética negativa', () => {
  const cwd = fixture(
    [{ event: 'rewrite-applied' }, { event: 'rewrite-skipped', reason: 'x' }, { event: 'rewrite-applied' }],
    [{ tool: 'Bash', cmd: 'npm test', ok: true }],
  );
  const w = reconcileW3(cwd, collectResourceEvents(cwd, {}), {});
  assertEqual(w.status, 'inconsistent', 'status');
  assertEqual(w.reason, 'candidates-exceed-evidence', 'razão nomeada');
  assertEqual(w.rewrite_events, 3, 'candidatos');
  assertEqual(w.bash_total, 1, 'evidência');
  assert(w.non_candidates === undefined || w.non_candidates >= 0, 'nunca negativo');
});

test('R7: caso normal → reconciled com non_candidates = bash_total - rewrite_events', () => {
  const cwd = fixture(
    [{ event: 'rewrite-applied' }, { event: 'rewrite-skipped', reason: 'y' }],
    [
      { tool: 'Bash', cmd: 'npm test', ok: true },
      { tool: 'Bash', cmd: 'ls', ok: true },
      { tool: 'Bash', cmd: 'git status', ok: true },
      { tool: 'Write', file: 'a.js', ok: true },
    ],
  );
  const w = reconcileW3(cwd, collectResourceEvents(cwd, {}), {});
  assertEqual(w.status, 'reconciled', 'status');
  assertEqual(w.bash_total, 3, 'só linhas tool==="Bash"');
  assertEqual(w.rewrite_events, 2, 'candidatos');
  assertEqual(w.non_candidates, 1, 'reconciliação de CONTAGEM, nunca de string');
});

test('R2: reason que atravessa kinds não faz reconcileW3(census) divergir de reconcileW3(collected)', () => {
  const cwd = fixture(
    [
      // Same reason, one non-rewrite kind and one rewrite kind — the
      // fallback branch must count only the rewrite-kind occurrence, never
      // the whole merged row.
      { kind: 'resource-clamp-skipped', reason: REWRITE_REASON_CODES.INTACT_NOT_RUNNER },
      { kind: 'rewrite-skipped', reason: REWRITE_REASON_CODES.INTACT_NOT_RUNNER },
      { event: 'rewrite-applied' },
    ],
    [
      { tool: 'Bash', cmd: 'npm test', ok: true },
      { tool: 'Bash', cmd: 'ls', ok: true },
    ],
  );
  const collected = collectResourceEvents(cwd, {});
  const c = buildCensus(collected);
  const wFromCollected = reconcileW3(cwd, collected, {});
  const wFromCensus = reconcileW3(cwd, c, {});
  assertEqual(wFromCollected.rewrite_events, 2, 'via entries: 1 rewrite-skipped + 1 rewrite-applied');
  assertEqual(wFromCensus.rewrite_events, wFromCollected.rewrite_events,
    'via reasons (fallback) deve concordar com via entries — sem overcounting por kind cruzado');
  assertEqual(wFromCensus.status, wFromCollected.status, 'os dois caminhos públicos devem concordar em status');
});

// ── R8: bounded tail ────────────────────────────────────────────────────────

test('R8: cauda limitada — fixture MAIOR que a janela devolve só o evento final', () => {
  const lines = [];
  for (let i = 0; i < 400; i++) {
    lines.push({ ts: i, kind: 'resource-admission', reason: REASON_CODES.PRESSURE_NORMAL, pad: 'x'.repeat(60) });
  }
  lines.push({ ts: 'ultimo', kind: 'resource-degradation', reason: REASON_CODES.PRESSURE_CRITICAL_MEASURED });
  const cwd = fixture(lines);
  const size = fs.statSync(path.join(cwd, '.gsd', 'forge', 'events.jsonl')).size;
  assert(size > 8192, `fixture precisa exceder a janela; tem ${size} bytes`);

  const last = readLastResourceEvent(cwd, {});
  assert(last, 'deve achar o último evento');
  assertEqual(last.name, 'resource-degradation', 'nome');
  assertEqual(last.reason, REASON_CODES.PRESSURE_CRITICAL_MEASURED, 'reason');
  assertEqual(last.ts, 'ultimo', 'é o ÚLTIMO, não um qualquer');
});

test('R8: janela minúscula não estoura na primeira linha parcial', () => {
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push({ ts: i, kind: 'shadow-wait', reason: REASON_CODES.SHADOW_WAIT });
  const cwd = fixture(lines);
  const last = readLastResourceEvent(cwd, { tailBytes: 120 });
  assert(last === null || last.name === 'shadow-wait', 'nunca lança, nunca devolve lixo');
});

test('R8: arquivo ausente → null, sem lançar (MEM008)', () => {
  assertEqual(readLastResourceEvent(mktmp(), {}), null, 'render nunca quebra');
});

test('R8: eventos de outro stream no fim são ignorados pela cauda', () => {
  const cwd = fixture([
    { kind: 'resource-pool-released', reason: POOL_REASON_CODES.POOL_RELEASED },
    { unit: 'execute-task/T01', agent: 'forge-executor' },
    { unit: 'execute-task/T02', agent: 'forge-executor' },
  ]);
  const last = readLastResourceEvent(cwd, {});
  assert(last, 'varre de trás pra frente até achar um de recursos');
  assertEqual(last.name, 'resource-pool-released', 'nome');
});

// ── R9: malformed line ──────────────────────────────────────────────────────

test('R9: linha JSON malformada é pulada COM NOME e as demais continuam sendo lidas', () => {
  const cwd = fixture([
    JSON.stringify({ kind: 'resource-admission', reason: REASON_CODES.PRESSURE_NORMAL }),
    '{"kind": "resource-admission", TRUNCADO',
    JSON.stringify({ kind: 'resource-pool-granted', reason: POOL_REASON_CODES.POOL_GRANTED }),
  ]);
  const c = collectResourceEvents(cwd, {});
  assertEqual(c.events_scanned, 3, 'a linha ruim TAMBÉM foi examinada');
  assertEqual(c.resource_events, 2, 'as boas continuaram sendo lidas');
  const bad = c.skipped.find((s) => s.reason === 'line-not-json');
  assert(bad, 'skip nomeado');
  assert(/:2$/.test(bad.id), `id deve apontar a linha, veio ${bad.id}`);
});

test('R9: linha sem kind nem event → line-without-event-name', () => {
  const cwd = fixture([{ ts: 1, foo: 'bar' }]);
  const c = collectResourceEvents(cwd, {});
  assertEqual(c.skipped[0].reason, 'line-without-event-name', 'skip nomeado');
});

test('R9: evento de outro stream → event-not-resource-related, contado', () => {
  const cwd = fixture([{ unit: 'execute-task/T01', agent: 'forge-executor', kind: 'dispatch' }]);
  const c = collectResourceEvents(cwd, {});
  assertEqual(c.events_scanned, 1, 'contado');
  assertEqual(c.skipped[0].reason, 'event-not-resource-related', 'nomeado, não sumido');
});

// ── R10: registry is enum-derived ───────────────────────────────────────────

test('R10: REASON_REGISTRY contém TODO membro dos quatro enums, com o owner certo', () => {
  const sources = [
    ['resources', REASON_CODES],
    ['pool', POOL_REASON_CODES],
    ['tokenize', TOKENIZE_REFUSAL_REASONS],
    ['rewrite', REWRITE_REASON_CODES],
  ];
  let n = 0;
  for (const [owner, enumObj] of sources) {
    for (const value of Object.values(enumObj)) {
      n++;
      assert(Object.prototype.hasOwnProperty.call(REASON_REGISTRY, value),
        `${value} deve estar no registro`);
      assertEqual(REASON_REGISTRY[value].owner, owner, `owner de ${value}`);
    }
  }
  assert(n >= 40, `os quatro enums devem somar dezenas de códigos, somaram ${n}`);
  assertEqual(Object.keys(REASON_REGISTRY).length, n, 'nada além dos enums entra no registro');
});

test('R10: nenhuma string de razão é redigitada como literal no módulo', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  // Strip comments — the header legitimately NAMES reasons in prose.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const offenders = [];
  for (const value of Object.keys(REASON_REGISTRY)) {
    if (code.includes(`'${value}'`) || code.includes(`"${value}"`)) offenders.push(value);
  }
  assertEqual(offenders.length, 0,
    `razões devem vir dos enums, não de literais. Redigitadas: ${offenders.join(', ')}`);
});

test('R10: REASON_OWNERS bate com os owners realmente emitidos', () => {
  const emitted = new Set(Object.values(REASON_REGISTRY).map((v) => v.owner));
  for (const o of REASON_OWNERS) assert(emitted.has(o), `owner ${o} declarado mas nunca emitido`);
  for (const o of emitted) assert(REASON_OWNERS.includes(o), `owner ${o} emitido mas não declarado`);
});

test('R10: DEGRADATION_REASONS ⊆ REASON_REGISTRY (nenhuma razão fantasma)', () => {
  for (const r of DEGRADATION_REASONS) {
    assert(Object.prototype.hasOwnProperty.call(REASON_REGISTRY, r),
      `${r} degrada mas não está no registro — seria inalcançável`);
  }
  assert(DEGRADATION_REASONS.size >= 8, 'o conjunto de degradação não pode estar vazio ou raquítico');
});

// ── R11: closed enums crossed both ways ─────────────────────────────────────

test('R11: CENSUS_VERDICTS é fechado e todo veredicto emitido pertence a ele', () => {
  const seen = new Set();
  seen.add(run(fixture([])).verdict);
  seen.add(run(fixture([{ unit: 'x', agent: 'y' }])).verdict);
  seen.add(run(fixture([{ kind: 'resource-admission', reason: REASON_CODES.PRESSURE_NORMAL }])).verdict);
  seen.add(run(fixture([{ kind: 'resource-admission', reason: REASON_CODES.SYSCTL_PARSE_FAILED }])).verdict);
  for (const v of seen) assert(CENSUS_VERDICTS.includes(v), `veredicto ${v} fora do enum`);
  for (const v of CENSUS_VERDICTS) assert(seen.has(v), `veredicto ${v} declarado mas nunca alcançado`);
});

test('R11: toda razão de skip emitida está em CENSUS_SKIP_REASONS, e vice-versa', () => {
  const seen = new Set();
  const collect = (cwd) => { for (const s of collectResourceEvents(cwd, {}).skipped) seen.add(s.reason); };

  collect(mktmp());                                        // events-file-missing
  collect(fixture(['{nao json']));                          // line-not-json
  collect(fixture([{ ts: 1 }]));                            // line-without-event-name
  collect(fixture([{ kind: 'dispatch' }]));                 // event-not-resource-related

  // events-file-unreadable: a DIRECTORY where the file should be.
  const bad = mktmp();
  fs.mkdirSync(path.join(bad, '.gsd', 'forge', 'events.jsonl'), { recursive: true });
  collect(bad);

  // evidence-log-empty / evidence-file-unreadable via reconcileW3.
  const c1 = fixture([{ event: 'rewrite-applied' }]);
  for (const s of reconcileW3(c1, collectResourceEvents(c1, {}), {}).skipped) seen.add(s.reason);
  const c2 = fixture([{ event: 'rewrite-applied' }]);
  fs.mkdirSync(path.join(c2, '.gsd', 'forge', 'evidence-BAD.jsonl'), { recursive: true });
  for (const s of reconcileW3(c2, collectResourceEvents(c2, {}), {}).skipped) seen.add(s.reason);

  for (const r of seen) assert(CENSUS_SKIP_REASONS.includes(r), `razão ${r} emitida mas não enumerada`);
  for (const r of CENSUS_SKIP_REASONS) assert(seen.has(r), `razão ${r} enumerada mas nunca emitida (entrada morta)`);
});

// ── R12: formatter + exit 0 by spawn ────────────────────────────────────────

test('R12: formatCensus nomeia veredicto, razão, censo, razões e pulados', () => {
  const cwd = fixture([
    { kind: 'resource-admission', reason: REASON_CODES.PLATFORM_UNSUPPORTED_LINUX },
    '{quebrada',
  ]);
  const r = run(cwd);
  const out = formatCensus(r);
  assert(out.startsWith('forge-resources-census: degraded — '), `1ª linha, veio: ${out.split('\n')[0]}`);
  assert(out.includes('censo:'), 'censo presente');
  assert(out.includes(REASON_CODES.PLATFORM_UNSUPPORTED_LINUX), 'razão nomeada');
  assert(out.includes('line-not-json'), 'pulado nomeado');
});

test('R12: pulados são AGREGADOS por razão — 300 alheios não viram 300 linhas', () => {
  const lines = [];
  // `kind: 'dispatch'` — um evento REAL de outro stream (tem nome, não é de
  // recursos). Sem o `kind` a linha cairia em `line-without-event-name`, que é
  // outra razão: as duas convivem no log vivo deste repo (290 e 17).
  for (let i = 0; i < 300; i++) lines.push({ ts: i, kind: 'dispatch', unit: 'execute-task/T01' });
  lines.push({ kind: 'resource-admission', reason: REASON_CODES.PRESSURE_NORMAL });
  const r = run(fixture(lines));
  assertEqual(r.skipped.length, 300, 'o dado exaustivo continua íntegro (é o que vai no --json)');
  const out = formatCensus(r);
  const skipLines = out.split('\n').filter((l) => l.includes('fora do censo'));
  assertEqual(skipLines.length, 1, 'uma linha por RAZÃO, não por item');
  assert(skipLines[0].includes('event-not-resource-related'), 'razão nomeada');
  assert(skipLines[0].includes('300×'), `contagem preservada, veio: ${skipLines[0]}`);
  assert(out.length < 4000, `saída legível, veio ${out.length} bytes`);
});

test('R12: inconclusive NUNCA sai mudo — carrega a razão na 1ª linha', () => {
  const out = formatCensus(run(fixture([])));
  assert(/^forge-resources-census: inconclusive — .+/.test(out.split('\n')[0]),
    `inconclusive mudo repete o próprio defeito: ${out.split('\n')[0]}`);
});

test('R12: CLI sai 0 mesmo com degradação (spawn real, status lido)', () => {
  const cwd = fixture([{ kind: 'resource-admission', reason: REASON_CODES.PLATFORM_UNSUPPORTED_LINUX }]);
  const p = spawnSync(process.execPath, [MODULE, '--check', '--cwd', cwd], { encoding: 'utf8' });
  assertEqual(p.status, 0, 'advisory: exit 0 SEMPRE, inclusive com degradação');
  assert(p.stdout.includes('degraded'), 'e o veredicto aparece na saída');
});

test('R12: CLI sai 0 em repo sem .gsd/ e com --json', () => {
  const empty = mktmp();
  const a = spawnSync(process.execPath, [MODULE, '--check', '--cwd', empty], { encoding: 'utf8' });
  assertEqual(a.status, 0, 'sem .gsd/');
  const cwd = fixture([{ kind: 'shadow-wait', reason: REASON_CODES.SHADOW_WAIT }]);
  const b = spawnSync(process.execPath, [MODULE, '--check', '--json', '--cwd', cwd], { encoding: 'utf8' });
  assertEqual(b.status, 0, '--json');
  const parsed = JSON.parse(b.stdout);
  assertEqual(parsed.verdict, 'clean', 'JSON parseável com veredicto');
  assert(parsed.w3, 'a CLI anexa a reconciliação W3');
});

// ── R13 (closing half) ──────────────────────────────────────────────────────

test('R13: o events.jsonl VIVO do operador nunca foi escrito', () => {
  assertEqual(liveStamp(), LIVE_BEFORE, 'mtime/size do log vivo devem estar inalterados');
});

// ── summary ─────────────────────────────────────────────────────────────────
cleanup();
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
