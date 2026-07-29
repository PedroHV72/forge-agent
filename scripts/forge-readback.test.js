#!/usr/bin/env node
// forge-readback.test.js — deterministic read-back guard for S03 (item consumption:
// /forge-task <item-id> intake + /forge-new-milestone open-items intake).
//
// Two halves:
//   1. Text invariants — fs.readFileSync assertions on the three edited files, proving
//      the § Item read-back spec, its consumers (forge-task, forge-new-milestone) and
//      the resolution/promotion/failure-posture rules landed and stayed consistent.
//   2. Live CLI round-trips — forge-items.js --resolve/--set-status/--promote/--list
//      exercised in a temp dir (never the live .gsd/), proving the resolver, status
//      transition, promotion and open-items filter the skills rely on actually behave.
//
// This is the in-place verification path for RISK blocker 3 (see S02-PLAN.md § Notes,
// reaffirmed in S03-PLAN.md § Notes): repo edits under shared/ and skills/ are inert
// until `./install.sh` re-installs them to ~/.claude/ — this test proves the
// source-of-truth text and CLI mechanics without requiring that reinstall.
//
// Run: node scripts/forge-readback.test.js  (exits 0 = all pass, 1 = any fail)
// Auto-discovered by run-tests.js via the *.test.js glob in scripts/ — same
// mechanism as forge-items.test.js / forge-capture.test.js, zero registration code.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const items = require('./forge-items.js');
const ITEMS_CLI = path.join(__dirname, 'forge-items.js');
const REPO_ROOT = path.resolve(__dirname, '..');

// ── Harness ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-readback-test-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, opts) {
  opts = opts || {};
  return spawnSync(process.execPath, [ITEMS_CLI, ...args], { cwd: opts.cwd, encoding: 'utf8' });
}

