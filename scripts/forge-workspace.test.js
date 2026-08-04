#!/usr/bin/env node
'use strict';

// forge-workspace.test.js — the predicate, and the three writers that used to
// forge it.
//
// The defect this suite exists for was measured, not imagined: of 18 projects
// registered in the app on the author's machine, 5 were directories our own
// tooling had enrolled. `forge-verify.js` ran `mkdirSync(cwd/.gsd/forge)` in
// every repo it verified; `forge-lock.js` ran `mkdirSync(cwd/.gsd/.locks)`
// wherever it was invoked; `forge-dashboard.js` then rendered a STATE.md into
// the directory those two had just created. `~/Development/.gsd` — one level
// above every real project — was born exactly that way.
//
// So the classification tests are only half the job. A predicate that ignores
// runtime scratch is worthless if the runtime keeps writing work-shaped files,
// which is why the second half of this suite runs the three scripts against a
// directory that is NOT a project and asserts the directory is still not one
// afterwards. Those are the regressions with teeth: they fail on the exact
// line that caused the incident.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { classify, isProject, resolveOwner, DASHBOARD_MARKER } = require('./forge-workspace.js');

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
function mkTmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-ws-${tag}-`));
  tmps.push(dir);
  return dir;
}
function cleanup() {
  for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

/** Build `<tmp>/.gsd/` with the given entries; a null value means directory. */
function fixture(tag, entries) {
  const dir = mkTmp(tag);
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  for (const [name, body] of Object.entries(entries || {})) {
    const p = path.join(dir, '.gsd', name);
    if (body === null) fs.mkdirSync(p, { recursive: true });
    else fs.writeFileSync(p, body, 'utf8');
  }
  return dir;
}

const repoRoot = path.resolve(__dirname, '..');
function runScript(name, args, opts) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'scripts', name), ...args],
                   { encoding: 'utf8', ...(opts || {}) });
}

// ── Classification ──────────────────────────────────────────────────────────

console.log('\nclassify — .gsd/ prova que uma ferramenta rodou, não que há trabalho');

test('sem .gsd/ é none', () => {
  const dir = mkTmp('none');
  assertEqual(classify(dir).kind, 'none');
  assertEqual(isProject(dir), false);
});

test('.gsd/ só com runtime é touched', () => {
  const dir = fixture('touched', { forge: null, '.locks': null });
  const r = classify(dir);
  assertEqual(r.kind, 'touched');
  assertEqual(r.signals.length, 0, 'runtime não é sinal');
});

test('.gsd/ vazio é touched, não none — está registrado, precisa ser removível', () => {
  assertEqual(classify(fixture('empty', {})).kind, 'touched');
});

test('só events.jsonl do verifier é touched — o caso asgard/saga/skuld', () => {
  const dir = mkTmp('verifyonly');
  fs.mkdirSync(path.join(dir, '.gsd', 'forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gsd', 'forge', 'events.jsonl'),
                   '{"ts":"2026-07-09T12:53:12.970Z","event":"verify","unit":"execute-task/T01"}\n');
  assertEqual(classify(dir).kind, 'touched');
});

test('cada artefato de trabalho promove a projeto', () => {
  for (const a of ['milestones', 'tasks', 'items', 'ledger', 'memory', 'decisions']) {
    const dir = fixture(`art-${a}`, { forge: null, [a]: null });
    const r = classify(dir);
    assertEqual(r.kind, 'project', `${a} deveria promover`);
    assert(r.signals.includes(a), `${a} deveria constar nos sinais`);
  }
});

test('SCHEMA-VERSION sozinho basta — projeto recém-inicializado', () => {
  assertEqual(classify(fixture('fresh', { 'SCHEMA-VERSION': '3\n' })).kind, 'project');
});

test('STATE.md do dashboard não conta — é o caso ~/Development', () => {
  const dir = fixture('dash', {
    '.locks': null,
    'STATE.md': `<!-- ${DASHBOARD_MARKER} — do not edit by hand -->\n\n# GSD Dashboard\n\nNo active runs.\n`,
  });
  assertEqual(classify(dir).kind, 'touched');
});

test('STATE.md escrito à mão conta', () => {
  const dir = fixture('hand', { 'STATE.md': '# Estado\n\n**Active Milestone:** M001\n' });
  const r = classify(dir);
  assertEqual(r.kind, 'project');
  assert(r.signals.includes('STATE.md'), 'STATE.md deveria constar nos sinais');
});

// ── Ownership ───────────────────────────────────────────────────────────────

console.log('\nresolveOwner — estado pertence a quem é dono do trabalho');

test('repo tocado resolve para o projeto acima dele', () => {
  const owner = fixture('owner', { milestones: null });
  const repo = path.join(owner, 'services', 'freyr');
  fs.mkdirSync(repo, { recursive: true });
  assertEqual(resolveOwner(repo), fs.realpathSync(owner) === owner ? owner : path.resolve(owner));
});

test('projeto aninhado é dono de si mesmo', () => {
  const owner = fixture('outer', { milestones: null });
  const inner = path.join(owner, 'apps', 'odin');
  fs.mkdirSync(path.join(inner, '.gsd', 'milestones'), { recursive: true });
  assertEqual(resolveOwner(inner), path.resolve(inner));
});

test('sem projeto acima devolve null — nunca "crie um aqui"', () => {
  const dir = mkTmp('orphan');
  assertEqual(resolveOwner(dir, { stopAt: dir }), null);
});

// ── The three writers ───────────────────────────────────────────────────────

console.log('\nescritores — nenhum deles pode fabricar .gsd/');

