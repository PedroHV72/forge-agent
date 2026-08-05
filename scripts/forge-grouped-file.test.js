'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  GROUP_FORMAT,
  SWEEP_CONTAINER_RE,
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

// R1: markers were written latin1 and read back with the high bit stripped, so
// a non-ASCII id never matched its own end marker and the container parsed as
// ZERO units — after apply() had already deleted the sources.
test('round-trips a non-ASCII unit id byte for byte', () => {
  const id = 'M-20260101000000-x~NOTAS-revisão.md';
  const original = Buffer.from('corpo com acentuação\n', 'utf8');
  const grouped = serializeGroup({ epoch: '2026-Q1', units: [{ id, content: original }] });
  assert.strictEqual(grouped.skipped.length, 0);
  const parsed = parseGroup(grouped.buffer);
  assert.deepStrictEqual(parsed.errors, []);
  assert.strictEqual(parsed.units.length, 1);
  assert.strictEqual(parsed.units[0].id, id);
  assertBufferEqual(parsed.units[0].content, original);
});

test('declares bytes= as a byte count, not a character count', () => {
  const original = Buffer.from('ação', 'utf8'); // 6 bytes, 4 characters
  const grouped = serializeGroup({ epoch: '2026-Q1', units: [{ id: 'acentuado-é', content: original }] });
  assert.ok(grouped.buffer.toString('utf8').includes(`bytes=${original.length}`));
  assert.strictEqual(original.length, 6);
  assertBufferEqual(parseGroup(grouped.buffer).units[0].content, original);
});

test('refuses an id that does not survive a UTF-8 round-trip', () => {
  const grouped = serializeGroup({
    epoch: '2026-Q1',
    units: [unit('\ud800-lone', 'body', 'lone.md'), unit('ok', 'body')],
  });
  assert.deepStrictEqual(grouped.skipped, [{ path: 'lone.md', reason: 'id-not-utf8' }]);
  assert.strictEqual(parseGroup(grouped.buffer).units.length, 1);
});

// R8: every parse error branch breaks, so truncation returned a short unit list
// that readers presented as the whole store.
test('reports a member count that disagrees with the declared one', () => {
  const grouped = serializeGroup({ epoch: '2026-Q1', units: [unit('a', 'A'), unit('b', 'B')] });
  const truncated = grouped.buffer.subarray(0, grouped.buffer.length - 4);
  const parsed = parseGroup(truncated);
  assert.ok(parsed.errors.some(error => error.reason === 'unit-count-mismatch'),
    `expected unit-count-mismatch, got ${JSON.stringify(parsed.errors)}`);
});

test('does not report a count mismatch for an intact container', () => {
  assert.deepStrictEqual(parseGroup(validGroup().buffer).errors, []);
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

// --- S09 T03: sweep-project-NN identity, date range, PR-1 compatibility ---

test('SWEEP_CONTAINER_RE accepts sweep-generation names and rejects near-misses', () => {
  assert.strictEqual(SWEEP_CONTAINER_RE.test('sweep-project-01'), true);
  assert.strictEqual(SWEEP_CONTAINER_RE.test('sweep-project-137'), true);
  assert.strictEqual(SWEEP_CONTAINER_RE.test('sweep-project-1'), false);
  assert.strictEqual(SWEEP_CONTAINER_RE.test('sweep-project-'), false);
  assert.strictEqual(SWEEP_CONTAINER_RE.test('sweep-project-abc'), false);
  assert.strictEqual(SWEEP_CONTAINER_RE.test('2026-Q1'), false);
});

// W3: the name-based recognition path only matters in the buffer-LESS branch
// of isGroupedFile — the three readers (forge-ledger.js, forge-decisions.js,
// forge-memory.js) call it without a buffer exactly when the file is
// UNREADABLE, to warn instead of silently listing it as a loose fragment.
// A test that only checks a READABLE container proves nothing about DS9-1,
// because on that path the content already answers. These two plant a
// corrupted (unreadable) container of each name shape and assert the
// buffer-less call still recognizes it as a container by name alone.
test('W3: an unreadable sweep-project-NN container is still recognized by name (buffer-less)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-grouped-file-w3-'));
  const filePath = path.join(root, 'sweep-project-01.md');
  // Deliberately corrupt / unreadable content: not valid frontmatter at all.
  fs.writeFileSync(filePath, Buffer.from([0x00, 0xff, 0x00, 0xff]));
  // The reader pattern under test: sniff fails to read cleanly upstream (or
  // the caller chooses not to pass a buffer at all), so isGroupedFile is
  // invoked with only the name — exactly the unreadable-file path.
  assert.strictEqual(isGroupedFile(filePath), true,
    'a sweep-project-NN file must be recognized by name even when unreadable/corrupted');
});

test('W3: an unreadable legacy 2026-Q1 container is still recognized by name (buffer-less, DS9-1)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-grouped-file-w3-'));
  const filePath = path.join(root, '2026-Q1.md');
  fs.writeFileSync(filePath, Buffer.from([0x00, 0xff, 0x00, 0xff]));
  assert.strictEqual(isGroupedFile(filePath), true,
    'a legacy 2026-Q1 file must still be recognized by name even when unreadable/corrupted (DS9-1)');
});

