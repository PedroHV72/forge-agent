'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const memory = require('./forge-memory');
const ledger = require('./forge-ledger');
const distill = require('./forge-distill');

const ID = 'M123';
const script = path.join(__dirname, 'forge-distill.js');

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-distill-t02-'));
  const root = path.join(cwd, '.gsd', 'milestones', ID);
  fs.mkdirSync(path.join(root, 'slices', 'S02'), { recursive: true });
  ledger.writeFragment(cwd, { id: ID, title: 'fixture' });
  fs.writeFileSync(path.join(root, `${ID}-SUMMARY.md`), '---\nkey_decisions:\n  - "Prefer a stable boundary"\nprovides:\n  - "A testable distiller"\n---\n\n## Forward Intelligence\n- Keep the source order\n');
  fs.writeFileSync(path.join(root, `${ID}-CONTEXT.md`), '## Decisions from Session\n- Preserve audit information\n');
  fs.writeFileSync(path.join(root, 'slices', 'S02', 'S02-SUMMARY.md'), '---\npatterns_established:\n  - "Use the memory API"\n---\n');
  fs.writeFileSync(path.join(root, 'slices', 'S02', 'S02-REVIEW.md'), 'Review verdict: green\n');
  fs.writeFileSync(path.join(root, 'slices', 'S02', 'S02-MEASUREMENT.md'), 'Result: conceded\n');
  return cwd;
}

function candidate(cwd, needle = 'stable') {
  const plan = distill.planDistill(cwd, ID);
  assert.strictEqual(plan.eligibility.ok, true, JSON.stringify(plan));
  return plan.candidates.find(item => item.text.toLowerCase().includes(needle)) || plan.candidates[0];
}

function selectionFor(cwd, verdicts) { return { milestone: ID, verdicts }; }
function completeSelection(cwd, verdicts) { const judged = new Set(verdicts.map(item => item.candidate_id)); return selectionFor(cwd, [...verdicts, ...distill.planDistill(cwd, ID).candidates.filter(item => !judged.has(item.id)).map(reject)]); }
function keep(c, rank = 1, text = c.text, category = 'pattern') { return { candidate_id: c.id, keep: true, gate: { project_specific: true, non_obvious: true, durable: true }, category, text, rank }; }
function reject(c) { return { candidate_id: c.id, keep: false, reason: 'not durable enough' }; }
function writeSelection(selection) { const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'selection-')), 'selection.json'); fs.writeFileSync(file, JSON.stringify(selection)); return file; }
function digest(cwd) {
  const rows = [];
  function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else rows.push([path.relative(cwd, file), fs.readFileSync(file).toString('hex')]); } }
  walk(cwd); return crypto.createHash('sha1').update(JSON.stringify(rows.sort())).digest('hex');
}
function expectFailure(fn, reason) { assert.throws(fn, error => error.reason === reason, `expected ${reason}`); }

// Schema and helper contract.
{
  const cwd = fixture(); const c = candidate(cwd);
  const file = writeSelection(selectionFor(cwd, [keep(c)]));
  assert.deepStrictEqual(distill.loadSelection(file).milestone, ID);
  assert.strictEqual(distill.dstMemId(ID, 'pattern', c.text).length, 16);
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [{ ...keep(c), gate: { project_specific: true, non_obvious: false, durable: true } }]))), 'gate-shape');
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [{ ...keep(c), category: 'made-up' }]))), 'invalid-category');
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [{ ...keep(c), text: 'two\nlines' }]))), 'multiline-text');
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [{ ...keep(c), rank: 0 }, { ...keep(c, 0, 'other') }]))), 'selection-unreadable');
  assert.strictEqual(distill.loadSelection(writeSelection(selectionFor(cwd, [reject(c)]))).verdicts[0].keep, false);
}

