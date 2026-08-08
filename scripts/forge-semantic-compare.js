#!/usr/bin/env node
'use strict';

// Compare provider-neutral observations without comparing host presentation.
// The allowlist is deliberately small: unknown fields remain semantic data and
// therefore cause a mismatch instead of being silently discarded.
const fs = require('fs');

const ALLOWED_METADATA_KEYS = Object.freeze([
  'adapter_runtime', 'host_runtime', 'runtime', 'runtime_adapter',
  'previous_host_runtime', 'next_host_runtime',
  'session', 'session_id', 'worker_engine',
  'owner', 'owner_digest', 'lease_generation',
  'heartbeat', 'expires_at', 'last_updated',
  'created_at', 'updated_at', 'committed_at', 'ts',
]);

function own(value, key) { return Object.prototype.hasOwnProperty.call(value || {}, key); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function metadataSet(options) {
  if (options && Array.isArray(options.allowedMetadataKeys)) return new Set(options.allowedMetadataKeys);
  return new Set(ALLOWED_METADATA_KEYS);
}

function normalize(value, options) {
  const allowed = metadataSet(options);
  const ignoreMetadata = !options || options.ignoreMetadata !== false;
  function visit(input) {
    if (Array.isArray(input)) return input.map(visit);
    if (!object(input)) return input;
    const output = {};
    for (const key of Object.keys(input).sort()) {
      if (ignoreMetadata && allowed.has(key)) continue;
      output[key] = visit(input[key]);
    }
    return output;
  }
  return visit(value);
}

function equalValue(left, right) {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => equalValue(item, right[index]));
  }
  if (object(left) || object(right)) {
    if (!object(left) || !object(right)) return false;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => own(left, key) && own(right, key) && equalValue(left[key], right[key]));
  }
  return false;
}

function diff(left, right, at) {
  const path = at || '$';
  if (equalValue(left, right)) return [];
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return [{ path, kind: 'type', left, right }];
    const result = [];
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index++) {
      const child = `${path}[${index}]`;
      if (index >= left.length) result.push({ path: child, kind: 'missing-left', right: right[index] });
      else if (index >= right.length) result.push({ path: child, kind: 'missing-right', left: left[index] });
      else result.push(...diff(left[index], right[index], child));
    }
    return result;
  }
  if (object(left) || object(right)) {
    if (!object(left) || !object(right)) return [{ path, kind: 'type', left, right }];
    const result = [];
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const child = `${path}.${key}`;
      if (!own(left, key)) result.push({ path: child, kind: 'missing-left', right: right[key] });
      else if (!own(right, key)) result.push({ path: child, kind: 'missing-right', left: left[key] });
      else result.push(...diff(left[key], right[key], child));
    }
    return result;
  }
  return [{ path, kind: 'value', left, right }];
}

function compare(left, right, options) {
  const normalizedLeft = normalize(left, options);
  const normalizedRight = normalize(right, options);
  const differences = diff(normalizedLeft, normalizedRight);
  return {
    equal: differences.length === 0,
    differences,
    left: normalizedLeft,
    right: normalizedRight,
  };
}

function assertEquivalent(left, right, options) {
  const result = compare(left, right, options);
  if (!result.equal) {
    const error = new Error(`semantic mismatch at ${result.differences[0].path}`);
    error.code = 'semantic-mismatch';
    error.differences = result.differences;
    error.left = result.left;
    error.right = result.right;
    throw error;
  }
  return result;
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--left') out.left = argv[++index];
    else if (arg === '--right') out.right = argv[++index];
    else if (arg === '--no-metadata') out.noMetadata = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else { const error = new Error(`opção desconhecida: ${arg}`); error.code = 'invalid-request'; throw error; }
  }
  return out;
}

function readInput(value) {
  if (value === undefined) { const error = new Error('--left/--right são obrigatórios'); error.code = 'invalid-request'; throw error; }
  try { return JSON.parse(value); } catch (_) { return JSON.parse(fs.readFileSync(value, 'utf8')); }
}

function main(argv = process.argv.slice(2), output = process.stdout.write.bind(process.stdout), errorOutput = process.stderr.write.bind(process.stderr)) {
  try {
    const args = parseArgs(argv);
    if (args.help) { output('Usage: forge-semantic-compare.js --left JSON|FILE --right JSON|FILE [--no-metadata] [--json]\n'); return 0; }
    const result = compare(readInput(args.left), readInput(args.right), { ignoreMetadata: !args.noMetadata });
    output(`${JSON.stringify(result)}\n`);
    return result.equal ? 0 : 1;
  } catch (error) {
    errorOutput(`forge-semantic-compare: ${error.code || 'failed'}: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { ALLOWED_METADATA_KEYS, normalize, diff, compare, assertEquivalent, parseArgs, readInput, main };
