#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const adapter = require('./forge-long-workflow-adapter.js');
const maintenance = require('./forge-maintenance.js');
const doctor = require('./forge-doctor.js');
const mcp = require('./forge-mcp.js');
const headless = require('./forge-headless.js');

const REPO = path.resolve(__dirname, '..');
const FAKE_HEADLESS = path.join(__dirname, 'fixtures', 'hooks-headless', 'fake-jsonl-cli.js');
const PLATFORMS = ['win32', 'darwin', 'linux'];
const HOSTS = ['claude', 'codex'];
let passed = 0;
function pass(name) { passed++; process.stdout.write(`  ✓ ${name}\n`); }
function available(id) { return { id, status: 'available', reason_code: 'available' }; }
function pickWorkflow(result) {
  return {
    outcome: result.outcome, reason_code: result.reason_code, lifecycle: result.lifecycle,
    action: result.action, unit: result.unit && result.unit.key,
    step_count: result.snapshot.step_count,
    boundary: result.boundary ? { state: result.boundary.state, has_idempotency_key: Boolean(result.boundary.idempotency_key) } : null,
  };
}
function fakeController() {
  return { run(operation, input) {
    if (operation === 'status') return { outcome: 'completed', reason_code: 'status-ready' };
    if (input.boundary) return { outcome: 'completed', reason_code: 'handoff-ready' };
    if (input.needs_input) return {
      outcome: 'needs_input', reason_code: 'needs-input', unit: { type: 'execute-task', id: 'T01', key: 'execute-task/T01' },
      boundary: { protocol_version: '1.0.0', state: 'awaiting_input', idempotency_key: 'handoff-Ω', boundary_id: 'boundary-1' },
    };
    return { outcome: 'completed', reason_code: 'unit-selected', unit: { type: 'execute-task', id: 'T01', key: 'execute-task/T01' } };
  } };
}
function catalog() {
  return { capabilities: [
    { capability_id: 'operational-hooks', kind: 'hook', required: true, hosts: { claude: 'implemented', codex: 'implemented' }, probe: { kind: 'filesystem', path: 'scripts/forge-hook.js' } },
    { capability_id: 'operational-headless', kind: 'headless', required: true, hosts: { claude: 'implemented', codex: 'implemented' }, probe: { kind: 'filesystem', path: 'scripts/forge-headless.js' } },
    { capability_id: 'operational-mcp', kind: 'mcp', required: true, hosts: { claude: 'implemented', codex: 'implemented' }, probe: { kind: 'filesystem', path: 'scripts/forge-mcp.js' } },
    { capability_id: 'operational-statusline', kind: 'statusline', required: false, hosts: { claude: 'conditional', codex: 'conditional' }, probe: { kind: 'filesystem', path: 'missing-statusline-fixture' } },
  ] };
}
function semanticDiagnostics(report) {
  return report.diagnostics.map((item) => ({ capability: item.capability, status: item.status, reason_code: item.reason_code, severity: item.severity, required: item.required }))
    .sort((left, right) => left.capability.localeCompare(right.capability));
}
function writeRuntimeProbe(root) {
  const file = path.join(root, 'fake runtime Ω.js');
  fs.writeFileSync(file, "if(process.argv.includes('--version'))process.stdout.write('3.2.0\\n');else process.stdout.write('help\\n');\n");
  return file;
}
function manifest(forgeHome, host) {
  fs.mkdirSync(forgeHome, { recursive: true });
  fs.writeFileSync(path.join(forgeHome, 'manifest.json'), JSON.stringify({ version: '3.1.4', adapters: { [host]: {} } }));
}

