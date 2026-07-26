#!/usr/bin/env node
'use strict';

// Zero-dependency test suite for the /forge-prefs viewer (M008 S06/T01).
// Isolated via a temp HOME (never touches the operator's real ~/.claude,
// same discipline as forge-prefs.test.js/forge-prefs-migrate.test.js) and a
// temp project cwd with its own .gsd.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadSchema } = require('./forge-prefs.js');
const { setPreference } = require('./forge-prefs-migrate.js');
const { walkSchemaLeaves, buildCatalog, renderView } = require('./forge-prefs-view.js');

let passes = 0;
let failures = 0;

function assert(condition, name, detail) {
  if (condition) {
    passes++;
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failures++;
    process.stderr.write(`  ✗ ${name}: ${detail || 'assertion failed'}\n`);
  }
}

function setEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function describeSetDiff(a, b) {
  const missing = [...b].filter((x) => !a.has(x));
  const extra = [...a].filter((x) => !b.has(x));
  return `missing: ${JSON.stringify(missing)}, extra: ${JSON.stringify(extra)}`;
}

// ── Isolated fixtures ───────────────────────────────────────────────────────

const originalHome = process.env.HOME;
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prefs-view-home-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prefs-view-project-'));
fs.mkdirSync(path.join(projectDir, '.gsd'), { recursive: true });

process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

