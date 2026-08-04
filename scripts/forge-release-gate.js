#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const generation = require('./forge-generate.js');
const offline = require('./forge-offline-ci.js');
const packaging = require('./forge-package.js');
const capabilities = require('./forge-capabilities.js');

const SCHEMA_VERSION = '1.0.0';
const ROOT = path.resolve(__dirname, '..');
const HOSTS = Object.freeze(['claude', 'codex']);
const PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);

function slash(value) { return String(value).replace(/\\/g, '/'); }
function walk(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...walk(full));
    else if (entry.isFile()) output.push(full);
  }
  return output;
}
function treeDigest(root) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');
  for (const file of walk(root)) {
    hash.update(slash(path.relative(root, file))); hash.update('\0'); hash.update(fs.readFileSync(file)); hash.update('\0');
  }
  return hash.digest('hex');
}
function git(repo, args, dependencies = {}) {
  const spawn = dependencies.spawnSync || spawnSync;
  const result = spawn('git', ['-c', `safe.directory=${repo}`, '-C', repo, ...args], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000 });
  if (result.status !== 0 || result.error) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error && result.error.message || '').trim()}`);
  return String(result.stdout || '').trim();
}
function status(repo, dependencies) { return git(repo, ['status', '--porcelain=v1', '--untracked-files=all'], dependencies).split(/\r?\n/).filter(Boolean).sort(); }

function regeneration(repo, platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `forge-release-regen-${platform}-Ω-`));
  try {
    const options = {
      repo, runtime: 'both', platform,
      projectRoot: path.join(root, 'project space Ω'),
      claudeHome: path.join(root, 'Claude Home Ω'),
      codexHome: path.join(root, 'Codex Home Ω'),
      forgeHome: path.join(root, 'Forge Home Ω'),
    };
    fs.mkdirSync(options.projectRoot, { recursive: true });
    const first = generation.generate(options);
    const digest = treeDigest(root);
    const second = generation.generate(options);
    const repeatDigest = treeDigest(root);
    const leftPackage = packaging.build({ repo, platform }).manifest.package_sha256;
    const rightPackage = packaging.build({ repo, platform }).manifest.package_sha256;
    return {
      platform, first_changed: first.changed, second_changed: second.changed,
      tree_sha256: digest, repeat_tree_sha256: repeatDigest,
      package_sha256: leftPackage, repeat_package_sha256: rightPackage,
      idempotent: first.changed === true && second.changed === false && digest === repeatDigest && leftPackage === rightPackage,
    };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function securityAudit(repo) {
  const plan = offline.buildPlan({ host: 'claude', platform: 'linux' });
  const scrubbed = offline.scrubEnvironment({ PATH: 'safe', OPENAI_API_KEY: 'SENTINEL', ANTHROPIC_AUTH_TOKEN: 'SENTINEL', AWS_ACCESS_KEY_ID: 'SENTINEL', PRIVATE_COOKIE: 'SENTINEL' });
  const manifest = packaging.build({ repo, platform: 'linux' }).manifest;
  const pathsSafe = manifest.files.every((entry) => !path.isAbsolute(entry.path) && !entry.path.split('/').includes('..') && !/[A-Za-z]:\//.test(entry.path));
  const providersAbsent = plan.every((entry) => entry.executable === process.execPath && entry.shell === false && entry.network === false);
  const secretsAbsent = !JSON.stringify(scrubbed).includes('SENTINEL');
  return {
    ok: pathsSafe && providersAbsent && secretsAbsent,
    relative_payload_paths: pathsSafe,
    node_argv_only: providersAbsent,
    provider_paid_required: false,
    secrets_forwarded: !secretsAbsent,
  };
}

function realCapabilitySmoke(repo, options = {}) {
  const detection = capabilities.detect(repo, {
    runtime: 'both',
    timeout: options.capabilityTimeout,
    binaries: options.binaries,
    env: options.env,
  });
  return {
    required: true,
    mode: 'manual-opt-in',
    executed: true,
    ok: detection.ok,
    selected: detection.selected,
    required_failures: detection.required_failures,
    probes: detection.probes,
  };
}

function summarizeOffline(report) {
  return {
    host: report.host, platform: report.platform, ok: report.ok,
    suites: report.results.map((item) => ({ name: item.suite, ok: item.ok, status: item.status, signal: item.signal })),
  };
}

function buildReport(options = {}, dependencies = {}) {
  const repo = path.resolve(options.repo || ROOT);
  const before = (dependencies.status || status)(repo, dependencies);
  const runOffline = dependencies.runOffline || ((input) => offline.run(input));
  const matrix = [];
  for (const platform of PLATFORMS) for (const host of HOSTS) {
    matrix.push(summarizeOffline(runOffline({ host, platform, env: options.env })));
  }
  const regenerate = dependencies.regeneration
    ? PLATFORMS.map((platform) => dependencies.regeneration(repo, platform))
    : PLATFORMS.map((platform) => regeneration(repo, platform));
  const security = dependencies.securityAudit ? dependencies.securityAudit(repo) : securityAudit(repo);
  const realCapability = options.realCapabilitySmoke
    ? (dependencies.realCapabilitySmoke || realCapabilitySmoke)(repo, options)
    : { required: false, mode: 'manual-opt-in', executed: false };
  const packageManifest = packaging.build({ repo, platform: 'linux' }).manifest;
  const after = (dependencies.status || status)(repo, dependencies);
  const tree = { clean_before: before.length === 0, clean_after: after.length === 0, stable: JSON.stringify(before) === JSON.stringify(after), before, after };
  const commit = dependencies.commit || git(repo, ['rev-parse', 'HEAD'], dependencies);
  const ok = matrix.every((cell) => cell.ok) && regenerate.every((item) => item.idempotent) && security.ok && (!realCapability.required || realCapability.ok) && tree.stable && (options.allowDirty || tree.clean_before);
  return {
    schema_version: SCHEMA_VERSION,
    release: { commit, product_version: packageManifest.product_version, package_sha256: packageManifest.package_sha256 },
    matrix, regeneration: regenerate, security, tree,
    real_provider_smoke: { required: false, mode: 'manual-opt-in', executed: false },
    real_capability_smoke: realCapability,
    ok,
  };
}

function inside(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function writeReport(file, report, repo = ROOT) {
  const target = path.resolve(file);
  if (inside(repo, target)) throw new Error('release report must be outside the repository to preserve a clean tree');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, target);
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { repo: ROOT, report: null, allowDirty: false, realCapabilitySmoke: false, json: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--repo') options.repo = path.resolve(argv[++index] || '');
    else if (argv[index] === '--report') options.report = path.resolve(argv[++index] || '');
    else if (argv[index] === '--allow-dirty') options.allowDirty = true;
    else if (argv[index] === '--real-capability-smoke') options.realCapabilitySmoke = true;
    else if (argv[index] === '--capability-timeout') options.capabilityTimeout = Number(argv[++index] || '');
    else if (argv[index] === '--json') options.json = true;
    else if (argv[index] === '--help' || argv[index] === '-h') options.help = true;
    else throw new Error(`unknown option: ${argv[index]}`);
  }
  return options;
}

function main(argv = process.argv.slice(2), output = process.stdout.write.bind(process.stdout), errorOutput = process.stderr.write.bind(process.stderr)) {
  try {
    const options = parseArgs(argv);
    if (options.help) { output('Usage: forge-release-gate.js [--repo DIR] [--report OUTSIDE_REPO.json] [--allow-dirty] [--real-capability-smoke] [--capability-timeout MS] [--json]\n'); return 0; }
    const report = buildReport(options);
    if (options.report) writeReport(options.report, report, options.repo);
    if (options.json) output(`${JSON.stringify(report)}\n`);
    else {
      for (const cell of report.matrix) output(`${cell.ok ? 'PASS' : 'FAIL'} ${cell.host}/${cell.platform} ${cell.suites.filter((item) => item.ok).length}/${cell.suites.length}\n`);
      output(`release gate: ${report.ok ? 'PASS' : 'FAIL'} ${report.release.commit} ${report.release.package_sha256}\n`);
    }
    return report.ok ? 0 : 1;
  } catch (error) { errorOutput(`forge-release-gate: ${error.message}\n`); return 1; }
}

if (require.main === module) process.exitCode = main();
module.exports = { HOSTS, PLATFORMS, SCHEMA_VERSION, buildReport, git, inside, main, parseArgs, realCapabilitySmoke, regeneration, securityAudit, status, summarizeOffline, treeDigest, writeReport };
