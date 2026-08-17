#!/usr/bin/env node
'use strict';

// forge-claim-flip.test.js — the advisory reporter that decides whether the
// claim gate may be flipped from advisory to enforcing NEVER reports its own
// inactivity as good news.
//
// The one property everything else serves: this module's `flip-ready` is a
// claim about WORK DONE ("I confronted N gate decisions against the factual
// overlap and none was a false positive"). A reporter that says `flip-ready`
// having compared nothing is byte-for-byte indistinguishable from a broken
// detector — and this repo has paid three rounds to learn exactly that.
//
// Properties this suite carries:
//
//   F1  the anti-silence floor, proved by an EXECUTED bite:
//       `pairs_compared === 0` yields `inconclusive` BEFORE any other branch,
//       and NEVER `flip-ready`. Asserted over an EMPTY log AND over a log full
//       of events that were all skipped (anti-vacuity: the floor is not being
//       reached by the empty case alone).
//   F2  the named gap, measured, not assumed: an event in the REAL shape that
//       `forge-claim-gate.emitGateEvent` writes carries neither `milestone` nor
//       `factual_overlap`, so it is SKIPPED BY NAME — never diluted into the
//       sample, never counted as evidence for a flip.
//   F3  closed set `SKIP_REASONS` crossed in BOTH directions: nothing emitted
//       falls outside it, and EVERY declared entry is emitted by >= 1 test.
//   F4  `decision: proceed` is not evidence about false positives and is not
//       examined; every other decision is.
//   F5  a `factual_overlap` that is not a measurement (null, string, absent) is
//       a NAMED SKIP, never a false positive — accusing the gate of being wrong
//       from a measurement nobody took is the same silence, inverted.
//   F6  the flip criterion is the documented one and BOTH its terms bite:
//       window < FLIP_WINDOW_MILESTONES => inconclusive; false positives >
//       FLIP_MAX_FALSE_POSITIVES => not-ready; otherwise flip-ready.
//   F7  an unreadable line in `events.jsonl` can never silently shrink the
//       universe: it is COUNTED, NAMED, and it forbids `flip-ready`.
//   F8  `exit 0` ALWAYS — proved by SPAWN, including over a corrupt log and a
//       workspace with no `.gsd/` at all.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-claim-flip.js');
const {
  FLIP_WINDOW_MILESTONES, FLIP_MAX_FALSE_POSITIVES, SKIP_REASONS,
  recordSkip, readEvents, readEventsDetailed, evaluateFlip,
} = require('./forge-claim-flip.js');

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claim-flip-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const VERDICTS = ['inconclusive', 'flip-ready', 'not-ready'];

// Both-directions crossing of the closed set.
const skipsSeen = new Set();
const verdictsSeen = new Set();
function record(r) {
  assert(VERDICTS.includes(r.verdict), `veredicto fora do conjunto: ${JSON.stringify(r.verdict)}`);
  verdictsSeen.add(r.verdict);
  for (const s of r.skipped) {
    assert(SKIP_REASONS.includes(s.reason), `skip fora de SKIP_REASONS: ${JSON.stringify(s.reason)}`);
    skipsSeen.add(s.reason);
  }
  return r;
}

/** A gate event in the shape `forge-claim-gate.emitGateEvent` really writes. */
function realGateEvent(over) {
  return Object.assign({
    event: 'claim-gate',
    ts: '2026-08-16T12:00:00.000Z',
    run: 'M-20260813133328-lease',
    unit: 'execute-task/T01',
    decision: 'defer',
    cause: 'overlap',
    undeclared_side: null,
    posture: 'defer',
    posture_source: 'pref',
    enforcement: 'advisory',
    enforcement_source: 'pref',
    advised_action: 'dispatch',
    suppressed_action: 'stop',
  }, over || {});
}

