#!/usr/bin/env node
// forge-doctor — schema-version + projection-versioned checks for Forge Agent
//
// Library exports:
//   CURRENT_SCHEMA              // string — 'fragment-store@2.0.0'
//   checkSchema(cwd)            // (cwd?) → { ok, expected, actual, message }
//   checkProjectionVersioned(cwd) // (cwd?) → { ok, tracked: string[], skipped?: string, message }
//   checkPlanRepoDeclared(cwd)  // (cwd?) → { ok, plans: string[], skipped?: string, message }  (advisory)
//   checkWorkspaceConsistency(cwd) // (cwd?) → { ok: true, workspaces, divergentCount, skipped?, message }  (advisory, D3)
//
// CLI:
//   node forge-doctor.js --check schema [--cwd <dir>]
//   node forge-doctor.js --check projection-versioned [--cwd <dir>]
//   node forge-doctor.js --check plan-repo-declared [--cwd <dir>]
//   node forge-doctor.js --check workspace-consistency [--cwd <dir>]
//   node forge-doctor.js --check all [--cwd <dir>]
//   node forge-doctor.js --fix [--cwd <dir>]
//   node forge-doctor.js --regen-projection [--cwd <dir>]
//   node forge-doctor.js --help
//
// Exit codes: 0 all checks pass, 1 check failed, 2 bad arguments.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── Imports from forge-ignore ─────────────────────────────────────────────────
const { PROJECTION_IGNORE_PATHS, detectVcs } = require('./forge-ignore');
const { audit: auditReview } = require('./forge-review-audit');

// ── Constants ─────────────────────────────────────────────────────────────────
const CURRENT_SCHEMA = 'fragment-store@2.0.0';
const SCHEMA_FILE = '.gsd/SCHEMA-VERSION';

// Single source of truth for the check names this CLI accepts via `--check`.
// `runCheck` dispatches these; the unknown-check message and `--help` text
// must both be derived from this array — never hand-repeated.
const VALID_CHECKS = ['schema', 'projection-versioned', 'review-model-drift', 'plan-repo-declared', 'workspace-consistency', 'run-overlap'];

// ── checkSchema ───────────────────────────────────────────────────────────────
/**
 * Reads .gsd/SCHEMA-VERSION and compares to CURRENT_SCHEMA.
 * @param {string} [cwd] - Working directory (default: process.cwd())
 * @returns {{ ok: boolean, expected: string, actual: string|null, message: string }}
 */
function checkSchema(cwd) {
  const dir = cwd || process.cwd();
  const schemaPath = path.join(dir, SCHEMA_FILE);

  if (!fs.existsSync(schemaPath)) {
    return {
      ok: false,
      expected: CURRENT_SCHEMA,
      actual: null,
      message: `SCHEMA-VERSION not found at ${schemaPath}. Run --fix to create it.`,
    };
  }

  const actual = fs.readFileSync(schemaPath, 'utf8').trim();

  if (actual === CURRENT_SCHEMA) {
    return {
      ok: true,
      expected: CURRENT_SCHEMA,
      actual,
      message: `Schema version matches: ${actual}`,
    };
  }

  return {
    ok: false,
    expected: CURRENT_SCHEMA,
    actual,
    message: `Schema version mismatch — expected "${CURRENT_SCHEMA}", got "${actual}". Run --fix to update.`,
  };
}

// ── checkProjectionVersioned ──────────────────────────────────────────────────
/**
 * Checks if any projection monolith is tracked by VCS (should be ignored).
 * Uses PROJECTION_IGNORE_PATHS from forge-ignore.js — single source of truth.
 *
 * The membership question goes through the `forge-vcs.js` seam (`isTracked`),
 * never through a VCS command parsed here. This layer previously read
 * `svn status <path>` textually and got the answer backwards on both ends —
 * an ignored path prints `I <path>` (read as tracked) and a versioned clean
 * one prints nothing (read as untracked). Re-implementing VCS access beside
 * the seam is what produced that; the seam owns the oracle now.
 *
 * @param {string} [cwd] - Working directory (default: process.cwd())
 * @returns {{ ok: boolean, tracked: string[], skipped?: string, unreadable?: string[], message: string }}
 */
