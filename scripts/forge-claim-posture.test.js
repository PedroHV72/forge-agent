#!/usr/bin/env node
'use strict';
//
// forge-claim-posture.test.js — the advisory|enforcing axis (PR #110, commit A).
//
// The claim under test is NOT "advisory works". It is the sharper one that D2 demands:
//
//   changing `parallelism.claim_gate` changes the ACT and does NOT change the DECISION.
//
// Both halves matter. If the decision moved, the flip criterion (which reads `decision` out of the
// `claim-gate` event) would be measuring the flag instead of the fence, and the debut would be
// permanently blind. If the act did not move, the flag would be decorative.
//
// Every assertion below is therefore stated over the SAME collision evaluated twice.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const gate = require('./forge-claim-gate.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (e) { failed++; failures.push(`${name}: ${e.message}`); process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert falhou'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'mismatch'}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}

function mktmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-posture-')); }

/** The ONE collision, built identically for every case below. */
function makeCollision(prefsBody) {
  const ws = path.join(mktmp(), 'ws');
  fs.mkdirSync(path.join(ws, '.gsd', 'forge', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');
  // The LOCAL prefs layer is `.gsd/forge-prefs.jsonc`, not `.gsd/prefs.local.md`.
  // Markdown without a jsonc sibling is deliberately BLOCKED by readPrefs
  // (`source: md-blocked`, `code: legacy-md-without-jsonc`, forge-prefs.js:277-285),
  // so a fixture writing Markdown never reaches the module at all — the asserts
  // below would then be exercising the no-pref-on-disk path and passing for the
  // wrong reason. Same shape the sibling suite uses (forge-claim-gate.test.js
  // `withPrefs`). Bodies are JSON.
  if (prefsBody) fs.writeFileSync(path.join(ws, '.gsd', 'forge-prefs.jsonc'), prefsBody, 'utf8');

  const now = Date.now();
  const mkRun = (id, claimPaths) => fs.writeFileSync(
    path.join(ws, '.gsd', 'forge', 'runs', `${id}.json`),
    JSON.stringify({
      kind: 'milestone', id, session_id: 'sess', active: true,
      started_at: now, last_heartbeat: now,
      isolation_mode: 'branch', cwd: ws,
      write_claim: claimPaths ? {
        paths: claimPaths, unit: 'execute-task/T01', code_dir: ws,
        recorded_at: new Date(now).toISOString(), released: null,
      } : null,
    }), 'utf8');

  mkRun('M-own', null);
  mkRun('M-other', ['scripts/x.js']);
  return ws;
}

const CLAIM = { paths: ['scripts/x.js'], unit: 'execute-task/T02', code_dir: null, eligible: true, cause: null };

function evaluate(ws, enforcement) {
  return gate.evaluateGate({
    cwd: ws, runId: 'M-own', claim: CLAIM, posture: 'block', enforcement, readyAlternatives: 0,
  });
}

process.stdout.write('\n=== forge-claim-posture — o eixo advisory|enforcing ===\n\n');

// ── The core claim, proved from BOTH sides ────────────────────────────────────
process.stdout.write('A MESMA colisão sob os dois valores\n');

test('P1a: a DECISÃO é idêntica sob advisory e sob enforcing — advisory nunca atalha a computação', () => {
  const ws = makeCollision(null);
  const adv = evaluate(ws, 'advisory');
  const enf = evaluate(ws, 'enforcing');
  assert(adv.decision !== 'proceed', `a fixture precisa colidir de verdade, veio ${adv.decision}`);
  assertEqual(adv.decision, enf.decision, 'a decisão NÃO pode depender da enforcement');
  assertEqual(adv.cause, enf.cause, 'a causa também não');
  // The census is the raw material of the flip criterion: it must survive advisory untouched.
  assertEqual(adv.census.runs_examined, enf.census.runs_examined, 'o censo é o insumo do critério de flip');
});

test('P1b: a AÇÃO difere — é o único efeito de mudar a pref', () => {
  const ws = makeCollision(null);
  assertEqual(evaluate(ws, 'advisory').advised_action, 'dispatch', 'advisory sempre despacha');
  assertEqual(evaluate(ws, 'enforcing').advised_action, 'stop', 'enforcing para num veredito != proceed');
});

test('P1c: a supressão é NOMEADA sob advisory e null sob enforcing — nunca silenciosa', () => {
  const ws = makeCollision(null);
  assertEqual(evaluate(ws, 'advisory').suppressed_action, 'stop', 'advisory nomeia o stop que não aconteceu');
  assertEqual(evaluate(ws, 'enforcing').suppressed_action, null, 'enforcing não suprime nada');
});

test('P1d: contra-lado — sem colisão os dois valores dão dispatch e NENHUM suprime', () => {
  // Without this the bite would be "advisory always dispatches", which is true but vacuous:
  // it would pass even if `suppressed_action` were hardcoded to 'stop'.
  const ws = makeCollision(null);
  const claim = { paths: ['scripts/nao-colide.js'], unit: 'execute-task/T02', code_dir: null, eligible: true, cause: null };
  for (const e of ['advisory', 'enforcing']) {
    const r = gate.evaluateGate({ cwd: ws, runId: 'M-own', claim, posture: 'block', enforcement: e });
    assertEqual(r.decision, 'proceed', `sem colisão a decisão é proceed (${e})`);
    assertEqual(r.advised_action, 'dispatch', `sem colisão despacha (${e})`);
    assertEqual(r.suppressed_action, null, `sem colisão nada é suprimido (${e})`);
  }
});

// ── Resolution lives in the MODULE ────────────────────────────────────────────
process.stdout.write('\nResolução no MÓDULO (spec § Step 0)\n');

test('P2a: sem pref, o fallback é advisory e é byte-idêntico ao default do schema', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'forge-prefs.schema.json'), 'utf8'));
  const leaf = schema.properties.parallelism.properties.claim_gate;
  assertEqual(gate.PARALLELISM_FALLBACKS.claim_gate, leaf.default, 'fallback do módulo == default do schema');
  const ws = makeCollision(null);
  const r = evaluate(ws, undefined);
  assertEqual(r.enforcement, 'advisory', 'default de estreia');
  assertEqual(r.enforcement_source, 'fallback', 'a origem é nomeada');
});

