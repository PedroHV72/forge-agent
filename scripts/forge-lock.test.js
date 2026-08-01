#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const lock = require('./forge-lock.js');

function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge lock espaço-測試-'));
}
function remove(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function child(cwd, name, barrier) {
  const source = [
    "const l=require(process.argv[1]);",
    "const fs=require('fs');",
    "const cwd=process.argv[2],name=process.argv[3],barrier=process.argv[4];",
    "while(!fs.existsSync(barrier)){}",
    "const h=l.tryAcquireSync(cwd,name,{ttlMs:5000});",
    "process.stdout.write(JSON.stringify({won:!!h,token:h&&h.ownerToken}));",
    "if(h)setTimeout(()=>h.release(),80);"
  ].join('');
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['-e', source, path.join(__dirname, 'forge-lock.js'), cwd, name, barrier], { shell: false });
    let output = ''; let error = '';
    proc.stdout.on('data', data => { output += data; });
    proc.stderr.on('data', data => { error += data; });
    proc.on('error', reject);
    proc.on('exit', code => resolve({ code, output, error }));
  });
}
async function testExactOneWinner() {
  const cwd = temporary(); const barrier = path.join(cwd, 'go');
  try {
    const attempts = [child(cwd, 'cross-platform', barrier), child(cwd, 'cross-platform', barrier)];
    fs.writeFileSync(barrier, 'go');
    const results = await Promise.all(attempts);
    assert.deepStrictEqual(results.map(result => result.code), [0, 0]);
    const winners = results.map(result => JSON.parse(result.output)).filter(result => result.won);
    assert.strictEqual(winners.length, 1, `expected one winner: ${JSON.stringify(results)}`);
  } finally { remove(cwd); }
}
function testOwnerScopedRenewalAndRelease() {
  const cwd = temporary();
  try {
    const first = lock.tryAcquireSync(cwd, 'owner', { ttlMs: 5_000 });
    assert(first);
    const fake = { lockDir: first.lockDir, ownerToken: 'not-the-owner', generation: first.generation };
    assert.deepStrictEqual(lock.renewHandle(fake), { ok: false, reason: 'owner_mismatch' });
    assert.deepStrictEqual(lock.releaseHandle(fake), { ok: false, reason: 'owner_mismatch' });
    assert.strictEqual(lock.releaseSync(cwd, 'owner'), false, 'legacy release cannot prove ownership');
    assert.strictEqual(first.renew().ok, true);
    assert.strictEqual(first.release().ok, true);
    assert.deepStrictEqual(first.release(), { ok: false, reason: 'owner_mismatch' });
  } finally { remove(cwd); }
}
function testStaleRecoveryAndABA() {
  const cwd = temporary();
  try {
    const old = lock.tryAcquireSync(cwd, 'aba', { ttlMs: 10, now: () => 10, tokenFactory: (() => { let n = 0; return () => `token${++n}`; })() });
    assert(old);
    const successor = lock.tryAcquireSync(cwd, 'aba', { ttlMs: 10, now: () => 100 });
    assert(successor, 'expired generation is quarantined then reacquired');
    assert.notStrictEqual(successor.generation, old.generation);
    assert.deepStrictEqual(old.release(), { ok: false, reason: 'owner_mismatch' }, 'old callback cannot unlink new generation');
    assert.strictEqual(lock.status(cwd, 'aba').metadata.generation, successor.generation);
    assert.strictEqual(successor.release().ok, true);
  } finally { remove(cwd); }
}
function testCrashBeforeMetadataIsRecoverable() {
  const cwd = temporary();
  try {
    const dir = lock.lockPath(cwd, 'crash'); fs.mkdirSync(dir, { recursive: true });
    const stale = new Date(0); fs.utimesSync(dir, stale, stale);
    const acquired = lock.tryAcquireSync(cwd, 'crash', { ttlMs: 10, now: () => 100 });
    assert(acquired);
    assert.strictEqual(acquired.release().ok, true);
  } finally { remove(cwd); }
}
async function main() {
  console.log(`forge-lock tests on ${process.platform}`);
  testOwnerScopedRenewalAndRelease();
  testStaleRecoveryAndABA();
  testCrashBeforeMetadataIsRecoverable();
  await testExactOneWinner();
  console.log('forge-lock tests passed');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
