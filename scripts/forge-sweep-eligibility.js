'use strict';

// Policy boundary for forge-sweep.  The VCS seam owns subprocess interaction;
// this module only translates one status snapshot into target-level decisions.

const path = require('path');
const vcsSeam = require('./forge-vcs');

const REASONS = {
  untracked: 'não versionado',
  ignored: 'ignorado pelo VCS',
  added: 'adicionado e não commitado',
  modified: 'modificado localmente',
  deleted: 'removido localmente',
};

function toRelativePosix(cwd, candidate) {
  if (typeof candidate !== 'string' || !candidate) return { ok: false, error: 'caminho ausente' };
  const rel = path.relative(cwd, candidate);
  // `relative` can be empty only for the cwd itself, which is still inside.
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { ok: false, error: 'caminho fora do cwd' };
  }
  return { ok: true, path: rel.split(path.sep).join('/') };
}

/** Exported small seam so path normalisation can be checked independently. */
function classifyPath(cwd, candidate, statuses) {
  const normalised = toRelativePosix(cwd, candidate);
  if (!normalised.ok) return { eligible: false, reason: normalised.error };
  if (!statuses.has(normalised.path)) return { eligible: true, path: normalised.path };
  const kind = statuses.get(normalised.path);
  const reason = REASONS[kind] || 'estado do VCS desconhecido';
  return { eligible: false, path: normalised.path, reason: `${normalised.path} — ${reason}` };
}

function targetPaths(target) {
  const paths = [];
  if (target && Array.isArray(target.members)) {
    for (const member of target.members) {
      if (member && member.path) paths[paths.length] = member.path;
      if (member && member.wrapperPath) paths[paths.length] = member.wrapperPath;
    }
  }
  if (target && target.containerPath) paths[paths.length] = target.containerPath;
  return paths;
}

function statusMap(entries) {
  const statuses = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.path !== 'string' || !REASONS[entry.kind]) {
      // An incomplete seam response is unsafe to interpret as an absent path.
      // Preserve the distinction from a genuinely clean, absent status record.
      return { ok: false, error: 'entrada de status do VCS inválida' };
    }
    // VCS paths are already relative POSIX. Reject an unexpected absolute or
    // traversing path rather than letting it fail to match a target by chance.
    if (entry.path.startsWith('/') || entry.path === '..' || entry.path.startsWith('../')) {
      return { ok: false, error: 'entrada de status fora do cwd' };
    }
    statuses.set(entry.path, entry.kind);
  }
  return { ok: true, statuses };
}

function rejectedFilter(skipped, error) {
  return (target) => {
    const result = { eligible: false, reason: error };
    skipped[skipped.length] = { path: target && target.containerPath, reason: result.reason };
    return result;
  };
}

function createEligibility(cwd, opts = {}) {
  const detect = typeof opts.detectVcs === 'function' ? opts.detectVcs : vcsSeam.detectVcs;
  const query = typeof opts.workingStatus === 'function' ? opts.workingStatus : vcsSeam.workingStatus;
  const vcs = detect(cwd);
  const forced = vcs === 'none' && opts.force === true;
  const skipped = [];

  // A no-VCS working tree has no recovery route.  The strict comparison keeps
  // serialized strings and numeric values from weakening this destructive gate.
  if (vcs === 'none') {
    const filter = (target) => {
      if (forced) return { eligible: true };
      const result = { eligible: false, reason: 'sem VCS — não há como desfazer' };
      skipped[skipped.length] = { path: target && target.containerPath, reason: result.reason };
      return result;
    };
    return { vcs, forced, filter, skipped };
  }

  // Exactly one seam query produces the entire map; no per-member lookup can
  // spawn another status command or turn a query failure into an empty map.
  const status = query(cwd, { ...opts, vcs });
  if (!status || status.ok !== true) {
    const error = (status && status.error) || 'falha ao consultar estado do VCS';
    const filter = rejectedFilter(skipped, `falha ao consultar estado do VCS: ${error}`);
    return { vcs, forced: false, filter, skipped };
  }

  const mapped = statusMap(status.entries);
  if (!mapped.ok) {
    const filter = rejectedFilter(skipped, `falha ao consultar estado do VCS: ${mapped.error}`);
    return { vcs, forced: false, filter, skipped };
  }
  const statuses = mapped.statuses;
  const filter = (target) => {
    for (const itemPath of targetPaths(target)) {
      const result = classifyPath(cwd, itemPath, statuses);
      if (!result.eligible) {
        skipped[skipped.length] = { path: itemPath, reason: result.reason };
        return result;
      }
    }
    return { eligible: true };
  };
  return { vcs, forced: false, filter, skipped };
}

module.exports = {
  createEligibility,
  classifyPath,
};
