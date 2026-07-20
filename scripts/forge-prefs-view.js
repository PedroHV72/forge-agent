#!/usr/bin/env node
'use strict';

// forge-prefs-view — full-catalog viewer for the JSONC prefs engine (M008 S06/T01).
//
// `--resolved --explain` (forge-prefs.js) only reports ACTIVE knobs (S04/T06,
// load-bearing decision): a knob absent from every layer never appears in
// `prefs`/`provenance`. The viewer's whole point is to show the user the
// FULL knob universe (every knob in the schema) — active AND inactive — so
// this module merges the schema catalog (loadSchema/defaultsFromSchema, the
// full universe of knobs with defaults + descriptions) with the resolved output (readPrefs + the CLI's
// `--explain` provenance) to decide, per knob: state (ATIVO/desligado),
// resolved value, origin layer, and description.
//
// Zero reimplementation: schema walking comes from loadSchema()/
// defaultsFromSchema(); resolution + provenance come from the forge-prefs.js
// CLI (`--resolved --explain`), invoked via spawnSync so this module never
// re-derives readProvenanceLayer/buildProvenance's file-reading internals.

const path = require('path');
const { spawnSync } = require('child_process');
const { loadSchema } = require('./forge-prefs.js');
const { defaultsFromSchema } = require('./forge-prefs-scaffold.js');

const PREFS_SCRIPT = path.join(__dirname, 'forge-prefs.js');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getDottedValue(value, dotted) {
  let current = value;
  for (const key of dotted.split('.')) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, key)) {
      return { found: false, value: undefined };
    }
    current = current[key];
  }
  return { found: true, value: current };
}

// Walk the schema's leaf set. A "leaf" is any node without its own
// `.properties` (matches defaultsFromSchema's walk exactly) — this includes
// scalar knobs (type: boolean/string/number) AND open-ended object knobs
// that carry a `default` but no declared sub-schema (e.g. `routing`,
// additionalProperties: true). `$schema` IS counted as its own knob/section
// here (the catalog-reference hook itself is a leaf with a default and a
// description) — the knob/section counts asserted by T01-PLAN include it,
// matching the top-level property count of forge-prefs.schema.json.
function walkSchemaLeaves(schema) {
  const leaves = [];
  const sections = [];
  if (!schema || !schema.properties) return { leaves, sections };
  function walk(node, parts, section) {
    if (!node || typeof node !== 'object') return;
    if (node.properties) {
      for (const [key, child] of Object.entries(node.properties)) {
        walk(child, parts.concat(key), section);
      }
      return;
    }
    leaves.push({
      section,
      path: parts.join('.'),
      description: node.description || '',
      default: node.default,
      type: node.type,
      enum: node.enum || null,
    });
  }
  for (const [topKey, topNode] of Object.entries(schema.properties)) {
    sections.push(topKey);
    walk(topNode, [topKey], topKey);
  }
  return { leaves, sections };
}

// Determine active/value/layer for one schema leaf against the resolved
// prefs + provenance map. Most leaves match `provenance[path]` exactly.
// Open-ended object leaves (routing, etc.) have no schema-declared children,
// so `buildProvenance` — which walks the ACTUAL resolved value tree, not the
// schema — reports provenance at deeper dotted keys under `path.`. A leaf is
// still ATIVO in that case; its layer is the single value shared by every
// nested key it owns, or `mixed` when a local override only replaced part
// of that subtree.
function knobState(leaf, prefs, provenance) {
  const exact = provenance[leaf.path];
  if (exact) {
    return { active: true, layer: exact, value: getDottedValue(prefs, leaf.path).value };
  }
  const prefix = `${leaf.path}.`;
  const nested = Object.keys(provenance).filter((key) => key.startsWith(prefix));
  if (nested.length > 0) {
    const layers = new Set(nested.map((key) => provenance[key]));
    const layer = layers.size === 1 ? [...layers][0] : 'mixed';
    return { active: true, layer, value: getDottedValue(prefs, leaf.path).value };
  }
  return { active: false, layer: '—', value: leaf.default };
}

// Runs the forge-prefs.js CLI in `--resolved --explain` mode via spawnSync so
// this module never re-derives the provenance/legacy-reading internals
// (which are process-argv-only in forge-prefs.js, not exported functions).
function resolveViaCli(cwd) {
  const result = spawnSync(process.execPath, [PREFS_SCRIPT, '--resolved', '--explain', '--cwd', cwd], {
    encoding: 'utf8',
  });
  const stdout = (result.stdout || '').split('\n').find((line) => line.trim().startsWith('{'));
  if (!stdout) {
    throw new Error(`forge-prefs.js --resolved --explain produced no JSON output (stderr: ${result.stderr || ''})`);
  }
  return JSON.parse(stdout);
}

