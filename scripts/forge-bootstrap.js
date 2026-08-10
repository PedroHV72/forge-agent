#!/usr/bin/env node
'use strict';

// Runtime-neutral project bootstrap. It initializes the shared local state and
// resolves Forge home paths; adapter rendering remains an explicit S04 action.
const fs = require('fs');
const path = require('path');
const forgeHome = require('./forge-home');
const orchestrate = require('./forge-orchestrate');
const RUNTIMES = Object.freeze(['claude', 'codex', 'both']);

function selected(runtime) { return runtime === 'both' ? ['claude', 'codex'] : [runtime]; }
function fail(message) { const error = new Error(message); error.code = 'invalid-request'; throw error; }
function normalize(options = {}) {
  const runtime = options.runtime || options.hostRuntime || 'claude';
  if (!RUNTIMES.includes(runtime)) fail(`runtime inválido: ${runtime}`);
  const repo = path.resolve(options.repo || path.resolve(__dirname, '..'));
  const projectRoot = path.resolve(options.projectRoot || options.cwd || process.cwd());
  const paths = forgeHome.resolveForgePaths({ cwd: projectRoot, forgeHome: options.forgeHome, claudeHome: options.claudeHome, codexHome: options.codexHome, userHome: options.userHome, env: options.env, platform: options.platform });
  return { ...options, runtime, repo, projectRoot, paths };
}
function legacy(options) {
  if (!options.runtime || !selected(options.runtime).includes('claude')) return { present: false, read: false };
  const file = path.join(options.paths.runtimeHomes.claude, 'forge-agent-prefs.jsonc');
  if (!fs.existsSync(file)) return { present: false, read: true };
  return { present: true, read: true, path: file, bytes: fs.statSync(file).size };
}
function bootstrap(input = {}) {
  const options = normalize(input);
  const legacyPrefs = legacy(options);
  if (options.dryRun) return { runtime: options.runtime, selected: selected(options.runtime), project_root: options.projectRoot, forge_home: options.paths.forgeHome, runtime_homes: options.paths.runtimeHomes, legacy_prefs: legacyPrefs, dry_run: true, result: null };
  fs.mkdirSync(options.paths.forgeHome, { recursive: true });
  const result = orchestrate.init({ cwd: options.projectRoot, milestone: options.milestone, host_runtime: options.runtime === 'both' ? 'claude' : options.runtime, owner_token: options.ownerToken || 'forge-bootstrap', project: options.project, description: options.description });
  return { runtime: options.runtime, selected: selected(options.runtime), project_root: options.projectRoot, forge_home: options.paths.forgeHome, runtime_homes: options.paths.runtimeHomes, legacy_prefs: legacyPrefs, dry_run: false, result };
}
function parseArgs(argv = process.argv.slice(2)) {
  const out = {}; for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (arg === '--runtime') out.runtime = argv[++i]; else if (arg === '--milestone') out.milestone = argv[++i]; else if (arg === '--project-root') out.projectRoot = argv[++i]; else if (arg === '--forge-home') out.forgeHome = argv[++i]; else if (arg === '--claude-home') out.claudeHome = argv[++i]; else if (arg === '--codex-home') out.codexHome = argv[++i]; else if (arg === '--dry-run') out.dryRun = true; else if (arg === '--json') out.json = true; else if (arg === '--help' || arg === '-h') out.help = true; else fail(`opção desconhecida: ${arg}`); } return out;
}
function main(argv = process.argv.slice(2), output = process.stdout.write.bind(process.stdout), error = process.stderr.write.bind(process.stderr)) { try { const options = parseArgs(argv); if (options.help) { output('Usage: forge-bootstrap.js --milestone M### --runtime claude|codex|both [--project-root DIR] [--dry-run] [--json]\n'); return 0; } const report = bootstrap(options); output(options.json ? `${JSON.stringify(report)}\n` : `Forge bootstrap ${report.runtime}: ${report.project_root}\n`); return 0; } catch (e) { error(`forge-bootstrap: ${e.code || 'error'}: ${e.message}\n`); return 1; } }
if (require.main === module) process.exitCode = main();
module.exports = { RUNTIMES, selected, normalize, legacy, bootstrap, parseArgs, main };
