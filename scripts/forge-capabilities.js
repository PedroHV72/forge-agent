#!/usr/bin/env node
'use strict';

/*
 * Canonical capability catalog reader.  It intentionally has no npm
 * dependency: release gates run from a fresh clone on Windows, macOS and
 * Linux.  Paths shown to people are always POSIX-style catalog paths.
 */

const fs = require('fs');
const path = require('path');
const { HOST_RUNTIMES } = require('./forge-runtime.js');

const AVAILABILITY = Object.freeze(['implemented', 'planned', 'conditional', 'unavailable']);
const KINDS = Object.freeze(['skill', 'agent', 'command', 'hook', 'headless', 'mcp', 'statusline', 'accounts', 'app']);

// Public API notes for adapter authors:
// AVAILABILITY is deliberately closed so a typo cannot claim a green host.
// KINDS is deliberately closed so operational surfaces remain reviewable.
// posixPath is presentation-only; filesystem access always uses Node paths.
// loadCatalog does not infer a release version from this catalog.
// discover covers published Forge paths, rather than every private script.
// validateCatalog validates data without touching an operator checkout.
// audit layers checkout-dependent discovery on top of structural validation.
// matrix converts canonical entries to an intentionally small public shape.
// renderText is a human convenience; JSON is the automation interface.
// parseArgs keeps this command portable without an argument-parser package.
// run returns a numeric exit status so tests and release gates share behavior.

