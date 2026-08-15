#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ledger = require('./forge-ledger');
const memory = require('./forge-memory');
const { checkClosure, renderClosureSection, _private } = require('./forge-wrapper-closure');

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function run() {
  for (const { name, fn } of tests) {
    try {
      fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`      ${error.stack || error.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

function withTemp(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-wrapper-closure-test-'));
  try {
    return fn(cwd);
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
}

function writeLedger(cwd, unitId) {
  ledger.writeFragment(cwd, {
    id: unitId,
    title: 'Fixture milestone',
    completed_at: '2026-08-15T00:00:00Z',
    slices: ['S01'],
    key_files: ['scripts/forge-wrapper-closure.js'],
    key_decisions: ['Fixture decision'],
    body: 'Fixture body.',
  });
}

function writeMemory(cwd, unitId, facts) {
  memory.writeFragment(cwd, { unit_id: unitId, facts });
}

// buildFileIndex only surfaces a fact in the unit axis when its text carries
// at least one resolvable file citation (facts.push is skipped for
// citation-less facts — measured directly against forge-memory-index.js).
// A cited fixture fact needs the cited file to actually exist under cwd for
// resolveCitation to reach RESOLVED — see writeCitedFile below.
const CITED_REL_PATH = 'scripts/fixture-cited-file.js';

function writeCitedFile(cwd) {
  const abs = path.join(cwd, ...CITED_REL_PATH.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '// fixture file cited by a DST- fact for index resolution\n', 'utf8');
}

function dstFact(id) {
  return {
    mem_id: `DST-${id}`,
    category: 'gotcha',
    text: `Fixture distilled fact text citing \`${CITED_REL_PATH}\` for index resolution.`,
    created_at: '2026-08-15',
    source_unit: 'distill/fixture',
  };
}

function memFact(id) {
  return {
    mem_id: `MEM${id}`,
    category: 'gotcha',
    text: 'Fixture non-distilled fact text.',
    created_at: '2026-08-15',
    source_unit: 'fixture-unit',
  };
}

function writeKnowledge(cwd, body) {
  fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.gsd', 'KNOWLEDGE.md'), body, 'utf8');
}

// ── 1. Four green layers ─────────────────────────────────────────────────────
test('checkClosure: 4/4 layers green when ledger + DST fact + KNOWLEDGE ref all present', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-green';
    writeLedger(cwd, unitId);
    writeCitedFile(cwd);
    writeMemory(cwd, unitId, [dstFact('aaaaaaaaaaaa')]);
    writeKnowledge(cwd, `# KNOWLEDGE\n\nSee ${unitId} for context.\n`);

    const result = checkClosure(cwd, unitId);
    assert.strictEqual(result.ok, true, 'overall ok should be true');
    assert.strictEqual(result.layers.ledger.outcome, 'ok');
    assert.strictEqual(result.layers.distilled.outcome, 'ok');
    assert.strictEqual(result.layers.distilled.dst_count, 1);
    assert.strictEqual(result.layers.index.outcome, 'ok');
    assert.ok(result.layers.index.facts_count >= 1);
    assert.strictEqual(result.layers.knowledge.outcome, 'ok');
    assert.strictEqual(result.layers.knowledge.refs.length, 1);
    assert.strictEqual(result.layers.knowledge.refs[0].line, 3);
    assert.deepStrictEqual(result.reasons, []);
  });
});

// ── 2. not-distilled — only MEM### facts, no DST- prefix ────────────────────
test('checkClosure: distilled.ok=false with reason not-distilled when no DST- fact exists', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-nodst';
    writeLedger(cwd, unitId);
    writeMemory(cwd, unitId, [memFact('001')]);

    const result = checkClosure(cwd, unitId);
    assert.strictEqual(result.layers.distilled.outcome, 'fail');
    assert.strictEqual(result.layers.distilled.reason, 'not-distilled');
    assert.strictEqual(result.layers.distilled.dst_count, 0);
    assert.strictEqual(result.ok, false, 'ok must be false — destilação never presumed');
    assert.ok(result.reasons.some((r) => r.startsWith('distilled:')));
  });
});

// ── 3. no-ledger-entry ───────────────────────────────────────────────────────
test('checkClosure: ledger.outcome=fail with reason no-ledger-entry when LEDGER fragment absent', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-noledger';
    writeMemory(cwd, unitId, [dstFact('bbbbbbbbbbbb')]);

    const result = checkClosure(cwd, unitId);
    assert.strictEqual(result.layers.ledger.outcome, 'fail');
    assert.strictEqual(result.layers.ledger.reason, 'no-ledger-entry');
    assert.strictEqual(result.ok, false);
  });
});

// ── 4. not-in-index + fragment-missing (unit entirely absent from the store) ─
test('checkClosure: distilled fragment-missing AND index not-in-index when unit has no memory fragment at all', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-absent';
    writeLedger(cwd, unitId);
    // No memory fragment written for this unit at all.

    const result = checkClosure(cwd, unitId);
    assert.strictEqual(result.layers.distilled.outcome, 'fail');
    assert.strictEqual(result.layers.distilled.reason, 'not-distilled');
    assert.strictEqual(result.layers.distilled.note, 'fragment-missing');
    assert.strictEqual(result.layers.index.outcome, 'fail');
    assert.strictEqual(result.layers.index.reason, 'not-in-index');
    assert.strictEqual(result.ok, false);
  });
});

