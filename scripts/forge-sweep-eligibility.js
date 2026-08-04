'use strict';

// Policy boundary for forge-sweep.  The VCS seam owns subprocess interaction;
// this module only translates one status snapshot into target-level decisions.

const path = require('path');
const vcsSeam = require('./forge-vcs');

// The CLI maps a policy refusal to exit 1 by identity, not by re-spelling this
// operator-facing pt-BR sentence at the call site.
const VCS_QUERY_FAILURE_PREFIX = 'falha ao consultar estado do VCS:';

function isVcsQueryFailure(reason) {
  return typeof reason === 'string' && reason.startsWith(VCS_QUERY_FAILURE_PREFIX);
}

// An ancestor in one of these states makes every descendant unrecoverable,
// whether or not the VCS enumerated the descendant itself.
const CONTAINING_REASONS = new Set(['untracked', 'ignored']);

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

/**
 * Walk from the path up to the cwd looking for a containing untracked or
 * ignored directory.  `git status -uall --ignored` enumerates descendants, so
 * this is redundant there; `svn status` does not, so relying on the per-path
 * record alone would let a path under an unversioned directory read as clean.
 */
function containingRefusal(relPath, statuses) {
  const parts = relPath.split('/');
  for (let depth = parts.length - 1; depth > 0; depth -= 1) {
    const ancestor = parts.slice(0, depth).join('/');
    const kind = statuses.get(ancestor);
    if (kind && CONTAINING_REASONS.has(kind)) return { ancestor, kind };
  }
  return null;
}

/**
 * Exported small seam so path normalisation can be checked independently.
 * A refusal carries two additive fields consumed only by the tool-undo
 * promotion in `createEligibility`: `kind` (the raw VCS state, matching a
 * `REASONS` key) and `via` (`'direct'` when the path itself matched a status
 * entry, `'ancestor'` when a containing directory did). Neither field changes
 * the `reason` string — the CLI's `isVcsQueryFailure` predicate and existing
 * tests key off that string, not off these fields.
 */
function classifyPath(cwd, candidate, statuses) {
  const normalised = toRelativePosix(cwd, candidate);
  if (!normalised.ok) return { eligible: false, reason: normalised.error };
  if (statuses.has(normalised.path)) {
    const kind = statuses.get(normalised.path);
    const reason = REASONS[kind] || 'estado do VCS desconhecido';
    return {
      eligible: false,
      path: normalised.path,
      reason: `${normalised.path} — ${reason}`,
      kind,
      via: 'direct',
    };
  }
  const containing = containingRefusal(normalised.path, statuses);
  if (containing) {
    const reason = REASONS[containing.kind] || 'estado do VCS desconhecido';
    return {
      eligible: false,
      path: normalised.path,
      reason: `${normalised.path} — sob ${containing.ancestor}, ${reason}`,
      kind: containing.kind,
      via: 'ancestor',
    };
  }
  return { eligible: true, path: normalised.path };
}

function targetPaths(target) {
  const paths = [];
  if (target && Array.isArray(target.members)) {
    for (const member of target.members) {
      if (member && member.path) paths.push(member.path);
      if (member && member.wrapperPath) paths.push(member.wrapperPath);
    }
  }
  if (target && target.containerPath) paths.push(target.containerPath);
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
    skipped.push({ path: target && target.containerPath, reason: result.reason });
    return result;
  };
}

function createEligibility(cwd, opts = {}) {
  const detect = typeof opts.detectVcs === 'function' ? opts.detectVcs : vcsSeam.detectVcs;
  const query = typeof opts.workingStatus === 'function' ? opts.workingStatus : vcsSeam.workingStatus;
  const vcs = detect(cwd);
  const forced = vcs === 'none' && opts.force === true;
  const skipped = [];
  // B2 named fundament: absent opts.toolUndo, or any value whose `available`
  // is not the boolean `true`, must never promote a refusal. The strict
  // comparison is the repo's idiom for destructive gates (MEM001) — a
  // serialized `'true'` or truthy `1` stays inert here, same as `force`
  // above and `includeWrapperDirs` elsewhere.
  const toolUndoActive = !!(opts.toolUndo && opts.toolUndo.available === true);

  // A no-VCS working tree has no recovery route.  The strict comparison keeps
  // serialized strings and numeric values from weakening this destructive gate.
  if (vcs === 'none') {
    const filter = (target) => {
      if (forced) return { eligible: true };
      const result = { eligible: false, reason: 'sem VCS — não há como desfazer' };
      skipped.push({ path: target && target.containerPath, reason: result.reason });
      return result;
    };
    return { vcs, forced, filter, skipped };
  }

  // Exactly one seam query produces the entire map; no per-member lookup can
  // spawn another status command or turn a query failure into an empty map.
  const status = query(cwd, { ...opts, vcs });
  if (!status || status.ok !== true) {
    const error = (status && status.error) || 'motivo não informado';
    const filter = rejectedFilter(skipped, `${VCS_QUERY_FAILURE_PREFIX} ${error}`);
    return { vcs, forced: false, filter, skipped };
  }

  const mapped = statusMap(status.entries);
  if (!mapped.ok) {
    const filter = rejectedFilter(skipped, `${VCS_QUERY_FAILURE_PREFIX} ${mapped.error}`);
    return { vcs, forced: false, filter, skipped };
  }
  const statuses = mapped.statuses;
  const filter = (target) => {
    // A dirty tracked file (added/modified/deleted, DS8-2) refuses
    // unconditionally: tool-undo restores pre-apply bytes, but the hazard it
    // would trample is a human edit in progress, which restoring bytes does
    // not address. Only untracked/ignored (direct or ancestor) are
    // promotable — CONTAINING_REASONS already names exactly that set.
    let promotedNote = null;
    for (const itemPath of targetPaths(target)) {
      const result = classifyPath(cwd, itemPath, statuses);
      if (!result.eligible) {
        if (toolUndoActive && result.kind && CONTAINING_REASONS.has(result.kind)) {
          promotedNote = `${result.reason}; elegível por undo de ferramenta`;
          continue;
        }
        skipped.push({ path: itemPath, reason: result.reason });
        return result;
      }
    }
    if (promotedNote) return { eligible: true, basis: 'tool-undo', note: promotedNote };
    if (toolUndoActive) return { eligible: true, basis: 'vcs' };
    return { eligible: true };
  };
  return { vcs, forced: false, filter, skipped };
}

module.exports = {
  createEligibility,
  classifyPath,
  isVcsQueryFailure,
  VCS_QUERY_FAILURE_PREFIX,
};
