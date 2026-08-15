#!/usr/bin/env node
/**
 * forge-resources-bench-dump.js — CHILD-SIDE witness (S06 review, R2).
 *
 * Injected into the measured corrida via `NODE_OPTIONS=--require <this>`.
 * It runs INSIDE the child, before the child's own entrypoint, and appends
 * one JSONL line describing what the child ACTUALLY received: its argv, the
 * NODE_OPTIONS it was started with, the resource-relevant env vars, and the
 * V8 heap ceiling the process is really running under.
 *
 * This exists because parent-side resolver output ("what we would apply") is
 * not evidence of child experience (the S03/T02 anti-pattern this milestone
 * already named). A bench cell may only be reported as enforced when a line
 * written BY THE CHILD corroborates it.
 *
 * Silent-fail (MEM008): a preload that throws would abort every measured
 * process. Nothing here may propagate.
 */

'use strict';

try {
  const dumpFile = process.env.FORGE_BENCH_DUMP;
  if (dumpFile) {
    const fs = require('fs');
    const envKeys = Object.keys(process.env)
      .filter((k) => /^(VITEST_|JEST_|PLAYWRIGHT_|UV_THREADPOOL|NODE_OPTIONS$)/.test(k))
      .sort();
    const env = {};
    for (const k of envKeys) env[k] = process.env[k];
    let heapLimitMb = null;
    try { heapLimitMb = Math.round(require('v8').getHeapStatistics().heap_size_limit / (1024 * 1024)); } catch { /* ignore */ }
    fs.appendFileSync(dumpFile, `${JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      ts: new Date().toISOString(),
      argv: process.argv,
      execArgv: process.execArgv,
      nodeOptions: process.env.NODE_OPTIONS || null,
      env,
      heapLimitMb,
    })}\n`, 'utf8');
  }
} catch { /* MEM008 — a witness that breaks the subject measures nothing */ }
