#!/usr/bin/env node
'use strict';

// File locks are defence-in-depth for shared worktrees, not unit leases.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mutex = require('./forge-lock.js');
const DEFAULT_TTL_MS = 60_000;
let runs = null;
try { runs = require('./forge-runs.js'); } catch { /* optional diagnostic */ }

function locksDir(cwd) { return path.join(cwd, '.gsd', 'forge', 'file-locks'); }
function encodePath(value) { return Buffer.from(String(value), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function canonicalPath(cwd, filePath) {
  validatePath(filePath);
  // Forge plans and state use POSIX separators on every platform. Treat both
  // spellings as separators before resolving so `src/foo.js` and
  // `src\\foo.js` cannot acquire different locks on macOS/Linux.
  const portable = String(filePath).normalize('NFC').replace(/[\\/]/g, path.sep);
  const normalized = path.normalize(path.resolve(cwd, portable)).normalize('NFC');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function lockPathFor(cwd, filePath) { const canonical = canonicalPath(cwd, filePath); return path.join(locksDir(cwd), `${encodePath(canonical)}.json`); }
function validatePath(filePath) { if (!filePath || String(filePath).length > 4096) throw new Error('forge-filelock: path inválido'); }
function positive(value, fallback) { const n = value === undefined ? fallback : Number(value); if (!Number.isFinite(n) || n <= 0) throw new Error('forge-filelock: ttl deve ser positivo'); return n; }
function nowOf(opts) { return opts && typeof opts.now === 'function' ? opts.now() : Date.now(); }
function newToken(opts) { return opts && typeof opts.tokenFactory === 'function' ? opts.tokenFactory() : crypto.randomUUID().replace(/-/g, ''); }
function readLock(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeAtomic(file, meta) { const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temporary, JSON.stringify(meta), 'utf8'); fs.renameSync(temporary, file); }
function ageOf(meta, now) { return meta ? now - (meta.renewed_at || meta.acquired_at || 0) : null; }
function isHolderRunActive(cwd, runId) { if (!runs || !runId) return false; try { const run = runs.get(cwd, runId); return !!(run && run.active); } catch { return false; } }
// Mutex names are capped at 160 characters. Absolute paths routinely exceed
// that once base64url-encoded (especially under Windows temp directories), so
// use a stable digest for the internal guard while retaining the readable
// canonical path in the file-lock metadata itself.
function guardName(filePath) { return `filelock-${crypto.createHash('sha256').update(String(filePath), 'utf8').digest('hex')}`; }
function withGuard(cwd, filePath, fn) {
  const guard = mutex.tryAcquireSync(cwd, guardName(filePath), { ttlMs: 5_000 });
  if (!guard) return { acquired: false, reason: 'guard_busy', holder: null };
  try { return fn(); } finally { guard.release(); }
}
function publicHolder(existing, now) { return { run_id: existing.run_id, session_id: existing.session_id, file_path: existing.file_path, acquired_at: existing.acquired_at, age_ms: ageOf(existing, now) }; }

function acquireFileLock(cwd, filePath, runId, sessionId, opts) {
  opts = opts || {}; const canonical = canonicalPath(cwd, filePath); const ttlMs = positive(opts.ttlMs, DEFAULT_TTL_MS); const now = nowOf(opts); const file = lockPathFor(cwd, canonical);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withGuard(cwd, canonical, () => {
    const existing = readLock(file);
    if (existing && existing.owner_token === opts.ownerToken && opts.ownerToken) {
      const renewed = { ...existing, renewed_at: now, ttl_ms: ttlMs, session_id: sessionId || existing.session_id, intent: opts.intent || existing.intent };
      writeAtomic(file, renewed); return { acquired: true, renewed: true, holder: null, owner_token: renewed.owner_token, generation: renewed.generation, release: () => releaseFileLock(cwd, filePath, runId, renewed.owner_token, renewed.generation) };
    }
    if (existing) {
      const age = ageOf(existing, now); const ownerTtl = positive(existing.ttl_ms, ttlMs); const stale = age !== null && age > ownerTtl;
      // A run/PID is never an authorization decision. It remains diagnostic only.
      const diagnostic = isHolderRunActive(cwd, existing.run_id) ? 'active-run' : 'inactive-run';
      if (!stale) return { acquired: false, reason: 'busy', holder: { ...publicHolder(existing, now), run_diagnostic: diagnostic } };
      const quarantine = `${file}.quarantine-${existing.generation || 'legacy'}-${crypto.randomUUID()}`;
      try { fs.renameSync(file, quarantine); } catch { return { acquired: false, reason: 'contended_recovery', holder: publicHolder(existing, now) }; }
      try { fs.unlinkSync(quarantine); } catch { /* quarantine is diagnostic debris only */ }
    }
    const meta = { run_id: runId || null, session_id: sessionId || null, file_path: canonical, intent: opts.intent || 'edit', generation: newToken(opts), owner_token: newToken(opts), acquired_at: now, renewed_at: now, ttl_ms: ttlMs };
    writeAtomic(file, meta);
    return { acquired: true, holder: null, owner_token: meta.owner_token, generation: meta.generation, stolen: existing ? { from: existing.run_id, reason: 'expired', age_ms: ageOf(existing, now) } : null, release: () => releaseFileLock(cwd, filePath, runId, meta.owner_token, meta.generation) };
  });
}

function renewFileLock(cwd, filePath, ownerToken, generation, opts) {
  opts = opts || {}; const canonical = canonicalPath(cwd, filePath); const now = nowOf(opts); const file = lockPathFor(cwd, canonical);
  return withGuard(cwd, canonical, () => { const existing = readLock(file); if (!existing) return { ok: false, reason: 'already_released' }; if (existing.owner_token !== ownerToken || existing.generation !== generation) return { ok: false, reason: 'owner_mismatch' }; const renewed = { ...existing, renewed_at: now, ttl_ms: positive(opts.ttlMs, existing.ttl_ms || DEFAULT_TTL_MS) }; writeAtomic(file, renewed); return { ok: true, reason: 'renewed', metadata: renewed }; });
}
function releaseFileLock(cwd, filePath, runId, ownerToken, generation) {
  // runId is retained for call-shape compatibility, but cannot prove ownership.
  if (!ownerToken || !generation) return false;
  const canonical = canonicalPath(cwd, filePath); const file = lockPathFor(cwd, canonical);
  const result = withGuard(cwd, canonical, () => { const existing = readLock(file); if (!existing) return { ok: false, reason: 'already_released' }; if (existing.owner_token !== ownerToken || existing.generation !== generation) return { ok: false, reason: 'owner_mismatch' }; const quarantine = `${file}.release-${generation}-${crypto.randomUUID()}`; try { fs.renameSync(file, quarantine); fs.unlinkSync(quarantine); return { ok: true, reason: 'released' }; } catch { return { ok: false, reason: 'already_released' }; } });
  return result.ok;
}
function checkFileLock(cwd, filePath, opts) {
  opts = opts || {}; const existing = readLock(lockPathFor(cwd, filePath)); if (!existing) return { held: false };
  const holder = publicHolder(existing, nowOf(opts));
  if (opts.ownerToken && opts.generation && existing.owner_token === opts.ownerToken && existing.generation === opts.generation) {
    holder.owner_token = existing.owner_token; holder.generation = existing.generation;
  }
  return { held: true, holder, age_ms: holder.age_ms };
}

function parseArgs(argv) { const args = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const key = argv[i].slice(2), next = argv[i + 1]; args[key] = next && !next.startsWith('--') ? (i++, next) : true; } return args; }
function cliMain() { const args = parseArgs(process.argv.slice(2)), cwd = args.cwd || process.cwd(); try { if (args.acquire) { const result = acquireFileLock(cwd, args.acquire, args.run || null, args.session || null, { ttlMs: args.ttl && Number(args.ttl), intent: args.intent, ownerToken: args.token }); process.stdout.write(JSON.stringify(result) + '\n'); if (!result.acquired) process.exitCode = 1; } else if (args.release) { const ok = releaseFileLock(cwd, args.release, args.run, args.token, args.generation); process.stdout.write(ok ? 'released\n' : 'not held (token obrigatório)\n'); if (!ok) process.exitCode = 1; } else if (args.check) process.stdout.write(JSON.stringify(checkFileLock(cwd, args.check), null, 2) + '\n'); else { process.stderr.write('forge-filelock: comando inválido\n'); process.exitCode = 2; } } catch (error) { process.stderr.write(`forge-filelock error: ${error.message}\n`); process.exitCode = 1; } }
if (require.main === module) cliMain();
module.exports = { acquireFileLock, renewFileLock, releaseFileLock, checkFileLock, lockPathFor, encodePath, DEFAULT_TTL_MS };