test('a sweep-project-NN file WITH a buffer but no grouped_format is not a container', () => {
  const content = Buffer.from('# sweep-project-01.md\n\nnot a container at all\n', 'utf8');
  assert.strictEqual(isGroupedFile('sweep-project-01.md', content), false);
});

test('recognizes sweep-generation names alongside legacy epoch names in isGroupedFile', () => {
  assert.strictEqual(isGroupedFile('sweep-project-01.md'), true);
  assert.strictEqual(isGroupedFile('sweep-project-137.md'), true);
  assert.strictEqual(isGroupedFile('sweep-project-1.md'), false);
  assert.strictEqual(isGroupedFile('sweep-project-abc.md'), false);
  assert.strictEqual(isGroupedFile('2026-Q1.md'), true);
  assert.strictEqual(isGroupedFile('M-20260101000000-foo.md'), false);
});

test('serializeGroup + parseGroup round-trip label/from/to via the label field', () => {
  const grouped = serializeGroup({
    label: 'sweep-project-01',
    dateRange: { from: '2026-07-01', to: '2026-07-15' },
    units: [unit('a', 'A'), unit('b', 'B')],
  });
  const parsed = parseGroup(grouped.buffer);
  assert.strictEqual(parsed.label, 'sweep-project-01');
  assert.strictEqual(parsed.epoch, 'sweep-project-01', 'epoch must mirror label for existing readers');
  assert.strictEqual(parsed.from, '2026-07-01');
  assert.strictEqual(parsed.to, '2026-07-15');
});

test('serializeGroup accepts the legacy epoch alias for label', () => {
  const grouped = serializeGroup({ epoch: '2026-Q1', units: [unit('a', 'A')] });
  const parsed = parseGroup(grouped.buffer);
  assert.strictEqual(parsed.label, '2026-Q1');
  assert.strictEqual(parsed.epoch, '2026-Q1');
});

test('an unknown date range serializes to empty grouped_from/grouped_to fields, never omitted', () => {
  const grouped = serializeGroup({ label: 'sweep-project-02', units: [unit('a', 'A')] });
  const text = grouped.buffer.toString('utf8');
  assert.ok(text.includes('grouped_from: \n'), 'grouped_from must be present, empty');
  assert.ok(text.includes('grouped_to: \n'), 'grouped_to must be present, empty');
  const parsed = parseGroup(grouped.buffer);
  assert.strictEqual(parsed.from, null);
  assert.strictEqual(parsed.to, null);
});

// A container written by the PR 1 sweep never had grouped_from/grouped_to at
// all. This fixture is a hand-built literal string, not generated by the
// serializer above — generating it with the new serializer would only prove
// self-consistency, never compatibility with what actually shipped in PR 1.
test('parses a byte-literal PR-1-era container without error (grouped_from/grouped_to absent)', () => {
  const bodyA = Buffer.from('first body', 'utf8');
  const bodyB = Buffer.from('second body', 'utf8');
  const header = [
    '---',
    'grouped_format: forge-group@1',
    'grouped_epoch: 2026-Q1',
    'grouped_units: 2',
    '---',
    '',
    '',
  ].join('\n');
  const pieces = [
    Buffer.from(header, 'utf8'),
    Buffer.from(`<!-- forge:unit id=a bytes=${bodyA.length} -->\n`, 'utf8'),
    bodyA,
    Buffer.from('\n<!-- forge:endunit id=a -->\n', 'utf8'),
    Buffer.from(`<!-- forge:unit id=b bytes=${bodyB.length} -->\n`, 'utf8'),
    bodyB,
    Buffer.from('\n<!-- forge:endunit id=b -->\n', 'utf8'),
  ];
  const literalPr1Buffer = Buffer.concat(pieces);

  const parsed = parseGroup(literalPr1Buffer);
  assert.deepStrictEqual(parsed.errors, []);
  assert.strictEqual(parsed.units.length, 2);
  assert.strictEqual(parsed.label, '2026-Q1');
  assert.strictEqual(parsed.epoch, '2026-Q1');
  assert.strictEqual(parsed.from, null);
  assert.strictEqual(parsed.to, null);
});

test('serializeGroup with a date range stays byte-deterministic across calls', () => {
  const entries = [unit('b', 'B'), unit('a', 'A')];
  const one = serializeGroup({ label: 'sweep-project-03', dateRange: { from: '2026-01-01', to: '2026-01-31' }, units: entries });
  const two = serializeGroup({ label: 'sweep-project-03', dateRange: { from: '2026-01-01', to: '2026-01-31' }, units: [...entries].reverse() });
  assertBufferEqual(one.buffer, two.buffer);
  const text = one.buffer.toString('utf8');
  assert.ok(text.indexOf('id=a') < text.indexOf('id=b'), 'ordering by id is unchanged');
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error}`);
  process.exitCode = 1;
} else {
  console.log(`\n${passed} test(s) passed`);
}
