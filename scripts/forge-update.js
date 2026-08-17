#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const maintenance = require('./forge-maintenance.js');
const installer = require('./forge-installer.js');
const { resolveForgeHome } = require('./forge-home.js');

const SOURCE_MANIFEST = 'forge-source-manifest.json';

function parseArgs(argv = process.argv.slice(2)) {
  // `repo` is deliberately NOT defaulted here. The default belongs to
  // resolveSourceRepo, which can tell a directory that merely holds this script
  // from one that can actually render projections — see the note there.
  const options = { apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runtime') options.runtime = argv[++i] || '';
    else if (arg === '--repo') options.repo = path.resolve(argv[++i] || '');
    else if (arg === '--forge-home') options.forgeHome = path.resolve(argv[++i] || '');
    else if (arg === '--claude-home') options.claudeHome = path.resolve(argv[++i] || '');
    else if (arg === '--codex-home') options.codexHome = path.resolve(argv[++i] || '');
    else if (arg === '--project-root') options.projectRoot = path.resolve(argv[++i] || '');
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-model-probe') options.noModelProbe = true;
    else if (arg === '--capability-timeout') options.capabilityTimeout = Number(argv[++i] || '');
    else if (arg === '--migrate-legacy') options.migrateLegacy = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`opção desconhecida: ${arg}`);
  }
  if (options.runtime) maintenance.selectedRuntimes(options.runtime);
  return options;
}

