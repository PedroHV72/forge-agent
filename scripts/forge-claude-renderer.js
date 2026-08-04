#!/usr/bin/env node
'use strict';

// Pure Claude adapter renderer. The source manifest is the only inventory
// consulted here; Codex homes are intentionally not accepted or resolved.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveForgePaths } = require('./forge-home');
const sourceManifest = require('./forge-source-manifest');

const VERSION = '3.1.4';
const RUNTIME = 'claude';
const ORIGIN_PREFIX = '<!-- forge-source:';
const ORIGIN_SUFFIX = ' -->';
const REASON = Object.freeze({
  INVALID_OPTIONS: 'invalid_options',
  MISSING_SOURCE: 'missing_source',
  PROTECTED_PATH: 'protected_path',
  USER_OWNED: 'user_owned',
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exists(file) {
  try { return fs.existsSync(file); } catch (_) { return false; }
}

function normalizeNewlines(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function relativeParts(value) {
  return String(value).split(/[\\/]/).filter(Boolean);
}

function isProtectedPath(value) {
  return relativeParts(value).some((part) => part === '.gsd');
}

function isMarkdown(file) {
  return /\.(?:md|markdown)$/i.test(file);
}

function originHeader(sourceId, sourcePath) {
  return `${ORIGIN_PREFIX}${sourceId} source=${sourcePath} version=${VERSION}${ORIGIN_SUFFIX}`;
}

function addOriginHeader(content, source, sourcePath) {
  const normalized = normalizeNewlines(content);
  if (!isMarkdown(sourcePath)) return normalized;
  const marker = originHeader(source.source_id, sourcePath);
  if (normalized.startsWith(marker)) return normalized;
  if (normalized.startsWith(`${ORIGIN_PREFIX}`)) return `${marker}\n\n${stripOriginHeader(normalized)}`;
  return `${marker}\n\n${normalized}`;
}

function stripOriginHeader(content) {
  return String(content).replace(/^<!-- forge-source:[^\n]* -->\n(?:\n)?/, '');
}

function walk(root) {
  if (!exists(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function safeJoin(root, relative) {
  const clean = relativeParts(relative).join(path.sep);
  if (!clean || isProtectedPath(clean)) fail(REASON.PROTECTED_PATH, `destino protegido: ${relative}`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, clean);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    fail(REASON.INVALID_OPTIONS, `destino fora da raiz: ${relative}`);
  }
  return resolved;
}

function isWithin(root, target) {
  const base = path.resolve(root);
  const candidate = path.resolve(target);
  const relative = path.relative(base, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function backupRelative(root, destination) {
  const scopes = [
    ['project', root.projectRoot],
    ['claude', root.claudeHome],
    ['forge', root.forgeHome],
  ];
  for (const [name, base] of scopes) {
    if (isWithin(base, destination)) {
      const relative = path.relative(path.resolve(base), path.resolve(destination)).replace(/\\/g, '/');
      return `${name}/${relative || path.basename(destination)}`;
    }
  }
  // A caller may deliberately project into an external absolute directory.
  // Keep the backup inside backupDir without interpreting repo-relative `..`.
  const digest = Buffer.from(path.resolve(destination), 'utf8').toString('hex');
  return `external/${digest}${path.extname(destination)}`;
}

function roots(options) {
  const repo = path.resolve(options.repo || path.resolve(__dirname, '..'));
  const paths = resolveForgePaths({
    cwd: repo,
    forgeHome: options.forgeHome,
    claudeHome: options.claudeHome,
    env: options.env,
    userHome: options.userHome,
    platform: options.platform,
  });
  return {
    repo,
    forgeHome: paths.forgeHome,
    claudeHome: paths.runtimeHomes.claude,
    projectRoot: path.resolve(options.projectRoot || repo),
  };
}

function destinationRoot(target, root) {
  const parts = relativeParts(target);
  const scope = parts[0];
  if (scope === 'project' || scope === 'forge') return { root: scope === 'project' ? root.projectRoot : root.forgeHome, relative: parts.slice(1).join('/') };
  return { root: root.claudeHome, relative: parts.join('/') };
}

function inputFiles(repo, input) {
  const absolute = safeJoin(repo, input);
  if (!exists(absolute)) fail(REASON.MISSING_SOURCE, `fonte ausente: ${input}`);
  return walk(absolute);
}

function targetFor(source, input, file, target, repo) {
  const inputRoot = safeJoin(repo.repo, input);
  const targetRoot = destinationRoot(target.path, repo);
  if (fs.statSync(inputRoot).isFile()) return safeJoin(targetRoot.root, targetRoot.relative);
  const relative = path.relative(inputRoot, file).replace(/\\/g, '/');
  return safeJoin(targetRoot.root, targetRoot.relative ? `${targetRoot.relative}/${relative}` : relative);
}

function selected(source) {
  const state = source.conditional && source.conditional[RUNTIME];
  return !state || !state.status || !['unavailable', 'planned'].includes(state.status);
}

function readManifest(root, manifestFile) {
  const file = path.resolve(manifestFile || path.join(root.repo, 'forge-source-manifest.json'));
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  sourceManifest.audit(manifest);
  return manifest;
}

function render(options = {}) {
  const root = roots(options);
  const manifest = options.manifest || readManifest(root, options.manifestFile);
  sourceManifest.audit(manifest);
  const artifacts = [];
  for (const source of manifest.sources) {
    if (!selected(source)) continue;
    const targets = source.render_targets || [];
    source.inputs.forEach((input, index) => {
      const files = inputFiles(root.repo, input);
      const target = targets[index] || targets[0];
      if (!target) fail(REASON.INVALID_OPTIONS, `render target ausente: ${source.source_id}`);
      for (const file of files) {
        const relativeInput = path.relative(root.repo, file).replace(/\\/g, '/');
        const destination = targetFor(source, input, file, target, root);
        const content = addOriginHeader(fs.readFileSync(file, 'utf8'), source, relativeInput);
        artifacts.push({
          source_id: source.source_id,
          source: relativeInput,
          destination,
          relative: path.relative(root.repo, destination).replace(/\\/g, '/'),
          backup_relative: backupRelative(root, destination),
          content,
          bytes: Buffer.byteLength(content),
          newline: 'lf',
          origin: isMarkdown(relativeInput) ? originHeader(source.source_id, relativeInput) : null,
        });
      }
    });
  }
  artifacts.sort((a, b) => (a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0));
  return { runtime: RUNTIME, version: VERSION, repo: root.repo, forge_home: root.forgeHome, claude_home: root.claudeHome, project_root: root.projectRoot, artifacts };
}

function write(options = {}) {
  const report = render(options);
  const written = [];
  const preserved = [];
  const conflicts = [];
  const backupRoot = options.backupDir ? path.resolve(options.backupDir) : null;
  for (const artifact of report.artifacts) {
    const destination = artifact.destination;
    const current = exists(destination) ? fs.readFileSync(destination, 'utf8') : null;
    const generated = artifact.content;
    if (current !== null && current === generated) { preserved.push({ ...artifact, reason: 'already-current' }); continue; }
    if (current !== null && !String(current).startsWith(`${ORIGIN_PREFIX}`)) {
      preserved.push({ ...artifact, reason: REASON.USER_OWNED });
      conflicts.push({ destination, source_id: artifact.source_id, reason: REASON.USER_OWNED });
      continue;
    }
    if (options.dryRun) { written.push({ ...artifact, dry_run: true }); continue; }
    if (current !== null && backupRoot) {
      const backup = safeJoin(backupRoot, artifact.backup_relative);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, current, 'utf8');
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, generated, 'utf8');
    written.push(artifact);
  }
  return { ...report, changed: written.some((item) => !item.dry_run), written, preserved, conflicts, dry_run: Boolean(options.dryRun) };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { repo: path.resolve(__dirname, '..') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--manifest') out.manifestFile = argv[++i];
    else if (arg === '--claude-home') out.claudeHome = argv[++i];
    else if (arg === '--forge-home') out.forgeHome = argv[++i];
    else if (arg === '--project-root') out.projectRoot = argv[++i];
    else if (arg === '--backup-dir') out.backupDir = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--update') out.update = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else fail(REASON.INVALID_OPTIONS, `opção desconhecida: ${arg}`);
  }
  return out;
}

function main(argv = process.argv.slice(2), writeOutput = process.stdout.write.bind(process.stdout), errorOutput = process.stderr.write.bind(process.stderr)) {
  try {
    const options = parseArgs(argv);
    if (options.help) { writeOutput('Usage: forge-claude-renderer.js [--repo DIR] [--claude-home DIR] [--forge-home DIR] [--project-root DIR] [--dry-run] [--update] [--json]\n'); return 0; }
    const report = write(options);
    writeOutput(options.json ? `${JSON.stringify(report)}\n` : `Claude renderer ${VERSION}: ${report.written.length} written, ${report.preserved.length} preserved\n`);
    return 0;
  } catch (error) {
    errorOutput(`forge-claude-renderer: ${error.code || 'error'}: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { VERSION, RUNTIME, REASON, ORIGIN_PREFIX, normalizeNewlines, isProtectedPath, originHeader, addOriginHeader, stripOriginHeader, roots, render, write, parseArgs, main };
