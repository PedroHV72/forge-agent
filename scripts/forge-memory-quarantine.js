'use strict';

// ── forge-memory-quarantine ───────────────────────────────────────────────────
// Recoverable holding area for memory fragments whose canonical envelope lives
// inside a grouped container (see writeFragment's `grouped-member` refusal in
// forge-memory.js).
//
// Why a sidecar directory and not a loose fragment: writing the loose file is
// exactly the damage the refusal exists to prevent — a loose file shadows the
// grouped member on the next read (loose-wins, forge-memory.js::listFragments).
// So the fact is parked whole, next to the store but outside it:
//
//   .gsd/memory/quarantine/<storageKey>~<ts>.json
//
// The directory is invisible to the store's own readers by construction:
// listFragments filters `isFile() && .md`, and the grouper skips non-`.md`
// entries — so a quarantined fact can never be listed, read or re-grouped by
// accident.  It is also outside the reach of `milestone_cleanup`, which walks
// `.gsd/milestones/**`.
//
// The `~` delimiter is deliberate: `-`, `_` and `.` are all legal *inside* a
// storage key, so any of them would make `<storageKey>~<ts>` ambiguous to parse
// back.  `~` sits outside the `[\w.\-]` class storage keys are built from.
//
// The `fragment` field carries the payload byte-for-byte as it was handed to
// writeFragment, so recovery is mechanical:
//
//   1. node scripts/forge-sweep-project.js --undo <container>
//   2. edit / confirm the loose fragment that reappears
//   3. node -e "…" | node scripts/forge-memory.js --write --cwd .   (field `fragment`)
//   4. re-group when the unit is sealed again

const fs = require('fs');
const path = require('path');

const QUARANTINE_DIRNAME = 'quarantine';

// The store's own directory helper, so a symlinked .gsd/memory cannot make the
// quarantine land somewhere else than the store it belongs to.
function quarantineDir(cwd) {
  const { memoryDir } = require('./forge-memory');
  return path.join(memoryDir(cwd), QUARANTINE_DIRNAME);
}

// Compact UTC stamp: 20260818T2256013Z-shaped, sortable, no separators that
// collide with the `~` delimiter or with path syntax.
function compactStamp(date) {
  return (date || new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// `<storageKey>~<ts>.json`, with a numeric `~2`, `~3`… suffix on collision.
// Two refusals inside the same second must not overwrite each other: the whole
// point of the quarantine is that no fact is lost.
function resolveTargetPath(dir, storageKey, stamp) {
  const base = `${storageKey}~${stamp}`;
  let candidate = path.join(dir, `${base}.json`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}~${n}.json`);
    n += 1;
  }
  return candidate;
}

// ── quarantineFragment ────────────────────────────────────────────────────────
// Parks `fragment` whole. `info` carries the refusal context:
//   { storageKey, unitId, milestoneId, container, reason, remedy }
// Returns { path }.
function quarantineFragment(cwd, fragment, info) {
  if (!fragment || typeof fragment !== 'object') {
    throw new Error('quarantineFragment requires a fragment object');
  }
  const meta = info || {};
  const storageKey = meta.storageKey;
  if (!storageKey || typeof storageKey !== 'string') {
    throw new Error('quarantineFragment requires info.storageKey');
  }

  const dir = quarantineDir(cwd);
  fs.mkdirSync(dir, { recursive: true });

  const refusedAt = new Date();
  const target = resolveTargetPath(dir, storageKey, compactStamp(refusedAt));

  const record = {
    refused_at: refusedAt.toISOString(),
    storage_key: storageKey,
    unit_id: meta.unitId || fragment.unit_id || null,
    milestone_id: meta.milestoneId || null,
    container: meta.container || null,
    reason: meta.reason || null,
    remedy: meta.remedy || null,
    // Exact payload handed to writeFragment — re-injectable verbatim.
    fragment,
  };

  fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { path: target };
}

// ── listQuarantine ────────────────────────────────────────────────────────────
// Reads the quarantine directory for the doctor / operator.  A missing
// directory is the ordinary empty case ([]).  An unreadable or unparseable
// entry is returned as { path, unreadable: true, error } — never dropped
// silently, because a quarantine that hides entries is worse than none.
function listQuarantine(cwd) {
  const dir = quarantineDir(cwd);
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name);
  } catch (_) {
    return [];
  }
  names.sort();

  return names.map(name => {
    const filePath = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { path: filePath, unreadable: false, ...parsed };
    } catch (error) {
      return { path: filePath, unreadable: true, error: error.message };
    }
  });
}

module.exports = {
  QUARANTINE_DIRNAME,
  quarantineDir,
  quarantineFragment,
  listQuarantine,
  _private: { compactStamp, resolveTargetPath },
};
