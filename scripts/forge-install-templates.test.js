#!/usr/bin/env node
'use strict';

// Installer contract tests for deterministic dispatch templates.
//
// Windows exercises the PowerShell installer's real control flow in dry-run
// mode (so the test never mutates the user's persisted PATH). POSIX additionally
// performs an isolated update and verifies both installed and backed-up bytes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TEMPLATE_FILES } = require('./forge-prompt.js');

const ROOT = path.resolve(__dirname, '..');
const INSTALL_SH = path.join(ROOT, 'install.sh');
const INSTALL_PS1 = path.join(ROOT, 'install.ps1');
const TEMPLATE_SRC = path.join(ROOT, 'shared', 'templates', 'dispatch');
const roots = [];
let passed = 0;
let skipped = 0;

function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `forge-install-templates-${label}-`));
  roots.push(root);
  return root;
}

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

function skip(name, reason) {
  skipped += 1;
  process.stdout.write(`ok - ${name} # SKIP ${reason}\n`);
}

function templateNames(dir) {
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .sort();
}

function nativePowerShell() {
  const candidates = process.platform === 'win32'
    ? ['pwsh.exe', 'powershell.exe']
    : ['pwsh', 'powershell'];
  for (const command of candidates) {
    const probe = spawnSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8',
    });
    if (!probe.error && probe.status === 0) return command;
  }
  return null;
}

test('template inventory matches every forge-prompt dispatch unit', () => {
  const expected = Object.values(TEMPLATE_FILES).sort();
  assert.deepStrictEqual(templateNames(TEMPLATE_SRC), expected);
  assert.ok(expected.length >= 10, 'expected the complete dispatch template set');
});

test('Bash installer installs and backs up the versioned template directory', () => {
  const source = fs.readFileSync(INSTALL_SH, 'utf8');
  assert.match(source, /DISPATCH_TEMPLATES_DIR="\$\{CLAUDE_DIR\}\/templates\/dispatch"/);
  assert.match(source, /DISPATCH_TEMPLATES_SRC="\$\{REPO_DIR\}\/shared\/templates\/dispatch"/);
  assert.match(source, /\$BACKUP_DIR\/templates\/dispatch/);
  assert.match(source, /for template in "\$\{DISPATCH_TEMPLATES_SRC\}"\/\*\.md/);
  assert.match(source, /copy "\$template" "\$\{DISPATCH_TEMPLATES_DIR\}\/\$\{name\}"/);
  assert(
    source.indexOf('if [ ! -d "$DISPATCH_TEMPLATES_SRC" ]') < source.indexOf('if $has_existing && $UPDATE'),
    'required templates must be validated before backup/install writes',
  );
});

test('PowerShell installer uses safe joined paths for install and backup', () => {
  const source = fs.readFileSync(INSTALL_PS1, 'utf8');
  assert.ok(!Buffer.from(source, 'utf8').includes(0x0c), 'install.ps1 contains a form-feed byte');
  assert.match(source, /\$DispatchTemplatesDir = Join-Path \(Join-Path \$ClaudeDir 'templates'\) 'dispatch'/);
  assert.match(source, /\$DispatchTemplatesBackupDir = Join-Path \(Join-Path \$BackupDir 'templates'\) 'dispatch'/);
  assert.match(source, /\$DispatchTemplatesSrc = Join-Path \(Join-Path \(Join-Path \$RepoDir 'shared'\) 'templates'\) 'dispatch'/);
  assert.match(source, /CopyFile \$_\.FullName \(Join-Path \$DispatchTemplatesDir \$_\.Name\)/);
  assert(
    source.indexOf('if (!(Test-Path -LiteralPath $DispatchTemplatesSrc') < source.indexOf('if ($hasExisting -and $Update)'),
    'required templates must be validated before backup/install writes',
  );
});

const ps = nativePowerShell();
if (!ps) {
  skip('PowerShell dry-run recognizes a templates-only existing install', 'PowerShell unavailable');
} else {
  test('PowerShell dry-run recognizes a templates-only existing install', () => {
    const home = tempRoot('powershell');
    const claude = path.join(home, '.claude');
    const dispatch = path.join(claude, 'templates', 'dispatch');
    fs.mkdirSync(dispatch, { recursive: true });
    fs.writeFileSync(path.join(dispatch, 'execute-task.md'), 'old-template\n');

    const env = { ...process.env, USERPROFILE: home, HOME: home };
    const existing = spawnSync(ps, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', INSTALL_PS1, '-DryRun', '-NoModelProbe',
    ], { encoding: 'utf8', env });
    assert.strictEqual(existing.status, 0, existing.stderr || existing.stdout);
    assert.match(existing.stdout, /Forge Agent j.+ instalado\./);

    const update = spawnSync(ps, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', INSTALL_PS1, '-Update', '-DryRun', '-NoModelProbe',
    ], { encoding: 'utf8', env, maxBuffer: 4 * 1024 * 1024 });
    assert.strictEqual(update.status, 0, update.stderr || update.stdout);
    for (const name of templateNames(TEMPLATE_SRC)) {
      assert.ok(update.stdout.includes(`templates/dispatch/${name}`), `dry-run omitted ${name}`);
    }
    assert.strictEqual(fs.readFileSync(path.join(dispatch, 'execute-task.md'), 'utf8'), 'old-template\n');
  });
}

if (process.platform === 'win32') {
  skip('POSIX update installs new bytes and backs up old bytes', 'requires a native POSIX shell');
} else {
  test('POSIX update installs new bytes and backs up old bytes', () => {
    const home = tempRoot('posix');
    const claude = path.join(home, '.claude');
    const dispatch = path.join(claude, 'templates', 'dispatch');
    const fakeBin = path.join(home, 'bin');
    fs.mkdirSync(dispatch, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(dispatch, 'execute-task.md'), 'old-template\n');

    // Prevent a host Claude installation from receiving MCP commands.
    const fakeClaude = path.join(fakeBin, 'claude');
    fs.writeFileSync(fakeClaude, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeClaude, 0o755);

    const nodeBin = path.dirname(process.execPath);
    const env = {
      ...process.env,
      HOME: home,
      SHELL: '/bin/bash',
      PATH: [fakeBin, nodeBin, '/usr/bin', '/bin'].join(path.delimiter),
    };
    const result = spawnSync('bash', [INSTALL_SH, '--update', '--no-model-probe'], {
      encoding: 'utf8',
      env,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);

    const expected = templateNames(TEMPLATE_SRC);
    assert.deepStrictEqual(templateNames(dispatch), expected);
    for (const name of expected) {
      assert.deepStrictEqual(
        fs.readFileSync(path.join(dispatch, name)),
        fs.readFileSync(path.join(TEMPLATE_SRC, name)),
        `installed bytes differ for ${name}`,
      );
    }

    const backups = fs.readdirSync(claude)
      .filter(name => name.startsWith('forge-agent-backup-'));
    assert.strictEqual(backups.length, 1, `expected one backup, found: ${backups.join(', ')}`);
    assert.strictEqual(
      fs.readFileSync(path.join(claude, backups[0], 'templates', 'dispatch', 'execute-task.md'), 'utf8'),
      'old-template\n',
    );
  });
}

for (const root of roots) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

process.stdout.write(`\n${passed} passed, ${skipped} skipped\n`);
