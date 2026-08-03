#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const api = require('./forge-capabilities.js');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-capabilities-'));
  fs.mkdirSync(path.join(root, 'schemas'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'forge-sample'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'forge-sample', 'SKILL.md'), '---\nname: sample\n---\n');
  fs.writeFileSync(path.join(root, 'agents', 'forge-sample.md'), '---\nname: sample\n---\n');
  fs.writeFileSync(path.join(root, 'commands', 'forge-sample.md'), 'sample\n');
  const schema = {
    $defs: { host: { enum: ['claude', 'codex'] } },
  };
  const capability = (id, kind, probe) => ({
    capability_id: id, kind, owner: 'test-owner', required: true, classification: 'conditional',
    hosts: { claude: 'implemented', codex: 'planned' }, probe: { kind: 'filesystem', path: probe },
  });
  const catalog = {
    $schema: 'schemas/forge-capabilities.schema.json', schema_version: '1.0.0',
    release: { product_version_source: 'git-tag-release-workflow', adapters: { claude: { optional: true, host: 'claude' }, codex: { optional: true, host: 'codex' } } },
    capabilities: [
      capability('skill-forge-sample', 'skill', 'skills/forge-sample/SKILL.md'),
      capability('agent-forge-sample', 'agent', 'agents/forge-sample.md'),
      capability('command-forge-sample', 'command', 'commands/forge-sample.md'),
    ],
  };
  fs.writeFileSync(path.join(root, 'forge-capabilities.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(root, 'schemas', 'forge-capabilities.schema.json'), JSON.stringify(schema));
  return { root, catalog, schema, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function has(issues, text) { assert(issues.some((item) => item.includes(text)), `expected issue containing ${text}; got ${issues.join('; ')}`); }

test('loads the repository catalog and runtime-backed schema', () => {
  const loaded = api.loadCatalog(path.resolve(__dirname, '..'));
  assert.strictEqual(loaded.catalog.schema_version, '1.0.0');
  assert.deepStrictEqual(loaded.schema.$defs.host.enum, ['claude', 'codex']);
});
test('repository audit has complete discovered coverage', () => {
  const result = api.audit(path.resolve(__dirname, '..'));
  assert.deepStrictEqual(result.issues, []);
  assert(result.discovered.length >= 42);
});
test('all published skills have catalog entries', () => {
  const result = api.audit(path.resolve(__dirname, '..'));
  for (const surface of result.discovered.filter((entry) => entry.kind === 'skill')) assert(result.catalog.capabilities.some((entry) => entry.probe.path === surface.path));
});
test('all published agents have catalog entries', () => {
  const result = api.audit(path.resolve(__dirname, '..'));
  for (const surface of result.discovered.filter((entry) => entry.kind === 'agent')) assert(result.catalog.capabilities.some((entry) => entry.probe.path === surface.path));
});
test('all published commands have catalog entries', () => {
  const result = api.audit(path.resolve(__dirname, '..'));
  for (const surface of result.discovered.filter((entry) => entry.kind === 'command')) assert(result.catalog.capabilities.some((entry) => entry.probe.path === surface.path));
});
test('fixture audit accepts a classified filesystem inventory', () => {
  const data = fixture();
  try { assert.deepStrictEqual(api.audit(data.root).issues, []); } finally { data.cleanup(); }
});
test('audit rejects an omitted discovered surface', () => {
  const data = fixture();
  try { data.catalog.capabilities.pop(); fs.writeFileSync(path.join(data.root, 'forge-capabilities.json'), JSON.stringify(data.catalog)); has(api.audit(data.root).issues, 'published command missing'); } finally { data.cleanup(); }
});
test('audit rejects duplicate capability ids', () => {
  const data = fixture();
  try { data.catalog.capabilities.push(clone(data.catalog.capabilities[0])); has(api.validateCatalog(data.catalog, data.schema), 'duplicate capability_id'); } finally { data.cleanup(); }
});
test('audit rejects duplicate probe paths', () => {
  const data = fixture();
  try { data.catalog.capabilities[1].probe.path = data.catalog.capabilities[0].probe.path; fs.writeFileSync(path.join(data.root, 'forge-capabilities.json'), JSON.stringify(data.catalog)); has(api.audit(data.root).issues, 'duplicate probe path'); } finally { data.cleanup(); }
});
test('audit rejects an invalid host classification', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].hosts.codex = 'green'; has(api.validateCatalog(data.catalog, data.schema), 'invalid codex classification'); } finally { data.cleanup(); }
});
test('schema definitions do not contain duplicate keys', () => {
  const schemaText = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'schemas', 'forge-capabilities.schema.json'), 'utf8');
  assert.strictEqual((schemaText.match(/"reason_code"\s*:/g) || []).length, 1);
});
test('audit rejects a missing or invalid explicit classification', () => {
  const data = fixture();
  try {
    delete data.catalog.capabilities[0].classification;
    has(api.validateCatalog(data.catalog, data.schema), 'classification must be one of');
  } finally { data.cleanup(); }
});
test('audit rejects unknown host keys', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].hosts.agy = 'planned'; has(api.validateCatalog(data.catalog, data.schema), 'hosts: unknown key agy'); } finally { data.cleanup(); }
});
test('audit rejects an invalid host enum in the schema', () => {
  const data = fixture();
  try { data.schema.$defs.host.enum = ['claude']; has(api.validateCatalog(data.catalog, data.schema), 'host enum drifted'); } finally { data.cleanup(); }
});
test('audit rejects a missing owner', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].owner = ''; has(api.validateCatalog(data.catalog, data.schema), 'owner is required'); } finally { data.cleanup(); }
});
test('audit rejects an invalid capability id', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].capability_id = 'Bad_ID'; has(api.validateCatalog(data.catalog, data.schema), 'invalid capability_id'); } finally { data.cleanup(); }
});
test('audit rejects an invalid capability kind', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].kind = 'widget'; has(api.validateCatalog(data.catalog, data.schema), 'invalid kind'); } finally { data.cleanup(); }
});
test('audit rejects an invalid required marker', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].required = 'true'; has(api.validateCatalog(data.catalog, data.schema), 'required must be boolean'); } finally { data.cleanup(); }
});
test('audit rejects an unnormalized probe path', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].probe.path = 'skills\\forge-sample\\SKILL.md'; has(api.validateCatalog(data.catalog, data.schema), 'normalized filesystem path'); } finally { data.cleanup(); }
});
test('audit rejects dot and dot-dot probe path segments', () => {
  const data = fixture();
  try {
    const schemaPattern = new RegExp(api.loadCatalog(path.resolve(__dirname, '..')).schema.$defs.probe.properties.path.pattern);
    for (const probe of ['skills/./forge-sample/SKILL.md', 'skills/../outside']) {
      data.catalog.capabilities[0].probe.path = probe;
      has(api.validateCatalog(data.catalog, data.schema), 'normalized filesystem path');
      assert.strictEqual(schemaPattern.test(probe), false, `schema accepted traversal probe ${probe}`);
    }
  } finally { data.cleanup(); }
});
test('audit rejects a required capability with no probe', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].probe = {}; has(api.validateCatalog(data.catalog, data.schema), 'required capability has no planned probe'); } finally { data.cleanup(); }
});
test('audit rejects a required missing filesystem probe', () => {
  const data = fixture();
  try { data.catalog.capabilities[0].probe.path = 'missing/file'; fs.writeFileSync(path.join(data.root, 'forge-capabilities.json'), JSON.stringify(data.catalog)); has(api.audit(data.root).issues, 'required probe does not exist'); } finally { data.cleanup(); }
});
test('audit rejects product versions outside the release workflow', () => {
  const data = fixture();
  try { data.catalog.release.product_version_source = 'catalog'; has(api.validateCatalog(data.catalog, data.schema), 'product version must derive'); } finally { data.cleanup(); }
});
test('audit rejects an adapter that is not optional', () => {
  const data = fixture();
  try { data.catalog.release.adapters.codex.optional = false; has(api.validateCatalog(data.catalog, data.schema), 'adapter codex'); } finally { data.cleanup(); }
});
test('matrix ordering is deterministic', () => {
  const data = fixture();
  try { const once = JSON.stringify(api.matrix(data.catalog)); data.catalog.capabilities.reverse(); const twice = JSON.stringify(api.matrix(data.catalog)); assert.strictEqual(once, twice); } finally { data.cleanup(); }
});
test('text rendering is deterministic and readable', () => {
  const data = fixture();
  try { const rendered = api.renderText(api.matrix(data.catalog)); assert.match(rendered, /Capability/); assert.match(rendered, /skill-forge-sample/); } finally { data.cleanup(); }
});
test('matrix preserves platform-specific availability for Forge.app', () => {
  const matrix = api.matrix(api.loadCatalog(path.resolve(__dirname, '..')).catalog);
  const app = matrix.find((entry) => entry.capability_id === 'operational-app');
  assert.deepStrictEqual(app.platforms, { macos: 'conditional', windows: 'unavailable', linux: 'unavailable' });
  assert.match(api.renderText([app]), /windows:unavailable/);
  assert.match(api.renderText([app]), /linux:unavailable/);
});
test('JSON output is stable across repeated invocations', () => {
  let left = ''; let right = '';
  assert.strictEqual(api.run(['--matrix', '--json', '--cwd', path.resolve(__dirname, '..')], (value) => { left += value; }), 0);
  assert.strictEqual(api.run(['--matrix', '--json', '--cwd', path.resolve(__dirname, '..')], (value) => { right += value; }), 0);
  assert.strictEqual(left, right);
  assert.deepStrictEqual(JSON.parse(left).capabilities, api.matrix(api.loadCatalog(path.resolve(__dirname, '..')).catalog));
});
test('check output reports successful audit', () => {
  let output = ''; assert.strictEqual(api.run(['--check', '--cwd', path.resolve(__dirname, '..')], (value) => { output += value; }), 0); assert.match(output, /Capability audit passed/);
});
test('check output fails with actionable fixture errors', () => {
  const data = fixture();
  try { data.catalog.capabilities.pop(); fs.writeFileSync(path.join(data.root, 'forge-capabilities.json'), JSON.stringify(data.catalog)); let output = ''; assert.strictEqual(api.run(['--check', '--cwd', data.root], (value) => { output += value; }), 1); assert.match(output, /Capability audit failed/); } finally { data.cleanup(); }
});
test('discovery serializes Windows-safe catalog paths with slashes', () => {
  const data = fixture();
  try { assert(api.discover(data.root).every((entry) => !entry.path.includes('\\'))); assert.strictEqual(api.posixPath('.\\skills\\x'), 'skills/x'); } finally { data.cleanup(); }
});
test('help returns without reading a catalog', () => { let output = ''; assert.strictEqual(api.run(['--help'], (value) => { output += value; }), 0); assert.match(output, /Usage:/); });

