'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { normalizeForCompare, digestOf, NORMALIZATION_RULES } = require('./forge-memory-normalize');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; console.log(`  ✗ ${name}: ${error.message}`); }
}

console.log('\n=== forge-memory-normalize.test.js ===\n');

test('normaliza CRLF e CR solto para LF', () => {
  assert.strictEqual(normalizeForCompare('a\r\nb\rc'), 'a\nb\nc');
});

test('remove whitespace de borda de cada linha', () => {
  assert.strictEqual(normalizeForCompare('  a  \n\tb\t\n  '), 'a\n\tb');
});

test('faz trim do texto inteiro após as linhas', () => {
  assert.strictEqual(normalizeForCompare(' \n  Texto  \n\n'), 'texto');
});

test('aplica caixa baixa', () => {
  assert.strictEqual(normalizeForCompare('ABC AbC'), 'abc abc');
});

test('não colapsa whitespace intra-linha', () => {
  assert.strictEqual(normalizeForCompare('a  b\na\tb'), 'a  b\na\tb');
  assert.notStrictEqual(normalizeForCompare('a b'), normalizeForCompare('a  b'));
});

test('preserva whitespace não-trailing que faz parte da linha', () => {
  assert.strictEqual(normalizeForCompare('x \t y'), 'x \t y');
});

test('aceita valores convertíveis para string na fronteira', () => {
  assert.strictEqual(normalizeForCompare(42), '42');
  assert.strictEqual(normalizeForCompare(null), 'null');
});

test('digest é sha256 estável do texto normalizado', () => {
  const expected = crypto.createHash('sha256').update('linha\ncaixa', 'utf8').digest('hex');
  assert.strictEqual(digestOf(' Linha\r\nCAIXA '), expected);
  assert.strictEqual(digestOf('Linha\ncaixa'), digestOf('linha\rcaixa'));
});

test('digest difere quando whitespace intra-linha difere', () => {
  assert.notStrictEqual(digestOf('a b'), digestOf('a  b'));
});

test('regras são uma fronteira congelada e documentam a exclusão', () => {
  assert(Object.isFrozen(NORMALIZATION_RULES));
  assert(NORMALIZATION_RULES.some(rule => rule.includes('preserved')));
  assert.strictEqual(NORMALIZATION_RULES.length, 5);
});

test('normalização é determinística em chamadas repetidas', () => {
  const input = '  A  B\r\nC  ';
  assert.strictEqual(normalizeForCompare(input), normalizeForCompare(input));
  assert.strictEqual(digestOf(input), digestOf(input));
});

if (failed) {
  console.error(`\n${failed} falha(s), ${passed} passou(aram).`);
  process.exit(1);
}
console.log(`\nPASS: ${passed} testes`);
