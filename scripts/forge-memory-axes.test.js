'use strict';

const assert = require('assert');
const { buildUnitAxis, renderUnitAxis, buildSubjectAxis, renderSubjectAxis, normalizeSubject, STOPWORDS, SUBJECTS_PER_FACT } = require('./forge-memory-axes');

function fact(mem_id, storage_key, source_unit) {
  return { mem_id, category: 'pattern', summary: `summary ${mem_id}`, unit_id: 'wrong', storage_key, milestone_id: null, source_unit, citations_total: 0, citations_resolved: 0, citations_resolved_count: 0 };
}
function result(facts, coverage) {
  return { facts, partial: false, coverage: Object.assign({ unreadable_fragments: [], fragments_skipped_by_store: [], fragment_listing_failed: null }, coverage) };
}
let passed = 0; let failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); } }

test('groups by envelope storage_key, not source_unit', () => {
  const axis = buildUnitAxis(result([fact('b', 'M001__T01', 'T99'), fact('a', 'M001__T01', 'T98'), fact('c', 'T02', 'T01')]));
  assert.deepStrictEqual(axis.units.map((u) => u.storage_key), ['M001__T01', 'T02']);
  assert.deepStrictEqual(axis.units[0].facts.map((f) => f.mem_id), ['a', 'b']);
  assert.strictEqual(axis.units[0].facts[0].source_unit, 'T98');
});
test('resolves milestone and unit from parseStorageKey', () => {
  const axis = buildUnitAxis(result([fact('a', 'M001__T01', 'T01')]));
  assert.strictEqual(axis.units[0].unit_id, 'T01'); assert.strictEqual(axis.units[0].milestone_id, 'M001');
});
test('invalid and missing envelopes are explicit undetermined states', () => {
  const axis = buildUnitAxis(result([fact('bad', 'not-valid', 'T01'), fact('missing', null, 'T01')]));
  assert.strictEqual(axis.units.length, 0);
  assert.deepStrictEqual(axis.coverage.units_undetermined.map((u) => u.reason), ['invalid-storage-key', 'missing-storage-key']);
  assert.strictEqual(axis.coverage.facts_with_unit, 0); assert.strictEqual(axis.coverage.facts_total, 2);
});
test('coverage is scoped to facts read and enumerates skipped input', () => {
  const axis = buildUnitAxis(result([fact('a', 'T01', 'T01')], { unreadable_fragments: [{}], fragments_skipped_by_store: ['bad.md'] }));
  assert.deepStrictEqual(axis.coverage.facts_not_read, { unreadable_fragments: 1, fragments_skipped_by_store: 1 });
  assert.strictEqual(axis.coverage.facts_with_unit / axis.coverage.facts_total, 1);
});
test('render is unconditional for empty stores and deterministic', () => {
  const one = renderUnitAxis(buildUnitAxis(result([]))); const two = renderUnitAxis(buildUnitAxis(result([])));
  assert(one.includes('## Eixo unidade de origem')); assert(one.includes('_Nenhuma unidade com fatos lidos._')); assert.strictEqual(one, two);
});
test('query by storage key or unit id lists only matching facts', () => {
  const axis = buildUnitAxis(result([fact('a', 'M001__T01', 'other'), fact('b', 'T02', 'T02')]));
  const rendered = renderUnitAxis(axis, { requested: ['T01'] });
  assert(rendered.includes('M001__T01')); assert(!rendered.includes('### `T02`'));
});
test('query with no result has named reason when complete', () => {
  const rendered = renderUnitAxis(buildUnitAxis(result([fact('a', 'T01', 'T01')])), { requested: ['T99'] });
  assert(rendered.includes('no-facts-for-unit')); assert(rendered.includes('Nenhum fato confirmado'));
});
test('query does not assert absence after listing failure', () => {
  const rendered = renderUnitAxis(buildUnitAxis(result([], { fragment_listing_failed: 'boom' })), { requested: ['T99'] });
  assert(rendered.includes('fragment_listing_failed')); assert(rendered.includes('index-unavailable')); assert(!rendered.includes('no-facts-for-unit'));
});
test('facts retain source_unit as information beside the envelope identity', () => {
  const axis = buildUnitAxis(result([fact('m|1', 'T01', 'T99')]));
  assert.strictEqual(axis.units[0].storage_key, 'T01');
  assert.strictEqual(axis.units[0].facts[0].source_unit, 'T99');
  assert.strictEqual(axis.units[0].facts[0].mem_id, 'm|1');
});
test('facts sort by mem_id with locale en', () => {
  const axis = buildUnitAxis(result([fact('z', 'T01', 'T01'), fact('a', 'T01', 'T01')]));
  assert.deepStrictEqual(axis.units[0].facts.map((item) => item.mem_id), ['a', 'z']);
});
test('multiple requested unit ids accumulate matching envelopes', () => {
  const axis = buildUnitAxis(result([fact('a', 'M001__T01', 'T01'), fact('b', 'M002__T02', 'T02')]));
  const rendered = renderUnitAxis(axis, { requested: ['T01', 'T02'] });
  assert(rendered.includes('M001__T01'));
  assert(rendered.includes('M002__T02'));
});
test('incomplete result names partial absence explicitly', () => {
  const axis = buildUnitAxis(Object.assign(result([]), { partial: true }));
  const rendered = renderUnitAxis(axis, { requested: ['T99'] });
  assert(rendered.includes('index-partial-no-match'));
  assert(!rendered.includes('no-facts-for-unit'));
});
test('empty coverage fields are normalized to zero', () => {
  const axis = buildUnitAxis({ facts: [], coverage: {} });
  assert.strictEqual(axis.coverage.facts_total, 0);
  assert.strictEqual(axis.coverage.facts_with_unit, 0);
  assert.strictEqual(axis.coverage.facts_not_read.fragments_skipped_by_store, 0);
});

