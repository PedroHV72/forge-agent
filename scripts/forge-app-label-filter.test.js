#!/usr/bin/env node
'use strict';

// forge-app-label-filter.test.js — the CLI half of the tela<->CLI parity proof
// for criterion #5 (S05/T04).
//
// WHY THIS IS A SEPARATE SUITE (D-S05-5): forge-app-items.test.js opens by
// promising "pure file reading — no swift invocation — so it NEVER skips".
// This suite SPAWNS A PROCESS (the real scripts/forge-items.js, over a
// temporary store), which is a different class of proof: it compares DATA, not
// source text. Putting it there would erase that file's promise. It still
// never skips — Node spawning Node with an argv array (no shell) runs on
// Windows exactly as it runs here.
//
// WHAT IS BEING PROVEN. app/fixtures/label-filter-parity.json is read by two
// INDEPENDENT sides:
//   - Swift (app/Sources/ForgeKitTests/main.swift) asserts
//     ItemLabelFilter.apply(items, query: L).count == expected[L].
//   - this file (a) RECALCULATES expected from the same items with the
//     expression equivalent to `jq '[.[]|select(.labels|index(L))]|length'`
//     and (b) ANCHORS the fixture in the engine: writes the items to a
//     TEMPORARY store via `forge-items.js --add` and reads them back via
//     `--list --json`, checking the labels arrays that come out.
// Loosening a value of `expected` so the Swift side passes breaks (a).
// Inventing a labels shape the engine never emits breaks (b). Comparing Swift
// against Swift would be tautology (D-S05-6) — that is the whole point.
//
// Zero deps (jq included: the expression is reproduced in JS; jq stays in the
// manual UAT only). Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const fixturePath = path.join(repoRoot, 'app', 'fixtures', 'label-filter-parity.json');
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

console.log('\n=== forge app label filter parity ===\n');

