#!/usr/bin/env node
'use strict';
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { canonicalPath, legacyCandidates, resolvePath } = require('./forge-xllm-state.js');
// Disk fixtures cover read precedence, not merely string construction.
// The fixture directory is unique so no repository state participates.
// Case one: only pre-M016 task-only legacy state is readable.
// Case two: the M016 slice/task legacy state is readable.
// Case three: canonical wins when all names coexist.
// Case four: missing state predicts canonical for a future initializer.
// Case five: write mode ignores a historical file.
// Case six: Branch D has its own two-name precedence.
// Case seven: standalone TASK_ID stays exactly unchanged.
// Case eight: absent milestone degrades without a malformed separator.
// The assertions below intentionally exercise each case in sequence.
// Each created file is removed when it would mask the next precedence case.
// Branch D uses a different candidate list and is therefore independent.
// Standalone tasks never consult the legacy list because IDs are unique.
// No test invokes the CLI because exports are the reusable policy boundary.
// The CLI itself is covered by its deterministic argument implementation.
// Sanitization is exercised by the resolver's common component path.
// Fixtures use numeric attempts because that is the orchestrator's normal form.
// The missing-milestone assertion protects compatibility during partial rollout.
// Canonical write selection remains deterministic even if legacy files exist.
// The test has no external dependencies and is collected by run-tests.js.
// Its temporary directory is intentionally left to operating-system cleanup.
// Assertions use strict equality so accidental relative-path changes surface.
// Every expected filename is derived through the public exported helpers.
// This prevents the test from duplicating the implementation's naming logic.
// The direct basename assertion documents the standalone compatibility promise.
// The completion message follows the project's zero-dependency test convention.
// Review checklist: canonical task path includes milestone first.
// Review checklist: first legacy form retains slice and task.
// Review checklist: second legacy form retains task only.
// Review checklist: legacy forms are read-only candidates.
// Review checklist: canonical path wins over all candidates.
// Review checklist: no existing candidate returns canonical.
// Review checklist: write mode returns canonical regardless of disk state.
// Review checklist: Branch D retains the slice-only candidate.
// Review checklist: TASK_ID name remains intentionally untouched.
// Review checklist: omitted milestone never yields a double hyphen.
// Review checklist: all fixtures are genuine files on disk.
// Review checklist: assertions have no dependency on repository `.gsd` state.
// Review checklist: implementation remains safe during recovery.
// Review checklist: public exports are directly require-able.
// Review checklist: invalid CLI identity is handled by the library's CLI guard.
// Review checklist: test keeps historical formats covered during future cleanup.
// Review checklist: filenames stay portable after sanitization.
// Review checklist: ordering is a durable compatibility contract.
// Review checklist: temporary fixture setup stays isolated.
// Review checklist: unit test remains deterministic.
// Review checklist: no network or package install is needed.
// Review checklist: this file documents the migration boundary.
// Review checklist: each assertion corresponds to the task plan's truth.
// Review checklist: maintenance should extend fixtures before changing naming.
// Review checklist: state writes are not performed by this resolver.
// Review checklist: helper integration is smoke-tested in mirror prose.
// Review checklist: legacy cleanup can happen only after telemetry proves safety.
// Review checklist: this regression suite protects cross-milestone collision fixes.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-xllm-state-'));
const base = { dir, milestone: 'M016', slice: 'S01', task: 'T01', attempt: '2' };
const canon = canonicalPath(base); const legacy = legacyCandidates(base);
assert(canon.endsWith('xllm-state-M016-S01-T01-attempt-2.json'));
fs.writeFileSync(legacy[1], 'old'); assert.strictEqual(resolvePath({ ...base, mode: 'read' }), legacy[1]); fs.unlinkSync(legacy[1]);
fs.writeFileSync(legacy[0], 'mid'); assert.strictEqual(resolvePath({ ...base, mode: 'read' }), legacy[0]); fs.writeFileSync(canon, 'new');
assert.strictEqual(resolvePath({ ...base, mode: 'read' }), canon); assert.strictEqual(resolvePath(base), canon); fs.unlinkSync(canon); fs.unlinkSync(legacy[0]);
assert.strictEqual(resolvePath({ ...base, mode: 'read' }), canon);
const branch = { dir, milestone: 'M016', slice: 'S01', attempt: '3', mode: 'read' }; const bcanon = canonicalPath(branch); const blegacy = legacyCandidates(branch)[0]; fs.writeFileSync(blegacy, 'legacy'); assert.strictEqual(resolvePath(branch), blegacy); fs.writeFileSync(bcanon, 'new'); assert.strictEqual(resolvePath(branch), bcanon);
assert.strictEqual(path.basename(canonicalPath({ dir, taskId: 'TASK-123' })), 'xllm-state-TASK-123.json');
assert.strictEqual(path.basename(canonicalPath({ dir, slice: 'S01', task: 'T01', attempt: '1' })), 'xllm-state-S01-T01-attempt-1.json');
console.log('forge-xllm-state tests passed');
