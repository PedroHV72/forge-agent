#!/usr/bin/env node
'use strict';

// Standalone CLI coverage.  This suite is intentionally not run while the
// task is implemented; the repository runner discovers it after handoff.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cliPath = path.join(__dirname, 'forge-sweep-project.js');
const epochGroup = require('./forge-epoch-group');
const { serializeGroup } = require('./forge-grouped-file');
const { buildRegistry } = require('./forge-sweep-project');

// Hand-built legacy container: PR-1 shape, grouped_format present but no
// grouped_from/grouped_to lines at all — genuinely predates T03's range
// fields, unlike serializeGroup's output which always emits them (even
// empty). --list must tell these apart from a range that is merely blank.
function writeLegacyContainer(cwd, storeDir, label, unitId, payload) {
  const dir = path.join(cwd, '.gsd', storeDir);
  fs.mkdirSync(dir, { recursive: true });
  const body = Buffer.from(payload, 'utf8');
  const header = ['---', 'grouped_format: forge-group@1', `grouped_epoch: ${label}`, 'grouped_units: 1', '---', '', ''].join('\n');
  const marker = Buffer.from(`<!-- forge:unit id=${unitId} bytes=${body.length} -->\n`, 'utf8');
  const endMarker = Buffer.from(`\n<!-- forge:endunit id=${unitId} -->\n`, 'utf8');
  const buffer = Buffer.concat([Buffer.from(header, 'utf8'), marker, body, endMarker]);
  fs.writeFileSync(path.join(dir, `${label}.md`), buffer);
}

let passed = 0;
let skipped = 0;

function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

function skip(name) {
  skipped += 1;
  process.stdout.write(`  - ${name} (git indisponível no PATH)\n`);
}