// Successful apply writes the exact fact shape through forge-memory.
{
  const cwd = fixture(); const c = candidate(cwd); const selection = selectionFor(cwd, [keep(c)]);
  const result = distill.applyDistill(cwd, ID, completeSelection(cwd, selection.verdicts));
  assert.strictEqual(result.verdict, 'APPLIED'); assert.strictEqual(result.written, true);
  const stored = memory.readFragment(cwd, ID);
  assert.strictEqual(stored.unit_id, ID); assert.strictEqual(stored.facts.length, 1);
  assert.deepStrictEqual(Object.keys(stored.facts[0]).sort(), ['category', 'confidence_base', 'created_at', 'mem_id', 'source_unit', 'text'].sort());
  assert.strictEqual(stored.facts[0].source_unit, `distill/${ID}`);
  assert.strictEqual(memory.listFragments(cwd).some(item => item.unitId === ID), true);
}

// Re-execution is byte stable and uses the API, not raw store writes.
{
  const cwd = fixture(); const c = candidate(cwd); const selection = selectionFor(cwd, [keep(c)]);
  const complete = completeSelection(cwd, selection.verdicts); distill.applyDistill(cwd, ID, complete); const before = fs.readFileSync(memory.readFragment(cwd, ID) && memory.listFragments(cwd).find(e => e.unitId === ID).path);
  const second = distill.applyDistill(cwd, ID, complete); const after = fs.readFileSync(memory.listFragments(cwd).find(e => e.unitId === ID).path);
  assert.deepStrictEqual(after, before); assert.deepStrictEqual(second.already_present, [c.id]);
}

// Fresh-plan binding: unknown and unjudged candidates refuse without mutation.
{
  const cwd = fixture(); const c = candidate(cwd); const before = digest(cwd);
  expectFailure(() => distill.applyDistill(cwd, ID, selectionFor(cwd, [{ ...keep(c), candidate_id: 'c-nope' }])), 'unknown-candidate');
  assert.strictEqual(digest(cwd), before);
  const other = distill.planDistill(cwd, ID).candidates.find(item => item.id !== c.id);
  expectFailure(() => distill.applyDistill(cwd, ID, selectionFor(cwd, [keep(c)])), 'unjudged-candidates');
  assert.strictEqual(digest(cwd), before); assert(other);
}

// Wrapper citation is rejected, including the literal blocker fixture.
{
  const cwd = fixture(); const review = distill.planDistill(cwd, ID).candidates.find(c => c.source_file.includes('S02-REVIEW'));
  expectFailure(() => distill.applyDistill(cwd, ID, completeSelection(cwd, [keep(review, 1, 'See slices/S02/S02-REVIEW.md')])), 'wrapper-citation');
  assert.strictEqual(memory.readFragment(cwd, ID), null);
}

// Existing MEM facts do not consume budget; an existing divergent DST id collides.
{
  const cwd = fixture(); const c = candidate(cwd); memory.writeFragment(cwd, { unit_id: ID, facts: [{ mem_id: 'MEM001', category: 'pattern', text: 'old', created_at: '2026-01-01', source_unit: 'test' }] });
  const id = distill.dstMemId(ID, 'pattern', c.text); memory.writeFragment(cwd, { unit_id: ID, facts: [{ mem_id: id, category: 'gotcha', text: 'different', created_at: '2026-01-01', source_unit: 'test' }] });
  const before = digest(cwd); expectFailure(() => distill.applyDistill(cwd, ID, completeSelection(cwd, [keep(c)])), 'mem-id-collision'); assert.strictEqual(digest(cwd), before);
}

