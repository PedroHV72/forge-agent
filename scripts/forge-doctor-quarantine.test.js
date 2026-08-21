#!/usr/bin/env node
'use strict';

// S03/T03 — surfacing the memory-quarantine sidecar (forge-memory-quarantine.js,
// T02) through forge-doctor.js: a pending fact refused by writeFragment's
// `grouped-member` guard must be COUNTED AND NAMED to the operator, not merely
// flagged present (S03-RISK warning 1: "há pendências" without a number is
// silence with different clothes). Six units under test:
//   (a) fixture with 2 pending entries -> pending: 2, both names in message.
//   (b) missing quarantine dir -> pending: 0, ok: true, never an error.
//   (c) a corrupted .json entry -> counted as unreadable, never dropped.
//   (d) `--check memory-quarantine` with pending entries -> exit 0 (process
//       property, spawned).
//   (e) `--check all` with pending entries -> exit 0, section present.
//   (f) IN-15 — the operational-order rule is greppable in BOTH the policy
//       header and the `--help` output of forge-sweep-project.js, naming the
//       consequence (loose beats grouped).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  checkMemoryQuarantine, VALID_CHECKS, CURRENT_SCHEMA,
} = require('./forge-doctor.js');
const { quarantineFragment } = require('./forge-memory-quarantine.js');

const DOCTOR_CLI = path.join(__dirname, 'forge-doctor.js');
const SWEEP_PROJECT_FILE = path.join(__dirname, 'forge-sweep-project.js');
const SWEEP_PROJECT_CLI = path.join(__dirname, 'forge-sweep-project.js');

