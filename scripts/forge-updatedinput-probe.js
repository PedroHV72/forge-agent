#!/usr/bin/env node
'use strict';

// forge-updatedinput-probe.js
//
// Standalone, manually-invocable E2E probe. Proves — from the CHILD process
// side (an argv/env dump the child itself writes) — whether Claude Code
// honors `hookSpecificOutput.updatedInput` emitted by a PreToolUse hook for
// the Bash tool, and answers three semantics questions empirically:
//
//   Q1 — is `updatedInput` honored WITHOUT `permissionDecision: 'allow'`,
//        preserving the normal permission flow?
//   Q2 — with `permissionDecision: 'allow'` alongside `updatedInput`, is the
//        rewrite honored AND the permission prompt bypassed?
//   Q3 — does a malformed `hookSpecificOutput` cause the ORIGINAL command to
//        run (doc says: non-blocking error on schema-invalid stdout, exit 0)?
//
// This script is deliberately standalone: it does not import forge-hook.js
// or any T01/T03 module. Its own temp workspace, its own inline hook, its
// own fixture runner. Evidence must stand on its own regardless of how the
// real rewrite module evolves (B3 / MEM001).
//
// NEVER wired into run-tests.js or forge-smoke.js — this probe spends real
// API tokens and requires an authenticated `claude` CLI.
//
// Usage: node scripts/forge-updatedinput-probe.js
//   Exits 0 on any COMPLETED measurement (including "not honored" — that is
//   a finding, not a failure). Exits 1 only on environment/tooling failure
//   that prevented measurement (e.g. `claude` not found, not authenticated).

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER_ORIGINAL = '--forge-probe-original';
const MARKER_REWRITTEN = '--forge-probe-rewritten';
const ENV_PREFIX = 'FORGE_PROBE_ENV=1';

// ── CLI degrades safely (idiom borrowed from forge-resources.js runCli) ────
function runCli() {
  const verdicts = [];

  const claudeCheck = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (claudeCheck.error || claudeCheck.status !== 0) {
    console.error(JSON.stringify({
      status: 'blocked',
      reason: 'claude-cli-unavailable',
      raw_error: claudeCheck.error ? String(claudeCheck.error) : (claudeCheck.stderr || '').trim(),
    }));
    process.exit(1);
  }
  const claudeVersion = (claudeCheck.stdout || '').trim();
  console.error(`[probe] claude --version: ${claudeVersion}`);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-updatedinput-probe-'));
  console.error(`[probe] workspace: ${workspace}`);

  try {
    const paths = buildWorkspace(workspace);

    const variants = [
      {
        name: 'updatedInput-without-permissionDecision',
        question: 'Q1',
        hookVariant: 'no-permission',
        skipPermissions: false,
      },
      {
        name: 'updatedInput-with-allow',
        question: 'Q2',
        hookVariant: 'allow',
        skipPermissions: true,
      },
      {
        name: 'malformed-payload',
        question: 'Q3',
        hookVariant: 'malformed',
        skipPermissions: true,
      },
    ];

    for (const variant of variants) {
      const result = runVariant(workspace, paths, variant);
      verdicts.push(result);
      console.error(`[probe] ${variant.name} → ${JSON.stringify(result)}`);
    }
  } finally {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }

  for (const v of verdicts) {
    console.log(JSON.stringify(v));
  }

  process.exit(0);
}

