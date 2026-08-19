#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ledger = require('./forge-ledger');
const memory = require('./forge-memory');
const groupedFile = require('./forge-grouped-file');
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
  return memory.writeFragment(cwd, { unit_id: unitId, facts });
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

// Writes a fact to the loose store, then moves it into a grouped container so
// the unit has NO loose file left — the only shape that exercises the
// grouped-aware read funnel (readFragmentText/parseFragment) instead of the
// loose-file shortcut. Mirrors the real shape produced by forge-sweep-project:
// bytes come from an actual writeFragment() call, never hand-assembled.
function groupIntoContainer(cwd, unitId, facts, containerName) {
  writeMemory(cwd, unitId, facts);
  const fpath = memory.fragmentPath(cwd, unitId);
  const content = fs.readFileSync(fpath);
  fs.unlinkSync(fpath);
  const storageKey = memory.qualifiedStorageKey(unitId);
  const { buffer } = groupedFile.serializeGroup({
    label: 'sweep-project-01',
    dateRange: { from: '2026-08-01', to: '2026-08-15' },
    units: [{ id: storageKey, content }],
  });
  const containerPath = path.join(memory.memoryDir(cwd), `${containerName}.md`);
  fs.mkdirSync(path.dirname(containerPath), { recursive: true });
  fs.writeFileSync(containerPath, buffer);
  return containerPath;
}

// A fact with NO resolvable file citation — buildFileIndex only pushes a fact
// into the unit axis when its text carries a citation that resolves under
// cwd, so this fact is invisible to the file-index path by construction and
// only reachable through the store fallback.
function uncitedFact(id) {
  return {
    mem_id: `MEM${id}`,
    category: 'gotcha',
    text: 'Fixture fact with no file citation at all — store-only signal.',
    created_at: '2026-08-15',
    source_unit: 'fixture-unit',
  };
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

// ── 12. Layer 3 outcome: file-index (control — old path stays intact) ───────
test('checkIndex outcome=file-index: cited fact preserves the old success path with source: file-index', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-idx-fileindex';
    writeCitedFile(cwd);
    writeMemory(cwd, unitId, [dstFact('gggggggggggg')]);

    const result = _private.checkIndex(cwd, unitId);
    assert.strictEqual(result.outcome, 'ok');
    assert.strictEqual(result.source, 'file-index');
    assert.ok(result.facts_count >= 1);
  });
});

// ── 13. Layer 3 outcome: store (citation-less fact, the new behavior) ───────
test('checkIndex outcome=store: citation-less fact falls back to the memory store with note no-file-citations', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-idx-store';
    // No cited file, no DST- fact — the only signal is a plain grouped fact
    // in the store, unreachable by the live file-index path.
    groupIntoContainer(cwd, unitId, [uncitedFact('001')], 'sweep-project-01');

    const result = _private.checkIndex(cwd, unitId);
    assert.strictEqual(result.outcome, 'ok');
    assert.strictEqual(result.source, 'store');
    assert.strictEqual(result.note, 'no-file-citations');
    assert.strictEqual(result.facts_count, 1);
  });
});

// ── 14. Layer 3 outcome: not-in-index (absent from BOTH sources) ────────────
test('checkIndex outcome=fail/not-in-index: unit absent from both the file-index and the store', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-idx-absent';
    // Nothing written for this unit at all — neither cited fact nor store fragment.

    const result = _private.checkIndex(cwd, unitId);
    assert.strictEqual(result.outcome, 'fail');
    assert.strictEqual(result.reason, 'not-in-index');
    assert.strictEqual(result.facts_count, 0);
  });
});

// ── 15. Layer 3 outcome: unavailable (fallback store read fails) ────────────
test('checkIndex outcome=unavailable: a fallback store read failure never collapses to ok', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-idx-unavailable';
    // A real, listable fragment exists — the index misses it (no citation),
    // and the fallback read is then forced to throw deterministically by
    // monkey-patching the shared, cached forge-memory export (local, always
    // restored in finally — no dependence on OS permission behavior).
    groupIntoContainer(cwd, unitId, [uncitedFact('002')], 'sweep-project-01');

    const originalReadFragmentText = memory.readFragmentText;
    memory.readFragmentText = () => {
      throw new Error('forced-read-failure-for-test');
    };
    try {
      const result = _private.checkIndex(cwd, unitId);
      assert.strictEqual(result.outcome, 'unavailable');
      assert.notStrictEqual(result.outcome, 'ok', 'a forced read failure must never present as ok');
      assert.strictEqual(result.facts_count, 0);
      assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
      assert.ok(typeof result.note === 'string' && result.note.includes('forced-read-failure-for-test'));
    } finally {
      memory.readFragmentText = originalReadFragmentText;
    }
  });
});

// ── 16. Layer 2 fence: Layer 3 widening never loosens Layer 2's DST- gate ───
test('checkClosure: MEM-only unit is index.ok/source:store while distilled stays fail/not-distilled (overall not ok)', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-fence';
    writeLedger(cwd, unitId);
    // Only MEM### facts, zero DST- facts, zero file citations.
    groupIntoContainer(cwd, unitId, [uncitedFact('003'), uncitedFact('004')], 'sweep-project-01');

    const result = checkClosure(cwd, unitId);
    assert.strictEqual(result.layers.index.outcome, 'ok');
    assert.strictEqual(result.layers.index.source, 'store');
    assert.strictEqual(result.layers.distilled.outcome, 'fail');
    assert.strictEqual(result.layers.distilled.reason, 'not-distilled');
    assert.strictEqual(result.layers.distilled.dst_count, 0);
    assert.strictEqual(result.ok, false, 'Layer 3 widening must not close the unit without a DST- fact');
  });
});

// ── 17. S03 boundary: a quarantined write is never normalized into closure ok
test('checkClosure: a refused (quarantined) write never surfaces as distilled ok — quarantine is not success', () => {
  withTemp((cwd) => {
    const unitId = 'M-20260101000000-fixture-quarantine';
    writeLedger(cwd, unitId);
    // The unit's canonical envelope lives inside a grouped container with
    // only a MEM### fact — no DST-, no loose file.
    groupIntoContainer(cwd, unitId, [uncitedFact('005')], 'sweep-project-01');

    // A later attempt to merge in a DST- fact finds no loose file and a
    // grouped member already claiming the storage key — writeFragment
    // REFUSES the write (quarantined: true) rather than silently shadowing
    // the grouped envelope. This is the exact S03 safety boundary: the
    // refusal result must never be read as "the fact is now in the store".
    const writeResult = writeMemory(cwd, unitId, [dstFact('hhhhhhhhhhhh')]);
    assert.strictEqual(writeResult.quarantined, true, 'fixture setup: the write must actually be refused');

    const result = checkClosure(cwd, unitId);
    // The store still only contains the original MEM### fact (from the
    // grouped container) — the quarantined DST- fact never landed there.
    assert.strictEqual(result.layers.distilled.outcome, 'fail');
    assert.strictEqual(result.layers.distilled.reason, 'not-distilled');
    assert.strictEqual(result.layers.distilled.dst_count, 0);
    assert.strictEqual(result.ok, false, 'a quarantined write must not be normalized into closure success');
  });
});

run();
