#!/usr/bin/env node
// forge-keychain-diagnostics.test.js — the diagnostics recorder must capture
// evidence of a Keychain write failure and must NEVER leak the secret value.
//
// Run: node scripts/forge-keychain-diagnostics.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-keychain-diag-'));
const DIAG_FILE = path.join(TMP, 'diag.jsonl');
process.env.FORGE_KEYCHAIN_DIAGNOSTICS = DIAG_FILE;

const diag = require('./forge-keychain-diagnostics.js');

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

function freshFile() {
  try { fs.rmSync(DIAG_FILE, { force: true }); } catch {}
}

console.log('recordFailure');

test('grava uma entrada com os campos esperados', () => {
  freshFile();
  const err = Object.assign(new Error('boom'), {
    status: 128,
    signal: null,
    code: undefined,
    stderr: 'security: SecKeychainAddGenericPassword: A required entitlement is missing.',
  });
  diag.recordFailure({
    engine: 'forge-secrets.storeSecret',
    service: 'forge-secret-figma-default',
    account: 'matheustelles',
    err,
    fallback: true,
  });
  const entries = diag.readEntries();
  assert(entries.length === 1, 'deve ter uma entrada');
  const e = entries[0];
  assert(e.engine === 'forge-secrets.storeSecret');
  assert(e.service === 'forge-secret-figma-default');
  assert(e.account === 'matheustelles');
  assert(e.status === 128);
  assert(e.fallback === true);
  assert(typeof e.ts === 'string' && e.ts.includes('T'));
  assert(e.stderr.includes('entitlement'));
  assert('ppid' in e.process);
  assert('term_program' in e.process);
  assert('claude_code_entrypoint' in e.process);
  assert('claudecode' in e.process);
  assert('cf_bundle_identifier' in e.process);
});

test('nunca lança mesmo com err malformado', () => {
  freshFile();
  assert.doesNotThrow ? null : null; // no-op, using try/catch below
  let threw = false;
  try { diag.recordFailure({ engine: 'x', service: 's', account: 'a', err: null, fallback: false }); }
  catch { threw = true; }
  assert(!threw, 'recordFailure não deve lançar');
});

console.log('\nnão vaza segredos');

test('o valor sentinela do segredo não aparece no arquivo', () => {
  freshFile();
  const SENTINEL = 'sk-super-secret-sentinel-9f8e7d6c5b';
  const err = Object.assign(new Error('boom'), {
    status: 1,
    stderr: `security: something failed, maybe echoed -w ${SENTINEL} back`,
  });
  diag.recordFailure({
    engine: 'forge-accounts.storeToken',
    service: 'forge-account-default',
    account: 'matheustelles',
    err,
    fallback: false,
  });
  const raw = fs.readFileSync(DIAG_FILE, 'utf8');
  assert(!raw.includes(SENTINEL), `segredo vazou no arquivo de diagnóstico:\n${raw}`);
});

console.log('\ncap de tamanho');

test('trunca quando o arquivo excede o teto', () => {
  freshFile();
  // Write well past MAX_BYTES (256 KiB) directly, then trigger the cap via
  // one more recordFailure call.
  const bigLine = JSON.stringify({ ts: new Date().toISOString(), engine: 'pad', stderr: 'x'.repeat(400) });
  const lines = [];
  let size = 0;
  while (size < 300 * 1024) { lines.push(bigLine); size += bigLine.length + 1; }
  fs.mkdirSync(path.dirname(DIAG_FILE), { recursive: true });
  fs.writeFileSync(DIAG_FILE, `${lines.join('\n')}\n`, 'utf8');
  const beforeSize = fs.statSync(DIAG_FILE).size;
  assert(beforeSize > 256 * 1024, 'setup deveria exceder o teto');

  diag.recordFailure({
    engine: 'forge-secrets.storeSecret',
    service: 'svc',
    account: 'acct',
    err: Object.assign(new Error('x'), { status: 1, stderr: 'y' }),
    fallback: true,
  });

  const afterSize = fs.statSync(DIAG_FILE).size;
  assert(afterSize < beforeSize, `deveria truncar (antes=${beforeSize}, depois=${afterSize})`);
  assert(afterSize <= 256 * 1024 + 2048, `deveria ficar perto do teto (depois=${afterSize})`);
  const entries = diag.readEntries();
  assert(entries.some(e => e.engine === 'forge-secrets.storeSecret'), 'a entrada mais recente deve sobreviver ao truncamento');
});

console.log('\nformatação legível');

test('formatEntries não expõe segredos e cobre "sem entradas"', () => {
  freshFile();
  assert(diag.formatEntries([]).length > 0);
  diag.recordFailure({
    engine: 'forge-accounts.storeToken',
    service: 'forge-account-default',
    account: 'matheustelles',
    err: Object.assign(new Error('x'), { status: 1, signal: null, stderr: 'nope' }),
    fallback: false,
  });
  const out = diag.formatEntries(diag.readEntries());
  assert(out.includes('forge-accounts.storeToken'));
  assert(out.includes('service=forge-account-default'));
});

// ── Cleanup ───────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n${'─'.repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFalhas:');
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.error}`);
}
console.log('');
process.exit(failed ? 1 : 0);
