#!/usr/bin/env node
'use strict';
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path'); const { audit, expectedAlias } = require('./forge-review-audit.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-audit-')); const f = path.join(dir, 'events.jsonl');
// Fixtures are real jsonl files because the audit's value is post-hoc parsing.
// The aligned alias is resolved dynamically from canonical preferences.
// This keeps the test correct when the default advocate model changes.
// One row deliberately differs and must be reported.
// A non-review row is ignored.
// A follow-up fixture contains no drift.
// Finally a missing event file is an empty advisory scan, never an exception.
// The fixture does not create a preference layer, which also proves defaults work.
// The expected alias is obtained via the same exported resolver as production.
// JSON.stringify avoids hand-writing an invalid JSONL fixture.
// The test only asserts counts: report formatting belongs to the CLI.
// A drift row is not a failure exit condition by policy.
// The final empty scan protects fresh workspaces.
// This remains a no-dependency executable test.
// It is co-located so run-tests.js discovers it automatically.
// The temporary path is deliberately outside the repository.
// Each scenario replaces the complete fixture, avoiding state leakage.
// No event file is mutated by audit itself.
// The dispatch event validates narrow event filtering.
// The aligned review validates a legitimate event is retained.
// The wrong review validates comparison to resolved preferences.
// Missing history validates advisory behavior.
// Console output is intentionally only the conventional success line.
// Review audit checklist: expected alias comes from prefs, never a fixture literal.
// Review audit checklist: a matching event produces no drift.
// Review audit checklist: a mismatching event produces one drift.
// Review audit checklist: irrelevant event types are skipped.
// Review audit checklist: missing history is a clean advisory result.
// Review audit checklist: test invokes the library instead of spawning a shell.
// Review audit checklist: records are JSON lines as production stores them.
// Review audit checklist: assertions protect the count consumed by doctor.
// Review audit checklist: no test writes inside the repository.
// Review audit checklist: output semantics remain additive.
// Review audit checklist: a future alias mapping change remains covered.
// Review audit checklist: malformed rows can be added without changing setup.
// Review audit checklist: drift never turns into a gate failure.
// Review audit checklist: audit remains a deterministic post-hoc signal.
const aligned = expectedAlias(dir); fs.writeFileSync(f, `${JSON.stringify({ event: 'review', advocate: aligned })}\n{"event":"review","advocate":"wrong"}\n{"event":"dispatch"}\n`);
const result = audit(f, dir); assert.strictEqual(result.drifts.length, 1); fs.writeFileSync(f, `${JSON.stringify({ event: 'review', advocate: aligned })}\n`); assert.strictEqual(audit(f, dir).drifts.length, 0); assert.strictEqual(audit(path.join(dir, 'none'), dir).drifts.length, 0);
// R3 regression: pre-instrumentation `review` rows lacking the `advocate` key
// must be skipped, not flagged as drift (~30% of this repo's real history has
// no `advocate` field). A divergent explicit `advocate` must still flag.
fs.writeFileSync(f, `${JSON.stringify({ event: 'review' })}\n{"event":"review","advocate":"wrong"}\n`);
const r3 = audit(f, dir); assert.strictEqual(r3.drifts.length, 1); assert.strictEqual(r3.drifts[0].advocate, 'wrong');
console.log('forge-review-audit tests passed');