// ── Workspace construction ──────────────────────────────────────────────────
function buildWorkspace(workspace) {
  const runnerPath = path.join(workspace, 'runner.js');
  const hookPath = path.join(workspace, 'probe-hook.js');
  const settingsPath = path.join(workspace, 'settings.json');

  // Fixture runner: dumps argv (minus the dump-path arg itself) + selected
  // env to the dump file passed as its first arg.
  fs.writeFileSync(runnerPath, [
    '#!/usr/bin/env node',
    "'use strict';",
    'const fs = require("fs");',
    'const dumpPath = process.argv[2];',
    'const rest = process.argv.slice(3);',
    'const payload = {',
    '  argv: rest,',
    '  env: { FORGE_PROBE_ENV: process.env.FORGE_PROBE_ENV || null },',
    '};',
    'fs.writeFileSync(dumpPath, JSON.stringify(payload));',
    '',
  ].join('\n'), 'utf8');

  // Inline probe hook — NOT forge-hook.js. Reads stdin PreToolUse payload;
  // when tool_input.command contains the "--forge-probe-original" marker,
  // emits the variant's payload (selected via FORGE_PROBE_VARIANT env var,
  // inherited from the `claude` process this hook is a child of).
  fs.writeFileSync(hookPath, [
    '#!/usr/bin/env node',
    "'use strict';",
    'let raw = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", c => (raw += c));',
    'process.stdin.on("end", () => {',
    '  try {',
    '    const data = JSON.parse(raw);',
    '    const cmd = (data.tool_input && data.tool_input.command) || "";',
    `    if (!cmd.includes(${JSON.stringify(MARKER_ORIGINAL)})) { process.exit(0); }`,
    '    const variant = process.env.FORGE_PROBE_VARIANT || "";',
    `    const rewritten = ${JSON.stringify(ENV_PREFIX)} + " " + cmd.replace(${JSON.stringify(MARKER_ORIGINAL)}, ${JSON.stringify(MARKER_REWRITTEN)});`,
    '    if (variant === "allow") {',
    '      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: rewritten } } }));',
    '      process.exit(0);',
    '    } else if (variant === "no-permission") {',
    '      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: rewritten } } }));',
    '      process.exit(0);',
    '    } else if (variant === "malformed") {',
    '      // Schema-invalid: updatedInput as a bare string, no "command" key.',
    '      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: "not-an-object" } }));',
    '      process.exit(0);',
    '    } else {',
    '      process.exit(0);',
    '    }',
    '  } catch (e) {',
    '    process.stderr.write(String(e));',
    '    process.exit(0);',
    '  }',
    '});',
    '',
  ].join('\n'), 'utf8');

  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node ${JSON.stringify(hookPath).slice(1, -1)}` }],
        },
      ],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

  return { runnerPath, hookPath, settingsPath };
}

// ── Per-variant spawn + observation ──────────────────────────────────────────
function runVariant(workspace, paths, variant) {
  const dumpPath = path.join(workspace, `dump-${variant.name}.json`);
  try { fs.unlinkSync(dumpPath); } catch { /* fine, may not exist */ }

  const prompt = `Run this exact bash command and nothing else: node ${paths.runnerPath} ${dumpPath} ${MARKER_ORIGINAL}`;

  const args = ['-p', prompt, '--settings', paths.settingsPath, '--model', 'haiku'];
  if (variant.skipPermissions) args.push('--dangerously-skip-permissions');

  const env = Object.assign({}, process.env, { FORGE_PROBE_VARIANT: variant.hookVariant });

  const spawned = spawnSync('claude', args, {
    cwd: workspace,
    env,
    encoding: 'utf8',
    timeout: 90_000,
  });

  const claude_exit = spawned.status === null ? (spawned.signal ? `signal:${spawned.signal}` : 'null') : spawned.status;
  const claude_stdout = (spawned.stdout || '').slice(0, 4000);
  const claude_stderr = (spawned.stderr || '').slice(0, 4000);

  let dump = null;
  let dump_error = null;
  try {
    dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
  } catch (e) {
    dump_error = String(e && e.message || e);
  }

  let honored = null; // true | false | null (undetermined — dump never written)
  let bash_ran = dump !== null;
  if (dump) {
    const argvStr = JSON.stringify(dump.argv || []);
    const rewrittenSeen = argvStr.includes(MARKER_REWRITTEN);
    const originalSeen = argvStr.includes(MARKER_ORIGINAL) && !rewrittenSeen;
    const envSeen = dump.env && dump.env.FORGE_PROBE_ENV === '1';
    if (rewrittenSeen && envSeen) honored = true;
    else if (originalSeen) honored = false;
    else honored = null; // ambiguous — record raw for manual inspection
  }

  return {
    variant: variant.name,
    question: variant.question,
    honored,
    bash_ran,
    child_argv: dump ? dump.argv : null,
    child_env: dump ? dump.env : null,
    dump_error,
    claude_exit,
    claude_stdout_tail: claude_stdout.slice(-800),
    claude_stderr_tail: claude_stderr.slice(-800),
  };
}

if (require.main === module) {
  runCli();
}

module.exports = { runCli, buildWorkspace, runVariant };
