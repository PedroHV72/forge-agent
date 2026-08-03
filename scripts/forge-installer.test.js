#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const installer = require('./forge-installer.js');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-installer space-Ω-'));
  const forgeHome = path.join(root, 'Forge Home');
  const claudeHome = path.join(root, 'Claude Home');
  const codexHome = path.join(root, 'Codex Home');
  const options = { repo: path.resolve(__dirname, '..'), forgeHome, claudeHome, codexHome };
  return { root, forgeHome, claudeHome, codexHome, options, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function files(root) { return fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).map((entry) => entry.name).sort() : []; }

test('rejects an unknown runtime before writing', () => {
  const data = fixture();
  try { assert.throws(() => installer.install({ ...data.options, runtime: 'agy' }), /runtime inválido/); assert.strictEqual(fs.existsSync(data.forgeHome), false); } finally { data.cleanup(); }
});

test('dry-run plans Claude-only without touching Forge, Claude, or Codex homes', () => {
  const data = fixture();
  try {
    const report = installer.install({ ...data.options, runtime: 'claude', dryRun: true });
    assert.strictEqual(report.dry_run, true);
    assert(report.plan.some((entry) => entry.destination === path.join(data.forgeHome, 'scripts')) || report.plan.some((entry) => entry.destination.includes(`${path.sep}scripts`)));
    assert.strictEqual(fs.existsSync(data.forgeHome), false);
    assert.strictEqual(fs.existsSync(data.claudeHome), false);
    assert.strictEqual(fs.existsSync(data.codexHome), false);
  } finally { data.cleanup(); }
});

test('Claude-only writes shared core once and only Claude projection', () => {
  const data = fixture();
  try {
    const report = installer.install({ ...data.options, runtime: 'claude' });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'scripts', 'forge-home.js')), true);
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'forge-capabilities.json')), true);
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'manifest.json')), true);
    assert.strictEqual(fs.existsSync(path.join(data.claudeHome, 'agents')), true);
    assert.strictEqual(fs.existsSync(data.codexHome), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(data.forgeHome, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(manifest.adapters), ['claude']);
  } finally { data.cleanup(); }
});

test('Codex-only does not read or write Claude home and both keeps one core', () => {
  const data = fixture();
  try {
    const report = installer.install({ ...data.options, runtime: 'codex' });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(fs.existsSync(data.claudeHome), false);
    assert.strictEqual(fs.existsSync(path.join(data.codexHome, 'agents')), true);
    const both = installer.install({ ...data.options, runtime: 'both', update: true });
    assert.strictEqual(both.ok, true);
    assert.strictEqual(fs.existsSync(path.join(data.claudeHome, 'agents')), true);
    assert.strictEqual(fs.existsSync(path.join(data.codexHome, 'agents')), true);
    assert.strictEqual(files(data.forgeHome).filter((name) => name === 'scripts').length, 1);
  } finally { data.cleanup(); }
});

test('update backs up managed files and preserves prefs and unmanaged files', () => {
  const data = fixture();
  try {
    installer.install({ ...data.options, runtime: 'claude' });
    const prefs = path.join(data.forgeHome, 'forge-agent-prefs.jsonc');
    const unmanaged = path.join(data.forgeHome, 'operator-note.txt');
    fs.writeFileSync(prefs, '{"operator":true}\n');
    fs.writeFileSync(unmanaged, 'keep\n');
    const report = installer.install({ ...data.options, runtime: 'claude', update: true });
    assert(report.backup && fs.existsSync(report.backup));
    assert.strictEqual(fs.readFileSync(prefs, 'utf8'), '{"operator":true}\n');
    assert.strictEqual(fs.readFileSync(unmanaged, 'utf8'), 'keep\n');
    assert(fs.readdirSync(path.join(data.forgeHome, 'backups')).length >= 1);
  } finally { data.cleanup(); }
});

test('legacy Claude preference migrates without removing source', () => {
  const data = fixture();
  try {
    fs.mkdirSync(data.claudeHome, { recursive: true });
    const legacy = path.join(data.claudeHome, 'forge-agent-prefs.jsonc');
    fs.writeFileSync(legacy, '{"legacy":true}\n');
    installer.install({ ...data.options, runtime: 'codex' });
    assert.strictEqual(fs.readFileSync(legacy, 'utf8'), '{"legacy":true}\n');
    assert.strictEqual(fs.readFileSync(path.join(data.forgeHome, 'forge-agent-prefs.jsonc'), 'utf8'), '{"legacy":true}\n');
  } finally { data.cleanup(); }
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);

