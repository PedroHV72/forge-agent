#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Installed BEFORE the modules under test are required, because
// forge-capabilities destructures spawnSync at require time. While armed, every
// spawn is recorded so a test can prove a probe did NOT happen instead of
// granting itself skipCapabilityCheck (which would prove nothing about the CLI).
const childProcess = require('child_process');
const realSpawnSync = childProcess.spawnSync;
let spawnLog = null;
childProcess.spawnSync = function guardedSpawnSync(command, args, options) {
  if (spawnLog) {
    spawnLog.push(`${command} ${Array.isArray(args) ? args.join(' ') : ''}`.trim());
    throw new Error(`spawn denied while previewing: ${command}`);
  }
  return realSpawnSync.call(this, command, args, options);
};

const installer = require('./forge-installer.js');
const updater = require('./forge-update.js');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-'));
  return { root, userHome: root, forgeHome: path.join(root, 'forge'), claudeHome: path.join(root, 'claude'), codexHome: path.join(root, 'codex'), projectRoot: path.join(root, 'project'), repo: path.resolve(__dirname, '..'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function snapshot(root) {
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else entries.push([path.relative(root, file), fs.readFileSync(file).toString('hex')]);
    }
  };
  visit(root);
  return entries;
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

// The fossil in these fixtures is named `forge-fossil.js` on purpose. It used to
// be `fossil.js` — a name Forge cannot prove is its own — and the assertion that
// it got moved encoded exactly the defect this suite now guards against:
// retirement renamed the whole directory, taking the operator's own scripts with
// it. Retiring a fossil is the intent; retiring a stranger never was.
test('dry-run lists legacy retire without changing a byte', () => {
  const data = fixture();
  try {
    const legacyScripts = path.join(data.userHome, '.claude', 'scripts');
    fs.mkdirSync(legacyScripts, { recursive: true });
    fs.writeFileSync(path.join(legacyScripts, 'forge-fossil.js'), 'legacy bytes\n');
    const before = snapshot(data.root);
    const report = updater.update({ ...data, runtime: 'claude', skipCapabilityCheck: true });
    assert.strictEqual(report.applied, false);
    const retire = report.retirements.find((entry) => entry.op === 'retire');
    assert(retire, 'dry-run must list retire');
    assert.strictEqual(retire.source, legacyScripts);
    assert.match(retire.destination, /forge[\\/]backups[\\/]/);
    assert.deepStrictEqual(snapshot(data.root), before, 'dry-run must leave the complete fixture byte-identical');
    assert.strictEqual(fs.existsSync(retire.destination), false);
    const output = updater.render(report);
    assert(output.includes(`retire: ${retire.source} -> ${retire.destination}`), 'dry-run output must list retire source and destination');
  } finally { data.cleanup(); }
});

test('dry-run plans retire without capability probing on the CLI path (no skip flag)', () => {
  const data = fixture();
  try {
    const legacyScripts = path.join(data.userHome, '.claude', 'scripts');
    fs.mkdirSync(legacyScripts, { recursive: true });
    fs.writeFileSync(path.join(legacyScripts, 'forge-fossil.js'), 'legacy bytes\n');
    const before = snapshot(data.root);
    const spawns = [];
    let report;
    spawnLog = spawns;
    // Exactly what `forge-update.js --dry-run` builds: parseArgs never sets
    // skipCapabilityCheck or noModelProbe, so neither is passed here.
    try { report = updater.update({ ...data, runtime: 'claude' }); } finally { spawnLog = null; }
    assert.deepStrictEqual(spawns, [], `dry-run must not spawn a capability probe; spawned: ${spawns.join(', ')}`);
    assert.strictEqual(report.applied, false);
    assert(report.retirements.find((entry) => entry.op === 'retire'), 'dry-run must still list retire');
    assert.deepStrictEqual(snapshot(data.root), before, 'dry-run must leave the fixture byte-identical');
  } finally { data.cleanup(); }
});

test('apply retires legacy scripts and a second update reports skipped', () => {
  const data = fixture();
  try {
    const legacyScripts = path.join(data.userHome, '.claude', 'scripts');
    fs.mkdirSync(legacyScripts, { recursive: true });
    fs.writeFileSync(path.join(legacyScripts, 'forge-fossil.js'), 'legacy bytes\n');
    const first = updater.update({ ...data, runtime: 'claude', apply: true, skipCapabilityCheck: true });
    const retire = first.installer.plan.find((entry) => entry.op === 'retire');
    assert(retire && fs.existsSync(path.join(retire.destination, 'forge-fossil.js')));
    assert.strictEqual(fs.existsSync(path.join(legacyScripts, 'forge-fossil.js')), false);
    assert(fs.existsSync(path.join(legacyScripts, 'README.md')), 'apply writes a tombstone');
    const second = updater.update({ ...data, runtime: 'claude', skipCapabilityCheck: true });
    const skipped = second.retirements.find((entry) => entry.op === 'skip' && entry.reason === 'already-retired');
    assert(skipped, 'second update must report skipped retirement');
    assert.strictEqual(skipped.source, legacyScripts);
    assert.match(skipped.destination, /forge[\\/]backups[\\/]/);
  } finally { data.cleanup(); }
});

// The operator running `/forge-update` reads THIS output, not the installer's.
// A hook aimed inside the retired directory has to be visible here or the loss
// is silent exactly where it was silent before.
test('the update output names what was retained and warns about hooks aimed inside the retired directory', () => {
  const data = fixture();
  try {
    const legacyScripts = path.join(data.userHome, '.claude', 'scripts');
    fs.mkdirSync(legacyScripts, { recursive: true });
    fs.writeFileSync(path.join(legacyScripts, 'forge-fossil.js'), 'legacy bytes\n');
    fs.writeFileSync(path.join(legacyScripts, 'svn-session-reconcile.py'), 'print(1)\n');
    fs.writeFileSync(path.join(data.userHome, '.claude', 'settings.json'), `${JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'python ~/.claude/scripts/svn-session-reconcile.py', timeout: 45 }] }] },
    }, null, 2)}\n`);

    const report = updater.update({ ...data, runtime: 'claude', apply: true, skipCapabilityCheck: true });
    const output = updater.render(report);
    assert(output.includes('moved: 1; retained: 1'), `o resumo do update não contabiliza os dois lados:\n${output}`);
    assert(output.includes('[retained] svn-session-reconcile.py'), `o resumo do update não nomeia o que ficou:\n${output}`);
    assert(/⚠.*svn-session-reconcile\.py.*preservado no lugar/.test(output), `o hook do operador não foi mencionado:\n${output}`);
    assert.strictEqual(fs.readFileSync(path.join(legacyScripts, 'svn-session-reconcile.py'), 'utf8'), 'print(1)\n',
      'o script do operador não sobreviveu ao update');
  } finally { data.cleanup(); }
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
