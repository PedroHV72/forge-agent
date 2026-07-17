#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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

/**
 * JSONC preference-file tokenizer.
 *
 * This module intentionally has zero dependencies: future additions may use only
 * Node's fs, path, and os built-ins.  Comment handling is a hand-written state
 * machine, never a regular expression, so URLs and escape sequences in strings
 * are safe.  The eventual CLI exits non-zero for parse errors (unlike the
 * exit-zero forge-routing and forge-review-pairing sibling CLIs); that CLI lands
 * in T04, while this module is deliberately parser-only.
 */

const NORMAL = 'normal';
const IN_STRING = 'in-string';
const ESCAPE = 'escape';
const LINE_COMMENT = 'line-comment';
const BLOCK_COMMENT = 'block-comment';

function lineAt(text, end) {
  let line = 1;
  for (let index = 0; index < end; index++) {
    if (text[index] === '\n') {
      line++;
    } else if (text[index] === '\r' && text[index + 1] !== '\n') {
      line++;
    }
  }
  return line;
}

/**
 * First pass: replace comments, rather than deleting them, to retain offsets.
 * The returned error is private to parseJsonc; the public stripJsonc API stays
 * string-shaped for callers that only need the normalized JSON text.
 */
function scanJsonc(text) {
  let state = NORMAL;
  let output = '';
  let line = 1;
  let startLine = 1;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    const next = text[index + 1];

    if (index === 0 && character === '\uFEFF') {
      output += ' ';
      continue;
    }

    if (state === NORMAL) {
      if (character === '"') {
        output += character;
        state = IN_STRING;
        startLine = line;
      } else if (character === '/' && next === '/') {
        output += ' ';
        state = LINE_COMMENT;
      } else if (character === '/' && next === '*') {
        output += ' ';
        state = BLOCK_COMMENT;
        startLine = line;
      } else {
        output += character;
      }
    } else if (state === IN_STRING) {
      output += character;
      if (character === '\\') {
        // ESCAPE consumes exactly the next code unit, including a quote.
        state = ESCAPE;
      } else if (character === '"') {
        state = NORMAL;
      }
    } else if (state === ESCAPE) {
      output += character;
      state = IN_STRING;
    } else if (state === LINE_COMMENT) {
      if (character === '\n' || character === '\r') {
        // Keep the line ending and resume normal JSON scanning.
        output += character;
        state = NORMAL;
      } else {
        output += ' ';
      }
    } else {
      // BLOCK_COMMENT: retain line breaks, blank every other character.
      if (character === '*' && next === '/') {
        // Consume both delimiter characters while preserving their two offsets.
        output += '  ';
        index++;
        state = NORMAL;
      } else if (character === '\n' || character === '\r') {
        output += character;
      } else {
        output += ' ';
      }
    }

    if (character === '\n') line++;
    else if (character === '\r' && next !== '\n') line++;
  }

  if (state === IN_STRING || state === ESCAPE) {
    return { text: output, error: { line: startLine, message: 'Unterminated string' } };
  }
  if (state === BLOCK_COMMENT) {
    return { text: output, error: { line: startLine, message: 'Unterminated block comment' } };
  }
  return { text: output, error: null };
}

function isJsonWhitespace(character) {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

/**
 * Second pass removes commas only when the next JSON token closes a container.
 * It is separately string-aware so literal commas inside quoted values survive.
 */
function removeTrailingCommas(text) {
  const characters = text.split('');
  let state = NORMAL;

  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    if (state === IN_STRING) {
      if (character === '\\') state = ESCAPE;
      else if (character === '"') state = NORMAL;
      continue;
    }
    if (state === ESCAPE) {
      state = IN_STRING;
      continue;
    }
    if (character === '"') {
      state = IN_STRING;
      continue;
    }
    if (character !== ',') continue;

    let lookahead = index + 1;
    while (lookahead < characters.length && isJsonWhitespace(characters[lookahead])) lookahead++;
    if (characters[lookahead] === '}' || characters[lookahead] === ']') characters[index] = ' ';
  }
  return characters.join('');
}

function stripJsonc(text) {
  if (typeof text !== 'string') throw new TypeError('JSONC input must be a string');
  return removeTrailingCommas(scanJsonc(text).text);
}

