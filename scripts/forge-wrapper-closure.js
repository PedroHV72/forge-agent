#!/usr/bin/env node
// forge-wrapper-closure — read-only 4-layer closure check for a wrapper unit
// (milestone or task) that a physical-deletion sweep would remove.
//
// The question this module answers, purely by code, never by narration
// (molde: forge-route-audit.js): "is the durable content of this wrapper
// already answered by LEDGER, a distilled memory fragment, the live memory
// index, and KNOWLEDGE.md?"
//
// Four layers, each with its own outcome from the closed set
// ok | fail | unavailable — "did not look" never collapses into "looked and
// is clean" (anti-silence floor, TASK-021 lesson):
//
//   1. ledger      — forge-ledger.readFragment(cwd, unitId). Reads the STORE,
//                     never the stale .gsd/LEDGER.md monolith.
//   2. distilled    — the unit's own memory fragment, located via
//                     forge-memory.listFragments + readFragmentText (never
//                     fs.readFileSync of the path directly), counting facts
//                     whose mem_id carries the DST- prefix. Destilação is
//                     PROVED here, never presumed from "milestone closed".
//   3. index        — forge-memory-axes.buildUnitAxis computed LIVE against
//                     forge-memory-index.buildFileIndex(cwd) — never the
//                     materialized MEMORY-INDEX-BY-FILE.md. A complete miss
//                     falls back to the canonical memory store funnel
//                     (listFragments/readFragmentText/parseFragment) so a
//                     fact with no file citation still proves existence;
//                     `source` names which signal decided (file-index |
//                     store).
//   4. knowledge    — .gsd/KNOWLEDGE.md refs to the unit, enumerated with
//                     line numbers. Purely informative: this layer NEVER
//                     decides `ok`; refs found are always surfaced, never
//                     silenced, and never flip the overall verdict.
//
// Library exports:
//   checkClosure(cwd, unitId, opts) → { unit, ok, reasons[], layers }
//   renderClosureSection(result)    → markdown string, ALWAYS emitted (even
//                                      when all 4 layers are clean)
//
// Exit codes (CLI): 0 — always (advisory leaf tool, molde forge-route-audit).

'use strict';

const fs = require('fs');
const path = require('path');

// ── Layer 1 — LEDGER ─────────────────────────────────────────────────────────
// readFragment is grouped-aware and reads the fragment STORE (.gsd/ledger/),
// never the regenerated .gsd/LEDGER.md monolith (measured stale: 3 vs 8
// entries — see M-S04 context).
function checkLedger(cwd, unitId) {
  let ledger;
  try {
    ledger = require('./forge-ledger');
  } catch (e) {
    return { outcome: 'unavailable', reason: 'module-unavailable', note: e.message };
  }
  try {
    const frag = ledger.readFragment(cwd, unitId);
    if (frag) return { outcome: 'ok', reason: null };
    return { outcome: 'fail', reason: 'no-ledger-entry' };
  } catch (e) {
    return { outcome: 'unavailable', reason: 'unreadable', note: e.message };
  }
}

// ── Layer 2 — DISTILLED ──────────────────────────────────────────────────────
// Locates the unit's memory fragment via listFragments (match by unitId OR
// storageKey — a caller may pass either form), reads bytes exclusively via
// readFragmentText (grouped-container aware), parses via parseFragment, and
// counts facts whose mem_id begins with 'DST-'. A missing fragment is
// 'not-distilled' with note 'fragment-missing' — never presumed clean.
function checkDistilled(cwd, unitId) {
  let memory;
  try {
    memory = require('./forge-memory');
  } catch (e) {
    return { outcome: 'unavailable', reason: 'module-unavailable', note: e.message, dst_count: 0 };
  }
  let fragments;
  try {
    fragments = memory.listFragments(cwd);
  } catch (e) {
    return { outcome: 'unavailable', reason: 'listing-failed', note: e.message, dst_count: 0 };
  }
  const entry = fragments.find((f) => f && (f.unitId === unitId || f.storageKey === unitId));
  if (!entry) {
    return { outcome: 'fail', reason: 'not-distilled', note: 'fragment-missing', dst_count: 0 };
  }
  try {
    const text = memory.readFragmentText(cwd, entry);
    const parsed = memory.parseFragment(text);
    const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    const dstCount = facts.filter((f) => typeof (f && f.mem_id) === 'string' && f.mem_id.startsWith('DST-')).length;
    if (dstCount >= 1) return { outcome: 'ok', reason: null, dst_count: dstCount };
    return { outcome: 'fail', reason: 'not-distilled', note: null, dst_count: 0 };
  } catch (e) {
    return { outcome: 'unavailable', reason: 'unreadable', note: e.message, dst_count: 0 };
  }
}

