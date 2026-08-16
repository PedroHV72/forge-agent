#!/usr/bin/env node
'use strict';

// Suíte pareada de forge-sweep-delete.js.
//
// Todo o fixture nasce em RUNTIME (D131/D135) — nenhum byte é commitado. O
// fixture é um repo git de verdade porque a única base de undo desta operação
// é o VCS: provar "undo = VCS" exige um working tree onde `.gsd/` está
// commitado, o que NÃO é o caso do repo do próprio forge-agent.

const assert = require('assert');
const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ledger = require('./forge-ledger');
const memory = require('./forge-memory');
const decisionsStore = require('./forge-decisions');
const journal = require('./forge-sweep-journal');
const {
  OPERATION,
  D11_AMENDMENT_DECISION,
  D11_AMENDMENT_UNIT_ID,
  checkD11Amendment,
  checkIndexGreen,
  buildRegistry,
  parseArgs,
  _private,
} = require('./forge-sweep-delete');
const { createEligibility } = require('./forge-sweep-eligibility');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function run() {
  for (const { name, fn } of tests) {
    try {
      fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`      ${error.stack || error.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

const UNIT_ID = 'M-20260101000000-fixture';

function git(cwd, args) {
  return cp.execSync(`git ${args}`, { cwd, stdio: 'pipe' }).toString();
}

// makeFixtureRepo — exportado para T04 reproduzir a mesma medição.
// opts.amendment (default true) — grava a emenda D11 no fragmento de decisões.
// opts.distilled (default true) — grava o fato DST- que prova a destilação.
// opts.ignoreWrapper (default false) — planta o invólucro sob um .gitignore.
function makeFixtureRepo(opts) {
  const options = opts || {};
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-delete-')));
  const unitId = options.unitId || UNIT_ID;

  fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'scripts', 'alvo.js'), '// alvo citado pelo fato destilado\n');

  const wrapperDir = path.join(cwd, '.gsd', 'milestones', unitId);
  fs.mkdirSync(wrapperDir, { recursive: true });
  fs.writeFileSync(path.join(wrapperDir, `${unitId}-SUMMARY.md`), '# resumo do invólucro\n\nconteúdo\n');

  ledger.writeFragment(cwd, {
    id: unitId,
    title: 'Fixture milestone',
    completed_at: '2026-08-15T00:00:00Z',
    slices: ['S01'],
    key_files: ['scripts/alvo.js'],
    key_decisions: ['decisão de fixture'],
    body: 'corpo do fixture',
  });

  if (options.distilled !== false) {
    memory.writeFragment(cwd, {
      unit_id: unitId,
      facts: [{
        mem_id: 'DST-001',
        category: 'architecture',
        text: 'O destilado desta unidade vive em `scripts/alvo.js` e nada mais.',
        created_at: '2026-08-15',
        source_unit: `complete-milestone/${unitId}`,
        confidence_base: '0.85',
        hits_initial: '0',
      }],
    });
  } else {
    memory.writeFragment(cwd, {
      unit_id: unitId,
      facts: [{
        mem_id: 'MEM001',
        category: 'architecture',
        text: 'Fato comum, sem destilação, citando `scripts/alvo.js`.',
        created_at: '2026-08-15',
        source_unit: `complete-milestone/${unitId}`,
        confidence_base: '0.85',
        hits_initial: '0',
      }],
    });
  }

  if (options.amendment !== false) writeAmendment(cwd);

  if (options.ignoreWrapper === true) {
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.gsd/milestones/\n');
  }

  git(cwd, 'init -q');
  git(cwd, 'config user.email fixture@example.com');
  git(cwd, 'config user.name fixture');
  // Sem isto o checkout de restauração converteria LF→CRLF no Windows e a
  // comparação byte-a-byte mediria a conversão do git, não a restauração.
  git(cwd, 'config core.autocrlf false');
  git(cwd, 'add -A');
  git(cwd, 'commit -qm fixture');
  return { cwd, unitId, wrapperDir };
}

function writeAmendment(cwd, when) {
  decisionsStore.writeFragment(cwd, {
    unit_id: D11_AMENDMENT_UNIT_ID,
    decisions: [{
      when: when || '2026-08-15',
      scope: 'milestone',
      decision: D11_AMENDMENT_DECISION,
      choice: 'permitida a deleção física pós-destilação',
      rationale: 'invólucro já respondido pelas 4 camadas',
      revisable: 'no',
    }],
  });
}

function cleanup(cwd) {
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

function withFixture(opts, fn) {
  const fixture = makeFixtureRepo(opts);
  try { return fn(fixture); } finally { cleanup(fixture.cwd); }
}

function previewFor(cwd, ctxExtra) {
  const ctx = Object.assign({ cwd }, ctxExtra || {});
  const eligibility = createEligibility(cwd);
  ctx.vcs = eligibility.vcs;
  const registry = buildRegistry();
  const result = registry.run(ctx, { filter: eligibility.filter });
  return { ctx, result, entry: result.preview.operations[0] };
}

function digestTree(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = path.join(current, entry.name);
      const nextRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next, nextRel);
      else hash.update(nextRel).update(fs.readFileSync(next));
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

// ── 1. Gate (1): emenda D11 lida do FRAGMENTO ────────────────────────────────
test('checkD11Amendment aprova quando o fragmento carrega a emenda datada', () => {
  withFixture({}, ({ cwd }) => {
    const result = checkD11Amendment(cwd);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.when, '2026-08-15');
  });
});

test('checkD11Amendment recusa d11-amendment-missing sem fragmento', () => {
  withFixture({ amendment: false }, ({ cwd }) => {
    const result = checkD11Amendment(cwd);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'd11-amendment-missing');
  });
});

test('checkD11Amendment recusa quando a decisão existe sem data válida', () => {
  withFixture({ amendment: false }, ({ cwd }) => {
    writeAmendment(cwd, 'quando der');
    const result = checkD11Amendment(cwd);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'd11-amendment-missing');
  });
});

test('o gate lê o fragmento, nunca .gsd/DECISIONS.md', () => {
  withFixture({ amendment: false }, ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, '.gsd', 'DECISIONS.md'), `| 2026-08-15 | ${D11_AMENDMENT_DECISION} |\n`);
    assert.strictEqual(checkD11Amendment(cwd).ok, false, 'projeção nunca autoriza a deleção');
    const source = fs.readFileSync(path.join(__dirname, 'forge-sweep-delete.js'), 'utf8');
    assert.ok(!/DECISIONS\.md/.test(source.replace(/^\/\/.*$/gm, '')), 'o código não referencia o monolito');
  });
});

// ── 2. Gate (2): índice verde re-medido ──────────────────────────────────────
test('checkIndexGreen aprova o fixture verde e reporta f2_recall', () => {
  withFixture({}, ({ cwd }) => {
    const result = checkIndexGreen(cwd);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.f2_recall, 1);
  });
});

test('green !== true vira index-not-green com reasons medidos', () => {
  const result = checkIndexGreen('/qualquer', { measureGreen: () => ({ green: false, reasons: ['f2-below-threshold'], f2_recall: 0.31 }) });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'index-not-green');
  assert.deepStrictEqual(result.reasons, ['f2-below-threshold']);
  assert.ok(result.detail.includes('0.31'));
});

test('retorno não-objeto e throw viram index-gate-unavailable', () => {
  const naoObjeto = checkIndexGreen('/qualquer', { measureGreen: () => 'não é json' });
  assert.strictEqual(naoObjeto.reason, 'index-gate-unavailable');
  const lancou = checkIndexGreen('/qualquer', { measureGreen: () => { throw new Error('spawn falhou'); } });
  assert.strictEqual(lancou.reason, 'index-gate-unavailable');
  assert.ok(lancou.detail.includes('spawn falhou'));
});

// ── 3. Ordem dura: falha em (1) ou (2) produz zero mutação ───────────────────
test('sem a emenda o preview recusa, lista o motivo e não deleta nada', () => {
  withFixture({ amendment: false }, ({ cwd, wrapperDir }) => {
    const { ctx, entry } = previewFor(cwd);
    assert.strictEqual(entry.targets.length, 0);
    assert.strictEqual(ctx.deleteRefusal.reason, 'd11-amendment-missing');
    assert.ok(entry.skipped.some(item => item.reason.startsWith('d11-amendment-missing')));
    assert.ok(fs.existsSync(wrapperDir), 'invólucro intocado');
  });
});

test('índice vermelho recusa no plan com index-not-green e zero mutação', () => {
  withFixture({}, ({ cwd, wrapperDir }) => {
    const ctx = { cwd, gateOpts: { measureGreen: () => ({ green: false, reasons: ['f2-below-threshold'], f2_recall: 0.3103 }) } };
    const plan = _private.deletePlan(ctx);
    assert.deepStrictEqual(plan.targets, []);
    assert.strictEqual(ctx.deleteRefusal.reason, 'index-not-green');
    assert.ok(ctx.deleteRefusal.detail.includes('0.3103'), 'o número medido é nomeado');
    assert.ok(fs.existsSync(wrapperDir));
  });
});

// ── 4. Preview verde ─────────────────────────────────────────────────────────
test('preview verde lista o invólucro como alvo elegível', () => {
  withFixture({}, ({ cwd, unitId }) => {
    const { entry, ctx } = previewFor(cwd);
    assert.strictEqual(ctx.deleteRefusal, null);
    assert.strictEqual(entry.targets.length, 1);
    assert.strictEqual(entry.targets[0].unitId, unitId);
    assert.strictEqual(entry.targets[0].relPath, `.gsd/milestones/${unitId}`);
    assert.strictEqual(entry.targets[0].closure.ok, true);
  });
});

test('raiz ausente entra no censo com dir-missing, nunca some', () => {
  withFixture({}, ({ cwd }) => {
    const { entry } = previewFor(cwd);
    const missing = entry.skipped.filter(item => item.reason === 'dir-missing').map(item => item.path);
    assert.ok(missing.includes('.gsd/tasks'), `.gsd/tasks ausente deve ser enumerado: ${JSON.stringify(entry.skipped)}`);
    assert.ok(missing.includes('.gsd/archive'));
  });
});

test('enumerateWrappers cobre milestones, tasks e archive', () => {
  withFixture({}, ({ cwd, unitId }) => {
    fs.mkdirSync(path.join(cwd, '.gsd', 'tasks', 'T-20260101000000-x'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.gsd', 'archive', 'M-20250101000000-y'), { recursive: true });
    const { candidates, census } = _private.enumerateWrappers(cwd);
    const ids = candidates.map(item => item.unitId).sort();
    assert.deepStrictEqual(ids, ['M-20250101000000-y', 'M-20260101000000-fixture', 'T-20260101000000-x'].sort());
    assert.strictEqual(census.length, 0, 'nenhuma raiz ausente quando as três existem');
    assert.strictEqual(unitId, UNIT_ID);
  });
});

// ── 5. Fence de fase ativa ───────────────────────────────────────────────────
test('unidade com run ativa é recusada com active-phase', () => {
  withFixture({}, ({ cwd, unitId, wrapperDir }) => {
    const runsDir = path.join(cwd, '.gsd', 'forge', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, `${unitId}.json`), JSON.stringify({
      id: unitId, milestone: unitId, active: true, kind: 'milestone', started_at: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(wrapperDir, `${unitId}-STATE.md`), [
      '---', `milestone: ${unitId}`, 'kind: milestone', '---', '',
      '**Active Slice:** S01', '**Active Task:** T01', '**Phase:** execute', '',
    ].join('\n'));
    git(cwd, 'add -A');
    git(cwd, 'commit -qm "run ativa"');
    const { entry } = previewFor(cwd);
    assert.strictEqual(entry.targets.length, 0);
    // A razão precisa ser 'active-phase' (fase medida), nunca a degradação
    // 'active-phase-unknown' — que passaria pelo teste sem provar o fence.
    assert.ok(entry.skipped.some(item => item.reason === 'active-phase'),
      `esperava fence de fase medido: ${JSON.stringify(entry.skipped)}`);
    assert.ok(fs.existsSync(wrapperDir));
  });
});

// ── 6. Camadas de fechamento como gate ───────────────────────────────────────
test('unidade sem fato DST- é recusada com not-distilled', () => {
  withFixture({ distilled: false }, ({ cwd, wrapperDir }) => {
    const { entry } = previewFor(cwd);
    assert.strictEqual(entry.targets.length, 0);
    assert.ok(entry.skipped.some(item => item.reason.includes('not-distilled')), JSON.stringify(entry.skipped));
    assert.ok(fs.existsSync(wrapperDir));
  });
});

test('unidade sem entrada de ledger é recusada com no-ledger-entry', () => {
  withFixture({}, ({ cwd, unitId }) => {
    fs.rmSync(path.join(cwd, '.gsd', 'ledger', `${unitId}.md`));
    const { entry } = previewFor(cwd);
    assert.strictEqual(entry.targets.length, 0);
    assert.ok(entry.skipped.some(item => item.reason.includes('no-ledger-entry')), JSON.stringify(entry.skipped));
  });
});

test('unidade fora do índice é recusada com not-in-index', () => {
  withFixture({}, ({ cwd, unitId }) => {
    // Um invólucro cuja unidade nunca produziu fragmento de memória: sem
    // entrada no índice e sem destilação — as duas recusas são nomeadas.
    const outro = 'M-20250505000000-sem-indice';
    fs.mkdirSync(path.join(cwd, '.gsd', 'milestones', outro), { recursive: true });
    ledger.writeFragment(cwd, { id: outro, title: 'sem índice', completed_at: '2026-08-15T00:00:00Z', slices: [], key_files: [], key_decisions: [], body: 'x' });
    const { entry } = previewFor(cwd);
    const skip = entry.skipped.find(item => item.path === `.gsd/milestones/${outro}`);
    assert.ok(skip, JSON.stringify(entry.skipped));
    assert.ok(skip.reason.includes('not-in-index'), skip.reason);
    assert.strictEqual(entry.targets.length, 1, 'o alvo fechado segue elegível');
    assert.strictEqual(entry.targets[0].unitId, unitId);
  });
});

// ── 7. Eligibility base vcs estrita (tool-undo proibido) ─────────────────────
test('invólucro ignorado pelo VCS é sempre recusado, com motivo nomeado', () => {
  withFixture({ ignoreWrapper: true }, ({ cwd, wrapperDir }) => {
    const { entry } = previewFor(cwd);
    assert.strictEqual(entry.targets.length, 0);
    assert.ok(entry.skipped.some(item => /ignorado pelo VCS|não versionado/.test(item.reason)),
      `esperava recusa por estado do VCS: ${JSON.stringify(entry.skipped)}`);
    assert.ok(fs.existsSync(wrapperDir), 'nada é deletado');
  });
});

test('createEligibility é chamado sem toolUndo — nenhuma base tool-undo aparece', () => {
  withFixture({ ignoreWrapper: true }, ({ cwd }) => {
    const { entry } = previewFor(cwd);
    assert.deepStrictEqual(entry.bases || [], [], 'nenhuma promoção por undo de ferramenta');
    const source = fs.readFileSync(path.join(__dirname, 'forge-sweep-delete.js'), 'utf8');
    assert.ok(!/toolUndo/.test(source.replace(/^\s*\/\/.*$/gm, '')), 'o código nunca passa toolUndo');
  });
});

// ── 8. apply: re-execução dos gates (D-2) ────────────────────────────────────
test('apply recusa quando o índice fica vermelho entre o plan e o apply', () => {
  withFixture({}, ({ cwd, wrapperDir }) => {
    const ctx = { cwd, vcs: 'git' };
    const plan = _private.deletePlan(ctx);
    assert.strictEqual(plan.targets.length, 1, 'plano nasceu verde');
    // O índice fica vermelho DEPOIS do plano: um fato novo menciona um arquivo
    // que o extrator de citações não captura → f2_recall cai abaixo do piso.
    // A extensão precisa ser sinal para o detector F2 e ficar FORA de CODE_EXT:
    // `.txt` servia até entrar em CODE_EXT (junto de jsonl/jsonc/swift, para
    // fechar misses reais como `events.jsonl` e `seed.txt`), o que tornava a
    // menção capturada e deixava o índice verde — o teste passava a não medir
    // nada. `.py` é sinal para o detector (lista curada, deliberadamente mais
    // larga) e não é extraído, que é exatamente o gap que este caso precisa.
    memory.writeFragment(cwd, {
      unit_id: UNIT_ID,
      facts: [{
        mem_id: 'MEM009',
        category: 'gotcha',
        text: 'Veja tambem notas/leia.py para o resto da historia.',
        created_at: '2026-08-15',
        source_unit: `complete-milestone/${UNIT_ID}`,
        confidence_base: '0.85',
        hits_initial: '0',
      }],
    });
    assert.strictEqual(checkIndexGreen(cwd).ok, false, 'índice ficou vermelho de fato');
    const result = _private.applyDelete(ctx, plan);
    assert.strictEqual(result.error, 'index-not-green');
    assert.deepStrictEqual(result.deleted, []);
    assert.ok(fs.existsSync(wrapperDir), 'zero mutação');
  });
});

test('apply recusa quando a emenda some entre o plan e o apply', () => {
  withFixture({}, ({ cwd, unitId, wrapperDir }) => {
    const ctx = { cwd, vcs: 'git' };
    const plan = _private.deletePlan(ctx);
    assert.strictEqual(plan.targets.length, 1);
    fs.rmSync(path.join(cwd, '.gsd', 'decisions', `${D11_AMENDMENT_UNIT_ID}.md`));
    const result = _private.applyDelete(ctx, plan);
    assert.strictEqual(result.error, 'd11-amendment-missing');
    assert.deepStrictEqual(result.deleted, []);
    assert.ok(fs.existsSync(path.join(cwd, '.gsd', 'milestones', unitId)));
    assert.ok(fs.existsSync(wrapperDir));
  });
});

// ── 9. apply verde: deleção + journal + relatório + undo VCS ─────────────────
test('apply deleta, registra ponteiros no journal e emite as 4 camadas + undo', () => {
  withFixture({}, ({ cwd, unitId, wrapperDir }) => {
    const ctx = { cwd, vcs: 'git' };
    const plan = _private.deletePlan(ctx);
    const result = _private.applyDelete(ctx, plan);
    assert.deepStrictEqual(result.deleted, [`.gsd/milestones/${unitId}`]);
    assert.ok(!fs.existsSync(wrapperDir), 'invólucro removido do disco');

    const report = result.report.join('\n');
    assert.ok(report.includes('## Fechamento em 4 camadas'), report);
    assert.ok(report.includes('LEDGER: ok'));
    assert.ok(report.includes('DISTILLED: ok'));
    assert.ok(report.includes('INDEX: ok'));
    assert.ok(report.includes('KNOWLEDGE:'));
    assert.ok(report.includes(`git checkout -- .gsd/milestones/${unitId}`), 'comando de undo exato');

    const entries = journal.listEntries(cwd);
    assert.strictEqual(entries.ok, true);
    const intent = entries.entries.find(item => item.phase === 'apply-intent');
    const done = entries.entries.find(item => item.phase === 'apply-done');
    assert.ok(intent && intent.operation === OPERATION);
    assert.deepStrictEqual(intent.containers, [`.gsd/milestones/${unitId}`]);
    assert.ok(done && done.id === intent.id);
    const raw = fs.readFileSync(path.join(cwd, '.gsd', 'forge', 'sweep-journal.jsonl'), 'utf8');
    assert.ok(!raw.includes('resumo do invólucro'), 'nenhum byte de conteúdo entra no journal');
  });
});

test('svn recebe o comando de undo próprio', () => {
  assert.strictEqual(_private.undoCommand('svn', '.gsd/tasks/T-1'), 'svn revert -R .gsd/tasks/T-1');
  assert.strictEqual(_private.undoCommand('git', '.gsd/tasks/T-1'), 'git checkout -- .gsd/tasks/T-1');
});

// ── 10. Undo real: git restaura byte-idêntico ────────────────────────────────
test('git checkout restaura o invólucro deletado byte a byte', () => {
  withFixture({}, ({ cwd, unitId, wrapperDir }) => {
    const before = digestTree(wrapperDir);
    const ctx = { cwd, vcs: 'git' };
    const plan = _private.deletePlan(ctx);
    _private.applyDelete(ctx, plan);
    assert.ok(!fs.existsSync(wrapperDir));
    git(cwd, `checkout -- .gsd/milestones/${unitId}`);
    assert.strictEqual(digestTree(wrapperDir), before, 'restauração byte-idêntica');
  });
});

// ── 11. Journal indisponível: warn, nunca recusa (alvos all-vcs) ─────────────
test('falha do intent do journal vira aviso e a aplicação prossegue', () => {
  withFixture({}, ({ cwd, unitId, wrapperDir }) => {
    // Um arquivo no lugar do diretório .gsd/forge impede o append do journal.
    fs.rmSync(path.join(cwd, '.gsd', 'forge'), { recursive: true, force: true });
    fs.writeFileSync(path.join(cwd, '.gsd', 'forge'), 'bloqueio\n');
    const ctx = { cwd, vcs: 'git' };
    const plan = _private.deletePlan(ctx);
    const result = _private.applyDelete(ctx, plan);
    assert.deepStrictEqual(result.deleted, [`.gsd/milestones/${unitId}`]);
    assert.strictEqual(result.journalId, null);
    assert.ok(!fs.existsSync(wrapperDir));
  });
});

// ── 12. Zero containers (D11 permanece) ──────────────────────────────────────
test('o módulo não importa forge-epoch-group nem forge-grouped-file', () => {
  const source = fs.readFileSync(path.join(__dirname, 'forge-sweep-delete.js'), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/require\(['"]\.\/forge-epoch-group['"]\)/.test(code));
  assert.ok(!/require\(['"]\.\/forge-grouped-file['"]\)/.test(code));
  assert.ok(!/forge-epoch-group|forge-grouped-file/.test(code), 'nenhuma referência a containerização');
});

// ── 13. CLI ──────────────────────────────────────────────────────────────────
test('parseArgs aceita as flags previstas e recusa combinações inválidas', () => {
  const options = parseArgs(['--cwd', '/tmp/x', '--apply', '--yes', '--json']);
  assert.deepStrictEqual(options, { cwd: '/tmp/x', apply: true, yes: true, json: true, help: false });
  assert.strictEqual(parseArgs([]).apply, false, 'dry-run é o default');
  assert.throws(() => parseArgs(['--yes']), /--yes exige --apply/);
  assert.throws(() => parseArgs(['--apply', '--json']), /exige --yes/);
  assert.throws(() => parseArgs(['--zzz']), /argumento desconhecido/);
});

test('CLI dry-run não deleta e sai 0; --apply --yes deleta e sai 0', () => {
  withFixture({}, ({ cwd, unitId, wrapperDir }) => {
    const cli = path.join(__dirname, 'forge-sweep-delete.js');
    const dry = cp.spawnSync(process.execPath, [cli, '--cwd', cwd], { encoding: 'utf8' });
    assert.strictEqual(dry.status, 0, dry.stderr);
    assert.ok(dry.stdout.includes(unitId) && dry.stdout.includes('membro(s)'), dry.stdout);
    assert.ok(fs.existsSync(wrapperDir), 'dry-run é read-only');

    const applied = cp.spawnSync(process.execPath, [cli, '--cwd', cwd, '--apply', '--yes'], { encoding: 'utf8' });
    assert.strictEqual(applied.status, 0, applied.stderr);
    assert.ok(applied.stdout.includes('Fechamento em 4 camadas'), applied.stdout);
    assert.ok(applied.stdout.includes('git checkout --'), applied.stdout);
    assert.ok(!fs.existsSync(wrapperDir));
  });
});

test('CLI sai 1 quando o gate recusa, sem deletar', () => {
  withFixture({ amendment: false }, ({ cwd, wrapperDir }) => {
    const cli = path.join(__dirname, 'forge-sweep-delete.js');
    const result = cp.spawnSync(process.execPath, [cli, '--cwd', cwd, '--json'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.refusal.reason, 'd11-amendment-missing');
    assert.strictEqual(payload.applied, false);
    assert.ok(fs.existsSync(wrapperDir));
  });
});

test('CLI recusa argumento inválido com código 2', () => {
  const result = cp.spawnSync(process.execPath, [path.join(__dirname, 'forge-sweep-delete.js'), '--zzz'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2, result.stderr);
});

// Guard de regressão do defeito achado em T04: exportar os helpers só serve se
// requerer o arquivo NÃO rodar a suíte. A asserção é sobre o stdout do require
// (vazio), não sobre o exit code — sem a guarda o require roda os 29 testes,
// imprime as linhas "✓" e ainda assim sai 0, então exit code não morde.
test('requerer a suíte expõe os helpers sem executar nenhum teste', () => {
  const probe = [
    `const m = require(${JSON.stringify(path.join(__dirname, 'forge-sweep-delete.test.js'))});`,
    'const p = m._private || {};',
    "for (const name of ['makeFixtureRepo', 'writeAmendment', 'digestTree', 'cleanup']) {",
    "  if (typeof p[name] !== 'function') { process.stderr.write('faltou ' + name); process.exit(3); }",
    '}',
  ].join('\n');
  const result = cp.spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, '', `require executou a suíte: ${result.stdout.slice(0, 200)}`);
});

module.exports = { _private: { makeFixtureRepo, writeAmendment, digestTree, cleanup } };

// T04 (dogfood) achou o defeito: o comentário de makeFixtureRepo promete a
// exportação "para T04 reproduzir a mesma medição", mas `run()` sem guarda
// executava a suíte inteira — e chamava process.exit — no ATO do require,
// tornando a exportação inalcançável. run-tests.js spawna cada suíte como
// processo próprio (scripts/run-tests.js:152), então a guarda não muda nada
// para o runner: quem roda o arquivo continua rodando os testes.
if (require.main === module) run();