function runScript(cwd, args) {
  return spawnSync(process.execPath, [cliPath, '--cwd', cwd, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
}

function gitAvailable() {
  return spawnSync('git', ['--version'], { encoding: 'utf8', shell: false }).status === 0;
}

// R9 triage: gate cases below only exercise real behaviour when a git
// binary is on the PATH. Without one, silently skipping those cases would
// let the suite print "passed" having verified zero gate behaviour. The
// escape hatch has to be explicit — FORGE_ALLOW_NO_GIT=1 — and the process
// exit code has to say so when it is not set.
const ALLOW_NO_GIT = process.env.FORGE_ALLOW_NO_GIT === '1';
const GIT_OK = gitAvailable();
if (!GIT_OK) {
  if (ALLOW_NO_GIT) {
    process.stderr.write(
      'forge-sweep-project.test.js: git indisponível no PATH — FORGE_ALLOW_NO_GIT=1 setado, ' +
      'pulando explicitamente os casos de gate que exigem git real (opt-out deliberado).\n'
    );
  } else {
    process.stderr.write(
      'forge-sweep-project.test.js: git indisponível no PATH — os casos de gate NÃO seriam ' +
      'exercitados e a suíte passaria verde tendo verificado zero comportamento. Defina ' +
      'FORGE_ALLOW_NO_GIT=1 para pular explicitamente este ambiente sem git; sem essa variável, ' +
      'este é um erro de suíte (exit != 0).\n'
    );
    process.exitCode = 1;
  }
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(' ')} falhou`);
}

function treeSnapshot(root) {
  const rows = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        rows.push({ relative, kind: 'dir' });
        visit(full);
      } else {
        rows.push({ relative, kind: 'file', bytes: fs.readFileSync(full).toString('base64') });
      }
    }
  }
  visit(root);
  return rows.sort((a, b) => a.relative.localeCompare(b.relative));
}

function writeLedger(cwd, id, completedAt) {
  // forge-ledger owns the canonical fragment store at .gsd/ledger. Keeping
  // this fixture on that real path exercises epoch-group discovery instead of
  // accidentally testing an obsolete, unenumerated directory.
  const dir = path.join(cwd, '.gsd', 'ledger');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), [
    '---',
    `id: ${id}`,
    `completed_at: ${completedAt}`,
    '---',
    '',
    `fragmento ${id}`,
  ].join('\n'));
}

// The wrapper ids must produce a SEALED epoch, or the D11 gate reads as held
// while protecting nothing.  sealedEpochs() calls the highest epoch present
// "current", so one wrapper per root is never eligible however it is dated:
// each root needs an older wrapper plus a newer one to seal it.
const WRAPPER_IDS = Object.freeze({
  milestones: Object.freeze(['M-20250101000000-wrapper', 'M-20250401000000-wrapper']),
  tasks: Object.freeze(['T-20250101000000-wrapper', 'T-20250401000000-wrapper']),
});

function wrapperPaths(cwd, root) {
  return WRAPPER_IDS[root].map(id => path.join(cwd, '.gsd', root, id, 'PLAN.md'));
}

function writeWrappers(cwd) {
  for (const root of ['milestones', 'tasks']) {
    for (const file of wrapperPaths(cwd, root)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `wrapper ${path.basename(path.dirname(file))}\n`);
    }
  }
}

// A milestone/task wrapper's own embedded timestamp is creation time, not
// closure (forge-sweep-sealed.js closureDateInId narrowing) — a wrapper is
// only sealed with a real ledger entry (proof a) naming its id. Seeded
// already-grouped (not a loose `<id>.md`) so it proves closure for the
// wrapper WITHOUT also becoming its own standalone member of the ledger
// store's plan — plan() skips an already-grouped container outright ('já
// agrupado') instead of listing it as loose, so alpha/beta (the fixture's
// real ledger-store subjects) stay the only loose ledger members.
function seedWrapperLedgerProof(cwd, ids) {
  const dir = path.join(cwd, '.gsd', 'ledger');
  fs.mkdirSync(dir, { recursive: true });
  const units = ids.map(id => ({
    id,
    content: Buffer.from(['---', `id: ${id}`, 'completed_at: 2025-01-01T00:00:00Z', '---', '', `fragmento ${id}`].join('\n'), 'utf8'),
  }));
  const serialized = serializeGroup({ label: 'sweep-project-00', units });
  fs.writeFileSync(path.join(dir, 'seed-wrapper-closure-proof.md'), serialized.buffer);
}

function fixture(withVcs) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-project-'));
  writeLedger(cwd, 'M-20250101000000-alpha', '2025-01-01T00:00:00Z');
  writeLedger(cwd, 'M-20250401000000-beta', '2025-04-01T00:00:00Z');
  writeWrappers(cwd);
  seedWrapperLedgerProof(cwd, [...WRAPPER_IDS.milestones, ...WRAPPER_IDS.tasks]);
  if (withVcs) {
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.name', 'Forge Test']);
    git(cwd, ['config', 'user.email', 'forge@example.invalid']);
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-qm', 'fixture inicial']);
  }
  return cwd;
}

function cleanup(cwd) {
  fs.rmSync(cwd, { recursive: true, force: true });
}

function wrapperBytes(cwd) {
  const rows = [];
  for (const root of ['milestones', 'tasks']) {
    for (const file of wrapperPaths(cwd, root)) rows.push({ file, bytes: fs.readFileSync(file) });
  }
  return rows;
}

test('o registro contém apenas a operação número um', () => {
  const operations = buildRegistry().list();
  assert.strictEqual(operations.length, 1);
  assert.strictEqual(operations[0].name, 'agrupar-unidades-encerradas');
});

test('fonte não oferece porta para wrappers além do comentário D11', () => {
  const source = fs.readFileSync(cliPath, 'utf8');
  // Counting mentions passes if someone opens the opt-in AND deletes the D11
  // comment.  Ban the option being passed at all, comment or no comment.
  assert.doesNotMatch(source, /includeWrapperDirs\s*:/);
  assert.doesNotMatch(source, /process\.env|\.env\b|config(?:uration)?/i);
  assert.doesNotMatch(source, /--(?:wrapper|wrappers)/i);
});

test('argumentos inválidos retornam 2 e ajuda retorna 0', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-args-'));
  try {
    const invalid = runScript(cwd, ['--desconhecido']);
    assert.strictEqual(invalid.status, 2);
    const help = runScript(cwd, ['--help']);
    assert.strictEqual(help.status, 0);
    assert.match(help.stdout, /Uso:/);
  } finally { cleanup(cwd); }
});

test('--json --apply sem --yes é argumento inválido', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-json-'));
  try {
    const result = runScript(cwd, ['--json', '--apply']);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--json --apply exige --yes/);
    assert.strictEqual(result.stdout, '');
  } finally { cleanup(cwd); }
});

test('--list é exclusivo com --apply e com --undo', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-list-excl-'));
  try {
    const withApply = runScript(cwd, ['--list', '--apply']);
    assert.strictEqual(withApply.status, 2);
    assert.match(withApply.stderr, /--list é exclusivo com --apply/);
    const withUndo = runScript(cwd, ['--list', '--undo']);
    assert.strictEqual(withUndo.status, 2);
    assert.match(withUndo.stderr, /--list é exclusivo com --undo/);
  } finally { cleanup(cwd); }
});

test('--list sem containers retorna 0 e diz explicitamente que não há nenhum', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-list-empty-'));
  try {
    const result = runScript(cwd, ['--list']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /nenhum container de varredura encontrado/);
    const json = runScript(cwd, ['--list', '--json']);
    assert.strictEqual(json.status, 0, json.stderr);
    assert.deepStrictEqual(JSON.parse(json.stdout), { containers: [] });
  } finally { cleanup(cwd); }
});

test('--list mostra a faixa de um container de varredura e "faixa não registrada" para um legado, sem tocar a árvore nem exigir VCS', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-list-'));
  try {
    const ledgerDir = path.join(cwd, '.gsd', 'ledger');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const serialized = serializeGroup({
      label: 'sweep-project-07',
      dateRange: { from: '2026-06-09', to: '2026-08-04' },
      units: [{ id: 'M-20260609000000-alpha', content: Buffer.from('conteudo\n') }],
    });
    fs.writeFileSync(path.join(ledgerDir, 'sweep-project-07.md'), serialized.buffer);
    writeLegacyContainer(cwd, 'decisions', '2026-Q1', 'D-20260101000000-legado', 'conteudo legado\n');

    const before = treeSnapshot(cwd);
    const result = runScript(cwd, ['--list']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /sweep-project-07 \(2026-06-09 → 2026-08-04\)/);
    assert.match(result.stdout, /2026-Q1 \(faixa não registrada\)/);
    assert.deepStrictEqual(treeSnapshot(cwd), before, '--list é leitura pura: a árvore não pode mudar');

    const json = runScript(cwd, ['--list', '--json']);
    assert.strictEqual(json.status, 0, json.stderr);
    const payload = JSON.parse(json.stdout);
    const sweepRow = payload.containers.find(row => row.label === 'sweep-project-07');
    assert.strictEqual(sweepRow.store, 'ledger');
    assert.strictEqual(sweepRow.from, '2026-06-09');
    assert.strictEqual(sweepRow.to, '2026-08-04');
    assert.strictEqual(sweepRow.units, 1);
    const legacyRow = payload.containers.find(row => row.label === '2026-Q1');
    assert.strictEqual(legacyRow.store, 'decisions');
    assert.strictEqual(legacyRow.from, null);
    assert.strictEqual(legacyRow.to, null);
    assert.strictEqual(legacyRow.units, 1);
  } finally { cleanup(cwd); }
});

test('relatório de pulados nomeia a unidade e o motivo novo de sealedBy (chave local órfã sem prova de encerramento)', () => {
  const cwd = fixture(false);
  try {
    // DS9-4/B1: a bare local key ("S02", no `__<milestone>` prefix) is not
    // extinct by construction — it falls through sealedBy's three proofs and
    // is skipped, never grouped on a refuted premise.
    const memoryDir = path.join(cwd, '.gsd', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'S02.md'), '---\n---\n\nfragmento sem prova\n');
    const result = runScript(cwd, []);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /S02\.md — sem prova de encerramento — unidade pode receber escrita/);
  } finally { cleanup(cwd); }
});

test('sem VCS não aplica, informa a proteção e reporta zero elegíveis', () => {
  const cwd = fixture(false);
  try {
    const before = treeSnapshot(cwd);
    const result = runScript(cwd, ['--apply', '--yes']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /sem VCS — não há como desfazer/);
    assert.match(result.stdout, /0 elegíveis/);
    assert.deepStrictEqual(treeSnapshot(cwd), before);
  } finally { cleanup(cwd); }
});

test('sem VCS, --force aplica e informa que prosseguiu forçado', () => {
  const cwd = fixture(false);
  try {
    const result = runScript(cwd, ['--apply', '--yes', '--force']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /prosseguiu forçado/);
    assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', 'sweep-project-01.md')));
  } finally { cleanup(cwd); }
});

if (GIT_OK) {
  test('dry-run imprime prévia e pulados sem alterar bytes ou mtimes', () => {
    const cwd = fixture(true);
    try {
      const before = treeSnapshot(cwd);
      const mtimes = before.filter(row => row.kind === 'file').map(row => [row.relative, fs.statSync(path.join(cwd, row.relative)).mtimeMs]);
      const result = runScript(cwd, []);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /Prévia do sweep/);
      assert.match(result.stdout, /Pulados:/);
      assert.deepStrictEqual(treeSnapshot(cwd), before);
      for (const [relative, mtime] of mtimes) assert.strictEqual(fs.statSync(path.join(cwd, relative)).mtimeMs, mtime);
    } finally { cleanup(cwd); }
  });

  test('--apply sem --yes fora de TTY não escreve e mostra prévia antes da recusa', () => {
    const cwd = fixture(true);
    try {
      const before = treeSnapshot(cwd);
      const result = runScript(cwd, ['--apply']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert(result.stdout.indexOf('Prévia do sweep') < result.stdout.indexOf('aplicação não confirmada'));
      assert.deepStrictEqual(treeSnapshot(cwd), before);
    } finally { cleanup(cwd); }
  });

  test('--apply --yes escreve container, remove membros e imprime contagens', () => {
    const cwd = fixture(true);
    try {
      const result = runScript(cwd, ['--apply', '--yes']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', 'sweep-project-01.md')));
      assert(!fs.existsSync(path.join(cwd, '.gsd', 'ledger', 'M-20250101000000-alpha.md')));
      assert.match(result.stdout, /arquivos: \d+ → \d+/);
      assert.match(result.stdout, /pastas: \d+ → \d+/);
    } finally { cleanup(cwd); }
  });

  test('D11 protege wrappers em todas as invocações públicas', () => {
    const cwd = fixture(true);
    try {
      const original = wrapperBytes(cwd);
      for (const args of [[], ['--apply'], ['--apply', '--yes'], ['--apply', '--yes', '--force']]) {
        const result = runScript(cwd, args);
        assert.strictEqual(result.status, 0, result.stderr);
        for (const item of original) {
          assert(fs.existsSync(item.file), `invólucro desapareceu: ${item.file}`);
          assert.deepStrictEqual(fs.readFileSync(item.file), item.bytes);
        }
      }
      const preview = buildRegistry().preview({ cwd });
      assert(!preview.operations[0].targets.some(target => /-wrappers$/.test(target.store)));
      // Non-vacuity: the same fixture DOES yield wrapper targets once the
      // opt-in is passed, so the assertions above measure the closed gate.
      const openedUp = epochGroup.plan(cwd, { includeWrapperDirs: true });
      assert(openedUp.targets.some(target => target.store === 'milestone-wrappers'),
        'fixture vácua: o opt-in não produz alvo de invólucro');
    } finally { cleanup(cwd); }
  });

  // R16 triage: with D11 closed, wrapper dirs used to vanish from the report
  // entirely — no trace the gate ever ran. Both dry-run and --json must now
  // carry an informative "protected" line naming a non-zero count (this
  // fixture seeds 4 wrapper dirs via writeWrappers), and the gate must stay
  // closed (still zero wrapper targets/stores in the plan).
  test('R16: invólucros protegidos aparecem no relatório com o gate D11 fechado', () => {
    const cwd = fixture(true);
    try {
      const dry = runScript(cwd, []);
      assert.strictEqual(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /4 invólucro\(s\) protegido\(s\)/);
      assert.match(dry.stdout, /gate D11 fechado/);

      const jsonResult = runScript(cwd, ['--json']);
      assert.strictEqual(jsonResult.status, 0, jsonResult.stderr);
      const payload = JSON.parse(jsonResult.stdout);
      assert(payload.messages.some(line => /4 invólucro\(s\) protegido\(s\)/.test(line)));

      // Non-vacuity + gate-still-closed: the same run must not have produced
      // any wrapper target/store, proving the line is reporting, not opening.
      assert(!payload.preview.operations[0].targets.some(target => /-wrappers$/.test(target.store)));
    } finally { cleanup(cwd); }
  });
} else {
  skip('casos com repositório Git real');
}

// ── T04: journal wiring on the apply path (S08 B2 / DS8-3) ─────────────────

function journalFile(cwd) {
  return path.join(cwd, '.gsd', 'forge', 'sweep-journal.jsonl');
}

function readJournalEntries(cwd) {
  const raw = fs.readFileSync(journalFile(cwd), 'utf8');
  return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// R3 fixture: `.gsd/` is committed to the repo as ignored (via .gitignore),
// so the ledger fragments read as `ignorado pelo VCS` — the exact class T03
// promotes to `basis: 'tool-undo'`. The wrapper pair still needs a sealed
// (older) and a current (newer) epoch, same rule as `fixture()`.
function fixtureIgnoredGsd() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-project-r3-'));
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.name', 'Forge Test']);
  git(cwd, ['config', 'user.email', 'forge@example.invalid']);
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.gsd/\n');
  fs.writeFileSync(path.join(cwd, 'README.md'), 'fixture\n');
  git(cwd, ['add', '.gitignore', 'README.md']);
  git(cwd, ['commit', '-qm', 'fixture inicial']);
  writeLedger(cwd, 'M-20250101000000-alpha', '2025-01-01T00:00:00Z');
  writeLedger(cwd, 'M-20250401000000-beta', '2025-04-01T00:00:00Z');
  return cwd;
}

// Same fragments, but `.gsd/` is committed and clean — the target classifies
// as tracked-clean, not ignored, so the accepted basis is 'vcs' rather than
// 'tool-undo' (DS8-3's "warn, don't refuse" branch).
function fixtureTrackedGsd() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-project-vcs-'));
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.name', 'Forge Test']);
  git(cwd, ['config', 'user.email', 'forge@example.invalid']);
  writeLedger(cwd, 'M-20250101000000-alpha', '2025-01-01T00:00:00Z');
  writeLedger(cwd, 'M-20250401000000-beta', '2025-04-01T00:00:00Z');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-qm', 'fixture inicial']);
  return cwd;
}

// The T02 lever: `.gsd/forge` pre-created as a plain FILE makes every probe/
// append against the journal fail with the exact same error, for the whole
// life of the process — see forge-sweep-journal.test.js scenario (b).
function blockJournal(cwd) {
  fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.gsd', 'forge'), 'não é um diretório');
}

if (GIT_OK) {
  test('R3: dry-run nomeia o basis tool-undo e --apply --yes sem --force escreve o container', () => {
    const cwd = fixtureIgnoredGsd();
    try {
      const dry = runScript(cwd, []);
      assert.strictEqual(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /elegível por undo de ferramenta/);

      const apply = runScript(cwd, ['--apply', '--yes']);
      assert.strictEqual(apply.status, 0, apply.stderr);
      assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', 'sweep-project-01.md')));
      assert(!fs.existsSync(path.join(cwd, '.gsd', 'ledger', 'M-20250101000000-alpha.md')));

      const entries = readJournalEntries(cwd);
      const phases = entries.map(entry => entry.phase);
      assert.deepStrictEqual(phases, ['apply-intent', 'apply-done']);
      for (const entry of entries) {
        assert.deepStrictEqual(entry.containers, ['.gsd/ledger/sweep-project-01.md']);
      }
      assert(entries[1].sha256 && typeof entries[1].sha256['.gsd/ledger/sweep-project-01.md'] === 'string');
      assert.strictEqual(entries[1].sha256['.gsd/ledger/sweep-project-01.md'].length, 64);
    } finally { cleanup(cwd); }
  });

  test('B2: journal bloqueado com alvo tool-undo recusa a aplicação inteira sem mutar o store', () => {
    const cwd = fixtureIgnoredGsd();
    try {
      blockJournal(cwd);
      const before = treeSnapshot(path.join(cwd, '.gsd', 'ledger'));
      const apply = runScript(cwd, ['--apply', '--yes']);
      assert.strictEqual(apply.status, 1);
      assert.match(apply.stdout + apply.stderr, /registro de undo indisponível/);
      const after = treeSnapshot(path.join(cwd, '.gsd', 'ledger'));
      assert.deepStrictEqual(after, before, 'zero mutação: a árvore do store precisa ficar byte-idêntica');
      assert(!fs.existsSync(path.join(cwd, '.gsd', 'ledger', 'sweep-project-01.md')));
    } finally { cleanup(cwd); }
  });

  test('DS8-3: .gsd/ commitado e limpo (basis vcs) com journal bloqueado prossegue com warn', () => {
    const cwd = fixtureTrackedGsd();
    try {
      blockJournal(cwd);
      const apply = runScript(cwd, ['--apply', '--yes']);
      assert.strictEqual(apply.status, 0, apply.stderr);
      assert.match(apply.stderr, /registro de undo indisponível/);
      assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', 'sweep-project-01.md')));
    } finally { cleanup(cwd); }
  });

  test('--json --apply --yes no fixture R3 emite um único documento JSON com journal.recorded true', () => {
    const cwd = fixtureIgnoredGsd();
    try {
      const apply = runScript(cwd, ['--json', '--apply', '--yes']);
      assert.strictEqual(apply.status, 0, apply.stderr);
      const payload = JSON.parse(apply.stdout);
      assert.strictEqual(payload.applied, true);
      assert.strictEqual(payload.journal.recorded, true);
      assert.strictEqual(typeof payload.journal.id, 'string');
    } finally { cleanup(cwd); }
  });
} else {
  skip('casos de journal com repositório Git real (B2/DS8-3/R3)');
}

// ── T05: --undo CLI + demo ponta-a-ponta do ROADMAP ─────────────────────────

// The demo compares the fragment STORES, not the journal itself (the journal
// is new operational data this milestone introduced) — walk only the store
// roots forge-epoch-group knows about, mirroring must-have #1's wording.
function storeTreeSnapshot(cwd) {
  const roots = ['ledger', 'decisions', 'memory', 'milestones', 'tasks'];
  const rows = [];
  for (const root of roots) {
    const dir = path.join(cwd, '.gsd', root);
    if (!fs.existsSync(dir)) continue;
    for (const row of treeSnapshot(dir)) rows.push({ relative: `${root}/${row.relative}`, kind: row.kind, bytes: row.bytes });
  }
  return rows.sort((a, b) => a.relative.localeCompare(b.relative));
}

if (GIT_OK) {
  test('DEMO ROADMAP S08: aplica sem --force num .gsd/ ignorado e --undo produz árvore byte-idêntica', () => {
    const cwd = fixtureIgnoredGsd();
    try {
      const before = storeTreeSnapshot(cwd);
      const apply = runScript(cwd, ['--apply', '--yes']);
      assert.strictEqual(apply.status, 0, apply.stderr);
      assert.doesNotMatch(apply.stdout + apply.stderr, /--force/);
      assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', 'sweep-project-01.md')));

      const undo = runScript(cwd, ['--undo', '--yes']);
      assert.strictEqual(undo.status, 0, undo.stderr);
      const after = storeTreeSnapshot(cwd);
      assert.deepStrictEqual(after, before, 'árvore dos stores precisa voltar byte-idêntica à pré-aplicação');
      assert(!fs.existsSync(path.join(cwd, '.gsd', 'ledger', 'sweep-project-01.md')));

      const entries = readJournalEntries(cwd);
      assert.deepStrictEqual(entries.map(e => e.phase), ['apply-intent', 'apply-done', 'undo-done']);
    } finally { cleanup(cwd); }
  });

  test('--undo tem preview + confirmação: fora de TTY sem --yes não desfaz; --json --undo exige --yes', () => {
    const cwd = fixtureIgnoredGsd();
    try {
      runScript(cwd, ['--apply', '--yes']);
      const before = fs.readFileSync(path.join(cwd, '.gsd', 'ledger', 'sweep-project-01.md'));

      const noTty = runScript(cwd, ['--undo']);
      assert.strictEqual(noTty.status, 0, noTty.stderr);
      assert.match(noTty.stdout, /desfazer não confirmado fora de TTY/);
      assert.deepStrictEqual(fs.readFileSync(path.join(cwd, '.gsd', 'ledger', 'sweep-project-01.md')), before);

      const jsonNoYes = runScript(cwd, ['--json', '--undo']);
      assert.strictEqual(jsonNoYes.status, 2);
      assert.match(jsonNoYes.stderr, /--json --undo exige --yes/);

      const jsonUndo = runScript(cwd, ['--json', '--undo', '--yes']);
      assert.strictEqual(jsonUndo.status, 0, jsonUndo.stderr);
      const payload = JSON.parse(jsonUndo.stdout);
      assert.strictEqual(typeof payload.undo.journalId, 'string');
      assert(payload.undo.restored.length > 0);
    } finally { cleanup(cwd); }
  });

  test('B1: undo parcial é recuperável — loose conflitante nomeado, container sobrevive, retry completa', () => {
    const cwd = fixtureIgnoredGsd();
    try {
      runScript(cwd, ['--apply', '--yes']);
      const memberPath = path.join(cwd, '.gsd', 'ledger', 'M-20250101000000-alpha.md');
      fs.writeFileSync(memberPath, 'conflito\n');

      const first = runScript(cwd, ['--undo', '--yes']);
      assert.strictEqual(first.status, 1);
      assert.match(first.stdout + first.stderr, /M-20250101000000-alpha\.md/);
      assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', 'sweep-project-01.md')), 'container precisa sobreviver ao undo parcial');

      fs.unlinkSync(memberPath);
      const second = runScript(cwd, ['--undo', '--yes']);
      assert.strictEqual(second.status, 0, second.stderr);
      assert(!fs.existsSync(path.join(cwd, '.gsd', 'ledger', 'sweep-project-01.md')));
      assert(fs.existsSync(memberPath));
    } finally { cleanup(cwd); }
  });

  test('journal vazio/sem registro desfazível: "nada para desfazer", exit 0', () => {
    const cwd = fixtureIgnoredGsd();
    try {
      const result = runScript(cwd, ['--undo', '--yes']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, /nada para desfazer/);
    } finally { cleanup(cwd); }
  });

  test('após undo bem-sucedido, novo --undo diz "nada para desfazer" (registro anterior não é re-desfazível)', () => {
    const cwd = fixtureIgnoredGsd();
    try {
      runScript(cwd, ['--apply', '--yes']);
      const undo = runScript(cwd, ['--undo', '--yes']);
      assert.strictEqual(undo.status, 0, undo.stderr);
      const again = runScript(cwd, ['--undo', '--yes']);
      assert.strictEqual(again.status, 0, again.stderr);
      assert.match(again.stdout, /nada para desfazer/);
    } finally { cleanup(cwd); }
  });

  test('--undo é mutuamente exclusivo com --apply e --force (exit 2 com uso)', () => {
    const cwd = fixtureIgnoredGsd();
    try {
      const withApply = runScript(cwd, ['--undo', '--apply']);
      assert.strictEqual(withApply.status, 2);
      assert.match(withApply.stderr, /--undo é exclusivo com --apply/);
      assert.match(withApply.stderr, /Uso:/);
      const withForce = runScript(cwd, ['--undo', '--force']);
      assert.strictEqual(withForce.status, 2);
      assert.match(withForce.stderr, /--undo é exclusivo com --force/);
    } finally { cleanup(cwd); }
  });
} else {
  skip('casos de --undo com repositório Git real');
}

test('regressão: sem VCS a recusa não toca o journal (herdada 7 travada)', () => {
  const cwd = fixture(false);
  try {
    const result = runScript(cwd, ['--apply', '--yes']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /sem VCS — não há como desfazer/);
    assert(!fs.existsSync(journalFile(cwd)), 'nenhum journal deveria existir quando 0 alvos são aceitos');
  } finally { cleanup(cwd); }
});

test('regressão: sem VCS, --force ainda é exigido e aplica normalmente (journal aditivo, não observado no contrato)', () => {
  const cwd = fixture(false);
  try {
    const result = runScript(cwd, ['--apply', '--yes', '--force']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /prosseguiu forçado/);
    assert(fs.existsSync(path.join(cwd, '.gsd', 'ledger', 'sweep-project-01.md')));
  } finally { cleanup(cwd); }
});

async function testOutcomeAppendFailureKeepsJournalRecordedTruthful() {
  // R2 regression: appendOutcome(apply-done) failing must not leave
  // journal.recorded === true off a bare intent id (forge-sweep-project.js
  // ~line 481-492). Mocks the journal seam directly (in-process, same
  // pattern as testVcsQueryFailureExitsOne) since spawnSync fixtures can't
  // inject a mid-run write failure timed after the intent but before the
  // outcome append.
  if (!GIT_OK) {
    skipped += 1;
    process.stdout.write('  - falha ao gravar outcome (apply-done) mantém journal.recorded truthful (git indisponível no PATH)\n');
    return;
  }
  const journalSeam = require('./forge-sweep-journal');
  const { main } = require('./forge-sweep-project');
  const cwd = fixtureIgnoredGsd();
  const realAppendOutcome = journalSeam.appendOutcome;
  const stdoutWrite = process.stdout.write;
  let capturedOut = '';
  try {
    journalSeam.appendOutcome = (targetCwd, opts) => {
      if (opts && opts.phase === 'apply-done') {
        return { ok: false, error: 'disco cheio (simulado)' };
      }
      return realAppendOutcome(targetCwd, opts);
    };
    process.stdout.write = chunk => { capturedOut += chunk; return true; };
    const code = await main(['--cwd', cwd, '--json', '--apply', '--yes']);
    process.stdout.write = stdoutWrite;
    assert.strictEqual(code, 0, 'apply-done outcome failure is advisory-only and must not affect exit code');
    const payload = JSON.parse(capturedOut);
    assert.strictEqual(payload.applied, true, 'the mutation itself still succeeded');
    assert.strictEqual(typeof payload.journal.id, 'string', 'an intent id was still minted');
    assert.strictEqual(
      payload.journal.recorded, false,
      'journal.recorded must go false when the apply-done outcome append fails — the id alone is not proof undo is discoverable'
    );

    // Confirm undo is STILL discoverable through the surviving intent —
    // this is the R2 fix in forge-sweep-journal.js's latestUndoable, not a
    // second bug. The truthful envelope above and a working --undo below
    // are two halves of the same fix and must both hold.
    const listed = journalSeam.listEntries(cwd);
    assert.strictEqual(listed.ok, true);
    const phases = listed.entries.map(e => e.phase);
    assert.deepStrictEqual(phases, ['apply-intent'], 'only the intent should have landed — outcome append was made to fail');
    const undoable = journalSeam.latestUndoable(cwd);
    assert.strictEqual(undoable.ok, true);
    assert(undoable.entry !== null, 'the intent-only record must still resolve as undoable (R2 fallback)');
    assert.strictEqual(undoable.entry.id, payload.journal.id);

    passed += 1;
    process.stdout.write('  ✓ falha ao gravar outcome (apply-done) mantém journal.recorded truthful e undo ainda descobrível via intent\n');
  } finally {
    process.stdout.write = stdoutWrite;
    journalSeam.appendOutcome = realAppendOutcome;
    cleanup(cwd);
  }
}

async function testVcsQueryFailureExitsOne() {
  // Runs in-process because the failure must be injected into the same seam
  // the CLI consumes.  Asserting exit 1 here is what a rename of the refusal
  // sentence would break, back when the code matched that string literally.
  const vcsSeam = require('./forge-vcs');
  const { main } = require('./forge-sweep-project');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-vcsfail-'));
  writeLedger(cwd, 'M-20250101000000-alpha', '2025-01-01T00:00:00Z');
  writeLedger(cwd, 'M-20250401000000-beta', '2025-04-01T00:00:00Z');
  const realDetect = vcsSeam.detectVcs;
  const realStatus = vcsSeam.workingStatus;
  const stdoutWrite = process.stdout.write;
  try {
    vcsSeam.detectVcs = () => 'git';
    vcsSeam.workingStatus = () => ({ vcs: 'git', ok: false, entries: [], error: 'status indisponível' });
    process.stdout.write = () => true;
    const code = await main(['--cwd', cwd]);
    process.stdout.write = stdoutWrite;
    assert.strictEqual(code, 1, 'falha de consulta ao VCS precisa sair com 1');
    passed += 1;
    process.stdout.write('  ✓ falha ao consultar o VCS sai com código 1\n');
  } finally {
    process.stdout.write = stdoutWrite;
    vcsSeam.detectVcs = realDetect;
    vcsSeam.workingStatus = realStatus;
    cleanup(cwd);
  }
}

async function testListSurfacesUnreadableContainers() {
  // Runs in-process (not via spawnSync) because the failure has to be
  // injected into the exact fs.readFileSync call collectContainers makes —
  // chmod does not reliably produce an unreadable file cross-platform
  // (Windows only toggles the read-only attribute), so the seam is stubbed
  // instead, mirroring testOutcomeAppendFailureKeepsJournalRecordedTruthful
  // above. Covers a sweep-numbered container AND a legacy epoch-shaped one —
  // review R2 requires isGroupedFile's name-only branch to catch both.
  const { main } = require('./forge-sweep-project');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-list-unreadable-'));
  const ledgerDir = path.join(cwd, '.gsd', 'ledger');
  const decisionsDir = path.join(cwd, '.gsd', 'decisions');
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.mkdirSync(decisionsDir, { recursive: true });
  const serialized = serializeGroup({
    label: 'sweep-project-09',
    dateRange: { from: '2026-06-09', to: '2026-08-04' },
    units: [{ id: 'M-20260609000000-alpha', content: Buffer.from('conteudo\n') }],
  });
  const unreadableSweepPath = path.join(ledgerDir, 'sweep-project-09.md');
  fs.writeFileSync(unreadableSweepPath, serialized.buffer);
  writeLegacyContainer(cwd, 'decisions', '2026-Q2', 'D-20260401000000-legado', 'conteudo legado\n');
  const unreadableLegacyPath = path.join(decisionsDir, '2026-Q2.md');
  // A readable, well-formed container in the mix confirms the stub only
  // breaks the two targeted files — everything else still lists normally.
  const okSerialized = serializeGroup({
    label: 'sweep-project-10',
    dateRange: { from: '2026-05-01', to: '2026-05-02' },
    units: [{ id: 'M-20260501000000-gamma', content: Buffer.from('ok\n') }],
  });
  fs.writeFileSync(path.join(ledgerDir, 'sweep-project-10.md'), okSerialized.buffer);

  const realReadFileSync = fs.readFileSync;
  const stdoutWrite = process.stdout.write;
  let capturedOut = '';
  try {
    fs.readFileSync = function stubbedReadFileSync(target, ...rest) {
      if (target === unreadableSweepPath || target === unreadableLegacyPath) {
        const error = new Error(`EACCES: permission denied, open '${target}' (simulado)`);
        error.code = 'EACCES';
        throw error;
      }
      return realReadFileSync.call(fs, target, ...rest);
    };

    process.stdout.write = chunk => { capturedOut += chunk; return true; };
    const textCode = await main(['--cwd', cwd, '--list']);
    process.stdout.write = stdoutWrite;
    assert.strictEqual(textCode, 0, '--list must not fail the process on an unreadable container');
    assert.match(capturedOut, /ledger: sweep-project-09 — erro: container-unreadable — unidades não listadas/);
    assert.match(capturedOut, /decisions: 2026-Q2 — erro: container-unreadable — unidades não listadas/);
    assert.match(capturedOut, /sweep-project-10 \(2026-05-01 → 2026-05-02\)/);

    capturedOut = '';
    process.stdout.write = chunk => { capturedOut += chunk; return true; };
    const jsonCode = await main(['--cwd', cwd, '--list', '--json']);
    process.stdout.write = stdoutWrite;
    assert.strictEqual(jsonCode, 0);
    const payload = JSON.parse(capturedOut);
    const sweepRow = payload.containers.find(row => row.name === 'sweep-project-09.md');
    assert.strictEqual(sweepRow.error, 'container-unreadable');
    assert.strictEqual(sweepRow.units, null);
    const legacyRow = payload.containers.find(row => row.name === '2026-Q2.md');
    assert.strictEqual(legacyRow.error, 'container-unreadable');
    assert.strictEqual(legacyRow.units, null);
    const okRow = payload.containers.find(row => row.name === 'sweep-project-10.md');
    assert.strictEqual(okRow.error, undefined);
    assert.strictEqual(okRow.units, 1);

    passed += 1;
    process.stdout.write('  ✓ --list surfaces an unreadable sweep container AND an unreadable legacy epoch container, in text and JSON\n');
  } finally {
    process.stdout.write = stdoutWrite;
    fs.readFileSync = realReadFileSync;
    cleanup(cwd);
  }
}

testOutcomeAppendFailureKeepsJournalRecordedTruthful()
  .then(() => testVcsQueryFailureExitsOne())
  .then(() => testListSurfacesUnreadableContainers())
  .then(() => {
    process.stdout.write(`forge-sweep-project: ${passed} passed, ${skipped} skipped\n`);
    if (!GIT_OK) {
      process.stdout.write(`forge-sweep-project: git gate ${ALLOW_NO_GIT ? 'opted out (FORGE_ALLOW_NO_GIT=1)' : 'FAILED — set FORGE_ALLOW_NO_GIT=1 to opt out explicitly'}\n`);
    }
  }).catch(error => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