function checkProjectionVersioned(cwd) {
  const dir = cwd || process.cwd();
  const vcs = detectVcs(dir);

  if (vcs === 'none') {
    return {
      ok: true,
      tracked: [],
      skipped: 'not-git',
      message: 'No VCS detected — projection-versioned check skipped.',
    };
  }

  const { isTracked } = require('./forge-vcs');

  const tracked = [];
  const unreadable = [];
  for (const projPath of PROJECTION_IGNORE_PATHS) {
    const probe = isTracked(dir, projPath, { vcs });
    // `ok: false` is "could not ask" (VCS binary absent), never "the answer is
    // no". Accusing on an unanswered probe is how this check lost the operator's
    // trust in the first place — it is reported, not counted.
    if (!probe.ok) unreadable.push(projPath);
    else if (probe.tracked) tracked.push(projPath);
  }

  const label = vcs === 'svn' ? 'SVN' : 'git';
  const suffix = unreadable.length
    ? ` (${unreadable.length} path(s) could not be probed: ${unreadable.join(', ')})`
    : '';

  if (tracked.length === 0) {
    return {
      ok: true,
      tracked: [],
      ...(unreadable.length ? { unreadable } : {}),
      message: `No projection monoliths are tracked by ${label}.${suffix}`,
    };
  }

  // Both failure texts are verbatim what they were before the seam refactor —
  // `commands/forge-doctor.md` reproduces the git one as sample output.
  const accusation = vcs === 'svn'
    ? `${tracked.length} projection monolith(s) tracked by SVN (should be ignored): ${tracked.join(', ')}`
    : `${tracked.length} projection monolith(s) accidentally tracked by git (should be in .gitignore): ${tracked.join(', ')}`;
  return {
    ok: false,
    tracked,
    ...(unreadable.length ? { unreadable } : {}),
    message: `${accusation}${suffix}`,
  };
}

// ── checkPlanRepoDeclared ─────────────────────────────────────────────────────
//
// Advisory (TASK-018). `repo:` is a frontmatter field introduced AFTER plans already
// existed, so a milestone planned before it — or by an older planner — carries plans that
// cannot be attributed to one repo in a multi-repo workspace. The resolver refuses those
// units fail-closed (`sidecar-code-dir-undeclared`), which is correct but only visible one
// unit at a time, mid-run. This layer answers the question up front: WHICH pending plans
// will refuse. It never writes: filling `repo:` by guesswork is worse than leaving it
// absent, because the resolver TRUSTS the declaration (P4 returns before the probe).

const PLAN_FILE_RE = /-PLAN\.md$/i;
const TASK_PLAN_FILE_RE = /^T.*-PLAN\.md$/i;
// The predicate this layer reports on. Deliberately ONE field: the class ("frontmatter key
// added after plans exist") is broader, but a second real case has to show up before
// generalizing is anything but speculation.
const REQUIRED_PLAN_FIELD = 'repo';