test('forge-lock: acquire rejeita com ENOGSD e não cria nada', () => {
  // `acquire` is async and this runner is synchronous, so the rejection is
  // proven in a child process rather than asserted on a variable nothing
  // waits for — a test that declares an error it never inspects proves only
  // that the call did not crash the runner.
  const dir = mkTmp('lock');
  const probe = `
    const lock = require(${JSON.stringify(path.join(repoRoot, 'scripts', 'forge-lock.js'))});
    lock.acquire(${JSON.stringify(dir)}, 'STATE.md', { retries: 1 })
      .then(() => { console.log('RESOLVED'); })
      .catch(e => { console.log('CODE:' + e.code); });
  `;
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  assert(/CODE:ENOGSD/.test(r.stdout),
         `esperada rejeição ENOGSD, veio: ${r.stdout.trim()} ${r.stderr.trim()}`);
  assert(!fs.existsSync(path.join(dir, '.gsd')),
         'acquire criou .gsd/ — era exatamente esse mkdir -p que plantava o marcador');
});

test('forge-lock: tryAcquire devolve null e não cria nada', () => {
  const lock = require('./forge-lock.js');
  const dir = mkTmp('trylock');
  const got = lock.tryAcquire
    ? lock.tryAcquire(dir, 'STATE.md', {})
    : lock.tryAcquireSync(dir, 'STATE.md', {});
  assertEqual(got, null, 'diretório não inicializado deve contar como indisponível');
  assert(!fs.existsSync(path.join(dir, '.gsd')), 'tryAcquire criou .gsd/');
});

test('forge-lock: projeto de verdade continua travando normalmente', () => {
  const lock = require('./forge-lock.js');
  const dir = fixture('locked', { milestones: null });
  const held = lock.tryAcquire
    ? lock.tryAcquire(dir, 'STATE.md', {})
    : lock.tryAcquireSync(dir, 'STATE.md', {});
  assert(held !== null, 'lock legítimo não pode regredir');
  assert(fs.existsSync(path.join(dir, '.gsd', '.locks', 'STATE.md')), 'lock não foi criado');
  held.release();
});

test('forge-dashboard: recusa diretório que não é projeto e não cria nada', () => {
  const dir = mkTmp('dash-guard');
  const r = runScript('forge-dashboard.js', ['--cwd', dir]);
  assert(r.status !== 0, 'dashboard deveria falhar num diretório sem projeto');
  assert(/not a Forge project/.test(r.stderr), `stderr inesperado: ${r.stderr}`);
  assert(!fs.existsSync(path.join(dir, '.gsd')),
         'dashboard criou .gsd/ — foi assim que ~/Development/.gsd nasceu');
});

test('forge-verify: evento vai para o dono, marcado com o repo, sem criar .gsd no repo', () => {
  const owner = fixture('verify-owner', { milestones: null });
  const repo = path.join(owner, 'services', 'freyr');
  fs.mkdirSync(repo, { recursive: true });

  const r = runScript('forge-verify.js', ['--cwd', repo, '--unit', 'execute-task/T01']);
  assert(r.status === 0 || r.status === 1, `saída inesperada: ${r.status} ${r.stderr}`);

  assert(!fs.existsSync(path.join(repo, '.gsd')),
         'verify criou .gsd/ no repo verificado — o defeito original');

  const events = path.join(owner, '.gsd', 'forge', 'events.jsonl');
  assert(fs.existsSync(events), 'evento não foi gravado no projeto dono');
  const line = JSON.parse(fs.readFileSync(events, 'utf8').trim().split('\n').pop());
  assertEqual(line.event, 'verify');
  assertEqual(line.repo, 'freyr', 'o repo tocado precisa aparecer no evento');
  assertEqual(line.repo_path, path.resolve(repo));
});

test('forge-verify: no próprio projeto o evento não ganha campo repo', () => {
  const owner = fixture('verify-self', { milestones: null });
  const r = runScript('forge-verify.js', ['--cwd', owner, '--unit', 'execute-task/T02']);
  assert(r.status === 0 || r.status === 1, `saída inesperada: ${r.status} ${r.stderr}`);
  const events = path.join(owner, '.gsd', 'forge', 'events.jsonl');
  const line = JSON.parse(fs.readFileSync(events, 'utf8').trim().split('\n').pop());
  assert(!('repo' in line), 'campo repo só existe quando o repo != dono');
});

test('forge-verify: --gsd-dir vence a busca por ancestral', () => {
  const owner = fixture('verify-explicit', { milestones: null });
  const elsewhere = mkTmp('verify-code');   // worktree: .gsd não está acima dele
  const r = runScript('forge-verify.js',
                      ['--cwd', elsewhere, '--unit', 'execute-task/T03',
                       '--gsd-dir', path.join(owner, '.gsd')]);
  assert(r.status === 0 || r.status === 1, `saída inesperada: ${r.status} ${r.stderr}`);
  assert(!fs.existsSync(path.join(elsewhere, '.gsd')), 'verify criou .gsd/ no CODE_DIR');
  const events = path.join(owner, '.gsd', 'forge', 'events.jsonl');
  assert(fs.existsSync(events), 'evento não chegou no --gsd-dir indicado');
});

test('forge-verify: sem dono, avisa e não grava — nunca cria', () => {
  const orphan = mkTmp('verify-orphan');
  const r = runScript('forge-verify.js', ['--cwd', orphan, '--unit', 'execute-task/T04']);
  assert(!fs.existsSync(path.join(orphan, '.gsd')), 'verify criou .gsd/ órfão');
  assert(/no owning Forge project/.test(r.stderr),
         `esperado aviso explícito no stderr, veio: ${r.stderr}`);
});

// ── Summary ─────────────────────────────────────────────────────────────────

cleanup();
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