try {
  process.stdout.write('\nforge-prefs-view test suite\n');

  const schema = loadSchema();

  // Independent leaf/section walker over the raw schema JSON — deliberately
  // NOT the walkSchemaLeaves function under test, so these asserts prove
  // "the viewer doesn't drop a knob the schema declares" rather than
  // comparing a function against itself. Adding a knob to
  // forge-prefs.schema.json must move this count without editing this file.
  function independentSchemaLeafKeys(node, prefix, section, acc) {
    if (!node || typeof node !== 'object') return acc;
    if (node.properties) {
      for (const [key, child] of Object.entries(node.properties)) {
        independentSchemaLeafKeys(child, prefix ? `${prefix}.${key}` : key, section || key, acc);
      }
      return acc;
    }
    acc.leafPaths.add(prefix);
    acc.sections.add(section);
    return acc;
  }
  const independentSchema = independentSchemaLeafKeys(
    { properties: schema.properties }, '', null, { leafPaths: new Set(), sections: new Set() },
  );

  // ── walkSchemaLeaves — schema-universe shape ──────────────────────────────
  const { leaves, sections } = walkSchemaLeaves(schema);
  const leafPaths = new Set(leaves.map((leaf) => leaf.path));
  assert(setEqual(leafPaths, independentSchema.leafPaths),
    'walkSchemaLeaves knob set matches an independent schema walk',
    describeSetDiff(leafPaths, independentSchema.leafPaths));
  assert(setEqual(new Set(sections), independentSchema.sections),
    'walkSchemaLeaves section set matches an independent schema walk',
    describeSetDiff(new Set(sections), independentSchema.sections));
  assert(leafPaths.has('review.rounds'), 'includes a known nested leaf (review.rounds)');
  assert(leafPaths.has('$schema'), 'includes the $schema catalog-reference leaf');
  assert(leafPaths.has('routing'), 'includes an open-ended object leaf (routing) as a single knob');

  // ── buildCatalog against a virgin project (nothing set anywhere) ─────────
  const virgin = buildCatalog(projectDir);
  const virginPaths = new Set(virgin.knobs.map((knob) => knob.path));
  assert(setEqual(virginPaths, independentSchema.leafPaths),
    'buildCatalog(virgin) lists exactly the knob set the schema declares',
    describeSetDiff(virginPaths, independentSchema.leafPaths));
  const virginSections = new Set(virgin.knobs.map((knob) => knob.section));
  assert(setEqual(virginSections, independentSchema.sections),
    'buildCatalog(virgin) covers exactly the section set the schema declares',
    describeSetDiff(virginSections, independentSchema.sections));
  assert(virgin.knobs.every((knob) => knob.active === false), 'buildCatalog(virgin) — every knob is desligado');
  assert(
    virgin.knobs.every((knob) => knob.layer === '—'),
    'buildCatalog(virgin) — every knob shows layer —',
  );
  const virginRounds = virgin.knobs.find((knob) => knob.path === 'review.rounds');
  assert(!!virginRounds, 'virgin catalog contains review.rounds');
  assert(virginRounds.value === 1, 'virgin review.rounds resolves to its schema default (1)', `got ${virginRounds.value}`);

  // ── No-drift: every rendered description === schema.description ─────────
  function schemaLeafNode(dotted) {
    let node = { properties: schema.properties };
    for (const part of dotted.split('.')) {
      if (!node || !node.properties || !node.properties[part]) return null;
      node = node.properties[part];
    }
    return node;
  }
  let driftFound = false;
  for (const knob of virgin.knobs) {
    const node = schemaLeafNode(knob.path);
    if (!node || node.description !== knob.description) {
      driftFound = true;
      break;
    }
  }
  assert(!driftFound, 'every knob description is byte-equal to schema.description (no drift)');

  // ── Activate one knob (review.rounds=2) via the migrate --set primitive ──
  const setResult = setPreference(projectDir, 'review.rounds=2', { layer: 'local', create: true });
  assert(setResult.status === 'set', 'setPreference activates review.rounds=2 locally', JSON.stringify(setResult));

  const active = buildCatalog(projectDir);
  const activePaths = new Set(active.knobs.map((knob) => knob.path));
  assert(setEqual(activePaths, independentSchema.leafPaths),
    'buildCatalog(active) still lists exactly the schema knob set after --set',
    describeSetDiff(activePaths, independentSchema.leafPaths));
  const activeRounds = active.knobs.find((knob) => knob.path === 'review.rounds');
  assert(activeRounds.active === true, 'review.rounds is ATIVO after --set');
  assert(activeRounds.value === 2, 'review.rounds resolves to the set value (2)', `got ${activeRounds.value}`);
  assert(activeRounds.layer === 'local', 'review.rounds shows layer local', `got ${activeRounds.layer}`);

  // A known-off knob (never set) stays desligado at its schema default.
  const stillOff = active.knobs.find((knob) => knob.path === 'skip_discuss');
  assert(stillOff.active === false, 'a never-set knob (skip_discuss) stays desligado');
  assert(stillOff.value === false, 'skip_discuss resolves to its schema default (false)', `got ${stillOff.value}`);
  assert(stillOff.layer === '—', 'skip_discuss shows layer —');

  // Per-layer source is surfaced (local is now jsonc after --set/create).
  assert(active.layers.local.source === 'jsonc', 'local layer source reported as jsonc after --set', active.layers.local.source);
  assert(active.layers.global.source === 'absent', 'global layer source reported as absent (untouched)', active.layers.global.source);

  // ── renderView — human text form ──────────────────────────────────────────
  const text = renderView(projectDir);
  assert(typeof text === 'string' && text.length > 0, 'renderView returns non-empty text');
  assert(text.includes('review.rounds'), 'renderView text mentions review.rounds');
  assert(text.includes('ATIVO'), 'renderView text uses the ATIVO legend');
  assert(text.includes('desligado'), 'renderView text uses the desligado legend');
  assert(text.includes('Legenda'), 'renderView text includes the legend header');

  // ── $schema is annotated as tooling metadata, not a preference ────────────
  const schemaKnob = active.knobs.find((knob) => knob.path === '$schema');
  assert(!!schemaKnob, 'catalog contains the $schema knob (preserves full count)');
  assert(schemaKnob.metadata === true, '$schema knob carries metadata:true flag');
  assert(
    text.includes('metadata de tooling — não é preferência'),
    'renderView annotates $schema as tooling metadata (not ATIVO/desligado)',
  );

  // ── set $schema ... is REFUSED (never delegates a catalog-corrupting write)
  let refused = false;
  let refusalMsg = '';
  try {
    setPreference(projectDir, '$schema=./whatever.json', { layer: 'local', create: true });
  } catch (err) {
    refused = true;
    refusalMsg = err.message;
  }
  assert(refused, 'setPreference refuses to set $schema', 'expected a throw');
  assert(
    /metadata de tooling/.test(refusalMsg),
    'refusal message names $schema as tooling metadata',
    refusalMsg,
  );
} finally {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
}

process.stdout.write(`\n${passes} passed, ${failures} failed\n`);
process.exitCode = failures > 0 ? 1 : 0;