// Eleven unique keeps exceed the hard post-merge DST budget.
{
  const cwd = fixture(); const plan = distill.planDistill(cwd, ID); const base = plan.candidates[0];
  const verdicts = Array.from({ length: 11 }, (_, index) => keep(base, index + 1, `fact ${index + 1}`));
  // Give each synthetic verdict a known candidate id by adding corresponding source candidates.
  for (let i = 1; i < 11; i++) verdicts[i].candidate_id = plan.candidates[i % plan.candidates.length].id;
  const unique = new Map(verdicts.map((v, i) => [`${v.candidate_id}-${i}`, { ...v, candidate_id: plan.candidates[i % plan.candidates.length].id }]));
  // The production validator intentionally requires one verdict per fresh candidate; use a fresh fixture with 11 candidates.
  const many = fixture(); const root = path.join(many, '.gsd', 'milestones', ID); fs.writeFileSync(path.join(root, `${ID}-SUMMARY.md`), `---\nprovides:\n${Array.from({ length: 12 }, (_, i) => `  - "budget fact ${i}"`).join('\n')}\n---\n`);
  const manyPlan = distill.planDistill(many, ID); assert(manyPlan.candidates.length >= 11, `budget fixture candidates=${manyPlan.candidates.length}`);
  const all = manyPlan.candidates.slice(0, 11).map((item, i) => keep(item, i + 1, `budget ${i}`));
  const before = digest(many);
  const judged = new Set(all.map(item => item.candidate_id));
  const budgetSelection = selectionFor(many, [...all, ...manyPlan.candidates.filter(item => !judged.has(item.id)).map(reject)]);
  expectFailure(() => distill.applyDistill(many, ID, budgetSelection), 'budget-exceeded');
  assert.strictEqual(digest(many), before);
  assert(unique.size > 0);
}

// CLI boundaries: apply requires selection, and prints a preview before apply output.
{
  const cwd = fixture(); const noSelection = spawnSync(process.execPath, [script, '--milestone', ID, '--cwd', cwd, '--apply'], { encoding: 'utf8' });
  assert.strictEqual(noSelection.status, 2); assert(noSelection.stderr.includes('--apply exige --selection'));
  const c = candidate(cwd); const file = writeSelection(selectionFor(cwd, [keep(c), ...distill.planDistill(cwd, ID).candidates.filter(x => x.id !== c.id).map(reject)]));
  const applied = spawnSync(process.execPath, [script, '--milestone', ID, '--cwd', cwd, '--selection', file, '--apply'], { encoding: 'utf8' });
  assert.strictEqual(applied.status, 0, applied.stderr); assert(applied.stdout.indexOf('"preview":true') < applied.stdout.indexOf('"verdict":"APPLIED"'));
}

console.log('PASS: forge-distill T02 apply tests');

// Additional boundary assertions keep each named refusal independently observable.
{
  const cwd = fixture();
  const c = candidate(cwd);
  const before = digest(cwd);
  expectFailure(() => distill.applyDistill(cwd, ID, { milestone: ID, verdicts: [] }), 'unjudged-candidates');
  assert.strictEqual(digest(cwd), before);
  expectFailure(() => distill.applyDistill(cwd, ID, { milestone: 'M999', verdicts: [] }), 'selection-unreadable');
  assert.strictEqual(digest(cwd), before);
  assert(c.id.startsWith('c-'));
}

{
  const cwd = fixture();
  const c = candidate(cwd);
  const badGate = { candidate_id: c.id, keep: true, gate: { project_specific: true, non_obvious: true, durable: 1 }, category: 'pattern', text: 'x', rank: 1 };
  const badCategory = { candidate_id: c.id, keep: true, gate: { project_specific: true, non_obvious: true, durable: true }, category: 'unknown', text: 'x', rank: 1 };
  const badText = { candidate_id: c.id, keep: true, gate: { project_specific: true, non_obvious: true, durable: true }, category: 'pattern', text: 'x\rline', rank: 1 };
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [badGate]))), 'gate-shape');
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [badCategory]))), 'invalid-category');
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [badText]))), 'multiline-text');
}

