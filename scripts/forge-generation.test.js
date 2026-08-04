#!/usr/bin/env node
'use strict';
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path'); const generation = require('./forge-generate');
const root = path.resolve(__dirname, '..'); const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-generation-Ω-'));
try {
  const project = path.join(temp, 'project Ω'); const claudeHome = path.join(temp, 'Claude Home Ω'); const codexHome = path.join(temp, 'Codex Home Ω'); const forgeHome = path.join(temp, 'Forge Home Ω'); fs.mkdirSync(project, { recursive: true });
  const dry = generation.generate({ repo: root, runtime: 'both', projectRoot: project, claudeHome, codexHome, forgeHome, dryRun: true }); assert.deepStrictEqual(dry.selected, ['claude', 'codex']); assert.strictEqual(fs.existsSync(claudeHome), false); assert.strictEqual(fs.existsSync(codexHome), false); assert.strictEqual(fs.existsSync(forgeHome), false);
  const first = generation.generate({ repo: root, runtime: 'both', projectRoot: project, claudeHome, codexHome, forgeHome }); assert.strictEqual(first.changed, true); assert(fs.existsSync(path.join(project, 'CLAUDE.md'))); assert(fs.existsSync(path.join(project, 'AGENTS.md'))); assert(fs.existsSync(path.join(claudeHome, 'agents', 'forge-executor.md'))); assert(fs.existsSync(path.join(codexHome, 'agents', 'forge-executor.toml')));
  const second = generation.generate({ repo: root, runtime: 'both', projectRoot: project, claudeHome, codexHome, forgeHome }); assert.strictEqual(second.changed, false); assert(second.reports.claude.preserved.length > 0); assert(second.reports.codex.preserved.length > 0);
  const sentinel = path.join(claudeHome, 'operator.txt'); fs.writeFileSync(sentinel, 'keep\r\n'); generation.generate({ repo: root, runtime: 'codex', projectRoot: project, claudeHome, codexHome, forgeHome }); assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep\r\n');
  assert.strictEqual(fs.existsSync(path.join(temp, '.claude')), false); assert.strictEqual(fs.existsSync(path.join(temp, '.codex')), false);
  // Exercise path/home resolution for all supported hosts even when the
  // release gate itself runs on only one operating system.
  for (const platform of ['win32', 'darwin', 'linux']) {
    const matrixRoot = path.join(temp, `matrix-${platform}`);
    const matrixProject = path.join(matrixRoot, 'project with spaces Ω');
    const matrixClaude = path.join(matrixRoot, 'Claude Home');
    const matrixCodex = path.join(matrixRoot, 'Codex Home');
    const matrixForge = path.join(matrixRoot, 'Forge Home');
    fs.mkdirSync(matrixProject, { recursive: true });
    const matrix = generation.generate({ repo: root, runtime: 'both', platform, projectRoot: matrixProject, claudeHome: matrixClaude, codexHome: matrixCodex, forgeHome: matrixForge });
    assert.strictEqual(matrix.changed, true, `${platform} first run changed`);
    assert(fs.existsSync(path.join(matrixProject, 'CLAUDE.md')));
    assert(fs.existsSync(path.join(matrixProject, 'AGENTS.md')));
    assert(fs.existsSync(path.join(matrixClaude, 'agents', 'forge-executor.md')));
    assert(fs.existsSync(path.join(matrixCodex, 'agents', 'forge-executor.toml')));
    const repeatMatrix = generation.generate({ repo: root, runtime: 'both', platform, projectRoot: matrixProject, claudeHome: matrixClaude, codexHome: matrixCodex, forgeHome: matrixForge });
    assert.strictEqual(repeatMatrix.changed, false, `${platform} second run idempotent`);
    assert.strictEqual(fs.existsSync(path.join(matrixRoot, '.claude')), false);
    assert.strictEqual(fs.existsSync(path.join(matrixRoot, '.codex')), false);
  }
  console.log('forge-generation tests passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
