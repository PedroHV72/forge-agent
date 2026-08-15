'use strict';

const crypto = require('crypto');

// These rules are intentionally narrow: this is a comparison fingerprint,
// not a claim about the integrity or authenticity of a fragment.
const NORMALIZATION_RULES = Object.freeze([
  'line-endings: CRLF and lone CR become LF',
  'line-boundary-whitespace: trailing spaces and tabs are removed per line',
  'outer-whitespace: surrounding whitespace is trimmed after line processing',
  'case: text is compared using toLowerCase()',
  'intra-line-whitespace: runs inside a line are preserved',
]);

// Keep this operation pure so callers can use it at read time without
// changing the source fragment. String() also makes the boundary explicit for
// values supplied by an envelope parser or a test double.
//
// The order below is observable: line cleanup precedes outer trim, and case
// folding is last. In particular, no regular expression here replaces runs
// of spaces between non-boundary characters.
// A caller that needs a different equivalence relation must name and test it.
// Keeping the implementation here also prevents store-specific I/O concerns.
function normalizeForCompare(text) {
  const lines = String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''));
  return lines.join('\n').trim().toLowerCase();
}

// The digest is only a compact grouping key. Consumers must still retain the
// original envelope when presenting a candidate to a human or later action.
function digestOf(text) {
  return crypto
    .createHash('sha256')
    .update(normalizeForCompare(text), 'utf8')
    .digest('hex');
}

module.exports = {
  normalizeForCompare,
  digestOf,
  NORMALIZATION_RULES,
};
