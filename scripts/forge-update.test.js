#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const installer = require('./forge-installer.js');
const updater = require('./forge-update.js');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-'));
  return { root, forgeHome: path.join(root, 'forge'), claudeHome: path.join(root, 'claude'), codexHome: path.join(root, 'codex'), projectRoot: path.join(root, 'project'), repo: path.resolve(__dirname, '..'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('codex-only apply preserves prefs/config and does not create Claude home', () => {
  const data = fixture();
  try {
    const base = { ...data, runtime: 'codex', skipCapabilityCheck: true };
    delete base.root; delete base.cleanup;
    installer.install(base);
    const prefs = path.join(data.forgeHome, 'forge-agent-prefs.jsonc');
    const config = path.join(data.codexHome, 'operator-config.toml');
    fs.writeFileSync(prefs, '{"operator":true}\n');
    fs.writeFileSync(config, 'operator = true\n');
    const report = updater.update({ ...base, apply: true });
    assert.strictEqual(report.runtime, 'codex');
    assert(report.backup && fs.existsSync(report.backup));
    assert.strictEqual(fs.readFileSync(prefs, 'utf8'), '{"operator":true}\n');
    assert.strictEqual(fs.readFileSync(config, 'utf8'), 'operator = true\n');
    assert.strictEqual(fs.existsSync(data.claudeHome), false);
  } finally { data.cleanup(); }
});

test('legacy Claude 3.1.4 migration preserves source bytes and reports provenance', () => {
  const data = fixture();
  try {
    fs.mkdirSync(data.claudeHome, { recursive: true });
    const legacy = path.join(data.claudeHome, 'forge-agent-prefs.jsonc');
    const bytes = Buffer.from('{\r\n  "release": "3.1.4" // keep\r\n}\r\n');
    fs.writeFileSync(legacy, bytes);
    const report = updater.update({ ...data, runtime: 'claude', apply: true, skipCapabilityCheck: true });
    assert.strictEqual(report.legacy_migration.release, '3.1.4-compatible');
    assert(report.backup && fs.existsSync(report.backup), 'legacy update must create a rollback backup');
    assert.deepStrictEqual(fs.readFileSync(legacy), bytes);
    assert.deepStrictEqual(fs.readFileSync(path.join(data.forgeHome, 'forge-agent-prefs.jsonc')), bytes);
  } finally { data.cleanup(); }
});

test('dry-run plans without calling installer or network', () => {
  const data = fixture();
  try {
    fs.mkdirSync(data.forgeHome, { recursive: true });
    fs.writeFileSync(path.join(data.forgeHome, 'manifest.json'), JSON.stringify({ adapters: { codex: {} } }));
    const report = updater.update({ ...data }, { install: () => { throw new Error('must not call'); } });
    assert.strictEqual(report.applied, false);
    assert.strictEqual(report.runtime, 'codex');
  } finally { data.cleanup(); }
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