{
  const cwd = fixture();
  const c = candidate(cwd);
  const noRank = { ...keep(c), rank: '1' };
  const duplicateRank = [keep(c, 1), { ...keep(c, 1, 'second'), candidate_id: 'other' }];
  const duplicateId = [keep(c), keep(c, 2, 'same id')];
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [noRank]))), 'selection-unreadable');
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, duplicateRank))), 'selection-unreadable');
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, duplicateId))), 'selection-unreadable');
}

{
  const cwd = fixture();
  const c = candidate(cwd);
  const citations = [
    '.gsd/milestones/M123/M123-SUMMARY.md',
    '.gsd\\tasks\\T02-PLAN.md',
    'slices/S02/S02-REVIEW.md',
    'tasks/T02/',
    'S02-REVIEW.md',
    'T02-SUMMARY.md',
  ];
  for (const text of citations) {
    const before = digest(cwd);
    expectFailure(() => distill.applyDistill(cwd, ID, completeSelection(cwd, [keep(c, 1, text)])), 'wrapper-citation');
    assert.strictEqual(digest(cwd), before);
  }
}

{
  const facts = Array.from({ length: 10 }, (_, i) => ({ mem_id: `DST-existing-${i}` }));
  const fresh = [{ candidate_id: 'new', rank: 4 }];
  try {
    distill._private.checkBudget(facts, fresh);
    assert.fail('budget must reject the eleventh DST fact');
  } catch (error) {
    assert.strictEqual(error.reason, 'budget-exceeded');
    assert(error.detail.includes('new'));
    assert(error.detail.includes('4'));
  }
  assert.strictEqual(distill._private.checkBudget(facts.slice(0, 9), fresh), 10);
}

{
  const cwd = fixture();
  const c = candidate(cwd);
  const selection = completeSelection(cwd, [keep(c)]);
  const preview = distill._private.previewText(distill.planDistill(cwd, ID), selection);
  const parsed = JSON.parse(preview);
  assert.strictEqual(parsed.preview, true);
  assert.strictEqual(parsed.milestone, ID);
  assert.strictEqual(parsed.verdicts, selection.verdicts.length);
  assert.strictEqual(parsed.keeps, 1);
}

{
  assert.strictEqual(distill._private.parseArgs(['--milestone', ID]).apply, false);
  assert.strictEqual(distill._private.parseArgs(['--milestone', ID, '--selection', 'x', '--apply']).apply, true);
  assert.throws(() => distill._private.parseArgs(['--milestone', ID, '--apply']), /--apply exige --selection/);
  assert.throws(() => distill._private.parseArgs(['--milestone', ID, '--selection']), /exige um valor/);
  assert.throws(() => distill._private.parseArgs(['--milestone', ID, '--wat']), /argumento desconhecido/);
}

{
  const cwd = fixture();
  const c = candidate(cwd);
  const selection = completeSelection(cwd, [keep(c)]);
  const first = distill.applyDistill(cwd, ID, selection);
  const listed = memory.listFragments(cwd);
  const entry = listed.find(item => item.unitId === ID);
  assert(entry);
  assert.strictEqual(entry.milestoneId, null);
  assert.strictEqual(path.isAbsolute(entry.path), true);
  const read = memory.readFragment(cwd, ID);
  assert.strictEqual(read.facts.filter(fact => /^DST-/.test(fact.mem_id)).length, first.dst_facts_total);
  const second = distill.applyDistill(cwd, ID, selection);
  assert.strictEqual(second.written, false);
  assert.deepStrictEqual(second.already_present, [c.id]);
}

{
  const cwd = fixture();
  const c = candidate(cwd);
  const selection = completeSelection(cwd, [keep(c)]);
  memory.writeFragment(cwd, { unit_id: ID, facts: [] });
  const before = digest(cwd);
  const result = distill.applyDistill(cwd, ID, selection);
  assert.strictEqual(result.verdict, 'APPLIED');
  assert.notStrictEqual(digest(cwd), before);
  const facts = memory.readFragment(cwd, ID).facts;
  assert.strictEqual(facts[0].source_unit, `distill/${ID}`);
}

