#!/usr/bin/env node
'use strict';

// Cold-path scaffold generator. Descriptions and knob values come from the
// schema ONLY. The off-marker grammar is exactly the three-character prefix
// `// ` before JSON structural lines; remove it to activate a line.

const fs = require('fs');
const path = require('path');
const { loadSchema, parseJsonc, stripJsonc, validatePrefs } = require('./forge-prefs.js');

const OFF_MARKER = /^(\s*)\/\/ (?=["{}\]])/;

const SETUP_KNOBS = [
  'auto_commit', 'merge_strategy', 'main_branch', 'auto_push',
  'review.mode', 'review.style', 'review.challenger', 'review.advocate',
  'review.challenger_model', 'review.advocate_model',
  'tier_models.light', 'tier_models.standard', 'tier_models.heavy', 'tier_models.max',
  'routing', 'forge_isolation.mode',
];

function isOffMarker(line) {
  return OFF_MARKER.test(line);
}

function stripOffMarker(line) {
  return line.replace(OFF_MARKER, '$1');
}

function defaultsFromSchema(schema) {
  const result = {};
  function walk(node, target) {
    if (!node || typeof node !== 'object' || !node.properties) return;
    for (const [key, child] of Object.entries(node.properties)) {
      if (Object.prototype.hasOwnProperty.call(child, 'default')) {
        target[key] = child.default;
      } else if (child.properties) {
        target[key] = {};
        walk(child, target[key]);
      }
    }
  }
  walk(schema, result);
  delete result.$schema;
  return result;
}

function wrapDescription(text, width) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current && current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : ['·'];
}

function docLines(text, indent) {
  return wrapDescription(text, Math.max(40, 100 - indent.length - 3)).map((line) => {
    let safe = line;
    if (/^["{}\]]/.test(safe)) safe = `· ${safe}`;
    return `${indent}// ${safe}`;
  });
}

function jsonValue(value) {
  return JSON.stringify(value);
}

function renderKnob(key, node, indent, isLast) {
  const suffix = isLast ? '' : ',';
  return [`${indent}\"${key}\": ${jsonValue(node.default)}${suffix}`];
}

function renderNode(key, node, indent, isLast) {
  const lines = [];
  const suffix = isLast ? '' : ',';
  if (node.description) lines.push(...docLines(node.description, indent));
  if (Object.prototype.hasOwnProperty.call(node, 'default') && !node.properties) {
    lines.push(...renderKnob(key, node, indent, isLast));
    return lines;
  }
  if (node.properties) {
    lines.push(`${indent}\"${key}\": {`);
    const entries = Object.entries(node.properties);
    entries.forEach(([childKey, child], index) => {
      lines.push(...renderNode(childKey, child, `${indent}  `, index === entries.length - 1));
    });
    lines.push(`${indent}}${suffix}`);
    return lines;
  }
  if (Object.prototype.hasOwnProperty.call(node, 'default')) {
    lines.push(`${indent}\"${key}\": ${jsonValue(node.default)}${suffix}`);
  }
  return lines;
}

function offBlock(lines, baseIndent) {
  return lines.map((line) => {
    const match = line.match(/^(\s*)/);
    const indentation = match ? match[1] : '';
    return `${baseIndent}${indentation}// ${line.slice(indentation.length)}`;
  });
}

function renderSection(key, node, isLast) {
  const body = renderNode(key, node, '', isLast);
  const commentify = (line) => {
    if (/^\s*\/\/ /.test(line)) return line;
    const indentation = line.match(/^\s*/)[0];
    return `${indentation}// ${line.slice(indentation.length)}`;
  };
  return [
    `// ── ${key} ${'─'.repeat(Math.max(2, 72 - key.length))}`,
    ...body.map(commentify),
  ];
}

function generateScaffold(schema, opts = {}) {
  if (!schema || typeof schema !== 'object' || !schema.properties) {
    throw new TypeError('schema with properties is required');
  }
  const schemaRef = opts.schemaRef || 'forge-prefs.schema.json';
  const lines = [
    '// Catálogo gerado por forge-prefs-scaffold.js.',
    '// Para ativar uma linha, descomente removendo exatamente `// `.',
    '// Referência completa: shared/forge-prefs-reference.md',
    '{',
    `  \"$schema\": ${JSON.stringify(schemaRef)},`,
  ];
  const sections = Object.entries(schema.properties).filter(([key]) => key !== '$schema');
  sections.forEach(([key, node], index) => {
    lines.push(...renderSection(key, node, index === sections.length - 1).map((line) => `  ${line}`));
  });
  // The active schema key is deliberately the only active preference. All
  // generated section lines carry the marker, including their punctuation.
  lines.push('}');
  return lines.map((line, index) => {
    if (index < 4 || line === '}') return line;
    if (line.startsWith('  // ')) return line;
    return line;
  }).join('\n') + '\n';
}

function setupTree() {
  const root = {};
  for (const dottedPath of SETUP_KNOBS) {
    const parts = dottedPath.split('.');
    let cursor = root;
    parts.forEach((part, index) => {
      if (!cursor[part]) cursor[part] = { children: {}, paths: [] };
      if (index < parts.length - 1) cursor = cursor[part].children;
      else cursor[part].paths.push(dottedPath);
    });
  }
  return root;
}

function setupHasActive(entry, activeValues) {
  return entry.paths.some((key) => Object.prototype.hasOwnProperty.call(activeValues, key)) ||
    Object.values(entry.children).some((child) => setupHasActive(child, activeValues));
}

function setupOff(lines) {
  return lines.map((line) => {
    if (/^\s*\/\//.test(line)) return line;
    const indentation = line.match(/^\s*/)[0];
    return `${indentation}// ${line.slice(indentation.length)}`;
  });
}

function renderSetupEntry(key, entry, schemaEntry, indent, activeValues, pathParts, isLast) {
  const dottedPath = pathParts.concat(key).join('.');
  const hasChildren = Object.keys(entry.children).length > 0;
  const active = setupHasActive(entry, activeValues);
  if (!hasChildren) {
    const node = Object.prototype.hasOwnProperty.call(activeValues, dottedPath)
      ? { ...schemaEntry, default: activeValues[dottedPath] }
      : schemaEntry;
    const lines = [];
    if (node.description) lines.push(...docLines(node.description, indent));
    lines.push(...renderKnob(key, node, indent, isLast));
    return active ? lines : setupOff(lines);
  }

  const childEntries = Object.entries(entry.children);
  const activeChildren = childEntries.filter(([, child]) => setupHasActive(child, activeValues));
  const lines = [];
  if (schemaEntry.description) lines.push(...docLines(schemaEntry.description, indent));
  lines.push(`${indent}"${key}": {`);
  childEntries.forEach(([childKey, child], index) => {
    const childSchema = schemaEntry.properties[childKey];
    const childIsLast = activeChildren.length === 0
      ? index === childEntries.length - 1
      : index === childEntries.length - 1 || !childEntries.slice(index + 1).some(([, next]) => setupHasActive(next, activeValues));
    lines.push(...renderSetupEntry(childKey, child, childSchema, `${indent}  `, activeValues, pathParts.concat(key), childIsLast));
  });
  lines.push(`${indent}}${isLast ? '' : ','}`);
  return active ? lines : setupOff(lines);
}

function generateSetupScaffold(schema, opts = {}) {
  if (!schema || typeof schema !== 'object' || !schema.properties) {
    throw new TypeError('schema with properties is required');
  }
  const activeValues = opts.activeValues || {};
  const tree = setupTree();
  const lines = [
    `// ${opts.header || 'Setup inicial do projeto'}`,
    '// Configure as escolhas abaixo; linhas comentadas mostram os defaults do schema.',
    '{',
    `  "$schema": ${jsonValue(opts.schemaRef || 'forge-prefs.schema.json')},`,
  ];
  const entries = Object.entries(tree);
  const activeEntries = entries.filter(([, entry]) => setupHasActive(entry, activeValues));
  entries.forEach(([key, entry], index) => {
    const node = schema.properties[key];
    if (!node) throw new Error(`schema path missing: ${key}`);
    const isLastActive = !entries.slice(index + 1).some(([, next]) => setupHasActive(next, activeValues));
    lines.push(...renderSetupEntry(key, entry, node, '  ', activeValues, [], isLastActive || activeEntries.length === 0));
  });
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

// Catalog merging is deliberately based on this shape-preserving JSONC mask,
// never on a regexp over the source.  Apart from protecting URLs and escaped
// quotes, retaining offsets lets every user-owned slice be copied verbatim.
function readQuoted(mask, start) {
  if (mask[start] !== '"') return null;
  let value = '';
  for (let index = start + 1; index < mask.length; index++) {
    if (mask[index] === '\\') {
      value += mask[index] + (mask[index + 1] || '');
      index++;
    } else if (mask[index] === '"') {
      try { return { value: JSON.parse(`"${value}"`), end: index + 1 }; } catch { return null; }
    } else value += mask[index];
  }
  return null;
}

function nextNonWhitespace(text, index) {
  while (index < text.length && /[ \t\r\n]/.test(text[index])) index++;
  return index;
}

function rootKeys(mask) {
  const result = [];
  let depth = 0;
  for (let index = 0; index < mask.length; index++) {
    const character = mask[index];
    if (character === '"') {
      const quoted = readQuoted(mask, index);
      if (!quoted) continue;
      const colon = nextNonWhitespace(mask, quoted.end);
      if (depth === 1 && mask[colon] === ':') result.push({ key: quoted.value, start: index });
      index = quoted.end - 1;
    } else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') depth--;
  }
  return result;
}

function rootClose(mask) {
  let depth = 0;
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] === '"') {
      const quoted = readQuoted(mask, index);
      if (quoted) { index = quoted.end - 1; continue; }
    }
    if (mask[index] === '{') depth++;
    else if (mask[index] === '}' && --depth === 0) return index;
  }
  return mask.length;
}

function lineStart(text, index) {
  const newline = text.lastIndexOf('\n', Math.max(0, index - 1));
  return newline === -1 ? 0 : newline + 1;
}

function commentedRootKeys(text) {
  const result = [];
  let offset = 0;
  let sectionKey = null;
  let sectionStart = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const trimmed = line.trimStart();
    // Section banners are presentation, not JSON.  Read them character by
    // character and use the following OFF_MARKER line to confirm the key.
    if (trimmed.startsWith('// ── ')) {
      const after = trimmed.slice('// ── '.length);
      const boundary = after.indexOf(' ─');
      sectionKey = boundary === -1 ? null : after.slice(0, boundary);
      sectionStart = offset;
    } else if (isOffMarker(line)) {
      const uncommented = stripOffMarker(line);
      const mask = stripJsonc(uncommented);
      const quote = nextNonWhitespace(mask, 0);
      const quoted = readQuoted(mask, quote);
      const colon = quoted && nextNonWhitespace(mask, quoted.end);
      if (sectionKey && quoted && quoted.value === sectionKey && mask[colon] === ':') {
        result.push({ key: quoted.value, start: sectionStart });
        sectionKey = null;
      }
    }
    offset += line.length;
  }
  return result;
}

function headerStart(text, start) {
  // Generated headers and user notes immediately above a section travel with
  // that section.  Stop at real JSON code; comments have already been masked.
  let cursor = lineStart(text, start);
  let candidate = cursor;
  while (candidate > 0) {
    const previousEnd = candidate - 1;
    const previous = lineStart(text, previousEnd);
    const line = text.slice(previous, candidate);
    if (/^\s*\/\/ ── /.test(line)) return previous;
    if (line.trim() === '' || /^\s*\/\//.test(line)) {
      candidate = previous;
      continue;
    }
    break;
  }
  return candidate;
}

/**
 * Return source-offset segments for a top-level JSONC catalogue.  `raw` is a
 * direct source slice, so callers can prove preservation using indexOf.
 */
function segmentCatalog(text) {
  if (typeof text !== 'string') throw new TypeError('catalog text must be a string');
  const mask = stripJsonc(text);
  const close = rootClose(mask);
  const anchors = [];
  for (const entry of rootKeys(mask)) anchors.push({ ...entry, kind: entry.key === '$schema' ? 'schema-key' : 'active' });
  for (const entry of commentedRootKeys(text)) anchors.push({ ...entry, kind: 'commented' });
  anchors.sort((left, right) => left.start - right.start || (left.kind === 'commented' ? -1 : 1));
  const unique = anchors.filter((entry, index) => index === 0 || entry.start !== anchors[index - 1].start);
  const segments = [];
  let consumed = 0;
  for (let index = 0; index < unique.length; index++) {
    const entry = unique[index];
    const start = Math.max(consumed, entry.kind === 'commented' ? entry.start : headerStart(text, entry.start));
    if (start > consumed) {
      const raw = text.slice(consumed, start);
      segments.push({ key: null, kind: consumed === 0 ? 'header' : 'unrecognized', start: consumed, end: start, raw });
    }
    const next = unique[index + 1];
    // A following active foreign key may sit below the banner of the preceding
    // commented section.  Its banner belongs to that prior section, so use the
    // actual key offset as the boundary and avoid an overlapping zero segment.
    const end = next ? next.start : close;
    if (end > start) segments.push({ key: entry.key, kind: entry.kind, start, end, raw: text.slice(start, end) });
    consumed = Math.max(consumed, end);
  }
  if (consumed < text.length) segments.push({ key: null, kind: consumed === 0 ? 'header' : 'unrecognized', start: consumed, end: text.length, raw: text.slice(consumed) });
  return segments;
}

function catalogDiff(text, schema) {
  if (!schema || !schema.properties) throw new TypeError('schema with properties is required');
  const present = new Set(segmentCatalog(text).filter((segment) => segment.key).map((segment) => segment.key));
  return { missingSections: Object.keys(schema.properties).filter((key) => key !== '$schema' && !present.has(key)) };
}

function generatedSection(key, node, isLast) {
  return renderSection(key, node, isLast).map((line) => `  ${line}`).join('\n') + '\n';
}

/**
 * Merge schema additions without normalising any existing user source.  The
 * only newly-rendered bytes are absent, commented schema sections.
 */
function rescaffoldCatalog(existingText, schema, opts = {}) {
  if (!schema || !schema.properties) throw new TypeError('schema with properties is required');
  const schemaKeys = Object.keys(schema.properties).filter((key) => key !== '$schema');
  const segments = segmentCatalog(existingText);
  const warnings = [];
  const known = new Set(schemaKeys);
  const seen = new Set();
  for (const segment of segments) {
    if (segment.key === '$schema') continue;
    if (segment.key) {
      if (known.has(segment.key)) seen.add(segment.key);
      else warnings.push({ code: 'unknown-section', message: `Unknown catalogue section: ${segment.key}` });
    } else if (segment.kind === 'unrecognized' && segment.raw.replace(/[}\s]/g, '') !== '') {
      warnings.push({ code: 'unrecognized-content', message: 'Unrecognized catalogue content was kept unchanged' });
    }
  }
  const addedSections = catalogDiff(existingText, schema).missingSections;
  const additions = new Map();
  for (const key of addedSections) {
    const order = schemaKeys.indexOf(key);
    let target = -1;
    for (let prior = order - 1; prior >= 0; prior--) {
      target = segments.map((segment) => segment.key).lastIndexOf(schemaKeys[prior]);
      if (target !== -1) break;
    }
    if (target === -1) {
      target = segments.length - 1;
      while (target >= 0 && segments[target].key === null) target--;
    }
    if (!additions.has(target)) additions.set(target, []);
    additions.get(target).push(key);
  }
  // Generated sections always start with a `// ── key ──` banner comment,
  // which is only recognised (by commentedRootKeys) when it begins its own
  // physical line. Splicing generated text right after raw source that has
  // no trailing newline (e.g. a single-line `{"$schema":"..."}` catalogue, or
  // a root close with no preceding newline) would fuse the banner onto the
  // previous line as a trailing comment — silently invisible to the parser.
  const withNewline = (text) => (text === '' || text.endsWith('\n') ? text : `${text}\n`);
  let output = '';
  const hasSchema = segments.some((segment) => segment.key === '$schema');
  for (let index = 0; index < segments.length; index++) {
    output += segments[index].raw;
    const keys = additions.get(index) || [];
    if (keys.length) output = withNewline(output);
    for (const key of keys) output += generatedSection(key, schema.properties[key], false);
  }
  if (additions.has(-1)) {
    // No keyed segment exists anywhere in the catalogue (zero-anchor case: an
    // empty object, a comment-only stub, or a `$schema`-only file). Appending
    // after the full per-segment loop would land the generated sections AFTER
    // the root's own closing `}`, producing knobs that live outside the JSON
    // object entirely. Splice them in front of the root close instead.
    const generated = additions.get(-1).map((key) => generatedSection(key, schema.properties[key], false)).join('');
    const closeIndex = rootClose(stripJsonc(output));
    if (closeIndex >= 0 && closeIndex < output.length) {
      output = `${withNewline(output.slice(0, closeIndex))}${generated}${output.slice(closeIndex)}`;
    } else {
      // No root close found at all (malformed/empty input) — fall back to a
      // synthesized root object so the output is still valid JSONC.
      output = `{\n${generated}}\n`;
    }
  }
  if (!hasSchema) {
    const ref = opts.schemaRef || 'forge-prefs.schema.json';
    const open = output.indexOf('{');
    if (open !== -1) output = `${output.slice(0, open + 1)}\n  "$schema": ${JSON.stringify(ref)},\n${output.slice(open + 1)}`;
  }
  const parsed = parseJsonc(output);
  if (!parsed.ok) throw new Error(`rescaffold produced invalid JSONC: ${parsed.error.message}`);
  const guard = catalogDiff(output, schema);
  if (guard.missingSections.length > 0) {
    throw new Error(`rescaffold guard failed: sections landed outside the root object: ${guard.missingSections.join(', ')}`);
  }
  return { text: output, warnings, addedSections };
}

