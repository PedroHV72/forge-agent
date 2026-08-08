#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const doc = fs.readFileSync(path.join(root, 'docs', 'operations.md'), 'utf8').replace(/\r\n/g, '\n');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');

for (const heading of [
  '### Windows — PowerShell', '### macOS e Linux', '## Upgrade seguro',
  '## Execução: Claude, Codex e handoff', '## Diagnóstico de capabilities',
  '## Headless e retries', '## MCP stdio e HTTP', '## Gate obrigatório offline',
  '## Smoke real — manual e separado',
]) assert(doc.includes(heading), `missing operations heading: ${heading}`);

for (const runtime of ['claude', 'codex', 'both']) {
  assert(doc.includes(`-Runtime ${runtime}`), `missing PowerShell install mode ${runtime}`);
  assert(doc.includes(`--runtime ${runtime}`), `missing POSIX install mode ${runtime}`);
}

for (const command of [
  '.\\install.ps1 -Runtime codex -Update',
  'bash ./install.sh --runtime codex --update',
  'node scripts/forge-update.js --runtime codex --dry-run --json',
  'node scripts/forge-doctor.js --check capabilities --runtime claude --json',
  'node scripts/forge-doctor.js --check capabilities --runtime codex --json',
  'node scripts/forge-package.js --verify',
  'node scripts/forge-headless.test.js',
  'node scripts/forge-mcp.test.js',
  'node scripts/forge-operational-parity.test.js',
]) assert(doc.includes(command), `missing executable operation: ${command}`);

for (const reason of [
  'core-incompatible', 'adapter-missing', 'required-capability-missing',
  'conditional-capability-unavailable', 'output-invalid',
  'auth-conditional-unavailable',
]) assert(doc.includes(reason), `missing diagnostic reason: ${reason}`);

assert(doc.includes('shell:false'));
assert(doc.includes('não pertence ao CI nem ao\ngate offline'));
assert(doc.includes('Não existe comando automático de paid smoke'));
assert(!/(?:OPENAI|ANTHROPIC|GEMINI)_API_KEY\s*=\s*\S+/.test(doc), 'documentation must not contain credential assignments');
assert(readme.includes('[Operação cross-platform](docs/operations.md)'));

const matrix = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'offline-ci', 'matrix.json'), 'utf8'));
assert(matrix.suites.includes('forge-operations-doc.test.js'));

process.stdout.write('forge operations documentation coverage passed\n');
