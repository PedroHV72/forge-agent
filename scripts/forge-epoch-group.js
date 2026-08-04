'use strict';

// Groups sealed fragment-store epochs in place.  This module is deliberately a
// small filesystem engine: it neither prompts nor examines version-control
// state.  Callers decide whether a returned plan should be applied.

const fs = require('fs');
const path = require('path');

const { epochOfUnit, sealedEpochs, isWrapperDir, listWrapperDirs } = require('./forge-epoch');
const { serializeGroup, parseGroup, isGroupedFile } = require('./forge-grouped-file');
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

// Store-specific date hints are the second link in epochOfUnit's chain, after
// the timestamp encoded in a unit id.  Keeping these descriptors declarative
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
// sibling directories.  The marker id is `dir~filename`; the left side keeps
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

function plan(cwd, opts = {}) {
  const dryRun = opts.dryRun === undefined ? true : Boolean(opts.dryRun);
  const targets = [];
  const skipped = [];

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
      if (store.name === 'memory' && id === 'legacy-orphan') {
        // This block-format compatibility entry is intentionally not a unit
        // payload; grouping it would make forge-projection parse the container.
        skip(skipped, filePath, 'legacy-orphan não é agrupável');
        continue;
      }
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
      const resolved = epochOfUnit({ id, dateHint, path: filePath });
      if (!resolved.epoch) {
        skip(skipped, filePath, 'época indeterminada');
        continue;
      }
      loose.push({ id, path: filePath, epoch: resolved.epoch });
    }

    const epochSet = sealedEpochs(loose.map(member => member.epoch));
    for (const member of loose) {
      if (member.epoch === epochSet.current) {
        skip(skipped, member.path, 'época corrente — não selada');
      }
    }
    for (const epoch of epochSet.sealed) {
      const members = loose.filter(member => member.epoch === epoch)
        .map(member => ({ id: member.id, path: member.path }));
      const containerPath = path.join(dir, `${epoch}.md`);
      if (fs.existsSync(containerPath)) {
        for (const member of members) skip(skipped, member.path, 'container já agrupado');
        continue;
      }
      targets.push({ store: store.name, epoch, containerPath, members });
    }
  }

  for (const store of WRAPPER_TARGETS) {
    const parent = store.parent(cwd);
    // Use the shared enumerator for eligible wrappers; inspect all dirs below
    // to report why rejected wrappers were skipped rather than hiding them.
    const eligible = new Map(listWrapperDirs(parent).map(item => [item.path, item]));
    const units = [];
    for (const entry of entries(parent)) {
      if (!entry.isDirectory()) continue;
      const wrapperPath = path.join(parent, entry.name);
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
      let content;
      try { content = fs.readFileSync(filePath); }
      catch (error) { skip(skipped, wrapperPath, 'falha de leitura'); continue; }
      if (isGroupedFile(filePath, content)) { skip(skipped, wrapperPath, 'já agrupado'); continue; }
      if (content.indexOf(Buffer.from('<!-- forge:', 'ascii')) !== -1) {
        skip(skipped, wrapperPath, 'delimitador no conteúdo'); continue;
      }
      const resolved = epochOfUnit({ id: entry.name, path: filePath });
      if (!resolved.epoch) { skip(skipped, wrapperPath, 'época indeterminada'); continue; }
      units.push({ id: entry.name, path: wrapperPath, filePath, fileName: path.basename(filePath), epoch: resolved.epoch });
    }
    const epochSet = sealedEpochs(units.map(unit => unit.epoch));
    for (const unit of units) {
      if (unit.epoch === epochSet.current) {
        skip(skipped, unit.path, 'época corrente — não selada');
      }
    }
    for (const epoch of epochSet.sealed) {
      const members = units.filter(unit => unit.epoch === epoch).map(unit => ({
        id: wrapperMarkerId(unit.id, unit.fileName), path: unit.filePath,
        wrapperPath: unit.path, wrapperId: unit.id, fileName: unit.fileName,
      }));
      const containerPath = path.join(parent, `${epoch}.md`);
      if (fs.existsSync(containerPath)) {
        for (const member of members) skip(skipped, member.wrapperPath, 'container já agrupado');
      } else if (members.length) {
        targets.push({ store: store.name, epoch, containerPath, members });
      }
    }
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
      try { units.push({ id: member.id, path: member.path, content: fs.readFileSync(member.path) }); }
      catch (error) {
        warn(`cannot read ${member.path}: ${error.message}`);
        skip(skipped, member.path, 'falha de leitura');
        invalid = true;
      }
    }
    if (invalid || units.length !== members.length) continue;
    const serialized = serializeGroup({ epoch: target.epoch, units });
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

function ungroup(cwd, containerPath) {
  const container = path.resolve(containerPath);
  const store = ALL_TARGETS.find(candidate => isDirectChild(candidate.dir ? candidate.dir(cwd) : candidate.parent(cwd), container));
  if (!store) throw new Error('container must be directly inside a fragment store');
  const parsed = parseGroup(fs.readFileSync(container));
  if (parsed.errors.length) throw new Error(`cannot ungroup invalid container: ${parsed.errors[0].reason}`);
  const restored = [];
  if (store.parent) {
    const parent = store.parent(cwd);
    for (const unit of parsed.units) {
      const member = splitWrapperMarkerId(unit.id);
      if (!member) throw new Error(`invalid wrapper member id: ${unit.id}`);
      const wrapper = path.join(parent, member.dirId);
      const destination = path.join(wrapper, member.fileName);
      if (!isDirectChild(parent, wrapper) || !isDirectChild(wrapper, destination)) throw new Error('wrapper member escapes store');
      if (fs.existsSync(wrapper) || fs.existsSync(destination)) throw new Error(`destination already exists: ${destination}`);
      fs.mkdirSync(wrapper);
      fs.writeFileSync(destination, unit.content);
      restored.push(destination);
    }
    fs.unlinkSync(container);
    return { restored };
  }
  for (const unit of parsed.units) {
    if (!safeMemberId(unit.id)) throw new Error(`invalid grouped unit id: ${unit.id}`);
    const destination = path.join(store.dir(cwd), `${unit.id}.md`);
    if (!isDirectChild(store.dir(cwd), destination)) throw new Error('grouped member escapes store');
    fs.writeFileSync(destination, unit.content);
    restored.push(destination);
  }
  fs.unlinkSync(container);
  return { restored };
}

module.exports = { STORE_TARGETS, WRAPPER_TARGETS, plan, apply, ungroup };