function addViaCli(dir, payload) {
  return spawnSync(process.execPath, [ITEMS_CLI, '--add', '--cwd', dir], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

function read(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

console.log('\n=== forge-readback.test.js — S03 read-back guard ===\n');

// ── 1. Text invariants ───────────────────────────────────────────────────────
console.log('1. Text invariants — three edited files');

const readbackSpec = read('shared/forge-items-readback.md');
const forgeTaskSkill = read('skills/forge-task/SKILL.md');
const forgeNewMilestoneSkill = read('skills/forge-new-milestone/SKILL.md');

// (a) shared/forge-items-readback.md — resolution rule, loud-stop-on-ambiguous,
// ## Item de origem block shape, doing transition, --promote rule, done/dropped
// refusal, inbox/triaged open-items filter.
test('(a) forge-items-readback.md contains the resolution rule (--resolve invocation)', () => {
  assert(readbackSpec.includes('--resolve'), 'missing --resolve invocation');
  assert(readbackSpec.includes('forge-items.js'), 'missing forge-items.js reference');
});

test('(a) forge-items-readback.md contains the loud-stop-on-ambiguous rule', () => {
  assert(readbackSpec.includes('LOUD STOP'), 'missing "LOUD STOP" label');
  assert(/never guess/i.test(readbackSpec), 'missing "never guess" anti-rule phrasing');
});

test('(a) forge-items-readback.md contains the exact "## Item de origem" block shape', () => {
  assert(readbackSpec.includes('## Item de origem'), 'missing "## Item de origem" heading');
  for (const label of ['**ID:**', '**Origem:**', '**Arquivo:**', '**SHA:**', '**Milestone:**', '**Status:**']) {
    assert(readbackSpec.includes(label), `missing provenance field label "${label}"`);
  }
});

test('(a) forge-items-readback.md contains the doing transition', () => {
  assert(readbackSpec.includes('--set-status'), 'missing --set-status invocation');
  assert(readbackSpec.includes('doing'), 'missing "doing" status reference');
});

test('(a) forge-items-readback.md contains the --promote rule', () => {
  assert(readbackSpec.includes('--promote'), 'missing --promote invocation');
});

test('(a) forge-items-readback.md contains the done/dropped refusal with exact operator hint', () => {
  assert(readbackSpec.includes('está {status} — reabra com:'), 'missing exact refusal hint template');
  assert(readbackSpec.includes('--set-status {id} triaged'), 'missing exact reopen command in refusal hint');
});

test('(a) forge-items-readback.md contains the inbox/triaged open-items filter', () => {
  assert(readbackSpec.includes('inbox'), 'missing "inbox" status reference');
  assert(readbackSpec.includes('triaged'), 'missing "triaged" status reference');
  assert(readbackSpec.includes('--list --json'), 'missing --list --json invocation');
});

// (b) skills/forge-task/SKILL.md — detects item reference in Parse arguments,
// references forge-items-readback.md, invokes --set-status doing and --promote
// with $TASK_ID, writes item: into the BRIEF.
test('(b) forge-task/SKILL.md detects an item reference in Parse arguments', () => {
  const parseSection = forgeTaskSkill.split('## Parse arguments')[1] || '';
  const upToNextHeading = parseSection.split(/\n## /)[0];
  assert(/\^I-\\d\{1,14\}/.test(upToNextHeading), 'Parse arguments must contain the widened item-ID shape regex (\\d{1,14})');
  assert(upToNextHeading.includes('ITEM_REF'), 'Parse arguments must set ITEM_REF');
});

// R1 (review fix) — the prefix guard must be widened to \d{1,14} in BOTH the
// consumer (forge-task/SKILL.md) and the canonical spec (forge-items-readback.md)
// so a genuinely unique short prefix (e.g. "I-2026072912") is always routed to
// --resolve instead of silently degrading into a free-text task.
test('(R1) forge-task/SKILL.md pins the widened \\d{1,14} prefix guard', () => {
  assert(/\^I-\\d\{1,14\}\(-\[a-z0-9-\]\*\)\?\$/.test(forgeTaskSkill), 'forge-task/SKILL.md must contain the exact widened regex ^I-\\d{1,14}(-[a-z0-9-]*)?$');
});

test('(R1) forge-items-readback.md pins the widened \\d{1,14} prefix guard', () => {
  assert(/\^I-\\d\{1,14\}\(-\[a-z0-9-\]\*\)\?\$/.test(readbackSpec), 'forge-items-readback.md must contain the exact widened regex ^I-\\d{1,14}(-[a-z0-9-]*)?$');
});

test('(b) forge-task/SKILL.md references forge-items-readback.md', () => {
  assert(forgeTaskSkill.includes('forge-items-readback.md'), 'missing reference to shared/forge-items-readback.md');
});

test('(b) forge-task/SKILL.md invokes --set-status doing and --promote with $TASK_ID', () => {
  assert(/--set-status\s+"?\$ITEM_ID"?\s+doing/.test(forgeTaskSkill), 'missing --set-status "$ITEM_ID" doing invocation');
  assert(/--promote\s+"?\$ITEM_ID"?\s+"?\$TASK_ID"?/.test(forgeTaskSkill), 'missing --promote "$ITEM_ID" "$TASK_ID" invocation');
});

test('(b) forge-task/SKILL.md writes item: into the BRIEF', () => {
  const briefSection = forgeTaskSkill.split('\n## Initialize task')[1] || '';
  const upToNextHeading = briefSection.split(/\n## /)[0];
  assert(/item:\s*\{ITEM_ID\}/.test(upToNextHeading), 'BRIEF frontmatter template missing "item: {ITEM_ID}" key');
});

// (c) skills/forge-new-milestone/SKILL.md — open-items step positioned BETWEEN
// Step 1 and Step 2 (assert by index of step headings), references the shared
// spec, invokes --promote with $MILESTONE_ID.
test('(c) forge-new-milestone/SKILL.md has the open-items step positioned between Step 1 and Step 2 (by heading index)', () => {
  const step1Idx = forgeNewMilestoneSkill.indexOf('## Step 1 —');
  const openItemsIdx = forgeNewMilestoneSkill.indexOf('## Step 1.5 —');
  const step2Idx = forgeNewMilestoneSkill.indexOf('## Step 2 —');
  assert(step1Idx !== -1, 'missing "## Step 1 —" heading');
  assert(openItemsIdx !== -1, 'missing open-items step heading (expected "## Step 1.5 —")');
  assert(step2Idx !== -1, 'missing "## Step 2 —" heading');
  assert(step1Idx < openItemsIdx, 'open-items step must come after Step 1 (position, not line number)');
  assert(openItemsIdx < step2Idx, 'open-items step must come before Step 2 (position, not line number)');
});

test('(c) forge-new-milestone/SKILL.md references the shared read-back spec', () => {
  assert(forgeNewMilestoneSkill.includes('forge-items-readback.md'), 'missing reference to shared/forge-items-readback.md');
});

test('(c) forge-new-milestone/SKILL.md invokes --promote with $MILESTONE_ID', () => {
  assert(/--promote\s+"?\$id"?\s+"?\$MILESTONE_ID"?/.test(forgeNewMilestoneSkill), 'missing --promote "$id" "$MILESTONE_ID" invocation');
});

// R2 (review fix) — selected items must be transitioned to `doing` after
// promotion, per shared/forge-items-readback.md § Transição para doing.
test('(R2) forge-new-milestone/SKILL.md transitions picked items to doing after promotion', () => {
  assert(/--set-status\s+"?\$id"?\s+doing/.test(forgeNewMilestoneSkill), 'missing --set-status "$id" doing invocation in the promotion loop');
});

// R3 (review fix) — the promotion loop's iterated variable ($PICKED_IDS) must
// be visibly assigned in the same block as SELECTED_ITEMS, otherwise the loop
// is inert (precedent: the ISOLATION_MODE orphan-variable incident).
test('(R3) forge-new-milestone/SKILL.md assigns PICKED_IDS in the same block it is derived and consumed', () => {
  const step15 = forgeNewMilestoneSkill.split('## Step 1.5 —')[1] || '';
  const upToNextHeading = step15.split(/\n## /)[0];
  assert(/PICKED_IDS=/.test(upToNextHeading), 'PICKED_IDS must be assigned (PICKED_IDS=...) within the Step 1.5 block');
  const assignIdx = upToNextHeading.indexOf('PICKED_IDS=');
  const loopIdx = upToNextHeading.indexOf('for id in $PICKED_IDS');
  assert(loopIdx !== -1, 'promotion loop iterating $PICKED_IDS must be present in Step 1.5');
  assert(assignIdx !== -1 && assignIdx < loopIdx, 'PICKED_IDS assignment must appear before the loop that consumes it');
});

// (d) both consumers reference the canonical spec rather than restating the
// resolution procedure inline.
test('(d) forge-task/SKILL.md does not restate the resolver/provenance/failure-posture procedure inline', () => {
  assert(forgeTaskSkill.includes('does not restate the resolver contract') ||
    forgeTaskSkill.includes('never restates the resolver contract'),
    'forge-task/SKILL.md must declare it defers to the canonical spec rather than restating it');
});

test('(d) forge-new-milestone/SKILL.md does not restate the listing/promotion procedure inline', () => {
  assert(/este step só referencia, não restate|references this file/i.test(forgeNewMilestoneSkill),
    'forge-new-milestone/SKILL.md must declare it defers to the canonical spec rather than restating it');
});

// ── 2. Live CLI round-trips ──────────────────────────────────────────────────
console.log('\n2. Live CLI round-trips (temp dirs only)');

test('unique prefix resolves to the full ID', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Unique prefix item', origin: 'human' });
    const resolve = runCli(['--resolve', created.id.slice(0, 20), '--cwd', dir]);
    assertEq(resolve.status, 0, `--resolve should exit 0: ${resolve.stderr}`);
    assertEq(resolve.stdout.trim(), created.id, 'resolved ID must match');
  });
});

test('an ambiguous prefix exits 1 and names both candidates on stderr', () => {
  withTmpDir(dir => {
    const dirItems = items.itemsDir(dir);
    fs.mkdirSync(dirItems, { recursive: true });
    // Strict-prefix collision: exact-match short-circuit means a full ID never
    // reports ambiguity (S01 Forward Intelligence) — the needle must be a
    // strict prefix of both candidates.
    const idA = 'I-20260729120000-alphaone';
    const idB = 'I-20260729120000-alphatwo';
    for (const id of [idA, idB]) {
      fs.writeFileSync(path.join(dirItems, `${id}.md`), items.serializeItem({
        id, title: id, status: 'inbox', origin: 'human',
        created: new Date().toISOString(), updated: new Date().toISOString(),
      }));
    }
    const resolve = runCli(['--resolve', 'I-20260729120000-alpha', '--cwd', dir]);
    assert(resolve.status !== 0, `expected non-zero exit, got ${resolve.status}`);
    assert(resolve.stderr.includes(idA), `stderr must name ${idA}: ${resolve.stderr}`);
    assert(resolve.stderr.includes(idB), `stderr must name ${idB}: ${resolve.stderr}`);
  });
});

test('an unknown prefix exits 1', () => {
  withTmpDir(dir => {
    fs.mkdirSync(items.itemsDir(dir), { recursive: true });
    const resolve = runCli(['--resolve', 'I-99999999999999', '--cwd', dir]);
    assert(resolve.status !== 0, `expected non-zero exit, got ${resolve.status}`);
  });
});

test('--set-status <id> doing then --read shows status: doing', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Doing transition', origin: 'human' });
    const setStatus = runCli(['--set-status', created.id, 'doing', '--cwd', dir]);
    assertEq(setStatus.status, 0, `--set-status should exit 0: ${setStatus.stderr}`);
    const readResult = runCli(['--read', created.id, '--cwd', dir]);
    assertEq(readResult.status, 0, `--read should exit 0: ${readResult.stderr}`);
    const parsed = JSON.parse(readResult.stdout);
    assertEq(parsed.status, 'doing', 'status must be "doing" after --set-status');
  });
});

