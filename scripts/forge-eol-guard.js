#!/usr/bin/env node
'use strict';

/**
 * The permanent EOL regression guard.  Detection lives exclusively in
 * forge-eol-anchors; this module only applies the closed protected roster to
 * one census.  This matters because historical fixture text and the working
 * tree must be judged by precisely the same predicate.
 */

const fs = require('fs');
const path = require('path');
const anchors = require('./forge-eol-anchors');
const protectedRoster = require('./forge-eol-protected');

const DEFAULT_ROOT = 'scripts';
const REASONS = Object.freeze({
  NO_PROTECTED_SCOPE_RESOLVED: 'no-protected-scope-resolved',
  NO_CALL_SITES_SCANNED: 'no-call-sites-scanned',
  PROTECTED_FILE_MISSING: 'protected-file-not-present',
  PROTECTED_SCOPE_UNRESOLVED: 'protected-scope-unresolved',
});

function posix(value) {
  return String(value).split(path.sep).join('/');
}

function recordKey(cwd, file) {
  const value = String(file);
  return posix(path.isAbsolute(value) ? path.relative(cwd, value) : value);
}

function readScriptRecords(cwd, root) {
  const absoluteRoot = path.resolve(cwd, root || DEFAULT_ROOT);
  const collected = anchors._private.collectFiles(absoluteRoot);
  const records = [];
  for (const file of collected.files) {
    try {
      records.push({ path: recordKey(cwd, file), content: fs.readFileSync(file, 'utf8') });
    } catch {
      // The scanner records unreadable files when it sees disk paths.  Passing
      // this named empty boundary to it would silently change that contract,
      // so leave it absent and keep the complete-tree mode strict below.
    }
  }
  return records;
}

/**
 * Measure a roster scope from the single scan result.  Symbol attribution is
 * deliberately the scanner's own nearest-declaration field; file scopes own
 * every site in that file.  resolveScope still proves the named body exists.
 */
function measureScope(entry, content, sites) {
  const resolution = protectedRoster.resolveScope(content, entry);
  if (!resolution.ok) return { ok: false, reason: resolution.reason, entry };
  const owned = entry.kind === protectedRoster.SCOPE_KINDS.FILE
    ? sites
    : sites.filter((site) => site.symbol === entry.symbol);
  const exposed = owned.filter((site) => site.exposed === true).length;
  const tolerant = owned.filter((site) => site.exposed !== true).length;
  return {
    ok: true,
    entry,
    start: resolution.start,
    end: resolution.end,
    exposed,
    tolerant,
    call_sites: owned.length,
    exposed_limit: entry.baseline_exposed,
    tolerant_floor: entry.baseline_tolerant,
  };
}

function repairIdiom(form) {
  // Assemble examples at runtime.  They are instructions for a human, not
  // another specimen for the census to classify in this guard's own source.
  const cr = '\\r';
  const lf = '\\n';
  const tolerantBreak = `/${cr}?${lf}/`;
  const normalizer = `/${cr}${lf}?/g`;
  const blindNormalizer = `/${cr}${lf}/g`;
  if (form === 'B') {
    return `Forma B: use ${tolerantBreak} com captura de eol e reutilize eol na escrita.`;
  }
  return `Forma A: normalize na leitura com .replace(${normalizer}, '${lf}') (nunca ${blindNormalizer}).`;
}

/** A failure is a repair instruction, not merely a red counter. */
function formatFailure(failure) {
  const entry = failure.entry || failure;
  const target = `${entry.file}::${entry.symbol || '(file)'}`;
  if (failure.reason === REASONS.PROTECTED_FILE_MISSING) {
    return `${target} is protected but not present; restore the protected file. ${repairIdiom(entry.form)}`;
  }
  if (failure.reason === REASONS.PROTECTED_SCOPE_UNRESOLVED) {
    return `${target} cannot be resolved (${failure.detail || 'unknown'}); restore the protected declaration. ${repairIdiom(entry.form)}`;
  }
  const exposed = failure.exposed > entry.baseline_exposed
    ? `exposed ${failure.exposed} > baseline ${entry.baseline_exposed}`
    : `exposed ${failure.exposed} (baseline ${entry.baseline_exposed})`;
  const tolerant = failure.tolerant < entry.baseline_tolerant
    ? `tolerant ${failure.tolerant} < baseline ${entry.baseline_tolerant}`
    : `tolerant ${failure.tolerant} (baseline ${entry.baseline_tolerant})`;
  return `${target} [${entry.form}]: ${exposed}; ${tolerant}. ${repairIdiom(entry.form)}`;
}

function isProtectedSite(site, roster, resolvedEntries, cwd) {
  const siteFile = recordKey(cwd, site.file);
  return roster.some((entry) => {
    if (!resolvedEntries.has(scopeKey(entry)) || entry.file !== siteFile) return false;
    return entry.kind === protectedRoster.SCOPE_KINDS.FILE || site.symbol === entry.symbol;
  });
}