// ── Layer 3 — INDEX ──────────────────────────────────────────────────────────
// Builds the unit axis LIVE off forge-memory-index.buildFileIndex(cwd) — the
// same scan the (never-injected) MEMORY-INDEX-BY-FILE.md is regenerated from
// — never reading that materialized artifact. An index that lost coverage
// (fragment_listing_failed, partial) is 'unavailable': a degraded index is
// not evidence of absence (same ruler as the index-verde gate).
//
// The file index only ever surfaces a fact when its text carries a resolvable
// file citation (buildFileIndex skips citation-less facts by design — see the
// fixture comment in the test file). That made Layer 3's real question wrong:
// it was answering "does this unit have a CITED fact?", not "does this unit
// have a durable fact at all?". A complete index miss is therefore NOT proof
// of absence — it only proves the fact (if any) did not cite a file. When the
// complete axis has nothing for the unit, checkIndex falls back to the
// canonical memory store funnel (listFragments → readFragmentText →
// parseFragment — never fs.readFileSync of a path directly, so grouped
// fragments work) and asks the more honest question directly. Fields stay
// additive: `source` names which signal actually established existence.
function checkIndex(cwd, unitId) {
  let memoryIndex;
  let memoryAxes;
  try {
    memoryIndex = require('./forge-memory-index');
    memoryAxes = require('./forge-memory-axes');
  } catch (e) {
    return { outcome: 'unavailable', reason: 'module-unavailable', note: e.message, facts_count: 0 };
  }
  let scan;
  try {
    scan = memoryIndex.buildFileIndex(cwd);
  } catch (e) {
    return { outcome: 'unavailable', reason: 'index-build-error', note: e.message, facts_count: 0 };
  }
  let axis;
  try {
    axis = memoryAxes.buildUnitAxis(scan);
  } catch (e) {
    return { outcome: 'unavailable', reason: 'axis-build-error', note: e.message, facts_count: 0 };
  }
  if (axis.fragment_listing_failed) {
    return { outcome: 'unavailable', reason: 'fragment-listing-failed', note: axis.fragment_listing_failed, facts_count: 0 };
  }
  if (axis.partial) {
    return { outcome: 'unavailable', reason: 'index-partial', note: null, facts_count: 0 };
  }
  const unit = axis.units.find((u) => u && (u.unit_id === unitId || u.storage_key === unitId));
  if (unit && Array.isArray(unit.facts) && unit.facts.length >= 1) {
    return { outcome: 'ok', reason: null, facts_count: unit.facts.length, source: 'file-index' };
  }
  return checkIndexStoreFallback(cwd, unitId);
}