test('P2b: a pref é LIDA pelo módulo — o consumidor nunca a relê', () => {
  const ws = makeCollision('{"parallelism":{"claim_gate":"enforcing"}}\n');
  const r = evaluate(ws, undefined);
  assertEqual(r.enforcement, 'enforcing', 'a pref do disco governa');
  assertEqual(r.enforcement_source, 'prefs', 'origem nomeada');
  assertEqual(r.advised_action, 'stop', 'e ela chega até a AÇÃO');
});

test('P2c: pref inválida cai para advisory com note NOMEADA (nunca aceita em silêncio)', () => {
  const ws = makeCollision('{"parallelism":{"claim_gate":"talvez"}}\n');
  const resolved = gate.resolveEnforcementFromPrefs(ws);
  assertEqual(resolved.enforcement, 'advisory', 'fallback');
  assertEqual(resolved.source, 'invalid-pref', 'origem nomeada');
  assertEqual(resolved.note, 'invalid-enforcement-pref', 'a nota nomeia o defeito');
});

test('P2d: valor EXPLÍCITO fora do conjunto LANÇA — typo de operador nunca vira fallback silencioso', () => {
  const ws = makeCollision(null);
  let threw = null;
  try { evaluate(ws, 'talvez'); } catch (e) { threw = e.message; }
  assert(threw && /ENFORCEMENTS/.test(threw), `deveria lançar nomeando o conjunto, veio ${threw}`);
  // The two directions of the closed set.
  for (const v of gate.ENFORCEMENTS) {
    assertEqual(typeof evaluate(ws, v).advised_action, 'string', `${v} é aceito`);
  }
  assertEqual(gate.ENFORCEMENTS.length, 2, 'o conjunto é exatamente {advisory, enforcing}');
});

// ── advised_action is a pure function of the two axes, both directions ────────
process.stdout.write('\nadviseAction/suppressedAction — cruzamento completo\n');

