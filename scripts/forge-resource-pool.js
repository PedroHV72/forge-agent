#!/usr/bin/env node
'use strict';

// Machine-wide counting-semaphore pool for cross-run command admission.
//
// B1 (root is machine-wide, never under a project's `.gsd/`): two Forge runs
// in two different repos must share ONE ceiling, or admission goes right
// back to multiplying the machine ceiling instead of summing to it (the
// measured bug: 301s vs 88s). Default root:
// `path.join(os.homedir(), '.claude', 'forge', 'resource-pool')`, overridable
// via `FORGE_RESOURCE_POOL_DIR` env or `opts.poolDir`. `forge-lock.js` (the
// mutex `forge-unit-lease.js` uses internally) refuses to operate on a cwd
// without a `.gsd/` directory — so the pool root bootstraps its own
// `<root>/.gsd/` once, deliberately, the same way `forge-ratelimit-<session>`
// bridges live outside any repo.
//
// B2 (TTL derived from the command timeout, not a fixed heartbeat interval):
// the S04 consumers hold a slot across a blocking `spawnSync` call. The
// holder executes no JS while the child process runs, so an in-process
// heartbeat is impossible — and a detached heartbeater child is a WORSE
// failure mode (an orphaned heartbeater keeps a dead holder's slot alive
// forever, which is exactly the over-subscription bug this pool exists to
// prevent). A command legally can never outlive its `commandTimeoutMs`
// because the caller's `spawnSync` kills it at that boundary. Therefore the
// slot's lease TTL is derived: `slotTtlMs = commandTimeoutMs +
// POOL_TTL_MARGIN_MS`. Trade-off, named: a kill -9'd holder occupies its
// slot for up to `ttl + grace` (~2.5 min at defaults) — bounded, self-healing
// capacity loss, chosen deliberately over the measured over-subscription bug.

const fs = require('fs');
const os = require('os');
const path = require('path');
const lease = require('./forge-unit-lease.js');

const POOL_TTL_MARGIN_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const POOL_PROTOCOL = 1;

const POOL_REASON_CODES = Object.freeze({
  POOL_GRANTED: 'pool-granted',
  POOL_CLAMPED_BY_POOL: 'pool-clamped-by-pool',
  POOL_EXHAUSTED_MINIMUM_GRANT: 'pool-exhausted-minimum-grant',
  POOL_RELEASED: 'pool-released',
  POOL_UNAVAILABLE_FAIL_OPEN: 'pool-unavailable-fail-open',
  STALE_LEASE_REAPED: 'stale-lease-reaped',
});

// ── Root resolution (pure, no I/O) ─────────────────────────────────────────
// Precedence: opts.poolDir > env.FORGE_RESOURCE_POOL_DIR (injectable via
// opts.env, default process.env) > machine-default homedir path. Never a
// project's `.gsd/` (B1).
function poolRootDir(opts) {
  const o = opts || {};
  if (o.poolDir) return o.poolDir;
  const env = o.env || process.env;
  if (env && env.FORGE_RESOURCE_POOL_DIR) return env.FORGE_RESOURCE_POOL_DIR;
  return path.join(os.homedir(), '.claude', 'forge', 'resource-pool');
}

function configPath(root) { return path.join(root, 'pool-config.json'); }
function gsdDir(root) { return path.join(root, '.gsd'); }

function nowOf(opts) { return opts && typeof opts.now === 'function' ? opts.now() : Date.now(); }
// forge-unit-lease.js only honors `options.now` when it is itself a
// function (see forge-unit-lease.js nowOf) — a raw numeric `now` is silently
// ignored in favor of Date.now(). Every call into the lease module must pass
// a closure over the resolved instant, never the resolved number itself.
function fixedNow(instant) { return () => instant; }

function ncpuOf(opts) {
  if (opts && Number.isFinite(opts.ncpu) && opts.ncpu > 0) return Math.floor(opts.ncpu);
  try { return Math.max(1, os.cpus().length || 1); } catch { return 1; }
}

function writeConfigOnce(root, ceiling) {
  const file = configPath(root);
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const record = { protocol: POOL_PROTOCOL, ceiling, written_at: Date.now() };
  fs.writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(temp, file);
    return record;
  } catch {
    try { fs.unlinkSync(temp); } catch { /* best-effort cleanup */ }
    const winner = readPoolConfig({ poolDir: root });
    return winner || record;
  }
}

