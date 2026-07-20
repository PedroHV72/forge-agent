#!/usr/bin/env node
'use strict';

// forge-prefs-migrate — Migrates legacy markdown preference files to the
// two-layer JSONC catalogs, gated on a resolved-diff so a migration can
// NEVER lose or invent a value (M008 S05 D1–D7).
//
// Pipeline per layer (D3):
//   capture (legacy old-reader) → generate (scaffold + user-value activation)
//   → diff-GATE + schema-GATE in memory (failure → exit 3, ZERO writes, not even .bak)
//   → copy every legacy md to .md.bak (never clobbers an existing .bak)
//   → write the jsonc catalog → re-verify with the REAL new-reader
//   → divergence or schema warning → rollback (delete the jsonc, originals untouched) → exit 3
//   → success → remove the legacy md files (the .bak stays).
//
// Malformed legacy markdown (routing parse error, e.g. the flattened
// indentation class of 2026-07-16) → exit 4, zero writes: never migrate
// invented state (M008-CONTEXT decision #2).
//
// Exit codes (D7):
//   0 — migrated, already-migrated no-op, or dry-run
//   3 — resolved diff/schema warning (gate STOP) or post-write re-verify rollback
//   4 — legacy markdown parse error (STOP)
//   1 — unexpected error / bad arguments
//
// Reuse contract (D1): the Markdown extractor comes from forge-prefs-legacy.js;
// parseJsonc / deepMerge and every catalog
// primitive from forge-prefs-scaffold.js (generateScaffold / segmentCatalog /
// off-marker grammar). This module declares ZERO markdown-extraction regexes.
//
// Test-only hook: FORGE_PREFS_MIGRATE_TEST_MUTATE=1 perturbs the generated
// jsonc BEFORE the gate runs, so the exit-3 zero-write path is e2e-testable
// (precedent: FORGE_XLLM_AGY_BIN mocks). Never set outside tests.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  parseJsonc,
  preferenceLayerDescriptors,
  deepMerge,
  loadSchema,
  validatePrefs,
} = require('./forge-prefs.js');
const { legacyReadLayer } = require('./forge-prefs-legacy.js');

const {
  generateScaffold,
  segmentCatalog,
  OFF_MARKER,
} = require('./forge-prefs-scaffold.js');

// ── Small local helpers (structural, not extraction) ───────────────────────

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonEqual(left, right) {
  // NOTE: JSON.stringify collapses NaN/Infinity→null; unreachable today (legacy reader + --set
  // never route non-JSON-safe numerics here), but a future numeric source would need a richer equality.
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function getDottedValue(value, dotted) {
  let current = value;
  for (const key of dotted.split('.')) {
    if (!isPlainObject(current) || !hasOwn(current, key)) return { found: false, value: undefined };
    current = current[key];
  }
  return { found: true, value: current };
}

function setDottedValue(value, dotted, nextValue) {
  const keys = dotted.split('.');
  if (!dotted || keys.some((key) => !key)) throw new Error('key must be a non-empty dotted path');
  const output = deepMerge({}, value || {});
  let current = output;
  for (let index = 0; index < keys.length - 1; index++) {
    const key = keys[index];
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key];
  }
  current[keys[keys.length - 1]] = nextValue;
  return output;
}

function parseSetExpression(expression) {
  const equals = String(expression || '').indexOf('=');
  if (equals <= 0) throw new Error('--set expects dotted.key=value');
  const key = expression.slice(0, equals).trim();
  const raw = expression.slice(equals + 1);
  if (!key || key.split('.').some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error('--set key must be a dotted key');
  }
  try { return { key, value: JSON.parse(raw) }; } catch { return { key, value: raw }; }
}

// ── resolvedDiff — the gate (pure, exported) ────────────────────────────────
// Deep-compares two resolved preference objects and returns every divergence
// as [{path, old, new}]. Arrays compare by whole-value equality (replace
// semantics, matching deepMerge). The top-level `$schema` key is catalog
// metadata introduced by the scaffold — it is ignored, never a divergence.

