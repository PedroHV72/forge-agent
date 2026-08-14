#!/usr/bin/env node
/**
 * forge-resources-bench.js
 *
 * The INSTRUMENT for S06/T06 — not the measurement. Builds the four-cell
 * matrix (solo/batch x controle off/on) with configurable repetitions, an
 * in-cell WITNESS of the resource control actually in effect (never the
 * requested state — see forge-resources-enforcement.test.js and D9), and
 * incremental JSONL so a run interrupted by the 10-minute Bash ceiling (A4)
 * leaves every already-finished corrida on disk.
 *
 * D5 (hard boundary, inherited): this harness only times. `spawnSync`'s
 * `timeout` option kills ONLY the process this module itself created (the
 * corrida under measurement) — it never signals a process it did not spawn.
 *
 * D10: sizing/enforcement resolution is never reimplemented here. The
 * witness is collected by requiring `forge-doctor.js`'s `checkResources`,
 * which itself defers to `forge-resources.js`'s `resolveResourceBudget` —
 * this module owns none of that logic (see also `readResourcePrefs` in
 * forge-resources.js:206, and `checkResources` in forge-doctor.js:474).
 *
 * Cells: `solo/off`, `solo/on`, `batch/off`, `batch/on`. `off` writes
 * `resources.enforcement: 'off'` to the project-local preference layer
 * (`.gsd/forge-prefs.jsonc` — see forge-home.js:134 `resolvePreferencePaths`
 * `.local.jsoncPath`, and forge-resources-enforcement.test.js's
 * `workspaceWith()` fixture, which writes the exact same file). `on` writes
 * `clamp`. Repetitions are INTERLEAVED across cells (round-robin), not
 * blocked, so machine drift over a long run distributes instead of
 * concentrating in one cell (S06-PLAN.md "Desenho exigido").
 *
 * Anti-silence floor (precedent: forge-overlap.js, S05): a cell with zero
 * `ok` corridas summarizes as `inconclusive:<reason>`, NEVER `clean` and
 * NEVER silently absent from the table. An `aborted:<reason>` corrida stays
 * in the JSONL and in the per-cell count, but is excluded from the
 * median/min/max (a timed-out run is not a measurement of the thing under
 * test).
 *
 * Prefs restoration (must-have, non-negotiable): every corrida this module
 * runs may have rewritten the project-local prefs file. The ORIGINAL bytes
 * (or absence) are snapshotted once before the first write and restored on
 * every exit path — normal completion, thrown exception, SIGINT, SIGTERM —
 * via a single idempotent `doRestore()` guarded by a `restored` flag so a
 * signal arriving during the `finally` block cannot double-write.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const CELLS = ['solo/off', 'solo/on', 'batch/off', 'batch/on'];
const DEFAULT_COMMAND = 'node scripts/run-tests.js';
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_REPS = 3;
const MIN_REPS = 3;
const DEFAULT_COMPETITORS = 2;

// ── Local prefs file (project-local layer, same file the operator edits —
// same path the enforcement suite fixtures write) ──────────────────────────
function localPrefsPath(cwd) {
  return path.join(cwd, '.gsd', 'forge-prefs.jsonc');
}

function cellEnforcement(cell) {
  return cell.endsWith('/off') ? 'off' : 'clamp';
}

function snapshotPrefsFile(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return { existed: true, content };
  } catch {
    return { existed: false, content: null };
  }
}

function restorePrefsFile(filePath, snapshot) {
  if (snapshot.existed) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, snapshot.content);
  } else {
    try { fs.unlinkSync(filePath); } catch { /* already absent, fine */ }
  }
}

// Best-effort merge: preserve any other keys already in the local prefs
// file, overwrite only `resources.enforcement`. Falls back to a minimal
// object when the existing file is absent or not parseable JSON — the local
// layer is `.jsonc` in name, but this harness only ever writes/reads plain
// JSON (mirrors the enforcement suite fixture).
function writeEnforcement(filePath, value) {
  let base = {};
  try {
    base = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { /* absent or unparsable — start fresh */ }
  base.resources = Object.assign({}, base.resources, { enforcement: value });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
}

// ── Command parsing (shell:false, MEM004 — no shell-string parsing) ───────
// `--command` accepts either a JSON array of argv tokens (unambiguous, the
// only supported form for arguments containing spaces/quotes) or a bare
// whitespace-split string (sufficient for the default `node
// scripts/run-tests.js`).
function parseCommand(raw) {
  const trimmed = String(raw || DEFAULT_COMMAND).trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr) || arr.some((t) => typeof t !== 'string')) {
      throw new Error('--command JSON array must contain only strings');
    }
    return arr;
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