// Frase-âncora citada pela aceitação da slice (S03-RISK / IN-15): a frase
// vive aqui, numa constante, para que o grep de aceitação a cite em vez de
// reimplementar o casamento.
const IN15_ANCHOR = 'edição de memória';
const IN15_CONSEQUENCE = 'a cópia solta vence a agrupada';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL ${name}\n    ${error && error.stack}\n`);
  }
}

function mkTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `forge-${label}-`));
}

function quarantineDirOf(root) {
  return path.join(root, '.gsd', 'memory', 'quarantine');
}

// ── (a) fixture with 2 pending entries ───────────────────────────────────────

test('checkMemoryQuarantine counts AND names pending entries (2)', () => {
  const root = mkTmp('t03-q-two');
  try {
    const f1 = quarantineFragment(root, { unit_id: 'T01', category: 'gotcha', text: 'a' }, {
      storageKey: 'S01T01MEM001', unitId: 'T01', reason: 'grouped-member',
    });
    const f2 = quarantineFragment(root, { unit_id: 'T02', category: 'pattern', text: 'b' }, {
      storageKey: 'S01T02MEM001', unitId: 'T02', reason: 'grouped-member',
    });

    const r = checkMemoryQuarantine(root);
    assert.strictEqual(r.ok, true, 'advisory: ok must always be true');
    assert.strictEqual(r.pending, 2, `expected pending:2, got ${r.pending}`);
    assert.strictEqual(r.files.length, 2, 'files[] must name each pending entry');
    const name1 = path.basename(f1.path);
    const name2 = path.basename(f2.path);
    assert.ok(r.files.includes(name1), `files[] must include ${name1}`);
    assert.ok(r.files.includes(name2), `files[] must include ${name2}`);
    assert.ok(r.message.includes(name1), `message must NAME ${name1}, not just count`);
    assert.ok(r.message.includes(name2), `message must NAME ${name2}, not just count`);
    assert.ok(/\b2\b/.test(r.message), 'message must CONTAIN the number (pending: N), not just "há pendências"');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── (b) missing/empty quarantine ─────────────────────────────────────────────

test('checkMemoryQuarantine: missing quarantine dir -> pending: 0, ok: true, never an error', () => {
  const root = mkTmp('t03-q-missing');
  try {
    const r = checkMemoryQuarantine(root);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pending, 0);
    assert.deepStrictEqual(r.files, []);
    assert.ok(!r.skipped, 'a missing/empty quarantine is not an error condition');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkMemoryQuarantine: empty quarantine dir -> pending: 0', () => {
  const root = mkTmp('t03-q-empty');
  try {
    fs.mkdirSync(quarantineDirOf(root), { recursive: true });
    const r = checkMemoryQuarantine(root);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pending, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── (c) unreadable entry ─────────────────────────────────────────────────────

test('checkMemoryQuarantine: corrupted .json entry is counted as unreadable, never dropped', () => {
  const root = mkTmp('t03-q-corrupt');
  try {
    const dir = quarantineDirOf(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'S01T01MEM001~20260818T000000Z.json'), '{ not valid json', 'utf8');

    const r = checkMemoryQuarantine(root);
    assert.strictEqual(r.ok, true, 'advisory: unreadable must still be ok:true');
    assert.strictEqual(r.pending, 1, 'an unreadable entry is still counted as pending');
    assert.strictEqual(r.files.length, 1, 'an unreadable entry must still be named, never dropped silently');
    assert.ok(/unreadable|ileg[ií]vel/i.test(r.message), 'message must mark the entry unreadable, not silently skip it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── (d) exit 0 of the process, with pending entries ──────────────────────────

test('--check memory-quarantine exits 0 (process property) even with pending entries', () => {
  const root = mkTmp('t03-q-cli');
  try {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    quarantineFragment(root, { unit_id: 'T01', category: 'gotcha', text: 'a' }, {
      storageKey: 'S01T01MEM001', unitId: 'T01', reason: 'grouped-member',
    });

    const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'memory-quarantine', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `must exit 0 with pendências present, got ${r.status}: ${r.stderr}`);
    assert.ok(/memory-quarantine|quarentena/.test(r.stdout), 'stdout must mention the check');
    assert.ok(/S01T01MEM001/.test(r.stdout), 'stdout must NAME the pending entry, not just count it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("'memory-quarantine' is in VALID_CHECKS and derived into usage", () => {
  assert.ok(VALID_CHECKS.includes('memory-quarantine'), 'memory-quarantine must be a valid check');
  const help = spawnSync(process.execPath, [DOCTOR_CLI, '--help'], { encoding: 'utf8' });
  assert.strictEqual(help.status, 0);
  assert.ok(help.stdout.includes('memory-quarantine'), '--help must list memory-quarantine (derived from VALID_CHECKS)');
});

// ── (e) --check all stays green with pending entries ─────────────────────────

test('--check all stays exit 0 with pending memory-quarantine entries present', () => {
  const root = mkTmp('t03-q-all');
  try {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    // Non-advisory layer (schema) passes on its own terms, so this test
    // isolates the memory-quarantine check's contribution to `allOk`.
    fs.writeFileSync(path.join(root, '.gsd', 'SCHEMA-VERSION'), `${CURRENT_SCHEMA}\n`, 'utf8');
    quarantineFragment(root, { unit_id: 'T01', category: 'gotcha', text: 'a' }, {
      storageKey: 'S01T01MEM001', unitId: 'T01', reason: 'grouped-member',
    });

    const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'all', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `--check all must stay exit 0, got ${r.status}: ${r.stderr}`);
    assert.ok(/memory-quarantine|quarentena/.test(r.stdout), '--check all must include the memory-quarantine section');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── (f) IN-15 greppable in both header policy AND --help ─────────────────────

test('IN-15: the operational-order rule is present in forge-sweep-project.js header AND --help, naming the consequence', () => {
  const source = fs.readFileSync(SWEEP_PROJECT_FILE, 'utf8');
  assert.ok(source.includes(IN15_ANCHOR), `header/policy source must mention "${IN15_ANCHOR}"`);
  assert.ok(source.includes(IN15_CONSEQUENCE), `header/policy source must name the consequence "${IN15_CONSEQUENCE}"`);

  const help = spawnSync(process.execPath, [SWEEP_PROJECT_CLI, '--help'], { encoding: 'utf8' });
  assert.strictEqual(help.status, 0, `--help must exit 0, got ${help.status}: ${help.stderr}`);
  assert.ok(help.stdout.includes(IN15_ANCHOR), `--help stdout must mention "${IN15_ANCHOR}"`);
  assert.ok(help.stdout.includes(IN15_CONSEQUENCE), `--help stdout must name the consequence "${IN15_CONSEQUENCE}"`);
  assert.ok(/grouped-member/.test(source) && /grouped-member/.test(help.stdout), 'both surfaces must name the refusal signal grouped-member');
});


// ── R2/R3 (review S03): advisory nunca quebra, e vazio nunca mente ───────────

test('R2: uma entrada com {"path": null} não quebra o check advisory', () => {
  const root = mkTmp('doctor-quarantine-forged');
  try {
    const dir = quarantineDirOf(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'forjado~20260818T000000Z.json'),
      JSON.stringify({ path: null, unreadable: true, unit_id: 'S01' })
    );
    const result = checkMemoryQuarantine(root);
    assert.strictEqual(result.ok, true, 'o check é advisory absoluto');
    assert.strictEqual(result.pending, 1, 'a entrada forjada continua contada');
    assert.ok(result.files.every(n => typeof n === 'string'), 'todo nome tem que ser derivável do path confiável');

    // Propriedade de processo: nem o CLI pode sair não-zero por conteúdo de arquivo.
    const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'memory-quarantine', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `advisory tem que sair 0, saiu ${r.status}: ${r.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R3: quarentena ilegível vira skipped: error — nunca "0 pendências" verde', () => {
  const root = mkTmp('doctor-quarantine-unreadable');
  try {
    const dir = quarantineDirOf(root);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'não sou um diretório');
    const result = checkMemoryQuarantine(root);
    assert.strictEqual(result.ok, true, 'segue advisory');
    assert.ok(result.skipped && /error/.test(result.skipped), 'não conseguir ler tem que aparecer como skipped: error');
    assert.ok(
      !/0 pendências/.test(result.message || ''),
      'um falso limpo é o defeito: "0 pendências" não pode sair de uma leitura que falhou'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