// A distilled fact that never reaches the projection the workers read is inert
// green: the milestone pays for the distillation and nobody reads the result.
// Defect this guards: `distill-facts-invisible-in-projection` (T03 dogfood, §7.2).
{
  const projection = require('./forge-projection');
  const cwd = fixture();
  const c = candidate(cwd);
  const selection = completeSelection(cwd, [keep(c)]);
  const applied = distill.applyDistill(cwd, ID, selection);
  assert.strictEqual(applied.verdict, 'APPLIED');

  // 1. The written fact carries the field the projection ranks on.
  const written = memory.readFragment(cwd, ID).facts.find(fact => /^DST-/.test(fact.mem_id));
  assert(written, 'expected a DST fact on disk');
  assert.strictEqual(Number(written.confidence_base), distill._private.DISTILL_CONFIDENCE_BASE);

  // 2. Synthetic store big enough that MEMORY_CAP=50 actually bites: 40 facts
  // above the distilled band and 30 below it, no ties with 0.80 on either side.
  // Ranked, the DST fact sits at position 41 — inside the cap. At the absent-field
  // default of 0.5 it would sit below all 70 fillers, at position 71 — outside.
  const created_at = String(written.created_at);
  const filler = (n, base) => Array.from({ length: n }, (_, i) => ({
    mem_id: `MEM${base * 1000 + i}`, category: 'pattern',
    text: `filler ${base} ${i}`, confidence_base: base, created_at,
  }));
  memory.writeFragment(cwd, { unit_id: 'M999', facts: [...filler(40, 0.9), ...filler(30, 0.6)] });

  const ranked = projection.projectMemoryEntries(cwd);
  const pos = ranked.findIndex(entry => entry.fact.mem_id === written.mem_id);
  assert(pos >= 0 && pos < 50, `DST fact ranked at ${pos} of ${ranked.length} — outside MEMORY_CAP`);

  // 3. The rendered artifact — the bytes a worker is handed — names it.
  const rendered = projection.renderMemory(cwd);
  assert(rendered.includes(written.mem_id), 'render memory omitted the distilled fact');
  assert.strictEqual((rendered.match(/gsd-auto-memory mem_id:/g) || []).length, 50, 'cap not exercised');
}

// R1 — the quality gate is not bypassable by calling applyDistill directly.
// loadSelection is the CLI door; applyDistill is exported and callable. Each
// malformed kept verdict below is refused BY NAME on the direct call, with the
// store left untouched. Reverting validateSelectionShape out of
// validateAgainstPlan makes all three of these accept and write.
{
  const cwd = fixture();
  const c = candidate(cwd);
  const cases = [
    ['gate-shape', { gate: { project_specific: true, non_obvious: false, durable: true } }],
    ['gate-shape', { gate: { project_specific: true, non_obvious: true, durable: 1 } }],
    ['invalid-category', { category: 'made-up' }],
    ['multiline-text', { text: 'two\nlines' }],
    ['multiline-text', { text: 'carriage\rreturn' }],
  ];
  for (const [reason, override] of cases) {
    const before = digest(cwd);
    const verdicts = completeSelection(cwd, [{ ...keep(c), ...override }]).verdicts;
    expectFailure(() => distill.applyDistill(cwd, ID, { milestone: ID, verdicts }), reason);
    assert.strictEqual(digest(cwd), before, `${reason}: store mutated by a refused apply`);
    assert.strictEqual(memory.readFragment(cwd, ID), null, `${reason}: fragment written`);
  }
  // Same fences, same reasons, through the other entry point — one validator.
  expectFailure(() => distill._private.validateSelectionShape({ milestone: ID, verdicts: [{ ...keep(c), category: 'made-up' }] }), 'invalid-category');
}

