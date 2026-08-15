'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeFragment } = require('./forge-memory');
const { detectMentions, detectSignalMentions, classifyCitationPrecision, measureF2 } = require('./forge-index-f2');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}
function snapshotTree(root) {
  const result = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      const stat = fs.statSync(target);
      result.push({ path: path.relative(root, target), size: stat.size, mtime: stat.mtimeMs, isDirectory: entry.isDirectory() });
      if (entry.isDirectory()) walk(target);
    }
  }
  walk(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function fact(mem_id, text) { return { mem_id, category: 'test', text, created_at: '2026-01-01T00:00:00Z', source_unit: 'T01' }; }
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-'));
  fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'scripts', 'covered.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(cwd, 'scripts', 'partial.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(cwd, 'scripts', 'other.md'), '# other\n');
  writeFragment(cwd, {
    unit_id: 'T01',
    facts: [
      fact('f-covered', '`scripts/covered.js`'),
      fact('f-partial', '`scripts/partial.js` e other.weird'),
      fact('f-missed', 'Veja scripts/absent.js'),
      fact('f-no-mention', 'Uma decisão sem arquivo.'),
      fact('f-fp', 'O plano T01-PLAN.md foi revisado.'),
      fact('f-noise', 'A versão 1.2.0 e o caminho e/ou são ruído.'),
    ],
  });
  return cwd;
}

test('detector usa vocabulário independente e largo', () => {
  const source = fs.readFileSync(path.join(__dirname, 'forge-index-f2.js'), 'utf8');
  const body = source.slice(source.indexOf('function detectMentions'), source.indexOf('function detectorFalsePositive'));
  assert(!body.includes('CODE_EXT'));
  assert(!body.includes('CITATION_REGEXES'));
  const mentions = detectMentions('`arquivo.weird` src/a/b token.js 1.2.0');
  assert.deepStrictEqual(mentions.map((item) => item.normalized), ['arquivo.weird', 'b', 'token.js', '1.2.0']);
  assert(mentions.every((item) => item.raw && item.why));
});

test('detecta ruído próprio sem ocultá-lo', () => {
  const report = detectMentions('A versão 1.2.0 e o fluxo e/ou foram citados.');
  assert(report.some((item) => item.normalized === '1.2.0'));
  assert(report.some((item) => item.raw === 'e/ou'));
});

test('precision enumera a citação -PLAN.md', () => {
  const mentions = detectMentions('O plano T01-PLAN.md foi revisado.');
  const citations = [{ raw: '-PLAN.md', path: '-PLAN.md', line: null, pattern: 'bare-basename' }];
  const fp = classifyCitationPrecision(citations, mentions, 'synthetic');
  assert.strictEqual(fp.length, 1);
  assert.strictEqual(fp[0].mem_id, 'synthetic');
  assert.strictEqual(fp[0].raw, '-PLAN.md');
});

test('mede covered, partial, missed e no-mention por listas', () => {
  const cwd = fixture();
  try {
    const report = measureF2(cwd);
    // S02 R1 (review-fix): o denominador passou de 5 para 4 — `f-noise` (versão
    // nua + `e/ou`) deixou de contar como fato que menciona arquivo, e com isso
    // deixou de ser `missed`. Não é ajuste de expectativa: é a mudança de
    // denominador sancionada pelo review.
    assert.strictEqual(report.facts_that_mention_file, 4);
    assert.strictEqual(report.facts_covered.length, 3);
    assert.strictEqual(report.facts_missed_total.length, 0);
    assert.strictEqual(report.facts_missed_partial.length, 1);
    assert.strictEqual(report.facts_no_mention.length, 2);
    assert.strictEqual(report.facts_missed_partial[0].missing_mentions[0].normalized, 'other.weird');
    assert.strictEqual(report.f2_recall, 1 - 1 / 4);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('publica resolution_rate e identidade de motivos', () => {
  const cwd = fixture();
  try {
    const report = measureF2(cwd);
    const sum = Object.values(report.unresolved_by_reason).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, report.citations_total - report.citations_resolved);
    assert.strictEqual(report.resolution_rate, report.citations_resolved / report.citations_total);
    assert(report.detector_false_positives.some((item) => item.raw.includes('1.2.0')));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('denominador vazio gera verdict próprio e recall nulo', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-empty-'));
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('empty', 'somente prosa')] });
    const report = measureF2(cwd);
    assert.strictEqual(report.verdict, 'EMPTY-DENOMINATOR');
    assert.strictEqual(report.f2_recall, null);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('a medição é read-only', () => {
  const cwd = fixture();
  try {
    const before = snapshotTree(cwd);
    measureF2(cwd);
    const after = snapshotTree(cwd);
    assert.deepStrictEqual(after, before);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('CLI JSON tem uma linha e exit 0', () => {
  const cwd = fixture();
  try {
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-index-f2.js'), '--cwd', cwd, '--json'], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 0);
    const lines = cli.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(JSON.parse(lines[0]).verdict, 'MEASURED');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('CLI rejeita argumento desconhecido com exit 2', () => {
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-index-f2.js'), '--wat'], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 2);
  assert(JSON.parse(cli.stderr).error);
});

test('classificador mantém raw, motivo e mem_id', () => {
  const result = classifyCitationPrecision(
    [{ raw: '`x.weird`', path: 'x.weird' }],
    [{ raw: 'x.js', normalized: 'x.js', why: 'suffix' }],
    'f-precision',
  );
  assert.deepStrictEqual(result, [{
    mem_id: 'f-precision',
    raw: '`x.weird`',
    motivo: 'citação extraída sem menção independente correspondente',
  }]);
});

test('relatório expõe buckets derivados sem contador oculto', () => {
  const cwd = fixture();
  try {
    const report = measureF2(cwd);
    assert.strictEqual(report.coverage_identity, true);
    assert.strictEqual(report.fact_counts.covered, report.facts_covered.length);
    assert.strictEqual(report.fact_counts.partial, report.facts_missed_partial.length);
    assert.strictEqual(report.fact_counts.missed, report.facts_missed_total.length);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// ── S02 R1 (review-fix): ruído do detector fora do denominador ───────────────
test('menção só-ruído não conta como missed; menção real ainda conta', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-noise-'));
  try {
    writeFragment(cwd, {
      unit_id: 'T01',
      facts: [
        fact('só-ruído', 'A versão 3.1.2 apareceu e/ou não.'),
        fact('menção-real', 'Veja outro.weird aqui.'),
      ],
    });
    const report = measureF2(cwd);
    // O fato só-ruído sai do denominador inteiro (não é missed nem partial).
    assert.strictEqual(report.facts_that_mention_file, 1);
    assert.deepStrictEqual(report.facts_missed_total.map((item) => item.mem_id), ['menção-real']);
    assert.deepStrictEqual(report.facts_no_mention.map((item) => item.mem_id), ['só-ruído']);
    assert.strictEqual(report.f2_recall, 0);
    // O descarte permanece ENUMERADO — diagnóstico preservado, nunca silencioso.
    assert(report.detector_false_positives.some((item) => item.raw.includes('3.1.2')));
    assert(report.detector_false_positives.some((item) => item.raw === 'e/ou'));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('detectSignalMentions remove o ruído que detectMentions ainda reporta', () => {
  const text = 'A versão 3.1.2 e/ou o arquivo real.js.';
  assert.strictEqual(detectMentions(text).length, 3);
  assert.deepStrictEqual(detectSignalMentions(text).map((item) => item.normalized), ['real.js']);
});

console.log(`\n${passed} testes F2 passaram`);
