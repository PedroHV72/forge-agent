#!/usr/bin/env node
/**
 * Deterministic cost gates for Forge.
 *
 * The policy intentionally decides WHETHER an LLM call is warranted; it never
 * asks another model to decide whether to ask a model.  Two hot-path policies
 * live here:
 *   - review: skip docs-only diffs, use one-pass flags for ordinary code, and
 *     reserve the full dialectic for explicit risk signals.
 *   - memory: extract only when a completed unit can add durable knowledge.
 *
 * Zero npm dependencies. CommonJS for the installed ~/.claude/scripts layout.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let prefsEngine = null;
try { prefsEngine = require('./forge-prefs.js'); } catch {}

const DOC_PATH_RE = /(^|\/)(docs?|examples?|changelog)(\/|$)|\.(?:md|mdx|txt|rst|adoc)$/i;
const TEST_PATH_RE = /(^|\/)(?:test|tests|__tests__|fixtures?)(\/|$)|\.(?:test|spec)\.[^.]+$/i;
const SENSITIVE_PATH_RE = /(^|\/)(?:auth|security|crypto|permissions?|payments?|billing|migrations?|infra|deploy|database|schema)(?:\/|[._-]|$)|(^|\/)\.github\/workflows(?:\/|$)/i;
const MEMORY_SIGNAL_RE = /\b(?:decision|decidiu|gotcha|pitfall|workaround|unexpected|surpresa|pattern|padr[aã]o|convention|conven[cç][aã]o|constraint|restri[cç][aã]o|root cause|causa raiz|reusable|reutiliz[aá]vel)\b/i;
const MAX_UNTRACKED_SCAN_BYTES = 8 * 1024 * 1024;

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseNumstat(text) {
  const entries = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const parts = raw.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]);
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
    const file = normalizePath(parts.slice(2).join('\t'));
    if (!file) continue;
    entries.push({
      file,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
      binary: parts[0] === '-' || parts[1] === '-',
    });
  }
  return entries;
}

function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function canonicalRoot(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // Keep the original path so the caller reports the actual VCS failure.
    return resolved;
  }
}

function collectDiff(cwd, base) {
  // Every containment comparison below must use the same canonical namespace as
  // `realpathSync` on untracked files. On macOS `/tmp` and `/var` commonly
  // traverse symlinks, so a lexical root would otherwise classify safe new files
  // as escaped and suppress their diff contribution.
  const root = canonicalRoot(cwd);
  const insideGit = run(root, 'git', ['rev-parse', '--is-inside-work-tree']);
  if (insideGit.ok) {
    // `git diff <base>` includes committed changes since base plus current
    // tracked working-tree changes. No shell/eval and no user-controlled flags.
    const safeBase = typeof base === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/@{}^~:-]*$/.test(base)
      ? base
      : 'HEAD';
    let diff = run(root, 'git', ['diff', '--numstat', safeBase, '--']);
    let warning = null;
    if (!diff.ok && safeBase !== 'HEAD') {
      warning = diff.stderr.trim() || `git-diff-failed:${safeBase}`;
      diff = run(root, 'git', ['diff', '--numstat', 'HEAD', '--']);
    }

    const entries = diff.ok ? parseNumstat(diff.stdout) : [];
    const seen = new Set(entries.map((entry) => entry.file));
    const untracked = run(root, 'git', ['ls-files', '--others', '--exclude-standard', '-z', '--']);
    if (untracked.ok) {
      for (const relative of untracked.stdout.split('\0').map(normalizePath).filter(Boolean)) {
        if (seen.has(relative)) continue;
        const absolute = path.resolve(root, relative);
        const escaped = path.relative(root, absolute);
        if (escaped === '..' || escaped.startsWith(`..${path.sep}`) || path.isAbsolute(escaped)) continue;
        try {
          const stat = fs.lstatSync(absolute);
          if (stat.isSymbolicLink()) {
            entries.push({ file: relative, added: 0, deleted: 0, binary: true });
            seen.add(relative);
            warning = warning || `untracked-symlink-not-read:${relative}`;
            continue;
          }
          if (!stat.isFile()) continue;
          const real = fs.realpathSync(absolute);
          const escapedReal = path.relative(root, real);
          if (escapedReal === '..' || escapedReal.startsWith(`..${path.sep}`) || path.isAbsolute(escapedReal)) {
            warning = warning || `untracked-realpath-escaped:${relative}`;
            entries.push({ file: relative, added: 0, deleted: 0, binary: true });
            seen.add(relative);
            continue;
          }
          if (stat.size > MAX_UNTRACKED_SCAN_BYTES) {
            // Do not read an arbitrarily large untracked file into the
            // orchestrator process. The conservative estimate plus binary flag
            // promotes the review to dialectic without exposing file content.
            entries.push({ file: relative, added: Math.ceil(stat.size / 80), deleted: 0, binary: true });
            seen.add(relative);
            warning = warning || `untracked-scan-capped:${relative}`;
            continue;
          }
          const data = fs.readFileSync(absolute);
          const binary = data.includes(0);
          const added = binary ? 0 : (data.length === 0 ? 0 : data.toString('utf8').split(/\r?\n/).length);
          entries.push({ file: relative, added, deleted: 0, binary });
          seen.add(relative);
        } catch {
          warning = warning || `untracked-stat-failed:${relative}`;
        }
      }
    } else {
      warning = warning || untracked.stderr.trim() || 'git-untracked-scan-failed';
    }
    const usable = diff.ok || (untracked.ok && entries.length > 0);
    return {
      vcs: 'git',
      base: safeBase,
      ok: usable,
      entries,
      warning: diff.ok ? warning : (diff.stderr.trim() || warning || 'git-diff-failed'),
    };
  }

  const insideSvn = run(root, 'svn', ['info']);
  if (insideSvn.ok) {
    const summary = run(root, 'svn', ['diff', '--summarize']);
    const entries = String(summary.stdout || '').split(/\r?\n/)
      .map((line) => normalizePath(line.replace(/^\s*[AMDRC!?~]\s+/, '').trim()))
      .filter(Boolean)
      .map((file) => ({ file, added: 0, deleted: 0, binary: false }));
    const seen = new Set(entries.map((entry) => entry.file));
    const status = run(root, 'svn', ['status']);
    if (status.ok) {
      for (const line of status.stdout.split(/\r?\n/)) {
        if (!/^\?\s+/.test(line)) continue;
        const file = normalizePath(line.replace(/^\?\s+/, '').trim());
        if (!file || seen.has(file)) continue;
        entries.push({ file, added: 0, deleted: 0, binary: true });
        seen.add(file);
      }
    }
    const ok = summary.ok && status.ok;
    const warning = !summary.ok ? 'svn-diff-failed' : (!status.ok ? 'svn-status-failed' : null);
    return { vcs: 'svn', base: null, ok, entries, warning };
  }

  return { vcs: 'none', base: null, ok: false, entries: [], warning: 'vcs-unavailable' };
}

function normalizeReviewConfig(review) {
  const cfg = review && typeof review === 'object' ? review : {};
  const mode = ['enabled', 'disabled'].includes(String(cfg.mode || '').toLowerCase())
    ? String(cfg.mode).toLowerCase()
    : 'enabled';
  const style = ['dialectic', 'flags'].includes(String(cfg.style || '').toLowerCase())
    ? String(cfg.style).toLowerCase()
    : 'dialectic';
  const trigger = ['always', 'adaptive'].includes(String(cfg.trigger || '').toLowerCase())
    ? String(cfg.trigger).toLowerCase()
    : 'adaptive';
  return {
    mode,
    style,
    trigger,
    flagsLines: positiveInt(cfg.adaptive_flags_lines, 40),
    dialecticLines: positiveInt(cfg.adaptive_dialectic_lines, 400),
    rounds: Number.isInteger(cfg.rounds) && cfg.rounds >= 0 && cfg.rounds <= 3 ? cfg.rounds : 1,
  };
}

function decideReview(input) {
  const config = normalizeReviewConfig(input && input.review);
  const entries = Array.isArray(input && input.entries) ? input.entries : [];
  const risk = String(input && input.risk || 'normal').toLowerCase();
  const securityPresent = Boolean(input && input.securityPresent);
  const verificationDrift = Boolean(input && input.verificationDrift);
  const changedLines = entries.reduce((sum, entry) => sum + Number(entry.added || 0) + Number(entry.deleted || 0), 0);
  const files = entries.map((entry) => normalizePath(entry.file)).filter(Boolean);
  const docsOnly = files.length > 0 && files.every((file) => DOC_PATH_RE.test(file));
  const testsOnly = files.length > 0 && files.every((file) => TEST_PATH_RE.test(file));
  const sensitiveFiles = files.filter((file) => SENSITIVE_PATH_RE.test(file));
  const binaryFiles = entries.filter((entry) => entry.binary).map((entry) => normalizePath(entry.file));
  const riskSignals = [];

  if (risk === 'high' || risk === 'critical') riskSignals.push(`risk:${risk}`);
  if (securityPresent) riskSignals.push('security-checklist');
  if (verificationDrift) riskSignals.push('verification-drift');
  if (sensitiveFiles.length > 0) riskSignals.push('sensitive-path');
  if (binaryFiles.length > 0) riskSignals.push('binary-or-unscanned-change');
  if (changedLines >= config.dialecticLines) riskSignals.push('large-diff');

  const fullCalls = 2 + config.rounds;
  let decision;
  let reason;

  if (config.mode === 'disabled') {
    decision = 'skip';
    reason = 'review-disabled';
  } else if (entries.length === 0) {
    decision = 'skip';
    reason = 'empty-diff';
  } else if (config.trigger === 'always') {
    decision = config.style;
    reason = 'configured-always';
  } else if (config.style === 'flags') {
    decision = 'flags';
    reason = 'configured-flags';
  } else if (riskSignals.length > 0) {
    decision = 'dialectic';
    reason = `adaptive-risk:${riskSignals.join(',')}`;
  } else if (docsOnly) {
    decision = 'skip';
    reason = 'adaptive-docs-only';
  } else {
    decision = 'flags';
    reason = testsOnly
      ? 'adaptive-tests-only'
      : (changedLines <= config.flagsLines ? 'adaptive-small-diff' : 'adaptive-normal-diff');
  }

  const estimatedCalls = decision === 'skip' ? 0 : (decision === 'flags' ? 1 : fullCalls);
  return {
    decision,
    reason,
    trigger: config.trigger,
    configured_style: config.style,
    changed_files: files.length,
    changed_lines: changedLines,
    docs_only: docsOnly,
    tests_only: testsOnly,
    sensitive_files: sensitiveFiles,
    binary_files: binaryFiles,
    risk_signals: riskSignals,
    estimated_calls: estimatedCalls,
    saved_calls_vs_dialectic: Math.max(0, fullCalls - estimatedCalls),
  };
}

function normalizeMemoryMode(memory) {
  const value = String(memory && memory.extraction || '').toLowerCase();
  return ['always', 'adaptive', 'disabled'].includes(value) ? value : 'adaptive';
}

function decideMemory(input) {
  const mode = normalizeMemoryMode(input && input.memory);
  const unitType = String(input && input.unitType || '').toLowerCase();
  const result = String(input && input.result || '');

  if (mode === 'disabled') return { decision: 'skip', reason: 'memory-disabled', mode };
  if (mode === 'always') return { decision: 'extract', reason: 'configured-always', mode };

  if (unitType === 'complete-slice' || unitType === 'complete-milestone') {
    return { decision: 'extract', reason: 'adaptive-boundary-summary', mode };
  }
  if (unitType === 'execute-task' && MEMORY_SIGNAL_RE.test(result)) {
    return { decision: 'extract', reason: 'adaptive-durable-signal', mode };
  }
  return { decision: 'skip', reason: `adaptive-artifact-owned:${unitType || 'unknown'}`, mode };
}

function failOpenOnDiffError(decision, review, diffOk) {
  if (diffOk || !decision || decision.reason !== 'empty-diff') return decision;
  const cfg = normalizeReviewConfig(review);
  const next = { ...decision };
  next.decision = cfg.trigger === 'always' ? cfg.style : 'flags';
  next.reason = 'diff-unavailable-fail-open';
  next.estimated_calls = next.decision === 'dialectic' ? 2 + cfg.rounds : 1;
  next.saved_calls_vs_dialectic = Math.max(0, 2 + cfg.rounds - next.estimated_calls);
  return next;
}

function readPrefs(cwd) {
  if (!prefsEngine || typeof prefsEngine.readPrefs !== 'function') return {};
  try {
    const resolved = prefsEngine.readPrefs(path.resolve(cwd || process.cwd()));
    return resolved && resolved.prefs || {};
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const out = { command: argv[0] || '', cwd: process.cwd(), base: null, risk: 'normal', securityPresent: false, verificationDrift: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') out.cwd = argv[++i];
    else if (arg === '--base') out.base = argv[++i];
    else if (arg === '--risk') out.risk = argv[++i];
    else if (arg === '--unit-type') out.unitType = argv[++i];
    else if (arg === '--security-present') out.securityPresent = true;
    else if (arg === '--verification-drift') out.verificationDrift = true;
    else if (arg === '--stdin') out.stdin = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    'Usage:',
    '  node forge-cost-policy.js review [--cwd <dir>] [--base <git-ref>] [--risk normal|high] [--security-present] [--verification-drift]',
    '  <result | node forge-cost-policy.js memory --unit-type <type> [--cwd <dir>] --stdin',
  ].join('\n');
}

function runCli(argv) {
  let args;
  try { args = parseArgs(argv); }
  catch (err) {
    process.stderr.write(`${err.message}\n${usage()}\n`);
    return 2;
  }
  if (args.help || !['review', 'memory'].includes(args.command)) {
    process.stdout.write(`${usage()}\n`);
    return args.help ? 0 : 2;
  }

  const prefs = readPrefs(args.cwd);
  if (args.command === 'review') {
    const diff = collectDiff(args.cwd, args.base);
    let decision = decideReview({
      review: prefs.review,
      entries: diff.entries,
      risk: args.risk,
      securityPresent: args.securityPresent,
      verificationDrift: args.verificationDrift,
    });
    // A broken diff probe must never masquerade as an empty diff and silently
    // suppress review. Adaptive mode fails open to one-pass flags; an explicit
    // always+dialectic configuration remains authoritative.
    decision = failOpenOnDiffError(decision, prefs.review, diff.ok);
    process.stdout.write(`${JSON.stringify({ ...decision, diff_source: diff.vcs, diff_warning: diff.warning })}\n`);
    return 0;
  }

  if (!args.unitType) {
    process.stderr.write('--unit-type is required for memory policy\n');
    return 2;
  }
  const result = args.stdin ? fs.readFileSync(0, 'utf8') : '';
  process.stdout.write(`${JSON.stringify(decideMemory({ memory: prefs.memory, unitType: args.unitType, result }))}\n`);
  return 0;
}

module.exports = {
  parseNumstat,
  collectDiff,
  normalizeReviewConfig,
  decideReview,
  decideMemory,
  failOpenOnDiffError,
  runCli,
};

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
