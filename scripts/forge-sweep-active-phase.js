'use strict';

// Single policy boundary for phase-aware sweep operations.  The registry and
// per-milestone state are deliberately kept behind their existing readers.
const forgeRuns = require('./forge-runs');
const forgeState = require('./forge-state');

const REFUSAL_REASONS = Object.freeze({
  UNKNOWN: 'active-phase-unknown',
  BLOCKED: 'active-phase',
});

function census() {
  return { runs_examined: 0, runs_with_state: 0, units: [], degraded: [] };
}

function cleanId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || id === '—' || id === '-' || id.toLowerCase() === 'idle') return null;
  return id;
}

function runMilestone(run) {
  if (!run || typeof run !== 'object') return null;
  return cleanId(run.milestone || run.milestone_id ||
    (run.kind === 'milestone' ? run.id : null));
}

// A standalone /forge-task run never carries a milestone id.  Resolving it to
// null used to degrade the whole census (ok:false), which made every caller
// refuse every unrelated target.  Such a run has a perfectly good scope: its
// own id.  Only a run with no usable identity at all remains unresolvable.
function runScope(run) {
  if (!run || typeof run !== 'object') return null;
  const milestoneId = runMilestone(run);
  if (milestoneId) return { id: milestoneId, kind: 'milestone' };
  if (run.kind === 'task') {
    const taskId = cleanId(run.id);
    if (taskId) return { id: taskId, kind: 'task' };
  }
  return null;
}

function namedUnit(value) {
  return cleanId(value);
}

function hasActivePhase(state) {
  return !!(state && cleanId(state.phase) && cleanId(state.phase).toLowerCase() !== 'idle');
}

function addUnit(units, milestoneId, unitId) {
  if (!unitId) return;
  if (!units.some(item => item.milestoneId === milestoneId && item.unitId === unitId)) {
    units.push({ milestoneId, unitId });
  }
}

function failure(result, reason) {
  result.ok = false;
  result.reason = reason || REFUSAL_REASONS.UNKNOWN;
  return result;
}

/**
 * Build the active-unit census from active registry records and their own
 * state files.  An incomplete observation is unsafe: callers must refuse all
 * targets when ok is false.
 */
function activeUnits(cwd, opts = {}) {
  const result = Object.assign({ ok: true }, census());
  const listActive = typeof opts.listActive === 'function'
    ? opts.listActive : forgeRuns.listActive;
  const readState = typeof opts.readState === 'function'
    ? opts.readState : forgeState.read;

  let runs;
  try {
    runs = listActive(cwd);
  } catch (error) {
    return failure(result, `${REFUSAL_REASONS.UNKNOWN}: runs: ${error.message}`);
  }
  if (!Array.isArray(runs)) return failure(result, `${REFUSAL_REASONS.UNKNOWN}: runs inválidas`);

  result.runs_examined = runs.length;
  for (const run of runs) {
    const label = run && (run.id || run.milestone || run.milestone_id) || '(run desconhecida)';
    const scope = runScope(run);
    if (!scope) {
      result.degraded.push({ run: label, reason: 'run sem identidade utilizável' });
      result.ok = false;
      continue;
    }
    const milestoneId = scope.id;
    if (scope.kind === 'task') {
      // The run is listed as active, so its own unit is occupied regardless of
      // whether it keeps a state file.  A missing state file for a standalone
      // task is normal, not an incomplete observation.
      addUnit(result.units, milestoneId, milestoneId);
      let taskState = null;
      try { taskState = readState(cwd, milestoneId); } catch (error) { taskState = null; }
      if (taskState && typeof taskState === 'object') {
        result.runs_with_state += 1;
        if (hasActivePhase(taskState)) {
          addUnit(result.units, milestoneId, namedUnit(taskState.active_slice));
          addUnit(result.units, milestoneId, namedUnit(taskState.active_task));
        }
      }
      continue;
    }
    let state;
    try {
      state = readState(cwd, milestoneId);
    } catch (error) {
      result.degraded.push({ run: label, reason: `state ilegível: ${error.message}` });
      result.ok = false;
      continue;
    }
    if (!state || typeof state !== 'object') {
      result.degraded.push({ run: label, reason: 'state ausente ou inválido' });
      result.ok = false;
      continue;
    }
    result.runs_with_state += 1;
    if (!hasActivePhase(state)) continue;
    addUnit(result.units, milestoneId, milestoneId);
    addUnit(result.units, milestoneId, namedUnit(state.active_slice));
    addUnit(result.units, milestoneId, namedUnit(state.active_task));
  }
  if (!result.ok) result.reason = REFUSAL_REASONS.UNKNOWN;
  return result;
}

function isUnitBlocked(result, unit = {}) {
  if (!result || result.ok !== true) {
    return { blocked: true, reason: REFUSAL_REASONS.UNKNOWN };
  }
  const unitId = cleanId(unit.unitId);
  const milestoneId = cleanId(unit.milestoneId);
  if (!unitId || !milestoneId) return { blocked: false, reason: null };
  const blocked = Array.isArray(result.units) && result.units.some(item =>
    item.milestoneId === milestoneId && item.unitId === unitId);
  return { blocked, reason: blocked ? REFUSAL_REASONS.BLOCKED : null };
}

module.exports = {
  activeUnits,
  isUnitBlocked,
  REFUSAL_REASONS,
  _private: { cleanId, runMilestone, runScope, hasActivePhase, addUnit, census },
};
