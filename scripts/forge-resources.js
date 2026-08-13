#!/usr/bin/env node
/**
 * forge-resources.js
 *
 * Single owner (D10) of the question "do I admit the NEXT command right now,
 * and with what sizing?" — a formula-once pure resolver in the same shape as
 * forge-dispatch-resolve.js: `resolveResourceBudget(opts)` is a pure function
 * returning a one-line, stable-key JSON contract; `readPressureSignal(opts)`
 * is the darwin probe (batched, cached); `REASON_CODES` is a frozen enum
 * naming every degradation path (D8); the CLI wrapper degrades to a safe
 * default and exits 0 on ANY internal failure, mirroring the dispatch
 * resolver's `degradedContract` convention.
 *
 * Contract JSON keys are stable and ordered:
 *   admit, workers, heapMb, playwrightWorkers, reason, pressureLevel,
 *   enforcement, shadowWait, source
 * Additional keys may be appended later without breaking existing readers —
 * this block is the stable prefix, the rest of the object is additive.
 *
 * D5 (hard boundary): this module NEVER suspends or kills a running process.
 * It only answers whether the NEXT command should be admitted.
 *
 * D1 (non-revisable): the admission signal is
 * `kern.memorystatus_vm_pressure_level` + `vm.swapusage`, read via a single
 * batched `sysctl -n` spawnSync call (measured: 36.7ms batched vs 120.3ms
 * across three separate spawnSync calls, 20 samples). The Node `os` module's
 * free-memory reading is FORBIDDEN as an admission signal anywhere in this
 * file — it under-reports pressure (measured: ~1.5GB "free" while
 * vm.swapusage showed 4076/5120MB swap used). `os.totalmem()` is used ONLY
 * as a capacity fallback on a
 * degraded (non-darwin, or sysctl-failed) platform, never as a pressure
 * signal — capacity is not admission.
 *
 * B1 (risk card, mandatory injection seams): `opts.readSignal` (replaces the
 * darwin probe entirely), `opts.now` (clock), `opts.platform` (defaults to
 * `process.platform`), and the `FORGE_RESOURCES_PRESSURE` env override
 * (`1|2|4`, read via `opts.env` for testability, default `process.env`).
 * Without these seams the "admit:false under pressure" must-have would be
 * unverifiable without actually pressurizing the machine running the test —
 * these seams are a requirement, not a convenience.
 *
 * D7 (no per-runner weight table, explicitly deferred): sizing produces a
 * single worker count N plus ONE dedicated Playwright cap. There is no
 * per-runner-type weight table anywhere in this file — that shape was
 * explicitly rejected by the milestone CONTEXT.
 *
 * D2/D3: `admit` is the verdict of the formula alone (false under critical
 * pressure), never adjusted by the `enforcement` posture — `enforcement` is
 * reported separately so the CALLER decides whether to actually refuse
 * (advisory in v1: the posture is reported, not baked into the verdict).
 * Shadow-wait (D3) computes "would have waited Xs" under critical pressure
 * with `shadow_wait` on, WITHOUT ever calling a real sleep — always
 * computed from the injectable clock and the `wait_cap_ms` pref.
 *
 * Seam for S02 (documented, no dead code): the cross-run pool blueprint is
 * `scripts/forge-unit-lease.js` (TTL+grace+quarantine, ABA-safe) — S02 will
 * pass pool state in as an ADDITIVE `opts.pool` field. This contract's keys
 * are stable-ordered with additive fields permitted; nothing here assumes
 * `opts.pool` exists yet, and nothing here reimplements locking/leasing.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readPrefsCached } = require('./forge-prefs.js');

// ── Frozen reason enum (D8) — every degradation path returns a member of ──
// this object. A code path that returns a reason NOT in this enum is a bug.
const REASON_CODES = Object.freeze({
  PRESSURE_NORMAL: 'pressure-normal',
  PRESSURE_WARN: 'pressure-warn',
  PRESSURE_CRITICAL_MEASURED: 'pressure-critical:measured',
  PRESSURE_CRITICAL_FORCED: 'pressure-critical:forced-env',
  PLATFORM_UNSUPPORTED_LINUX: 'platform-unsupported:linux',
  PLATFORM_UNSUPPORTED_WIN32: 'platform-unsupported:win32',
  PLATFORM_UNSUPPORTED_OTHER: 'platform-unsupported:other',
  SYSCTL_SPAWN_FAILED: 'sysctl-spawn-failed',
  SYSCTL_PARSE_FAILED: 'sysctl-parse-failed',
  SHADOW_WAIT: 'shadow-wait',
  INTERNAL_ERROR_DEGRADED: 'internal-error-degraded',
});

const SYSCTL_KEYS = [
  'kern.memorystatus_vm_pressure_level',
  'kern.memorystatus_level',
  'vm.swapusage',
  'hw.ncpu',
  'hw.memsize',
];

const DEFAULT_CACHE_TTL_MS = 2000;

// module-level cache: cacheKey -> { signal, ts }. Wraps readPressureSignal
// (or an injected opts.readSignal) so a resolve inside the TTL window never
// re-invokes the probe — the mechanism the "single spawn + TTL cache"
// must-have is asserted against (counted via an injected reader, never via
// wall-clock sleep).
const SIGNAL_CACHE = new Map();

// Exported for test isolation — clears the module-level cache between cases.
function resetResourceCache() {
  SIGNAL_CACHE.clear();
}

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

// Maps an unsupported platform string to its frozen enum member. Unknown
// platforms fall back to the generic "other" member rather than minting an
// ad-hoc string — the enum stays closed.
function platformUnsupportedReason(platform) {
  if (platform === 'linux') return REASON_CODES.PLATFORM_UNSUPPORTED_LINUX;
  if (platform === 'win32') return REASON_CODES.PLATFORM_UNSUPPORTED_WIN32;
  return REASON_CODES.PLATFORM_UNSUPPORTED_OTHER;
}

// Reads the FORGE_RESOURCES_PRESSURE override. Valid values are 1|2|4
// (mirroring the kern.memorystatus_vm_pressure_level enum). Returns null
// when unset or invalid — invalid values are treated as "no override",
// never silently clamped to a nearby valid level.
function readEnvOverride(opts) {
  const env = (opts && opts.env) || process.env;
  const raw = text(env.FORGE_RESOURCES_PRESSURE);
  if (raw === '1' || raw === '2' || raw === '4') return Number(raw);
  return null;
}

// ── Darwin probe (single batched spawnSync call) ──────────────────────────
// Parses `sysctl -n <5 keys>` multi-line output into a snapshot. Never
// throws — spawn or parse failure returns { ok:false, reason }.
function readPressureSignal(opts) {
  const o = opts || {};
  const spawn = typeof o.spawn === 'function' ? o.spawn : spawnSync;
  let res;
  try {
    res = spawn('sysctl', ['-n', ...SYSCTL_KEYS], { encoding: 'utf8' });
  } catch {
    return { ok: false, reason: REASON_CODES.SYSCTL_SPAWN_FAILED };
  }
  if (!res || res.error || typeof res.status !== 'number' || res.status !== 0 || typeof res.stdout !== 'string') {
    return { ok: false, reason: REASON_CODES.SYSCTL_SPAWN_FAILED };
  }
  const lines = res.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 5) {
    return { ok: false, reason: REASON_CODES.SYSCTL_PARSE_FAILED };
  }
  const pressureLevel = parseInt(lines[0], 10);
  const memstatusLevel = parseInt(lines[1], 10);
  const swapLine = lines[2];
  const ncpu = parseInt(lines[3], 10);
  const memBytes = parseInt(lines[4], 10);
  const swapMatch = swapLine.match(/total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M\s+free\s*=\s*([\d.]+)M/);
  if (!Number.isFinite(pressureLevel) || !Number.isFinite(ncpu) || !Number.isFinite(memBytes) || !swapMatch) {
    return { ok: false, reason: REASON_CODES.SYSCTL_PARSE_FAILED };
  }
  return {
    ok: true,
    pressureLevel: [1, 2, 4].includes(pressureLevel) ? pressureLevel : 1,
    memstatusLevel: Number.isFinite(memstatusLevel) ? memstatusLevel : null,
    ncpu: ncpu > 0 ? ncpu : os.cpus().length || 1,
    memBytes: memBytes > 0 ? memBytes : os.totalmem(),
    swap: {
      totalM: Number(swapMatch[1]),
      usedM: Number(swapMatch[2]),
      freeM: Number(swapMatch[3]),
    },
  };
}

// Cache wrapper around readPressureSignal / opts.readSignal, keyed on
// opts.cacheKey (defaults to cwd) and TTL'd against the injectable clock.
function getCachedSignal(opts, now, cwd) {
  const reader = typeof (opts && opts.readSignal) === 'function' ? opts.readSignal : readPressureSignal;
  const ttl = Number.isInteger(opts && opts.cacheTtlMs) && opts.cacheTtlMs > 0 ? opts.cacheTtlMs : DEFAULT_CACHE_TTL_MS;
  const key = (opts && opts.cacheKey) || cwd || 'default';
  const entry = SIGNAL_CACHE.get(key);
  const nowMs = now();
  if (entry && (nowMs - entry.ts) < ttl) {
    return entry.signal;
  }
  const signal = reader(opts);
  SIGNAL_CACHE.set(key, { signal, ts: nowMs });
  return signal;
}

// Fail-open reader for the `resources:` pref namespace — same shape as
// readFileLocksEnabled/readEvidenceMode in forge-hook.js:188-207. Any
// failure to read prefs falls back to these documented defaults; T02 wires
// the schema and cites these defaults as the source of truth.
function readResourcePrefs(opts, cwd) {
  const defaults = { enforcement: 'clamp', shadow_wait: true, wait_cap_ms: 30000 };
  try {
    const prefsResult = (opts && opts.prefsResult) || readPrefsCached(cwd);
    const resources = (prefsResult && prefsResult.prefs && prefsResult.prefs.resources) || {};
    return {
      enforcement: typeof resources.enforcement === 'string' ? resources.enforcement : defaults.enforcement,
      shadow_wait: resources.shadow_wait === undefined ? defaults.shadow_wait : resources.shadow_wait === true,
      wait_cap_ms: Number.isInteger(resources.wait_cap_ms) && resources.wait_cap_ms > 0 ? resources.wait_cap_ms : defaults.wait_cap_ms,
    };
  } catch {
    return defaults;
  }
}

// Builds a forced snapshot from the FORGE_RESOURCES_PRESSURE override. A
// forced value is NEVER confusable with a measured reading — it carries its
// own dedicated reason (only the critical level has a distinct forced enum
// member today; normal/warn share the measured-style names because no
// must-have currently distinguishes them, though `source: 'forced-env'` on
// the outer contract already marks every forced call unambiguously).
function forcedSignal(level) {
  return {
    ok: true,
    pressureLevel: level,
    memstatusLevel: null,
    ncpu: os.cpus().length || 1,
    memBytes: os.totalmem(),
    swap: null,
    forced: true,
  };
}

function platformUnsupportedSignal(platform) {
  return {
    ok: false,
    forced: false,
    reason: platformUnsupportedReason(platform),
    ncpu: os.cpus().length || 1,
    memBytes: os.totalmem(),
  };
}

// ── Sizing formula (D7: single N + one Playwright cap, no weight table) ───
function budgetForLevel(level, ncpu, memBytes) {
  const safeNcpu = ncpu > 0 ? ncpu : 1;
  const heapMbTotal = Math.max(1, Math.floor((memBytes > 0 ? memBytes : os.totalmem()) / (1024 * 1024)));
  if (level === 4) {
    return {
      admit: false,
      workers: 0,
      heapMb: Math.max(1, Math.floor(heapMbTotal * 0.1)),
      playwrightWorkers: 0,
    };
  }
  if (level === 2) {
    const workers = Math.max(1, Math.floor(safeNcpu / 2));
    return {
      admit: true,
      workers,
      heapMb: Math.max(1, Math.floor(heapMbTotal * 0.5)),
      playwrightWorkers: Math.min(1, workers),
    };
  }
  // level === 1 (normal) or unknown/degraded — fail-open normal-shaped budget.
  const workers = Math.max(1, safeNcpu);
  return {
    admit: true,
    workers,
    heapMb: Math.max(1, Math.floor(heapMbTotal * 0.75)),
    playwrightWorkers: Math.min(2, workers),
  };
}

function reasonForMeasured(level) {
  if (level === 4) return REASON_CODES.PRESSURE_CRITICAL_MEASURED;
  if (level === 2) return REASON_CODES.PRESSURE_WARN;
  return REASON_CODES.PRESSURE_NORMAL;
}

function reasonForForced(level) {
  if (level === 4) return REASON_CODES.PRESSURE_CRITICAL_FORCED;
  if (level === 2) return REASON_CODES.PRESSURE_WARN;
  return REASON_CODES.PRESSURE_NORMAL;
}

// Silent-fail event append — never lets an event-log problem affect the
// resolver's return value. Only appends when .gsd/ exists under cwd.
function appendEvent(opts, cwd, kind, payload) {
  try {
    if (opts && opts.noEvents) return;
    const gsdDir = path.join(cwd, '.gsd');
    if (!fs.existsSync(gsdDir)) return;
    const forgeDir = path.join(gsdDir, 'forge');
    if (!fs.existsSync(forgeDir)) fs.mkdirSync(forgeDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...payload });
    fs.appendFileSync(path.join(forgeDir, 'events.jsonl'), line + '\n');
  } catch {
    /* silent-fail (MEM008) — event logging never breaks admission */
  }
}