// ── 5. KNOWLEDGE refs enumerated WITHOUT derailing ok when 1–3 pass ──────────
test('checkClosure: KNOWLEDGE refs present never flip ok when layers 1-3 pass (layer 4 is informative only)', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-refsok';
    writeLedger(cwd, unitId);
    writeCitedFile(cwd);
    writeMemory(cwd, unitId, [dstFact('cccccccccccc')]);
    // Multiple KNOWLEDGE refs, including a path-shaped one.
    writeKnowledge(
      cwd,
      `# KNOWLEDGE\n\nline about ${unitId}\nanother line mentioning .gsd/milestones/${unitId}/ROADMAP.md\nunrelated line\n`
    );

    const result = checkClosure(cwd, unitId);
    assert.strictEqual(result.layers.knowledge.refs.length, 2);
    assert.strictEqual(result.ok, true, 'refs found in KNOWLEDGE must never derail ok when 1-3 are green');
  });
});

// ── 6. Section always emitted — clean case ───────────────────────────────────
test('renderClosureSection: emits the section heading on the fully-clean case (4/4 layers)', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-rendergreen';
    writeLedger(cwd, unitId);
    writeCitedFile(cwd);
    writeMemory(cwd, unitId, [dstFact('dddddddddddd')]);
    writeKnowledge(cwd, `See ${unitId}.\n`);

    const result = checkClosure(cwd, unitId);
    const md = renderClosureSection(result);
    assert.ok(md.startsWith('## Fechamento em 4 camadas'), 'section heading must be present');
    assert.ok(md.includes('FECHADO'), 'clean case should render FECHADO verdict');
    assert.ok(md.includes('LEDGER: ok'));
    assert.ok(md.includes('DISTILLED: ok'));
    assert.ok(md.includes('INDEX: ok'));
    assert.ok(md.includes('KNOWLEDGE: ok'));
  });
});

// ── 7. Section always emitted — failing case ─────────────────────────────────
test('renderClosureSection: emits the section heading even when layers fail (never by narration)', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-renderfail';
    // Nothing written at all — every measurable layer should fail/unavailable.

    const result = checkClosure(cwd, unitId);
    const md = renderClosureSection(result);
    assert.ok(md.startsWith('## Fechamento em 4 camadas'), 'section heading must be present even on failure');
    assert.ok(md.includes('ABERTO'), 'failing case should render ABERTO verdict');
    assert.ok(md.includes('no-ledger-entry'));
    assert.ok(md.includes('nenhuma'), 'no KNOWLEDGE.md refs to report should say nenhuma, not omit the line');
  });
});

// ── 8. unavailable — invalid unit id makes the LEDGER layer throw ───────────
test('checkClosure: ledger.outcome=unavailable when the underlying read throws (invalid id)', () => {
  withTemp((cwd) => {
    const result = checkClosure(cwd, 'not-a-valid-forge-id');
    assert.strictEqual(result.layers.ledger.outcome, 'unavailable');
    assert.strictEqual(result.layers.ledger.reason, 'unreadable');
    assert.ok(typeof result.layers.ledger.note === 'string' && result.layers.ledger.note.length > 0);
    assert.strictEqual(result.ok, false);
  });
});

// ── 9. unavailable — KNOWLEDGE.md absent reports its own outcome ────────────
test('checkClosure: knowledge.outcome=unavailable (not "ok" with empty refs) when KNOWLEDGE.md is absent', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-noknowledge';
    writeLedger(cwd, unitId);
    writeCitedFile(cwd);
    writeMemory(cwd, unitId, [dstFact('eeeeeeeeeeee')]);
    // No .gsd/KNOWLEDGE.md written at all.

    const result = checkClosure(cwd, unitId);
    assert.strictEqual(result.layers.knowledge.outcome, 'unavailable');
    assert.strictEqual(result.layers.knowledge.reason, 'knowledge-file-absent');
    assert.deepStrictEqual(result.layers.knowledge.refs, []);
    // Layer 4 never decides ok — layers 1-3 are green here.
    assert.strictEqual(result.ok, true);
  });
});

// ── 10. EOL normalization on KNOWLEDGE.md read funnel ────────────────────────
test('checkClosure: KNOWLEDGE.md refs are located correctly under CRLF line endings', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-crlf';
    writeLedger(cwd, unitId);
    writeMemory(cwd, unitId, [dstFact('ffffffffffff')]);
    fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.gsd', 'KNOWLEDGE.md'),
      `# KNOWLEDGE\r\n\r\nline mentioning ${unitId}\r\nunrelated\r\n`,
      'utf8'
    );

    const result = checkClosure(cwd, unitId);
    assert.strictEqual(result.layers.knowledge.refs.length, 1);
    assert.strictEqual(result.layers.knowledge.refs[0].line, 3);
  });
});

// ── 11. _private helper exports exist for future reuse ───────────────────────
test('_private exports the per-layer helpers and knowledgeRefPatterns', () => {
  assert.strictEqual(typeof _private.checkLedger, 'function');
  assert.strictEqual(typeof _private.checkDistilled, 'function');
  assert.strictEqual(typeof _private.checkIndex, 'function');
  assert.strictEqual(typeof _private.checkKnowledge, 'function');
  const patterns = _private.knowledgeRefPatterns('M-20260101000000-x');
  assert.ok(patterns.includes('M-20260101000000-x'));
  assert.ok(patterns.some((p) => p.includes('.gsd/milestones/M-20260101000000-x/')));
});

run();
