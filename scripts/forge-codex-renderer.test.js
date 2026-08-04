#!/usr/bin/env node
'use strict';
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path'); const renderer = require('./forge-codex-renderer');
const root = path.resolve(__dirname, '..'); const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-Ω-'));
try {
  const project = path.join(temp, 'project Ω'); const codex = path.join(temp, 'Codex Home Ω'); const forge = path.join(temp, 'Forge Home Ω'); fs.mkdirSync(project, { recursive: true });
  const report = renderer.render({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge });
  assert.strictEqual(report.runtime, 'codex'); assert(report.artifacts.some((item) => item.destination.endsWith(path.join('project Ω', 'AGENTS.md')))); assert(report.artifacts.some((item) => item.destination.endsWith(path.join('Codex Home Ω', 'agents', 'forge-executor.toml')))); assert(report.artifacts.every((item) => !item.destination.includes('.claude'))); assert(report.artifacts.every((item) => !item.content.includes('\r')));
  const agent = report.artifacts.find((item) => item.destination.endsWith(path.join('agents', 'forge-executor.toml')));
  assert.match(agent.content, /^# forge-source:codex-agent-forge-executor version=3\.1\.4/m);
  assert.match(agent.content, /^name = "forge-executor"$/m);
  assert.match(agent.content, /^sandbox_mode = "workspace-write"$/m);
  assert.match(agent.content, /developer_instructions = """[\s\S]+"""/);
  // Parse the generated TOML subset: every scalar is quoted and the multiline
  // instruction value is terminated, so Codex receives a valid agent document.
  const scalarLines = agent.content.split('\n').filter((line) => line && !line.startsWith('#') && !line.startsWith('developer_instructions =') && line !== '"""');
  assert(scalarLines.slice(0, 3).every((line) => /^(name|description|sandbox_mode) = "[^"\n]+"$/.test(line)));
  const first = renderer.write({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge }); assert(first.written.length > 0); assert(fs.existsSync(path.join(project, 'AGENTS.md'))); assert(fs.existsSync(path.join(codex, 'config.toml'))); assert(!fs.existsSync(path.join(temp, 'Claude Home Ω')));
  assert(fs.existsSync(path.join(codex, 'skills', 'forge-help', 'SKILL.md')));
  assert(fs.existsSync(path.join(codex, 'commands', 'forge.md')));
  assert(fs.existsSync(path.join(codex, 'templates', 'dispatch', 'execute-task.md')));
  assert(!fs.readFileSync(path.join(codex, 'config.toml'), 'utf8').startsWith('<!--'));
  assert.match(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'), /^# forge-source:codex-config version=3\.1\.4/m);
  const reportCapabilities = JSON.parse(fs.readFileSync(path.join(forge, 'adapters', 'codex', 'capabilities.json'), 'utf8'));
  assert(reportCapabilities.surfaces.some((surface) => surface.source_id === 'hooks' && surface.status === 'planned'));
  const second = renderer.write({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge }); assert.strictEqual(second.written.length, 0); assert(second.preserved.every((item) => item.reason === 'already-current'));
  fs.writeFileSync(path.join(codex, 'config.toml'), 'operator = true\n'); const preserved = renderer.write({ repo: root, projectRoot: project, codexHome: codex, forgeHome: forge }); assert(preserved.conflicts.some((item) => item.destination.endsWith(path.join('Codex Home Ω', 'config.toml')))); assert.match(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'), /operator/);
  const dry = renderer.write({ repo: root, projectRoot: project, codexHome: path.join(temp, 'dry codex'), forgeHome: path.join(temp, 'dry forge'), dryRun: true }); assert.strictEqual(dry.dry_run, true); assert(!fs.existsSync(path.join(temp, 'dry codex')));
  assert.throws(() => renderer.render({ repo: root, codexHome: path.join(temp, '.claude') }), error => error.code === 'invalid_options' || error.code === 'host-isolation');
  console.log('forge-codex-renderer tests passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