function resolvedDiff(oldObj, newObj) {
  const diffs = [];
  (function walk(a, b, prefix) {
    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = new Set(Object.keys(a).concat(Object.keys(b)));
      for (const key of keys) {
        if (prefix === '' && key === '$schema') continue;
        const dotted = prefix ? `${prefix}.${key}` : key;
        if (!hasOwn(a, key)) diffs.push({ path: dotted, old: undefined, new: b[key] });
        else if (!hasOwn(b, key)) diffs.push({ path: dotted, old: a[key], new: undefined });
        else walk(a[key], b[key], dotted);
      }
      return;
    }
    if (!jsonEqual(a, b)) diffs.push({ path: prefix || '<root>', old: a, new: b });
  })(oldObj || {}, newObj || {}, '');
  return diffs;
}

// ── activateValues — scaffold + user values ────────────────────────────────
// Starts from the all-commented scaffold and appends one ACTIVE JSON entry per
// top-level key found in `values`, placed right after that key's commented
// scaffold segment (the docs stay). Keys the schema does not know (typo or
// custom — D4) are spliced literally before the root close with a marker
// comment. The result MUST parse via parseJsonc to exactly `values` (plus the
// `$schema` metadata key, which the gate ignores).

function renderActiveEntry(key, value, note) {
  const json = JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');
  const lines = [];
  if (note) lines.push(`  // ${note}`);
  lines.push(`  ${JSON.stringify(key)}: ${json},`);
  return `${lines.join('\n')}\n`;
}

function activateValues(catalogText, values, schema) {
  const userValues = values || {};
  const pending = new Set(Object.keys(userValues));
  let output = '';
  for (const segment of segmentCatalog(catalogText)) {
    output += segment.raw;
    if (segment.key && pending.has(segment.key)) {
      if (!output.endsWith('\n')) output += '\n';
      output += renderActiveEntry(segment.key, userValues[segment.key]);
      pending.delete(segment.key);
    }
  }
  if (pending.size > 0) {
    // Out-of-schema keys (D4): no scaffold segment exists — splice before the
    // root close so they live inside the JSON object. The generated catalog is
    // module-owned text: its final `}` is always the root close.
    let block = '';
    for (const key of Object.keys(userValues)) {
      if (!pending.has(key)) continue;
      block += renderActiveEntry(key, userValues[key], 'migrated from legacy md (not in schema)');
    }
    const close = output.lastIndexOf('}');
    if (close === -1) throw new Error('generated catalog has no root close');
    const head = output.slice(0, close);
    output = `${head.endsWith('\n') ? head : `${head}\n`}${block}${output.slice(close)}`;
  }
  const parsed = parseJsonc(output);
  if (!parsed.ok) {
    throw new Error(`activateValues produced invalid JSONC: ${parsed.error.message}`);
  }
  if (schema) {
    // Structural sanity only; the real gate is resolvedDiff in migrateLayer.
    const check = resolvedDiff(userValues, parsed.value);
    if (check.length > 0) {
      throw new Error(`activateValues round-trip mismatch: ${check.map((d) => d.path).join(', ')}`);
    }
  }
  return output;
}

// ── Layer descriptors ──────────────────────────────────────────────────────
// The file lists come from forge-prefs.js#preferenceLayerDescriptors — the
// SAME lists readPrefs resolves (global ~/.claude; local <cwd>/.gsd with the
// repo-shared md before the personal md, last-wins). The 3→2 fold direction
// of decision #1 therefore comes from the old-reader itself and is never
// re-implemented here. No legacy filename literal exists in this module.

function layerDescriptors(cwd, opts) {
  return preferenceLayerDescriptors(cwd, opts);
}

