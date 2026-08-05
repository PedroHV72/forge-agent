'use strict';

// Groups sealed fragment-store units in place. This module is deliberately a
// small filesystem engine: it neither prompts nor examines version-control
// state. Callers decide whether a returned plan should be applied.
//
// The calendar axis is gone (S09). Selection now asks forge-sweep-sealed's
// sealedBy() for a verdict per member — this module owns none of the
// eligibility criteria itself; it only enumerates candidates, applies the
// structural guards that have nothing to do with closure proof (readability,
// already-grouped, id shape, delimiter-in-payload), and obeys the verdict.
// The container name comes from a single sweep number computed once per plan
// (DS9-3) via forge-sweep-sealed's nextSweepNumber/containerName.

const fs = require('fs');
const path = require('path');

const { dateOfUnit, isWrapperDir, listWrapperDirs } = require('./forge-epoch');
const { serializeGroup, parseGroup, isGroupedFile } = require('./forge-grouped-file');
const sealed = require('./forge-sweep-sealed');
const ledger = require('./forge-ledger');
const decisions = require('./forge-decisions');
const memory = require('./forge-memory');

function earliest(values) {
  const valid = values.filter(value => typeof value === 'string' && value.trim());
  return valid.length ? valid.sort()[0] : null;
}

function fileId(fileName) {
  return path.basename(fileName, '.md');
}

// dateOnly renders dateOfUnit's Date (UTC-based no matter which link in its
// chain resolved it — id-timestamp and mtime both come out as instants) as
// the YYYY-MM-DD string T03's serializeGroup expects for a range endpoint. A
// null/invalid Date is not an error here: DS9-5 made "no derivable date" a
// non-disqualifying outcome, so the member simply contributes nothing.
function dateOnly(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// The min/max of every member's derived date, in a single plan target — the
// "faixa" a sweep container carries because the number alone does not situate
// it in time. Members without a date simply do not participate.
function dateRangeOf(members) {
  const dates = (Array.isArray(members) ? members : [])
    .map(member => member && member.date)
    .filter(date => typeof date === 'string' && date);
  if (!dates.length) return undefined;
  dates.sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

// Store-specific date hints are the second link in dateOfUnit's chain, after
// the timestamp encoded in a unit id. Keeping these descriptors declarative
// makes all three stores pass through exactly the same planner.
const STORE_TARGETS = [
  {
    name: 'ledger',
    dir: cwd => ledger.ledgerDir(cwd),
    idOf: fileId,
    dateHintOf: text => ledger.parseFragment(text).completed_at || null,
  },
  {
    name: 'decisions',
    dir: cwd => decisions.decisionsDir(cwd),
    idOf: fileId,
    dateHintOf: text => earliest((decisions.parseFragment(text).decisions || []).map(item => item.when)),
  },
  {
    name: 'memory',
    dir: cwd => memory.memoryDir(cwd),
    idOf: fileId,
    dateHintOf: text => earliest((memory.parseFragment(text).facts || []).map(item => item.created_at)),
  },
];

// Wrapper stores are intentionally separate from fragment stores: their
// parent is the original .gsd directory, so grouping never creates archive or
// sibling directories. The marker id is `dir~filename`; the left side keeps
// the Forge identity while the right side preserves the original filename.
const WRAPPER_TARGETS = [
  { name: 'milestone-wrappers', parent: cwd => path.join(cwd, '.gsd', 'milestones') },
  { name: 'task-wrappers', parent: cwd => path.join(cwd, '.gsd', 'tasks') },
];

const ALL_TARGETS = [...STORE_TARGETS, ...WRAPPER_TARGETS];

function descriptor(name) {
  return ALL_TARGETS.find(store => store.name === name) || null;
}

function isDirectChild(dir, candidate) {
  return path.dirname(path.resolve(candidate)) === path.resolve(dir);
}

function safeMemberId(id) {
  return typeof id === 'string' && id && path.basename(id) === id && !/[\\/]/.test(id);
}

function wrapperMarkerId(dirId, fileName) {
  return `${dirId}~${fileName}`;
}

function splitWrapperMarkerId(value) {
  const index = typeof value === 'string' ? value.indexOf('~') : -1;
  if (index < 1 || index === value.length - 1) return null;
  const dirId = value.slice(0, index);
  const fileName = value.slice(index + 1);
  return safeMemberId(dirId) && safeMemberId(fileName) && fileName.endsWith('.md')
    ? { dirId, fileName } : null;
}

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return []; }
}

