#!/usr/bin/env node
'use strict';

// Standalone parity matrix for forge-dispatch-resolve.  This deliberately has
// no test-framework dependency: it is useful before the installer runs too.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveDispatch } = require('./forge-dispatch-resolve.js');
const { readTierChain } = require('./forge-tier-chain.js');

const SCRIPT = path.join(__dirname, 'forge-dispatch-resolve.js');
const KEEP = process.argv.includes('--keep');
let passes = 0;
let fails = 0;
const fixtures = [];

function pass(name) {
  passes += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

function fail(name, detail) {
  fails += 1;
  process.stdout.write(`  ✗ ${name}\n    ${detail || 'assertion failed'}\n`);
}

function assert(condition, name, detail) {
  if (condition) pass(name);
  else fail(name, detail);
}

function assertEqual(actual, expected, name) {
  assert(actual === expected, name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function mkFixture(input) {
  const spec = input || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dispatch-resolve-'));
  fs.mkdirSync(path.join(dir, '.gsd', 'forge'), { recursive: true });
  if (spec.prefs) fs.writeFileSync(path.join(dir, '.gsd', 'claude-agent-prefs.md'), spec.prefs, 'utf8');
  let planPath = null;
  if (spec.plan) {
    planPath = path.join(dir, 'T01-PLAN.md');
    fs.writeFileSync(planPath, spec.plan, 'utf8');
  }
  let roadmapPath = null;
  if (spec.roadmap) {
    roadmapPath = path.join(dir, 'M001-ROADMAP.md');
    fs.writeFileSync(roadmapPath, spec.roadmap, 'utf8');
  }
  const fixture = { dir, planPath, roadmapPath };
  fixtures.push(fixture);
  return fixture;
}

function cleanup(fixture) {
  if (KEEP) {
    process.stdout.write(`  (kept ${fixture.dir})\n`);
    return;
  }
  try { fs.rmSync(fixture.dir, { recursive: true, force: true }); } catch {}
}

// Avoid a developer's real global preferences changing the legacy fixtures.
function withHermeticHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dispatch-home-'));
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn({ ...process.env, HOME: home, USERPROFILE: home });
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
    if (!KEEP) fs.rmSync(home, { recursive: true, force: true });
  }
}

function dispatch(fixture, options) {
  return resolveDispatch({ cwd: fixture.dir, planPath: fixture.planPath, roadmapPath: fixture.roadmapPath, ...options });
}

function runCase(name, fn) {
  process.stdout.write(`\n[case] ${name}\n`);
  try { fn(); } catch (error) { fail(`${name} did not throw`, error.stack || error.message); }
}

withHermeticHome((cliEnv) => {
  runCase('execute-task defaults: legacy standard chain and low effort', () => {
    const f = mkFixture({});
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.tier, 'standard', 'defaults tier standard');
    assertEqual(r.route_source, 'tier_models', 'defaults use legacy tier_models');
    assertEqual(r.model, 'claude-sonnet-5', 'defaults primary is canonical sonnet');
    assertEqual(r.effort, 'low', 'defaults effort low');
    assertEqual(r.effort_reason, 'unit-type:execute-task', 'defaults effort reason');
    assertEqual(r.engine, 'claude', 'defaults engine claude');
    cleanup(f);
  });

  runCase('execute-task frontmatter tier heavy and effort high', () => {
    const f = mkFixture({ plan: '---\ntier: heavy\neffort: high\n---\n# task\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.tier, 'heavy', 'frontmatter tier override');
    assertEqual(r.reason, 'frontmatter-override:heavy', 'frontmatter tier reason');
    assertEqual(r.effort, 'high', 'opus allows high effort');
    assertEqual(r.effort_reason, 'frontmatter-effort:high', 'frontmatter effort reason');
    cleanup(f);
  });

  runCase('execute-task xhigh effort is clamped by sonnet', () => {
    const f = mkFixture({ plan: '---\neffort: xhigh\n---\n# task\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.model, 'claude-sonnet-5', 'clamp fixture resolves sonnet');
    assertEqual(r.effort, 'medium', 'xhigh effort clamps to medium');
    assert(/frontmatter-effort:xhigh\|clamped:model-cap/.test(r.effort_reason), 'clamp reason is recorded', r.effort_reason);
    cleanup(f);
  });

  runCase('execute-task docs tag selects light tier', () => {
    const f = mkFixture({ plan: '---\ntag: docs\n---\n# task\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.tier, 'light', 'docs tier light');
    assertEqual(r.reason, 'frontmatter-tag:docs', 'docs reason');
    cleanup(f);
  });

  runCase('plan-slice high-risk roadmap escalates to max', () => {
    const f = mkFixture({ roadmap: '- id: S01 risk: high domain:backend\n' });
    const r = dispatch(f, { unitType: 'plan-slice', unitId: 'S01' });
    assertEqual(r.tier, 'max', 'risk high tier max');
    assertEqual(r.reason, 'risk-escalation:high', 'risk escalation reason');
    assertEqual(r.effort, 'max', 'risk escalation effort max');
    assertEqual(r.effort_reason, 'risk-escalation:high', 'risk escalation effort reason');
    cleanup(f);
  });

  runCase('plan-slice without high risk retains heavy default', () => {
    const f = mkFixture({ roadmap: '- id: S01 risk: medium domain:backend\n' });
    const r = dispatch(f, { unitType: 'plan-slice', unitId: 'S01' });
    assertEqual(r.tier, 'heavy', 'normal plan-slice tier heavy');
    assert(r.reason !== 'risk-escalation:high', 'normal plan-slice has no escalation', r.reason);
    cleanup(f);
  });

  runCase('plan-milestone is non-routable max and uses tier_models', () => {
    const f = mkFixture({ prefs: 'routing:\n  default:\n    planner:\n      max: gpt-5-codex\n' });
    const r = dispatch(f, { unitType: 'plan-milestone' });
    assertEqual(r.tier, 'max', 'plan-milestone tier max');
    assertEqual(r.route_source, 'tier_models', 'plan-milestone is never captured by routing');
    cleanup(f);
  });

  runCase('routing backend executor selects capped routing chain', () => {
    const f = mkFixture({
      prefs: 'routing:\n  backend:\n    executor:\n      standard: [gpt-5-codex, claude-sonnet-5, claude-opus-4-8, claude-haiku-4-5-20251001]\n',
      plan: '---\ndomain: backend\n---\n# task\n',
    });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.route_source, 'routing', 'routing block is selected');
    assertEqual(r.domain, 'backend', 'routing domain backend');
    assertEqual(r.engine, r.chain[0].engine, 'routing engine comes from primary chain member');
    assertEqual(r.chain_len, 3, 'routing chain respects cap three');
    cleanup(f);
  });

  runCase('routing falls back to default domain for absent domain cell', () => {
    const f = mkFixture({
      prefs: 'routing:\n  default:\n    executor:\n      standard: claude-opus-4-8\n',
      plan: '---\ndomain: nonexistent\n---\n# task\n',
    });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.route_source, 'routing', 'default routing remains routing source');
    assertEqual(r.domain, 'default', 'missing domain uses routing.default');
    assertEqual(r.model, 'claude-opus-4-8', 'default cell model selected');
    cleanup(f);
  });

  runCase('legacy workers compatibility retains tier_models model', () => {
    const f = mkFixture({ prefs: 'workers:\n  execute-task: codex\n  codex_model: gpt-fixture\ntier_models:\n  standard: claude-opus-4-8\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    const canonical = readTierChain('standard', f.dir)[0];
    assertEqual(r.route_source, 'tier_models', 'legacy compatibility source');
    assertEqual(r.engine, 'codex', 'workers execute-task controls legacy engine');
    assertEqual(r.engine_reason, 'workers.execute-task:codex', 'legacy worker reason');
    assertEqual(r.codex_model, 'gpt-fixture', 'legacy codex model is included');
    assertEqual(r.model, canonical.id, 'legacy resolver model equals canonical tier chain');
    assertEqual(r.alias, canonical.alias, 'legacy resolver alias equals canonical tier chain');
    assertEqual(r.effort, 'low', 'legacy resolver effort is expected default');
    cleanup(f);
  });

  runCase('frontmatter worker pins model family over routing (source=frontmatter)', () => {
    // Canonical semantics (skills/forge-auto/SKILL.md § "Engine decision by route_source"
    // + forge-routing.js Precedence 1a): a frontmatter `worker:` PINS a model and wins the
    // SOURCE label (frontmatter > routing), but the ENGINE is the pinned model's FAMILY —
    // engine = chain[0].engine — NOT a literal "codex". `codex` is a gpt-family model, so the
    // canonical engine here is `gpt`. The literal `engine == codex` only arises on the
    // tier_models legacy path via the prefs `workers:` block (covered by the case above).
    const f = mkFixture({
      prefs: 'routing:\n  backend:\n    executor:\n      standard: claude-opus-4-8\n',
      plan: '---\nworker: codex\ndomain: backend\n---\n# task\n',
    });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.route_source, 'frontmatter', 'frontmatter worker wins source over routing');
    assertEqual(r.engine, r.chain[0].engine, 'engine is the pinned model family (chain[0].engine)');
    assertEqual(r.engine, 'gpt', 'codex pin resolves to gpt family, not literal codex');
    assert(/frontmatter-worker|route:frontmatter/.test(r.engine_reason), 'frontmatter worker reason is coherent', r.engine_reason);
    cleanup(f);
  });

  runCase('unknown alias is safely omitted from applied model', () => {
    const f = mkFixture({ prefs: 'tier_models:\n  standard: gpt-5-codex\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.alias, null, 'unknown model alias is null');
    assertEqual(r.model_applied, null, 'unknown model has no applied alias');
    cleanup(f);
  });

  runCase('fable model enables adaptive thinking header', () => {
    const f = mkFixture({ prefs: 'tier_models:\n  standard: claude-fable-5\n' });
    const r = dispatch(f, { unitType: 'execute-task' });
    assertEqual(r.thinking_header, 'adaptive', 'fable thinking header adaptive');
    cleanup(f);
  });

  runCase('CLI matches in-process resolver and degrades on missing plan', () => {
    const f = mkFixture({});
    const expected = dispatch(f, { unitType: 'execute-task', planPath: path.join(f.dir, 'missing-PLAN.md') });
    const cli = spawnSync('node', [SCRIPT, '--json', '--unit-type', 'execute-task', '--plan', path.join(f.dir, 'missing-PLAN.md'), '--cwd', f.dir], { encoding: 'utf8', env: cliEnv });
    let parsed = null;
    try { parsed = JSON.parse(cli.stdout); } catch (error) { fail('CLI stdout is valid JSON', error.message); }
    assertEqual(cli.status, 0, 'CLI exits zero for missing plan');
    assert(parsed !== null, 'CLI emits a JSON contract', cli.stdout);
    if (parsed) {
      assertEqual(parsed.tier, expected.tier, 'CLI and library tier agree');
      assertEqual(parsed.model, expected.model, 'CLI and library model agree');
      assertEqual(parsed.effort, expected.effort, 'CLI and library effort agree');
      assertEqual(parsed.route_source, expected.route_source, 'CLI and library route source agree');
      assertEqual(Object.keys(parsed).slice(0, 11).join(','), 'engine,model,alias,tier,domain,route_source,chain,chain_len,reason,effort,effort_reason', 'CLI contract keys are ordered');
    }
    cleanup(f);
  });
});

process.stdout.write(`\nResults: ${passes} passed, ${fails} failed\n`);
process.exit(fails > 0 ? 1 : 0);
