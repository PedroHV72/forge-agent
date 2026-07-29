#!/usr/bin/env node
// forge-creds.test.js — contract tests for the credential vault.
//
// The properties worth guarding are all about the secret NOT leaking: it must
// never reach the registry file, never reach stdout, and reach only the child
// process that needs it.
//
// Run: node scripts/forge-creds.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ENGINE = path.join(__dirname, 'forge-creds.js');

// Isolate the registry; the Keychain is shared, so tests use a unique service
// prefix and clean up after themselves.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-creds-'));
const REGISTRY = path.join(TMP, 'registry.json');
const SERVICE = `test${Date.now()}`;
process.env.FORGE_CREDS_REGISTRY = REGISTRY;

const creds = require('./forge-creds.js');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) {
    failed++; failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${m || 'mismatch'}\n     esperado: ${JSON.stringify(b)}\n     obtido:   ${JSON.stringify(a)}`);
  }
}
function cli(args, input) {
  return spawnSync(process.execPath, [ENGINE, ...args], {
    encoding: 'utf8',
    input: input === undefined ? '' : input,
    env: { ...process.env, FORGE_CREDS_REGISTRY: REGISTRY },
  });
}

console.log('\n=== forge-creds.js — contract test suite ===\n');

console.log('mapeamento de env var');

test('serviços conhecidos usam a variável que o CLI realmente lê', () => {
  // Getting this wrong runs the command unauthenticated, which fails in a way
  // that looks like a bad token.
  assertEq(creds.envVarFor('railway'), 'RAILWAY_TOKEN');
  assertEq(creds.envVarFor('vercel'), 'VERCEL_TOKEN');
  assertEq(creds.envVarFor('fly'), 'FLY_API_TOKEN');
  assertEq(creds.envVarFor('cloudflare'), 'CLOUDFLARE_API_TOKEN');
});

test('serviço desconhecido cai na convenção SERVICE_TOKEN', () => {
  assertEq(creds.envVarFor('meuservico'), 'MEUSERVICO_TOKEN');
  assertEq(creds.envVarFor('my-thing'), 'MY_THING_TOKEN');
});

console.log('\nregistro e segredo');

test('o segredo NUNCA entra no arquivo de registro', () => {
  const secret = 'sk-super-secreto-12345';
  creds.add({ service: SERVICE, name: 'a', secret });
  const raw = fs.readFileSync(REGISTRY, 'utf8');
  assert(!raw.includes(secret), 'segredo vazou para o registro!');
  assert(raw.includes(SERVICE), 'o registro deve conter o serviço');
});

test('o segredo volta pelo cofre', () => {
  assertEq(creds.get(SERVICE, 'a'), 'sk-super-secreto-12345');
});

test('list() não expõe segredo, só se existe', () => {
  const rows = creds.list().filter(c => c.service === SERVICE);
  assertEq(rows.length, 1);
  assertEq(rows[0].has_secret, true);
  assert(!('secret' in rows[0]), 'list() não pode carregar o segredo');
  assert(!JSON.stringify(rows).includes('sk-super-secreto'), 'segredo em list()');
});

test('readicionar substitui em vez de duplicar', () => {
  creds.add({ service: SERVICE, name: 'a', secret: 'novo-valor' });
  const rows = creds.load().filter(c => c.service === SERVICE && c.name === 'a');
  assertEq(rows.length, 1, 'não pode duplicar a entrada');
  assertEq(creds.get(SERVICE, 'a'), 'novo-valor');
});

test('--env sobrepõe a convenção', () => {
  creds.add({ service: SERVICE, name: 'custom', secret: 'x', envVar: 'MINHA_VAR' });
  assertEq(creds.find(SERVICE, 'custom').env_var, 'MINHA_VAR');
});

console.log('\nexec');

test('exec injeta a variável no filho e nada mais', () => {
  creds.add({ service: SERVICE, name: 'exec1', secret: 'valor-do-exec' });
  const r = cli(['--exec', SERVICE, 'exec1', '--',
    process.execPath, '-e', 'console.log(process.env.' + creds.envVarFor(SERVICE) + ')']);
  assertEq(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assertEq(r.stdout.trim(), 'valor-do-exec');
});

test('exec não vaza o segredo para o próprio ambiente', () => {
  const varName = creds.envVarFor(SERVICE);
  assert(!process.env[varName], 'a variável não pode existir no processo pai');
});

test('exec propaga o código de saída do comando', () => {
  const r = cli(['--exec', SERVICE, 'exec1', '--', process.execPath, '-e', 'process.exit(3)']);
  assertEq(r.status, 3, 'o exit code do filho tem que chegar ao chamador');
});

test('exec de credencial inexistente falha claramente', () => {
  const r = cli(['--exec', SERVICE, 'nao-existe', '--', 'echo', 'oi']);
  assertEq(r.status, 1);
  assert(/não está registrada/.test(r.stderr), r.stderr);
});

test('exec sem -- é erro de uso, não execução às cegas', () => {
  const r = cli(['--exec', SERVICE, 'exec1']);
  assertEq(r.status, 2);
});

console.log('\nsuperfície da CLI');

test('não existe comando que imprima o segredo', () => {
  // An agent that can print a secret will eventually print it into a
  // transcript, so the surface simply does not include one.
  const help = cli(['--help']).stdout;
  assert(!/--print|--token|--reveal|--show/.test(help), `help oferece impressão:\n${help}`);
  for (const flag of ['--print', '--token', '--reveal']) {
    const r = cli([flag, SERVICE, 'a']);
    assert(!r.stdout.includes('novo-valor'), `${flag} imprimiu o segredo`);
  }
});

test('--list --json não carrega segredo', () => {
  const r = cli(['--list', '--json']);
  assertEq(r.status, 0);
  assert(!r.stdout.includes('novo-valor'), 'segredo no --list --json');
  const rows = JSON.parse(r.stdout);
  assert(Array.isArray(rows));
});

test('--add sem stdin recusa em vez de guardar vazio', () => {
  const r = cli(['--add', SERVICE, 'vazio'], '');
  assertEq(r.status, 2);
  assert(/stdin/.test(r.stderr), r.stderr);
});

test('--add lê o segredo do stdin', () => {
  const r = cli(['--add', SERVICE, 'viacli'], 'segredo-do-stdin');
  assertEq(r.status, 0, r.stderr);
  assertEq(creds.get(SERVICE, 'viacli'), 'segredo-do-stdin');
  assert(!r.stdout.includes('segredo-do-stdin'), 'a confirmação não pode ecoar o segredo');
});

test('--services lista o mapeamento', () => {
  const r = cli(['--services', '--json']);
  assertEq(r.status, 0);
  const rows = JSON.parse(r.stdout);
  assert(rows.some(s => s.service === 'railway' && s.env === 'RAILWAY_TOKEN'));
});

console.log('\nremoção');

test('remove apaga registro e segredo', () => {
  creds.add({ service: SERVICE, name: 'temp', secret: 'apagar' });
  assertEq(creds.remove(SERVICE, 'temp'), true);
  assertEq(creds.find(SERVICE, 'temp'), null);
  assertEq(creds.get(SERVICE, 'temp'), null, 'o segredo tem que sumir do cofre');
});

test('remover o que não existe devolve false', () => {
  assertEq(creds.remove(SERVICE, 'fantasma'), false);
});

// ── Cleanup ─────────────────────────────────────────────────────────────────
for (const c of creds.load()) {
  if (c.service === SERVICE) creds.remove(c.service, c.name);
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n${'─'.repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFalhas:');
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.error}`);
}
console.log('');
process.exit(failed ? 1 : 0);