// Recursive walker, zero deps. Never descends into `archive/` and never returns a path
// under `.gsd/archive/` — an archived plan will never be dispatched again, so flagging it
// would be pure noise.
function collectPlanFiles(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'archive') continue;
      collectPlanFiles(full, out);
    } else if (ent.isFile() && PLAN_FILE_RE.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Lists pending plans that declare no `repo:` in a multi-repo workspace.
 * @param {string} [cwd] - Working directory (default: process.cwd())
 * @returns {{ ok: boolean, plans: string[], skipped?: string, message: string }}
 */
function checkPlanRepoDeclared(cwd) {
  const dir = cwd || process.cwd();

  const { discoverRepos } = require('./forge-repos');
  let repos = [];
  try { repos = discoverRepos(dir) || []; } catch (_) { repos = []; }
  if (repos.length < 2) {
    return {
      ok: true,
      plans: [],
      skipped: 'single-repo',
      message: `Workspace has ${repos.length} repo(s) — \`${REQUIRED_PLAN_FIELD}:\` is only needed in a multi-repo workspace; check skipped.`,
    };
  }

  const { parseScalarField, frontmatterOf } = require('./forge-code-dir');

  const candidates = [];
  const milestonesDir = path.join(dir, '.gsd', 'milestones');
  for (const p of collectPlanFiles(milestonesDir, [])) {
    if (TASK_PLAN_FILE_RE.test(path.basename(p))) candidates.push(p);
  }
  const tasksDir = path.join(dir, '.gsd', 'tasks');
  for (const p of collectPlanFiles(tasksDir, [])) candidates.push(p);

  const plans = [];
  for (const planPath of candidates) {
    if (planPath.replace(/\\/g, '/').includes('/.gsd/archive/')) continue;

    // Already executed → declaring `repo:` now changes nothing.
    const planDir = path.dirname(planPath);
    let siblings = [];
    try { siblings = fs.readdirSync(planDir); } catch (_) { siblings = []; }
    if (siblings.some(name => /-SUMMARY\.md$/i.test(name))) continue;

    let text = '';
    try { text = fs.readFileSync(planPath, 'utf8'); } catch (_) { continue; }
    const fm = frontmatterOf(text);
    const status = String(parseScalarField(fm, 'status') || '').toUpperCase();
    if (status === 'DONE' || status === 'DECOMPOSED') continue;

    if (!parseScalarField(fm, REQUIRED_PLAN_FIELD)) {
      plans.push(path.relative(dir, planPath).replace(/\\/g, '/'));
    }
  }

  plans.sort();

  if (plans.length === 0) {
    return {
      ok: true,
      plans: [],
      message: `All pending plans declare \`${REQUIRED_PLAN_FIELD}:\` (${repos.length} repos in workspace).`,
    };
  }

  return {
    ok: true, // advisory — a missing `repo:` is legitimate in a single-repo workspace and
              // is already handled fail-closed by the resolver; this never fails the run.
    plans,
    message: `${plans.length} pending plan(s) declare no \`${REQUIRED_PLAN_FIELD}:\` in a multi-repo workspace (${repos.length} repos). `
      + 'Those whose `writes:`/`expected_output:` cannot be attributed to a single repo will be refused with '
      + '`sidecar-code-dir-undeclared` and fall back to Claude. '
      + `Declaring \`${REQUIRED_PLAN_FIELD}: <repo-dir-name>\` in the plan frontmatter removes the ambiguity up front — `
      + '`--fix` does NOT fill it: the resolver trusts the declaration, so a guessed value is worse than an absent one.',
  };
}

// ── checkWorkspaceConsistency ─────────────────────────────────────────────────
/**
 * Advisory guard (D3, T04): confronts the registry (~/.claude) against the
 * on-disk marker of each indexed workspace and surfaces divergence. Wraps
 * `auditWorkspaces` from `forge-workspace-consistency.js` — this function does
 * not implement the comparison itself, it only shapes the result the way this
 * CLI's other checks are shaped, following `checkPlanRepoDeclared`'s form.
 *
 * ALWAYS `ok: true` — divergence here is advisory information, never a
 * failure. See `forge-workspace-consistency.js` for the full rationale (D3
 * mandates this guard never blocks).
 *
 * @param {string} [cwd] - Working directory (default: process.cwd())
 * @returns {{ ok: true, workspaces: object[], divergentCount: number, skipped?: string, message: string }}
 */
function checkWorkspaceConsistency(cwd) {
  const dir = cwd || process.cwd();
  const { auditWorkspaces } = require('./forge-workspace-consistency');

  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) {
    return {
      ok: true,
      workspaces: [],
      divergentCount: 0,
      skipped: 'no-home',
      message: 'forge-workspace-consistency: sem HOME resolvível — check pulado (advisory).',
    };
  }

  let result;
  try {
    result = auditWorkspaces({ home, cwd: dir });
  } catch (e) {
    return {
      ok: true, // advisory — an internal error here still must not fail `--check all`
      workspaces: [],
      divergentCount: 0,
      skipped: `error: ${e.message}`,
      message: `forge-workspace-consistency: erro ao auditar (${e.message}) — advisory, não bloqueia.`,
    };
  }

  if (result.skipped) {
    return {
      ok: true,
      workspaces: [],
      divergentCount: 0,
      skipped: result.skipped,
      message: `forge-workspace-consistency: ${result.skipped} — nada a confrontar.`,
    };
  }

  const divergent = result.workspaces.filter((w) => w.status === 'divergent');
  const unreadable = result.workspaces.filter((w) => w.status === 'marker-unreadable');

  if (divergent.length === 0 && unreadable.length === 0) {
    return {
      ok: true,
      workspaces: result.workspaces,
      divergentCount: 0,
      message: `${result.workspaces.length} workspace(s) indexado(s) verificado(s) — registry e marcador consistentes (advisory).`,
    };
  }

  const lines = [];
  for (const w of divergent) {
    for (const d of w.diffs) {
      const reg = d.registry_path || '(ausente)';
      const mk = d.marker_path || '(ausente)';
      lines.push(`${w.workspace}: ${d.name} [${d.kind}] registry=${reg} marcador=${mk}`);
    }
  }
  for (const w of unreadable) {
    lines.push(`${w.workspace}: marcador ilegível (${w.error})`);
  }

  return {
    ok: true, // advisory — never fails `--check all`; D3 requires exit 0 always
    workspaces: result.workspaces,
    divergentCount: divergent.length,
    message: `${divergent.length + unreadable.length} workspace(s) com registry × marcador divergentes ou ilegíveis (advisory, nunca bloqueia):\n    `
      + lines.join('\n    '),
  };
}

