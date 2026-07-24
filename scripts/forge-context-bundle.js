#!/usr/bin/env node
/**
 * forge-context-bundle.js — assemble informational Forge context for the Codex sidecar.
 *
 * Codex runs in a workspace-write sandbox scoped to CODE_DIR, while Forge metadata lives
 * under WORKING_DIR/.gsd. Supplying those paths would therefore be inert: their content
 * must be read by the orchestrator and inlined in the sidecar prompt. This module keeps
 * that extraction in one testable place instead of duplicating it across dispatch mirrors.
 *
 * Security deliberately is not part of this bundle. It is a must-have, non-truncatable
 * checklist with imperative semantics; the bundle is informational and is wrapped by the
 * adapter's anti-injection markers.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { renderMemory } = require('./forge-projection.js');

/**
 * Extract a level-two markdown section, including its heading, up to the next level-two
 * heading. A missing heading or whitespace-only body yields an empty string.
 *
 * @param {string} markdown
 * @param {string} heading
 * @returns {string}
 */
function extractSection(markdown, heading) {
  if (typeof markdown !== 'string' || typeof heading !== 'string' || !heading) return '';
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markdown.match(new RegExp(`^${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'm'));
  if (!match || !match[0].trim() || !match[1].trim()) return '';
  return match[0].trim();
}

function readFileOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Limit rendered memory to its first N entries. renderMemory already ranks entries, and
 * each entry begins with an HTML delimiter comment (`<!-- gsd-auto-memory ... -->`), not a
 * markdown heading — preserving the preamble (title + blockquote lines) before the first
 * entry is useful.
 */
function firstMemoryEntries(markdown, limit) {
  if (typeof markdown !== 'string' || !markdown.trim()) return '';
  if (markdown.includes('_No memory entries yet._')) return '';
  const starts = [...markdown.matchAll(/^<!-- gsd-auto-memory /gm)].map((match) => match.index);
  if (starts.length <= limit) return markdown.trim();
  return markdown.slice(0, starts[limit]).trim();
}

/**
 * Build the three informational sections in canonical order. Missing sources are normal:
 * this is intentionally best-effort so absent context never blocks a sidecar dispatch.
 *
 * @param {{cwd?: string, sliceContext?: string}} opts
 * @returns {string}
 */
function buildContextBundle(opts) {
  opts = opts || {};
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const sections = [];

  const standards = readFileOrEmpty(path.join(cwd, '.gsd', 'CODING-STANDARDS.md'));
  const lint = extractSection(standards, '## Lint & Format Commands');
  if (lint) sections.push(lint);

  if (opts.sliceContext) {
    const decisions = extractSection(readFileOrEmpty(opts.sliceContext), '## Decisions');
    if (decisions) sections.push(decisions.replace(/^## Decisions/m, '## Slice Decisions'));
  }

  try {
    const memory = firstMemoryEntries(renderMemory(cwd), 10);
    if (memory) sections.push(`## Project Memory\n\n${memory}`);
  } catch {
    // Projection is optional context; it must never prevent dispatch.
  }

  return sections.join('\n\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    process.stderr.write('forge-context-bundle: --out <file> is required\n');
    process.exitCode = 2;
    return;
  }
  try {
    const out = path.resolve(args.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buildContextBundle({ cwd: args.cwd, sliceContext: args['slice-context'] }), 'utf8');
  } catch (error) {
    process.stderr.write(`forge-context-bundle: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { buildContextBundle, extractSection };

if (require.main === module) main();