test('P3: as 8 combinações (2 enforcements × 4 decisões) são exaustivas e conferem', () => {
  const expected = {
    'advisory|proceed': ['dispatch', null],
    'advisory|defer': ['dispatch', 'stop'],
    'advisory|block': ['dispatch', 'stop'],
    'advisory|refuse': ['dispatch', 'stop'],
    'enforcing|proceed': ['dispatch', null],
    'enforcing|defer': ['stop', null],
    'enforcing|block': ['stop', null],
    'enforcing|refuse': ['stop', null],
  };
  let seen = 0;
  for (const e of gate.ENFORCEMENTS) {
    for (const d of gate.GATE_DECISIONS) {
      const key = `${e}|${d}`;
      assert(expected[key], `combinação não prevista pelo teste: ${key}`);
      assertEqual(gate.adviseAction(e, d), expected[key][0], `advised_action de ${key}`);
      assertEqual(gate.suppressedAction(e, d), expected[key][1], `suppressed_action de ${key}`);
      seen++;
    }
  }
  assertEqual(seen, Object.keys(expected).length, 'toda combinação prevista foi exercida (as duas direções)');
  // Every produced value is inside the closed set.
  for (const e of gate.ENFORCEMENTS) {
    for (const d of gate.GATE_DECISIONS) {
      assert(gate.ADVISED_ACTIONS.includes(gate.adviseAction(e, d)), 'ação emitida ⊂ ADVISED_ACTIONS');
    }
  }
});

// ── --wait is an ACT ─────────────────────────────────────────────────────────
process.stdout.write('\n--wait é um ATO (must-have 4)\n');

test('P4a: sob advisory o módulo NÃO polla — zero polls, sem consumir block_wait_ms', () => {
  const ws = makeCollision('{"parallelism":{"claim_gate":"advisory","block_wait_ms":4000,"block_poll_ms":1000}}\n');
  let polls = 0;
  const t0 = Date.now();
  const r = gate.recordAndEvaluate({
    cwd: ws, runId: 'M-own', paths: ['scripts/x.js'], unit: 'execute-task/T02',
    source: 'plan-writes', posture: 'block', wait: true, record: false, emitEvent: false,
    onPoll: () => { polls++; },
  });
  const elapsed = Date.now() - t0;
  assertEqual(polls, 0, 'nenhum poll sob advisory');
  assert(elapsed < 3000, `retornou sem consumir o teto (levou ${elapsed}ms de 4000)`);
  assertEqual(r.decision, 'block', 'a DECISÃO continua sendo o block real');
  assertEqual(r.advised_action, 'dispatch', 'mas a ação é dispatch');
  assertEqual(r.wait && r.wait.suppressed_by, 'advisory', 'a supressão da espera é nomeada');
  assertEqual(r.escalation, null, 'wait-ceiling é a MEDIÇÃO de uma espera; sem espera não há medição a emitir');
});

test('P4b: contra-lado — sob enforcing o módulo POLLA e escala (a mordida não é "nunca polla")', () => {
  const ws = makeCollision('{"parallelism":{"claim_gate":"enforcing","block_wait_ms":300,"block_poll_ms":100}}\n');
  let polls = 0;
  const r = gate.recordAndEvaluate({
    cwd: ws, runId: 'M-own', paths: ['scripts/x.js'], unit: 'execute-task/T02',
    source: 'plan-writes', posture: 'block', wait: true, record: false, emitEvent: false,
    onPoll: () => { polls++; },
  });
  assert(polls >= 1, `sob enforcing tem de pollar, veio ${polls}`);
  assertEqual(r.escalation, 'wait-ceiling', 'e escalar com nome');
  assertEqual(r.advised_action, 'stop', 'e parar');
});

// ── gate-unavailable is the named boundary: it stops under BOTH ──────────────
process.stdout.write('\ngate-unavailable: a fronteira nomeada (must-have 3)\n');