// First-writer-wins: whoever's temp file lands via renameSync first defines
// the ceiling; the file — never local recomputation — is the authority
// afterward (W2). On an EEXIST-style race, the loser re-reads the winner.
function ensurePoolRoot(opts) {
  const root = poolRootDir(opts);
  try {
    fs.mkdirSync(gsdDir(root), { recursive: true });
    const existing = readPoolConfig({ poolDir: root });
    if (existing && Number.isFinite(existing.ceiling)) {
      return { ok: true, root, ceiling: existing.ceiling, created: false };
    }
    const ceiling = ncpuOf(opts);
    const record = writeConfigOnce(root, ceiling);
    return { ok: true, root, ceiling: record.ceiling, created: true };
  } catch {
    return { ok: false, root, reason: POOL_REASON_CODES.POOL_UNAVAILABLE_FAIL_OPEN };
  }
}

function readPoolConfig(opts) {
  const root = poolRootDir(opts);
  try {
    const raw = fs.readFileSync(configPath(root), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Number.isFinite(parsed.ceiling)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── TTL derivation (B2) ─────────────────────────────────────────────────────
function deriveSlotTtlMs(opts) {
  const o = opts || {};
  const commandTimeoutMs = Number.isFinite(o.commandTimeoutMs) && o.commandTimeoutMs > 0
    ? o.commandTimeoutMs
    : DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.max(commandTimeoutMs, 1) + POOL_TTL_MARGIN_MS;
}

// ── Event trace (silent-fail, MEM008; project-scoped, derived observability
// only — never the count source) ────────────────────────────────────────────
function appendEvent(opts, kind, payload) {
  try {
    const o = opts || {};
    if (!o.cwd) return;
    const gsd = path.join(o.cwd, '.gsd');
    if (!fs.existsSync(gsd)) return;
    const forgeDir = path.join(gsd, 'forge');
    if (!fs.existsSync(forgeDir)) fs.mkdirSync(forgeDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...payload });
    fs.appendFileSync(path.join(forgeDir, 'events.jsonl'), line + '\n');
  } catch {
    /* silent-fail (MEM008) — event logging never breaks pool admission */
  }
}

function slotKey(index) { return `resource-pool/slot-${index}`; }

// ── Reap ─────────────────────────────────────────────────────────────────
// Only quarantines lease records via forge-unit-lease's recover(). Never
// signals, kills, or throttles any process (W3/D5).
function reapStale(opts) {
  const o = opts || {};
  const config = readPoolConfig(o);
  if (!config) return { ok: false, reason: POOL_REASON_CODES.POOL_UNAVAILABLE_FAIL_OPEN, reaped: 0 };
  const root = poolRootDir(o);
  const now = nowOf(o);
  let reaped = 0;
  for (let index = 0; index < config.ceiling; index += 1) {
    const key = slotKey(index);
    const observed = lease.observe(root, key, { now: fixedNow(now) });
    if (observed.ok && observed.lease && observed.lease.recoverable) {
      const recovered = lease.recover(root, key, { now: fixedNow(now) });
      if (recovered.ok && recovered.reason === 'recovered') {
        reaped += 1;
        appendEvent(o, POOL_REASON_CODES.STALE_LEASE_REAPED, { slot: key, reason: POOL_REASON_CODES.STALE_LEASE_REAPED });
      }
    }
  }
  return { ok: true, reason: 'reap-complete', reaped };
}

// ── Acquire ─────────────────────────────────────────────────────────────────
function acquireSlots(n, opts) {
  const o = opts || {};
  const requested = Math.max(1, Math.floor(Number(n) || 1));
  const bootstrap = ensurePoolRoot(o);
  if (!bootstrap.ok) {
    return { ok: false, granted: 0, reason: POOL_REASON_CODES.POOL_UNAVAILABLE_FAIL_OPEN, ceiling: 0, free_before: 0, slots: [], ttlMs: 0 };
  }
  const root = bootstrap.root;
  const ceiling = bootstrap.ceiling;
  const now = nowOf(o);
  const ttlMs = deriveSlotTtlMs(o);
  const ownerToken = o.ownerToken;
  const session = o.session;

  // Opportunistically reap crashed holders before scanning for free slots.
  try { reapStale(o); } catch { /* best-effort; scan below still works */ }

  let freeBefore = 0;
  for (let index = 0; index < ceiling; index += 1) {
    const observed = lease.observe(root, slotKey(index), { now: fixedNow(now) });
    if (observed.ok && (observed.reason === 'already-released' || observed.reason === 'recovered')) freeBefore += 1;
  }

  const acquired = [];
  for (let index = 0; index < ceiling && acquired.length < requested; index += 1) {
    const key = slotKey(index);
    const result = lease.acquire(root, key, { ttlMs, ownerToken, now: fixedNow(now), session });
    if (result.ok) {
      acquired.push({ key, owner_token: result.owner_token, generation: result.generation });
    }
  }

  if (acquired.length === 0) {
    // Minimum-grant path is explicit: leasing a nonexistent slot would break
    // the sum invariant a caller relies on, so no lease is force-acquired.
    // The floor is advisory only.
    return {
      ok: true,
      granted: 1,
      reason: POOL_REASON_CODES.POOL_EXHAUSTED_MINIMUM_GRANT,
      ceiling,
      free_before: freeBefore,
      slots: [],
      ttlMs,
    };
  }

  const reason = acquired.length >= requested ? POOL_REASON_CODES.POOL_GRANTED : POOL_REASON_CODES.POOL_CLAMPED_BY_POOL;
  return { ok: true, granted: acquired.length, reason, ceiling, free_before: freeBefore, slots: acquired, ttlMs };
}

// ── Release ─────────────────────────────────────────────────────────────────
function releaseSlots(slots, opts) {
  const o = opts || {};
  const root = poolRootDir(o);
  const results = [];
  for (const slot of slots || []) {
    const result = lease.release(root, slot.key, slot.owner_token, slot.generation);
    results.push({
      key: slot.key,
      ok: result.ok || result.reason === 'already-released',
      reason: result.ok ? POOL_REASON_CODES.POOL_RELEASED : result.reason,
    });
  }
  return { ok: true, released: results };
}

// ── Status (read-only census) ────────────────────────────────────────────────
function poolStatus(opts) {
  const o = opts || {};
  const config = readPoolConfig(o);
  if (!config) {
    return { ok: false, reason: POOL_REASON_CODES.POOL_UNAVAILABLE_FAIL_OPEN, ceiling: 0, held: 0, free: 0, slots: [] };
  }
  const root = poolRootDir(o);
  const now = nowOf(o);
  const slots = [];
  let held = 0;
  for (let index = 0; index < config.ceiling; index += 1) {
    const key = slotKey(index);
    const observed = lease.observe(root, key, { now: fixedNow(now) });
    const state = observed.ok
      ? (observed.reason === 'already-released' ? 'free' : observed.reason === 'recovered' ? 'reapable' : 'held')
      : 'unknown';
    if (state === 'held') held += 1;
    slots.push({ key, state, expires_at: observed.lease ? observed.lease.expires_at : null });
  }
  return { ok: true, ceiling: config.ceiling, held, free: config.ceiling - held, slots };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { cwd: process.cwd(), asJson: false };
  const list = argv || [];
  for (let i = 0; i < list.length; i += 1) {
    const flag = list[i];
    if (flag === '--status') args.status = true;
    else if (flag === '--json') args.asJson = true;
    else if (flag === '--pool-dir') { args.poolDir = list[i + 1]; i += 1; }
    else if (flag === '--cwd') { args.cwd = list[i + 1]; i += 1; }
  }
  return args;
}

function runCli(argv) {
  const args = parseArgs(argv || []);
  const status = poolStatus({ poolDir: args.poolDir, cwd: args.cwd });
  if (args.asJson) {
    process.stdout.write(JSON.stringify(status) + '\n');
  } else {
    process.stdout.write(
      `pool: ceiling=${status.ceiling} held=${status.held} free=${status.free}\n`
    );
  }
  return status;
}

if (require.main === module) {
  // Advisory posture (molde forge-resources.js CLI): the CLI always exits 0.
  try {
    runCli(process.argv.slice(2));
    process.exit(0);
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, reason: POOL_REASON_CODES.POOL_UNAVAILABLE_FAIL_OPEN }) + '\n');
    process.exit(0);
  }
}

module.exports = {
  poolRootDir,
  ensurePoolRoot,
  readPoolConfig,
  deriveSlotTtlMs,
  acquireSlots,
  releaseSlots,
  reapStale,
  poolStatus,
  POOL_REASON_CODES,
  POOL_TTL_MARGIN_MS,
  parseArgs,
  runCli,
};
