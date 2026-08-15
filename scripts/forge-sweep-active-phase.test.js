'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const activePhase = require('./forge-sweep-active-phase');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-active-phase-'));
const MILESTONE = 'M123';

function state(phase, slice = '—', task = '—') {
  return { milestone: MILESTONE, phase, active_slice: slice, active_task: task };
}

function readWith(map) {
  return (_cwd, id) => map[id];
}

function activeRun(overrides = {}) {
  return Object.assign({ id: MILESTONE, kind: 'milestone', active: true }, overrides);
}

function runWith(runs, states) {
  return activePhase.activeUnits(cwd, {
    listActive: () => runs,
    readState: readWith(states),
  });
}

// Active phase blocks the milestone itself and both local units.
{
  const result = runWith([activeRun()], { [MILESTONE]: state('execute', 'S01', 'T02') });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.runs_examined, 1);
  assert.strictEqual(result.runs_with_state, 1);
  assert.deepStrictEqual(result.degraded, []);
  assert.deepStrictEqual(activePhase.isUnitBlocked(result, { milestoneId: MILESTONE, unitId: MILESTONE }), { blocked: true, reason: 'active-phase' });
  assert.strictEqual(activePhase.isUnitBlocked(result, { milestoneId: MILESTONE, unitId: 'S01' }).blocked, true);
  assert.strictEqual(activePhase.isUnitBlocked(result, { milestoneId: MILESTONE, unitId: 'T02' }).blocked, true);
}

// Idle and empty phases are clean, including when stale unit labels remain.
{
  const idle = runWith([activeRun()], { [MILESTONE]: state('idle', 'S01', 'T02') });
  const empty = runWith([activeRun()], { [MILESTONE]: state('', 'S01', 'T02') });
  assert.strictEqual(idle.ok, true);
  assert.strictEqual(empty.ok, true);
  assert.deepStrictEqual(idle.units, []);
  assert.strictEqual(activePhase.isUnitBlocked(idle, { milestoneId: MILESTONE, unitId: 'S01' }).blocked, false);
}

// The reader receives only active registry entries; an inactive record cannot block.
{
  const result = runWith([], {});
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.runs_examined, 0);
  assert.deepStrictEqual(result.units, []);
}

// A missing or throwing state is a named degradation and refuses universally.
{
  const missing = runWith([activeRun()], {});
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.reason, 'active-phase-unknown');
  assert.deepStrictEqual(missing.degraded, [{ run: MILESTONE, reason: 'state ausente ou inválido' }]);
  assert.deepStrictEqual(activePhase.isUnitBlocked(missing, { milestoneId: 'M999', unitId: 'S99' }), { blocked: true, reason: 'active-phase-unknown' });

  const throwing = runWith([activeRun({ id: 'M124' })], {});
  throwing.degraded = [];
  const failed = activePhase.activeUnits(cwd, {
    listActive: () => [activeRun({ id: 'M124' })],
    readState: () => { throw new Error('corrupted state'); },
  });
  assert.strictEqual(failed.ok, false);
  assert.match(failed.degraded[0].reason, /corrupted state/);
  assert.strictEqual(throwing.ok, false);
}

// A malformed run is also fail-closed, and the census remains complete.
{
  const result = runWith([{}, activeRun({ id: 'M125' })], { M125: state('plan') });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.runs_examined, 2);
  assert.strictEqual(result.runs_with_state, 1);
  assert.deepStrictEqual(result.degraded[0], { run: '(run desconhecida)', reason: 'run sem identidade utilizável' });
  assert.strictEqual(activePhase.isUnitBlocked(result, { milestoneId: MILESTONE, unitId: MILESTONE }).blocked, true);
}

