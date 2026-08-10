#!/usr/bin/env node
'use strict';
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path'); const bootstrap = require('./forge-bootstrap');
const repo = path.resolve(__dirname, '..'); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bootstrap-Ω-'));
try {
  const project = path.join(root, 'project with spaces'); const forge = path.join(root, 'Forge Home'); const claude = path.join(root, 'Claude Home'); const codex = path.join(root, 'Codex Home'); fs.mkdirSync(project, { recursive: true });
  const dry = bootstrap.bootstrap({ runtime: 'codex', milestone: 'M-BOOTSTRAP', projectRoot: project, forgeHome: forge, claudeHome: claude, codexHome: codex, dryRun: true }); assert.strictEqual(dry.dry_run, true); assert.strictEqual(fs.existsSync(forge), false); assert.strictEqual(fs.existsSync(claude), false); assert.strictEqual(fs.existsSync(codex), false); assert.strictEqual(dry.legacy_prefs.read, false);
  const first = bootstrap.bootstrap({ runtime: 'codex', milestone: 'M-BOOTSTRAP', projectRoot: project, forgeHome: forge, claudeHome: claude, codexHome: codex }); const second = bootstrap.bootstrap({ runtime: 'codex', milestone: 'M-BOOTSTRAP', projectRoot: project, forgeHome: forge, claudeHome: claude, codexHome: codex }); assert.deepStrictEqual(first.result, second.result); assert.strictEqual(fs.existsSync(claude), false); assert.strictEqual(fs.existsSync(forge), true);
  fs.mkdirSync(claude, { recursive: true }); fs.writeFileSync(path.join(claude, 'forge-agent-prefs.jsonc'), '{"legacy":true}\n'); const claudeReport = bootstrap.bootstrap({ runtime: 'claude', milestone: 'M-BOOTSTRAP-CLAUDE', projectRoot: project, forgeHome: forge, claudeHome: claude, codexHome: codex }); assert.strictEqual(claudeReport.legacy_prefs.present, true); assert.strictEqual(fs.readFileSync(path.join(claude, 'forge-agent-prefs.jsonc'), 'utf8'), '{"legacy":true}\n');
  assert.throws(() => bootstrap.bootstrap({ runtime: 'agy', milestone: 'M-BOOTSTRAP', projectRoot: project }), /runtime inválido/); console.log('forge-bootstrap tests passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
