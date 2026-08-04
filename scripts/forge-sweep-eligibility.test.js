#!/usr/bin/env node
'use strict';

// Standalone coverage for the safety gate.  The fixture deliberately uses a
// real repository because mocked status output cannot prove the status flags
// include ignored descendants and individual untracked descendants.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createEligibility, classifyPath } = require('./forge-sweep-eligibility');

let passed = 0;
let skipped = 0;

function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

function skip(name) {
  skipped += 1;
  process.stdout.write(`  - ${name} (git indisponível no PATH)\n`);
}

function run(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}

function gitAvailable() {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8', shell: false });
  return result.status === 0;
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function target(cwd, names) {
  return {
    store: 'ledger',
    epoch: '2026-08',
    containerPath: path.join(cwd, '.gsd', 'forge', 'ledger', '2026-08.md'),
    members: names.map((name) => ({ id: name, path: path.join(cwd, name) })),
  };
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-eligibility-'));
  run(cwd, ['init', '-q']);
  run(cwd, ['config', 'user.name', 'Forge Test']);
  run(cwd, ['config', 'user.email', 'forge@example.invalid']);
  for (const name of ['limpo.md', 'sujo.md']) fs.writeFileSync(path.join(cwd, name), `${name} inicial\n`);
  fs.mkdirSync(path.join(cwd, '.gsd', 'forge', 'ledger'), { recursive: true });
  run(cwd, ['add', 'limpo.md', 'sujo.md']);
  run(cwd, ['commit', '-qm', 'initial fixture']);
  fs.writeFileSync(path.join(cwd, 'sujo.md'), 'mudança local\n');
  fs.writeFileSync(path.join(cwd, 'novo.md'), 'não rastreado\n');
  fs.writeFileSync(path.join(cwd, 'staged.md'), 'adicionado ao índice\n');
  run(cwd, ['add', 'staged.md']);
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'ignorado/\n');
  fs.mkdirSync(path.join(cwd, 'ignorado'));
  fs.writeFileSync(path.join(cwd, 'ignorado', 'um.md'), 'ignorado\n');
  return cwd;
}

function cleanup(cwd) {
  fs.rmSync(cwd, { recursive: true, force: true });
}

test('sem VCS recusa por padrão e force é estrito', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-no-vcs-'));
  try {
    const ordinary = createEligibility(cwd);
    const candidate = target(cwd, ['limpo.md']);
    assert.strictEqual(ordinary.vcs, 'none');
    assert.strictEqual(ordinary.forced, false);
    assert.deepStrictEqual(ordinary.filter(candidate), {
      eligible: false,
      reason: 'sem VCS — não há como desfazer',
    });
    assert.strictEqual(ordinary.skipped.length, 1);
    assert.strictEqual(createEligibility(cwd, { force: 'true' }).filter(candidate).eligible, false);
    assert.strictEqual(createEligibility(cwd, { force: 1 }).filter(candidate).eligible, false);
    const forced = createEligibility(cwd, { force: true });
    assert.strictEqual(forced.forced, true);
    assert.strictEqual(forced.filter(candidate).eligible, true);
  } finally { cleanup(cwd); }
});

test('status query failure fails closed and records its error', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-status-failure-'));
  try {
    let calls = 0;
    const eligibility = createEligibility(cwd, {
      detectVcs: () => 'git',
      workingStatus: () => { calls += 1; return { ok: false, error: 'status indisponível' }; },
    });
    const result = eligibility.filter(target(cwd, ['limpo.md']));
    assert.strictEqual(calls, 1);
    assert.strictEqual(result.eligible, false);
    assert.match(result.reason, /status indisponível/);
  } finally { cleanup(cwd); }
});

test('consulta o status uma vez e examina membros, invólucro e container', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-one-query-'));
  try {
    let detectCalls = 0;
    let statusCalls = 0;
    const wrapper = path.join(cwd, 'wrapper');
    const candidate = {
      containerPath: path.join(cwd, 'container.md'),
      members: [{ id: 'one', path: path.join(cwd, 'limpo.md'), wrapperPath: wrapper }],
    };
    const eligibility = createEligibility(cwd, {
      detectVcs: () => { detectCalls += 1; return 'git'; },
      workingStatus: () => {
        statusCalls += 1;
        return { ok: true, entries: [{ path: 'wrapper', code: ' M', kind: 'modified' }] };
      },
    });
    assert.strictEqual(detectCalls, 1);
    assert.strictEqual(statusCalls, 1);
    const result = eligibility.filter(candidate);
    assert.strictEqual(result.eligible, false);
    assert.match(result.reason, /wrapper.*modificado localmente/);
    assert.strictEqual(statusCalls, 1);
  } finally { cleanup(cwd); }
});

