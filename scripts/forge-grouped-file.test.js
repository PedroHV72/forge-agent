'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  GROUP_FORMAT,
  serializeGroup,
  parseGroup,
  isGroupedFile,
  readGroupedUnits,
  unitTextOf,
} = require('./forge-grouped-file');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error: error.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${error.message}`);
  }
}

function assertBufferEqual(actual, expected, message) {
  assert.strictEqual(Buffer.compare(actual, expected), 0, message);
}

function unit(id, content, filePath) {
  return { id, path: filePath || `${id}.md`, content: Buffer.from(content) };
}

function validGroup() {
  return serializeGroup({
    epoch: '2026-Q1',
    units: [unit('u-b', 'second'), unit('u-a', 'first')],
  });
}

test('exports the locked group format', () => {
  assert.strictEqual(GROUP_FORMAT, 'forge-group@1');
});

test('round-trips CRLF content without normalization', () => {
  const original = Buffer.from('alpha\r\nbeta\r\n', 'utf8');
  const grouped = serializeGroup({ epoch: '2026-Q1', units: [{ id: 'crlf', content: original }] });
  const parsed = parseGroup(grouped.buffer);
  assert.strictEqual(parsed.errors.length, 0);
  assertBufferEqual(parsed.units[0].content, original);
});

test('round-trips a UTF-8 BOM byte for byte', () => {
  const original = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
  const grouped = serializeGroup({ epoch: '2026-Q1', units: [{ id: 'bom', content: original }] });
  const parsed = parseGroup(grouped.buffer);
  assert.strictEqual(parsed.errors.length, 0);
  assertBufferEqual(parsed.units[0].content, original);
});

test('round-trips a payload without a final newline', () => {
  const original = Buffer.from('last byte');
  const grouped = serializeGroup({ epoch: '2026-Q1', units: [{ id: 'nonewline', content: original }] });
  const parsed = parseGroup(grouped.buffer);
  assert.strictEqual(parsed.errors.length, 0);
  assertBufferEqual(parsed.units[0].content, original);
});

test('round-trips every member in a mixed three-unit group', () => {
  const originals = [
    unit('z-crlf', 'a\r\nb\r\n'),
    { id: 'a-bom', path: 'bom.md', content: Buffer.from([0xef, 0xbb, 0xbf, 0x78]) },
    unit('m-final', 'no trailing newline'),
  ];
  const grouped = serializeGroup({ epoch: '2026-Q1', units: originals });
  const parsed = parseGroup(grouped.buffer);
  assert.strictEqual(parsed.errors.length, 0);
  const byId = new Map(parsed.units.map(value => [value.id, value.content]));
  for (const original of originals) assertBufferEqual(byId.get(original.id), original.content, original.id);
});

test('serializes unit ids in ascending English locale order', () => {
  const grouped = validGroup();
  const text = grouped.buffer.toString('utf8');
  assert.ok(text.indexOf('id=u-a') < text.indexOf('id=u-b'));
});

test('is byte-identical when serialized again with the same entries', () => {
  const entries = [unit('b', 'B'), unit('a', 'A')];
  const one = serializeGroup({ epoch: '2026-Q1', units: entries });
  const two = serializeGroup({ epoch: '2026-Q1', units: entries });
  assertBufferEqual(one.buffer, two.buffer);
});

test('internally sorts reversed inputs to the same container bytes', () => {
  const entries = [unit('a', 'A'), unit('b', 'B')];
  const forward = serializeGroup({ epoch: '2026-Q1', units: entries });
  const reverse = serializeGroup({ epoch: '2026-Q1', units: [...entries].reverse() });
  assertBufferEqual(forward.buffer, reverse.buffer);
});

test('declares the number of actually serialized members', () => {
  const grouped = serializeGroup({
    epoch: '2026-Q1',
    units: [unit('keep', 'safe'), unit('skip', '<!-- forge:unit id=x bytes=0 -->')],
  });
  assert.ok(grouped.buffer.toString('utf8').includes('grouped_units: 1'));
  assert.strictEqual(parseGroup(grouped.buffer).units.length, 1);
});

test('returns the frontmatter epoch and format to readers', () => {
  const parsed = parseGroup(validGroup().buffer);
  assert.strictEqual(parsed.epoch, '2026-Q1');
  assert.strictEqual(parsed.format, GROUP_FORMAT);
});

test('keeps the separator before an end marker outside payload bytes', () => {
  const original = Buffer.from('payload');
  const grouped = serializeGroup({ epoch: '2026-Q1', units: [{ id: 'edge', content: original }] });
  const parsed = parseGroup(grouped.buffer);
  assert.strictEqual(parsed.units[0].content.length, original.length);
  assertBufferEqual(parsed.units[0].content, original);
});

test('refuses a payload containing a forge delimiter', () => {
  const grouped = serializeGroup({
    epoch: '2026-Q1',
    units: [unit('unsafe', 'text <!-- forge:unit id=fake bytes=0 -->', 'unsafe.md')],
  });
  assert.strictEqual(grouped.skipped.length, 1);
  assert.deepStrictEqual(grouped.skipped[0], { path: 'unsafe.md', reason: 'delimiter-in-payload' });
  assert.ok(!grouped.buffer.toString('utf8').includes('unsafe'));
});

test('reports an oversized bytes declaration without returning a partial unit', () => {
  const grouped = validGroup();
  const corrupt = Buffer.from(grouped.buffer.toString('utf8').replace('bytes=5', 'bytes=999'));
  const parsed = parseGroup(corrupt);
  assert.ok(parsed.errors.some(error => error.reason === 'payload-out-of-bounds'));
  assert.strictEqual(parsed.units.length, 0);
});

test('reports an end marker with a divergent id without returning that payload', () => {
  const grouped = serializeGroup({ epoch: '2026-Q1', units: [unit('known', 'body')] });
  const corrupt = Buffer.from(grouped.buffer.toString('utf8').replace('endunit id=known', 'endunit id=other'));
  const parsed = parseGroup(corrupt);
  assert.ok(parsed.errors.some(error => error.reason === 'end-marker-mismatch'));
  assert.strictEqual(parsed.units.length, 0);
});

test('recognizes epoch-named containers and rejects ordinary fragments', () => {
  assert.strictEqual(isGroupedFile('2026-Q1.md'), true);
  assert.strictEqual(isGroupedFile('M-20260101000000-foo.md'), false);
});

test('uses supplied frontmatter as the authoritative grouping signal', () => {
  const grouped = validGroup();
  assert.strictEqual(isGroupedFile('ordinary.md', grouped.buffer), true);
  assert.strictEqual(isGroupedFile('2026-Q1.md', Buffer.from('ordinary fragment')), false);
});

test('readGroupedUnits reads bytes from disk before parsing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-grouped-file-'));
  const filePath = path.join(root, '2026-Q1.md');
  const grouped = validGroup();
  fs.writeFileSync(filePath, grouped.buffer);
  const parsed = readGroupedUnits(filePath);
  assert.strictEqual(parsed.errors.length, 0);
  assert.strictEqual(parsed.units.length, 2);
});

test('unitTextOf supplies the explicit reader-facing UTF-8 conversion', () => {
  assert.strictEqual(unitTextOf(Buffer.from('reader text')), 'reader text');
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error}`);
  process.exitCode = 1;
} else {
  console.log(`\n${passed} test(s) passed`);
}
