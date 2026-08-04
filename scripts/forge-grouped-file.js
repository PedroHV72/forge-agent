'use strict';

// Golden rule: the group format moves payloads only as Buffers.  File readers
// use fs.readFileSync(path) without an encoding and writers use a Buffer, so a
// UTF-8 conversion can never discard a BOM, normalize CRLF, or add a newline.

const fs = require('fs');

const { EPOCH_LABEL_RE } = require('./forge-epoch');

const GROUP_FORMAT = 'forge-group@1';
const PAYLOAD_DELIMITER = Buffer.from('<!-- forge:', 'ascii');
const FRONTMATTER_END = Buffer.from('---\n\n', 'ascii');
const UNIT_START_RE = /^<!-- forge:unit id=([^\s>]+) bytes=(\d+) -->\n/;

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : null;
}

function hasPayloadDelimiter(content) {
  return content.indexOf(PAYLOAD_DELIMITER) !== -1;
}

// Markers are UTF-8 on BOTH sides. A wrapper marker id embeds an arbitrary
// on-disk filename, which cannot be constrained to ASCII. Encoding with 'ascii'
// (latin1 on encode, high bit stripped on decode) was asymmetric: an id written
// one way read back mangled, markerEnd never matched, and parseGroup returned
// zero units for the whole container. bytes= stays a BYTE count either way —
// it is Buffer.length, never String.length.
function markerStart(id, bytes) {
  return Buffer.from(`<!-- forge:unit id=${id} bytes=${bytes} -->\n`, 'utf8');
}

function markerEnd(id) {
  return Buffer.from(`\n<!-- forge:endunit id=${id} -->\n`, 'utf8');
}

// An id that does not survive a UTF-8 round-trip (a lone surrogate) would be
// written mangled and could never be matched back. Refuse it at write time
// rather than produce a container whose members are unreachable.
function utf8RoundTrips(id) {
  return Buffer.from(id, 'utf8').toString('utf8') === id;
}

function serializeGroup({ epoch, units } = {}) {
  const skipped = [];
  const accepted = [];

  for (const unit of Array.isArray(units) ? units : []) {
    const content = asBuffer(unit && unit.content);
    if (!content) {
      skipped.push({ path: unit && unit.path, reason: 'invalid-content' });
      continue;
    }
    if (typeof unit.id !== 'string' || !unit.id || /[\s>]/.test(unit.id)) {
      skipped.push({ path: unit.path, reason: 'invalid-id' });
      continue;
    }
    if (!utf8RoundTrips(unit.id)) {
      skipped.push({ path: unit.path, reason: 'id-not-utf8' });
      continue;
    }
    if (hasPayloadDelimiter(content)) {
      skipped.push({ path: unit.path, reason: 'delimiter-in-payload' });
      continue;
    }
    accepted.push({ id: unit.id, content });
  }

  accepted.sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const header = [
    '---',
    `grouped_format: ${GROUP_FORMAT}`,
    `grouped_epoch: ${typeof epoch === 'string' ? epoch : ''}`,
    `grouped_units: ${accepted.length}`,
    '---',
    '',
    '',
  ].join('\n');
  const pieces = [Buffer.from(header, 'utf8')];
  for (const unit of accepted) {
    pieces.push(markerStart(unit.id, unit.content.length));
    pieces.push(unit.content);
    // This separator is outside bytes= and is deliberately emitted even when
    // the payload itself already ends with a newline.
    pieces.push(markerEnd(unit.id));
  }
  return { buffer: Buffer.concat(pieces), skipped };
}