function existingFiles(files) {
  return files.filter((file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
}

// Resolve the current on-disk state of both layers with composed semantics
// (jsonc shadows md). Used for the merged capture and the post-write
// re-verify. With default dirs the CLI path uses the REAL readPrefs(cwd);
// with test overrides (globalDir/localDir) it composes the identical shape
// via the same exported primitives (parseJsonc / legacyReadLayer / deepMerge).
function resolveCurrent(cwd, opts) {
  const options = opts || {};
  const errors = [];
  const layers = layerDescriptors(cwd, options).map((layer) => {
    if (existingFiles([layer.jsoncPath]).length === 1) {
      let raw;
      try {
        raw = fs.readFileSync(layer.jsoncPath, 'utf8');
      } catch (error) {
        errors.push({ file: layer.jsoncPath, line: null, message: error.message });
        return {};
      }
      const parsed = parseJsonc(raw);
      if (!parsed.ok) {
        errors.push({ file: layer.jsoncPath, line: parsed.error.line, message: parsed.error.message });
        return {};
      }
      return parsed.value;
    }
    const legacy = legacyReadLayer(layer.mdFiles);
    if (legacy.routingMalformed) {
      errors.push({
        file: legacy.malformedFile,
        line: null,
        message: `routing-parse-error: malformed routing block in ${legacy.malformedFile}`,
      });
      delete legacy.prefs.routing;
    }
    return legacy.prefs;
  });
  return { prefs: deepMerge(layers[0], layers[1]), errors };
}

// ── migrateLayer — the per-layer pipeline (D3, D5) ─────────────────────────

function bakPathFor(mdFile) {
  const candidate = `${mdFile}.bak`;
  if (!fs.existsSync(candidate)) return candidate;
  // Never clobber a pre-existing .bak: it may hold an older, still-precious
  // pre-migration state. Timestamp-suffix instead.
  return `${mdFile}.bak-${Date.now()}`;
}

// prepareLayer performs the entire read-only half of the pipeline: capture is
// the caller's, generation and THE GATE happen here — with ZERO writes. Only
// a prep whose gate passed may be handed to commitLayer.
function prepareLayer(layer) {
  const { name, jsoncPath, mdFiles, oldLayerResolved, schema } = layer;
  if (fs.existsSync(jsoncPath)) {
    // Idempotence (D5): the layer already migrated. Do not re-read md or .bak.
    return { name, action: 'skipped', reason: 'already-migrated', jsoncPath };
  }
  const present = existingFiles(mdFiles);
  if (present.length === 0) {
    return { name, action: 'skipped', reason: 'absent', jsoncPath };
  }
  const effectiveSchema = schema || loadSchema();
  if (!effectiveSchema) return { name, action: 'error', reason: 'schema-unavailable' };
  const schemaRef = path
    .relative(path.dirname(jsoncPath), path.join(__dirname, '..', 'forge-prefs.schema.json'))
    .split(path.sep).join('/') || 'forge-prefs.schema.json';
  let generated = activateValues(
    generateScaffold(effectiveSchema, { schemaRef }),
    oldLayerResolved,
    effectiveSchema,
  );
  if (process.env.FORGE_PREFS_MIGRATE_TEST_MUTATE === '1') {
    // TEST-ONLY: perturb the generated catalog before the gate so the exit-3
    // zero-write path can be exercised end to end. Never set in production.
    const close = generated.lastIndexOf('}');
    generated = `${generated.slice(0, close)}  "__forge_test_mutation": 1\n${generated.slice(close)}`;
  }
  const parsed = parseJsonc(generated);
  if (!parsed.ok) return { name, action: 'error', reason: `generated-jsonc-invalid: ${parsed.error.message}` };

  // ── THE GATE (D2 / RISK BLOCKER 1): in-memory, before ANY filesystem write.
  const diff = resolvedDiff(oldLayerResolved, parsed.value);
  if (diff.length > 0) {
    return { name, action: 'stop', reason: 'diff', diff, jsoncPath };
  }
  // Schema is an independent gate from the round-trip proof above: the
  // legacy and generated values can agree while still being invalid for the
  // catalog schema. Keep this before commit so rejection leaves no .bak or
  // jsonc artifact behind.
  const warnings = validatePrefs(parsed.value, effectiveSchema);
  if (warnings.length > 0) {
    return { name, action: 'stop', reason: 'schema-warnings', warnings, jsoncPath };
  }
  return { name, action: 'ready', jsoncPath, mdFiles: present, generated, diff: [] };
}

// commitLayer performs the write half: .bak of every legacy md FIRST (never
// clobbering an existing .bak), then the jsonc catalog (LF, utf8).
function commitLayer(prep) {
  const baks = [];
  for (const mdFile of prep.mdFiles) {
    const bak = bakPathFor(mdFile);
    fs.copyFileSync(mdFile, bak);
    baks.push(bak);
  }
  fs.writeFileSync(prep.jsoncPath, prep.generated, 'utf8');
  return { name: prep.name, action: 'migrated', jsoncPath: prep.jsoncPath, baks, mdFiles: prep.mdFiles, diff: [] };
}

// Single-layer convenience pipeline (exported for tests / targeted callers).
function migrateLayer(layer) {
  const prep = prepareLayer(layer);
  if (prep.action !== 'ready') return prep;
  if (layer.dryRun) {
    return {
      name: prep.name,
      action: 'dry-run',
      jsoncPath: prep.jsoncPath,
      wouldBackup: prep.mdFiles.map((file) => `${file}.bak`),
      diff: [],
    };
  }
  return commitLayer(prep);
}

// Local catalogues must not silently become team configuration.  This helper
// is intentionally best-effort: a non-repository is a valid caller, and an
// already-covered path needs no textual .gitignore edit.  `execFileSync` is
// injectable so tests can prove all three branches without invoking git.
function ensureGitignore(cwd, opts) {
  const options = opts || {};
  const run = options.execFileSync || execFileSync;
  const write = options.writeFileSync || fs.writeFileSync;
  const exists = options.existsSync || fs.existsSync;
  const gitignore = path.join(cwd, '.gitignore');
  const warning = 'config de time por commit deixa de existir — valores fundidos no seu local gitignored';
  try {
    run('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'ignore' });
  } catch {
    return { action: 'skipped', reason: 'not-git', warning: null };
  }
  try {
    run('git', ['check-ignore', '-q', '.gsd/forge-prefs.jsonc'], { cwd, stdio: 'ignore' });
    return { action: 'skipped', reason: 'already-ignored', warning: null };
  } catch {
    // git check-ignore uses exit 1 for an unignored path; any other failure is
    // conservatively treated the same, because the preceding rev-parse proved
    // this is a repository and the additive rule is safe.
  }
  if (options.dryRun) return { action: 'would-append', path: gitignore, warning: `adicionaria .gsd/forge-prefs.jsonc ao .gitignore; ${warning}` };
  let old = '';
  if (exists(gitignore)) old = fs.readFileSync(gitignore, 'utf8');
  const newline = old.length === 0 || old.endsWith('\n') ? old : `${old}\n`;
  write(gitignore, `${newline}.gsd/forge-prefs.jsonc\n`, 'utf8');
  return { action: 'appended', path: gitignore, warning: `adicionado .gsd/forge-prefs.jsonc ao .gitignore; ${warning}` };
}

// Set a dotted knob while retaining every existing catalogue segment verbatim.
// JSON permits later duplicate object keys; the JSONC reader resolves the last
// one. Appending an active replacement section therefore edits only new bytes,
// preserving the user-owned source block byte-for-byte. Fresh catalogues go
// through activateValues, which shares the scaffold's OFF_MARKER grammar.
function setCatalogValue(catalogText, dotted, value, schema) {
  const parsed = parseJsonc(catalogText);
  if (!parsed.ok) throw new Error(`cannot set value in invalid JSONC: ${parsed.error.message}`);
  const keys = dotted.split('.');
  const section = keys[0];
  const next = setDottedValue(parsed.value, dotted, value);
  // segmentCatalog is the only catalogue locator used here; OFF_MARKER comes
  // from the scaffold module rather than defining a competing on/off grammar.
  const segments = segmentCatalog(catalogText);
  const hasSection = segments.some((segment) => segment.key === section);
  if (!hasSection && !OFF_MARKER) throw new Error('scaffold off-marker unavailable');
  let output = catalogText;
  const close = output.lastIndexOf('}');
  if (close === -1) throw new Error('catalog has no root close');
  const head = output.slice(0, close);
  output = `${head.endsWith('\n') ? head : `${head}\n`}${renderActiveEntry(section, next[section], 'set by forge-prefs-migrate --set')}${output.slice(close)}`;
  const checked = parseJsonc(output);
  if (!checked.ok) throw new Error(`--set produced invalid JSONC: ${checked.error.message}`);
  return output;
}

function setPreference(cwd, expression, opts) {
  const options = opts || {};
  // $schema is tooling metadata (the catalog-reference hook), not a user
  // preference — refuse to set it BEFORE parseSetExpression (whose dotted-key
  // regex rejects the leading `$` with a generic message) so the viewer/skill
  // never delegate a catalog-corrupting write.
  const rawKey = String(expression || '').slice(0, String(expression || '').indexOf('=')).trim();
  if (rawKey === '$schema') {
    throw new Error('$schema é metadata de tooling, não pode ser setado como preferência');
  }
  const requested = parseSetExpression(expression);
  const descriptors = layerDescriptors(cwd, options);
  const defaultLayer = fs.existsSync(path.join(cwd, '.gsd')) ? 'local' : 'global';
  const layerName = options.layer || defaultLayer;
  if (layerName !== 'global' && layerName !== 'local') throw new Error('--layer must be global or local');
  const layer = descriptors.find((entry) => entry.name === layerName);
  const exists = fs.existsSync(layer.jsoncPath);
  if (!exists && layerName === 'local' && !options.create) {
    return { status: 'local-create-required', layer: layerName, path: layer.jsoncPath };
  }
  const schema = options.schema || loadSchema();
  if (!schema) throw new Error('forge-prefs.schema.json unavailable');
  // Enum/type gate — pre-write, reusing validatePrefs (schema is the single
  // source of truth, DECISION 53). Build a minimal candidate carrying only
  // the requested key so pre-existing legacy state elsewhere in the resolved
  // prefs never gets flagged (Pitfall 1). The candidate contains ONLY the
  // requested dotted chain, so ANY warning validatePrefs emits on it is
  // necessarily about that chain (ancestor, descendant, or the exact key) —
  // reject on any warning rather than filtering by exact key match, which
  // let unknown/invalid keys under a validated ancestor/descendant slip
  // through and get written (review-fix/TASK-001, R1 conceded).
  const candidate = setDottedValue({}, requested.key, requested.value);
  const candidateWarnings = validatePrefs(candidate, schema);
  if (candidateWarnings.length > 0) {
    throw new Error(candidateWarnings.map((warning) => warning.message).join('; '));
  }
  const schemaRef = path.relative(path.dirname(layer.jsoncPath), path.join(__dirname, '..', 'forge-prefs.schema.json')).split(path.sep).join('/') || 'forge-prefs.schema.json';
  const original = exists ? fs.readFileSync(layer.jsoncPath, 'utf8') : generateScaffold(schema, { schemaRef });
  const next = exists
    ? setCatalogValue(original, requested.key, requested.value, schema)
    : activateValues(original, setDottedValue({}, requested.key, requested.value), schema);
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(layer.jsoncPath), { recursive: true });
    fs.writeFileSync(layer.jsoncPath, next, 'utf8');
  }
  const resolved = options.dryRun
    ? parseJsonc(next).value
    : resolveCurrent(cwd, options).prefs;
  const actual = getDottedValue(resolved, requested.key);
  if (!actual.found || !jsonEqual(actual.value, requested.value)) {
    throw new Error(`--set verification failed for ${requested.key}`);
  }
  return { status: options.dryRun ? 'dry-run' : 'set', layer: layerName, path: layer.jsoncPath, key: requested.key, value: requested.value };
}

// ── migrateAll — capture → per-layer → re-verify → cleanup ─────────────────

function migrateAll(cwd, opts) {
  const options = opts || {};
  const targetCwd = cwd || process.cwd();
  const schema = options.schema || loadSchema();
  if (!schema) return { status: 'error', errors: [{ message: 'forge-prefs.schema.json unavailable' }], layers: [] };

  const descriptors = layerDescriptors(targetCwd, options).filter((layer) => {
    if (options.globalOnly) return layer.name === 'global';
    if (options.localOnly) return layer.name === 'local';
    return true;
  });

  // Capture: per-layer legacy resolved (only for layers still on markdown) and
  // the merged pre-migration resolved for the whole-object re-verify gate.
  const captures = [];
  for (const layer of descriptors) {
    if (fs.existsSync(layer.jsoncPath) || existingFiles(layer.mdFiles).length === 0) {
      captures.push({ layer, oldLayerResolved: {} });
      continue;
    }
    const legacy = legacyReadLayer(layer.mdFiles);
    if (legacy.routingMalformed) {
      // Malformed legacy markdown → never migrate invented state (exit 4).
      return {
        status: 'legacy-parse-error',
        errors: [{
          file: legacy.malformedFile,
          message: `routing-parse-error: malformed routing block in ${legacy.malformedFile}`,
        }],
        layers: [],
      };
    }
    captures.push({ layer, oldLayerResolved: legacy.prefs });
  }
  const before = resolveCurrent(targetCwd, options);
  if (before.errors.length > 0) {
    return { status: 'legacy-parse-error', errors: before.errors, layers: [] };
  }

  // Phase 1 — prepare EVERY layer (read-only). A gate failure in ANY layer
  // stops the whole run before a single byte is written anywhere: "exit 3,
  // ZERO writes" holds across layers, not just within one.
  const preps = [];
  for (const capture of captures) {
    const prep = prepareLayer({
      name: capture.layer.name,
      jsoncPath: capture.layer.jsoncPath,
      mdFiles: capture.layer.mdFiles,
      oldLayerResolved: capture.oldLayerResolved,
      schema,
    });
    preps.push(prep);
    if (prep.action === 'stop') {
      if (prep.reason === 'schema-warnings') {
        return { status: 'schema-warnings', layers: preps, warnings: prep.warnings };
      }
      return { status: 'diff', layers: preps, diff: prep.diff };
    }
    if (prep.action === 'error') {
      return { status: 'error', layers: preps, errors: [{ message: prep.reason }] };
    }
  }

  const ready = preps.filter((prep) => prep.action === 'ready');
  if (options.dryRun) {
    const localReady = preps.find((prep) => prep.name === 'local' && prep.action === 'ready');
    const execForIgnore = options.execFileSync || ((options.globalDir || options.localDir) ? (() => { throw new Error('not a git repository'); }) : undefined);
    const gitignore = localReady ? ensureGitignore(targetCwd, { dryRun: true, execFileSync: execForIgnore }) : null;
    return {
      status: 'dry-run',
      gitignore,
      layers: preps.map((prep) => (prep.action !== 'ready' ? prep : {
        name: prep.name,
        action: 'dry-run',
        jsoncPath: prep.jsoncPath,
        wouldBackup: prep.mdFiles.map((file) => `${file}.bak`),
        diff: [],
      })),
    };
  }
  if (ready.length === 0) return { status: 'noop', layers: preps };

  // Phase 2 — commit (writes) only after every gate passed.
  // Commit is injectable so tests can force a mid-loop throw. If any layer's
  // commit throws mid-loop (ENOSPC/EACCES on the 2nd+ layer), UNWIND: delete
  // the jsonc files already written by prior successful commits in THIS run,
  // leaving the .bak files and original mds intact, then surface the error.
  // Mirrors the rigor of the post-write-diff rollback below.
  const commit = options.commitLayer || commitLayer;
  const results = [];
  const writtenJsonc = [];
  try {
    for (const prep of preps) {
      if (prep.action !== 'ready') { results.push(prep); continue; }
      const result = commit(prep);
      results.push(result);
      if (result.action === 'migrated') writtenJsonc.push(result.jsoncPath);
    }
  } catch (err) {
    for (const jsoncPath of writtenJsonc) {
      try { fs.unlinkSync(jsoncPath); } catch { /* unwind best effort */ }
    }
    return { status: 'error', layers: results, errors: [{ message: err && err.message ? err.message : String(err) }] };
  }
  const migrated = results.filter((result) => result.action === 'migrated');

  // Post-write re-verify (D3): run the REAL resolver over the new state and
  // diff against the captured pre-migration resolved. The legacy md files are
  // still on disk here — the jsonc shadow makes them inert — so a rollback
  // (delete the jsonc) restores the exact previous state.
  const after = resolveCurrent(targetCwd, options);
  const mergedDiff = resolvedDiff(before.prefs, after.prefs);
  const schemaWarnings = validatePrefs(after.prefs, schema);
  if (after.errors.length > 0 || mergedDiff.length > 0 || schemaWarnings.length > 0) {
    for (const result of migrated) {
      try { fs.unlinkSync(result.jsoncPath); } catch { /* rollback best effort */ }
    }
    return { status: 'rollback', layers: results, diff: mergedDiff, errors: after.errors, warnings: schemaWarnings };
  }

  // Success: retire the legacy md files (the .bak stays as the recovery copy).
  for (const result of migrated) {
    for (const mdFile of result.mdFiles) {
      try { fs.unlinkSync(mdFile); } catch { /* leave shadowed file behind */ }
    }
  }
  const localMigrated = migrated.some((result) => result.name === 'local');
  // Directory overrides are a test/embedding API, not an instruction to run
  // the caller's git executable. They model a non-git temp directory unless
  // the embedding caller deliberately supplies the standard exec hook.
  const execForIgnore = options.execFileSync || ((options.globalDir || options.localDir) ? (() => { throw new Error('not a git repository'); }) : undefined);
  const gitignore = localMigrated
    ? ensureGitignore(targetCwd, { execFileSync: execForIgnore })
    : null;
  // The first local legacy source is the repo-shared file by the canonical
  // descriptor order. Keep filename ownership in forge-prefs.js alone.
  const localDescriptor = descriptors.find((descriptor) => descriptor.name === 'local');
  const repoSharedLegacy = localDescriptor && localDescriptor.mdFiles[0];
  const teamFolded = migrated.some((result) => result.name === 'local' && result.mdFiles.includes(repoSharedLegacy));
  const warnings = [];
  if (gitignore && gitignore.warning) warnings.push(gitignore.warning);
  if (teamFolded) warnings.push('config de time por commit deixa de existir — valores fundidos no seu local gitignored');
  return { status: 'migrated', layers: results, diff: [], gitignore, warnings };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const args = {
    cwd: process.cwd(),
    dryRun: false,
    globalOnly: false,
    localOnly: false,
    json: false,
    globalDir: null,
    localDir: null,
    set: null,
    layer: null,
    create: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--cwd') args.cwd = path.resolve(argv[++index] || process.cwd());
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--global-only') args.globalOnly = true;
    else if (arg === '--local-only') args.localOnly = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--set') args.set = argv[++index] || '';
    else if (arg === '--layer') args.layer = argv[++index] || '';
    else if (arg === '--create') args.create = true;
    // Test/advanced overrides — keep the CLI e2e-testable without ever
    // touching the operator's real ~/.claude.
    else if (arg === '--global-dir') args.globalDir = path.resolve(argv[++index] || '');
    else if (arg === '--local-dir') args.localDir = path.resolve(argv[++index] || '');
    else return { error: `unknown argument: ${arg}` };
  }
  return args;
}

function printDiff(diff, write) {
  for (const entry of diff) {
    write(`  ✗ ${entry.path}: old=${JSON.stringify(entry.old)} new=${JSON.stringify(entry.new)}\n`);
  }
}

function exitCodeFor(status) {
  if (status === 'migrated' || status === 'noop' || status === 'dry-run') return 0;
  if (status === 'diff' || status === 'schema-warnings' || status === 'rollback') return 3;
  if (status === 'legacy-parse-error') return 4;
  return 1;
}

function runCli(argv) {
  const args = parseCliArgs(argv);
  const err = (text) => process.stderr.write(text);
  if (args.error) {
    err(`✗ forge-prefs-migrate: ${args.error}\n`);
    return 1;
  }
  if (args.set !== null) {
    try {
      const result = setPreference(args.cwd, args.set, args);
      if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else process.stderr.write(`✓ ${result.status}: ${result.key || ''} (${result.layer})\n`);
      return result.status === 'local-create-required' ? 1 : 0;
    } catch (error) {
      err(`✗ prefs --set error: ${error.message}\n`);
      return 1;
    }
  }
  let result;
  try {
    result = migrateAll(args.cwd, {
      dryRun: args.dryRun,
      globalOnly: args.globalOnly,
      localOnly: args.localOnly,
      globalDir: args.globalDir || undefined,
      localDir: args.localDir || undefined,
    });
  } catch (error) {
    err(`✗ forge-prefs-migrate: unexpected error: ${error.message}\n`);
    if (args.json) process.stdout.write(`${JSON.stringify({ status: 'error', errors: [{ message: error.message }] })}\n`);
    return 1;
  }
  if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  for (const layer of result.layers || []) {
    if (layer.action === 'skipped') err(`• ${layer.name}: skipped (${layer.reason})\n`);
    else if (layer.action === 'dry-run') err(`• ${layer.name}: would migrate → ${layer.jsoncPath} (gate diff: empty)\n`);
    else if (layer.action === 'migrated') err(`✓ ${layer.name}: migrated → ${layer.jsoncPath} (gate diff: empty; .bak: ${(layer.baks || []).join(', ')})\n`);
    else if (layer.action === 'stop' && layer.reason === 'schema-warnings') err(`✗ ${layer.name}: schema warnings — migration stopped, zero writes\n`);
    else if (layer.action === 'stop') err(`✗ ${layer.name}: resolved diff NON-EMPTY — migration stopped, zero writes\n`);
  }
  if (result.status === 'diff' || result.status === 'rollback') {
    err(`✗ gate STOP (${result.status}): the old and new resolved objects diverge:\n`);
    printDiff(result.diff || [], err);
    if (result.status === 'rollback') err('✗ jsonc rolled back; legacy md files untouched (.bak kept)\n');
  }
  if (result.status === 'schema-warnings' || (result.status === 'rollback' && (result.warnings || []).length > 0)) {
    for (const warning of result.warnings || []) err(`✗ schema warning: ${warning.key}: ${warning.message}\n`);
    err('✗ migration refused to avoid corrupting values; legacy sources and any existing .bak preserved\n');
  } else if (result.status === 'legacy-parse-error') {
    for (const entry of result.errors || []) err(`✗ legacy parse error: ${entry.file || ''} — ${entry.message}\n`);
    err('✗ fix the legacy markdown before migrating — never migrating invented state\n');
  } else if (result.status === 'migrated') {
    err('✓ migration complete — resolved diff old×new: empty (round-trip proven)\n');
  } else if (result.status === 'noop') {
    err('• nothing to migrate (already migrated or no legacy markdown)\n');
  } else if (result.status === 'dry-run') {
    err('• dry-run: no files written\n');
  }
  if (result.status === 'migrated') {
    for (const warning of result.warnings || []) err(`⚠ ${warning}\n`);
  }
  if (result.gitignore && result.gitignore.action === 'would-append') err(`⚠ ${result.gitignore.warning}\n`);
  return exitCodeFor(result.status);
}

module.exports = {
  resolvedDiff,
  activateValues,
  prepareLayer,
  commitLayer,
  migrateLayer,
  migrateAll,
  ensureGitignore,
  setCatalogValue,
  setPreference,
  parseSetExpression,
  layerDescriptors,
  resolveCurrent,
  runCli,
};

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