test('normaliza o caminho local antes da comparação e recusa fora do cwd', () => {
  const cwd = path.join(path.parse(process.cwd()).root, 'forge', 'workspace');
  const statuses = new Map([['pasta/arquivo.md', 'modified']]);
  const inside = classifyPath(cwd, path.join(cwd, 'pasta', 'arquivo.md'), statuses);
  const outside = classifyPath(cwd, path.resolve(cwd, '..', 'estranho.md'), statuses);
  assert.strictEqual(inside.eligible, false);
  assert.match(inside.reason, /pasta\/arquivo\.md/);
  assert.deepStrictEqual(outside, { eligible: false, reason: 'caminho fora do cwd' });
});

test('a fonte da política não contém verbos destrutivos de VCS', () => {
  const source = fs.readFileSync(path.join(__dirname, 'forge-sweep-eligibility.js'), 'utf8');
  assert.doesNotMatch(source, /\b(commit|push|revert|checkout|stash|reset)\b/);
  assert.doesNotMatch(source, /git add/);
});

if (gitAvailable()) {
  test('só o alvo limpo passa; estados e conteúdo ficam idênticos após o filtro', () => {
    const cwd = fixture();
    try {
      const files = ['limpo.md', 'sujo.md', 'novo.md', 'staged.md'];
      const beforeHashes = new Map(files.map((name) => [name, fileHash(path.join(cwd, name))]));
      const beforeStatus = run(cwd, ['status', '--porcelain', '-uall', '-z', '--ignored']);
      const eligibility = createEligibility(cwd);
      const clean = eligibility.filter(target(cwd, ['limpo.md']));
      const modified = eligibility.filter(target(cwd, ['sujo.md']));
      const untracked = eligibility.filter(target(cwd, ['novo.md']));
      const added = eligibility.filter(target(cwd, ['staged.md']));
      assert.deepStrictEqual(clean, { eligible: true });
      assert.strictEqual(modified.eligible, false);
      assert.match(modified.reason, /sujo\.md.*modificado localmente/);
      assert.strictEqual(untracked.eligible, false);
      assert.match(untracked.reason, /novo\.md.*não versionado/);
      assert.strictEqual(added.eligible, false);
      assert.match(added.reason, /staged\.md.*adicionado e não commitado/);
      assert.strictEqual(eligibility.skipped.length, 3);
      for (const name of files) assert.strictEqual(fileHash(path.join(cwd, name)), beforeHashes.get(name));
      assert.strictEqual(run(cwd, ['status', '--porcelain', '-uall', '-z', '--ignored']), beforeStatus);
    } finally { cleanup(cwd); }
  });

  test('um alvo inteiro recusa quando apenas um membro está sujo', () => {
    const cwd = fixture();
    try {
      const eligibility = createEligibility(cwd);
      const result = eligibility.filter(target(cwd, ['limpo.md', 'sujo.md']));
      assert.strictEqual(result.eligible, false);
      assert.match(result.reason, /sujo\.md.*modificado localmente/);
      assert.strictEqual(eligibility.skipped.length, 1);
    } finally { cleanup(cwd); }
  });

  test('arquivo ignorado dentro de diretório ignorado é encontrado individualmente', () => {
    const cwd = fixture();
    try {
      const eligibility = createEligibility(cwd);
      const result = eligibility.filter(target(cwd, ['ignorado/um.md']));
      assert.strictEqual(result.eligible, false);
      assert.match(result.reason, /ignorado\/um\.md.*ignorado pelo VCS/);
    } finally { cleanup(cwd); }
  });
} else {
  skip('casos com repositório Git real');
}

process.stdout.write(`forge-sweep-eligibility: ${passed} passed, ${skipped} skipped\n`);
