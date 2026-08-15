#!/usr/bin/env node
'use strict';

// Runtime fixtures matter here: a checkout may normalize committed text EOLs,
// whereas the vault's only useful promise is preservation of actual bytes.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { serializeGroup } = require('./forge-grouped-file');
const { vaultDir, writeVault, restoreVault, listVaults } = require('./forge-sweep-vault');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error: error.message });
    console.log(`  not ok - ${name}: ${error.message}`);
  }
}

function assert(value, message) {
  if (!value) throw new Error(message || 'assertion failed');
}

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-vault-test-'));
}

function write(cwd, relative, bytes) {
  const file = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function remove(cwd) {
  fs.rmSync(cwd, { recursive: true, force: true });
}

console.log('\nforge-sweep-vault: byte-preserving pre-apply containers\n');

test('round-trips runtime CRLF and LF fixtures byte-for-byte', () => {
  const cwd = fixture();
  const crlf = Buffer.from('# CRLF\r\nline two\r\n', 'utf8');
  const lf = Buffer.from('# LF\nline two\n', 'utf8');
  const crlfPath = write(cwd, '.gsd/memory/crlf.md', crlf);
  const lfPath = write(cwd, '.gsd/decisions/lf.md', lf);
  const vault = writeVault(cwd, { operation: 'dedupe', files: [crlfPath, lfPath] });
  assert(vault.ok, 'vault write should succeed');
  assert(vault.containerPath.startsWith(vaultDir(cwd)), 'container should be in vault directory');
  fs.unlinkSync(crlfPath);
  fs.unlinkSync(lfPath);
  const result = restoreVault(cwd, vault.containerPath);
  assert(result.restored.length === 2, 'both missing files should restore');
  assert(Buffer.compare(crlf, fs.readFileSync(crlfPath)) === 0, 'CRLF bytes must match exactly');
  assert(Buffer.compare(lf, fs.readFileSync(lfPath)) === 0, 'LF bytes must match exactly');
  remove(cwd);
});

test('round-trips a BOM and a file without a final newline', () => {
  const cwd = fixture();
  const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
  const noFinalNewline = Buffer.from('last line has no newline', 'utf8');
  const bomPath = write(cwd, '.gsd/items/bom.md', bom);
  const plainPath = write(cwd, '.gsd/items/no-final.md', noFinalNewline);
  const vault = writeVault(cwd, { operation: 'dedupe', files: [bomPath, plainPath] });
  fs.unlinkSync(bomPath);
  fs.unlinkSync(plainPath);
  const result = restoreVault(cwd, vault.containerPath);
  assert(result.refused.length === 0, 'restore must not refuse valid byte fixtures');
  assert(Buffer.compare(bom, fs.readFileSync(bomPath)) === 0, 'BOM must survive');
  assert(Buffer.compare(noFinalNewline, fs.readFileSync(plainPath)) === 0, 'final newline absence must survive');
  remove(cwd);
});

test('an identical present destination is reported without rewriting it', () => {
  const cwd = fixture();
  const bytes = Buffer.from('same bytes\r\n', 'utf8');
  const member = write(cwd, '.gsd/memory/same.md', bytes);
  const vault = writeVault(cwd, { operation: 'dedupe', files: [member] });
  const before = fs.statSync(member).mtimeMs;
  const result = restoreVault(cwd, vault.containerPath);
  const after = fs.statSync(member).mtimeMs;
  assert(result.alreadyPresent.length === 1, 'identical file should be already present');
  assert(result.restored.length === 0, 'identical file must not be rewritten');
  assert(before === after, 'mtime must be untouched for already-present bytes');
  assert(Buffer.compare(bytes, fs.readFileSync(member)) === 0, 'bytes must stay untouched');
  remove(cwd);
});

test('a divergent destination is named and never overwritten', () => {
  const cwd = fixture();
  const original = Buffer.from('before\n', 'utf8');
  const changed = Buffer.from('after\n', 'utf8');
  const member = write(cwd, '.gsd/memory/conflict.md', original);
  const vault = writeVault(cwd, { operation: 'dedupe', files: [member] });
  fs.writeFileSync(member, changed);
  const result = restoreVault(cwd, vault.containerPath);
  assert(result.refused.length === 1, 'divergence must be recorded as one refusal');
  assert(result.refused[0].reason === 'destination-has-different-bytes', 'refusal needs a stable reason');
  assert(Buffer.compare(changed, fs.readFileSync(member)) === 0, 'divergent destination must remain untouched');
  remove(cwd);
});

test('a member id escaping .gsd is refused by real containment', () => {
  const cwd = fixture();
  const dir = vaultDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const malicious = path.join(dir, 'malicious.md');
  const serialized = serializeGroup({ label: 'dedupe', units: [
    { id: '../outside.md', content: Buffer.from('never write this', 'utf8') },
  ] });
  fs.writeFileSync(malicious, serialized.buffer);
  const result = restoreVault(cwd, malicious);
  assert(result.refused.length === 1, 'escaping member must be refused');
  assert(result.refused[0].reason === 'path-escapes-gsd', 'escape should have named reason');
  assert(!fs.existsSync(path.join(cwd, 'outside.md')), 'outside path must remain absent');
  remove(cwd);
});

// R4: containment must be proven before any mutation. A symlinked intermediate
// segment used to be followed by mkdirSync(recursive), creating directories
// outside .gsd; the later refusal only stopped the final file write.
test('a symlinked intermediate segment creates nothing outside .gsd', () => {
  const cwd = fixture();
  const outside = path.join(cwd, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
  const link = path.join(cwd, '.gsd', 'link');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch (error) {
    // Symlink creation needs privileges on some platforms; the skip is named
    // rather than silently passing.
    console.log(`  skip - symlink escape (symlink indisponível: ${error.code || error.message})`);
    remove(cwd);
    return;
  }
  const dir = vaultDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const container = path.join(dir, 'symlink-escape.md');
  fs.writeFileSync(container, serializeGroup({ label: 'dedupe', units: [
    { id: '.gsd/link/escaped/file.md', content: Buffer.from('never write this', 'utf8') },
  ] }).buffer);
  const result = restoreVault(cwd, container);
  assert(result.refused.length === 1, 'symlink boundary must be refused');
  assert(result.refused[0].reason === 'path-escapes-gsd', 'refusal needs the containment reason');
  assert(!fs.existsSync(path.join(outside, 'escaped')), 'no directory may be created outside .gsd');
  assert(result.restored.length === 0, 'nothing may be restored through the link');
  remove(cwd);
});

test('a payload containing the format delimiter prevents any vault write', () => {
  const cwd = fixture();
  const unsafe = write(cwd, '.gsd/memory/unsafe.md', Buffer.from('x\n<!-- forge:endunit id=x -->\n', 'utf8'));
  const result = writeVault(cwd, { operation: 'dedupe', files: [unsafe] });
  assert(result.ok === false, 'unsafe payload must reject the whole write');
  assert(result.skipped.length === 1, 'serializeGroup skip should be exposed');
  assert(result.skipped[0].reason === 'delimiter-in-payload', 'skip reason should be preserved');
  assert(listVaults(cwd).length === 0, 'no incomplete vault container may be written');
  remove(cwd);
});

test('listVaults returns deterministic filename order', () => {
  const cwd = fixture();
  const dir = vaultDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'z.md'), 'z');
  fs.writeFileSync(path.join(dir, 'a.md'), 'a');
  assert(listVaults(cwd).map(file => path.basename(file)).join(',') === 'a.md,z.md', 'vaults should sort by name');
  remove(cwd);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const failure of failures) console.error(`${failure.name}: ${failure.error}`);
  process.exit(1);
}
