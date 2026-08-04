#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gate = require('./forge-release-gate.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-gate-test Ω-'));
function fakeOffline({ host, platform }) {
  return { host, platform, ok: true, results: [{ suite: 'fixture.test.js', ok: true, status: 0, signal: null, stdout: 'must-not-persist', stderr: '' }] };
}
function idempotent(_, platform) { return { platform, first_changed: true, second_changed: false, tree_sha256: 'a'.repeat(64), repeat_tree_sha256: 'a'.repeat(64), package_sha256: 'b'.repeat(64), repeat_package_sha256: 'b'.repeat(64), idempotent: true }; }
function safe() { return { ok: true, relative_payload_paths: true, node_argv_only: true, provider_paid_required: false, secrets_forwarded: false }; }

try {
  const clean = gate.buildReport({ repo: path.resolve(__dirname, '..') }, { runOffline: fakeOffline, regeneration: idempotent, securityAudit: safe, status: () => [], commit: 'deadbeef' });
  assert.strictEqual(clean.ok, true);
  assert.strictEqual(clean.matrix.length, 6);
  assert.deepStrictEqual(clean.matrix.map((cell) => `${cell.host}/${cell.platform}`), [
    'claude/win32', 'codex/win32', 'claude/darwin', 'codex/darwin', 'claude/linux', 'codex/linux',
  ]);
  assert(!JSON.stringify(clean).includes('must-not-persist'));
  assert.deepStrictEqual(clean.real_provider_smoke, { required: false, mode: 'manual-opt-in', executed: false });

  const dirty = [' M operator-file'];
  const refused = gate.buildReport({ repo: path.resolve(__dirname, '..') }, { runOffline: fakeOffline, regeneration: idempotent, securityAudit: safe, status: () => dirty, commit: 'deadbeef' });
  assert.strictEqual(refused.ok, false, 'dirty tree is a release failure by default');
  const allowed = gate.buildReport({ repo: path.resolve(__dirname, '..'), allowDirty: true }, { runOffline: fakeOffline, regeneration: idempotent, securityAudit: safe, status: () => dirty, commit: 'deadbeef' });
  assert.strictEqual(allowed.ok, true, 'allow-dirty permits existing dirt only');
  let calls = 0;
  const changed = gate.buildReport({ repo: path.resolve(__dirname, '..'), allowDirty: true }, { runOffline: fakeOffline, regeneration: idempotent, securityAudit: safe, status: () => (++calls === 1 ? dirty : dirty.concat('?? new-file')), commit: 'deadbeef' });
  assert.strictEqual(changed.ok, false, 'gate-created tree drift always fails');

  const reportFile = path.join(root, 'release-report.json');
  gate.writeReport(reportFile, clean, path.resolve(__dirname, '..'));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(reportFile, 'utf8')), clean);
  assert.throws(() => gate.writeReport(path.join(__dirname, 'forbidden-report.json'), clean, path.resolve(__dirname, '..')), /outside the repository/);

  const audit = gate.securityAudit(path.resolve(__dirname, '..'));
  assert.strictEqual(audit.ok, true);
  assert.strictEqual(audit.provider_paid_required, false);
  assert.strictEqual(audit.secrets_forwarded, false);

  const regen = gate.regeneration(path.resolve(__dirname, '..'), 'win32');
  assert.strictEqual(regen.idempotent, true);
  assert.strictEqual(regen.tree_sha256, regen.repeat_tree_sha256);
  assert.strictEqual(regen.package_sha256, regen.repeat_package_sha256);
} finally { fs.rmSync(root, { recursive: true, force: true }); }

process.stdout.write('forge release gate tests passed (clean tree, regeneration, security, single report)\n');