// R2 — batch origin is not store origin. `already_present` is a claim about the
// persisted store; a duplicate payload inside the same selection is reported
// separately as `deduped_in_batch`, so a first-ever apply never claims a fact
// pre-existed.
{
  const cwd = fixture();
  const plan = distill.planDistill(cwd, ID);
  const [a, b] = plan.candidates;
  assert(a && b && a.id !== b.id, 'fixture needs two distinct candidates');
  // Two distinct candidates judged into the SAME category+text ⇒ same DST id.
  const text = 'one payload judged twice in one batch';
  const first = distill.applyDistill(cwd, ID, completeSelection(cwd, [keep(a, 1, text), keep(b, 2, text)]));
  assert.strictEqual(first.verdict, 'APPLIED');
  assert.deepStrictEqual(first.already_present, [], 'first-ever apply must not claim a prior run');
  assert.strictEqual(first.deduped_in_batch.length, 1, JSON.stringify(first.deduped_in_batch));
  assert.strictEqual(first.deduped_in_batch[0].candidate_id, b.id);
  assert.strictEqual(first.deduped_in_batch[0].mem_id, distill.dstMemId(ID, 'pattern', text));
  assert.strictEqual(memory.readFragment(cwd, ID).facts.filter(f => /^DST-/.test(f.mem_id)).length, 1);

  // Re-running the same selection: now the fact IS persisted — store origin.
  const second = distill.applyDistill(cwd, ID, completeSelection(cwd, [keep(a, 1, text), keep(b, 2, text)]));
  assert.strictEqual(second.written, false);
  assert.deepStrictEqual(second.already_present.sort(), [a.id, b.id].sort(), 'second run must be store-origin for both');
  assert.deepStrictEqual(second.deduped_in_batch, [], 'nothing is fresh, so nothing dedupes in batch');
}

// R3 — the accepted single-operator race is narrowed by a re-read: facts that
// landed between the first budget check and the write are refused by name
// (`budget-exceeded-on-recheck`) instead of silently overflowing the budget.
{
  const cwd = fixture();
  const c = candidate(cwd);
  const selection = completeSelection(cwd, [keep(c)]);
  // The competing apply must land INSIDE the window — after the first snapshot,
  // before the write. Nothing else can express that, so the store read is driven
  // directly: the first read is empty (budget passes, as it did before this fix),
  // the second read carries the ten DST facts the competitor just merged.
  const realRead = memory.readFragment;
  const raced = Array.from({ length: 10 }, (_, i) => ({ mem_id: `DST-race${String(i).padStart(6, '0')}`, category: 'pattern', text: `raced ${i}`, created_at: '2026-01-01', source_unit: 'other-operator' }));
  let reads = 0;
  memory.readFragment = function (...args) {
    reads++;
    return reads === 1 ? realRead.apply(this, args) : { unit_id: ID, facts: raced };
  };
  const before = digest(cwd);
  try {
    expectFailure(() => distill.applyDistill(cwd, ID, selection), 'budget-exceeded-on-recheck');
  } finally {
    memory.readFragment = realRead;
  }
  assert(reads >= 2, 'applyDistill must re-read the store before writing');
  assert.strictEqual(digest(cwd), before, 'a refused apply must not write');

  // Without a competitor the same path applies normally — the narrowing does not
  // refuse honest work.
  const clean = fixture();
  const cc = candidate(clean);
  assert.strictEqual(distill.applyDistill(clean, ID, completeSelection(clean, [keep(cc)])).verdict, 'APPLIED');
}

// R4 — the dead `merged` computation is gone from the collision result.
{
  const checked = distill._private.checkCollisions([], [{ candidate_id: 'x', category: 'pattern', text: 'y', rank: 1 }], ID);
  assert.deepStrictEqual(Object.keys(checked).sort(), ['already', 'dedupedInBatch', 'fresh']);
  assert.strictEqual('merged' in checked, false, 'merged had no consumer and was removed');
}

console.log('PASS: forge-distill review-fix/S03 (R1-R4)');
