#!/usr/bin/env node
'use strict';

// Standalone CLI coverage.  This suite is intentionally not run while the
// task is implemented; the repository runner discovers it after handoff.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cliPath = path.join(__dirname, 'forge-sweep-project.js');
const { buildRegistry } = require('./forge-sweep-project');

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

function runScript(cwd, args) {
  return spawnSync(process.execPath, [cliPath, '--cwd', cwd, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
}

function gitAvailable() {
  return spawnSync('git', ['--version'], { encoding: 'utf8', shell: false }).status === 0;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(' ')} falhou`);
}

function treeSnapshot(root) {
  const rows = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        rows.push({ relative, kind: 'dir' });
        visit(full);
      } else {
        rows.push({ relative, kind: 'file', bytes: fs.readFileSync(full).toString('base64') });
      }
    }
  }
  visit(root);
  return rows.sort((a, b) => a.relative.localeCompare(b.relative));
}

function writeLedger(cwd, id, completedAt) {
  const dir = path.join(cwd, '.gsd', 'forge', 'ledger');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), [
    '---',
    `id: ${id}`,
    `completed_at: ${completedAt}`,
    '---',
    '',
    `fragmento ${id}`,
  ].join('\n'));
}

function writeWrappers(cwd) {
  for (const root of ['milestones', 'tasks']) {
    const wrapper = path.join(cwd, '.gsd', root, 'eligible-wrapper');
    fs.mkdirSync(wrapper, { recursive: true });
    fs.writeFileSync(path.join(wrapper, 'PLAN.md'), `wrapper ${root}\n`);
  }
}

function fixture(withVcs) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-project-'));
  writeLedger(cwd, 'M-20250101000000-alpha', '2025-01-01T00:00:00Z');
  writeLedger(cwd, 'M-20250401000000-beta', '2025-04-01T00:00:00Z');
  writeWrappers(cwd);
  if (withVcs) {
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.name', 'Forge Test']);
    git(cwd, ['config', 'user.email', 'forge@example.invalid']);
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-qm', 'fixture inicial']);
  }
  return cwd;
}

function cleanup(cwd) {
  fs.rmSync(cwd, { recursive: true, force: true });
}

function wrapperBytes(cwd) {
  return ['milestones', 'tasks'].map(root => ({
    root,
    bytes: fs.readFileSync(path.join(cwd, '.gsd', root, 'eligible-wrapper', 'PLAN.md')),
  }));
}

test('o registro contém apenas a operação número um', () => {
  const operations = buildRegistry().list();
  assert.strictEqual(operations.length, 1);
  assert.strictEqual(operations[0].name, 'agrupar-epocas-seladas');
});

test('fonte não oferece porta para wrappers além do comentário D11', () => {
  const source = fs.readFileSync(cliPath, 'utf8');
  const mentions = source.match(/includeWrapperDirs/g) || [];
  assert.strictEqual(mentions.length, 1);
  assert.doesNotMatch(source, /process\.env|\.env\b|config(?:uration)?/i);
  assert.doesNotMatch(source, /--(?:wrapper|wrappers)/i);
});

test('argumentos inválidos retornam 2 e ajuda retorna 0', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-args-'));
  try {
    const invalid = runScript(cwd, ['--desconhecido']);
    assert.strictEqual(invalid.status, 2);
    const help = runScript(cwd, ['--help']);
    assert.strictEqual(help.status, 0);
    assert.match(help.stdout, /Uso:/);
  } finally { cleanup(cwd); }
});

test('sem VCS não aplica, informa a proteção e reporta zero elegíveis', () => {
  const cwd = fixture(false);
  try {
    const before = treeSnapshot(cwd);
    const result = runScript(cwd, ['--apply', '--yes']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /sem VCS — não há como desfazer/);
    assert.match(result.stdout, /0 elegíveis/);
    assert.deepStrictEqual(treeSnapshot(cwd), before);
  } finally { cleanup(cwd); }
});

test('sem VCS, --force aplica e informa que prosseguiu forçado', () => {
  const cwd = fixture(false);
  try {
    const result = runScript(cwd, ['--apply', '--yes', '--force']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /prosseguiu forçado/);
    assert(fs.existsSync(path.join(cwd, '.gsd', 'forge', 'ledger', '2025-Q1.md')));
  } finally { cleanup(cwd); }
});

if (gitAvailable()) {
  test('dry-run imprime prévia e pulados sem alterar bytes ou mtimes', () => {
    const cwd = fixture(true);
    try {
      const before = treeSnapshot(cwd);
      const mtimes = before.filter(row => row.kind === 'file').map(row => [row.relative, fs.statSync(path.join(cwd, row.relative)).mtimeMs]);
      const result = runScript(cwd, []);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Prévia do sweep/);
      assert.match(result.stdout, /Pulados:/);
      assert.deepStrictEqual(treeSnapshot(cwd), before);
      for (const [relative, mtime] of mtimes) assert.strictEqual(fs.statSync(path.join(cwd, relative)).mtimeMs, mtime);
    } finally { cleanup(cwd); }
  });

  test('--apply sem --yes fora de TTY não escreve e mostra prévia antes da recusa', () => {
    const cwd = fixture(true);
    try {
      const before = treeSnapshot(cwd);
      const result = runScript(cwd, ['--apply']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert(result.stdout.indexOf('Prévia do sweep') < result.stdout.indexOf('aplicação não confirmada'));
      assert.deepStrictEqual(treeSnapshot(cwd), before);
    } finally { cleanup(cwd); }
  });

  test('--apply --yes escreve container, remove membros e imprime contagens', () => {
    const cwd = fixture(true);
    try {
      const result = runScript(cwd, ['--apply', '--yes']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert(fs.existsSync(path.join(cwd, '.gsd', 'forge', 'ledger', '2025-Q1.md')));
      assert(!fs.existsSync(path.join(cwd, '.gsd', 'forge', 'ledger', 'M-20250101000000-alpha.md')));
      assert.match(result.stdout, /arquivos: \d+ → \d+/);
      assert.match(result.stdout, /pastas: \d+ → \d+/);
    } finally { cleanup(cwd); }
  });

  test('D11 protege wrappers em todas as invocações públicas', () => {
    const cwd = fixture(true);
    try {
      const original = wrapperBytes(cwd);
      for (const args of [[], ['--apply'], ['--apply', '--yes'], ['--apply', '--yes', '--force']]) {
        const result = runScript(cwd, args);
        assert.strictEqual(result.status, 0, result.stderr);
        for (const item of original) {
          const file = path.join(cwd, '.gsd', item.root, 'eligible-wrapper', 'PLAN.md');
          assert(fs.existsSync(file), `${item.root} wrapper desapareceu`);
          assert.deepStrictEqual(fs.readFileSync(file), item.bytes);
        }
      }
      const preview = buildRegistry().preview({ cwd });
      assert(!preview.operations[0].targets.some(target => /-wrappers$/.test(target.store)));
    } finally { cleanup(cwd); }
  });
} else {
  skip('casos com repositório Git real');
}

process.stdout.write(`forge-sweep-project: ${passed} passed, ${skipped} skipped\n`);