function parseFrontmatter(buffer, errors) {
  const end = buffer.indexOf(FRONTMATTER_END);
  if (end === -1) {
    errors.push({ id: null, reason: 'invalid-frontmatter' });
    return { fields: {}, offset: buffer.length, valid: false };
  }
  const lines = buffer.subarray(0, end).toString('utf8').split('\n');
  if (lines.shift() !== '---') {
    errors.push({ id: null, reason: 'invalid-frontmatter' });
    return { fields: {}, offset: end + FRONTMATTER_END.length, valid: false };
  }
  const fields = {};
  for (const line of lines) {
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  if (fields.grouped_format !== GROUP_FORMAT) {
    errors.push({ id: null, reason: 'unsupported-format' });
    return { fields, offset: end + FRONTMATTER_END.length, valid: false };
  }
  return { fields, offset: end + FRONTMATTER_END.length, valid: true };
}

function parseStartAt(buffer, offset) {
  const end = buffer.indexOf(Buffer.from('\n', 'ascii'), offset);
  if (end === -1) return null;
  // utf8, symmetrically with markerStart. Scanning for 0x0A above is still
  // safe: no UTF-8 continuation byte can be 0x0A.
  const line = buffer.subarray(offset, end + 1).toString('utf8');
  const match = UNIT_START_RE.exec(line);
  if (!match) return null;
  return { id: match[1], bytes: Number(match[2]), next: end + 1 };
}

function parseGroup(value) {
  const buffer = asBuffer(value);
  const errors = [];
  const units = [];
  if (!buffer) {
    return { epoch: null, format: null, units, errors: [{ id: null, reason: 'invalid-buffer' }] };
  }

  const frontmatter = parseFrontmatter(buffer, errors);
  const result = {
    epoch: frontmatter.fields.grouped_epoch || null,
    format: frontmatter.fields.grouped_format || null,
    units,
    errors,
  };
  if (!frontmatter.valid) return result;

  let offset = frontmatter.offset;
  while (offset < buffer.length) {
    const start = parseStartAt(buffer, offset);
    if (!start) {
      errors.push({ id: null, reason: 'invalid-unit-marker' });
      break;
    }
    const payloadEnd = start.next + start.bytes;
    if (!Number.isSafeInteger(start.bytes) || payloadEnd > buffer.length) {
      errors.push({ id: start.id, reason: 'payload-out-of-bounds' });
      break;
    }
    const endMarker = markerEnd(start.id);
    const markerEndOffset = payloadEnd + endMarker.length;
    if (markerEndOffset > buffer.length ||
        !buffer.subarray(payloadEnd, markerEndOffset).equals(endMarker)) {
      errors.push({ id: start.id, reason: 'end-marker-mismatch' });
      break;
    }
    units.push({ id: start.id, content: Buffer.from(buffer.subarray(start.next, payloadEnd)) });
    offset = markerEndOffset;
  }
  // Every error branch above breaks, so a container damaged at member 3 of 40
  // parses as 2 units. Without this check readers list those 2 as the entire
  // store — silent truncation. grouped_units is what the writer declared.
  if (frontmatter.fields.grouped_units !== String(units.length)) {
    errors.push({ id: null, reason: 'unit-count-mismatch' });
  }
  return result;
}

function isGroupedFile(nameOrPath, buffer) {
  // With a supplied buffer, frontmatter is authoritative; without one, the
  // epoch-shaped filename is the intentionally weaker discovery signal.
  if (buffer !== undefined && buffer !== null) {
    const content = asBuffer(buffer);
    if (!content) return false;
    const end = content.indexOf(FRONTMATTER_END);
    return end !== -1 && content.subarray(0, end).toString('utf8')
      .split('\n').includes(`grouped_format: ${GROUP_FORMAT}`);
  }
  const name = String(nameOrPath || '').replace(/^.*[\\/]/, '').replace(/\.md$/, '');
  return EPOCH_LABEL_RE.test(name);
}

function readGroupedUnits(filePath) {
  return parseGroup(fs.readFileSync(filePath));
}

function unitTextOf(unitBuffer) {
  const buffer = asBuffer(unitBuffer);
  return buffer ? buffer.toString('utf8') : '';
}

// Fields the grouping layer adds to a store's listFragments() entries. They are
// additive on the LIBRARY API and internal to it: a container is an on-disk
// packing detail, not part of the identity of a unit.
const INTERNAL_ENTRY_FIELDS = ['grouped', 'epoch'];

// The projection that turns a rich library entry into a frozen CLI row.
//
// Two shapes exist on purpose. `listFragments()` is the library API and MAY
// grow fields as the storage format evolves; `--list` stdout is an EXTERNAL
// contract that skills and scripts parse by key, so it must not gain keys when
// the format changes. forge-schema-guard-wiring.test.js asserts exactly that.
//
// The projection removes the internal fields rather than whitelisting stable
// ones because the stable row shape differs per store — ledger `{id,path}`,
// decisions `{unitId,path}`, memory `{...parseStorageKey(),path}` — and a
// whitelist would silently drop memory's key columns.
function publicEntry(entry) {
  const projected = { ...entry };
  for (const field of INTERNAL_ENTRY_FIELDS) delete projected[field];
  return projected;
}

// Read a fragment purely to SNIFF whether it is a container.
//
// Returning null on failure instead of throwing keeps the blast radius of one
// unreadable file at one file. Enumeration in the stores predates the grouped
// format and never read content: a broken `.md` surfaced at the consumer, one
// unit at a time. Letting a sniff error escape would instead collapse the whole
// store to an empty list — the silently-degrading reader this format exists to
// prevent. On failure the file is simply not classified as a container and its
// entry is still returned, so the real read (and the real error) stays with the
// consumer, exactly where it was before grouping existed.
function readSniffBuffer(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (_) {
    return null;
  }
}

module.exports = {
  GROUP_FORMAT,
  INTERNAL_ENTRY_FIELDS,
  serializeGroup,
  parseGroup,
  isGroupedFile,
  readGroupedUnits,
  readSniffBuffer,
  publicEntry,
  unitTextOf,
};
