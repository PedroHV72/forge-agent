#!/usr/bin/env node
'use strict';

// Coverage + drift guard for shared/forge-prefs-reference.md.
//   1. Every schema leaf dotted path must appear in the committed doc.
//   2. The committed doc must equal a fresh renderReference() output after
//      normalizing checkout line endings — forces a regen whenever the schema
//      changes without making Git's Windows CRLF conversion a false failure.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { renderReference } = require('./forge-prefs-reference.js');
const { loadSchema } = require('./forge-prefs.js');

const DOC_PATH = path.join(__dirname, '..', 'shared', 'forge-prefs-reference.md');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${error.message}`);
  }
}

function collectLeafPaths(properties, prefix) {
  const paths = [];
  for (const key of Object.keys(properties)) {
    const node = properties[key];
    const dottedPath = prefix ? `${prefix}.${key}` : key;
    if (node && typeof node === 'object' && node.properties && typeof node.properties === 'object') {
      paths.push(...collectLeafPaths(node.properties, dottedPath));
    } else {
      paths.push(dottedPath);
    }
  }
  return paths;
}

const schema = loadSchema();
assert.ok(schema, 'loadSchema() must return the schema (forge-prefs.schema.json missing?)');

const leafPaths = collectLeafPaths(schema.properties, '');
assert.ok(leafPaths.length > 0, 'schema must have at least one leaf knob');

test(`committed doc exists at ${DOC_PATH}`, () => {
  assert.ok(fs.existsSync(DOC_PATH), 'shared/forge-prefs-reference.md is missing');
});

const committed = fs.readFileSync(DOC_PATH, 'utf8');
const committedCanonical = committed.replace(/\r\n/g, '\n');

test(`coverage: all ${leafPaths.length} schema leaf paths present in committed doc`, () => {
  const missing = leafPaths.filter((leafPath) => !committed.includes(`\`${leafPath}\``));
  assert.deepStrictEqual(missing, [], `missing knob paths in doc: ${missing.join(', ')}`);
});

test('drift guard: committed doc equals a fresh renderReference(loadSchema()) render', () => {
  const fresh = renderReference(schema);
  assert.strictEqual(
    committedCanonical,
    fresh,
    'shared/forge-prefs-reference.md is stale — regenerate with: node scripts/forge-prefs-reference.js --out shared/forge-prefs-reference.md'
  );
});

test('renderReference output has no schema-declared stub markers', () => {
  const stubPatterns = ['TODO', 'TBD', '(pendente)', 'XXX', 'PLACEHOLDER'];
  for (const pattern of stubPatterns) {
    assert.ok(!committed.includes(pattern), `doc contains stub marker: ${pattern}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
