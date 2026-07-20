#!/usr/bin/env node
'use strict';

// forge-env-promote.js — deterministic, orchestrator-side partial→done gate (M016 S01).
// The allowlist is deliberately imported from forge-xllm.js: do not copy it into docs/mirrors.

const fs = require('fs');
const path = require('path');
const { MH_SCOPE_ENUM, ENV_REASON_ENUM } = require('./forge-xllm.js');

function textOf(entry) {
  return `${entry && entry.item || ''}\n${entry && entry.note || ''}`;
}

function normalizedPath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function citedTestPaths(value) {
  // Accept ordinary source/test paths, but demand a test-ish component or suffix.
  const candidates = value.match(/(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+/g) || [];
  return candidates.filter(candidate => /(?:\.test\.|\.spec\.|(?:^|\/)tests?(?:\/|$))/i.test(candidate));
}

function corroborates(entry, planText) {
  const evidence = textOf(entry);
  switch (entry.reason) {
    case 'gsd-write-refused':
      return /\.gsd\//.test(evidence)
        ? null
        : 'gsd-write-refused requires literal .gsd/ path evidence';
    case 'out-of-scope-test-failure': {
      const testPaths = citedTestPaths(evidence);
      if (!testPaths.length) return 'out-of-scope-test-failure requires a cited test path';
      const inPlan = testPaths.some(testPath => planText.includes(normalizedPath(testPath)));
      return inPlan ? 'cited test path appears in planText' : null;
    }
    case 'git-commit-required':
      return /\bgit\b|commit|push/i.test(evidence)
        ? null
        : 'git-commit-required requires git operation evidence';
    case 'network-required':
      return /network|install|fetch|clone|download|registry/i.test(evidence)
        ? null
        : 'network-required requires network operation evidence';
    default:
      return 'reason is not in the environment allowlist';
  }
}

/**
 * Check whether a partial worker result is exclusively blocked by corroborated
 * environment constraints. This function is pure and intentionally never
 * mutates the worker payload.
 *
 * @param {object} result parsed worker result
 * @param {string} planText full task-plan text
 * @returns {{promote:boolean, env_constraints:Array, rejected:Array, reason?:string}}
 */
function checkEnvPromotion(result, planText) {
  if (!result || result.status !== 'partial' || !Array.isArray(result.must_haves_status)) {
    return { promote: false, env_constraints: [], rejected: [], reason: 'not-applicable' };
  }

  const env_constraints = [];
  const rejected = [];
  const safePlanText = typeof planText === 'string' ? planText : '';

  for (const entry of result.must_haves_status) {
    if (!entry || entry.status === 'met') continue;
    const item = typeof entry.item === 'string' ? entry.item : '';
    if (entry.scope !== 'environment') {
      rejected.push({ item, why: 'scope must be environment' });
      continue;
    }
    if (!MH_SCOPE_ENUM.includes(entry.scope) || !ENV_REASON_ENUM.includes(entry.reason)) {
      rejected.push({ item, why: 'reason is not in the environment allowlist' });
      continue;
    }
    const why = corroborates(entry, safePlanText);
    if (why) {
      rejected.push({ item, why });
      continue;
    }
    env_constraints.push({ item, reason: entry.reason, note: typeof entry.note === 'string' ? entry.note : '' });
  }

  return {
    promote: env_constraints.length > 0 && rejected.length === 0,
    env_constraints,
    rejected,
  };
}

function usage() {
  return 'Usage: node scripts/forge-env-promote.js --result <file> --plan <file> [--json]\n';
}

function runCli(args) {
  let resultPath = null;
  let planPath = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--result' && args[i + 1]) resultPath = args[++i];
    else if (args[i] === '--plan' && args[i + 1]) planPath = args[++i];
    else if (args[i] === '--json') { /* accepted for mirror consistency */ }
    else if (args[i] === '--help') {
      process.stdout.write(usage());
      return 0;
    }
  }
  if (!resultPath || !planPath) {
    process.stderr.write(usage());
    return 2;
  }
  try {
    const result = JSON.parse(fs.readFileSync(path.resolve(resultPath), 'utf8'));
    const planText = fs.readFileSync(path.resolve(planPath), 'utf8');
    process.stdout.write(`${JSON.stringify(checkEnvPromotion(result, planText))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));

module.exports = { checkEnvPromotion };