module.exports = {
  OFF_MARKER,
  isOffMarker,
  stripOffMarker,
  defaultsFromSchema,
  renderSection,
  renderKnob,
  renderNode,
  docLines,
  jsonValue,
  generateSetupScaffold,
  SETUP_KNOBS,
  generateScaffold,
  segmentCatalog,
  rescaffoldCatalog,
  catalogDiff,
  fs,
  path,
  parseJsonc,
  loadSchema,
  validatePrefs,
};

// Cold-path CLI. Only `--diff <file>` is supported here — the scaffold/
// rescaffold write actions are exposed via forge-prefs.js's own CLI, which
// already lazy-requires this module. Keeping this block additive avoids
// duplicating that entry point.
function runCli(argv) {
  const diffIndex = argv.indexOf('--diff');
  if (diffIndex === -1) {
    process.stderr.write('✗ forge-prefs-scaffold CLI error: use --diff <catalog.jsonc>\n');
    return 1;
  }
  const target = argv[diffIndex + 1];
  if (!target) {
    process.stderr.write('✗ forge-prefs-scaffold CLI error: --diff requires a file path\n');
    return 1;
  }
  let text;
  try {
    text = fs.readFileSync(path.resolve(target), 'utf8');
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    return 1;
  }
  const schema = loadSchema();
  if (!schema) {
    process.stdout.write(`${JSON.stringify({ error: 'schema unavailable' })}\n`);
    return 1;
  }
  try {
    process.stdout.write(`${JSON.stringify(catalogDiff(text, schema))}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
