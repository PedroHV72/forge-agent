#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const doctor = require('./forge-doctor.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-runtime-'));
try {
  const forgeHome = path.join(root, 'forge');
  fs.mkdirSync(forgeHome, { recursive: true });
  fs.writeFileSync(path.join(forgeHome, 'manifest.json'), JSON.stringify({ adapters: { codex: {} } }));
  const available = (id) => ({ id, status: 'available', reason_code: 'available' });
  const report = doctor.checkCapabilities(root, {
    runtime: 'codex', forgeHome,
    detectCapabilities: () => ({ runtime: 'codex', probes: { node: available('node'), codex: available('codex'), claude: { id: 'claude', status: 'skipped', reason_code: 'not-selected' } } }),
    catalog: { capabilities: [{ capability_id: 'optional-app', kind: 'app', required: false, hosts: { codex: 'unavailable' } }] },
  });
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.protocol_version, '1.0.0');
  assert(report.diagnostics.some((item) => item.reason_code === 'conditional-capability-unavailable' && item.severity === 'warning'));
  const json = JSON.stringify(report);
  assert(!json.includes(forgeHome));
  assert(!json.includes('credential'));
  process.stdout.write('  ✓ versioned runtime diagnostics are fatality-aware and path-neutral\n\n1 passed, 0 failed\n');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
