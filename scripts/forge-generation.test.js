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
  console.log('forge-generation tests passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
