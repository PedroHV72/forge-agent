#!/usr/bin/env node
'use strict';

// Cross-platform Forge installer core. Shell wrappers only translate flags;
// every path, copy, backup and migration operation lives here so Bash and
// PowerShell have identical semantics.

const fs = require('fs');
const path = require('path');
const { resolveForgePaths } = require('./forge-home');

const RUNTIMES = Object.freeze(['claude', 'codex', 'both']);
const VERSION = '3.1.4';
const MANAGED_CORE = Object.freeze([
  'scripts', 'schemas', 'forge-capabilities.json', 'forge-prefs.schema.json',
]);

function parseArgs(argv = process.argv.slice(2)) {
  const result = { runtime: 'claude', update: false, dryRun: false, noModelProbe: false, withApp: false, repo: path.resolve(__dirname, '..') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runtime') result.runtime = argv[++i] || '';
    else if (arg === '--update') result.update = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--no-model-probe') result.noModelProbe = true;
    else if (arg === '--with-app') result.withApp = true;
    else if (arg === '--repo') result.repo = path.resolve(argv[++i] || '');
    else if (arg === '--forge-home') result.forgeHome = path.resolve(argv[++i] || '');
    else if (arg === '--claude-home') result.claudeHome = path.resolve(argv[++i] || '');
    else if (arg === '--codex-home') result.codexHome = path.resolve(argv[++i] || '');
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`opção desconhecida: ${arg}`);
  }
  if (!RUNTIMES.includes(result.runtime)) throw new Error(`runtime inválido: ${JSON.stringify(result.runtime)} (use claude, codex ou both)`);
  return result;
}

function exists(file) { try { return fs.existsSync(file); } catch (_) { return false; } }