// ── Witness (D9 — collected fresh, in-cell, never assumed) ────────────────
function collectWitness(cwd) {
  // Lazy require: keeps `parseCommand`/`median` etc. testable without the
  // doctor module's heavier dependency graph loading on every import.
  const { checkResources } = require('./forge-doctor.js');
  const r = checkResources(cwd, {});
  if (r.skipped) {
    return { ok: false, skipped: r.skipped };
  }
  return {
    ok: true,
    verdict: r.verdict,
    pool: r.pool,
    census: r.census,
  };
}

// checkResources() does not surface the raw contract fields (enforcement,
// workers, heapMb) directly — it folds them into a formatted `message`
// string plus a census verdict. The witness this module's must-haves
// require (enforcement/workers/heapMb/aggregate/RAM) needs the contract
// itself, so this reads it the same way checkResources does — via the same
// resolver, never reimplemented (D10) — and augments with the aggregate.
function collectContractWitness(cwd) {
  const { resolveResourceBudget } = require('./forge-resources.js');
  const contract = resolveResourceBudget({ cwd, noEvents: true });
  const totalMb = Math.round(require('os').totalmem() / (1024 * 1024));
  return {
    enforcement: contract.enforcement,
    workers: contract.workers,
    heapMb: contract.heapMb,
    aggregateMb: contract.workers * contract.heapMb,
    totalMb,
    pressureLevel: contract.pressureLevel,
    reason: contract.reason,
    source: contract.source,
  };
}

// ── Corrida execution ──────────────────────────────────────────────────────
function runChild(cmd, args, cwd, timeoutMs) {
  const start = Date.now();
  const result = spawnSync(cmd, args, {
    cwd,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
  const wallMs = Date.now() - start;
  if (result.error && result.error.code === 'ETIMEDOUT') {
    return { wallMs, exitCode: null, status: 'aborted:timeout-exceeded' };
  }
  if (result.signal) {
    return { wallMs, exitCode: null, status: `aborted:killed-${result.signal}` };
  }
  if (result.status === 0) {
    return { wallMs, exitCode: 0, status: 'ok' };
  }
  return { wallMs, exitCode: result.status, status: `aborted:non-zero-exit-${result.status}` };
}

// Competitors are fire-and-forget context (S06-PLAN.md: "o wall-clock dos
// competidores é registrado como contexto, não como o número"). They are
// spawned async, never synchronously blocking the measured corrida's start.
function spawnCompetitor(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const child = spawn(cmd, args, { cwd, stdio: 'ignore' });
    const killer = setTimeout(() => {
      if (!settled) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve({ wallMs: Date.now() - start, exitCode: code, signal: signal || null });
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve({ wallMs: Date.now() - start, exitCode: null, signal: 'spawn-error' });
    });
  });
}

