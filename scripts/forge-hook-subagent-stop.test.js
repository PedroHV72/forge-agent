#!/usr/bin/env node
'use strict';

// Contract tests for the native Claude Code SubagentStop repair loop.
// A malformed Forge worker gets one in-context correction; unrelated agents
// and the second hook pass remain fail-open.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hookPath = path.join(__dirname, 'forge-hook.js');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-subagent-stop-'));
let passed = 0;

function run(input) {
  const result = spawnSync(process.execPath, [hookPath, 'subagent-stop'], {
    cwd,
    input: JSON.stringify({
      session_id: `subagent-stop-test-${process.pid}`,
      cwd,
      ...input,
    }),
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function test(name, fn) {
  fn();
  passed++;
  process.stdout.write(`  ✓ ${name}\n`);
}

try {
  test('known Forge worker without result block is kept alive', () => {
    const output = run({
      agent_type: 'forge-executor',
      stop_hook_active: false,
      last_assistant_message: 'Implemented and verified the task.',
    });
    const parsed = JSON.parse(output);
    assert.strictEqual(parsed.decision, 'block');
    assert.match(parsed.reason, /GSD-WORKER-RESULT/);
    assert.match(parsed.reason, /forge-executor/);
    const live = JSON.parse(fs.readFileSync(
      path.join(os.tmpdir(), `forge-live-subagent-stop-test-${process.pid}.json`),
      'utf8',
    ));
    assert.strictEqual(live.status, 'repairing-contract');
  });

  test('valid Forge worker result is allowed', () => {
    const output = run({
      agent_type: 'forge-planner',
      stop_hook_active: false,
      last_assistant_message: '---GSD-WORKER-RESULT---\nstatus: done\nsummary: planned',
    });
    assert.strictEqual(output, '');
  });

  test('second hook pass is an escape hatch', () => {
    const output = run({
      agent_type: 'forge-reviewer',
      stop_hook_active: true,
      last_assistant_message: 'still malformed',
    });
    assert.strictEqual(output, '');
  });

  test('command-only forge-memory agent is not blocked', () => {
    const output = run({
      agent_type: 'forge-memory',
      stop_hook_active: false,
      last_assistant_message: '',
    });
    assert.strictEqual(output, '');
  });

  test('unrelated custom agents are not blocked', () => {
    const output = run({
      agent_type: 'code-reviewer',
      stop_hook_active: false,
      last_assistant_message: '',
    });
    assert.strictEqual(output, '');
  });

  process.stdout.write(`\n${passed} passed, 0 failed\n`);
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
  try {
    fs.rmSync(path.join(os.tmpdir(), `forge-live-subagent-stop-test-${process.pid}.json`), { force: true });
  } catch {}
}