// Fallback funnel used only after a COMPLETE file-index/axis lookup found no
// facts for the unit. Never invoked on a degraded first read (partial /
// fragment_listing_failed / build errors all return before reaching here) —
// a degraded index is not evidence of absence and must not trigger a
// fallback that could disguise it as a clean miss.
function checkIndexStoreFallback(cwd, unitId) {
  let memory;
  try {
    memory = require('./forge-memory');
  } catch (e) {
    return { outcome: 'unavailable', reason: 'module-unavailable', note: e.message, facts_count: 0, source: 'store' };
  }
  let fragments;
  try {
    fragments = memory.listFragments(cwd);
  } catch (e) {
    return { outcome: 'unavailable', reason: 'listing-failed', note: e.message, facts_count: 0, source: 'store' };
  }
  // D5 precedent (S01): a local id like `S01`/`T01` is qualified by milestone
  // in the store, so several fragments can share the same BARE unitId. Picking
  // the first ordered match would answer for another milestone's fragment and
  // be right only by luck. Filter, and when more than one candidate matches,
  // REFUSE naming them — never choose one, never ok, never fail.
  const matches = fragments.filter((f) => f && (f.unitId === unitId || f.storageKey === unitId));
  if (matches.length > 1) {
    const keys = matches.map((f) => f.storageKey || f.unitId).sort();
    return {
      outcome: 'unavailable',
      reason: `ambiguous-unit-id: ${keys.join(', ')}`,
      facts_count: 0,
      source: 'store',
    };
  }
  const entry = matches[0];
  if (!entry) {
    return { outcome: 'fail', reason: 'not-in-index', facts_count: 0 };
  }
  let facts;
  try {
    const text = memory.readFragmentText(cwd, entry);
    const parsed = memory.parseFragment(text);
    facts = Array.isArray(parsed.facts) ? parsed.facts : [];
  } catch (e) {
    return { outcome: 'unavailable', reason: 'store-read-error', note: e.message, facts_count: 0, source: 'store' };
  }
  if (facts.length >= 1) {
    return { outcome: 'ok', reason: null, source: 'store', note: 'no-file-citations', facts_count: facts.length };
  }
  return { outcome: 'fail', reason: 'not-in-index', facts_count: 0 };
}

// ── Layer 4 — KNOWLEDGE ──────────────────────────────────────────────────────
// Purely informative — the return value is NEVER folded into the overall
// `ok`. Refs are enumerated with line numbers, never silenced. An absent
// KNOWLEDGE.md reports its own 'unavailable' outcome ('knowledge-file-absent')
// rather than an empty-and-clean refs list.
const KNOWLEDGE_REL_PATH = path.join('.gsd', 'KNOWLEDGE.md');

function knowledgeRefPatterns(unitId) {
  return [
    unitId,
    `.gsd/milestones/${unitId}/`,
    `.gsd/tasks/${unitId}/`,
    `.gsd/archive/${unitId}/`,
  ];
}

function checkKnowledge(cwd, unitId) {
  const knowledgePath = path.join(cwd, KNOWLEDGE_REL_PATH);
  if (!fs.existsSync(knowledgePath)) {
    return { outcome: 'unavailable', reason: 'knowledge-file-absent', refs: [] };
  }
  try {
    // EOL normalization happens before any regex/substring scan of the read
    // funnel (Standards: normalize /\r\n?/g before matching).
    const raw = fs.readFileSync(knowledgePath, 'utf8').replace(/\r\n?/g, '\n');
    const lines = raw.split('\n');
    const patterns = knowledgeRefPatterns(unitId);
    const refs = [];
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (patterns.some((p) => text.includes(p))) refs.push({ line: i + 1, text });
    }
    return { outcome: 'ok', reason: null, refs };
  } catch (e) {
    return { outcome: 'unavailable', reason: 'read-error', note: e.message, refs: [] };
  }
}

// ── checkClosure ──────────────────────────────────────────────────────────────
// Overall `ok` = layers 1–3 ok. Layer 4 (KNOWLEDGE) NEVER decides `ok` — its
// refs are always enumerated in layers.knowledge.refs, never used to derail
// the verdict when 1–3 pass.
function checkClosure(cwd, unitId, opts) {
  opts = opts || {};
  const layers = {
    ledger: checkLedger(cwd, unitId),
    distilled: checkDistilled(cwd, unitId),
    index: checkIndex(cwd, unitId),
    knowledge: checkKnowledge(cwd, unitId),
  };

  const decisive = [layers.ledger, layers.distilled, layers.index];
  const ok = decisive.every((l) => l.outcome === 'ok');

  const reasons = [];
  if (layers.ledger.outcome !== 'ok') reasons.push(`ledger:${layers.ledger.reason || layers.ledger.outcome}`);
  if (layers.distilled.outcome !== 'ok') reasons.push(`distilled:${layers.distilled.reason || layers.distilled.outcome}`);
  if (layers.index.outcome !== 'ok') reasons.push(`index:${layers.index.reason || layers.index.outcome}`);

  return { unit: unitId, ok, reasons, layers };
}