function scopeKey(entry) {
  return `${entry.file}::${entry.kind === protectedRoster.SCOPE_KINDS.FILE ? '(file)' : entry.symbol}`;
}

/**
 * Check source records or the scripts tree.  Advisory findings intentionally
 * do not affect ok: the initial census has hundreds of known, unprotected
 * exposures, and a noisy guard will soon be disabled instead of repaired.
 */
function checkEolGuard(options) {
  const opts = options || {};
  const cwd = path.resolve(opts.cwd || process.cwd());
  const roster = Array.isArray(opts.roster) ? opts.roster : protectedRoster.PROTECTED;
  const suppliedRecords = Array.isArray(opts.records);
  const records = suppliedRecords ? opts.records : readScriptRecords(cwd, opts.root);
  const scan = anchors.scanEolAnchors(records, { inMemory: true });
  const recordsByFile = new Map();
  for (const record of records) {
    if (record && typeof record.path === 'string' && typeof record.content === 'string') {
      recordsByFile.set(recordKey(cwd, record.path), record.content);
    }
  }
  const sitesByFile = new Map();
  for (const site of scan.call_sites || []) {
    const file = recordKey(cwd, site.file);
    if (!sitesByFile.has(file)) sitesByFile.set(file, []);
    sitesByFile.get(file).push(site);
  }

  const failures = [];
  const checked = [];
  const skipped = [];
  const resolvedEntries = new Set();
  const completeRecords = !suppliedRecords || opts.completeRecords === true;
  for (const entry of roster) {
    const content = recordsByFile.get(entry.file);
    if (content === undefined) {
      const missing = { entry, reason: REASONS.PROTECTED_FILE_MISSING };
      if (completeRecords) failures.push(missing); else skipped.push({ ...missing, status: 'skipped' });
      continue;
    }
    const measured = measureScope(entry, content, sitesByFile.get(entry.file) || []);
    if (!measured.ok) {
      failures.push({ entry, reason: REASONS.PROTECTED_SCOPE_UNRESOLVED, detail: measured.reason });
      continue;
    }
    resolvedEntries.add(scopeKey(entry));
    checked.push(measured);
    if (measured.exposed > entry.baseline_exposed || measured.tolerant < entry.baseline_tolerant) {
      failures.push({ ...measured, reason: 'baseline-violated' });
    }
  }

  const floor = protectedRoster.familyFloor(roster);
  const reasons = [];
  if (roster.length === 0 || resolvedEntries.size === 0) reasons.push(REASONS.NO_PROTECTED_SCOPE_RESOLVED);
  if (!floor.ok) reasons.push(floor.reason);
  if (scan.scanned === 0) reasons.push(REASONS.NO_CALL_SITES_SCANNED);
  const suspects = (scan.call_sites || []).filter((site) => site.exposed === true && !isProtectedSite(site, roster, resolvedEntries, cwd));
  const advisory = {
    scanned: scan.scanned || 0,
    call_sites: (scan.counts && scan.counts.call_sites) || 0,
    exposed: (scan.counts && scan.counts.exposed) || 0,
    suspects,
    ...(scan.outcome === 'scan-failed' ? { reason: scan.reason || 'advisory-census-failed' } : {}),
  };
  const enforcing = {
    checked: checked.length,
    failures: failures.map((failure) => ({
      file: failure.entry.file,
      symbol: failure.entry.symbol || null,
      form: failure.entry.form,
      exposed: failure.exposed === undefined ? null : failure.exposed,
      baseline_exposed: failure.entry.baseline_exposed,
      tolerant: failure.tolerant === undefined ? null : failure.tolerant,
      baseline_tolerant: failure.entry.baseline_tolerant,
      reason: failure.reason,
      message: formatFailure(failure),
    })),
    skipped,
    family_floor: floor,
  };
  const ok = failures.length === 0 && reasons.length === 0;
  const message = ok
    ? 'EOL guard passed: protected scopes stayed within their baselines.'
    : [...reasons, ...enforcing.failures.map((failure) => failure.message)].join('; ');
  return { ok, enforcing, advisory, message };
}

function parseArgs(argv) {
  let check = false;
  let json = false;
  for (const arg of argv) {
    if (arg === '--check') check = true;
    else if (arg === '--json') json = true;
    else return { error: `invalid flag: ${arg}` };
  }
  return check ? { check, json } : { error: 'missing required flag: --check' };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`Error: ${args.error}\n`);
    process.exitCode = 2;
    return;
  }
  const result = checkEolGuard();
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${result.message}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
  checkEolGuard,
  formatFailure,
  _private: { measureScope, repairIdiom, readScriptRecords, recordKey, isProtectedSite, parseArgs, REASONS },
};