test('detects a fake CLI with argv and never spawns the non-selected host', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cap-probe space-Ω-'));
  const fake = path.join(root, 'fake cli Ω.js');
  const marker = path.join(root, 'invocations.log');
  fs.writeFileSync(fake, [
    "const fs = require('fs');",
    "if (process.env.FORGE_FAKE_MARKER) fs.appendFileSync(process.env.FORGE_FAKE_MARKER, `${process.argv[2] || ''}\\n`);",
    "if (process.argv.includes('--version')) process.stdout.write('3.2.0\\n');",
    "else if (process.argv.includes('--help')) process.stdout.write('fake help\\n');",
    "else process.exitCode = 2;",
  ].join('\n'));
  try {
    const report = api.detect(path.resolve(__dirname, '..'), {
      runtime: 'claude',
      binaries: { claude: { command: process.execPath, args: [fake] }, codex: { command: process.execPath, args: [fake] } },
      env: { ...process.env, FORGE_FAKE_MARKER: marker },
    });
    assert.strictEqual(report.probes.claude.status, 'available');
    assert.strictEqual(report.probes.claude.reason_code, 'available');
    assert.strictEqual(report.probes.codex.reason_code, 'not-selected');
    assert.strictEqual(fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('classifies missing, unsupported, and invalid CLI probes with stable codes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cap-probe-negative-'));
  const low = path.join(root, 'low.js');
  const invalid = path.join(root, 'invalid.js');
  fs.writeFileSync(low, "if (process.argv.includes('--version')) process.stdout.write('0.0.1\\n'); else process.stdout.write('help\\n');");
  fs.writeFileSync(invalid, "if (process.argv.includes('--version')) process.stdout.write('not-a-version\\n'); else process.stdout.write('help\\n');");
  try {
    const base = path.resolve(__dirname, '..');
    const lowReport = api.detect(base, { runtime: 'claude', binaries: { claude: { command: process.execPath, args: [low] } } });
    assert.strictEqual(lowReport.probes.claude.status, 'unsupported');
    assert.strictEqual(lowReport.probes.claude.reason_code, 'minimum-version');
    const invalidReport = api.detect(base, { runtime: 'claude', binaries: { claude: { command: process.execPath, args: [invalid] } } });
    assert.strictEqual(invalidReport.probes.claude.status, 'inconclusive');
    assert.strictEqual(invalidReport.probes.claude.reason_code, 'invalid-output');
    const missingReport = api.detect(base, { runtime: 'claude', binaries: { claude: path.join(root, 'absent') } });
    assert.strictEqual(missingReport.probes.claude.status, 'missing');
    assert.strictEqual(missingReport.probes.claude.reason_code, 'missing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows .cmd shims keep argv and Unicode paths without shell fallback', () => {
  if (process.platform !== 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cap-cmd-Ω-'));
  const shim = path.join(root, 'fake cli Ω.cmd');
  fs.writeFileSync(shim, '@echo off\r\nif "%1"=="--version" (echo 3.2.0) else (echo help)\r\n', 'utf8');
  try {
    const report = api.detect(path.resolve(__dirname, '..'), { runtime: 'claude', binaries: { claude: shim } });
    assert.strictEqual(report.probes.claude.status, 'available');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('POSIX non-executable probe reports permission-denied', () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cap-noexec-'));
  const file = path.join(root, 'fake-cli');
  fs.writeFileSync(file, '#!/bin/sh\necho 3.2.0\n', 'utf8');
  fs.chmodSync(file, 0o644);
  try {
    const report = api.detect(path.resolve(__dirname, '..'), { runtime: 'claude', binaries: { claude: file } });
    assert.strictEqual(report.probes.claude.reason_code, 'permission-denied');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
