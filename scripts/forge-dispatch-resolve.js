#!/usr/bin/env node
/**
 * forge-dispatch-resolve.js
 *
 * Shared dispatch resolver.  It folds the canonical bash wiring into one pure
 * call while deliberately delegating routing, model aliases, prefs parsing,
 * and legacy tier chains to their owning modules.
 *
 * Contract JSON (default and --json) is one line.  The first eleven keys are
 * stable and ordered: engine, model, alias, tier, domain, route_source,
 * chain, chain_len, reason, effort, effort_reason.  The remaining fields are
 * additive dispatch sidecar data.  CLI flags: --unit-type, --plan, --unit-id,
 * --milestone, --roadmap, --cwd, --json, and --effort-<unit-type> <effort>.
 * Unexpected CLI failures degrade to a valid legacy-shaped contract and exit 0.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveRoute } = require('./forge-routing.js');
const { modelToAlias, modelFamily } = require('./forge-model-alias.js');
const { readPrefsCached } = require('./forge-prefs.js');
const { readTierChain } = require('./forge-tier-chain.js');

const TIER_DEFAULTS = {
  'memory-extract': 'light',
  'complete-slice': 'light',
  'complete-milestone': 'light',
  'research-milestone': 'standard',
  'research-slice': 'standard',
  'discuss-milestone': 'standard',
  'discuss-slice': 'standard',
  'execute-task': 'standard',
  'plan-milestone': 'max',
  'plan-slice': 'heavy',
};

const EFFORT_DEFAULTS = {
  'plan-milestone': 'medium',
  'plan-slice': 'medium',
  'discuss-milestone': 'medium',
  'discuss-slice': 'medium',
  'research-milestone': 'medium',
  'research-slice': 'medium',
  'execute-task': 'low',
  'complete-slice': 'low',
  'complete-milestone': 'low',
  'memory-extract': 'low',
};

const EFFORT_RANK = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function firstFrontmatter(raw) {
  const match = String(raw || '').match(/^---[\s\S]*?---/);
  return match ? match[0] : '';
}

function frontmatterValue(block, pattern) {
  const match = block.match(pattern);
  return match && match[1] ? match[1].trim() : '';
}

// The five requested fields use the same regex shapes as the bash snippet.
// `slice` is also read solely to reproduce its ROADMAP domain lookup fallback.
function readPlanFrontmatter(planPath) {
  const empty = { tier: '', tag: '', domain: '', effort: '', worker: '', slice: '' };
  if (!planPath) return empty;
  let block = '';
  try {
    block = firstFrontmatter(fs.readFileSync(planPath, 'utf8'));
  } catch {
    return empty;
  }
  if (!block) return empty;
  const worker = frontmatterValue(block, /^worker:[ \t]*(\S+)/m);
  return {
    tier: frontmatterValue(block, /^tier:\s*(.+)$/m),
    tag: frontmatterValue(block, /^tag:\s*(.+)$/m),
    domain: frontmatterValue(block, /^domain:[ \t]*(.+)$/m),
    effort: frontmatterValue(block, /^effort:\s*(.+)$/m),
    worker: worker === 'claude' || worker === 'codex' ? worker : '',
    slice: frontmatterValue(block, /^slice:\s*(.+)$/m),
  };
}

function defaultRoadmapPath(milestoneId, cwd) {
  const id = text(milestoneId);
  return id ? path.join(cwd, '.gsd', 'milestones', id, `${id}-ROADMAP.md`) : null;
}

function roadmapDomain(roadmapPath, key) {
  if (!roadmapPath || !key) return '';
  try {
    const line = fs.readFileSync(roadmapPath, 'utf8').split(/\r?\n/).find((item) =>
      new RegExp(`\\b${key}\\b`).test(item) && /domain:[A-Za-z0-9_-]+/.test(item));
    const match = line && line.match(/domain:([A-Za-z0-9_-]+)/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function hasHighRisk(roadmapPath, unitId) {
  if (!roadmapPath || !unitId) return false;
  try {
    return new RegExp(`${unitId}.*risk:\\s*high`).test(fs.readFileSync(roadmapPath, 'utf8'));
  } catch {
    return false;
  }
}

function normalizeWorkers(prefs, unitType) {
  const workers = prefs && prefs.workers && typeof prefs.workers === 'object' ? prefs.workers : {};
  const requested = text(workers[unitType]);
  const workersEngine = requested === 'codex' || requested === 'claude' ? requested : 'claude';
  const timeout = Number(workers.timeout);
  return {
    workers_engine: workersEngine,
    workers_timeout: Number.isInteger(timeout) && timeout > 0 ? timeout : 1800,
    codex_model: typeof workers.codex_model === 'string' ? workers.codex_model : '',
  };
}

function resolveDispatch(opts) {
  const o = opts || {};
  const unitType = text(o.unitType);
  const cwd = o.cwd || process.cwd();
  const plan = unitType === 'execute-task' ? readPlanFrontmatter(o.planPath) : readPlanFrontmatter(null);
  const roadmapPath = o.roadmapPath || defaultRoadmapPath(o.milestoneId, cwd);

  let tier = TIER_DEFAULTS[unitType] || 'standard';
  let reason = `unit-type:${unitType}`;
  if (unitType === 'execute-task' && plan.tier) {
    tier = plan.tier;
    reason = `frontmatter-override:${plan.tier}`;
  } else if (unitType === 'execute-task' && plan.tag === 'docs') {
    tier = 'light';
    reason = 'frontmatter-tag:docs';
  }
  if (unitType === 'plan-slice' && hasHighRisk(roadmapPath, o.unitId)) {
    tier = 'max';
    reason = 'risk-escalation:high';
  }

  const domainKey = unitType === 'execute-task' ? plan.slice : o.unitId;
  const requestedDomain = (unitType === 'execute-task' && plan.domain) ||
    roadmapDomain(roadmapPath, domainKey) || 'default';
  const route = resolveRoute({
    unitType,
    tier,
    domain: requestedDomain,
    frontmatterTier: plan.tier || null,
    frontmatterWorker: plan.worker || null,
    cwd,
  });
  const chain = Array.isArray(route.chain) ? route.chain : [];
  const model = chain[0] && chain[0].id ? chain[0].id : '';
  const prefsResult = readPrefsCached(cwd);
  const prefs = prefsResult && prefsResult.prefs ? prefsResult.prefs : {};
  const workers = normalizeWorkers(prefs, unitType);

  let engine;
  let engineReason;
  if (route.source === 'routing' || route.source === 'frontmatter') {
    engine = chain[0] && chain[0].engine ? chain[0].engine : 'claude';
    engineReason = `route:${route.source}:${engine}`;
  } else if (plan.worker) {
    engine = plan.worker;
    engineReason = `frontmatter-worker:${plan.worker}`;
  } else if (workers.workers_engine !== 'claude') {
    engine = workers.workers_engine;
    engineReason = `workers.${unitType}:${engine}`;
  } else {
    engine = 'claude';
    engineReason = 'default:claude';
  }

  const effortMap = o.effortMap && typeof o.effortMap === 'object' ? o.effortMap : (prefs.effort || {});
  let effort = effortMap[unitType] !== undefined ? effortMap[unitType] : (EFFORT_DEFAULTS[unitType] || 'low');
  let effortReason = `unit-type:${unitType}`;
  if (unitType === 'execute-task' && plan.effort) {
    effort = plan.effort;
    effortReason = `frontmatter-effort:${plan.effort}`;
  }
  if (unitType === 'plan-slice' && reason === 'risk-escalation:high') {
    effort = 'max';
    effortReason = 'risk-escalation:high';
  }
  effort = text(effort);
  if (!Object.prototype.hasOwnProperty.call(EFFORT_RANK, effort)) effort = 'medium';
  const cap = /^claude-(haiku|sonnet)/.test(model) ? 'medium' : 'max';
  if (EFFORT_RANK[effort] > EFFORT_RANK[cap]) {
    effort = cap;
    effortReason += '|clamped:model-cap';
  }

  const alias = modelToAlias(model).alias;
  // modelFamily is the canonical family classifier; its invocation here keeps
  // this orchestration layer aligned with alias/routing model semantics.
  const family = modelFamily(model);
  if (family === null && route.source === 'routing' && !chain[0]) engine = 'claude';
  return {
    engine,
    model,
    alias,
    tier,
    domain: route.domain_used || 'default',
    route_source: route.source || 'tier_models',
    chain,
    chain_len: chain.length,
    reason,
    effort,
    effort_reason: effortReason,
    model_applied: alias,
    engine_reason: engineReason,
    workers_engine: workers.workers_engine,
    workers_timeout: workers.workers_timeout,
    codex_model: workers.codex_model,
    plan_worker: plan.worker,
    thinking_header: model.startsWith('claude-fable-5') ? 'adaptive' : '',
  };
}

function parseArgs(args) {
  const parsed = { unitType: '', planPath: null, unitId: '', milestoneId: '', roadmapPath: null, cwd: process.cwd(), asJson: false, effortMap: {} };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--unit-type' && value !== undefined) { parsed.unitType = value; i += 1; }
    else if (flag === '--plan' && value !== undefined) { parsed.planPath = value; i += 1; }
    else if (flag === '--unit-id' && value !== undefined) { parsed.unitId = value; i += 1; }
    else if (flag === '--milestone' && value !== undefined) { parsed.milestoneId = value; i += 1; }
    else if (flag === '--roadmap' && value !== undefined) { parsed.roadmapPath = value; i += 1; }
    else if (flag === '--cwd' && value !== undefined) { parsed.cwd = value; i += 1; }
    else if (flag === '--json') parsed.asJson = true;
    else if (flag.startsWith('--effort-') && value !== undefined) { parsed.effortMap[flag.slice('--effort-'.length)] = value; i += 1; }
  }
  return parsed;
}

function runCli(args) {
  const parsed = parseArgs(args || []);
  const result = resolveDispatch(parsed);
  process.stdout.write(JSON.stringify(result) + '\n');
  return result;
}

function degradedContract(args) {
  const parsed = parseArgs(args || []);
  const unitType = parsed.unitType;
  const cwd = parsed.cwd || process.cwd();
  const tier = TIER_DEFAULTS[unitType] || 'standard';
  let chain = [];
  try {
    chain = readTierChain(tier, cwd).map((member) => ({
      id: member.id, alias: member.alias, mapped: member.mapped, engine: modelFamily(member.id),
    }));
  } catch { /* minimal ordered contract below */ }
  const model = chain[0] ? chain[0].id : '';
  const alias = modelToAlias(model).alias;
  return {
    engine: 'claude', model, alias, tier, domain: 'default', route_source: 'tier_models',
    chain, chain_len: chain.length, reason: 'routing-runtime-error; tier_models',
    effort: 'low', effort_reason: `unit-type:${unitType}`,
    model_applied: alias, engine_reason: 'default:claude', workers_engine: 'claude',
    workers_timeout: 1800, codex_model: '', plan_worker: '',
    thinking_header: model.startsWith('claude-fable-5') ? 'adaptive' : '',
  };
}

module.exports = { resolveDispatch, parseArgs, runCli };

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch {
    process.stdout.write(JSON.stringify(degradedContract(process.argv.slice(2))) + '\n');
  }
  process.exit(0);
}