function parseJsonc(text, opts) { // opts is reserved for future parser policy.
  if (typeof text !== 'string') {
    return { ok: false, value: undefined, error: { line: null, message: 'JSONC input must be a string' } };
  }
  const scanned = scanJsonc(text);
  if (scanned.error) return { ok: false, value: undefined, error: scanned.error };

  const stripped = removeTrailingCommas(scanned.text);
  if (stripped.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const positionMatch = /position\s+(\d+)/i.exec(message);
    const messageLineMatch = /line\s+(\d+)\s+column\s+\d+/i.exec(message);
    const position = positionMatch ? Number(positionMatch[1]) : null;
    // Newer V8 releases sometimes provide line/column instead of an offset.
    // Both derive from the shape-preserved string and therefore match source.
    const line = position !== null
      ? lineAt(text, position)
      : (messageLineMatch ? Number(messageLineMatch[1]) : null);
    return {
      ok: false,
      value: undefined,
      error: { line, message },
    };
  }
}

// ── Two-layer preference resolution ───────────────────────────────────────
// A layer chooses exactly one format.  JSONC shadows every Markdown file in
// that same layer; this prevents a partially migrated layer from being mixed.
const ATOMIC_KEYS = ['routing'];

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Merge user preferences without mutating either input.
 *
 * Normal objects merge recursively.  Arrays, null, and type changes are
 * replacements.  routing is intentionally different: forge-routing.js uses
 * last-wins per whole domain, so a newer routing.backend replaces the older
 * routing.backend rather than inheriting omitted phases from it.
 */
function deepMerge(base, over, depth) {
  const currentDepth = depth || 0;
  if (!isPlainObject(base) || !isPlainObject(over)) return over;

  const merged = Object.assign({}, base);
  for (const key of Object.keys(over)) {
    const next = over[key];
    const previous = base[key];
    if (ATOMIC_KEYS.includes(key) && currentDepth === 0 &&
      isPlainObject(previous) && isPlainObject(next)) {
      const routing = Object.assign({}, previous);
      for (const domain of Object.keys(next)) routing[domain] = next[domain];
      merged[key] = routing;
    } else if (isPlainObject(previous) && isPlainObject(next)) {
      merged[key] = deepMerge(previous, next, currentDepth + 1);
    } else {
      // Includes arrays and explicit null: both replace rather than merge.
      merged[key] = next;
    }
  }
  return merged;
}

