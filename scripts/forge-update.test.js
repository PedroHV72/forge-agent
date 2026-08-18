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

test('dry-run lists legacy retire without changing a byte', () => {
  const data = fixture();
  try {
    const legacyScripts = path.join(data.userHome, '.claude', 'scripts');
    fs.mkdirSync(legacyScripts, { recursive: true });
    fs.writeFileSync(path.join(legacyScripts, 'fossil.js'), 'legacy bytes\n');
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
    fs.writeFileSync(path.join(legacyScripts, 'fossil.js'), 'legacy bytes\n');
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
    fs.writeFileSync(path.join(legacyScripts, 'fossil.js'), 'legacy bytes\n');
    const first = updater.update({ ...data, runtime: 'claude', apply: true, skipCapabilityCheck: true });
    const retire = first.installer.plan.find((entry) => entry.op === 'retire');
    assert(retire && fs.existsSync(path.join(retire.destination, 'fossil.js')));
    assert.strictEqual(fs.existsSync(path.join(legacyScripts, 'fossil.js')), false);
    assert(fs.existsSync(path.join(legacyScripts, 'README.md')), 'apply writes a tombstone');
    const second = updater.update({ ...data, runtime: 'claude', skipCapabilityCheck: true });
    const skipped = second.retirements.find((entry) => entry.op === 'skip' && entry.reason === 'already-retired');
    assert(skipped, 'second update must report skipped retirement');
    assert.strictEqual(skipped.source, legacyScripts);
    assert.match(skipped.destination, /forge[\\/]backups[\\/]/);
  } finally { data.cleanup(); }
});

// ── The source repo is resolved, not assumed ────────────────────────────────
//
// `commands/forge-update.md` documents `node scripts/forge-update.js --apply
// --json`. Because `scripts/` is managed core, that command is routinely run
// from the INSTALLED copy under `~/.forge-agent/scripts/`, where `__dirname/..`
// is the Forge home — a directory that will never hold
// forge-source-manifest.json, since the installer does not copy it there. The
// documented command died on a raw ENOENT naming exactly that absent file.
// Measured on a real 4.8.0 → 4.15.0 update and reproduced on 4.15.0 itself.

test('apply resolves the source repo from recorded provenance — the documented command needs no --repo', () => {
  const data = fixture();
  try {
    const base = { ...data, runtime: 'claude', skipCapabilityCheck: true };
    delete base.root; delete base.cleanup;
    installer.install(base);

    const manifestFile = path.join(data.forgeHome, 'manifest.json');
    assert.strictEqual(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).source_repo, data.repo,
      'a instalação não registrou de qual clone ela veio — não há o que resolver depois');

    // Control: the fixture only exercises provenance if the entry point really
    // cannot render on its own.
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, updater.SOURCE_MANIFEST)), false,
      'controle: o Forge home não pode conter o manifesto de origem');

    const fromHome = { ...base, apply: true, entryRoot: data.forgeHome };
    delete fromHome.repo;
    const report = updater.update(fromHome);
    assert.strictEqual(report.source_repo.origin, 'manifest');
    assert.strictEqual(report.source_repo.path, data.repo);
    assert.strictEqual(report.applied, true);
    assert(updater.render(report).includes(`source repo: ${data.repo} (manifest)`),
      'o resumo não nomeia o clone que foi lido nem como ele foi encontrado');
  } finally { data.cleanup(); }
});

test('without provenance and without --repo the failure names the flag, not ENOENT', () => {
  const data = fixture();
  try {
    const base = { ...data, runtime: 'claude', skipCapabilityCheck: true };
    delete base.root; delete base.cleanup;
    installer.install(base);

    // An installation made by any release before provenance was recorded.
    const manifestFile = path.join(data.forgeHome, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    delete manifest.source_repo;
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    const blind = { ...base, apply: true, entryRoot: data.forgeHome };
    delete blind.repo;
    const before = snapshot(data.root);
    assert.throws(() => updater.update(blind), (error) => {
      assert.match(error.message, /--repo/, 'a mensagem não nomeia a flag que resolve o problema');
      assert.match(error.message, /forge-source-manifest\.json/, 'a mensagem não diz o que faltou');
      assert.doesNotMatch(error.message, /ENOENT/, 'continua sendo o ENOENT cru');
      assert.ok(error.message.includes(data.forgeHome), 'a mensagem não diz qual caminho foi avaliado');
      return true;
    });
    assert.deepStrictEqual(snapshot(data.root), before,
      'a resolução falhou DEPOIS de escrever — ela precisa acontecer antes do installer, sem backup órfão');
  } finally { data.cleanup(); }
});

test('precedence: an explicit --repo wins over provenance, and the entry point wins over both', () => {
  const data = fixture();
  try {
    const base = { ...data, runtime: 'claude', skipCapabilityCheck: true };
    delete base.root; delete base.cleanup;
    installer.install(base);

    const manifestFile = path.join(data.forgeHome, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.source_repo = path.join(data.root, 'clone-que-nao-existe');
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    // Explicit flag: used as given, and the stale recorded value is not consulted.
    const explicit = updater.resolveSourceRepo({ ...base, repo: data.repo });
    assert.strictEqual(explicit.origin, 'flag');
    assert.strictEqual(explicit.path, data.repo);
    assert.deepStrictEqual(explicit.considered.map((item) => item.origin), ['flag'],
      'a flag explícita não deve nem avaliar a proveniência gravada');

    // No flag, and the entry point IS a clone (a developer running from the repo):
    // it wins without reading the manifest value at all.
    const fromRepo = { ...base, entryRoot: data.repo };
    delete fromRepo.repo;
    assert.strictEqual(updater.resolveSourceRepo(fromRepo).origin, 'entry');
  } finally { data.cleanup(); }
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