test('P5: falha de tooling sai != 0 sob os DOIS valores — não é veredito da cerca', () => {
  // A broken gate is the absence of a fence, not a fence saying "go". And the flip criterion needs
  // the gate to have actually RUN — an advisory that tolerates a broken gate stops producing the
  // very data that would justify the flip.
  const ws = makeCollision(null);
  for (const enf of gate.ENFORCEMENTS) {
    const r = spawnSync(process.execPath, [
      path.join(__dirname, 'forge-claim-gate.js'), '--check-only',
      '--paths', 'scripts/x.js', '--run', 'M-own', '--cwd', ws,
      '--posture', 'block', '--enforcement', enf,
      '--plan', 'nao-existe.md', '--json',
    ], { encoding: 'utf8' });
    assert(r.status !== 0, `${enf}: gate quebrado tem de sair != 0, veio ${r.status}`);
  }
});

test('P5b: a CLI aceita --enforcement e ele chega ao payload sob os dois valores', () => {
  const ws = makeCollision(null);
  for (const enf of gate.ENFORCEMENTS) {
    const r = spawnSync(process.execPath, [
      path.join(__dirname, 'forge-claim-gate.js'), '--evaluate',
      '--paths', 'scripts/x.js', '--run', 'M-own', '--cwd', ws,
      '--posture', 'block', '--enforcement', enf, '--json',
    ], { encoding: 'utf8' });
    assertEqual(r.status, 0, `exit 0 (${enf}): ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assertEqual(out.enforcement, enf, `enforcement no payload (${enf})`);
    assertEqual(out.decision, 'block', `a decisão é a mesma sob os dois (${enf})`);
    assertEqual(out.advised_action, enf === 'advisory' ? 'dispatch' : 'stop', `ação (${enf})`);
  }
});

// ── The executed bite ────────────────────────────────────────────────────────
process.stdout.write('\nMORDIDA EXECUTADA — neutralizar a leitura da pref deixa EXATAMENTE um lado vermelho\n');

test('P6: com a leitura da pref neutralizada no módulo copiado, enforcing deixa de parar', () => {
  // The bite runs against a COPY in tmp (medium 4 discipline): the real scripts/ is never written.
  const tmp = mktmp();
  const copyDir = path.join(tmp, 'scripts');
  fs.mkdirSync(copyDir, { recursive: true });
  for (const f of fs.readdirSync(__dirname)) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) {
      fs.copyFileSync(path.join(__dirname, f), path.join(copyDir, f));
    }
  }
  const target = path.join(copyDir, 'forge-claim-gate.js');
  const src = fs.readFileSync(target, 'utf8');

  // The needle must match EXACTLY ONCE. Zero matches would be a bite that drifted off its target
  // (vacuously green); two would neutralise more than the one thing under test.
  const needle = "  if (enforcement === 'advisory') return 'dispatch';";
  const occurrences = src.split(needle).length - 1;
  assertEqual(occurrences, 1, 'a agulha precisa casar exatamente uma vez');

  // Neutralise: make adviseAction ignore the enforcement entirely (always dispatch).
  fs.writeFileSync(target, src.replace(needle, "  if (true) return 'dispatch';"), 'utf8');

  const ws = makeCollision(null);
  const mutated = require(target);
  const enf = mutated.evaluateGate({ cwd: ws, runId: 'M-own', claim: CLAIM, posture: 'block', enforcement: 'enforcing' });

  // THIS is the bite: with the pref read neutralised, the enforcing side stops fencing. Exactly one
  // of the two sides goes red — advisory was already 'dispatch' and is unaffected.
  assertEqual(enf.decision, 'block', 'a decisão (a computação) sobrevive à mutação — é só o ATO que morre');
  assertEqual(enf.advised_action, 'dispatch', 'MORDIDA: sem a leitura da pref, enforcing deixa de parar');
  assert(enf.advised_action !== 'stop', 'e o assert P1b acima ficaria vermelho contra este módulo');

  // The real module is untouched — asserted, not assumed.
  assertEqual(gate.evaluateGate({ cwd: ws, runId: 'M-own', claim: CLAIM, posture: 'block', enforcement: 'enforcing' }).advised_action,
    'stop', 'o módulo REAL segue intacto');
});

process.stdout.write(`\n=== Result: ${passed} passed, ${failed} failed ===\n`);
if (failed) { for (const f of failures) process.stdout.write(`  ✗ ${f}\n`); process.exit(1); }
