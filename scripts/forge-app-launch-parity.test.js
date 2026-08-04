#!/usr/bin/env node
'use strict';

// forge-app-launch-parity.test.js — the CLI half of the counter-criterion
// proof for D9/F7 (S06/T04): "five drag-move gestures in a row must produce
// zero /forge-task launches".
//
// WHY THIS IS A SEPARATE SUITE (D-S06-7, precedent D-S05-5): this suite
// SPAWNS A PROCESS (the real scripts/forge-items.js, over a temporary
// store) to anchor the item-id shape — a different class of proof than the
// pure file-reading guards in forge-app-items.test.js. It still never
// skips: Node spawning Node with an argv array (no shell) runs on Windows
// exactly as it runs here.
//
// WHAT IS BEING PROVEN. app/fixtures/board-gesture-launches.json is read by
// TWO INDEPENDENT sides:
//   - Swift (app/Sources/ForgeKitTests/main.swift) applies
//     ItemLaunch.decide to each gesture IN ORDER and asserts the resulting
//     slashCommand list equals expected_launches, item by item.
//   - this file (a) RECALCULATES expected_launches from items + gestures
//     with its OWN rule — never reading, importing or grepping the Swift
//     source — and (b) ANCHORS the item-id shape by running
//     `forge-items.js --add` on a temporary store and checking the
//     generated id against the SAME regex used to decide launches.
// Loosening a value of expected_launches so the Swift side passes breaks
// (a). Inventing an id shape the engine never emits breaks (b). Comparing
// Swift against Swift would be tautology — that is the whole point.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const fixturePath = path.join(repoRoot, 'app', 'fixtures', 'board-gesture-launches.json');
const forgeItemsPath = path.join(__dirname, 'forge-items.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n  ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log('\n=== forge app board-gesture launch parity (D9/F7) ===\n');

// A missing fixture must NEVER become a silently green run — it is the
// shared input of both halves of the proof, so its absence is a hard
// failure, never a skip.
if (!fs.existsSync(fixturePath)) {
  console.error(`✗ fixture not found at ${fixturePath} — refusing to skip: it is the shared input of the counter-criterion proof.`);
  process.exit(1);
}
if (!fs.existsSync(forgeItemsPath)) {
  console.error(`✗ engine not found at ${forgeItemsPath} — refusing to skip.`);
  process.exit(1);
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const items = fixture.items;
const gestures = fixture.gestures;
const expectedLaunches = fixture.expected_launches;

const ID_SHAPE = /^I-\d{1,14}(-[a-z0-9-]*)?$/;
const OPEN_STATUSES = ['inbox', 'triaged', 'doing'];

function itemById(id) {
  return items.find(i => i.id === id);
}

// The INDEPENDENT rule (never derived from, nor cross-checked against, the
// Swift ItemLaunch.decide implementation): a gesture produces a launch IFF
// it is a `start`, the item's status is one of the three open statuses, AND
// the item's id matches the whole-string readback shape.
function recomputeLaunches(gestureList) {
  const out = [];
  for (const g of gestureList) {
    if (g.kind !== 'start') continue;
    const item = itemById(g.item);
    if (!item) throw new Error(`gesture references item "${g.item}" which is not in fixture.items`);
    if (!OPEN_STATUSES.includes(item.status)) continue;
    if (!ID_SHAPE.test(item.id)) continue;
    out.push(`/forge-task ${item.id}`);
  }
  return out;
}

// ── (0) the fixture is structurally what both sides assume ──────────────────

check('fixture has items, gestures and expected_launches, well-formed', () => {
  assert(Array.isArray(items) && items.length > 0, 'fixture.items must be a non-empty array');
  assert(Array.isArray(gestures) && gestures.length > 0, 'fixture.gestures must be a non-empty array');
  assert(Array.isArray(expectedLaunches), 'fixture.expected_launches must be an array');
  for (const g of gestures) {
    assert(['move', 'drag', 'start', 'openDetail'].includes(g.kind), `unknown gesture kind "${g.kind}"`);
    assert(itemById(g.item), `gesture references unknown item "${g.item}"`);
    if (g.kind === 'move' || g.kind === 'drag') {
      assert(typeof g.to === 'string' && g.to.length > 0, `${g.kind} gesture must carry a "to" status`);
    }
  }
});

check('fixture carries the deliberate cases the slice requires', () => {
  const firstFive = gestures.slice(0, 5);
  assert(firstFive.length === 5, 'fixture must have at least 5 gestures to exercise the counter-criterion');
  assert(firstFive.every(g => g.kind === 'move'), 'the first 5 gestures must all be "move" — the literal counter-criterion (D9/F7)');
  const destinations = new Set(firstFive.map(g => g.to));
  assert(destinations.has('done'), 'the first 5 moves must cover "done" as a destination');
  assert(destinations.has('dropped'), 'the first 5 moves must cover "dropped" as a destination');
  assert(new Set(firstFive.map(g => g.item)).size === 5, 'the first 5 moves must be over 5 distinct items');

  const known = ['inbox', 'triaged', 'doing', 'done', 'dropped'];
  const unknownMove = gestures.find(g => g.kind === 'move' && !known.includes(itemById(g.item).status));
  assert(unknownMove, 'fixture has no "move" of an item with an UNKNOWN status — the Desconhecido column must also refuse to launch');

  assert(gestures.some(g => g.kind === 'openDetail'), 'fixture has no "openDetail" gesture — opening detail must not be conflated with starting work');

  const startTriaged = gestures.find(g => g.kind === 'start' && itemById(g.item).status === 'triaged');
  assert(startTriaged, 'fixture has no "start" of a well-formed triaged item — the one positive case');

  const startDone = gestures.find(g => g.kind === 'start' && itemById(g.item).status === 'done');
  assert(startDone, 'fixture has no "start" of a done item — the deterministic refusal case (D-S06-3)');

  const startMalformed = gestures.find(g => g.kind === 'start' && !ID_SHAPE.test(itemById(g.item).id));
  assert(startMalformed, 'fixture has no "start" of an item whose id does not match the readback shape — the silent-failure case (D-S06-4)');

  // Arrastar entrou quando o piso subiu para macOS 26. E o MESMO ato que o menu
  // "Mover para" — organizar — entao o contra-criterio D9/F7 vale para ele. Se
  // o gesto existe no app e nao esta aqui, o fixture deixou de cobrir metade do
  // caminho de mover.
  const drags = gestures.filter((g) => g.kind === 'drag');
  assert(drags.length >= 5,
    `fixture tem ${drags.length} gesto(s) "drag" — o contra-criterio precisa de pelo menos 5, `
    + 'igual ao do menu, senao arrastar vira o caminho nao auditado');
  assert(recomputeLaunches(drags).length === 0,
    'arrastar produziu launch — arrastar e organizar, nunca originar trabalho (D9/F7)');

  assert(expectedLaunches.length === 1, 'expected_launches must have EXACTLY 1 entry — otherwise "zero everywhere" could pass by accident');
});

// ── (a) recalculation: expected_launches is not free-hand ───────────────────

check('recalculating expected_launches from items+gestures (independent rule) reproduces the committed list', () => {
  const recomputed = recomputeLaunches(gestures);
  assert(
    JSON.stringify(recomputed) === JSON.stringify(expectedLaunches),
    `recomputed ${JSON.stringify(recomputed)} but fixture.expected_launches is ${JSON.stringify(expectedLaunches)} — ` +
      'the committed expectation does not match a fresh, independent derivation from items+gestures'
  );
});

check('the first 5 gestures (the counter-criterion, D9/F7) recompute to ZERO launches', () => {
  const recomputed = recomputeLaunches(gestures.slice(0, 5));
  assert(
    recomputed.length === 0,
    `5 consecutive move gestures must produce 0 launches, got ${JSON.stringify(recomputed)}`
  );
});

check('loosening expected_launches would be caught: an extra entry disagrees with the recomputation', () => {
  // Not a redundant test: proves the fixture actually discriminates a looser
  // (wrong) expectation — if this ever passed trivially, the recomputation
  // stopped doing its job as an independent check.
  const loosened = expectedLaunches.concat('/forge-task I-99999999999999-fake');
  const recomputed = recomputeLaunches(gestures);
  assert(
    JSON.stringify(loosened) !== JSON.stringify(recomputed),
    'a loosened expected_launches list was not distinguishable from the real recomputation'
  );
});

// ── (b) anchor: the fixture's id shape is the engine's real shape ───────────

let tmp = null;
try {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-launch-parity-'));

  check('engine round-trip: --add generates an id matching the same shape ItemLaunch relies on', () => {
    const res = spawnSync(process.execPath, [forgeItemsPath, '--add', '--cwd', tmp], {
      input: JSON.stringify({ title: 'item de ancoragem da forma do id', origin: 'human' }),
      encoding: 'utf8',
    });
    assert(res.status === 0, `forge-items.js --add failed (exit ${res.status}): ${(res.stderr || '').trim()}`);

    const added = JSON.parse(res.stdout);
    const generatedId = added.id;
    assert(typeof generatedId === 'string' && generatedId.length > 0, `--add did not return a string id, got ${JSON.stringify(added)}`);
    assert(
      ID_SHAPE.test(generatedId),
      `engine-generated id "${generatedId}" does not match ${ID_SHAPE} — the fixture's id shape was not invented by this slice, it must match the real engine`
    );

    const list = spawnSync(process.execPath, [forgeItemsPath, '--list', '--json', '--cwd', tmp], { encoding: 'utf8' });
    assert(list.status === 0, `forge-items.js --list --json failed (exit ${list.status}): ${(list.stderr || '').trim()}`);
    const fromEngine = JSON.parse(list.stdout);
    assert(fromEngine.some(i => i.id === generatedId), 'the generated id did not round-trip through --list --json');
  });

  check('the temporary store was used — nothing was written to the repo .gsd/', () => {
    assert(fs.existsSync(path.join(tmp, '.gsd', 'items')), `expected ${tmp}/.gsd/items to exist — the engine did not use --cwd`);
    assert(path.resolve(tmp).startsWith(path.resolve(os.tmpdir())), `the store must live under the OS tmpdir, got ${tmp}`);
    assert(!path.resolve(tmp).startsWith(path.resolve(repoRoot)), 'the temporary store must never live inside the repo');
  });
} finally {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}

check('the temporary store was cleaned up', () => {
  assert(tmp && !fs.existsSync(tmp), `temporary store ${tmp} survived the run`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
