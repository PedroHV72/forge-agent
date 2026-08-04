#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const mcp = require('./forge-mcp.js');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform} stdio config uses absolute executable and argv without shell`, () => {
    const result = mcp.normalize({ id: 'fixture', transport: 'stdio', command: process.execPath, args: ['server.js'], platform, claudeHome: 'absent', codexHome: 'absent' });
    assert.deepStrictEqual(result.process, { executable: process.execPath, args: ['server.js'], shell: false });
    assert(!JSON.stringify(result).includes('absent'));
  });
}

test('HTTP config is canonical and credential headers are runtime-only', () => {
  const result = mcp.normalize({ id: 'remote', transport: 'http', url: 'https://example.test/mcp', headers: { 'X-Client': 'forge' }, auth: { required: true, available: true, kind: 'bearer', header_name: 'Authorization' } });
  assert.strictEqual(result.status, 'available');
  assert.strictEqual(result.http.url, 'https://example.test/mcp');
  assert(!JSON.stringify(result).includes('Bearer '));
  assert.strictEqual(result.auth.source, 'runtime-injection');
});

test('missing auth is conditional-unavailable and projects no host config', () => {
  const input = { id: 'remote', transport: 'http', url: 'https://example.test/mcp', auth: { required: true, available: false } };
  const canonical = mcp.normalize(input);
  assert.strictEqual(canonical.reason_code, 'auth-conditional-unavailable');
  for (const host of ['claude', 'codex']) assert.strictEqual(mcp.project(input, host).config, null);
});

test('invalid JSON, relative commands, unsafe URL and credential literals fail closed', () => {
  assert.throws(() => mcp.normalize('{bad'), (error) => error.reason_code === 'invalid-json');
  assert.throws(() => mcp.normalize({ id: 'x', command: 'node', args: [] }), (error) => error.reason_code === 'invalid-command');
  assert.throws(() => mcp.normalize({ id: 'x', transport: 'http', url: 'file:///secret' }), (error) => error.reason_code === 'invalid-url');
  assert.throws(() => mcp.normalize({ id: 'x', transport: 'http', url: 'https://example.test', headers: { Authorization: 'secret' } }), (error) => error.reason_code === 'credential-in-config');
});

test('projections preserve the same canonical stdio semantics for both hosts', () => {
  const config = { id: 'same', command: path.resolve(process.execPath), args: ['server.js'] };
  assert.deepStrictEqual(mcp.project(config, 'claude').config, mcp.project(config, 'codex').config);
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