function existingFiles(files) {
  return files.filter((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

function resolveLayer(jsoncFile, markdownFiles, errors) {
  if (existingFiles([jsoncFile]).length === 1) {
    let raw;
    try {
      raw = fs.readFileSync(jsoncFile, 'utf8');
    } catch (error) {
      errors.push({ file: jsoncFile, line: null, message: error.message });
      return { prefs: {}, source: 'jsonc', files: [jsoncFile] };
    }
    const parsed = parseJsonc(raw);
    if (!parsed.ok) {
      errors.push({ file: jsoncFile, line: parsed.error.line, message: parsed.error.message });
      // A broken JSONC layer contributes nothing.  In particular, do not fall
      // back to its Markdown files: JSONC's shadow remains in force.
      return { prefs: {}, source: 'jsonc', files: [jsoncFile] };
    }
    return { prefs: parsed.value, source: 'jsonc', files: [jsoncFile] };
  }

  const files = existingFiles(markdownFiles);
  if (files.length === 0) {
    return { prefs: {}, source: 'absent', files, routingMalformed: false, malformedFile: null };
  }
  const legacy = legacyReadLayer(markdownFiles);
  return {
    prefs: legacy.prefs,
    source: 'md-legacy',
    files,
    routingMalformed: legacy.routingMalformed,
    malformedFile: legacy.malformedFile,
  };
}

/**
 * Canonical per-layer file lists — the ONLY production declaration of the
 * legacy preference filenames (guarded by smoke Section 39e). Consumers such
 * as forge-prefs-migrate.js import this instead of re-declaring paths.
 * `opts.globalDir` / `opts.localDir` exist for test isolation (never touch the
 * operator's real ~/.claude from a test).
 */
function preferenceLayerDescriptors(cwd, opts) {
  const options = opts || {};
  const claudeDir = options.globalDir || path.join(os.homedir(), '.claude');
  const gsdDir = options.localDir || path.join(cwd || process.cwd(), '.gsd');
  return [
    {
      name: 'global',
      jsoncPath: path.join(claudeDir, 'forge-agent-prefs.jsonc'),
      mdFiles: [path.join(claudeDir, 'forge-agent-prefs.md')],
    },
    {
      name: 'local',
      jsoncPath: path.join(gsdDir, 'forge-prefs.jsonc'),
      mdFiles: [path.join(gsdDir, 'claude-agent-prefs.md'), path.join(gsdDir, 'prefs.local.md')],
    },
  ];
}

/**
 * Resolve global preferences then project-local preferences.  No cache is
 * created: callers always receive an in-memory result for the current files.
 */
function readPrefs(cwd, opts) {
  const targetCwd = cwd || process.cwd();
  const errors = [];
  const [globalDescriptor, localDescriptor] = preferenceLayerDescriptors(targetCwd, opts);
  const globalLayer = resolveLayer(globalDescriptor.jsoncPath, globalDescriptor.mdFiles, errors);
  const localLayer = resolveLayer(localDescriptor.jsoncPath, localDescriptor.mdFiles, errors);
  const merged = deepMerge(globalLayer.prefs, localLayer.prefs);
  // R1 fix: the md-legacy routing cascade spans BOTH layers (matching
  // readRoutingConfig's file-list semantics) — a malformed block anywhere in
  // it drops `routing` from the merged result entirely and surfaces ok:false.
  if (globalLayer.routingMalformed || localLayer.routingMalformed) {
    const malformedFile = globalLayer.routingMalformed ? globalLayer.malformedFile : localLayer.malformedFile;
    delete merged.routing;
    errors.push({
      file: malformedFile,
      line: null,
      message: `routing-parse-error: malformed routing block in ${malformedFile}`,
    });
  }
  return {
    ok: errors.length === 0,
    prefs: merged,
    errors,
    layers: {
      global: { source: globalLayer.source, files: globalLayer.files },
      local: { source: localLayer.source, files: localLayer.files },
    },
  };
}

// Process-local hot-path memo. The preference files remain the source of
// truth; this cache never writes a resolved snapshot to disk.
const prefsCache = new Map();

function preferenceLayerFiles(cwd) {
  const targetCwd = cwd || process.cwd();
  const claudeDir = path.join(os.homedir(), '.claude');
  const gsdDir = path.join(targetCwd, '.gsd');
  return [
    path.join(claudeDir, 'forge-agent-prefs.jsonc'),
    path.join(claudeDir, 'forge-agent-prefs.md'),
    path.join(gsdDir, 'forge-prefs.jsonc'),
    path.join(gsdDir, 'claude-agent-prefs.md'),
    path.join(gsdDir, 'prefs.local.md'),
  ];
}

function preferenceFileSignature(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeNs || stat.mtimeMs}:${stat.size}:${stat.ino || ''}`;
  } catch {
    return 'absent';
  }
}

function readPrefsCached(cwd) {
  const targetCwd = cwd || process.cwd();
  const signature = preferenceLayerFiles(targetCwd).map(preferenceFileSignature).join('|');
  const cached = prefsCache.get(targetCwd);
  if (cached && cached.signature === signature) return cached.result;
  const result = readPrefs(targetCwd);
  prefsCache.set(targetCwd, { signature, result });
  return result;
}

// ── Generic advisory validator and CLI ────────────────────────────────────
// Validation is schema-driven and advisory: consumers retain their own
// defaults for invalid knobs. This engine never mutates or defaults prefs.
function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'object') return isPlainObject(value);
    if (type === 'null') return value === null;
    return jsonType(value) === type;
  });
}

function validationEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((item, index) => validationEqual(item, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key) && validationEqual(left[key], right[key]));
  }
  return false;
}

function validatePrefs(resolved, schema) {
  const warnings = [];
  if (!schema || typeof schema !== 'object') return warnings;
  function walk(value, node, parts) {
    if (!node || typeof node !== 'object') return;
    const key = parts.join('.') || '<root>';
    if (node.type !== undefined && !typeMatches(value, node.type)) {
      const expected = Array.isArray(node.type) ? node.type.join(' or ') : node.type;
      warnings.push({ key, message: `${key}: expected ${expected}, got ${jsonType(value)}` });
      return;
    }
    if (Array.isArray(node.enum) && !node.enum.some((item) => validationEqual(value, item))) {
      warnings.push({ key, message: `${key}: expected one of ${node.enum.map((item) => JSON.stringify(item)).join(', ')}` });
    }
    if (!isPlainObject(value) || !isPlainObject(node.properties)) return;
    for (const childKey of Object.keys(value)) {
      const child = node.properties[childKey];
      const childPath = parts.concat(childKey).join('.');
      if (!child && node.additionalProperties !== true) {
        warnings.push({ key: childPath, message: `${childPath}: unknown preference key` });
      } else if (child) {
        walk(value[childKey], child, parts.concat(childKey));
      }
    }
  }
  walk(resolved, schema, []);
  return warnings;
}

function loadSchema() {
  const schemaFile = path.join(__dirname, '..', 'forge-prefs.schema.json');
  try {
    return JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  } catch (error) {
    // The schema belongs to the installation. Missing or broken schema data
    // cannot turn into a user-facing parse error and is intentionally ignored.
    return null;
  }
}

function schemaLoadWarning() {
  const schemaFile = path.join(__dirname, '..', 'forge-prefs.schema.json');
  try {
    fs.accessSync(schemaFile, fs.constants.F_OK);
    JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
    return null;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return { key: '<schema>', message: `forge-prefs.schema.json: ${error.message}` };
  }
}

// R3 fix: walk the leaf set of the MERGED result, not the raw global/local
// trees independently. deepMerge does whole-domain atomic replace for
// `routing` (and whole-subtree replace on any type conflict), so unioning the
// raw trees reports phantom leaves for paths absent from the merged result
// (e.g. a global-only routing.<domain>.<phase> under a locally-redefined
// domain). A leaf is attributed 'local' only when the identical dotted path
// resolves to the SAME value in the raw local tree; otherwise 'global'.
function buildProvenance(globalPrefs, localPrefs) {
  const merged = deepMerge(globalPrefs || {}, localPrefs || {});
  const result = {};
  function walk(value, parts) {
    if (!isPlainObject(value)) {
      if (parts.length > 0) {
        const key = parts.join('.');
        const local = getDottedValue(localPrefs || {}, key);
        result[key] = local.found && validationEqual(local.value, value) ? 'local' : 'global';
      }
      return;
    }
    for (const key of Object.keys(value)) walk(value[key], parts.concat(key));
  }
  walk(merged, []);
  return result;
}

function parseCliArgs(argv) {
  const args = { resolved: false, scaffold: false, rescaffold: null, write: false, out: null, key: null, explain: false, cwd: process.cwd(), globalDir: null, localDir: null };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--resolved') args.resolved = true;
    else if (argv[index] === '--scaffold') args.scaffold = true;
    else if (argv[index] === '--rescaffold') args.rescaffold = path.resolve(argv[++index] || '');
    else if (argv[index] === '--write') args.write = true;
    else if (argv[index] === '--out') args.out = path.resolve(argv[++index] || '');
    else if (argv[index] === '--explain') args.explain = true;
    else if (argv[index] === '--key') args.key = argv[++index] || '';
    else if (argv[index] === '--cwd') args.cwd = path.resolve(argv[++index] || process.cwd());
    // Test/round-trip isolation: point either layer at a scratch dir so the
    // migration proof can resolve the freshly-written file instead of the
    // operator's real ~/.claude. Mirrors preferenceLayerDescriptors' opts.
    else if (argv[index] === '--global-dir') args.globalDir = path.resolve(argv[++index] || '');
    else if (argv[index] === '--local-dir') args.localDir = path.resolve(argv[++index] || '');
  }
  return args;
}

function readProvenanceLayer(cwd, source, files) {
  if (source === 'jsonc') {
    try {
      const parsed = parseJsonc(fs.readFileSync(files[0], 'utf8'));
      return parsed.ok ? parsed.value : {};
    } catch { return {}; }
  }
  return legacyReadLayer(files).prefs;
}

function getDottedValue(value, key) {
  if (!key) return { found: true, value };
  let current = value;
  for (const part of key.split('.')) {
    if (current === null || current === undefined ||
      !Object.prototype.hasOwnProperty.call(Object(current), part)) return { found: false, value: null };
    current = current[part];
  }
  return { found: true, value: current };
}

// Keep the cold scaffold dependency lazy: normal preference resolution remains
// independent from its renderer, while both scaffold actions share one import.
function loadScaffoldModule() {
  return require('./forge-prefs-scaffold.js');
}

function runCli(argv) {
  const args = parseCliArgs(argv);
  if (args.rescaffold) {
    let existing;
    try {
      existing = fs.readFileSync(args.rescaffold, 'utf8');
    } catch (error) {
      process.stderr.write(`✗ prefs rescaffold error: ${args.rescaffold}: ${error.message}\n`);
      return 1;
    }
    const schema = loadSchema();
    if (!schema) return 1;
    const { rescaffoldCatalog } = loadScaffoldModule();
    let result;
    try {
      const schemaRef = path.relative(path.dirname(args.rescaffold), path.join(__dirname, '..', 'forge-prefs.schema.json')) || 'forge-prefs.schema.json';
      result = rescaffoldCatalog(existing, schema, { schemaRef: schemaRef.split(path.sep).join('/') });
    } catch (error) {
      process.stderr.write(`✗ prefs rescaffold error: ${error.message}\n`);
      return 1;
    }
    if (args.write) fs.writeFileSync(args.rescaffold, result.text, 'utf8');
    process.stdout.write(result.text);
    for (const warning of result.warnings) process.stderr.write(`⚠ ${warning.message}\n`);
    return 0;
  }
  if (args.scaffold) {
    const { generateScaffold } = loadScaffoldModule();
    const schema = loadSchema();
    if (!schema) return 1;
    const schemaRef = args.out
      ? path.relative(path.dirname(args.out), path.join(__dirname, '..', 'forge-prefs.schema.json')) || path.basename(path.join(__dirname, '..', 'forge-prefs.schema.json'))
      : 'forge-prefs.schema.json';
    const output = generateScaffold(schema, { schemaRef: schemaRef.split(path.sep).join('/') });
    if (args.out) {
      fs.mkdirSync(path.dirname(args.out), { recursive: true });
      fs.writeFileSync(args.out, output, 'utf8');
    }
    else process.stdout.write(output);
    return 0;
  }
  if (!args.resolved) {
    const output = {
      ok: false,
      prefs: {},
      errors: [{ file: '<cli>', line: null, message: '--resolved is required' }],
      warnings: [],
      layers: { global: { source: 'absent', files: [] }, local: { source: 'absent', files: [] } },
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.stderr.write('✗ prefs CLI error: use --resolved para resolver as preferências\n');
    return 1;
  }
  const dirOpts = {};
  if (args.globalDir) dirOpts.globalDir = args.globalDir;
  if (args.localDir) dirOpts.localDir = args.localDir;
  const result = readPrefs(args.cwd, dirOpts);
  const warnings = validatePrefs(result.prefs, loadSchema());
  const schemaWarning = schemaLoadWarning();
  if (schemaWarning) warnings.push(schemaWarning);
  const output = { ok: result.errors.length === 0, prefs: result.prefs, errors: result.errors, warnings, layers: result.layers };
  if (args.explain) {
    const globalDir = args.globalDir || path.join(os.homedir(), '.claude');
    const localDir = args.localDir || path.join(args.cwd, '.gsd');
    output.provenance = buildProvenance(
      readProvenanceLayer(args.cwd, result.layers.global.source, [path.join(globalDir, 'forge-agent-prefs.jsonc'), path.join(globalDir, 'forge-agent-prefs.md')]),
      readProvenanceLayer(args.cwd, result.layers.local.source, [path.join(localDir, 'forge-prefs.jsonc'), path.join(localDir, 'claude-agent-prefs.md'), path.join(localDir, 'prefs.local.md')]),
    );
  }
  if (args.key !== null) {
    const selected = getDottedValue(result.prefs, args.key);
    delete output.prefs;
    output.value = selected.value;
    if (!selected.found) output.warnings.push({ key: args.key, message: `${args.key}: key not found` });
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  for (const warning of output.warnings) process.stderr.write(`⚠ ${warning.message}\n`);
  for (const error of result.errors) {
    process.stderr.write(`✗ prefs parse error: ${error.file}:${error.line === null ? '?' : error.line} — ${error.message}\n`);
    process.stderr.write('corrija o JSONC ou renomeie o arquivo para voltar ao legado\n');
  }
  return result.errors.length > 0 ? 1 : 0;
}

module.exports = {
  parseJsonc,
  stripJsonc,
  legacyReadFile,
  legacyReadLayer,
  preferenceLayerDescriptors,
  readPrefs,
  readPrefsCached,
  deepMerge,
  validatePrefs,
  loadSchema,
  buildProvenance,
  runCli,
};

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