function warn(message) {
  process.stderr.write(`[forge-epoch-group] warn: ${message}\n`);
}

function countTree(dir) {
  let files = 0;
  let dirs = 0;
  for (const entry of entries(dir)) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) files += 1;
    else if (entry.isDirectory()) {
      dirs += 1;
      const child = countTree(fullPath);
      files += child.files;
      dirs += child.dirs;
    }
  }
  return { files, dirs };
}

function skip(skipped, itemPath, reason) {
  skipped.push({ path: itemPath, reason });
}

// R16 triage: with the D11 gate closed (the CLI's default — see
// forge-sweep-project.js buildRegistry), wrapper dirs never enter `skipped`
// at all, so a run that protected them left no trace of having done so —
// indistinguishable from a detector that never looked. This does not open
// the gate; it only counts what the gate is currently shielding, for an
// informative line the caller can always print (present even when the
// count is zero — silence reads as broken, not as "nothing to protect").
function countProtectedWrapperDirs(cwd) {
  let count = 0;
  for (const store of WRAPPER_TARGETS) {
    for (const entry of entries(store.parent(cwd))) {
      if (entry.isDirectory()) count += 1;
    }
  }
  return count;
}

function plan(cwd, opts = {}) {
  const dryRun = opts.dryRun === undefined ? true : Boolean(opts.dryRun);
  const includeWrapperDirs = opts.includeWrapperDirs === true;
  const targets = [];
  const skipped = [];

  // The default plan is intentionally limited to the three fragment stores.
  // This preserves the existing planner contract for callers that do not know
  // about wrapper containers yet, while keeping explicit wrapper plans valid.
  // The strict option check above is part of that boundary: serialized values
  // such as "false" and numeric truthy values must remain opt-out values.
  // Keeping this decision at enumeration time also keeps `skipped` quiet for
  // wrappers the caller did not request. `apply()` still accepts an explicit
  // wrapper target because descriptor() resolves both target lists below.
  // `ungroup()` likewise remains able to discover wrapper containers through
  // ALL_TARGETS, preserving the reversible path for deliberate callers.
  // No target shape or return field changes are needed for this gate.
  // Callers can therefore opt in without adapting apply/ungroup payloads.

  // DS9-3: one sweep number for the WHOLE plan, computed over every directory
  // this plan could touch — never per store. Computing it later or per-store
  // would let the same sweep land as -03 in one store and -01 in another,
  // and the S08 journal (one intent line per apply, many containers) would
  // point at numbers that no longer correspond to each other.
  const storeDirs = STORE_TARGETS.map(store => store.dir(cwd));
  const wrapperDirs = includeWrapperDirs ? WRAPPER_TARGETS.map(store => store.parent(cwd)) : [];
  const sweepNumber = sealed.nextSweepNumber([...storeDirs, ...wrapperDirs]);
  const label = sealed.containerName(sweepNumber);
  // Loaded once per plan (not per member) — sealedBy's proof (a) consults it.
  const ctx = { ledgerIds: sealed.loadLedgerIds(cwd) };

  for (const store of STORE_TARGETS) {
    const dir = store.dir(cwd);
    const loose = [];
    for (const entry of entries(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = path.join(dir, entry.name);
      let content;
      try { content = fs.readFileSync(filePath); }
      catch (error) {
        warn(`cannot read ${filePath}: ${error.message}`);
        skip(skipped, filePath, 'falha de leitura');
        continue;
      }
      if (isGroupedFile(entry.name, content)) {
        skip(skipped, filePath, 'já agrupado');
        continue;
      }
      const id = store.idOf(entry.name);
      if (!safeMemberId(id)) {
        skip(skipped, filePath, 'identificador inválido');
        continue;
      }
      if (content.indexOf(Buffer.from('<!-- forge:', 'ascii')) !== -1) {
        skip(skipped, filePath, 'delimitador no conteúdo');
        continue;
      }
      let dateHint = null;
      try { dateHint = store.dateHintOf(content.toString('utf8')); }
      catch (error) {
        warn(`cannot derive date hint for ${filePath}: ${error.message}`);
      }
      // sealedBy is the ENTIRE eligibility criterion (DS9-6: legacy-orphan is
      // its concern now, not an `if (store.name === 'memory')` here). Date is
      // never asked about grouping — only about the range (DS9-5).
      const verdict = sealed.sealedBy({ id }, ctx);
      if (!verdict.groupable) {
        skip(skipped, filePath, verdict.reason);
        continue;
      }
      const derived = dateOfUnit({ id, dateHint, path: filePath });
      // proof (review R1 triage, Guard A) is carried from sealedBy()'s verdict
      // all the way to serializeGroup, so the container itself records which
      // of the three admitting proofs let this member group.
      loose.push({ id, path: filePath, date: dateOnly(derived.date), proof: verdict.proof });
    }

    if (!loose.length) continue;
    const containerPath = path.join(dir, `${label}.md`);
    if (fs.existsSync(containerPath)) {
      for (const member of loose) skip(skipped, member.path, 'container já agrupado');
      continue;
    }
    targets.push({ store: store.name, label, containerPath, members: loose });
  }

  // Wrapper targets delete directories whose readers still expect loose entries.
  // D11 keeps that destructive format transition behind an explicit opt-in.
  if (includeWrapperDirs) for (const store of WRAPPER_TARGETS) {
    const parent = store.parent(cwd);
    // Use the shared enumerator for eligible wrappers; inspect all dirs below
    // to report why rejected wrappers were skipped rather than hiding them.
    const eligible = new Map(listWrapperDirs(parent).map(item => [item.path, item]));
    const units = [];
    for (const entry of entries(parent)) {
      if (!entry.isDirectory()) continue;
      const wrapperPath = path.join(parent, entry.name);
      // `~` separates dirId from fileName in the marker id and split takes the
      // FIRST one, so `foo~bar/PLAN.md` would restore to `foo/bar~PLAN.md` —
      // a silent relocation the ungroup existence guard cannot catch, since
      // the original was already removed. Never group such a wrapper.
      if (/~/.test(entry.name)) {
        skip(skipped, wrapperPath, 'separador reservado no nome do invólucro');
        continue;
      }
      // Keep the runtime structural decision owned by forge-epoch; the map is
      // only the filename projection supplied by listWrapperDirs.
      const wrapper = isWrapperDir(wrapperPath) ? eligible.get(wrapperPath) : null;
      if (!wrapper) {
        const children = entries(wrapperPath);
        const fileCount = children.filter(child => child.isFile()).length;
        const subdir = children.find(child => child.isDirectory());
        if (subdir) skip(skipped, wrapperPath, `contém subpasta ${subdir.name}/`);
        else skip(skipped, wrapperPath, `${fileCount} arquivos`);
        continue;
      }
      const filePath = wrapper.file;
      // splitWrapperMarkerId requires .md, so a non-.md member would only be
      // rejected in apply() — where it sets invalid and discards the ENTIRE
      // target under a misleading reason. Reject it here, alone.
      if (!filePath.endsWith('.md')) {
        skip(skipped, wrapperPath, 'arquivo do invólucro não é .md');
        continue;
      }
      let content;
      try { content = fs.readFileSync(filePath); }
      catch (error) { skip(skipped, wrapperPath, 'falha de leitura'); continue; }
      if (isGroupedFile(filePath, content)) { skip(skipped, wrapperPath, 'já agrupado'); continue; }
      if (content.indexOf(Buffer.from('<!-- forge:', 'ascii')) !== -1) {
        skip(skipped, wrapperPath, 'delimitador no conteúdo'); continue;
      }
      // The wrapper's OWNING id (entry.name — e.g. `M-...` or `T-...`) is what
      // sealedBy judges; DS9-6 says the wrapper branch inherits the same
      // criterion "for free" — no separate wrapper-shaped verdict exists.
      const verdict = sealed.sealedBy({ id: entry.name }, ctx);
      if (!verdict.groupable) { skip(skipped, wrapperPath, verdict.reason); continue; }
      const derived = dateOfUnit({ id: entry.name, path: filePath });
      units.push({
        id: wrapperMarkerId(entry.name, path.basename(filePath)),
        path: filePath,
        wrapperPath,
        fileName: path.basename(filePath),
        date: dateOnly(derived.date),
        proof: verdict.proof,
      });
    }
    if (!units.length) continue;
    const containerPath = path.join(parent, `${label}.md`);
    if (fs.existsSync(containerPath)) {
      for (const unit of units) skip(skipped, unit.wrapperPath, 'container já agrupado');
      continue;
    }
    targets.push({ store: store.name, label, containerPath, members: units });
  }
  return { targets, skipped, dryRun };
}

function apply(cwd, groupingPlan, opts = {}) {
  const input = groupingPlan || { targets: [], skipped: [] };
  const written = [];
  const removed = [];
  const skipped = Array.isArray(input.skipped) ? input.skipped.slice() : [];
  const allDirs = [...STORE_TARGETS.map(store => store.dir(cwd)), ...WRAPPER_TARGETS.map(store => store.parent(cwd))];
  const before = allDirs.reduce((total, dir) => {
    const counts = countTree(dir); total.files += counts.files; total.dirs += counts.dirs; return total;
  }, { files: 0, dirs: 0 });

  for (const target of Array.isArray(input.targets) ? input.targets : []) {
    const store = descriptor(target.store);
    if (!store) {
      skip(skipped, target && target.containerPath, 'store desconhecido');
      continue;
    }
    const dir = store.dir ? store.dir(cwd) : store.parent(cwd);
    if (!isDirectChild(dir, target.containerPath) || path.extname(target.containerPath) !== '.md') {
      skip(skipped, target.containerPath, 'container fora do diretório do store');
      continue;
    }
    if (fs.existsSync(target.containerPath)) {
      skip(skipped, target.containerPath, 'container já existe');
      continue;
    }
    const members = Array.isArray(target.members) ? target.members : [];
    const units = [];
    let invalid = false;
    for (const member of members) {
      const wrapperMember = store.parent ? splitWrapperMarkerId(member.id) : null;
      const validPath = store.parent
        ? wrapperMember && isDirectChild(dir, member.wrapperPath) && isDirectChild(member.wrapperPath, member.path)
        : isDirectChild(dir, member.path);
      if ((!store.parent && !safeMemberId(member.id)) || !validPath || !fs.existsSync(member.path)) {
        skip(skipped, member && member.path, 'membro fora do diretório do store ou ausente');
        invalid = true;
        continue;
      }
      try {
        units.push({
          id: member.id,
          path: member.path,
          content: fs.readFileSync(member.path),
          proof: member.proof,
        });
      }
      catch (error) {
        warn(`cannot read ${member.path}: ${error.message}`);
        skip(skipped, member.path, 'falha de leitura');
        invalid = true;
      }
    }
    if (invalid || units.length !== members.length) continue;
    const serialized = serializeGroup({ label: target.label, dateRange: dateRangeOf(members), units });
    if (serialized.skipped.length) {
      for (const item of serialized.skipped) skip(skipped, item.path, 'membro recusado pelo formato');
      continue;
    }
    try {
      // The container is durable before any source is removed.
      fs.writeFileSync(target.containerPath, serialized.buffer);
      written.push(target.containerPath);
    } catch (error) {
      warn(`cannot write ${target.containerPath}: ${error.message}`);
      skip(skipped, target.containerPath, 'falha de escrita');
      continue;
    }
    if (store.parent) {
      // The durable container is written first. rmdir is non-recursive so a
      // wrapper changed between plan and apply is reported, never erased.
      for (const member of members) {
        try { fs.unlinkSync(member.path); removed.push(member.path); }
        catch (error) { skip(skipped, member.path, 'falha ao remover arquivo do invólucro após escrita'); }
      }
      for (const member of members) {
        try { fs.rmdirSync(member.wrapperPath); removed.push(member.wrapperPath); }
        catch (error) { skip(skipped, member.wrapperPath, 'invólucro não vazio após escrita'); }
      }
      continue;
    }
    for (const member of members) {
      try {
        fs.unlinkSync(member.path);
        removed.push(member.path);
      } catch (error) {
        warn(`container written but cannot remove ${member.path}: ${error.message}`);
        skip(skipped, member.path, 'falha ao remover membro após escrita');
      }
    }
  }

  const after = allDirs.reduce((total, dir) => {
    const counts = countTree(dir); total.files += counts.files; total.dirs += counts.dirs; return total;
  }, { files: 0, dirs: 0 });
  return { written, removed, skipped, counts: {
    filesBefore: before.files, filesAfter: after.files,
    dirsBefore: before.dirs, dirsAfter: after.dirs,
  } };
}

// Restores a single member idempotently: absent -> write; present with
// byte-identical content -> record as already-present without rewriting (a
// second ungroup() after a partial failure completes cleanly); present with
// different bytes -> throw, preserving the loose-wins-over-grouped invariant
// (S03 R3). Shared by both branches so the comparison is never duplicated.
function restoreUnit(destination, content, restored, alreadyPresent) {
  if (fs.existsSync(destination)) {
    if (Buffer.compare(fs.readFileSync(destination), content) === 0) {
      alreadyPresent.push(destination);
      return;
    }
    throw new Error(`destination already exists with different content: ${destination}`);
  }
  fs.writeFileSync(destination, content);
  restored.push(destination);
}

function ungroup(cwd, containerPath) {
  const container = path.resolve(containerPath);
  const store = ALL_TARGETS.find(candidate => isDirectChild(candidate.dir ? candidate.dir(cwd) : candidate.parent(cwd), container));
  if (!store) throw new Error('container must be directly inside a fragment store');
  const parsed = parseGroup(fs.readFileSync(container));
  if (parsed.errors.length) throw new Error(`cannot ungroup invalid container: ${parsed.errors[0].reason}`);
  const restored = [];
  const alreadyPresent = [];
  if (store.parent) {
    const parent = store.parent(cwd);
    for (const unit of parsed.units) {
      const member = splitWrapperMarkerId(unit.id);
      if (!member) throw new Error(`invalid wrapper member id: ${unit.id}`);
      const wrapper = path.join(parent, member.dirId);
      const destination = path.join(wrapper, member.fileName);
      if (!isDirectChild(parent, wrapper) || !isDirectChild(wrapper, destination)) throw new Error('wrapper member escapes store');
      if (fs.existsSync(wrapper)) {
        if (!fs.statSync(wrapper).isDirectory()) throw new Error(`wrapper path exists and is not a directory: ${wrapper}`);
      } else {
        fs.mkdirSync(wrapper);
      }
      restoreUnit(destination, unit.content, restored, alreadyPresent);
    }
    fs.unlinkSync(container);
    return { restored, alreadyPresent };
  }
  for (const unit of parsed.units) {
    if (!safeMemberId(unit.id)) throw new Error(`invalid grouped unit id: ${unit.id}`);
    const destination = path.join(store.dir(cwd), `${unit.id}.md`);
    if (!isDirectChild(store.dir(cwd), destination)) throw new Error('grouped member escapes store');
    // Mirrors the wrapper branch. By the loose-wins invariant a divergent file
    // already there is the canonical one, so restoring must never overwrite
    // it — only a byte-identical match is swallowed as already restored.
    restoreUnit(destination, unit.content, restored, alreadyPresent);
  }
  fs.unlinkSync(container);
  return { restored, alreadyPresent };
}

module.exports = { STORE_TARGETS, WRAPPER_TARGETS, plan, apply, ungroup, isDirectChild, safeMemberId, countProtectedWrapperDirs };