// ── renderClosureSection ─────────────────────────────────────────────────────
// Emits the '## Fechamento em 4 camadas' section BY CODE, always — including
// the fully-clean case (molde: forge-route-audit.formatRouteMd never skips
// the section it owns).
function layerLine(label, layer, measureLabel, measureValue) {
  const note = layer.note ? ` — ${layer.note}` : '';
  const reasonPart = layer.reason ? ` (${layer.reason})` : '';
  const measurePart = measureValue !== undefined && measureValue !== null ? `, ${measureLabel}=${measureValue}` : '';
  return `- ${label}: ${layer.outcome}${reasonPart}${measurePart}${note}`;
}

function renderClosureSection(result) {
  const layers = (result && result.layers) || {};
  const ledger = layers.ledger || { outcome: 'unavailable' };
  const distilled = layers.distilled || { outcome: 'unavailable' };
  const index = layers.index || { outcome: 'unavailable' };
  const knowledge = layers.knowledge || { outcome: 'unavailable', refs: [] };

  const lines = ['## Fechamento em 4 camadas', ''];
  lines.push(layerLine('LEDGER', ledger));
  lines.push(layerLine('DISTILLED', distilled, 'dst_count', distilled.dst_count));
  lines.push(layerLine('INDEX', index, 'facts_count', index.facts_count));
  lines.push(layerLine('KNOWLEDGE', knowledge));
  lines.push('');

  const decisive = [ledger, distilled, index];
  const okCount = decisive.filter((l) => l.outcome === 'ok').length;
  const verdict = result && result.ok ? 'FECHADO' : 'ABERTO';
  lines.push(`- resultado: ${verdict} (${okCount}/3 camadas decisórias verdes; KNOWLEDGE é informativa e nunca decide)`);

  const refs = Array.isArray(knowledge.refs) ? knowledge.refs : [];
  if (refs.length > 0) {
    lines.push('- refs em KNOWLEDGE.md:');
    for (const ref of refs) {
      lines.push(`  - linha ${ref.line}: ${ref.text}`);
    }
  } else {
    lines.push('- refs em KNOWLEDGE.md: nenhuma');
  }

  return `${lines.join('\n')}\n`;
}

// ── Module exports ────────────────────────────────────────────────────────────
module.exports = {
  checkClosure,
  renderClosureSection,
  _private: {
    checkLedger,
    checkDistilled,
    checkIndex,
    checkIndexStoreFallback,
    checkKnowledge,
    knowledgeRefPatterns,
    KNOWLEDGE_REL_PATH,
  },
};

// ── CLI ───────────────────────────────────────────────────────────────────────
// node forge-wrapper-closure.js --unit <id> [--cwd <dir>] [--json]
// Advisory leaf tool (molde forge-route-audit): exit code is always 0, stdout
// carries the JSON result, stderr carries the rendered section for humans.
function parseArgs(argv) {
  const out = { cwd: process.cwd(), unit: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--json') out.json = true;
    else if (key === '--unit' && argv[i + 1] !== undefined) out.unit = argv[++i];
    else if (key === '--cwd' && argv[i + 1] !== undefined) out.cwd = argv[++i];
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (!args.unit) {
      process.stdout.write(`${JSON.stringify({ error: '--unit is required' })}\n`);
      process.exit(0);
    }
    const result = checkClosure(path.resolve(args.cwd), args.unit);
    process.stderr.write(renderClosureSection(result));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ error: e.message })}\n`);
    process.exit(0);
  }
}
