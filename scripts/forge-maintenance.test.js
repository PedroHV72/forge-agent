#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const maintenance = require('./forge-maintenance.js');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function fixture(runtime = 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-maintenance-'));
  const forgeHome = path.join(root, 'forge');
  const claudeHome = path.join(root, 'claude');
  const codexHome = path.join(root, 'codex');
  fs.mkdirSync(forgeHome, { recursive: true });
  fs.writeFileSync(path.join(forgeHome, 'manifest.json'), JSON.stringify({ version: '3.1.4', adapters: { [runtime]: {} } }));
  return { root, forgeHome, claudeHome, codexHome, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function detector(runtime, overrides = {}) {
  const available = (id) => ({ id, status: 'available', reason_code: 'available' });
  return () => ({ runtime, ok: true, required_failures: [], probes: { node: available('node'), claude: available('claude'), codex: available('codex'), ...overrides } });
}
function guardedFs(forbidden) {
  const guard = (file) => { if (path.resolve(String(file)).startsWith(path.resolve(forbidden))) throw new Error(`forbidden access: ${file}`); };
  return {
    existsSync(file) { guard(file); return fs.existsSync(file); },
    readFileSync(file, encoding) { guard(file); return fs.readFileSync(file, encoding); },
  };
}

test('codex-only discovery and diagnostics never access Claude home', () => {
  const data = fixture('codex');
  try {
    const report = maintenance.diagnose({ runtime: 'codex', forgeHome: data.forgeHome, claudeHome: data.claudeHome, codexHome: data.codexHome, fs: guardedFs(data.claudeHome), detectCapabilities: detector('codex'), catalog: { capabilities: [] } });
    assert.strictEqual(report.ok, true);
    assert.deepStrictEqual(report.selected, ['codex']);
  } finally { data.cleanup(); }
});

test('manifest detection keeps codex-only update codex-only', () => {
  const data = fixture('codex');
  try {
    const plan = maintenance.planUpdate({ forgeHome: data.forgeHome, claudeHome: data.claudeHome, fs: guardedFs(data.claudeHome) });
    assert.strictEqual(plan.runtime, 'codex');
    assert.deepStrictEqual(plan.installer_args, ['--runtime', 'codex', '--update']);
  } finally { data.cleanup(); }
});

test('required and conditional capability reasons have different fatality', () => {
  const data = fixture('claude');
  try {
    const catalog = { capabilities: [
      { capability_id: 'required-gap', kind: 'headless', required: true, hosts: { claude: 'planned' }, probe: { kind: 'filesystem', path: 'missing-required' } },
      { capability_id: 'optional-gap', kind: 'app', required: false, hosts: { claude: 'unavailable' }, probe: { kind: 'filesystem', path: 'missing-optional' } },
      { capability_id: 'operational-hooks', kind: 'hook', required: true, hosts: { claude: 'implemented' }, probe: { kind: 'filesystem', path: 'scripts/forge-hook.js' } },
    ] };
    const report = maintenance.diagnose({ runtime: 'claude', forgeHome: data.forgeHome, claudeHome: data.claudeHome, detectCapabilities: detector('claude'), hookTrust: { claude: false }, catalog });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.diagnostics.find((x) => x.capability === 'required-gap').reason_code, 'required-capability-missing');
    assert.strictEqual(report.diagnostics.find((x) => x.capability === 'optional-gap').reason_code, 'conditional-capability-unavailable');
    const hook = report.diagnostics.find((x) => x.capability === 'operational-hooks');
    assert.strictEqual(hook.reason_code, 'conditional-capability-unavailable');
    assert.strictEqual(hook.severity, 'warning');
  } finally { data.cleanup(); }
});

test('core and adapter failures have stable explicit reasons', () => {
  const data = fixture('codex');
  try {
    const report = maintenance.diagnose({ runtime: 'codex', forgeHome: data.forgeHome, detectCapabilities: detector('codex', {
      node: { id: 'node', status: 'unsupported', reason_code: 'minimum-version' },
      codex: { id: 'codex', status: 'missing', reason_code: 'missing' },
    }), catalog: { capabilities: [] } });
    assert(report.diagnostics.some((x) => x.reason_code === 'core-incompatible'));
    assert(report.diagnostics.some((x) => x.reason_code === 'adapter-missing'));
  } finally { data.cleanup(); }
});

for (const platform of require('./fixtures/runtime-maintenance/platforms.json').platforms) {
  test(`${platform} remains offline and selected-home local`, () => {
    const data = fixture('codex');
    try {
      const report = maintenance.diagnose({ platform, runtime: 'codex', forgeHome: data.forgeHome, claudeHome: data.claudeHome, fs: guardedFs(data.claudeHome), detectCapabilities: detector('codex'), catalog: { capabilities: [] } });
      assert.strictEqual(report.ok, true);
    } finally { data.cleanup(); }
  });
}

process.stdout.write(`\n${passed} passed, 0 failed\n`);