// buildCatalog(cwd) — the structured accessor consumed by the test suite and
// by `--json`. Returns every schema knob, each carrying its resolved
// state, so nothing here is filtered by activity.
function buildCatalog(cwd) {
  const targetCwd = cwd || process.cwd();
  const schema = loadSchema();
  if (!schema) throw new Error('forge-prefs.schema.json unavailable');
  const { leaves, sections } = walkSchemaLeaves(schema);
  const resolved = resolveViaCli(targetCwd);
  const provenance = resolved.provenance || {};
  const knobs = leaves.map((leaf) => {
    const state = knobState(leaf, resolved.prefs || {}, provenance);
    return {
      section: leaf.section,
      path: leaf.path,
      description: leaf.description,
      default: leaf.default,
      type: leaf.type,
      enum: leaf.enum,
      active: state.active,
      value: state.active ? state.value : leaf.default,
      layer: state.layer,
      // $schema is the catalog-reference hook — tooling metadata, not a user
      // preference. Flagged so the renderer annotates it distinctly and never
      // presents ATIVO/desligado semantics for it.
      metadata: leaf.path === '$schema',
    };
  });
  return {
    ok: resolved.ok,
    errors: resolved.errors || [],
    warnings: resolved.warnings || [],
    layers: resolved.layers || { global: { source: 'absent', files: [] }, local: { source: 'absent', files: [] } },
    sections,
    knobs,
  };
}

function formatValue(value) {
  if (value === undefined) return '(unset)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function layerLabel(layer) {
  if (layer === 'global') return 'global';
  if (layer === 'local') return 'local';
  if (layer === 'mixed') return 'global+local (mixed)';
  return '—';
}

function sourceLabel(source) {
  if (source === 'jsonc') return 'jsonc';
  if (source === 'md-legacy') return 'md-legacy (considere migrar: forge-prefs-migrate.js)';
  return 'absent';
}

// renderView(cwd) — human-readable text form of buildCatalog(cwd). This is
// the default `--view` CLI output and what `/forge-prefs` (the skill) prints
// verbatim.
function renderView(cwd) {
  const catalog = buildCatalog(cwd);
  const lines = [];
  lines.push(`Forge Agent — Catálogo de preferências (todos os ${catalog.knobs.length} knobs)`);
  lines.push('');
  lines.push(`  camada global: ${sourceLabel(catalog.layers.global.source)}${catalog.layers.global.files.length ? ` — ${catalog.layers.global.files.join(', ')}` : ''}`);
  lines.push(`  camada local:  ${sourceLabel(catalog.layers.local.source)}${catalog.layers.local.files.length ? ` — ${catalog.layers.local.files.join(', ')}` : ''}`);
  lines.push('');
  if (catalog.errors.length > 0) {
    lines.push('✗ ERROS DE PARSE');
    for (const error of catalog.errors) {
      lines.push(`  ✗ ${error.file || '<?>'}:${error.line === null || error.line === undefined ? '?' : error.line} — ${error.message}`);
    }
    lines.push('');
  }
  if (catalog.warnings.length > 0) {
    lines.push('⚠ AVISOS (valores inválidos)');
    for (const warning of catalog.warnings) {
      lines.push(`  ⚠ ${warning.key}: ${warning.message}`);
    }
    lines.push('');
  }
  lines.push('Legenda: ● ATIVO   ○ desligado');
  lines.push('');
  const bySection = new Map();
  for (const knob of catalog.knobs) {
    if (!bySection.has(knob.section)) bySection.set(knob.section, []);
    bySection.get(knob.section).push(knob);
  }
  for (const section of catalog.sections) {
    const knobs = bySection.get(section) || [];
    if (knobs.length === 0) continue;
    lines.push(`── ${section} ${'─'.repeat(Math.max(2, 72 - section.length))}`);
    for (const knob of knobs) {
      if (knob.metadata) {
        lines.push(`  ◆ ${knob.path}`);
        lines.push(`      metadata de tooling — não é preferência   valor: ${formatValue(knob.value)}`);
        lines.push(`      ${knob.description}`);
        continue;
      }
      const marker = knob.active ? '●' : '○';
      const state = knob.active ? 'ATIVO' : 'desligado';
      lines.push(`  ${marker} ${knob.path}`);
      lines.push(`      estado: ${state}   valor: ${formatValue(knob.value)}   camada: ${layerLabel(knob.layer)}`);
      lines.push(`      ${knob.description}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function parseCliArgs(argv) {
  const args = { cwd: process.cwd(), json: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--cwd') args.cwd = path.resolve(argv[++index] || process.cwd());
    else if (argv[index] === '--json') args.json = true;
    else if (argv[index] === '--view') { /* default action, no-op flag */ }
  }
  return args;
}

function runCli(argv) {
  const args = parseCliArgs(argv);
  try {
    if (args.json) {
      process.stdout.write(`${JSON.stringify(buildCatalog(args.cwd))}\n`);
    } else {
      process.stdout.write(`${renderView(args.cwd)}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`✗ forge-prefs-view: ${error.message}\n`);
    return 1;
  }
}

module.exports = {
  walkSchemaLeaves,
  knobState,
  buildCatalog,
  renderView,
  runCli,
};

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