function readJsonIfPresent(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function hasSourceManifest(directory) {
  try { return Boolean(directory) && fs.existsSync(path.join(directory, SOURCE_MANIFEST)); } catch (_) { return false; }
}

/**
 * Where the projections are rendered FROM — which is never the Forge home.
 *
 * `scripts/` is managed core (forge-installer.js § MANAGED_CORE), so the
 * documented invocation `node scripts/forge-update.js --apply --json` is
 * routinely executed from the INSTALLED copy at `~/.forge-agent/scripts/`.
 * Resolving the repo as `__dirname/..` then points it at the Forge home, and
 * `forge-source-manifest.json` has never lived there — it is not managed core,
 * so no install ever copies it. The renderer died on a raw ENOENT naming a file
 * that should not exist at that path, and nothing in the message suggested
 * `--repo`: measured on a real 4.8.0 → 4.15.0 update, reproduced on both
 * versions, so the defect was at the tip of master and not a stale install.
 *
 * The durable answer is provenance: the install records which clone rendered
 * the installation, and the update reads it back. Order is the contract —
 * an explicit `--repo` never loses to a recorded value, and a recorded value is
 * only consulted when the entry point itself cannot render.
 */
function resolveSourceRepo(input = {}) {
  const candidates = [];
  if (input.repo) candidates.push({ path: path.resolve(input.repo), origin: 'flag', label: '--repo' });
  else {
    candidates.push({ path: path.resolve(input.entryRoot || path.join(__dirname, '..')), origin: 'entry', label: 'diretório deste script' });
    const forgeHome = resolveForgeHome(input);
    const manifest = readJsonIfPresent(path.join(forgeHome, 'manifest.json'));
    const recorded = manifest && typeof manifest.source_repo === 'string' ? manifest.source_repo.trim() : '';
    if (recorded) candidates.push({ path: path.resolve(recorded), origin: 'manifest', label: `manifest.json § source_repo (${forgeHome})` });
  }
  const considered = candidates.map((candidate) => ({ path: candidate.path, origin: candidate.origin, has_source_manifest: hasSourceManifest(candidate.path) }));
  const resolved = considered.find((candidate) => candidate.has_source_manifest);
  if (resolved) return { path: resolved.path, origin: resolved.origin, considered };
  // Name the flag. The operator following the documented command has no way to
  // deduce `--repo` from a path that should not have held the file anyway.
  throw new Error([
    `repo-fonte não encontrado: nenhum caminho avaliado contém ${SOURCE_MANIFEST}`,
    ...candidates.map((candidate) => `  - ${candidate.path} (${candidate.label})`),
    'informe `--repo <dir>` apontando para o clone do forge-agent',
  ].join('\n'));
}

function update(input = {}, dependencies = {}) {
  const sourceRepo = resolveSourceRepo(input);
  const plan = maintenance.planUpdate(input);
  const install = dependencies.install || installer.install;
  // A preview must stay side-effect free: the installer runs only to compute the
  // retire plan, so capability probing (which spawns `claude`/`codex --version`)
  // is suppressed here rather than left to a flag the CLI never sets.
  const preview = !input.apply;
  const installed = install({
    repo: sourceRepo.path,
    runtime: plan.runtime,
    update: true,
    forgeHome: input.forgeHome,
    userHome: input.userHome,
    claudeHome: input.claudeHome,
    codexHome: input.codexHome,
    projectRoot: input.projectRoot,
    platform: input.platform,
    env: input.env,
    env: input.env,
    userHome: input.userHome,
    platform: input.platform,
    binaries: input.binaries,
    capabilityTimeout: input.capabilityTimeout,
    noModelProbe: preview ? true : input.noModelProbe,
    skipCapabilityCheck: preview ? true : input.skipCapabilityCheck,
    migrateLegacy: input.migrateLegacy,
    dryRun: preview,
  });
  if (preview) return { ...plan, source_repo: sourceRepo, applied: false, installer: installed, retirements: installed.plan.filter((entry) => entry.op === 'retire' || (entry.op === 'skip' && entry.reason === 'already-retired')) };
  return { ...plan, source_repo: sourceRepo, applied: true, changed: installed.changed, backup: installed.backup, installer: installed };
}

function render(report) {
  const lines = [
    `Forge update ${report.applied ? 'applied' : 'plan'}`,
    `runtime: ${report.runtime}`,
    `installation: ${report.installation_source}`,
    // Named, not implied: an update that reinstalls whatever the clone happens
    // to hold must say WHICH clone it read, and how it found it.
    `source repo: ${report.source_repo ? `${report.source_repo.path} (${report.source_repo.origin})` : 'não resolvido'}`,
    `backup: ${report.backup_required ? 'required-before-write' : 'not-required'}`,
  ];
  if (report.legacy_migration) lines.push(`legacy migration: ${report.legacy_migration.release} (${report.legacy_migration.runtime})`);
  if (report.installer && report.installer.backup) lines.push(`backup created: ${report.installer.backup}`);
  for (const retirement of report.retirements || []) {
    const state = retirement.op === 'skip' ? 'skipped' : 'retire';
    lines.push(`${state}: ${retirement.source} -> ${retirement.destination}`);
  }
  const conflicts = report.installer && report.installer.manifest && report.installer.manifest.adapters
    ? Object.values(report.installer.manifest.adapters).reduce((total, adapter) => total + (Array.isArray(adapter.conflicts) ? adapter.conflicts.length : 0), 0)
    : 0;
  if (conflicts) lines.push(`conflicts preserved: ${conflicts}; use --migrate-legacy to replace unmarked legacy projections`);
  if (report.applied) lines.push(report.changed ? 'managed files updated' : 'no managed-file changes');
  else lines.push('no files written; pass --apply to update');
  return `${lines.join('\n')}\n`;
}

function run(argv = process.argv.slice(2), write = process.stdout.write.bind(process.stdout), errorWrite = process.stderr.write.bind(process.stderr)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      write('Usage: forge-update.js [--runtime claude|codex|both] [--apply|--dry-run] [--repo DIR] [--json] [--no-model-probe] [--capability-timeout MS] [--migrate-legacy]\n');
      return 0;
    }
    const report = update(options);
    write(options.json ? `${JSON.stringify(report, null, 2)}\n` : render(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    errorWrite(`forge-update: ${error.message}\n`);
    return 1;
  }
}

module.exports = { SOURCE_MANIFEST, parseArgs, resolveSourceRepo, update, render, run };
if (require.main === module) process.exitCode = run();
