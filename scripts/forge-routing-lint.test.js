#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { lintRouting, formatText } = require('./forge-routing-lint');

const CLI = path.join(__dirname, 'forge-routing-lint.js');
let passed = 0;

function scenario(name, prefs, check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-routing-lint-'));
  const cwd = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const evaluate = (contents) => {
      const prefsPath = path.join(cwd, '.gsd', 'forge-prefs.jsonc');
      if (contents === null) fs.rmSync(prefsPath, { force: true });
      else fs.writeFileSync(prefsPath, contents);
      return {
        report: lintRouting(cwd),
        cli: spawnSync(process.execPath, [CLI, '--lint', '--json', '--cwd', cwd], {
          encoding: 'utf8',
          env: Object.assign({}, process.env, { HOME: home }),
        }),
      };
    };
    const result = evaluate(prefs);
    check(result.report, result.cli, evaluate);
    passed += 1;
    process.stdout.write('ok - ' + name + '\n');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function codes(items) {
  return items.map((item) => item.code);
}

scenario('bloco saudável', `{
  "routing": {
    "default": {
      "executor": {
        "standard": ["claude-sonnet-4-5", "claude-haiku-4-5"],
        "fallback": "claude-sonnet-4-5"
      }
    }
  }
}`, (report, cli) => {
  assert.strictEqual(report.errors.length, 0);
  assert.strictEqual(report.warnings.length, 0);
  assert.strictEqual(report.cells.length, 1);
  assert.strictEqual(cli.status, 0);
  assert.strictEqual(JSON.parse(cli.stdout).cells[0].chain[0].engine, 'claude');
});

scenario('membro não mapeado', `{
  "routing": { "default": { "executor": { "standard": ["mystery-model"] } } }
}`, (report, cli) => {
  assert.deepStrictEqual(codes(report.errors), ['unmapped-chain-member']);
  assert.strictEqual(report.errors[0].id, 'mystery-model');
  assert.strictEqual(cli.status, 1);
});

scenario('membro gpt é válido via sidecar', `{
  "routing": { "default": { "executor": { "standard": ["gpt-5.6-sol"] } } }
}`, (report, cli) => {
  assert.strictEqual(report.errors.length, 0);
  assert.strictEqual(report.cells[0].chain[0].engine, 'gpt');
  assert.strictEqual(report.cells[0].chain[0].mapped, false);
  assert.strictEqual(cli.status, 0);
});

scenario('fallback inválido', `{
  "routing": {
    "default": {
      "planner": { "heavy": ["claude-opus-4-8"], "fallback": "gpt-5.6-sol" }
    }
  }
}`, (report, cli) => {
  assert.deepStrictEqual(codes(report.errors), ['invalid-fallback']);
  assert.strictEqual(report.cells[0].fallback.engine, 'gpt');
  assert.strictEqual(cli.status, 1);
});

scenario('default ausente é warning', `{
  "routing": { "backend": { "executor": { "standard": ["claude-sonnet-4-5"] } } }
}`, (report, cli) => {
  assert.strictEqual(report.errors.length, 0);
  assert.deepStrictEqual(codes(report.warnings), ['missing-default-domain']);
  assert.strictEqual(cli.status, 0);
});

scenario('bloco ausente', '{ "tier_models": { "standard": "claude-sonnet-4-5" } }', (report, cli) => {
  assert.strictEqual(report.present, false);
  assert.strictEqual(report.errors.length, 0);
  assert.strictEqual(report.cells.length, 0);
  assert.strictEqual(cli.status, 0);
});

scenario('gemini gera warning de fase', `{
  "routing": { "default": { "executor": { "standard": ["agy/gemini-3.1-pro"] } } }
}`, (report, cli) => {
  assert.strictEqual(report.errors.length, 0);
  assert.deepStrictEqual(codes(report.warnings), ['phase-unsupported-family']);
  assert.strictEqual(report.cells[0].findings[0].severity, 'warning');
  assert.strictEqual(cli.status, 0);
});

// M015 jsonc-only cut: a legacy prefs.local.md with a malformed `routing:`
// block is no longer parsed by the normal consumer path (lintRouting/CLI) —
// that layer now hard-stops with `legacy-md-without-jsonc` before routing
// analysis even runs (see forge-prefs.js resolveLayer). The `routing-parse-
// error` code survives ONLY on the sanctioned migrator bridge
// (forge-prefs-migrate.js resolveCurrent), which still reads legacy md to
// compose the pre-migration snapshot. Assert against that sanctioned path
// instead of lintRouting/CLI.
{
  const { resolveCurrent } = require('./forge-prefs-migrate.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-routing-lint-migrate-'));
  const localDir = path.join(root, 'repo', '.gsd');
  const globalDir = path.join(root, 'home', '.claude');
  fs.mkdirSync(localDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, 'claude-agent-prefs.md'), `routing:
  default: invalid
`);
  try {
    const result = resolveCurrent(path.join(root, 'repo'), { globalDir, localDir });
    assert.strictEqual(
      result.errors.some((e) => /routing-parse-error/.test(e.message)),
      true,
      'migrator resolveCurrent still detects malformed legacy routing block',
    );
    assert.strictEqual(result.prefs.routing, undefined, 'malformed routing block dropped from merged snapshot');
    passed += 1;
    process.stdout.write('ok - erro de parse interrompe células (via forge-prefs-migrate sanctioned bridge)\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

scenario('fase só-com-fallback valida fallback e avisa sobre tiers', `{
  "routing": { "default": { "planner": { "fallback": "claude-sonnet-4-5" } } }
}`, (report, cli, evaluate) => {
  assert.strictEqual(report.cells.length, 0);
  assert.deepStrictEqual(codes(report.errors), []);
  assert.deepStrictEqual(codes(report.warnings), ['phase-without-tiers']);
  assert.strictEqual(report.warnings[0].phase, 'planner');
  assert.strictEqual(cli.status, 0);

  const invalid = evaluate(`{
  "routing": { "default": { "planner": { "fallback": "gpt-5.6-sol" } } }
}`);
  assert.strictEqual(invalid.report.cells.length, 0);
  assert.deepStrictEqual(codes(invalid.report.errors), ['invalid-fallback']);
  assert.deepStrictEqual(codes(invalid.report.warnings), ['phase-without-tiers']);
  assert.strictEqual(invalid.report.errors[0].domain, 'default');
  assert.strictEqual(invalid.report.errors[0].phase, 'planner');
  assert.strictEqual(invalid.report.errors[0].id, 'gpt-5.6-sol');
  assert.strictEqual(invalid.cli.status, 1);
});

// Regression: a chain entry written as ONE comma-joined string used to lint
// clean — substring matching mapped it to a real alias, so `mapped` was true
// and no finding fired. 22/22 cells reported "nenhum" on a config with 5 of
// these. The finding must name the actual mistake, not just "unmapped".
scenario('id composto na cadeia', `{
  "routing": {
    "default": {
      "planner": {
        "max": ["claude-fable-5, claude-opus-5"]
      }
    }
  }
}`, (report, cli) => {
  assert.deepStrictEqual(codes(report.errors), ['malformed-model-id']);
  assert.strictEqual(report.errors[0].id, 'claude-fable-5, claude-opus-5');
  assert.strictEqual(report.errors[0].tier, 'max');
  assert.strictEqual(cli.status, 1);
  assert.match(formatText(report), /ID composto/);
});

scenario('id composto no fallback', `{
  "routing": {
    "default": {
      "executor": {
        "standard": ["claude-sonnet-5"],
        "fallback": "claude-sonnet-5, claude-opus-5"
      }
    }
  }
}`, (report, cli) => {
  assert.deepStrictEqual(codes(report.errors), ['malformed-model-id']);
  assert.strictEqual(report.errors[0].id, 'claude-sonnet-5, claude-opus-5');
  assert.strictEqual(cli.status, 1);
});

// The correctly-split form of the same intent must stay clean, so the guard
// cannot be satisfied by simply rejecting every multi-model chain.
scenario('a forma correta da mesma intenção passa limpa', `{
  "routing": {
    "default": {
      "planner": {
        "max": ["claude-fable-5", "claude-opus-5"]
      }
    }
  }
}`, (report, cli) => {
  assert.strictEqual(report.errors.length, 0);
  assert.strictEqual(cli.status, 0);
});

const text = formatText({
  present: true,
  ok: true,
  errors: [],
  warnings: [],
  cells: [{
    domain: 'default', phase: 'executor', tier: 'standard',
    chain: [{ id: 'gpt-5', engine: 'gpt', alias: null, mapped: false }],
    fallback: null, findings: [],
  }],
});
assert.match(text, /domain: default/);
assert.match(text, /phase: executor/);
assert.match(text, /tier: standard/);
assert.match(text, /gpt-5 \(engine=gpt/);
assert.match(text, /fallback: \(ausente\)/);
assert.match(text, /Resumo: 0 erro\(s\), 0 warning\(s\)/);

process.stdout.write('1..' + passed + '\n');
