#!/usr/bin/env node
// forge-app.test.js — runs the macOS app's Swift suite from the JS test gate.
//
// The app is not a second-class citizen: `node scripts/run-tests.js` should
// cover it too. But it is macOS + Swift only, so this suite SKIPS (exit 0)
// wherever it cannot run rather than failing a Linux/Windows checkout.
//
// The Swift side uses the same harness shape as the JS suites (asserts, exit
// 0/1) because XCTest ships with full Xcode, not with the Command Line Tools.

'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const appDir = path.join(repoRoot, 'app');

function skip(reason) {
  console.log(`\n=== forge app (Swift) ===\n`);
  console.log(`  ⊘ pulado — ${reason}`);
  console.log('');
  process.exit(0);
}

if (process.platform !== 'darwin') skip('o app é macOS-only');
if (!fs.existsSync(path.join(appDir, 'Package.swift'))) skip('app/Package.swift ausente');

const which = spawnSync('which', ['swift'], { encoding: 'utf8' });
if (which.status !== 0) skip('swift não encontrado (instale as Command Line Tools)');

// FORGE_SKIP_APP_TESTS=1 keeps a fast local loop available: the first build
// resolves SwiftTerm from the network and takes minutes.
if (process.env.FORGE_SKIP_APP_TESTS === '1') skip('FORGE_SKIP_APP_TESTS=1');

console.log('\n=== forge app (Swift) ===\n');

const res = spawnSync('swift', ['run', '--package-path', appDir, 'ForgeKitTests'], {
  encoding: 'utf8',
  stdio: 'inherit',
  timeout: 15 * 60 * 1000,
});

if (res.error) {
  console.log(`  ✗ falhou ao invocar swift: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status === 0 ? 0 : 1);