function subjectFact(mem_id, text) {
  return { mem_id, category: 'pattern', text, summary: text, storage_key: 'T01', unit_id: 'T01' };
}
test('subject axis is deterministic and reports its locked coverage envelope', () => {
  const input = result([subjectFact('z', 'Arquitetura parser parser'), subjectFact('a', 'Arquitetura parser'), subjectFact('v', 'e a de')]);
  const one = buildSubjectAxis(input); const two = buildSubjectAxis(input);
  assert.deepStrictEqual(one, two);
  assert.strictEqual(one.coverage.facts_total, 3);
  assert.strictEqual(one.coverage.facts_without_subject[0].reason, 'so-stopwords');
  assert.strictEqual(one.coverage.k, SUBJECTS_PER_FACT);
  assert(one.coverage.stopwords_version);
  assert(STOPWORDS.has('the') && STOPWORDS.has('de'));
});
test('subject ranking uses frequency, rarity, and locale tie-break without a threshold', () => {
  const axis = buildSubjectAxis(result([subjectFact('b', 'alpha beta beta'), subjectFact('a', 'alpha gamma') ]));
  assert(axis.subjects.some((item) => item.subject === 'beta'));
  assert(axis.subjects.some((item) => item.subject === 'gamma'));
  assert.strictEqual(axis.coverage.facts_without_subject.length, 0);
});
test('subject normalization is shared by render filtering and escapes table-sensitive prose', () => {
  const axis = buildSubjectAxis(result([subjectFact('pipe|id', '`CamelCase` parser|unsafe') ]));
  const rendered = renderSubjectAxis(axis, { requested: [normalizeSubject('CAMELCASE')] });
  assert(rendered.includes('## Eixo assunto'));
  assert(rendered.includes('Camelcase') || rendered.includes('camelcase'));
  assert(rendered.includes('pipe\\|id'));
});
test('empty subject axis is unconditional and enumerates no-subject facts', () => {
  const axis = buildSubjectAxis(result([subjectFact('empty', 'the and de') ]));
  const rendered = renderSubjectAxis(axis);
  assert(rendered.includes('## Eixo assunto'));
  assert(rendered.includes('### Fatos sem assunto'));
  assert(rendered.includes('so-stopwords'));
});
test('subject coverage distinguishes empty text from short and stop-only text', () => {
  const axis = buildSubjectAxis(result([
    subjectFact('empty', ''),
    subjectFact('short', 'a b c'),
    subjectFact('stop', 'the and para'),
  ]));
  const reasons = axis.coverage.facts_without_subject.map((item) => item.reason);
  assert(reasons.includes('texto-vazio'));
  assert(reasons.includes('so-tokens-curtos'));
  assert(reasons.includes('so-stopwords'));
});
test('subject extraction normalizes CRLF and strips punctuation at the edges', () => {
  const axis = buildSubjectAxis(result([subjectFact('line', '\r\n!!! Parser, arquitetura. ???\r\n')]));
  assert(axis.subjects.some((item) => item.subject === 'parser'));
  assert(axis.subjects.some((item) => item.subject === 'arquitetura'));
});
test('hyphen, underscore, camelCase and backtick tokens survive short-token filtering', () => {
  const axis = buildSubjectAxis(result([subjectFact('syntax', '`API` x-y a_b camelCase')]));
  const names = axis.subjects.map((item) => item.subject);
  assert(names.includes('api'));
  assert(names.includes('x-y'));
  assert(names.includes('a_b'));
  assert(names.includes('camelcase'));
});
test('each subject group has stable fact order independent of input order', () => {
  const facts = [subjectFact('z', 'parser architecture'), subjectFact('a', 'parser architecture'), subjectFact('m', 'parser architecture')];
  const forward = buildSubjectAxis(result(facts));
  const reverse = buildSubjectAxis(result(facts.slice().reverse()));
  assert.deepStrictEqual(forward, reverse);
});
test('rare terms outrank common terms when local frequency ties', () => {
  const axis = buildSubjectAxis(result([
    subjectFact('one', 'common uniqueone'),
    subjectFact('two', 'common uniquetwo'),
  ]));
  // S02 R4 (review-fix): o assert anterior (`=== 'uniqueone' || === 'common'`)
  // aceitava o bug que o nome do teste vigia. `axis.subjects` é ordenado por
  // localeCompare, então percorrê-lo mede ordem alfabética ('common' vem antes
  // sempre, com ranking correto ou invertido) — o contrato só é observável no
  // ranking em si. Assert estrito sobre `rankSubjects`, sem hedge.
  const { subjectTokens, rankSubjects } = require('./forge-memory-axes')._private;
  const facts = [subjectFact('one', 'common uniqueone'), subjectFact('two', 'common uniquetwo')];
  const df = new Map();
  const tokenized = facts.map((item) => subjectTokens(item.text));
  for (const item of tokenized) for (const token of new Set(item.tokens)) df.set(token, (df.get(token) || 0) + 1);
  assert.strictEqual(rankSubjects(tokenized[0].tokens, df, facts.length)[0], 'uniqueone');
  // E o fato raro continua alcançável pelo grupo raro no eixo publicado.
  const rare = axis.subjects.find((group) => group.subject === 'uniqueone');
  assert(rare && rare.facts.some((item) => item.mem_id === 'one'));
});
test('locale tie ordering is deterministic for accented and ASCII subjects', () => {
  const axis = buildSubjectAxis(result([subjectFact('one', 'zebra árvore'), subjectFact('two', 'zebra abaco')]));
  const names = axis.subjects.map((item) => item.subject);
  assert.deepStrictEqual(names, names.slice().sort((a, b) => a.localeCompare(b, 'en')));
});
test('requested subject matching is case-insensitive and repeatable', () => {
  const axis = buildSubjectAxis(result([subjectFact('one', 'Parser arquitetura'), subjectFact('two', 'Banco dados')]));
  const rendered = renderSubjectAxis(axis, { requested: ['PARSER', 'parser'] });
  assert(rendered.includes('parser'));
  assert(!rendered.includes('### `banco`'));
});
test('subject rendering has an explicit empty section for unknown requests', () => {
  const axis = buildSubjectAxis(result([subjectFact('one', 'Parser arquitetura')]));
  const rendered = renderSubjectAxis(axis, { requested: ['unknown-subject'] });
  assert(rendered.includes('## Eixo assunto'));
  assert(rendered.includes('Nenhum fato confirmado'));
  assert(rendered.includes('Fatos sem assunto'));
});
test('subject fact lines reuse the shared metadata format', () => {
  const axis = buildSubjectAxis(result([subjectFact('fact|pipe', 'Parser arquitetura')]));
  const rendered = renderSubjectAxis(axis);
  assert(rendered.includes('fact\\|pipe'));
  assert(rendered.includes('origem:'));
});
test('coverage reports facts_with_subject as a census, not a threshold verdict', () => {
  const axis = buildSubjectAxis(result([subjectFact('one', 'parser'), subjectFact('two', 'e de')])) ;
  assert.strictEqual(axis.coverage.facts_with_subject, 1);
  assert.strictEqual(axis.coverage.facts_total, 2);
  assert.strictEqual(axis.coverage.facts_without_subject.length, 1);
  assert(!Object.prototype.hasOwnProperty.call(axis.coverage, 'coverage_percent'));
});
// These cases intentionally assert shape and provenance rather than a quality
// score. The subject axis is a navigation aid, so a sparse result is still a
// valid result when its omissions are enumerated with named reasons.
// Keeping the cases here beside the unit-axis tests protects the shared fact
// renderer and the common storage envelope from accidental divergence.
// Repeated calls also document that no current time or random seed participates
// in either ranking or rendering. The exact stoplist version is carried in the
// report so a future vocabulary revision remains explainable to readers.
// No test below this point should introduce a percentage threshold.
// The absence list is the observable contract for facts that cannot rank.
// Escaping is checked through factLine because subjects originate in prose.
// Locale ordering is explicit so locale changes cannot become hidden ordering.
// Coverage remains a report, never a pass/fail gate for subject availability.
// This keeps D-2 visible in the executable specification.
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
