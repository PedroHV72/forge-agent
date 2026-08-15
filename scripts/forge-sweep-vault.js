#!/usr/bin/env node
'use strict';

// forge-sweep-vault.js -- byte-preserving pre-apply containers for sweep undo.
//
// The journal records this container's path, never the member bytes.  Keeping
// the container in its own directory also stops it from appearing as an input
// fragment in a store that the sweep is evaluating.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { serializeGroup, parseGroup } = require('./forge-grouped-file');
const { nowTimestamp } = require('./forge-ids');

function vaultDir(cwd) {
  return path.join(cwd, '.gsd', 'forge', 'sweep-vault');
}

function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function randomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

// Build the member list before touching the vault directory. A skipped member
// means the caller has no complete undo record, so no partial vault is written.
function writeVault(cwd, options) {
  const opts = options || {};
  const files = Array.isArray(opts.files) ? opts.files : [];
  const members = [];
  for (const file of files) {
    const absolute = path.resolve(file);
    members.push({
      id: toPosix(path.relative(cwd, absolute)),
      path: absolute,
      content: fs.readFileSync(absolute),
    });
  }

  const serialized = serializeGroup({
    label: typeof opts.operation === 'string' ? opts.operation : 'sweep',
    units: members,
  });
  if (serialized.skipped.length) {
    return { ok: false, containerPath: null, members: [], skipped: serialized.skipped };
  }

  const dir = vaultDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${typeof opts.operation === 'string' && opts.operation ? opts.operation : 'sweep'}-${nowTimestamp()}-${randomSuffix()}.md`;
  const containerPath = path.join(dir, name);
  fs.writeFileSync(containerPath, serialized.buffer);
  return { ok: true, containerPath, members: members.map(member => member.id), skipped: serialized.skipped };
}

function parseVault(containerPath) {
  let parsed;
  try {
    parsed = parseGroup(fs.readFileSync(containerPath));
  } catch (error) {
    throw new Error(`cannot read vault container: ${error.message}`);
  }
  if (parsed.errors.length) {
    throw new Error(`invalid vault container: ${parsed.errors[0].reason}`);
  }
  return parsed;
}

// Walks the lexical segments between .gsd and the requested parent, stopping at
// the first one that does not exist.  A symlink boundary anywhere along the way
// is refused outright: it is the only way an intermediate segment can move the
// destination out of .gsd, and it must be caught before mkdir runs.
function existingAncestor(cwd, requested) {
  const lexicalRoot = path.resolve(cwd, '.gsd');
  const relative = path.relative(lexicalRoot, path.dirname(requested));
  const segments = relative === '' ? [] : relative.split(path.sep);
  let current = lexicalRoot;
  for (const segment of segments) {
    const next = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(next);
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: true, path: current };
      return { ok: false, reason: `path-unavailable: ${error.message}` };
    }
    if (stat.isSymbolicLink()) return { ok: false, reason: 'path-escapes-gsd' };
    if (!stat.isDirectory()) return { ok: false, reason: 'path-unavailable: segmento não é diretório' };
    current = next;
  }
  return { ok: true, path: current };
}

// Creates the requested parent and returns its resolved physical path. The
// comparison is deliberately against real paths: string-prefix checks would
// accept a symlink inside .gsd that actually points out of the worktree.
function containedDestination(cwd, rootReal, id) {
  const requested = path.resolve(cwd, id);
  const lexicalRoot = path.resolve(cwd, '.gsd');
  if (!isInside(lexicalRoot, requested) || requested === lexicalRoot) {
    return { ok: false, path: requested, reason: 'path-escapes-gsd' };
  }

  try {
    // Containment must be proven BEFORE any mutation: mkdirSync(recursive)
    // follows a symlinked intermediate segment and would create directories
    // outside .gsd, and a later refusal only stops the final write -- the
    // side effect would already have escaped.
    const ancestor = existingAncestor(cwd, requested);
    if (!ancestor.ok) return { ok: false, path: requested, reason: ancestor.reason };
    if (!isInside(rootReal, fs.realpathSync(ancestor.path))) {
      return { ok: false, path: requested, reason: 'path-escapes-gsd' };
    }
    fs.mkdirSync(path.dirname(requested), { recursive: true });
    const parentReal = fs.realpathSync(path.dirname(requested));
    if (!isInside(rootReal, parentReal)) {
      return { ok: false, path: requested, reason: 'path-escapes-gsd' };
    }
    const destination = path.join(parentReal, path.basename(requested));
    // An existing symlink must be checked too: reading it would otherwise
    // inspect bytes outside .gsd even though its parent was legitimate.
    if (fs.existsSync(destination) && !isInside(rootReal, fs.realpathSync(destination))) {
      return { ok: false, path: requested, reason: 'path-escapes-gsd' };
    }
    return { ok: true, path: destination };
  } catch (error) {
    return { ok: false, path: requested, reason: `path-unavailable: ${error.message}` };
  }
}

// Restore is intentionally non-throwing for individual members. This lets an
// undo report every conflict and leaves a retryable vault when only one member
// was divergent. Only a malformed/unreadable container is structural.
function restoreVault(cwd, containerPath) {
  const parsed = parseVault(containerPath);
  const restored = [];
  const alreadyPresent = [];
  const refused = [];
  const root = path.resolve(cwd, '.gsd');
  fs.mkdirSync(root, { recursive: true });
  const rootReal = fs.realpathSync(root);

  for (const unit of parsed.units) {
    const resolved = containedDestination(cwd, rootReal, unit.id);
    if (!resolved.ok) {
      refused.push({ path: resolved.path, reason: resolved.reason });
      continue;
    }
    try {
      if (fs.existsSync(resolved.path)) {
        if (Buffer.compare(fs.readFileSync(resolved.path), unit.content) === 0) {
          alreadyPresent.push(resolved.path);
        } else {
          refused.push({ path: resolved.path, reason: 'destination-has-different-bytes' });
        }
      } else {
        fs.writeFileSync(resolved.path, unit.content);
        restored.push(resolved.path);
      }
    } catch (error) {
      refused.push({ path: resolved.path, reason: `restore-failed: ${error.message}` });
    }
  }
  return { restored, alreadyPresent, refused };
}

function listVaults(cwd) {
  const dir = vaultDir(cwd);
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.join(dir, entry.name))
      .sort((left, right) => path.basename(left).localeCompare(path.basename(right), 'en'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

module.exports = {
  vaultDir,
  writeVault,
  restoreVault,
  listVaults,
  _private: { toPosix, isInside, parseVault, containedDestination, existingAncestor },
};
