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

test('a fonte da política não invoca comandos destrutivos de VCS', () => {
  // Anchored on command form, not on bare words: the previous version matched
  // Array.prototype.push and pressured the module into paths[paths.length]=…,
  // dictating non-idiomatic style to satisfy itself.
  const source = fs.readFileSync(path.join(__dirname, 'forge-sweep-eligibility.js'), 'utf8');
  assert.doesNotMatch(source, /\bgit\s+(commit|push|revert|checkout|stash|reset|add|clean|rm)\b/);
  assert.doesNotMatch(source, /\bsvn\s+(commit|revert|delete|rm|cleanup)\b/);
  assert.doesNotMatch(source, /['"](commit|revert|checkout|stash|reset|clean)['"]/);
  // The guard must remain able to see a real invocation in both spellings:
  // a shell command line, and a verb in an argv array.
  assert.match('run(cwd, `git reset --hard`)', /\bgit\s+(commit|push|revert|checkout|stash|reset|add|clean|rm)\b/);
  assert.match('spawnSync("git", ["reset", "--hard"])', /['"](commit|revert|checkout|stash|reset|clean)['"]/);
  // …and must not fire on the idiomatic array append it used to forbid.
  assert.doesNotMatch('paths.push(member.path);', /\bgit\s+(commit|push|revert|checkout|stash|reset|add|clean|rm)\b/);
  assert(source.includes('paths.push('), 'o módulo deve poder usar .push() idiomático');
});

test('ancestral não versionado ou ignorado recusa o descendente', () => {
  // git -uall --ignored enumerates descendants; svn status does not, so the
  // per-path record alone would read a path under an unversioned directory as
  // clean.  Failing closed on any ancestor is what equalises the two.
  const cwd = path.join(path.parse(process.cwd()).root, 'forge', 'workspace');
  for (const kind of ['untracked', 'ignored']) {
    const statuses = new Map([['pasta', kind]]);
    const deep = classifyPath(cwd, path.join(cwd, 'pasta', 'sub', 'arquivo.md'), statuses);
    assert.strictEqual(deep.eligible, false, `descendente de ancestral ${kind} passou`);
    assert.match(deep.reason, /sob pasta/);
  }
  // A modified ancestor does not hide descendants, so it must not propagate.
  const modified = new Map([['pasta', 'modified']]);
  assert.strictEqual(classifyPath(cwd, path.join(cwd, 'pasta', 'arquivo.md'), modified).eligible, true);
  // A sibling prefix is not an ancestor.
  const sibling = new Map([['pas', 'untracked']]);
  assert.strictEqual(classifyPath(cwd, path.join(cwd, 'pasta', 'arquivo.md'), sibling).eligible, true);
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

// --- B2: named tool-undo basis -------------------------------------------
// These use injected detectVcs/workingStatus (like the status-failure test
// above) rather than a real git fixture: full control over statuses without
// needing a git binary, and this file is written-not-run per Step 5.

function eligibilityWithStatuses(cwd, entries, opts = {}) {
  return createEligibility(cwd, {
    detectVcs: () => 'git',
    workingStatus: () => ({ ok: true, entries }),
    ...opts,
  });
}

function workspaceCwd() {
  return path.join(path.parse(process.cwd()).root, 'forge', 'workspace');
}

test('sem opts.toolUndo, o filtro recusa igual ao atual (regressão byte-idêntica)', () => {
  const cwd = workspaceCwd();
  const eligibility = eligibilityWithStatuses(cwd, [{ path: '.gsd', kind: 'ignored' }]);
  const result = eligibility.filter(target(cwd, [path.join('.gsd', 'forge', 'ledger.md')]));
  assert.strictEqual(result.eligible, false);
  assert.match(result.reason, /sob \.gsd, ignorado pelo VCS/);
  assert.strictEqual(result.basis, undefined);
});

test('toolUndo disponível promove alvo untracked direto para basis tool-undo', () => {
  const cwd = workspaceCwd();
  const eligibility = eligibilityWithStatuses(cwd, [{ path: 'novo.md', kind: 'untracked' }], {
    toolUndo: { available: true },
  });
  const result = eligibility.filter(target(cwd, ['novo.md']));
  assert.strictEqual(result.eligible, true);
  assert.strictEqual(result.basis, 'tool-undo');
  assert.match(result.note, /não versionado/);
  assert.match(result.note, /elegível por undo de ferramenta/);
});

test('toolUndo disponível promove alvo sob ancestral ignorado', () => {
  const cwd = workspaceCwd();
  const eligibility = eligibilityWithStatuses(cwd, [{ path: 'pasta', kind: 'ignored' }], {
    toolUndo: { available: true },
  });
  const result = eligibility.filter(target(cwd, [path.join('pasta', 'arquivo.md')]));
  assert.strictEqual(result.eligible, true);
  assert.strictEqual(result.basis, 'tool-undo');
  assert.match(result.note, /sob pasta, ignorado pelo VCS/);
});

test('caminho limpo com toolUndo ativo reporta basis vcs', () => {
  const cwd = workspaceCwd();
  const eligibility = eligibilityWithStatuses(cwd, [], { toolUndo: { available: true } });
  const result = eligibility.filter(target(cwd, ['limpo.md']));
  assert.deepStrictEqual(result, { eligible: true, basis: 'vcs' });
});

test('estados de arquivo rastreado sujo recusam mesmo com toolUndo disponível (DS8-2)', () => {
  const cwd = workspaceCwd();
  for (const kind of ['modified', 'added', 'deleted']) {
    const eligibility = eligibilityWithStatuses(cwd, [{ path: 'sujo.md', kind }], {
      toolUndo: { available: true },
    });
    const result = eligibility.filter(target(cwd, ['sujo.md']));
    assert.strictEqual(result.eligible, false, `kind ${kind} não deveria promover`);
    assert.strictEqual(result.basis, undefined);
  }
});

test('toolUndo com available:false recusa exatamente como o default (B2)', () => {
  const cwd = workspaceCwd();
  const entries = [{ path: 'novo.md', kind: 'untracked' }];
  const withFalse = eligibilityWithStatuses(cwd, entries, { toolUndo: { available: false } });
  const withoutOpt = eligibilityWithStatuses(cwd, entries);
  const candidate = target(cwd, ['novo.md']);
  assert.deepStrictEqual(withFalse.filter(candidate), withoutOpt.filter(candidate));
  assert.strictEqual(withFalse.filter(candidate).eligible, false);
});

test("toolUndo.available string/numérico não ativa (comparação estrita, MEM001)", () => {
  const cwd = workspaceCwd();
  for (const bogus of ['true', 1]) {
    const eligibility = eligibilityWithStatuses(cwd, [{ path: 'novo.md', kind: 'untracked' }], {
      toolUndo: { available: bogus },
    });
    const result = eligibility.filter(target(cwd, ['novo.md']));
    assert.strictEqual(result.eligible, false, `available:${JSON.stringify(bogus)} não deveria ativar`);
    assert.strictEqual(result.basis, undefined);
  }
});

test('ramo sem VCS ignora toolUndo por completo (herdada 7 travada)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-no-vcs-tool-undo-'));
  try {
    const withToolUndo = createEligibility(cwd, { toolUndo: { available: true } });
    const without = createEligibility(cwd);
    const candidate = target(cwd, ['limpo.md']);
    assert.deepStrictEqual(withToolUndo.filter(candidate), without.filter(candidate));
    assert.strictEqual(withToolUndo.filter(candidate).eligible, false);
    assert.strictEqual(withToolUndo.vcs, 'none');
  } finally { cleanup(cwd); }
});

test('classifyPath expõe kind/via aditivos sem alterar a string reason', () => {
  const cwd = workspaceCwd();
  const direct = classifyPath(cwd, path.join(cwd, 'novo.md'), new Map([['novo.md', 'untracked']]));
  assert.strictEqual(direct.kind, 'untracked');
  assert.strictEqual(direct.via, 'direct');
  assert.strictEqual(direct.reason, 'novo.md — não versionado');
  const ancestor = classifyPath(cwd, path.join(cwd, 'pasta', 'arquivo.md'), new Map([['pasta', 'ignored']]));
  assert.strictEqual(ancestor.kind, 'ignored');
  assert.strictEqual(ancestor.via, 'ancestor');
  assert.strictEqual(ancestor.reason, 'pasta/arquivo.md — sob pasta, ignorado pelo VCS');
});

process.stdout.write(`forge-sweep-eligibility: ${passed} passed, ${skipped} skipped\n`);