// R2: a standalone /forge-task run has no milestone by construction. Scoping it
// to its own id keeps the census complete, so unrelated units stay eligible
// instead of the whole sweep being refused as active-phase-unknown.
{
  const taskId = 'T-20260814222313-solta';
  const result = activePhase.activeUnits(cwd, {
    listActive: () => [{ id: taskId, kind: 'task', active: true }],
    readState: () => null,
  });
  assert.strictEqual(result.ok, true, 'uma task solta não degrada o censo');
  assert.deepStrictEqual(result.degraded, []);
  assert.strictEqual(activePhase.isUnitBlocked(result, { milestoneId: taskId, unitId: taskId }).blocked, true);
  assert.strictEqual(activePhase.isUnitBlocked(result, { milestoneId: MILESTONE, unitId: 'S01' }).blocked, false);
}

// The task scope still honours its own state file when one exists.
{
  const taskId = 'T-20260814222313-com-state';
  const result = activePhase.activeUnits(cwd, {
    listActive: () => [{ id: taskId, kind: 'task', active: true }],
    readState: () => ({ phase: 'execute', active_slice: 'S07', active_task: 'T02' }),
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.runs_with_state, 1);
  assert.strictEqual(activePhase.isUnitBlocked(result, { milestoneId: taskId, unitId: 'S07' }).blocked, true);
}

// A task run with no usable identity at all is still genuinely unresolvable,
// and a milestone run with an unreadable state still refuses everything.
{
  const anonymous = activePhase.activeUnits(cwd, {
    listActive: () => [{ kind: 'task', active: true }],
    readState: () => null,
  });
  assert.strictEqual(anonymous.ok, false);
  assert.strictEqual(anonymous.reason, 'active-phase-unknown');

  const unreadable = activePhase.activeUnits(cwd, {
    listActive: () => [activeRun({ id: 'M126' })],
    readState: () => { throw new Error('state ilegível sintético'); },
  });
  assert.strictEqual(unreadable.ok, false);
  assert.strictEqual(activePhase.isUnitBlocked(unreadable, { milestoneId: 'M999', unitId: 'S99' }).blocked, true);
}

// Matching is scoped to the pair: the same local id in another milestone is
// not accidentally blocked, while the active milestone id remains a match.
{
  const result = runWith([activeRun()], { [MILESTONE]: state('review', 'S01', 'T02') });
  assert.strictEqual(activePhase.isUnitBlocked(result, { milestoneId: 'M999', unitId: 'S01' }).blocked, false);
  assert.strictEqual(activePhase.isUnitBlocked(result, { milestoneId: MILESTONE, unitId: 'T03' }).blocked, false);
  assert.strictEqual(activePhase.isUnitBlocked(result, { milestoneId: MILESTONE, unitId: 'M123' }).blocked, true);
  assert.strictEqual(activePhase.isUnitBlocked(result, { milestoneId: MILESTONE, unitId: ' S01 ' }).blocked, true);
}

// A registry read that returns a malformed collection is not interpreted as
// an empty registry, and public APIs never leak the reader exception.
{
  const invalid = activePhase.activeUnits(cwd, { listActive: () => null, readState: () => null });
  assert.strictEqual(invalid.ok, false);
  assert.strictEqual(invalid.reason, 'active-phase-unknown: runs inválidas');
  const throws = activePhase.activeUnits(cwd, { listActive: () => { throw new Error('registry unavailable'); } });
  assert.strictEqual(throws.ok, false);
  assert.match(throws.reason, /^active-phase-unknown: runs: registry unavailable$/);
  assert.strictEqual(activePhase.isUnitBlocked(throws, {}).blocked, true);
}

// Guard the source from consulting the forbidden root projection. Control
// positive proves the predicate itself can detect the prohibited spelling.
{
  const source = fs.readFileSync(path.join(__dirname, 'forge-sweep-active-phase.js'), 'utf8');
  const forbidden = text => text.includes('.gsd/STATE.md');
  assert.strictEqual(forbidden(source), false);
  assert.strictEqual(forbidden('sentinel .gsd/STATE.md'), true);
}

assert.strictEqual(activePhase.REFUSAL_REASONS.UNKNOWN, 'active-phase-unknown');
console.log('forge-sweep-active-phase.test.js: ok');
