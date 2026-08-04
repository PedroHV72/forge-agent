#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const api = require('./forge-manifest');
let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
const ROOT = path.resolve(__dirname, '..');
test('repository manifest audits every published surface', () => { const result = api.audit(ROOT); assert.deepStrictEqual(result.issues, []); assert(result.discovered.length >= 40); });
test('matrix ordering is deterministic and host-neutral', () => { const manifest = api.loadManifest(ROOT).manifest; const left = JSON.stringify(api.matrix(manifest)); manifest.entries.reverse(); assert.strictEqual(left, JSON.stringify(api.matrix(manifest))); assert(!left.includes('~/.claude')); assert(!left.includes('~/.codex')); });
test('audit rejects duplicate ids and discovery patterns', () => { const manifest = api.loadManifest(ROOT).manifest; const copy = JSON.parse(JSON.stringify(manifest)); copy.entries.push({ ...copy.entries[0] }); assert(api.validate(copy).some((issue) => issue.includes('duplicate source_id'))); });
test('audit rejects absolute, Windows and traversal discovery paths', () => { const manifest = api.loadManifest(ROOT).manifest; for (const value of ['/agents/*.md', 'agents\\*.md', 'agents/../*.md']) { const copy = JSON.parse(JSON.stringify(manifest)); copy.entries[0].discovery = value; assert(api.validate(copy).some((issue) => issue.includes('discovery'))); } });
test('fixture audit reports omitted surface and preserves reason', () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-manifest-')); try { fs.mkdirSync(path.join(root, 'agents'), { recursive: true }); fs.writeFileSync(path.join(root, 'agents', 'extra.md'), 'x'); fs.writeFileSync(path.join(root, 'forge-manifest.json'), JSON.stringify({ $schema: 'schemas/forge-manifest.schema.json', schema_version: '1.0.0', product_version: '3.1.4', newline: 'lf', entries: [] })); fs.mkdirSync(path.join(root, 'schemas')); fs.writeFileSync(path.join(root, 'schemas', 'forge-manifest.schema.json'), '{}'); const result = api.audit(root); assert(result.issues.some((issue) => issue.includes('missing from manifest'))); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
test('CLI JSON output is stable', () => { let left = ''; let right = ''; assert.strictEqual(api.run(['--audit', '--json', '--cwd', ROOT], (value) => { left += value; }), 0); assert.strictEqual(api.run(['--audit', '--json', '--cwd', ROOT], (value) => { right += value; }), 0); assert.strictEqual(left, right); });
process.stdout.write(`\n${passed} passed, 0 failed\n`);