// ── checkRunOverlap ──────────────────────────────────────────────────────────
/**
 * Advisory guard (S07/T03): confronts the touch snapshots forge-touch.js
 * records against every other active run and surfaces cross-run file
 * collisions. Wraps `collectRunTouches`/`computeOverlap` from
 * `forge-overlap.js` — this function does not implement the comparison
 * itself, it only shapes the result the way this CLI's other checks are
 * shaped, following `checkWorkspaceConsistency`'s form.
 *
 * ALWAYS `ok: true` — overlap here is advisory information, never a failure.
 * See `forge-overlap.js` for the locked boundary (signals, never sequences)
 * and the verdict floor (`pairs_compared === 0` → `inconclusive`, never a
 * silent `clean`).
 *
 * @param {string} [cwd] - Working directory (default: process.cwd())
 * @returns {{ ok: true, verdict?: string, overlaps: object[], skipped?: string, message: string }}
 */
function checkRunOverlap(cwd) {
  const dir = cwd || process.cwd();
  const { collectRunTouches, computeOverlap, formatOverlap } = require('./forge-overlap');

  const runsDir = path.join(dir, '.gsd', 'forge', 'runs');
  if (!fs.existsSync(runsDir)) {
    return {
      ok: true,
      overlaps: [],
      skipped: 'no-runs-registry',
      message: 'forge-overlap: sem .gsd/forge/runs/ — nada a confrontar (advisory).',
    };
  }

  let result;
  try {
    result = computeOverlap(collectRunTouches(dir, {}));
  } catch (e) {
    return {
      ok: true, // advisory — an internal error here still must not fail `--check all`
      overlaps: [],
      skipped: `error: ${e.message}`,
      message: `forge-overlap: erro ao confrontar (${e.message}) — advisory, não bloqueia.`,
    };
  }

  return {
    ok: true, // advisory — never fails `--check all`, including verdict === 'overlap'
    verdict: result.verdict,
    overlaps: result.overlaps,
    census: {
      runs_examined: result.runs_examined,
      runs_with_touch_data: result.runs_with_touch_data,
      pairs_compared: result.pairs_compared,
      files_compared: result.files_compared,
      skipped: result.skipped.length,
    },
    message: formatOverlap(result),
  };
}

// ── module.exports ────────────────────────────────────────────────────────────
module.exports = {
  CURRENT_SCHEMA,
  VALID_CHECKS,
  checkSchema,
  checkProjectionVersioned,
  checkPlanRepoDeclared,
  checkWorkspaceConsistency,
  checkRunOverlap,
};

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

function runCheck(name, cwd) {
  const checks = name === 'all' ? VALID_CHECKS.slice() : [name];

  let allOk = true;
  const results = [];

  for (const c of checks) {
    if (c === 'schema') {
      const r = checkSchema(cwd);
      results.push({ check: 'schema', ...r });
      if (!r.ok) allOk = false;
    } else if (c === 'projection-versioned') {
      const r = checkProjectionVersioned(cwd);
      results.push({ check: 'projection-versioned', ...r });
      if (!r.ok) allOk = false;
    } else if (c === 'review-model-drift') {
      const report = auditReview(path.join(cwd, '.gsd', 'forge', 'events.jsonl'), cwd);
      results.push({ check: c, ok: true, report, message: `${report.drifts.length} advisory review model drift(s) (compares history against TODAY's advocate_model preference — a past preference change can surface old, then-compliant events as drift).` });
    } else if (c === 'plan-repo-declared') {
      const r = checkPlanRepoDeclared(cwd);
      results.push({ check: c, ...r });
      // Advisory: `r.ok` is always true, so this never flips `allOk`.
      if (!r.ok) allOk = false;
    } else if (c === 'workspace-consistency') {
      const r = checkWorkspaceConsistency(cwd);
      results.push({ check: c, ...r });
      // Advisory (D3): `r.ok` is always true, so this never flips `allOk` — a
      // registry × marker divergence must never fail `--check all`.
      if (!r.ok) allOk = false;
    } else if (c === 'run-overlap') {
      const r = checkRunOverlap(cwd);
      results.push({ check: c, ...r });
      // Advisory: `r.ok` is always true, so this never flips `allOk` — a
      // cross-run overlap must never fail `--check all`.
      if (!r.ok) allOk = false;
    } else {
      process.stderr.write(`forge-doctor: unknown check "${c}". Valid: ${VALID_CHECKS.join(', ')}, all\n`);
      process.exit(2);
    }
  }

  return { allOk, results };
}