test('--promote <id> T-<ts>-<slug> writes promoted_to', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Promote to task', origin: 'human' });
    const promote = runCli(['--promote', created.id, 'T-20260729120000-task', '--cwd', dir]);
    assertEq(promote.status, 0, `--promote should exit 0: ${promote.stderr}`);
    const fragment = fs.readFileSync(created.path, 'utf8');
    assert(fragment.includes('promoted_to: T-20260729120000-task'), `fragment should contain promoted_to:\n${fragment}`);
  });
});

test('--promote <id> M-<ts>-<slug> writes promoted_to', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Promote to milestone', origin: 'human' });
    const promote = runCli(['--promote', created.id, 'M-20260729120000-milestone', '--cwd', dir]);
    assertEq(promote.status, 0, `--promote should exit 0: ${promote.stderr}`);
    const fragment = fs.readFileSync(created.path, 'utf8');
    assert(fragment.includes('promoted_to: M-20260729120000-milestone'), `fragment should contain promoted_to:\n${fragment}`);
  });
});

test('--promote <id> lixo exits 1', () => {
  withTmpDir(dir => {
    const created = items.addItem(dir, { title: 'Bad promotion target', origin: 'human' });
    const promote = runCli(['--promote', created.id, 'lixo', '--cwd', dir]);
    assertEq(promote.status, 1);
  });
});

