#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  buildReviewEvent,
  buildUnavailableEvent,
  appendEvents,
  familyOf,
} = require('./forge-review-emit.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-emit-'));
const CLI = path.join(__dirname, 'forge-review-emit.js');
const base = { milestone: 'M134', slice: 'S02', ts: '2026-08-05T01:06:45Z' };

// ── The canonical shape is complete, always ─────────────────────────────────
// The defect this emitter closes was field OMISSION, not field corruption:
// 265 hand-written events produced 151 key shapes. Every row must carry the
// full key set so aggregation across a history is possible at all.
const CANONICAL_KEYS = [
  'ts', 'event', 'milestone', 'slice', 'style', 'rounds', 'counts',
  'conceded_fixed', 'engine', 'challenger', 'advocate',
  'intra_family_debate', 'intra_family_withdrawn',
];
const minimal = buildReviewEvent(base);
assert.strictEqual(minimal.errors.length, 0, 'minimal invocation is valid');
assert.deepStrictEqual(Object.keys(minimal.event), CANONICAL_KEYS, 'full key set, fixed order');
assert.deepStrictEqual(minimal.event.counts, { resolved: 0, conceded: 0, open: 0 });

// ── intra_family_debate is derived, not asserted ────────────────────────────
// The M134/S02 case: gpt author, challenger collapsed to claude, advocate
// collapsed to claude. Both debaters in one family, neither in the author's.
const s02 = buildReviewEvent({
  ...base, authorEngine: 'codex', challenger: 'claude', advocate: 'opus',
});
assert.strictEqual(s02.event.intra_family_debate, true, 'gpt author + two claude debaters');

// The S01 case: claude author, gpt challenger, claude advocate. Cross-family
// in the direction that matters — not intra-family.
const s01 = buildReviewEvent({
  ...base, authorEngine: 'claude', challenger: 'codex', advocate: 'fable',
});
assert.strictEqual(s01.event.intra_family_debate, false, 'cross-family challenger');

// A claude author defended by claude and challenged by claude is same-family
// throughout — the author is IN that family, so this is the designed pairing,
// not a collapse.
const allClaude = buildReviewEvent({
  ...base, authorEngine: 'claude', challenger: 'claude', advocate: 'fable',
});
assert.strictEqual(allClaude.event.intra_family_debate, false, 'author inside the family');

// Forward guard for --mode defend: once a gpt advocate exists, a gpt author
// defended by gpt and challenged by gpt must NOT read as intra-family. The
// original bash compared a family to an engine ('gpt' != 'codex' → true) and
// would have inverted exactly here.
const gptDefend = buildReviewEvent({
  ...base, authorEngine: 'codex', challenger: 'codex', advocate: 'gpt-5.6-sol',
});
assert.strictEqual(
  gptDefend.event.intra_family_debate, false,
  'family-vs-family comparison survives a gpt advocate'
);
assert.strictEqual(familyOf('codex'), 'gpt');
assert.strictEqual(familyOf('gpt-5.6-sol'), 'gpt');
assert.strictEqual(familyOf('fable'), 'claude');
assert.strictEqual(familyOf(''), null);

// ── The withdrawn count cannot contradict the flag ──────────────────────────
const clamped = buildReviewEvent({
  ...base, authorEngine: 'claude', challenger: 'codex', advocate: 'fable',
  intraFamilyWithdrawn: 4,
});
assert.strictEqual(clamped.event.intra_family_withdrawn, 0, 'clamped when not intra-family');
const kept = buildReviewEvent({
  ...base, authorEngine: 'codex', challenger: 'claude', advocate: 'opus',
  intraFamilyWithdrawn: 4,
});
assert.strictEqual(kept.event.intra_family_withdrawn, 4, 'kept when intra-family');

