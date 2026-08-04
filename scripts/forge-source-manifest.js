#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_ROOTS = ['agents', 'commands', 'skills', 'shared/templates/dispatch'];
const REASON = Object.freeze({ INVALID_SCHEMA: 'invalid_schema', DUPLICATE_ID: 'duplicate_source_id', UNSAFE_PATH: 'unsafe_path', COMMON_HOST_RULE: 'host_rule_in_common', UNCOVERED_PUBLIC_SURFACE: 'uncovered_public_surface' });
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function isSafeRelative(value) { return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && value.split(/[\\/]/).every(part => part && part !== '..'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function stable(value) { return JSON.stringify(canonical(value)); }
function normalize(value) { return `${stable(value)}\n`; }
function readManifest(cwd, file = 'forge-source-manifest.json') { return JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf8')); }
function validate(manifest) {
  if (!manifest || manifest.schema_version !== '1.0.0' || !Array.isArray(manifest.sources)) fail(REASON.INVALID_SCHEMA, 'manifest schema_version 1.0.0 e sources são obrigatórios');
  const ids = new Set();
  for (const source of manifest.sources) {
    for (const key of ['source_id', 'owner', 'inputs', 'render_targets', 'capability', 'security_role', 'newline', 'origin_header', 'common']) if (!(key in source)) fail(REASON.INVALID_SCHEMA, `campo obrigatório ausente: ${key}`);
    if (!/^[a-z][a-z0-9-]*$/.test(source.source_id)) fail(REASON.INVALID_SCHEMA, 'source_id inválido');
    if (ids.has(source.source_id)) fail(REASON.DUPLICATE_ID, `source_id duplicado: ${source.source_id}`); ids.add(source.source_id);
    if (!['public', 'operator', 'internal'].includes(source.security_role) || !['lf', 'crlf', 'preserve'].includes(source.newline)) fail(REASON.INVALID_SCHEMA, 'enum inválido');
    for (const item of [...source.inputs, ...source.render_targets.map(target => target.path)]) if (!isSafeRelative(item)) fail(REASON.UNSAFE_PATH, `path inseguro: ${item}`);
    if (/claude|codex|~[\\/]/i.test(JSON.stringify(source.common))) fail(REASON.COMMON_HOST_RULE, `regra host-specific em common: ${source.source_id}`);
  }
  return manifest;
}
function targetCovers(target, root) { return target.path === root || target.recursive && root.startsWith(`${target.path}/`); }
function audit(manifest) { validate(manifest); for (const root of PUBLIC_ROOTS) if (!manifest.sources.some(source => source.render_targets.some(target => targetCovers(target, root)))) fail(REASON.UNCOVERED_PUBLIC_SURFACE, `superfície pública sem fonte: ${root}`); return { ok: true, source_ids: manifest.sources.map(source => source.source_id).sort() }; }
function load(cwd, file) { const manifest = readManifest(cwd, file); audit(manifest); return JSON.parse(normalize(manifest)); }
function main() { const cwd = process.argv[2] || process.cwd(); process.stdout.write(normalize(audit(readManifest(cwd)))); }
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.code || 'error'}: ${error.message}\n`); process.exitCode = 1; } }
module.exports = { PUBLIC_ROOTS, REASON, isSafeRelative, normalize, validate, audit, load, readManifest };