test('--list --json with items across all five statuses yields exactly the inbox+triaged subset', () => {
  withTmpDir(dir => {
    const dirItems = items.itemsDir(dir);
    fs.mkdirSync(dirItems, { recursive: true });
    const statuses = items.STATUSES; // inbox, triaged, doing, done, dropped (store's own order)
    assert(Array.isArray(statuses) && statuses.length === 5, `expected 5 statuses, got ${JSON.stringify(statuses)}`);
    const ids = {};
    statuses.forEach((status, i) => {
      const id = `I-2026072912${String(1000 + i).padStart(4, '0')}-${status}`;
      ids[status] = id;
      fs.writeFileSync(path.join(dirItems, `${id}.md`), items.serializeItem({
        id, title: `Item ${status}`, status, origin: 'human',
        created: new Date().toISOString(), updated: new Date().toISOString(),
      }));
    });

    const list = runCli(['--list', '--json', '--cwd', dir]);
    assertEq(list.status, 0, `--list should exit 0: ${list.stderr}`);
    const listed = JSON.parse(list.stdout);
    const openItems = listed.filter(it => it.status === 'inbox' || it.status === 'triaged');
    const openIds = openItems.map(it => it.id).sort();
    const expectedIds = [ids.inbox, ids.triaged].sort();
    assertEq(openIds, expectedIds, `open-items filter must yield exactly inbox+triaged: ${JSON.stringify(openIds)} vs ${JSON.stringify(expectedIds)}`);
  });
});

// Note: this suite deliberately does NOT spawn `node scripts/run-tests.js` on
// itself — run-tests.js auto-discovers every scripts/*.test.js file (including
// this one), so shelling out to it here would recurse infinitely. The truth
// "run-tests.js passes end-to-end" is verified by running run-tests.js directly
// (see T04-PLAN.md Step 5 and the verification gate below), which in turn
// executes this file as one of its suites.

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`      ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