async function exercise(platform, host, root, runtimeProbe) {
  const workspace = path.join(root, platform, host, 'workspace espaço Ω');
  const forgeHome = path.join(root, platform, host, 'forge home Ω');
  const otherHome = path.join(root, platform, host, host === 'claude' ? 'absent codex home' : 'absent claude home');
  fs.mkdirSync(workspace, { recursive: true });
  manifest(forgeHome, host);
  const workflow = {};
  for (const mode of ['auto', 'task']) {
    // `milestone` is load-bearing, not decoration: both modes of the real layer
    // are milestone-scoped, and without it `task` is refused up front
    // (task-scope-unsupported) and `auto` throws — either way the next/pause/
    // resume/handoff chain below would stop being exercised for that mode.
    const input = { workflow_id: `${mode}-parity`, milestone: 'M-20260804000000-parity', description: 'linha α\r\nlinha β Ω', max_steps: mode === 'task' ? 1 : 4 };
    const first = adapter.invoke(host, mode, 'next', input, null, { orchestrate: fakeController() }).result;
    const retry = adapter.invoke(host, mode, 'next', input, first.snapshot, { orchestrate: fakeController() }).result;
    assert.deepStrictEqual(retry, first, `${platform}/${host}/${mode}: retry must be idempotent`);
    const paused = adapter.invoke(host, mode, 'pause', input, null, { orchestrate: fakeController() }).result;
    const target = host === 'claude' ? 'codex' : 'claude';
    const resumed = adapter.invoke(target, mode, 'resume', { ...input, response: { choice: 'continue Ω' } }, paused.snapshot, { orchestrate: fakeController() }).result;
    workflow[mode] = { next: pickWorkflow(first), retry_equal: true, pause: pickWorkflow(paused), handoff: { ...pickWorkflow(resumed), host_changed: resumed.host_runtime === target } };
  }

  const probes = { runtime: host, ok: true, required_failures: [], probes: { node: available('node'), claude: host === 'claude' ? available('claude') : { id: 'claude', status: 'skipped', reason_code: 'not-selected' }, codex: host === 'codex' ? available('codex') : { id: 'codex', status: 'skipped', reason_code: 'not-selected' } } };
  const doctorReport = doctor.checkCapabilities(workspace, {
    runtime: host, platform, repo: REPO, forgeHome,
    claudeHome: host === 'claude' ? path.join(root, platform, host, 'claude') : otherHome,
    codexHome: host === 'codex' ? path.join(root, platform, host, 'codex') : otherHome,
    binaries: { [host]: { command: process.execPath, args: [runtimeProbe] } },
    detectCapabilities: () => probes, catalog: catalog(), hookTrust: { [host]: true },
  });
  assert.strictEqual(doctorReport.ok, true);

  const updatePlan = maintenance.planUpdate({ runtime: host, platform, forgeHome });
  const hookDenied = maintenance.diagnose({ runtime: host, platform, repo: REPO, forgeHome, detectCapabilities: () => probes, catalog: catalog(), hookTrust: { [host]: false } });
  const hookFinding = hookDenied.diagnostics.find((item) => item.capability === 'operational-hooks');
  assert.strictEqual(hookFinding.reason_code, 'conditional-capability-unavailable');
  assert.strictEqual(hookFinding.severity, 'warning');

  const invocation = headless.buildInvocation({ runtime: host, dispatchId: 'parity', workspaceRoot: workspace, cwd: workspace, sandbox: 'workspace-write', approval: 'never', binary: { command: process.execPath, args: [FAKE_HEADLESS, 'success'] }, env: { ...process.env, PARITY_SECRET: 'never-forward' } });
  assert.strictEqual(invocation.policy.sandbox_mode, 'workspace-write');
  const headlessResult = await headless.run({ runtime: host, dispatchId: 'parity', workspaceRoot: workspace, cwd: workspace, sandbox: 'workspace-write', approval: 'never', binary: { command: process.execPath, args: [FAKE_HEADLESS, 'success'] }, prompt: 'parity prompt Ω\r\nsecond line', timeoutMs: 1500 });
  assert.strictEqual(headlessResult.status, 'succeeded');
  const crlfParser = new headless.JsonlParser({ runtime: host, dispatchId: 'crlf' });
  const crlfLines = host === 'codex'
    ? [{ type: 'thread.started' }, { type: 'item.completed', item: { type: 'agent_message', text: 'Ω' } }, { type: 'turn.completed' }]
    : [{ type: 'system', subtype: 'init' }, { type: 'assistant', message: { content: [{ type: 'text', text: 'Ω' }] } }, { type: 'result', is_error: false }];
  crlfParser.push(`${crlfLines.map(JSON.stringify).join('\r\n')}\r\n`);
  assert.strictEqual(crlfParser.finish().output, 'Ω');

  const stdio = mcp.project({ id: 'stdio-parity', command: process.execPath, args: ['server espaço Ω.js'] }, host);
  const http = mcp.project({ id: 'http-parity', transport: 'http', url: 'https://example.test/mcp', headers: { 'X-Parity': 'Ω' } }, host);
  const authMissing = mcp.project({ id: 'auth-parity', transport: 'http', url: 'https://example.test/mcp', auth: { required: true, available: false } }, host);
  assert.strictEqual(authMissing.reason_code, 'auth-conditional-unavailable');

  const requiredMissing = maintenance.diagnose({ runtime: host, platform, repo: REPO, forgeHome, detectCapabilities: () => probes, catalog: { capabilities: [{ capability_id: 'required-fixture', kind: 'headless', required: true, hosts: { claude: 'implemented', codex: 'implemented' }, probe: { kind: 'filesystem', path: 'definitely-absent' } }] } });
  assert.strictEqual(requiredMissing.ok, false);
  const missing = requiredMissing.diagnostics.find((item) => item.capability === 'required-fixture');

  return {
    workflow,
    doctor: { ok: doctorReport.ok, diagnostics: semanticDiagnostics(doctorReport) },
    update: { backup_required: updatePlan.backup_required, preserve: updatePlan.preserve, argv_shape: ['--runtime', '<host>', '--update'] },
    hooks: { trust_denied_reason: hookFinding.reason_code, severity: hookFinding.severity },
    headless: {
      status: headlessResult.status, reason_code: headlessResult.reason_code,
      event_types: headlessResult.events.map((event) => event.type),
      usage_schema: Object.keys(headlessResult.usage).sort(), output_present: headlessResult.output.length > 0,
      security: { decision: invocation.policy.decision, reason_code: invocation.policy.reason_code, permissions: invocation.policy.permissions },
      // Sandbox mode is asserted above; its host-specific presentation is
      // metadata and must not make Claude/Codex logical projections diverge.
      process: { executable_is_node: invocation.command === process.execPath, argv_array: Array.isArray(invocation.args), shell: invocation.shell },
    },
    mcp: { stdio: stdio.config, http: http.config, auth_missing: { status: authMissing.status, reason_code: authMissing.reason_code, config: authMissing.config } },
    missing_capability: { ok: requiredMissing.ok, reason_code: missing.reason_code, severity: missing.severity },
  };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge operational parity Ω-'));
  try {
    const runtimeProbe = writeRuntimeProbe(root);
    for (const platform of PLATFORMS) {
      const results = {};
      for (const host of HOSTS) results[host] = await exercise(platform, host, root, runtimeProbe);
      assert.deepStrictEqual(results.claude, results.codex, `${platform}: semantic adapter parity`);
      pass(`${platform}: auto/task/doctor/update/hooks/headless/MCP semantic parity`);
    }
    const capabilityCatalog = JSON.parse(fs.readFileSync(path.join(REPO, 'forge-capabilities.json'), 'utf8'));
    for (const id of ['operational-statusline', 'operational-accounts', 'operational-app']) {
      const entry = capabilityCatalog.capabilities.find((item) => item.capability_id === id);
      assert(entry && entry.required === false && entry.classification === 'conditional', `${id} must remain optional conditional`);
    }
    pass('optional statusline/accounts/app never become parity blockers');

    const source = fs.readFileSync(__filename, 'utf8');
    assert(!/spawn(?:Sync)?\s*\(\s*['"](?:bash|sh|wsl|grep|sed|awk)['"]/.test(source), 'gate must not spawn shell/GNU/WSL tools');
    assert(source.includes('process.execPath'));
    pass('gate is offline Node/argv-only with isolated homes');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  process.stdout.write(`\n${passed} passed, 0 failed (2 hosts × 3 platforms)\n`);
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
