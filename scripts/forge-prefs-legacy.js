'use strict';

// Private to forge-prefs-migrate.js and its tests. Production reads NEVER go
// through this module (M015 S01 cut).

const fs = require('fs');
const { loadSchema } = require('./forge-prefs.js');

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}


// ── Legacy markdown preference readers ─────────────────────────────────────
// These readers deliberately live here because T03/T04 consume this module
// after the scattered forge-* readers are removed.  They are copies of the
// old readers, with the EOF-safe block boundary required by MEM030.

function stripLegacyInlineComment(value) {
  let quote = null;
  let escaped = false;
  let bracketDepth = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '[') {
      bracketDepth++;
    } else if (character === ']' && bracketDepth > 0) {
      bracketDepth--;
    } else if (character === '#' && bracketDepth === 0) {
      return value.slice(0, index);
    }
  }
  return value;
}

function parseLegacyValue(raw, isArrayPath) {
  const trimmed = stripLegacyInlineComment(String(raw)).trim();
  if (isArrayPath && trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) return trimmed;
    const parts = trimmed.slice(1, -1)
      .split(',')
      .map((part) => part.trim().replace(/^["']|["']$/g, ''))
      .filter((part) => part.length > 0);
    return parts;
  }
  const unquoted = trimmed.replace(/^["']|["']$/g, '');
  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function parseLegacyKeyLine(line, isArrayPath) {
  const match = line.match(/^[ \t]+([A-Za-z0-9_.-]+):[ \t]*(.*)$/);
  return match ? { key: match[1], rawValue: match[2], value: parseLegacyValue(match[2], isArrayPath) } : null;
}

// Byte-identical copy of forge-routing.js#parseValue (level-3 tier value).
// Bare scalar -> single-element array; bracket list -> parsed array; empty
// or unbalanced list -> null (malformed, discards the file's routing block).
function parseLegacyRoutingValue(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) return null;
    const inner = trimmed.slice(1, -1);
    const parts = inner
      .split(',')
      .map((part) => part.trim().replace(/^["']|["']$/g, ''))
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts : null;
  }
  const unquoted = trimmed.replace(/^["']|["']$/g, '');
  return unquoted.length > 0 ? [unquoted] : null;
}

// Copied from forge-routing.js parseRoutingBlock; this is the per-file
// extraction only.  A malformed nested block discards the complete routing
// section, matching the routing reader's all-or-nothing behavior.
function parseLegacyRoutingBlock(block) {
  const lines = block.split(/\r?\n/);
  const routing = {};
  const indentStack = [];
  let domain = null;
  let phase = null;

  for (const rawLine of lines) {
    if (rawLine.trim() === '') continue;
    const indent = rawLine.match(/^[ \t]*/)[0];
    const width = indent.length;
    if (rawLine.slice(width).startsWith('#')) continue;
    const line = stripLegacyInlineComment(rawLine);
    const match = line.match(/^[ \t]*([A-Za-z0-9_.-]+):[ \t]*(.*)$/);
    if (!match) return null;
    const key = match[1];
    const value = match[2].trim();
    let level;
    if (indentStack.length === 0) {
      indentStack.push(width);
      level = 1;
    } else if (width === indentStack[indentStack.length - 1]) {
      level = indentStack.length;
    } else if (width > indentStack[indentStack.length - 1]) {
      indentStack.push(width);
      level = indentStack.length;
    } else {
      while (indentStack.length > 0 && indentStack[indentStack.length - 1] > width) indentStack.pop();
      if (indentStack.length === 0 || indentStack[indentStack.length - 1] !== width) return null;
      level = indentStack.length;
    }
    if (level > 3) return null;
    if (level === 1) {
      if (value !== '') return null;
      domain = key;
      phase = null;
      routing[domain] = {};
    } else if (level === 2) {
      if (domain === null || value !== '') return null;
      phase = key;
      routing[domain][phase] = {};
    } else {
      if (domain === null || phase === null || value === '') return null;
      // R2 fix: mirror forge-routing.js#parseValue exactly — bare scalar wraps
      // into a single-element array, and `fallback` always takes list[0]
      // (including `fallback: [a, b]` -> "a"), matching the production reader.
      const list = parseLegacyRoutingValue(value);
      if (list === null) return null;
      if (key === 'fallback') {
        routing[domain][phase].fallback = list[0];
      } else {
        routing[domain][phase][key] = list;
      }
    }
  }
  return routing;
}

function legacySectionBlocks(raw) {
  const blocks = [];
  const sectionRe = /^([A-Za-z0-9_.-]+):[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$)|[ \t]*\r?\n)*)/gm;
  let match;
  while ((match = sectionRe.exec(raw)) !== null) {
    blocks.push({ section: match[1], block: match[2] });
  }
  return blocks;
}

function parseLegacyRepos(sectionBlock, arrayPaths) {
  const repos = {};
  let activeList = null;
  for (const rawLine of sectionBlock.split(/\r?\n/)) {
    const scalar = rawLine.match(/^\s{4}([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (scalar) {
      const key = scalar[1];
      // Strip the inline comment BEFORE deciding whether the value is empty: a
      // list-style knob such as `exclude:  # globs` carries only a comment on
      // the key line, so the raw match is non-empty even though the real value
      // is the `- item` continuation below.
      const stripped = stripLegacyInlineComment(scalar[2]).trim();
      if (stripped !== '') {
        repos[key] = parseLegacyValue(scalar[2], arrayPaths.has(`forge_isolation.repos.${key}`));
        activeList = null;
      } else if (arrayPaths.has(`forge_isolation.repos.${key}`)) {
        repos[key] = [];
        activeList = key;
      } else activeList = null;
      continue;
    }
    const item = rawLine.match(/^\s*-\s+(.+)$/);
    if (item && activeList) repos[activeList].push(stripLegacyInlineComment(item[1]).trim().replace(/^["']|["']$/g, ''));
  }
  return repos;
}

// T05 (M008 S04): a handful of legacy top-level keys (`repo_path`, `auto_commit`,
// `merge_strategy`, `auto_push`, `main_branch`) predate the nested `key:\n  indented`
// block convention used by `effort:`/`workers:`/etc. They live as bare
// `key: value` scalars directly under a `## Section Heading` (markdown prose),
// never inside an indented block — legacySectionBlocks only captures
// `key:\n  indented-content` shapes, so these were silently invisible to the
// resolver (readers fell back to `key not found` even against a real prefs
// file). A whitelist (not a generic scanner) is deliberate: `forge-agent-prefs.md`
// also embeds illustrative frontmatter snippets (e.g. `id: T12` / `tier: heavy`
// inside a fenced ```yaml example) that a generic bare-key-value scan would
// mis-capture as preference keys — a naive scan was caught corrupting `repo_path`
// during T05 verification. Only these five known legacy scalars are folded in
// at the top level, additive only, never overwriting a key already produced by
// a real nested section.
const LEGACY_FLAT_KEYS = new Set(['repo_path', 'auto_commit', 'merge_strategy', 'auto_push', 'main_branch']);

function legacyReadFlatKeys(raw) {
  const flat = {};
  let inFence = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = rawLine.match(/^([A-Za-z0-9_.-]+):[ \t]+(.+)$/);
    if (!match || !LEGACY_FLAT_KEYS.has(match[1])) continue;
    // First-match-wins: real legacy files declare each key once; this also
    // protects against a trailing doc example (unfenced) overwriting the
    // real value earlier in the file.
    if (Object.prototype.hasOwnProperty.call(flat, match[1])) continue;
    flat[match[1]] = parseLegacyValue(match[2]);
  }
  return flat;
}

// Legacy markdown has no type syntax of its own.  Consult the installed schema
// so bracket syntax is only coerced where the preference contract says it is an
// array; a scalar such as a glob or command is otherwise left untouched.
function schemaArrayPaths(schema) {
  const paths = new Set();
  function walk(node, parts) {
    if (!node || typeof node !== 'object') return;
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (parts.length > 0 && types.includes('array')) paths.add(parts.join('.'));
    if (!node.properties || typeof node.properties !== 'object') return;
    for (const key of Object.keys(node.properties)) walk(node.properties[key], parts.concat(key));
  }
  walk(schema, []);
  return paths;
}

function legacyReadFile(absPath) {
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return { ok: true, prefs: {}, routingMalformed: false };
  }
  const prefs = {};
  const arrayPaths = schemaArrayPaths(loadSchema());
  let routingMalformed = false;
  for (const entry of legacySectionBlocks(raw)) {
    if (entry.section === 'routing') {
      const routing = parseLegacyRoutingBlock(entry.block);
      if (routing !== null) prefs.routing = routing;
      else routingMalformed = true;
      continue;
    }
    const section = {};
    if (entry.section === 'forge_isolation' && /(^|\n)[ \t]+repos:[ \t]*\n/.test(entry.block)) {
      section.repos = parseLegacyRepos(entry.block, arrayPaths);
    }
    const lines = entry.block.split(/\r?\n/);
    const directIndent = lines.reduce((minimum, line) => {
      const match = line.match(/^([ \t]+)[A-Za-z0-9_.-]+:[ \t]*/);
      return match ? Math.min(minimum, match[1].length) : minimum;
    }, Infinity);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const keyMatch = line.match(/^([ \t]+)([A-Za-z0-9_.-]+):[ \t]*(.*)$/);
      if (!keyMatch || keyMatch[1].length !== directIndent) continue;
      const key = keyMatch[2];
      if (entry.section === 'forge_isolation' && key === 'repos') continue;
      const dottedPath = `${entry.section}.${key}`;
      const isArrayPath = arrayPaths.has(dottedPath);
      const parsed = parseLegacyKeyLine(line, isArrayPath);
      if (!parsed) continue;
      if (isArrayPath && stripLegacyInlineComment(parsed.rawValue).trim() === '') {
        const items = [];
        const keyIndent = keyMatch[1].length;
        let next = index + 1;
        while (next < lines.length) {
          const item = lines[next].match(/^([ \t]*)-[ \t]+(.*)$/);
          if (!item || item[1].length <= keyIndent) break;
          items.push(stripLegacyInlineComment(item[2]).trim().replace(/^["']|["']$/g, ''));
          next++;
        }
        section[key] = items;
        index = next - 1;
      } else {
        section[key] = parsed.value;
      }
    }
    prefs[entry.section] = section;
  }
  const flat = legacyReadFlatKeys(raw);
  for (const key of Object.keys(flat)) {
    if (!(key in prefs)) prefs[key] = flat[key];
  }
  return { ok: true, prefs, routingMalformed };
}

// R1 fix: a malformed routing: block in ANY file of the cascade must be
// surfaced, not silently dropped for that one file. legacyReadLayer reports
// the FIRST malformed file so readPrefs can drop `routing` cascade-wide and
// push an errors[] entry — matching readRoutingConfig's all-or-nothing scope.
function legacyReadLayer(files) {
  const merged = {};
  let routingMalformed = false;
  let malformedFile = null;
  for (const file of files) {
    const result = legacyReadFile(file);
    if (result.routingMalformed && !routingMalformed) {
      routingMalformed = true;
      malformedFile = file;
    }
    for (const section of Object.keys(result.prefs)) {
      if (section === 'routing') {
        if (!merged.routing) merged.routing = {};
        for (const domain of Object.keys(result.prefs.routing)) {
          merged.routing[domain] = result.prefs.routing[domain];
        }
      } else if (isPlainObject(result.prefs[section])) {
        // T05 (M008 S04): section values are section-objects EXCEPT the
        // LEGACY_FLAT_KEYS scalars folded in by legacyReadFile — guard the
        // Object.assign merge so a string never gets spread char-by-char
        // (Object.assign(target, "abc") indexes each character).
        merged[section] = Object.assign({}, merged[section], result.prefs[section]);
      } else {
        // Flat scalar (e.g. repo_path/auto_commit): later files in the same
        // layer's cascade win, matching the existing last-wins semantics.
        merged[section] = result.prefs[section];
      }
    }
  }
  return { ok: true, prefs: merged, routingMalformed, malformedFile };
}

module.exports = { legacyReadFile, legacyReadLayer, legacyReadFlatKeys };
