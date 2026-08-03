#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const home = require('./forge-home.js');
const prefs = require('./forge-prefs.js');
const legacy = require('./forge-prefs-legacy.js');
const migrate = require('./forge-prefs-migrate.js');

let passes = 0;
function test(name, fn) {
  try { fn(); passes++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { process.stderr.write(`  ✗ ${name}: ${error.message}\n`); process.exitCode = 1; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-')); // removed in finally below
const user = path.join(root, 'Pessoa com espaço 🚀');
const forge = path.join(root, 'Dados', 'Forge Agent ✓');
const cwd = path.join(root, 'projeto', 'café');
fs.mkdirSync(cwd, { recursive: true });

try {
  test('FORGE_HOME overrides HOME and USERPROFILE on every platform', () => {
    const resolved = home.resolveForgeHome({ platform: 'win32', env: {
      FORGE_HOME: forge, HOME: path.join(root, 'home'), USERPROFILE: user,
    } });
    assert.strictEqual(resolved, path.resolve(forge));
  });

  for (const platform of ['win32', 'darwin', 'linux']) {
    test(`${platform} home precedence is deterministic`, () => {
      const expected = platform === 'win32' ? path.join(root, 'Windows User') : path.join(root, 'Posix User');
      const env = platform === 'win32'
        ? { USERPROFILE: expected, HOME: path.join(root, 'wrong') }
        : { HOME: expected, USERPROFILE: path.join(root, 'wrong') };
      assert.strictEqual(home.resolveUserHome({ platform, env }), path.resolve(expected));
      assert.strictEqual(home.resolveForgeHome({ platform, env }), path.join(path.resolve(expected), '.forge-agent'));
    });
  }

  test('runtime homes are independent projections and preserve Unicode', () => {
    const paths = home.resolveForgePaths({ userHome: user, forgeHome: forge, cwd });
    assert.strictEqual(paths.forgeHome, path.resolve(forge));
    assert.strictEqual(paths.claudeHome, path.join(path.resolve(user), '.claude'));
    assert.strictEqual(paths.codexHome, path.join(path.resolve(user), '.codex'));
    assert(paths.shared.scripts.startsWith(paths.forgeHome));
    assert(paths.adapters.claude.startsWith(paths.forgeHome));
  });

  test('preference paths put global JSONC in Forge home and keep .gsd local', () => {
    const layers = home.resolvePreferencePaths(cwd, { userHome: user, forgeHome: forge });
    assert.strictEqual(layers.canonical.jsoncPath, path.join(path.resolve(forge), 'forge-agent-prefs.jsonc'));
    assert.strictEqual(layers.local.jsoncPath, path.join(path.resolve(cwd), '.gsd', 'forge-prefs.jsonc'));
    assert(layers.legacyMdFiles.every((file) => file.includes(`${path.sep}.claude${path.sep}`)));
    assert(layers.jsoncCandidates[0].startsWith(path.resolve(forge)));
  });

  test('FORGE_HOME and explicit dirs survive spaces/Unicode without shell expansion', () => {
    const paths = prefs.preferenceLayerDescriptors(cwd, { env: { FORGE_HOME: forge, HOME: user }, platform: 'linux' });
    assert(paths[0].jsoncPath.includes('Dados'));
    assert(paths[0].jsoncPath.includes('Forge Agent ✓'));
    assert(paths[1].jsoncPath.includes(`${path.sep}.gsd${path.sep}`));
  });

  test('legacy adapter exposes Claude files through the resolver only', () => {
    const files = legacy.legacyGlobalPreferenceFiles({ userHome: user });
    assert.deepStrictEqual(files, [
      path.join(path.resolve(user), '.claude', 'forge-agent-prefs.jsonc'),
      path.join(path.resolve(user), '.claude', 'forge-agent-prefs.md'),
    ]);
  });

  test('descriptor does not copy or convert the project .gsd', () => {
    const layers = prefs.preferenceLayerDescriptors(cwd, { userHome: user, forgeHome: forge });
    assert.strictEqual(layers[1].mdFiles[0], path.join(path.resolve(cwd), '.gsd', 'claude-agent-prefs.md'));
    assert(!layers[1].jsoncPath.startsWith(path.resolve(forge)));
  });

  test('Claude-only legacy migration is backed up and non-destructive', () => {
    const migrationRoot = path.join(root, 'migração com espaço ✓');
    const migrationCwd = path.join(migrationRoot, 'projeto');
    const claudeHome = path.join(migrationRoot, 'home', '.claude');
    const forgeHome = path.join(migrationRoot, 'home', '.forge-agent');
    fs.mkdirSync(migrationCwd, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true });
    const md = path.join(claudeHome, 'forge-agent-prefs.md');
    fs.writeFileSync(md, 'review:\n  rounds: 3\n', 'utf8');
    const result = migrate.migrateAll(migrationCwd, {
      env: { HOME: path.dirname(claudeHome), USERPROFILE: path.dirname(claudeHome), FORGE_HOME: forgeHome },
    });
    assert.strictEqual(result.status, 'migrated');
    assert(fs.existsSync(path.join(forgeHome, 'forge-agent-prefs.jsonc')));
    assert(fs.existsSync(md), 'legacy source remains for rollback');
    assert(fs.existsSync(`${md}.bak`), 'legacy source receives recoverable backup');
    const resolved = prefs.readPrefs(migrationCwd, {
      env: { HOME: path.dirname(claudeHome), USERPROFILE: path.dirname(claudeHome), FORGE_HOME: forgeHome },
    });
    assert.strictEqual(resolved.prefs.review.rounds, 3);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\n${passes} passed\n`);
