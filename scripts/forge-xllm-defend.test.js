#!/usr/bin/env node
'use strict';
/**
 * --mode defend: the surface whose absence made `advocate: auto` a no-op for
 * GPT/Gemini authors. Coverage here is the contract Steps 3–7a of
 * shared/forge-review.md consume, not the model's judgment quality.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  buildDefendPrompt,
  normalizeDefense,
  validateVerdicts,
  verdictSchema,
  DEFEND_VERDICT_ENUM,
  runDefend,
} = require('./forge-xllm.js');

const CLI = path.join(__dirname, 'forge-xllm.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-xllm-defend-'));

// ── Enum is the advocate's, not the rebuttal's ──────────────────────────────
assert.deepStrictEqual(DEFEND_VERDICT_ENUM, ['refuted', 'conceded', 'open']);
assert.strictEqual(
  verdictSchema(DEFEND_VERDICT_ENUM).properties.verdicts.items.properties.verdict.enum[1],
  'conceded'
);

// ── validateVerdicts is enum-parameterized without breaking its old callers ──
const defenseObj = { verdicts: [{ id: 'R1', verdict: 'conceded', rationale: 'real bug' }] };
const rebuttalObj = { verdicts: [{ id: 'R1', verdict: 'withdrawn', rationale: 'defense holds' }] };
assert.ok(validateVerdicts(defenseObj, DEFEND_VERDICT_ENUM), 'defense verdicts accepted');
assert.ok(validateVerdicts(rebuttalObj), 'default enum still the rebuttal one');
assert.ok(!validateVerdicts(defenseObj), 'defense verdicts rejected under the default enum');
assert.ok(!validateVerdicts(rebuttalObj, DEFEND_VERDICT_ENUM), 'rebuttal verdicts rejected as defense');
assert.ok(
  !validateVerdicts({ verdicts: [{ id: 'R1', verdict: 'maybe', rationale: 'x' }] }, DEFEND_VERDICT_ENUM),
  'invented verdict rejected'
);
assert.ok(
  !validateVerdicts({ verdicts: [{ id: '', verdict: 'open', rationale: 'x' }] }, DEFEND_VERDICT_ENUM),
  'empty id rejected — Step 5 pairs verdicts to objections by id'
);

// ── normalizeDefense keeps `rationale` (Steps 5/7a read defense.rationale) ───
const normalized = normalizeDefense(defenseObj);
assert.deepStrictEqual(normalized, {
  verdicts: [{ id: 'R1', verdict: 'conceded', rationale: 'real bug' }],
});
assert.ok(!('reason' in normalized.verdicts[0]), 'defense does not rename to `reason` as rebuttal does');

// ── The prompt frames the AUTHOR, and forbids both degenerate postures ───────
const prompt = buildDefendPrompt('R1 — src/a.js:10 — claim');
assert.ok(/who wrote the code/i.test(prompt), 'author framing present');
assert.ok(/refuted/.test(prompt) && /conceded/.test(prompt) && /open/.test(prompt));
assert.ok(/both failure modes/i.test(prompt), 'agree-with-everything is called out');
assert.ok(/verify claims against the actual code/i.test(prompt), 'told to check the code');
assert.ok(prompt.includes('R1 — src/a.js:10 — claim'), 'objections embedded verbatim');

// ── Missing --input is a caller error, not a silent empty defense ────────────
assert.throws(() => runDefend({ cwd: dir }), /requires --input/);
assert.throws(() => runDefend({ cwd: dir, inputFile: path.join(dir, 'nope') }), /failed to read --input/);

// ── CLI wiring ──────────────────────────────────────────────────────────────
const run = (args, env) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8', env: { ...process.env, ...(env || {}) },
      }),
    };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
};

// defend is a recognized mode (the usage line lists it)
const usage = run(['--mode', 'bogus']);
assert.strictEqual(usage.code, 2);
assert.ok(/challenge\|defend\|rebuttal\|execute\|plan/.test(usage.err), 'usage advertises defend');

// stdout is the result channel — --result-file belongs to execute/plan only
const rf = run(['--mode', 'defend', '--input', 'x', '--result-file', path.join(dir, 'r.json')]);
assert.strictEqual(rf.code, 2);
assert.ok(/--result-file is not supported in --mode defend/.test(rf.err));
assert.ok(/challenge\/defend\/rebuttal/.test(rf.err), 'error message lists defend with its peers');

// agy (Gemini) is allowed to defend — the execute/plan-only guard must not catch it
const agyGuard = run(['--mode', 'defend', '--input', path.join(dir, 'missing-input')], {});
assert.strictEqual(agyGuard.code, 2);
assert.ok(
  !/supports only challenge\|rebuttal/.test(agyGuard.err || ''),
  'defend is not rejected by the engine-capability guard'
);
const agyExplicit = run(['--mode', 'defend', '--engine', 'agy', '--input', path.join(dir, 'missing-input')]);
assert.ok(
  !/--engine agy supports only/.test(agyExplicit.err || ''),
  'agy may defend (only execute/plan are codex-only)'
);

// ── End-to-end through a mocked engine ──────────────────────────────────────
// The codex mock is a POSIX shell script (the established convention in this
// suite — FORGE_XLLM_CODEX_BIN resolves to a single executable path, unlike the
// agy mock which is a .js launched with the current Node). Windows skips.
const inputFile = path.join(dir, 'objections.txt');
fs.writeFileSync(inputFile, 'R1 ...\nR2 ...\nR3 ...\n');
// The real `codex exec` takes the prompt on stdin and writes its answer to the
// `-o` last-message file; stdout is not the channel. A mock that prints to stdout
// reproduces nothing, so this one mirrors the contract.
const writeCodexMock = (file, payload) => {
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      'OUT=""',
      'prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "-o" ]; then OUT="$arg"; fi',
      '  prev="$arg"',
      'done',
      'cat - > /dev/null',
      `if [ -n "$OUT" ]; then printf '%s' '${payload.replace(/'/g, "'\\''")}' > "$OUT"; fi`,
      'exit 0',
      '',
    ].join('\n')
  );
  fs.chmodSync(file, 0o755);
};

if (process.platform !== 'win32') {
  const mock = path.join(dir, 'mock-codex.sh');
  writeCodexMock(
    mock,
    JSON.stringify({
      verdicts: [
        { id: 'R1', verdict: 'conceded', rationale: 'the null check is genuinely missing' },
        { id: 'R2', verdict: 'refuted', rationale: 'callers already normalize this input' },
        { id: 'R3', verdict: 'open', rationale: 'deliberate tradeoff for readability' },
      ],
    })
  );
  const e2e = run(['--mode', 'defend', '--input', inputFile, '--cwd', dir], {
    FORGE_XLLM_CODEX_BIN: mock,
  });
  assert.strictEqual(e2e.code, 0, `defend e2e exited ${e2e.code}: ${e2e.err || ''}`);
  const parsed = JSON.parse(e2e.out);
  assert.strictEqual(parsed.verdicts.length, 3);
  assert.deepStrictEqual(parsed.verdicts.map((v) => v.verdict), ['conceded', 'refuted', 'open']);
  assert.ok(parsed.verdicts.every((v) => typeof v.rationale === 'string'), 'rationale survives');
  assert.ok(parsed.verdicts.every((v) => !('reason' in v)), 'no rebuttal-shaped rename');

  // A defender that returns rebuttal verdicts must fail validation, not be
  // silently accepted — that is how a mis-wired mode would go unnoticed.
  const wrong = path.join(dir, 'mock-codex-wrong.sh');
  writeCodexMock(wrong, JSON.stringify({ verdicts: [{ id: 'R1', verdict: 'withdrawn', rationale: 'x' }] }));
  const bad = run(['--mode', 'defend', '--input', inputFile, '--cwd', dir], {
    FORGE_XLLM_CODEX_BIN: wrong,
  });
  assert.strictEqual(bad.code, 2, 'wrong-enum defense rejected');
  assert.ok(/defense verdicts validation/.test(bad.err || ''), 'rejection names the defense contract');
}

console.log('forge-xllm-defend tests passed');