function walk(root) {
  if (!exists(root)) return [];
  if (fs.statSync(root).isFile()) return [root];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function relativeFiles(root) { return walk(root).map((file) => path.relative(root, file)); }

function copyFile(source, destination, plan, options) {
  const record = { op: 'copy', source, destination };
  plan.push(record);
  if (options.dryRun) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyTree(sourceRoot, destinationRoot, plan, options) {
  for (const relative of relativeFiles(sourceRoot)) copyFile(path.join(sourceRoot, relative), path.join(destinationRoot, relative), plan, options);
}

function backupTree(sourceRoot, destinationRoot, plan, options) {
  for (const relative of relativeFiles(sourceRoot)) copyFile(path.join(sourceRoot, relative), path.join(destinationRoot, relative), plan, options);
}

function selectedRuntimes(runtime) { return runtime === 'both' ? ['claude', 'codex'] : [runtime]; }

function adapterSources(repo) {
  const agents = path.join(repo, 'agents');
  const commands = path.join(repo, 'commands');
  const skills = path.join(repo, 'skills');
  const dispatch = path.join(repo, 'shared', 'templates', 'dispatch');
  return {
    agents: relativeFiles(agents).filter((name) => /^forge.*\.md$/i.test(name)).map((name) => path.join(agents, name)),
    commands: relativeFiles(commands).filter((name) => /^forge.*\.md$/i.test(name)).map((name) => path.join(commands, name)),
    skills: relativeFiles(skills).filter((name) => /^forge-[^\\/]+[\\/]SKILL\.md$/i.test(name)).map((name) => path.join(skills, name)),
    dispatch: relativeFiles(dispatch).filter((name) => /\.md$/i.test(name)).map((name) => path.join(dispatch, name)),
  };
}

function writeText(file, text, plan, options) {
  plan.push({ op: 'write', destination: file, bytes: Buffer.byteLength(text) });
  if (options.dryRun) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function copyIfMissing(source, destination, plan, options) {
  if (exists(destination)) return false;
  copyFile(source, destination, plan, options);
  return true;
}

function backupExisting(paths, backupRoot, plan, options) {
  const files = [];
  for (const root of paths) {
    const rootIsFile = exists(root) && fs.statSync(root).isFile();
    for (const file of walk(root)) {
      const relative = rootIsFile ? path.basename(file) : path.relative(root, file);
      const destination = path.join(backupRoot, path.basename(root), relative);
      files.push({ file, destination });
      copyFile(file, destination, plan, options);
    }
  }
  return files;
}

function install(input = {}) {
  const options = { ...input };
  const runtime = options.runtime || 'claude';
  if (!RUNTIMES.includes(runtime)) throw new Error(`runtime inválido: ${JSON.stringify(runtime)} (use claude, codex ou both)`);
  const repo = path.resolve(options.repo || path.resolve(__dirname, '..'));
  const paths = resolveForgePaths({
    cwd: repo,
    forgeHome: options.forgeHome,
    claudeHome: options.claudeHome,
    codexHome: options.codexHome,
    env: options.env,
    userHome: options.userHome,
    platform: options.platform,
  });
  const plan = [];
  const selected = selectedRuntimes(runtime);
  const backupName = `backup-${VERSION}-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  const backupRoot = path.join(paths.forgeHome, 'backups', backupName);
  const coreFiles = [];
  for (const item of MANAGED_CORE) {
    const source = path.join(repo, item);
    if (exists(source)) coreFiles.push(item);
  }
  const coreAlready = exists(paths.forgeHome) && coreFiles.some((item) => exists(path.join(paths.forgeHome, item)));
  if (coreAlready && !options.update && !options.dryRun) {
    return { ok: true, changed: false, already_installed: true, runtime, forge_home: paths.forgeHome, selected, backup: null, plan: [{ op: 'skip', reason: 'already-installed', destination: paths.forgeHome }] };
  }
  if (options.update && coreAlready) {
    backupExisting(coreFiles.map((item) => path.join(paths.forgeHome, item)), backupRoot, plan, options);
    for (const host of selected) {
      const home = paths.runtimeHomes[host];
      for (const directory of ['agents', 'commands', 'skills', path.join('templates', 'dispatch')]) {
        backupExisting([path.join(home, directory)], path.join(backupRoot, 'adapters', host), plan, options);
      }
    }
  }

  // Shared core is copied exactly once into Forge home. Existing prefs are
  // deliberately outside this managed list and are never overwritten.
  for (const item of coreFiles) {
    const source = path.join(repo, item);
    const destination = path.join(paths.forgeHome, item);
    if (fs.statSync(source).isDirectory()) copyTree(source, destination, plan, options);
    else copyFile(source, destination, plan, options);
  }
  const versionFile = path.join(paths.forgeHome, 'VERSION');
  if (!exists(versionFile) || options.update) writeText(versionFile, `${VERSION}\n`, plan, options);
  const prefs = path.join(paths.forgeHome, 'forge-agent-prefs.jsonc');
  const legacyPrefs = path.join(paths.claudeHome, 'forge-agent-prefs.jsonc');
  // Claude legacy state is an input only when Claude is selected. Codex-only
  // must not even read the unselected Claude home.
  if (selected.includes('claude') && !exists(prefs) && exists(legacyPrefs)) copyFile(legacyPrefs, prefs, plan, options);
  if (!exists(prefs)) {
    const schema = JSON.parse(fs.readFileSync(path.join(repo, 'forge-prefs.schema.json'), 'utf8'));
    const { generateScaffold } = require('./forge-prefs-scaffold');
    copyIfMissing(path.join(repo, 'forge-prefs.schema.json'), path.join(paths.forgeHome, 'schemas', 'forge-prefs.schema.json'), plan, options);
    writeText(prefs, generateScaffold(schema, { schemaRef: 'schemas/forge-prefs.schema.json' }), plan, options);
  }

  // Migrate a legacy Claude global preference only as a read-preserving input.
  const source = adapterSources(repo);
  const adapterManifest = {};
  for (const host of selected) {
    const home = paths.runtimeHomes[host];
    const root = path.join(paths.adapters[host]);
    const entries = [];
    for (const file of source.agents) { const dest = path.join(home, 'agents', path.basename(file)); copyFile(file, dest, plan, options); entries.push(path.relative(home, dest).replace(/\\/g, '/')); }
    for (const file of source.commands) { const dest = path.join(home, 'commands', path.basename(file)); copyFile(file, dest, plan, options); entries.push(path.relative(home, dest).replace(/\\/g, '/')); }
    for (const file of source.skills) { const relative = path.relative(path.join(repo, 'skills'), file); const dest = path.join(home, 'skills', relative); copyFile(file, dest, plan, options); entries.push(path.relative(home, dest).replace(/\\/g, '/')); }
    for (const file of source.dispatch) { const dest = path.join(home, 'templates', 'dispatch', path.basename(file)); copyFile(file, dest, plan, options); entries.push(path.relative(home, dest).replace(/\\/g, '/')); }
    adapterManifest[host] = { home, files: entries.sort() };
    writeText(path.join(root, 'manifest.json'), JSON.stringify({ runtime: host, version: VERSION, files: entries.sort() }, null, 2) + '\n', plan, options);
  }
  const manifest = { version: VERSION, runtime, core: coreFiles.concat(['VERSION', 'forge-agent-prefs.jsonc']).sort(), adapters: adapterManifest };
  writeText(paths.shared.manifest, JSON.stringify(manifest, null, 2) + '\n', plan, options);
  return { ok: true, changed: plan.some((entry) => entry.op === 'copy' || entry.op === 'write'), dry_run: Boolean(options.dryRun), runtime, selected, forge_home: paths.forgeHome, runtime_homes: Object.fromEntries(selected.map((host) => [host, paths.runtimeHomes[host]])), backup: options.update && coreAlready ? backupRoot : null, plan, manifest };
}

function render(report) {
  const lines = [`Forge Agent Installer ${VERSION}`, `runtime: ${report.runtime}`, `Forge home: ${report.forge_home}`];
  if (report.already_installed) lines.push('Already installed; use --update to replace managed files.');
  if (report.dry_run) lines.push(`Dry-run: ${report.plan.length} operation(s), no files written.`);
  else lines.push(`${report.changed ? 'Installed' : 'No changes'}; ${report.plan.length} operation(s).`);
  if (report.backup) lines.push(`Backup: ${report.backup}`);
  return lines.join('\n') + '\n';
}

function run(argv = process.argv.slice(2), write = process.stdout.write.bind(process.stdout), errorWrite = process.stderr.write.bind(process.stderr)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { errorWrite(`forge-installer: ${error.message}\n`); return 2; }
  if (options.help) { write('Usage: install.{sh,ps1} --runtime claude|codex|both [--update] [--dry-run] [--no-model-probe]\n'); return 0; }
  try { const report = install(options); if (options.dryRun || report.ok) write(render(report)); return report.ok ? 0 : 1; }
  catch (error) { errorWrite(`forge-installer: ${error.message}\n`); return 1; }
}

module.exports = { RUNTIMES, VERSION, MANAGED_CORE, parseArgs, walk, adapterSources, install, render, run };
if (require.main === module) process.exitCode = run();