function formatResults(results) {
  const lines = [];
  for (const r of results) {
    const advisoryWarn = (r.check === 'plan-repo-declared' && Array.isArray(r.plans) && r.plans.length > 0)
      || (r.check === 'workspace-consistency' && r.divergentCount > 0)
      || (r.check === 'run-overlap' && r.verdict === 'overlap');
    const icon = advisoryWarn ? '⚠' : (r.ok ? '✓' : '✗');
    const label = r.check === 'schema' ? 'Layer 2 — Schema version'
      : r.check === 'review-model-drift' ? 'Advisory — Review model drift'
      : r.check === 'plan-repo-declared' ? 'Advisory — Plan repo declaration'
      : r.check === 'workspace-consistency' ? 'Advisory — Workspace registry × marker consistency'
      : r.check === 'run-overlap' ? 'Advisory — Cross-run overlap'
      : 'Layer 3 — Projection versioned';
    lines.push(`  ${icon} ${label}`);
    lines.push(`    ${r.message}`);
    if (!r.ok && r.tracked && r.tracked.length > 0) {
      for (const t of r.tracked) lines.push(`      - ${t}`);
    }
    if (advisoryWarn && r.check === 'plan-repo-declared') {
      for (const p of r.plans) lines.push(`      - ${p}`);
    }
  }
  return lines.join('\n');
}