// ── Prose in the advocate field is refused ──────────────────────────────────
// Real rows found in production: "not-invoked-orchestrator-verified-by-direct-reading"
// and "claude-main-context". Those describe what the orchestrator did INSTEAD of
// running the advocate. An advocate that did not run is null; it is never a story.
const prose = buildReviewEvent({
  ...base, advocate: 'not-invoked orchestrator verified by direct reading',
});
assert.ok(prose.errors.length > 0, 'prose advocate rejected');
assert.strictEqual(buildReviewEvent({ ...base, advocate: '' }).event.advocate, null);
assert.strictEqual(buildReviewEvent({ ...base, advocate: 'null' }).event.advocate, null);
assert.strictEqual(buildReviewEvent({ ...base, advocate: 'fable' }).event.advocate, 'fable');

// ── Caller mistakes fail loudly ─────────────────────────────────────────────
assert.ok(buildReviewEvent({ slice: 'S02' }).errors.length > 0, 'milestone required');
assert.ok(buildReviewEvent({ milestone: 'M134' }).errors.length > 0, 'slice required');
assert.ok(buildReviewEvent({ ...base, style: 'freeform' }).errors.length > 0, 'style enum');
assert.ok(buildReviewEvent({ ...base, engine: 'inline' }).errors.length > 0, 'engine enum');
assert.ok(buildReviewEvent({ ...base, challenger: 'opus' }).errors.length > 0, 'challenger enum');
assert.ok(buildReviewEvent({ ...base, rounds: 9 }).errors.length > 0, 'rounds clamped range');
assert.ok(buildReviewEvent({ ...base, open: -1 }).errors.length > 0, 'counts non-negative');
assert.ok(
  buildReviewEvent({ ...base, conceded: 2, concededFixed: 5 }).errors.length > 0,
  'cannot fix more than were conceded'
);

// ── Companion unavailable event ─────────────────────────────────────────────
const un = buildUnavailableEvent({ ...base, unavailableReason: 'review-advocate-unavailable', attempts: 2 });
assert.strictEqual(un.errors.length, 0);
assert.strictEqual(un.event.event, 'review-agent-unavailable');
assert.strictEqual(un.event.attempts, 2);
assert.ok(buildUnavailableEvent({ ...base, unavailableReason: 'nope' }).errors.length > 0);

// ── Append is real JSONL a reader can parse back ────────────────────────────
const f = path.join(dir, 'events.jsonl');
appendEvents(f, [minimal.event, s02.event]);
const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.strictEqual(rows.length, 2);
assert.strictEqual(rows[1].intra_family_debate, true);

// ── CLI contract: exit 2 on malformed, 0 on valid, and --dry-run writes nothing
const run = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};
const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-emit-cli-'));
assert.strictEqual(run(['--cwd', cliDir, '--slice', 'S02']).code, 2, 'missing milestone → exit 2');
assert.strictEqual(
  fs.existsSync(path.join(cliDir, '.gsd', 'forge', 'events.jsonl')), false,
  'a refused invocation writes no row'
);
const dry = run(['--cwd', cliDir, '--milestone', 'M134', '--slice', 'S02', '--dry-run', '--json']);
assert.strictEqual(dry.code, 0);
assert.strictEqual(fs.existsSync(path.join(cliDir, '.gsd', 'forge', 'events.jsonl')), false, 'dry-run writes nothing');
const wrote = run([
  '--cwd', cliDir, '--milestone', 'M134', '--slice', 'S02',
  '--author-engine', 'codex', '--challenger', 'claude', '--advocate', 'opus',
  '--conceded', '4', '--conceded-fixed', '4', '--open', '1', '--json',
]);
assert.strictEqual(wrote.code, 0);
const cliRow = JSON.parse(
  fs.readFileSync(path.join(cliDir, '.gsd', 'forge', 'events.jsonl'), 'utf8').trim()
);
assert.deepStrictEqual(Object.keys(cliRow), CANONICAL_KEYS, 'CLI writes the canonical shape');
assert.strictEqual(cliRow.intra_family_debate, true, 'CLI derives the flag too');

// The emitter's rows must satisfy the audit's own reader without special-casing.
const { audit } = require('./forge-review-audit.js');
assert.ok(Array.isArray(audit(path.join(cliDir, '.gsd', 'forge', 'events.jsonl'), cliDir).drifts));

console.log('forge-review-emit tests passed');
