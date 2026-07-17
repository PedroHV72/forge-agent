#!/usr/bin/env node
'use strict';

// Generates the long-form prefs reference (shared/forge-prefs-reference.md)
// from forge-prefs.schema.json (via loadSchema()). This is a pure PROJECTION
// of the schema: no hand-written per-knob prose. See T03-PLAN §Standards —
// mirrors the scaffold projection (S02): the doc is provable by
// regenerate-and-compare (see forge-prefs-reference.test.js).

const fs = require('fs');
const path = require('path');
const { loadSchema } = require('./forge-prefs.js');

const DEFAULT_OUT = path.join(__dirname, '..', 'shared', 'forge-prefs-reference.md');

function formatDefault(value) {
  if (value === undefined) return '_(sem default)_';
  return '`' + JSON.stringify(value) + '`';
}

function formatType(schemaNode) {
  const type = schemaNode.type;
  if (Array.isArray(type)) return type.join(' \\| ');
  return type || 'unknown';
}

function formatEnum(schemaNode) {
  if (!Array.isArray(schemaNode.enum)) return '';
  return schemaNode.enum.map((entry) => '`' + entry + '`').join(', ');
}

// Walks the schema's `properties` tree. A node with a nested `properties`
// object is a SECTION (recurse); any other node (scalar, or an object with
// no static `properties`, e.g. `routing`'s open/dynamic domain map) is a LEAF.
function collectLeaves(properties, prefix) {
  const leaves = [];
  const keys = Object.keys(properties);
  for (const key of keys) {
    const node = properties[key];
    const dottedPath = prefix ? `${prefix}.${key}` : key;
    if (node && typeof node === 'object' && node.properties && typeof node.properties === 'object') {
      leaves.push(...collectLeaves(node.properties, dottedPath));
    } else {
      leaves.push({ path: dottedPath, node });
    }
  }
  return leaves;
}

function renderReference(schema) {
  if (!schema || !schema.properties) {
    throw new Error('renderReference: schema is missing or has no top-level properties');
  }

  const lines = [];
  lines.push('# Forge Agent — Referência de Preferências');
  lines.push('');
  lines.push('> Documento gerado a partir de [`forge-prefs.schema.json`](../forge-prefs.schema.json)');
  lines.push('> via `scripts/forge-prefs-reference.js`. Não editar manualmente — rode');
  lines.push('> `node scripts/forge-prefs-reference.js --out shared/forge-prefs-reference.md`');
  lines.push('> após qualquer mudança no schema. Todo texto de descrição vem verbatim do campo');
  lines.push('> `description` de cada knob no schema — fonte única, zero drift.');
  lines.push('');

  const topKeys = Object.keys(schema.properties);
  for (const topKey of topKeys) {
    const topNode = schema.properties[topKey];
    lines.push(`## ${topKey}`);
    lines.push('');

    const isSection = topNode && typeof topNode === 'object' && topNode.properties && typeof topNode.properties === 'object';
    const leaves = isSection ? collectLeaves(topNode.properties, topKey) : [{ path: topKey, node: topNode }];
    const isSingleLeafTopKey = leaves.length === 1 && leaves[0].path === topKey;

    if (topNode && topNode.description && !isSingleLeafTopKey) {
      lines.push(topNode.description);
      lines.push('');
    }

    for (const leaf of leaves) {
      const node = leaf.node || {};
      lines.push(`### \`${leaf.path}\``);
      lines.push('');
      lines.push(`- **Tipo:** ${formatType(node)}`);
      lines.push(`- **Default:** ${formatDefault(node.default)}`);
      const enumText = formatEnum(node);
      if (enumText) lines.push(`- **Valores permitidos:** ${enumText}`);
      lines.push(`- **Descrição:** ${node.description || '_(sem descrição no schema)_'}`);
      lines.push('');
    }
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}

function main(argv) {
  const outIndex = argv.indexOf('--out');
  const hasOut = outIndex !== -1;
  const outArg = hasOut ? argv[outIndex + 1] : null;
  const outFile = hasOut ? (outArg && !outArg.startsWith('--') ? outArg : DEFAULT_OUT) : null;

  const schema = loadSchema();
  const markdown = renderReference(schema);

  if (outFile) {
    const target = path.isAbsolute(outFile) ? outFile : path.join(process.cwd(), outFile);
    fs.writeFileSync(target, markdown, 'utf8');
    process.stdout.write(`Wrote ${target}\n`);
  } else {
    process.stdout.write(markdown);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { renderReference };