function posixPath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read JSON ${posixPath(file)}: ${error.message}`);
  }
}

function catalogPath(cwd) { return path.join(cwd, 'forge-capabilities.json'); }
function schemaPath(cwd) { return path.join(cwd, 'schemas', 'forge-capabilities.schema.json'); }

function loadCatalog(cwd = path.resolve(__dirname, '..')) {
  const root = path.resolve(cwd);
  return { root, catalog: readJson(catalogPath(root)), schema: readJson(schemaPath(root)) };
}

function discover(root) {
  const entries = [];
  const pushFiles = (directory, expression, kind, prefix) => {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) return;
    for (const name of fs.readdirSync(absolute).sort()) {
      if (!expression.test(name)) continue;
      entries.push({ kind, path: `${prefix}/${name}` });
    }
  };
  const skillRoot = path.join(root, 'skills');
  if (fs.existsSync(skillRoot)) {
    for (const name of fs.readdirSync(skillRoot).sort()) {
      if (fs.existsSync(path.join(skillRoot, name, 'SKILL.md'))) entries.push({ kind: 'skill', path: `skills/${name}/SKILL.md` });
    }
  }
  pushFiles('agents', /^forge-.*\.md$/, 'agent', 'agents');
  pushFiles('commands', /^forge.*\.md$/, 'command', 'commands');
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function issue(issues, message) { issues.push(message); }

function validateCatalog(catalog, schema) {
  const issues = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return ['catalog must be an object'];
  if (catalog.$schema !== 'schemas/forge-capabilities.schema.json') issue(issues, 'catalog $schema must point to schemas/forge-capabilities.schema.json');
  if (!/^\d+\.\d+\.\d+$/.test(String(catalog.schema_version || ''))) issue(issues, 'catalog schema_version must be semver');
  if (!schema || !schema.$defs || !schema.$defs.host) issue(issues, 'schema must define host enums');
  const schemaHosts = (((schema || {}).$defs || {}).host || {}).enum || [];
  if (JSON.stringify(schemaHosts) !== JSON.stringify(HOST_RUNTIMES)) issue(issues, 'schema host enum drifted from forge-runtime HOST_RUNTIMES');
  const release = catalog.release || {};
  if (release.product_version_source !== 'git-tag-release-workflow') issue(issues, 'product version must derive from git-tag-release-workflow');
  for (const host of HOST_RUNTIMES) {
    const adapter = (release.adapters || {})[host];
    if (!adapter || adapter.optional !== true || adapter.host !== host) issue(issues, `adapter ${host} must be optional and target its own host`);
  }
  if (!Array.isArray(catalog.capabilities) || catalog.capabilities.length === 0) return issues.concat('catalog capabilities must be a non-empty array');
  const ids = new Set();
  for (const capability of catalog.capabilities) {
    const id = capability && capability.capability_id;
    if (!/^[a-z][a-z0-9-]*$/.test(String(id || ''))) issue(issues, `invalid capability_id ${JSON.stringify(id)}`);
    if (ids.has(id)) issue(issues, `duplicate capability_id ${id}`);
    ids.add(id);
    if (!KINDS.includes(capability.kind)) issue(issues, `${id}: invalid kind ${capability.kind}`);
    if (!/^[a-z][a-z0-9-]*$/.test(String(capability.owner || ''))) issue(issues, `${id}: owner is required`);
    if (typeof capability.required !== 'boolean') issue(issues, `${id}: required must be boolean`);
    for (const host of HOST_RUNTIMES) {
      const status = (capability.hosts || {})[host];
      if (!AVAILABILITY.includes(status)) issue(issues, `${id}: invalid ${host} classification ${JSON.stringify(status)}`);
    }
    const probe = capability.probe || {};
    if (probe.kind !== 'filesystem' || typeof probe.path !== 'string' || !probe.path || probe.path.includes('\\')) issue(issues, `${id}: probe must be a normalized filesystem path`);
    if (capability.required && (!probe.path || !probe.kind)) issue(issues, `${id}: required capability has no planned probe`);
  }
  return issues;
}

function audit(cwd = path.resolve(__dirname, '..')) {
  const { root, catalog, schema } = loadCatalog(cwd);
  const issues = validateCatalog(catalog, schema);
  const listedByPath = new Map();
  for (const capability of catalog.capabilities || []) {
    const probePath = capability.probe && capability.probe.path;
    if (!probePath) continue;
    if (listedByPath.has(probePath)) issue(issues, `duplicate probe path ${probePath}`);
    listedByPath.set(probePath, capability);
    if (capability.required && !fs.existsSync(path.join(root, probePath))) issue(issues, `${capability.capability_id}: required probe does not exist: ${probePath}`);
  }
  for (const surface of discover(root)) {
    const capability = listedByPath.get(surface.path);
    if (!capability) issue(issues, `published ${surface.kind} missing from catalog: ${surface.path}`);
    else if (capability.kind !== surface.kind) issue(issues, `${surface.path}: catalog kind ${capability.kind} does not match discovered ${surface.kind}`);
  }
  return { root, catalog, schema, issues: issues.sort(), discovered: discover(root) };
}

function orderedCapabilities(catalog) {
  return [...catalog.capabilities].sort((a, b) => a.capability_id.localeCompare(b.capability_id));
}

function matrix(catalog) {
  return orderedCapabilities(catalog).map((entry) => ({
    capability_id: entry.capability_id,
    kind: entry.kind,
    owner: entry.owner,
    required: entry.required,
    claude: entry.hosts.claude,
    codex: entry.hosts.codex,
    probe: entry.probe.path,
  }));
}

function renderText(rows) {
  const header = ['Capability', 'Kind', 'Owner', 'Claude', 'Codex', 'Probe'];
  const body = rows.map((row) => [row.capability_id, row.kind, row.owner, row.claude, row.codex, row.probe]);
  const widths = header.map((value, index) => Math.max(value.length, ...body.map((row) => row[index].length)));
  const format = (row) => row.map((value, index) => value.padEnd(widths[index])).join('  ');
  return [format(header), format(widths.map((width) => '-'.repeat(width))), ...body.map(format)].join('\n');
}

function parseArgs(argv) {
  const result = { check: false, matrix: false, json: false, cwd: path.resolve(__dirname, '..') };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--check') result.check = true;
    else if (arg === '--matrix') result.matrix = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '--cwd') result.cwd = path.resolve(argv[++index] || '');
    else if (arg === '--help') result.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return result;
}

function run(argv = process.argv.slice(2), write = process.stdout.write.bind(process.stdout)) {
  const options = parseArgs(argv);
  if (options.help) { write('Usage: forge-capabilities.js [--check] [--matrix] [--json] [--cwd PATH]\n'); return 0; }
  const result = audit(options.cwd);
  if (options.check && result.issues.length) {
    write(`Capability audit failed (${result.issues.length}):\n${result.issues.map((entry) => `- ${entry}`).join('\n')}\n`);
    return 1;
  }
  const rows = matrix(result.catalog);
  if (options.json) write(`${JSON.stringify({ schema_version: result.catalog.schema_version, release: result.catalog.release, capabilities: rows })}\n`);
  else if (options.matrix || !options.check) write(`${renderText(rows)}\n`);
  if (options.check) write(`Capability audit passed: ${rows.length} catalog entries, ${result.discovered.length} discovered surfaces.\n`);
  return 0;
}

module.exports = { AVAILABILITY, KINDS, posixPath, loadCatalog, discover, validateCatalog, audit, matrix, renderText, parseArgs, run };

if (require.main === module) {
  try { process.exitCode = run(); } catch (error) { process.stderr.write(`forge-capabilities: ${error.message}\n`); process.exitCode = 1; }
}