/** An ENRICHED event — the shape the flip reporter would need to compare. */
function richEvent(over) {
  return realGateEvent(Object.assign({ milestone: 'M-20260813133328-lease', factual_overlap: true }, over || {}));
}

/** Workspace fixture. Self-contained: reads no real prefs and no real `.gsd/`. */
function makeFixture(lines) {
  const tmp = mktmp();
  const wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(wsDir, '.gsd', 'forge'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');
  if (lines !== null) {
    fs.writeFileSync(path.join(wsDir, '.gsd', 'forge', 'events.jsonl'),
      lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf8');
  }
  return wsDir;
}

function runCli(cwd) {
  const res = spawnSync(process.execPath, [MODULE], { encoding: 'utf8', cwd });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

console.log('\nforge-claim-flip — critério de flip advisory -> enforcing\n');

// ── F1: the anti-silence floor ──────────────────────────────────────────────
test('F1: log vazio -> inconclusive, NUNCA flip-ready (0 pares comparados não é "limpo")', () => {
  const r = record(evaluateFlip([], { milestones: 99 }));
  assertEqual(r.verdict, 'inconclusive',
    'um comparador que diz "pronto" sem ter comparado nada relata a própria inatividade como boa notícia');
  assertEqual(r.pairs_compared, 0, 'pares comparados');
  assert(r.verdict !== 'flip-ready', 'jamais flip-ready sem amostra');
});

test('F1 (anti-vacuidade): log CHEIO cujos eventos foram todos pulados também é inconclusive', () => {
  const events = [
    realGateEvent({ decision: 'defer' }),
    realGateEvent({ decision: 'block' }),
    realGateEvent({ decision: 'defer', run: null }),
    richEvent({ factual_overlap: undefined }),
  ];
  const r = record(evaluateFlip(events, { milestones: 99 }));
  assert(r.examined >= 4, 'o piso tem de ser alcançado com eventos DE VERDADE, não só pelo caso vazio');
  assertEqual(r.pairs_compared, 0, 'nenhum par comparável');
  assertEqual(r.verdict, 'inconclusive', 'universo cheio e amostra vazia continua sendo amostra vazia');
  assertEqual(r.skipped.length, r.examined, 'todo evento examinado e não comparado sai NOMEADO no censo');
});

test('F1: o piso vem ANTES do critério — nem a janela satisfeita produz flip-ready sem pares', () => {
  const r = record(evaluateFlip([realGateEvent()], { milestones: FLIP_WINDOW_MILESTONES + 10 }));
  assertEqual(r.verdict, 'inconclusive', 'a janela não substitui a amostra');
});

// ── F2: the named gap ───────────────────────────────────────────────────────
test('F2: evento claim-gate REAL não carrega milestone -> skip scope-unresolved, nunca comparado', () => {
  const ev = realGateEvent();
  assert(!Object.prototype.hasOwnProperty.call(ev, 'milestone'),
    'a forma real emitida por emitGateEvent não tem milestone — se um dia tiver, este teste tem de ser revisto');
  const r = record(evaluateFlip([ev], { milestones: 99 }));
  assertEqual(r.examined, 1, 'o evento é examinado');
  assertEqual(r.pairs_compared, 0, 'e NÃO comparado');
  assertEqual(r.skipped[0].reason, 'scope-unresolved',
    'a lacuna da ponte de escopo é tratada com skip NOMEADO, nunca por diluição silenciosa');
});

test('F2: evento sem run -> skip run-not-registered (a ponte do registro de runs não resolve)', () => {
  const r = record(evaluateFlip([realGateEvent({ run: null })], { milestones: 99 }));
  assertEqual(r.skipped[0].reason, 'run-not-registered', 'razão nomeada');
  assertEqual(r.pairs_compared, 0, 'não entra na amostra');
});

test('F2: evento com milestone mas sem dado factual -> skip touch-data-absent', () => {
  // `forge-touch --record` só roda antes de complete-slice, então em fronteira
  // de task o dado factual simplesmente não existe. Isso é ausência de medição.
  const r = record(evaluateFlip([richEvent({ factual_overlap: undefined })], { milestones: 99 }));
  assertEqual(r.skipped[0].reason, 'touch-data-absent', 'razão nomeada');
  assertEqual(r.pairs_compared, 0, 'não entra na amostra');
});

// ── F4: which decisions are evidence ────────────────────────────────────────
test('F4: decision proceed não é evidência sobre falso positivo e não é examinado', () => {
  const r = record(evaluateFlip([
    richEvent({ decision: 'proceed', factual_overlap: false }),
    richEvent({ decision: 'proceed', factual_overlap: false }),
  ], { milestones: 99 }));
  assertEqual(r.examined, 0, 'proceed não cerca ninguém — não pode ser falso positivo da cerca');
  assertEqual(r.false_positives, 0, 'e jamais conta como um');
  assertEqual(r.verdict, 'inconclusive', 'sem amostra, inconclusive');
});

test('F4 (outro sentido): defer e block SÃO examinados e comparados', () => {
  for (const decision of ['defer', 'block']) {
    const r = record(evaluateFlip([richEvent({ decision, factual_overlap: true })], { milestones: 99 }));
    assertEqual(r.examined, 1, `${decision}: examinado`);
    assertEqual(r.pairs_compared, 1, `${decision}: comparado`);
  }
});

// ── F5: a non-measurement is never an accusation ────────────────────────────
test('F5: factual_overlap true -> par comparado, ZERO falsos positivos (a cerca acertou)', () => {
  const r = record(evaluateFlip([richEvent({ factual_overlap: true })], { milestones: 99 }));
  assertEqual(r.pairs_compared, 1, 'comparado');
  assertEqual(r.false_positives, 0, 'cerca corroborada pelo fato');
});

test('F5: factual_overlap false -> falso positivo CONTADO (a cerca cercou sem colisão real)', () => {
  const r = record(evaluateFlip([richEvent({ factual_overlap: false })], { milestones: 99 }));
  assertEqual(r.pairs_compared, 1, 'comparado');
  assertEqual(r.false_positives, 1, 'medido false é uma acusação legítima à cerca');
});

test('F5: factual_overlap que NÃO é medição (null / string) -> skip nomeado, jamais falso positivo', () => {
  for (const value of [null, 'unknown', 0, 'false']) {
    const r = record(evaluateFlip([richEvent({ factual_overlap: value })], { milestones: 99 }));
    assertEqual(r.false_positives, 0,
      `factual_overlap=${JSON.stringify(value)}: acusar a cerca de errar a partir de uma medição que ninguém tomou é o mesmo silêncio, invertido`);
    assertEqual(r.pairs_compared, 0, `factual_overlap=${JSON.stringify(value)}: não comparado`);
    assertEqual(r.skipped[0].reason, 'touch-data-absent', 'a razão nomeia a ausência de medição');
  }
});

// ── F6: the flip criterion, both terms ──────────────────────────────────────
test('F6: as constantes são as documentadas (janela 2 milestones, zero falsos positivos)', () => {
  assertEqual(FLIP_WINDOW_MILESTONES, 2, 'FLIP_WINDOW_MILESTONES');
  assertEqual(FLIP_MAX_FALSE_POSITIVES, 0, 'FLIP_MAX_FALSE_POSITIVES');
});

test('F6: amostra limpa mas janela curta -> inconclusive com skip milestone-window-unmet', () => {
  const r = record(evaluateFlip([richEvent({ factual_overlap: true })], { milestones: FLIP_WINDOW_MILESTONES - 1 }));
  assertEqual(r.verdict, 'inconclusive', 'uma milestone limpa não é o critério — o critério são duas');
  assert(r.skipped.some((s) => s.reason === 'milestone-window-unmet'), 'a razão da não-conclusão é nomeada');
});

test('F6: amostra limpa + janela cumprida -> flip-ready', () => {
  const r = record(evaluateFlip([
    richEvent({ factual_overlap: true }), richEvent({ factual_overlap: true }),
  ], { milestones: FLIP_WINDOW_MILESTONES }));
  assertEqual(r.verdict, 'flip-ready', 'os dois termos satisfeitos');
  assertEqual(r.pairs_compared, 2, 'sobre uma amostra real');
});

test('F6: UM único falso positivo já derruba o flip -> not-ready', () => {
  const r = record(evaluateFlip([
    richEvent({ factual_overlap: true }), richEvent({ factual_overlap: true }), richEvent({ factual_overlap: false }),
  ], { milestones: FLIP_WINDOW_MILESTONES + 5 }));
  assertEqual(r.verdict, 'not-ready', 'FLIP_MAX_FALSE_POSITIVES = 0 significa zero, não "poucos"');
  assertEqual(r.false_positives, 1, 'contado');
});

// ── F9: the join — the reporter reads the REAL event shape ──────────────────
//
// F2 above measures the gap; F9 measures the bridge that closes it. The event grows NOTHING: the
// milestone comes from the run registry (`milestone_dir`), the factual side from `forge-overlap`'s
// pair confrontation over the `touched` snapshots. Everything the join cannot fill stays a NAMED
// skip — never a zero folded into the sample.

/** A run record on disk, in the shape `forge-runs` reads. */
function writeRun(wsDir, rec) {
  const dir = path.join(wsDir, '.gsd', 'forge', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify(rec), 'utf8');
}

function runRec(id, milestone, files, over) {
  return Object.assign({
    id,
    kind: 'milestone',
    active: false,
    session_id: `sess-${id}`,
    milestone_dir: `.gsd/milestones/${milestone}/`,
    last_heartbeat: Date.now(),
    touched: {
      examined: 1,
      repos: [{ name: 'forge-agent', path: '/repo/forge-agent', repo_id: 'r1', status: 'ok', files }],
    },
  }, over || {});
}

test('F9: a ponte de milestone é o REGISTRO DE RUNS, não um campo novo no evento', () => {
  const wsDir = makeFixture([]);
  writeRun(wsDir, runRec('R1', 'M-alpha', ['a.js']));
  const bridge = require('./forge-claim-flip.js').milestoneBridge(wsDir);
  assertEqual(bridge.get('R1'), 'M-alpha', 'run -> milestone via milestone_dir');
});

test('F9 (PROVA CONTRA DADO REAL): eventos na forma exata de emitGateEvent -> VEREDICTO real', () => {
  // Nenhum evento carrega `milestone` nem `factual_overlap` — é a forma que o gate escreve hoje.
  const evA = realGateEvent({ run: 'R1', counterparts: [{ id: 'R2', cause: 'overlap', paths: ['a.js'], scope: null, note: null }] });
  const evB = realGateEvent({ run: 'R3', decision: 'block', counterparts: [{ id: 'R4', cause: 'overlap', paths: ['b.js'], scope: null, note: null }] });
  for (const ev of [evA, evB]) {
    assert(!Object.prototype.hasOwnProperty.call(ev, 'milestone'), 'forma real: sem milestone');
    assert(!Object.prototype.hasOwnProperty.call(ev, 'factual_overlap'), 'forma real: sem factual_overlap');
  }
  const wsDir = makeFixture([evA, evB]);
  // Duas milestones (a janela), e as duas cercas corroboradas por colisão factual real.
  writeRun(wsDir, runRec('R1', 'M-alpha', ['a.js']));
  writeRun(wsDir, runRec('R2', 'M-alpha', ['a.js']));
  writeRun(wsDir, runRec('R3', 'M-beta', ['b.js']));
  writeRun(wsDir, runRec('R4', 'M-beta', ['b.js']));

  const cli = runCli(wsDir);
  assertEqual(cli.status, 0, `advisory: exit 0; stderr: ${cli.stderr}`);
  const out = record(JSON.parse(cli.stdout));
  assertEqual(out.pairs_compared, 2, 'os dois eventos REAIS foram comparados — o join lê o dado que existe');
  assertEqual(out.milestones_covered, 2, 'a janela é derivada das milestones da amostra, não afirmada');
  assertEqual(out.false_positives, 0, 'ambas as cercas corroboradas pelo toque real');
  assertEqual(out.verdict, 'flip-ready',
    'contra dado REAL o reporter conclui; se voltasse inconclusive o instrumento estaria cego de novo');
});

test('F9 (mordida): cerca sem colisão factual real -> falso positivo CONTADO -> not-ready', () => {
  const ev = realGateEvent({ run: 'R1', counterparts: [{ id: 'R2', cause: 'overlap', paths: ['a.js'], scope: null, note: null }] });
  const ev2 = realGateEvent({ run: 'R3', counterparts: [{ id: 'R4', cause: 'overlap', paths: ['b.js'], scope: null, note: null }] });
  const wsDir = makeFixture([ev, ev2]);
  writeRun(wsDir, runRec('R1', 'M-alpha', ['a.js']));
  writeRun(wsDir, runRec('R2', 'M-alpha', ['OUTRO.js'])); // cercados, mas NÃO tocaram o mesmo arquivo
  writeRun(wsDir, runRec('R3', 'M-beta', ['b.js']));
  writeRun(wsDir, runRec('R4', 'M-beta', ['b.js']));
  const out = record(JSON.parse(runCli(wsDir).stdout));
  assertEqual(out.pairs_compared, 2, 'ambos comparados');
  assertEqual(out.false_positives, 1, 'a cerca que cercou sem colisão real é acusada — pelo FATO, não por um campo');
  assertEqual(out.verdict, 'not-ready', 'um falso positivo já derruba o flip');
});

test('F9 (mordida): sem touched gravado -> touch-data-absent, e NUNCA um zero diluído', () => {
  // `forge-touch --record` só roda antes de complete-slice: na fronteira de task o dado não existe.
  const ev = realGateEvent({ run: 'R1', counterparts: [{ id: 'R2', cause: 'overlap', paths: ['a.js'], scope: null, note: null }] });
  const wsDir = makeFixture([ev]);
  writeRun(wsDir, runRec('R1', 'M-alpha', ['a.js'], { touched: null }));
  writeRun(wsDir, runRec('R2', 'M-alpha', ['a.js'], { touched: null }));
  const out = record(JSON.parse(runCli(wsDir).stdout));
  assertEqual(out.pairs_compared, 0, 'ausência de medição não entra na amostra');
  assertEqual(out.verdict, 'inconclusive', 'e o piso anti-silêncio segura o veredicto');
  assert(out.skipped.some((s) => s.reason === 'touch-data-absent'), 'com a razão nomeada');
});

test('F9 (mordida): SÓ o counterpart sem touched -> touch-data-absent, jamais "não colidiu"', () => {
  // O caso assimétrico, e o mais perigoso: o run cercado TEM dado de toque, o counterpart não.
  // Se essa ausência colapsasse em `value:false`, o par entraria na amostra como FALSO POSITIVO —
  // acusar a cerca de errar a partir de uma medição que ninguém tomou é o mesmo silêncio invertido.
  const ev = realGateEvent({ run: 'R1', counterparts: [{ id: 'R2', cause: 'overlap', paths: ['a.js'] }] });
  const wsDir = makeFixture([ev]);
  writeRun(wsDir, runRec('R1', 'M-alpha', ['a.js']));               // tem toque
  writeRun(wsDir, runRec('R2', 'M-alpha', ['a.js'], { touched: null })); // não tem
  const out = record(JSON.parse(runCli(wsDir).stdout));
  assertEqual(out.pairs_compared, 0, 'nenhum par foi de fato confrontado');
  assertEqual(out.false_positives, 0, 'e ninguém é acusado por isso');
  assertEqual(out.skipped[0].reason, 'touch-data-absent', 'a razão nomeia a ausência de medição do OUTRO lado');
});

test('F9 (mordida): run do evento fora do registro -> run-not-registered, não escopo máximo', () => {
  const ev = realGateEvent({ run: 'FANTASMA', counterparts: [{ id: 'R2' }] });
  const wsDir = makeFixture([ev]);
  writeRun(wsDir, runRec('R2', 'M-alpha', ['a.js']));
  const out = record(JSON.parse(runCli(wsDir).stdout));
  assertEqual(out.skipped[0].reason, 'run-not-registered', 'a ponte não resolve — e isso sai nomeado');
  assertEqual(out.pairs_compared, 0, 'não entra na amostra');
});

test('F9 (mordida): run registrado sem milestone resolvível -> scope-unresolved', () => {
  const ev = realGateEvent({ run: 'R1', counterparts: [{ id: 'R2' }] });
  const wsDir = makeFixture([ev]);
  writeRun(wsDir, runRec('R1', 'M-alpha', ['a.js'], { kind: 'task', milestone_dir: null }));
  writeRun(wsDir, runRec('R2', 'M-alpha', ['a.js']));
  const out = record(JSON.parse(runCli(wsDir).stdout));
  assertEqual(out.skipped[0].reason, 'scope-unresolved', 'registrado, mas sem milestone: outra ausência, outro nome');
});

test('F9: cerca sem counterparts nomeados -> counterparts-unnamed (distinto de touch-data-absent)', () => {
  const ev = realGateEvent({ run: 'R1', counterparts: [] });
  const wsDir = makeFixture([ev]);
  writeRun(wsDir, runRec('R1', 'M-alpha', ['a.js']));
  writeRun(wsDir, runRec('R2', 'M-alpha', ['a.js']));
  const out = record(JSON.parse(runCli(wsDir).stdout));
  assertEqual(out.skipped[0].reason, 'counterparts-unnamed',
    'não há contra quem confrontar — evento malformado não pode se esconder dentro de uma lacuna legítima');
});

test('F9 (mordida da janela): amostra limpa numa milestone SÓ -> inconclusive, não flip-ready', () => {
  const ev = realGateEvent({ run: 'R1', counterparts: [{ id: 'R2', cause: 'overlap', paths: ['a.js'] }] });
  const wsDir = makeFixture([ev]);
  writeRun(wsDir, runRec('R1', 'M-alpha', ['a.js']));
  writeRun(wsDir, runRec('R2', 'M-alpha', ['a.js']));
  const out = record(JSON.parse(runCli(wsDir).stdout));
  assertEqual(out.pairs_compared, 1, 'comparado de verdade');
  assertEqual(out.milestones_covered, 1, 'mas cobrindo uma milestone só');
  assertEqual(out.verdict, 'inconclusive', 'a janela derivada morde: uma milestone limpa não é o critério');
  assert(out.skipped.some((s) => s.reason === 'milestone-window-unmet'), 'razão nomeada');
});

// ── F3: closed set both directions ──────────────────────────────────────────
test('F3: recordSkip recusa razão fora de SKIP_REASONS', () => {
  let threw = false;
  try { recordSkip({ skipped: [] }, 'inventada'); } catch { threw = true; }
  assert(threw, 'uma razão não declarada não pode entrar no censo por acidente');
});

// ── F7: an unreadable line can never shrink the universe in silence ─────────
test('F7: linha corrompida no events.jsonl é CONTADA e NOMEADA, não engole o log inteiro', () => {
  const wsDir = makeFixture([
    richEvent({ factual_overlap: true }),
    '{"event":"claim-gate","decis',           // truncada: o estado que um kill deixa
    richEvent({ factual_overlap: true }),
  ]);
  const d = readEventsDetailed(wsDir);
  assertEqual(d.parsed.length, 2,
    'as linhas legíveis TÊM de sobreviver — descartar o log inteiro por uma linha faz o censo mentir por omissão');
  assertEqual(d.unparseable, 1, 'a ilegível é contada');
});

test('F7: log parcialmente ilegível NÃO pode produzir flip-ready', () => {
  const clean = [richEvent({ factual_overlap: true }), richEvent({ factual_overlap: true })];
  const ok = record(evaluateFlip(clean, { milestones: 99 }));
  assertEqual(ok.verdict, 'flip-ready', 'controle: sem ilegível, a mesma amostra é flip-ready');

  const r = record(evaluateFlip(clean, { milestones: 99, unparseable: 1 }));
  assertEqual(r.verdict, 'inconclusive',
    'certificar flip-ready sobre um log que não pôde ser lido inteiro é alegar mais do que se mediu');
  assertEqual(r.unparseable, 1, 'e o número sai no censo');
  assert(r.skipped.some((s) => s.reason === 'event-log-unparseable'), 'com razão nomeada');
});

test('F7: readEvents mantém o contrato antigo (array) e devolve [] sem arquivo', () => {
  const wsDir = makeFixture(null);
  assert(Array.isArray(readEvents(wsDir)), 'array');
  assertEqual(readEvents(wsDir).length, 0, 'sem events.jsonl não há evento — e isso não é erro');
});

// ── F8: exit 0 always, proved by spawn ──────────────────────────────────────
test('F8: CLI sai 0 e imprime JSON com veredicto sobre um log real', () => {
  const wsDir = makeFixture([richEvent({ factual_overlap: true }), realGateEvent()]);
  const r = runCli(wsDir);
  assertEqual(r.status, 0, `advisory: exit 0 sempre; stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert(VERDICTS.includes(out.verdict), `veredicto fora do conjunto: ${out.verdict}`);
  assert(Array.isArray(out.skipped), 'censo enumerado no JSON');
});

test('F8: CLI sai 0 num workspace SEM .gsd/ (e não fabrica um)', () => {
  const tmp = mktmp();
  const r = runCli(tmp);
  assertEqual(r.status, 0, 'exit 0');
  assertEqual(JSON.parse(r.stdout).verdict, 'inconclusive', 'sem log, nada foi comparado');
  assert(!fs.existsSync(path.join(tmp, '.gsd')), 'o reporter não pode manufaturar um .gsd/');
});

test('F8: CLI sai 0 com events.jsonl corrompido, e reporta a ilegibilidade', () => {
  const wsDir = makeFixture(['nao sou json', richEvent({ factual_overlap: true })]);
  const r = runCli(wsDir);
  assertEqual(r.status, 0, 'exit 0 mesmo com log corrompido');
  const out = JSON.parse(r.stdout);
  assertEqual(out.unparseable, 1, 'a linha ilegível aparece no censo do CLI, não some');
});

// ── F3: closed set, direction 2 — runs LAST, after every emitter above ──────
test('F3: SKIP_REASONS — toda entrada declarada foi emitida por >= 1 teste', () => {
  assert(skipsSeen.size > 0, 'piso anti-vacuidade: o cruzamento roda sobre skips DE VERDADE');
  for (const s of SKIP_REASONS) {
    assert(skipsSeen.has(s),
      `SKIP_REASONS: ${s} nunca foi emitida — razão declarada e nunca produzida é indistinguível de razão morta`);
  }
});

test('F3: os veredictos emitidos cobrem os três do conjunto', () => {
  for (const v of VERDICTS) assert(verdictsSeen.has(v), `veredicto ${v} nunca foi produzido por nenhum teste`);
});

// ── Suite close ─────────────────────────────────────────────────────────────
cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