async function runOneCorrida(opts) {
  const {
    cell, rep, command, cwd, timeoutMs, competitors, outFile,
  } = opts;
  writeEnforcement(localPrefsPath(cwd), cellEnforcement(cell));

  const witness = collectContractWitness(cwd);

  const [cmd, ...args] = command;
  let competitorPromises = [];
  if (cell.startsWith('batch/') && competitors > 0) {
    competitorPromises = Array.from({ length: competitors }, () => spawnCompetitor(cmd, args, cwd, timeoutMs));
  }

  const measured = runChild(cmd, args, cwd, timeoutMs);
  const competitorResults = competitorPromises.length ? await Promise.all(competitorPromises) : undefined;

  const record = {
    cell,
    rep,
    ts: new Date().toISOString(),
    wallMs: measured.wallMs,
    exitCode: measured.exitCode,
    status: measured.status,
    witness,
  };
  if (competitorResults) record.competitors = competitorResults;

  fs.appendFileSync(outFile, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

// ── Planning ────────────────────────────────────────────────────────────
// Interleaved round-robin: for rep 1..n, one corrida per cell in order —
// never all reps of one cell back to back (S06-PLAN.md "intercale as
// células").
function planRuns(cells, reps) {
  const plan = [];
  for (let r = 1; r <= reps; r += 1) {
    for (const cell of cells) plan.push({ cell, rep: r });
  }
  return plan;
}

// ── Aggregation ─────────────────────────────────────────────────────────
function median(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function readJsonlRecords(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function summarizeRecords(records, cells) {
  const byCell = {};
  for (const cell of cells) byCell[cell] = [];
  for (const rec of records) {
    if (!byCell[rec.cell]) byCell[rec.cell] = [];
    byCell[rec.cell].push(rec);
  }

  const summary = {};
  for (const cell of Object.keys(byCell)) {
    const recs = byCell[cell];
    const ok = recs.filter((r) => r.status === 'ok').map((r) => r.wallMs).sort((a, b) => a - b);
    const aborted = recs.filter((r) => r.status !== 'ok');
    const lastWitness = recs.length ? recs[recs.length - 1].witness : null;

    if (ok.length === 0) {
      // Anti-silence floor: zero `ok` corridas is `inconclusive`, NEVER
      // `clean`, and the cell stays in the table (never omitted).
      summary[cell] = {
        n: recs.length,
        nOk: 0,
        median: null,
        min: null,
        max: null,
        aborted: aborted.map((r) => ({ rep: r.rep, status: r.status })),
        witness: lastWitness,
        verdict: recs.length === 0 ? 'inconclusive:no-data' : 'inconclusive:zero-ok-runs',
      };
      continue;
    }

    summary[cell] = {
      n: recs.length,
      nOk: ok.length,
      median: median(ok),
      min: ok[0],
      max: ok[ok.length - 1],
      aborted: aborted.map((r) => ({ rep: r.rep, status: r.status })),
      witness: lastWitness,
      verdict: 'measured',
    };
  }
  return summary;
}

function summarizeFile(filePath, cells) {
  return summarizeRecords(readJsonlRecords(filePath), cells || CELLS);
}

function formatSummary(summary) {
  const lines = [];
  for (const cell of Object.keys(summary)) {
    const s = summary[cell];
    if (s.verdict !== 'measured') {
      lines.push(`${cell}: ${s.verdict} (n=${s.n}, ok=${s.nOk})`);
      continue;
    }
    const w = s.witness || {};
    lines.push(
      `${cell}: n=${s.n} ok=${s.nOk} mediana=${s.median}ms min=${s.min}ms max=${s.max}ms`
      + ` aborted=${s.aborted.length}`
      + `${w.enforcement ? ` enforcement=${w.enforcement} workers=${w.workers} heapMb=${w.heapMb} agregado=${w.aggregateMb}MB RAM=${w.totalMb}MB` : ''}`,
    );
  }
  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'dry-run') { args.dryRun = true; continue; }
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
  }
  return args;
}

async function runMatrix(opts) {
  const {
    cwd, cells, reps, competitors, command, timeoutMs, outFile,
  } = opts;
  const prefsPath = localPrefsPath(cwd);
  const snapshot = snapshotPrefsFile(prefsPath);
  let restored = false;
  const doRestore = () => {
    if (restored) return;
    restored = true;
    try {
      restorePrefsFile(prefsPath, snapshot);
    } catch (e) {
      process.stderr.write(`forge-resources-bench: ERRO ao restaurar prefs (${e.message}) — verifique ${prefsPath} manualmente.\n`);
    }
  };

  const onSignal = (sig) => () => {
    doRestore();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal('SIGINT'));
  process.on('SIGTERM', onSignal('SIGTERM'));

  try {
    const plan = planRuns(cells, reps);
    for (const { cell, rep } of plan) {
      // eslint-disable-next-line no-await-in-loop
      await runOneCorrida({
        cell, rep, command, cwd, timeoutMs, competitors, outFile,
      });
    }
    return summarizeFile(outFile, cells);
  } finally {
    doRestore();
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  const cwd = args.cwd || process.cwd();

  if (args.summarize) {
    const summary = summarizeFile(args.summarize, CELLS);
    process.stdout.write(`${formatSummary(summary)}\n`);
    return;
  }

  const reps = Math.max(MIN_REPS, Number.parseInt(args.reps, 10) || DEFAULT_REPS);
  const competitors = Number.isInteger(Number.parseInt(args.competitors, 10))
    ? Number.parseInt(args.competitors, 10) : DEFAULT_COMPETITORS;
  const cells = args.cells ? String(args.cells).split(',').map((c) => c.trim()).filter(Boolean) : CELLS;
  const timeoutMs = Number.parseInt(args['timeout-ms'], 10) || DEFAULT_TIMEOUT_MS;
  const outFile = args.out || path.join(cwd, '.gsd', 'forge', `resources-bench-${Date.now()}.jsonl`);
  const command = parseCommand(args.command);

  if (args.dryRun) {
    const plan = planRuns(cells, reps);
    process.stdout.write(`${JSON.stringify({
      dryRun: true, plan, command, competitors, timeoutMs, outFile,
    }, null, 2)}\n`);
    return;
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const summary = await runMatrix({
    cwd, cells, reps, competitors, command, timeoutMs, outFile,
  });
  process.stdout.write(`${formatSummary(summary)}\n`);
  process.stdout.write(`\narquivo: ${outFile}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`forge-resources-bench: erro fatal (${e.message})\n`);
    process.exit(1);
  });
}

module.exports = {
  CELLS,
  DEFAULT_COMMAND,
  localPrefsPath,
  cellEnforcement,
  snapshotPrefsFile,
  restorePrefsFile,
  writeEnforcement,
  parseCommand,
  runChild,
  spawnCompetitor,
  runOneCorrida,
  planRuns,
  median,
  readJsonlRecords,
  summarizeRecords,
  summarizeFile,
  formatSummary,
  parseArgs,
  runMatrix,
  main,
};
