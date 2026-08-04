#!/usr/bin/env node
'use strict';

// Canonical source inventory for host renderers. It contains no host paths or
// rendering prose: renderers consume this manifest and project into Claude or
// Codex-specific destinations.
const fs = require('fs');
const path = require('path');

const KINDS = Object.freeze(['agent', 'command', 'skill', 'dispatch', 'hook', 'headless', 'mcp']);
const HOST_STATUS = Object.freeze(['common', 'implemented', 'conditional', 'planned', 'unavailable']);

function posix(value) { return String(value).replace(/\\/g, '/').replace(/^\.\//, ''); }
function loadManifest(cwd = path.resolve(__dirname, '..')) {
  const root = path.resolve(cwd);
  const manifestPath = path.join(root, 'forge-manifest.json');
  const schemaPath = path.join(root, 'schemas', 'forge-manifest.schema.json');
  return { root, manifestPath, schemaPath, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')), schema: JSON.parse(fs.readFileSync(schemaPath, 'utf8')) };
}
function files(root) {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...files(full)); else if (entry.isFile()) out.push(full);
  }
  return out;
}
function discover(root) {
  const candidates = [];
  for (const relative of files(path.join(root, 'agents')).map((f) => posix(path.relative(root, f)))) if (/^agents\/[^/]+\.md$/i.test(relative)) candidates.push({ path: relative, kind: 'agent' });
  for (const relative of files(path.join(root, 'commands')).map((f) => posix(path.relative(root, f)))) if (/^commands\/[^/]+\.md$/i.test(relative)) candidates.push({ path: relative, kind: 'command' });
  for (const relative of files(path.join(root, 'skills')).map((f) => posix(path.relative(root, f)))) if (/^skills\/[^/]+\/SKILL\.md$/i.test(relative)) candidates.push({ path: relative, kind: 'skill' });
  for (const relative of files(path.join(root, 'shared', 'templates', 'dispatch')).map((f) => posix(path.relative(root, f)))) if (/^shared\/templates\/dispatch\/[^/]+\.md$/i.test(relative)) candidates.push({ path: relative, kind: 'dispatch' });
  for (const [relative, kind] of [['scripts/forge-hook.js', 'hook'], ['scripts/forge-dispatch-resolve.js', 'headless'], ['shared/forge-mcps.md', 'mcp']]) if (fs.existsSync(path.join(root, relative))) candidates.push({ path: relative, kind });
  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}
function patternRegex(pattern) {
  const escaped = posix(pattern).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return new RegExp(`^${escaped}$`);
}
function validate(manifest) {
  const issues = [];
  if (!manifest || manifest.$schema !== 'schemas/forge-manifest.schema.json') issues.push('$schema must point to schemas/forge-manifest.schema.json');
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest && manifest.schema_version || ''))) issues.push('schema_version must be semver');
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest && manifest.product_version || ''))) issues.push('product_version must be semver');
  if (!manifest || manifest.newline !== 'lf') issues.push('newline must be lf');
  const ids = new Set(); const discoveries = new Set();
  for (const entry of (manifest && manifest.entries) || []) {
    const id = String(entry && entry.source_id || '');
    if (!/^[a-z][a-z0-9-]*$/.test(id)) issues.push(`invalid source_id ${JSON.stringify(id)}`);
    if (ids.has(id)) issues.push(`duplicate source_id ${id}`); ids.add(id);
    if (!KINDS.includes(entry.kind)) issues.push(`${id}: invalid kind`);
    if (!/^[a-z][a-z0-9-]*$/.test(String(entry.owner || ''))) issues.push(`${id}: owner is required`);
    const discovery = String(entry.discovery || '');
    if (!discovery || discovery.startsWith('/') || discovery.includes('\\') || discovery.split('/').some((part) => part === '.' || part === '..')) issues.push(`${id}: discovery must be a relative POSIX path`);
    if (discoveries.has(discovery)) issues.push(`duplicate discovery ${discovery}`); discoveries.add(discovery);
    if (!entry.hosts || !Object.keys(entry.hosts).every((host) => ['claude', 'codex'].includes(host)) || !['claude', 'codex'].every((host) => HOST_STATUS.includes(entry.hosts[host]))) issues.push(`${id}: hosts must declare Claude and Codex statuses`);
    if (!Array.isArray(entry.capabilities) || entry.capabilities.length === 0 || new Set(entry.capabilities).size !== entry.capabilities.length) issues.push(`${id}: capabilities must be a non-empty unique array`);
  }
  if (!Array.isArray(manifest && manifest.entries) || manifest.entries.length === 0) issues.push('entries must be non-empty');
  return issues.sort();
}
function audit(cwd = path.resolve(__dirname, '..')) {
  const loaded = loadManifest(cwd); const issues = validate(loaded.manifest); const entries = loaded.manifest.entries || [];
  const discovered = discover(loaded.root); const matched = new Map();
  for (const surface of discovered) {
    const matches = entries.filter((entry) => patternRegex(entry.discovery).test(surface.path));
    if (!matches.length) issues.push(`published ${surface.kind} missing from manifest: ${surface.path}`);
    else if (!matches.some((entry) => entry.kind === surface.kind)) issues.push(`${surface.path}: manifest kind mismatch`);
    else matched.set(surface.path, matches.map((entry) => entry.source_id));
  }
  return { ...loaded, entries, discovered, matched, issues: [...new Set(issues)].sort() };
}
function matrix(manifest) { return [...(manifest.entries || [])].sort((a, b) => a.source_id.localeCompare(b.source_id)).map((entry) => ({ source_id: entry.source_id, kind: entry.kind, owner: entry.owner, discovery: entry.discovery, hosts: entry.hosts, capabilities: entry.capabilities })); }
function run(argv = process.argv.slice(2), write = process.stdout.write.bind(process.stdout)) {
  const options = { cwd: path.resolve(__dirname, '..'), json: false, audit: false };
  for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (arg === '--cwd') options.cwd = path.resolve(argv[++i] || ''); else if (arg === '--json') options.json = true; else if (arg === '--audit' || arg === '--check') options.audit = true; else if (arg === '--help') { write('Usage: forge-manifest.js [--audit|--check] [--json] [--cwd PATH]\n'); return 0; } else throw new Error(`unknown option ${arg}`); }
  const result = audit(options.cwd);
  if (options.audit && result.issues.length) { write(`${options.json ? JSON.stringify({ ok: false, issues: result.issues }) : `Manifest audit failed:\n${result.issues.map((issue) => `- ${issue}`).join('\n')}\n`}`); return 1; }
  write(options.json ? `${JSON.stringify({ ok: true, schema_version: result.manifest.schema_version, entries: matrix(result.manifest), discovered: result.discovered })}\n` : `Manifest audit passed: ${result.entries.length} entries, ${result.discovered.length} discovered surfaces.\n`);
  return 0;
}
module.exports = { KINDS, HOST_STATUS, posix, loadManifest, discover, patternRegex, validate, audit, matrix, run };
if (require.main === module) { try { process.exitCode = run(); } catch (error) { process.stderr.write(`forge-manifest: ${error.message}\n`); process.exitCode = 1; } }