function cliMain() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`forge-doctor — Forge schema-version and projection-versioned checks

Flags:
  --check <name> [--cwd <dir>]   run check: ${VALID_CHECKS.join(' | ')} |
                                 all
  --fix [--cwd <dir>] [--migrate]  write SCHEMA-VERSION if missing; suggest ignore
                                 fixes. Refuses to stamp an unmigrated store unless
                                 --migrate is given (then runs forge-migrate first).
  --regen-projection [--cwd <dir>] [--force]  regenerate monolith projections from
                                 fragment store (refuses to overwrite a populated
                                 monolith from an empty store unless --force)
  --cwd <dir>                    working directory (default: process.cwd())
  --help                         show this help

Exit codes:
  0  all requested checks passed
  1  one or more checks failed
  2  bad arguments
`);
    return;
  }

  const cwdArg = typeof args.cwd === 'string' ? path.resolve(args.cwd) : process.cwd();

  if (args.fix) {
    const schemaPath = path.join(cwdArg, SCHEMA_FILE);
    const gsdDir = path.join(cwdArg, '.gsd');
    let fixed = [];

    // Ensure .gsd/ exists
    if (!fs.existsSync(gsdDir)) {
      fs.mkdirSync(gsdDir, { recursive: true });
    }

    // Migration gate: never stamp SCHEMA-VERSION on an unmigrated working copy.
    // A stamped-but-empty store makes --regen-projection destructive (it would
    // overwrite populated monoliths with empty skeletons). Require an explicit
    // --migrate to decompose the monoliths into fragments before stamping.
    const { isUnmigrated, storeState } = require('./forge-store-state');
    if (isUnmigrated(cwdArg)) {
      const st = storeState(cwdArg);
      const unmig = Object.entries(st)
        .filter(([, s]) => s.state === 'unmigrated')
        .map(([name, s]) => `${name} (${s.monolithPath}: ${s.monolithEntries} entries, 0 fragments)`);

      if (!args.migrate) {
        process.stdout.write('forge-doctor --fix:\n');
        process.stdout.write('  Refusing to stamp SCHEMA-VERSION — fragment store is not migrated.\n');
        process.stdout.write('  The following monoliths still hold the source of truth:\n');
        for (const u of unmig) process.stdout.write(`    - ${u}\n`);
        process.stdout.write('\n  Run the migration first (decomposes monoliths → fragments, then stamps):\n');
        process.stdout.write('    node scripts/forge-migrate.js\n');
        process.stdout.write('  Or let --fix run it for you:\n');
        process.stdout.write('    node scripts/forge-doctor.js --fix --migrate\n');
        process.exit(1);
        return;
      }

      // --migrate: delegate to the umbrella migrator. migrateAll() backs up each
      // monolith to .bak, decomposes into fragments, verifies, and stamps
      // SCHEMA-VERSION itself. Lazy-required to avoid the forge-migrate ↔
      // forge-doctor require cycle.
      const { migrateAll } = require('./forge-migrate');
      let results;
      try {
        results = migrateAll(cwdArg, {});
      } catch (e) {
        process.stderr.write(`forge-doctor --fix --migrate: migration failed: ${e.message}\n`);
        process.exit(1);
        return;
      }
      const migErr = ['ledger', 'decisions', 'memory'].find(n => results[n] && results[n].error);
      if (migErr) {
        process.stderr.write(`forge-doctor --fix --migrate: ${migErr} migration errored: ${results[migErr].error}\n`);
        process.stderr.write('  Partial state preserved; .bak files kept. See above.\n');
        process.exit(1);
        return;
      }
      process.stdout.write('forge-doctor --fix --migrate:\n');
      for (const n of ['ledger', 'decisions', 'memory']) {
        const r = results[n];
        if (r) process.stdout.write(`  ${n}: ${r.written} fragment(s) written, verification: ${r.verification}\n`);
      }
      process.stdout.write(`  SCHEMA-VERSION stamped: ${results.schema_version_written}\n`);
      process.exit(0);
      return;
    }

    if (!fs.existsSync(schemaPath)) {
      fs.writeFileSync(schemaPath, CURRENT_SCHEMA + '\n', 'utf8');
      fixed.push(`Created ${SCHEMA_FILE} with "${CURRENT_SCHEMA}"`);
    } else {
      const current = fs.readFileSync(schemaPath, 'utf8').trim();
      if (current !== CURRENT_SCHEMA) {
        fs.writeFileSync(schemaPath, CURRENT_SCHEMA + '\n', 'utf8');
        fixed.push(`Updated ${SCHEMA_FILE}: "${current}" → "${CURRENT_SCHEMA}"`);
      } else {
        fixed.push(`${SCHEMA_FILE} already at "${CURRENT_SCHEMA}" — no change`);
      }
    }

    // Suggest ignore fixes for tracked projections
    const projResult = checkProjectionVersioned(cwdArg);
    if (!projResult.ok && projResult.tracked.length > 0) {
      process.stdout.write(`forge-doctor --fix:\n`);
      for (const f of fixed) process.stdout.write(`  ${f}\n`);
      process.stdout.write(`\nProjection monoliths tracked by VCS:\n`);
      for (const t of projResult.tracked) process.stdout.write(`  - ${t}\n`);
      process.stdout.write(`\nTo fix, run:\n  node scripts/forge-ignore.js --apply\n`);
    } else {
      process.stdout.write(`forge-doctor --fix:\n`);
      for (const f of fixed) process.stdout.write(`  ${f}\n`);
    }
    process.exit(0);
    return;
  }

  if (args['regen-projection']) {
    const projectionScript = path.resolve(__dirname, 'forge-projection.js');
    const projArgs = ['--write-all'];
    if (cwdArg !== process.cwd()) projArgs.push('--cwd', cwdArg);
    if (args.force) projArgs.push('--force');
    try {
      execFileSync(process.execPath, [projectionScript].concat(projArgs), { stdio: 'inherit' });
      process.stdout.write('Monoliths regenerated. (.gsd/{AUTO-MEMORY,DECISIONS,LEDGER,CHECKER-MEMORY}.md refreshed from fragments.)\n');
      process.exit(0);
    } catch (err) {
      // forge-projection exits 1 when a target was blocked (empty store would
      // overwrite a populated monolith). The block reasons were printed to
      // stderr via stdio:inherit — add the operator-facing next step.
      process.stderr.write('forge-doctor --regen-projection: regeneration incomplete.\n');
      process.stderr.write('  An unmigrated store would overwrite a populated monolith.\n');
      process.stderr.write('  Run the migration first:  node scripts/forge-migrate.js\n');
      process.stderr.write('  Or force-overwrite (data loss):  node scripts/forge-doctor.js --regen-projection --force\n');
      process.exit(1);
    }
    return;
  }

  if (args.check) {
    const { allOk, results } = runCheck(args.check, cwdArg);
    process.stdout.write('Forge Doctor\n============\n\n');
    process.stdout.write(formatResults(results) + '\n');
    const passed = results.filter(r => r.ok).length;
    process.stdout.write(`\n  Summary: ${passed}/${results.length} checks passed\n`);
    process.exit(allOk ? 0 : 1);
    return;
  }

  process.stderr.write('forge-doctor: no command specified. Use --help.\n');
  process.exit(2);
}

if (require.main === module) cliMain();