// A missing fixture must NEVER become a silently green run — it is the shared
// input of both halves of the proof, so its absence is a hard failure.
if (!fs.existsSync(fixturePath)) {
  console.error(`✗ fixture not found at ${fixturePath} — refusing to skip: it is the shared input of the parity proof.`);
  process.exit(1);
}
if (!fs.existsSync(forgeItemsPath)) {
  console.error(`✗ engine not found at ${forgeItemsPath} — refusing to skip.`);
  process.exit(1);
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const items = fixture.items;
const expected = fixture.expected;

// `Array.prototype.includes` is ELEMENT EQUALITY — precisely what jq's
// `index(L)` does inside an array. The substring form that is FORBIDDEN here
// (and which D-S05-1 rejects) would be:
//     (i.labels || []).some(x => x.includes(L))
// which would count `ui-bug` for the query `ui` and put one card on screen
// that the CLI does not count. That extra card IS the criterion #5 failure.
function countByLabel(list, label) {
  return list.filter(i => (i.labels || []).includes(label)).length;
}

// ── (0) the fixture is structurally what both sides assume ───────────────────

check('fixture has items and expected, both non-empty', () => {
  assert(Array.isArray(items) && items.length > 0, 'fixture.items must be a non-empty array');
  assert(expected && typeof expected === 'object', 'fixture.expected must be an object');
  assert(Object.keys(expected).length > 0, 'fixture.expected must have at least one label');
});

check('fixture carries the deliberate cases the slice requires', () => {
  const labelSets = items.map(i => i.labels || []);
  const flat = labelSets.flat();

  // prefix pair: one label is a strict prefix of another. This is what kills
  // substring matching — without it the parity proof proves almost nothing.
  const hasPrefixPair = flat.some(a => flat.some(b => b !== a && b.startsWith(a)));
  assert(hasPrefixPair, 'fixture has no prefix pair (e.g. "ui" / "ui-bug") — substring matching would go undetected');

  assert(items.some(i => !('labels' in i)), 'fixture has no item WITHOUT the labels key — that is how the engine omits it');
  assert(items.some(i => i.status === 'done'), 'fixture has no item with status "done"');

  const known = ['inbox', 'triaged', 'doing', 'done', 'dropped'];
  const unknown = items.find(i => !known.includes(i.status));
  assert(unknown, 'fixture has no item with an UNKNOWN status — the "Desconhecido" column must be filtered too (D-S05-2)');
  assert((unknown.labels || []).length > 0, 'the unknown-status item must carry a label, otherwise it proves nothing about filtering');

  const repeated = flat.some(l => flat.filter(x => x === l).length >= 2);
  assert(repeated, 'no label appears on two items — some expected value must be 2, not only 0 or 1');
});

check('expected pins case sensitivity explicitly (D-S05-1)', () => {
  const keys = Object.keys(expected);
  const casePair = keys.find(k => k !== k.toLowerCase() && keys.includes(k.toLowerCase()));
  assert(casePair, 'expected has no key differing only by case (e.g. "Bug" alongside "bug") — case sensitivity would be accidental, not expected');
  assert(expected[casePair] === 0, `expected["${casePair}"] must be 0 — matching is case-SENSITIVE, like jq index()`);
});

// ── (a) recalculation: expected is not free-hand ─────────────────────────────

check('recalculating expected from the fixture items reproduces every committed value', () => {
  for (const label of Object.keys(expected)) {
    const recomputed = countByLabel(items, label);
    assert(
      recomputed === expected[label],
      `expected["${label}"] = ${expected[label]} but recalculating from items (jq index() equivalent) yields ${recomputed} — ` +
        'the committed expectation does not match the fixture data'
    );
  }
});

check('substring matching would DISAGREE with expected on the prefix pair', () => {
  // Not a redundant test: it proves the fixture actually discriminates. If this
  // one ever passes trivially, the prefix pair stopped doing its job.
  const substringCount = label => items.filter(i => (i.labels || []).some(x => x.includes(label))).length;
  const diverging = Object.keys(expected).find(l => substringCount(l) !== expected[l]);
  assert(
    diverging,
    'no label in the fixture distinguishes exact matching from substring matching — the fixture cannot detect the ' +
      'regression it exists to detect'
  );
});

// ── (b) anchor: the fixture's labels shape is the engine's real shape ────────
//
// Only `labels` is anchored here. Do NOT try to push status "done"/"zzz"
// through `--add`: STATUSES is a closed set and the engine rejects anything
// outside it (correctly). Those statuses exist in the fixture for the SWIFT
// side, which decodes them straight from JSON without going through the
// engine's validation. This is a deliberate boundary, not an omission.

let tmp = null;
try {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-label-parity-'));

  check('engine round-trip: --add then --list --json returns the fixture labels as real arrays', () => {
    for (const item of items) {
      const payload = { title: item.title, origin: 'human' };
      if ('labels' in item) payload.labels = item.labels;
      const res = spawnSync(process.execPath, [forgeItemsPath, '--add', '--cwd', tmp], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
      });
      assert(
        res.status === 0,
        `forge-items.js --add failed for "${item.title}" (exit ${res.status}): ${(res.stderr || '').trim()}`
      );
    }

    const list = spawnSync(process.execPath, [forgeItemsPath, '--list', '--json', '--cwd', tmp], {
      encoding: 'utf8',
    });
    assert(list.status === 0, `forge-items.js --list --json failed (exit ${list.status}): ${(list.stderr || '').trim()}`);

    const fromEngine = JSON.parse(list.stdout);
    assert(
      fromEngine.length === items.length,
      `engine returned ${fromEngine.length} items, fixture has ${items.length}`
    );

    for (const item of items) {
      const got = fromEngine.find(i => i.title === item.title);
      assert(got, `engine output has no item titled "${item.title}"`);
      assert(
        Array.isArray(got.labels),
        `engine returned labels of type ${typeof got.labels} for "${item.title}" — --list --json must widen the ` +
          'on-disk scalar into an array (D6); the fixture shape depends on it'
      );
      const fixtureLabels = item.labels || [];
      assert(
        JSON.stringify(got.labels) === JSON.stringify(fixtureLabels),
        `labels mismatch for "${item.title}": engine ${JSON.stringify(got.labels)} vs fixture ${JSON.stringify(fixtureLabels)}`
      );
    }
  });

  check('counts recalculated over the ENGINE output match expected, label by label', () => {
    const list = spawnSync(process.execPath, [forgeItemsPath, '--list', '--json', '--cwd', tmp], {
      encoding: 'utf8',
    });
    assert(list.status === 0, `forge-items.js --list --json failed (exit ${list.status}): ${(list.stderr || '').trim()}`);
    const fromEngine = JSON.parse(list.stdout);

    for (const label of Object.keys(expected)) {
      const engineCount = countByLabel(fromEngine, label);
      assert(
        engineCount === expected[label],
        `parity broken for "${label}": the real engine yields ${engineCount}, expected (and asserted in Swift) is ${expected[label]}`
      );
    }
  });

  check('the temporary store was used — nothing was written to the repo .gsd/', () => {
    assert(fs.existsSync(path.join(tmp, '.gsd', 'items')), `expected ${tmp}/.gsd/items to exist — the engine did not use --cwd`);
    assert(
      path.resolve(tmp).startsWith(path.resolve(os.tmpdir())),
      `the store must live under the OS tmpdir, got ${tmp}`
    );
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