// Safe default contract used both by internal-failure recovery inside
// resolveResourceBudget and by the CLI's degradedContract() wrapper.
function degradedContract() {
  return {
    admit: true,
    workers: 1,
    heapMb: 512,
    playwrightWorkers: 1,
    reason: REASON_CODES.INTERNAL_ERROR_DEGRADED,
    pressureLevel: null,
    enforcement: 'clamp',
    shadowWait: null,
    source: 'internal-error-degraded',
  };
}

// ── Pure resolver ───────────────────────────────────────────────────────
function resolveResourceBudget(opts) {
  const o = opts || {};
  try {
    const platform = o.platform || process.platform;
    const now = typeof o.now === 'function' ? o.now : Date.now;
    const cwd = o.cwd || process.cwd();
    const prefs = readResourcePrefs(o, cwd);

    const envOverride = readEnvOverride(o);
    let signal;
    let source;
    let reason;

    if (envOverride !== null) {
      signal = forcedSignal(envOverride);
      source = 'forced-env';
      reason = reasonForForced(signal.pressureLevel);
    } else if (platform !== 'darwin') {
      signal = platformUnsupportedSignal(platform);
      source = 'platform-degraded';
      reason = signal.reason;
    } else {
      signal = getCachedSignal(o, now, cwd);
      if (signal.ok) {
        source = 'measured';
        reason = reasonForMeasured(signal.pressureLevel);
      } else {
        source = 'degraded';
        reason = signal.reason;
      }
    }

    const level = signal.ok ? signal.pressureLevel : null;
    const ncpu = signal.ncpu || os.cpus().length || 1;
    const memBytes = signal.memBytes || os.totalmem();
    const budget = budgetForLevel(level === null ? 1 : level, ncpu, memBytes);

    let shadowWait = null;
    if (level === 4 && prefs.shadow_wait) {
      shadowWait = { triggered: true, wouldWaitMs: prefs.wait_cap_ms };
      appendEvent(o, cwd, 'shadow-wait', {
        reason: REASON_CODES.SHADOW_WAIT,
        wouldWaitMs: prefs.wait_cap_ms,
        source,
      });
    }

    const contract = {
      admit: budget.admit,
      workers: budget.workers,
      heapMb: budget.heapMb,
      playwrightWorkers: budget.playwrightWorkers,
      reason,
      pressureLevel: level,
      enforcement: prefs.enforcement,
      shadowWait,
      source,
    };

    appendEvent(o, cwd, contract.admit ? 'resource-admission' : 'resource-degradation', {
      reason: contract.reason,
      pressureLevel: contract.pressureLevel,
      source: contract.source,
      workers: contract.workers,
    });

    return contract;
  } catch {
    return degradedContract();
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────
function parseArgs(args) {
  const parsed = { cwd: process.cwd(), asJson: false, platform: undefined };
  const list = args || [];
  for (let i = 0; i < list.length; i += 1) {
    const flag = list[i];
    const value = list[i + 1];
    if (flag === '--cwd' && value !== undefined) { parsed.cwd = value; i += 1; }
    else if (flag === '--json') parsed.asJson = true;
    else if (flag === '--platform' && value !== undefined) { parsed.platform = value; i += 1; }
  }
  return parsed;
}

function runCli(args) {
  const parsed = parseArgs(args || []);
  const result = resolveResourceBudget({ cwd: parsed.cwd, platform: parsed.platform });
  process.stdout.write(JSON.stringify(result) + '\n');
  return result;
}

if (require.main === module) {
  // The CLI ALWAYS exits 0 (must-have: "degrades to a safe-default contract
  // and exits 0 on any internal failure"). This module's advisory posture is
  // reporting-only — a caller decides whether/how to enforce `admit`.
  try {
    runCli(process.argv.slice(2));
    process.exit(0);
  } catch {
    process.stdout.write(JSON.stringify(degradedContract()) + '\n');
    process.exit(0);
  }
}

module.exports = {
  resolveResourceBudget,
  readPressureSignal,
  REASON_CODES,
  parseArgs,
  runCli,
  degradedContract,
  resetResourceCache,
};
