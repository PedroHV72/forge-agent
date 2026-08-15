#!/usr/bin/env node
// forge-unit-delta — what each GSD unit actually WROTE, straight from the VCS.
//
// ── The attribution axis, and why it is the ref (S02-PLAN § B1) ─────────────
//
// The obvious axis — "read `type(S##/T##):` out of commit subjects" — is
// unusable in this corpus, and that is a MEASURED fact, not a worry: 136 of
// the 154 `(S##/T##)` commits in forge-agent's history belong to pairs that
// recur across milestones, and `S04/T01` alone appears 11 times. A global
// subject scan therefore merges the writes of unrelated milestones into one
// bucket and calls the result coverage.
//
// So the unit key here is COMPOSITE, and the composition is what makes the
// collision unreachable BY CONSTRUCTION rather than by care:
//
//   milestone / loose-task id   <- the NAME of the ref (`forge/M-<id>`,
//                                  `forge/T-<id>`; timestamp ids, globally
//                                  unique)
//   S## / T##                   <- the conventional-commit scope, read ONLY
//                                  inside `merge-base(ref, default)..ref`
//
// Every S##/T## lookup in this file is born already scoped by a ref. There is
// no code path that asks the history at large what `S04/T01` wrote, which is
// why `unitKeyFor` below carries the owner id in the key itself — see the
// comment there, and `forge-unit-delta.test.js` R6, which reverts exactly that
// composition on a throwaway copy and observes the bait assert go red.
//
// Why not the default branch: this repo's PR merges are SQUASH commits (single
// parent — verified), so `master` carries one commit per milestone and no
// per-unit granularity at all. The branch ranges do carry it (measured:
// controle-contexto-gsd 16 commits / 9 scoped, varredura-classe-eol 12 / 9,
// lease-escrita-cross-run 7 / 5).
//
// ── Anti-silence floor ─────────────────────────────────────────────────────
//
// Every commit walked lands in exactly one place: attributed to a unit, or in
// `unattributed[]` with a reason from the closed `DELTA_REASONS` set. The
// census reconciles by construction — `commits_walked === attributed +
// unattributed.length` — because a walker that quietly drops what it cannot
// classify reports its own blind spot as a clean history. Same rule one level
// up: a unit whose owner cannot be resolved goes to `skipped[]` with a named
// reason, never to a wildcard owner. A smaller honest measurement beats a
// larger contaminated one; widening attribution to raise coverage is the one
// move this module must never make.
//
// ── Composition, not reimplementation ──────────────────────────────────────
//
//   default branch   forge-isolation.gitDefaultBranch  (never re-derived —
//                    the fourth implementation of that relation IS the defect,
//                    forge-touch.js:51)
//   vcs detect/svn   forge-vcs.detectVcs / svnLogChangedPaths (T02, additive)
//   id shape         forge-ids.entityKind / classify   (zero ID regex here)
//
// D6: the evidence log is NEVER a source in this module. It records tool
// calls, not tree state.
//
// Posture: read-only VCS (for-each-ref, merge-base, rev-list, show,
// diff-tree, svn log) — never add/commit/checkout/fetch.
//
// CLI:
//   node forge-unit-delta.js [--cwd <dir>] [--json]

'use strict';

const { execFileSync } = require('child_process');

const { gitDefaultBranch } = require('./forge-isolation.js');
const { detectVcs, svnLogChangedPaths } = require('./forge-vcs.js');
const { entityKind, classify } = require('./forge-ids.js');

// ── Reasons ────────────────────────────────────────────────────────────────
//
// Closed set, cross-checked BOTH WAYS by the suite against what the code
// actually produces (forge-touch.js:60 precedent; TASK-021's lesson: a
// declared reason nobody ever saw fire is decoration, and a reason the code
// produces but the list omits is a silent drop). Each entry says exactly when
// it is reachable.
const DELTA_REASONS = [
  'no-unit-marker',       // commit subject carries no `type(S##/T##):` scope — e.g. `fix(review): …`, `docs: …`. Named, never dropped.
  'no-attributed-commits',// the ref EXISTS but carries no commit with any unit scope (e.g. a batch commit that aggregated several tasks). Neither 0% nor 100% coverage — an honest "cannot measure this one"
  'merge-commit',         // multi-parent commit: `diff-tree` against no single parent yields no file list, so it names no writes
  'no-merge-base',        // `git merge-base <ref> <default>` failed (unrelated histories) — the ref's range cannot be bounded, so the ref is skipped rather than walked whole
  'git-command-failed',   // a read-only git invocation threw for this ref (corrupt repo, permissions) — this ref is skipped, other refs continue
  'ambiguous-unit-owner', // svn only: >1 milestone candidate in context and the message names no full id. There is no ref axis in svn, so the honest answer is "I cannot say who owns this"
  'svn-log-failed',       // `svn log --xml -v` could not be read (non-zero exit, malformed XML, or the reader THREW — see writtenByUnit)
  'vcs-unsupported',      // detectVcs returned something this module has no adapter for
  'ref-divergent',        // a unit id carries BOTH a local and an origin ref and NEITHER contains the other. There is no "the" range to walk, so the unit is skipped carrying both refs — never one of them picked in silence (S02 review R5)
];
// Deliberately ABSENT: `no-branch-ref`. It names a unit that has a PLAN but no
// ref, and this module never sees the plan side — it starts from refs. It
// belongs to the join (T03) and listing it here would be an aspirational entry
// no test could ever see fire.

// The conventional-commit scope, ANCHORED at the start of the subject and
// requiring the closing paren: only the exact form `type(S##/T##):` counts.
// `fix(S01/review):`, `fix(review):`, `merge:` deliberately do NOT match — they
// carry no unit, and stretching this regex to "recover" them is precisely the
// widening-for-coverage move that would contaminate the measurement.
// `T##.#` is admitted because split tasks (`T03.1`) exist in this corpus.
const UNIT_SCOPE_RE = /^\w+\((S\d{2})\/(T\d{2}(?:\.\d+)?)\):/;

/**
 * The composite unit key — the whole B1 defence, in one line.
 *
 * `ownerId` is the milestone (or loose-task) id taken from the REF NAME; it is
 * part of the key, not metadata beside it. Drop it and `S04/T01` from eleven
 * different milestones collapses into one bucket. `forge-unit-delta.test.js`
 * R6 mutates this exact expression on a throwaway copy to prove the bait test
 * bites.
 */
function unitKeyFor(ownerId, slice, task) {
  // A loose task's ref IS the whole unit — there is no S##/T## below it.
  if (slice === null || task === null) return `${ownerId}`;
  return `${ownerId}::${slice}/${task}`;
}

// ── git plumbing (array args, read-only, never shell) ──────────────────────
function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Every `forge/*` ref, local and origin, as `[{ id, kind, ref, scope }]`.
 *
 * The id is whatever follows `forge/` in the ref name; its kind comes from
 * `entityKind` (forge-ids) rather than a private regex — this repo keeps ID
 * shape knowledge in exactly one module and a second copy here would be the
 * defect, not the convenience.
 *
 * Dedup is by id, resolved by ANCESTRY — never by a blanket preference.
 *
 * The previous rule preferred the local ref, justified by the claim that "the
 * local ref is the one that can be ahead". That claim is FALSIFIED BY THE VERY
 * REPOSITORY THIS MODULE MEASURES (S02 review R5, `rev-list --left-right`):
 * `controle-contexto-gsd` is 0/5 — the local ref is five commits BEHIND origin,
 * and preferring it silently dropped five commits of that unit's writes from
 * the measurement, raising coverage. `varredura-classe-eol` is 12/1 —
 * DIVERGENT, so "take the one that is ahead" has no answer at all there.
 *
 * So: ask git which one contains the other and take the DESCENDANT; when
 * neither contains the other, refuse — the pair comes back marked
 * `divergent: true` carrying BOTH refs, and `writtenByUnit` turns that into a
 * named `ref-divergent` skip. A silent pick between two divergent histories is
 * a measurement nobody can reproduce.
 *
 * Refs whose id `entityKind` cannot classify as milestone or task are dropped
 * from the ref list on purpose — they are not unit refs, so they carry no
 * unit to skip (`skipped[]` is for units, not for arbitrary branch names).
 */
function isAncestorOf(repoRoot, a, b) {
  try {
    git(repoRoot, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    // Non-zero exit is the ANSWER ("not an ancestor"). A git failure answers
    // the same way here on purpose: the caller's fallback for "cannot tell" is
    // `ref-divergent`, a named skip — never a pick.
    return false;
  }
}

function listUnitRefs(repoRoot) {
  let out = '';
  try {
    out = git(repoRoot, ['for-each-ref', '--format=%(refname)', 'refs/heads/forge', 'refs/remotes/origin/forge']);
  } catch {
    return [];
  }
  const byId = new Map();
  for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const local = line.startsWith('refs/heads/forge/');
    const marker = '/forge/';
    const at = line.indexOf(marker);
    if (at === -1) continue;
    const id = line.slice(at + marker.length);
    if (!id) continue;
    const kind = entityKind(id);
    if (kind !== 'milestone' && kind !== 'task') continue;
    if (!byId.has(id)) byId.set(id, { id, kind, idForm: classify(id), local: null, remote: null });
    const slot = byId.get(id);
    if (local) slot.local = line; else slot.remote = line;
  }

  const refs = [];
  for (const slot of byId.values()) {
    const base = { id: slot.id, kind: slot.kind, idForm: slot.idForm };
    if (slot.local && !slot.remote) { refs.push({ ...base, ref: slot.local, scope: 'local', resolution: 'only-ref' }); continue; }
    if (slot.remote && !slot.local) { refs.push({ ...base, ref: slot.remote, scope: 'remote', resolution: 'only-ref' }); continue; }
    const localInRemote = isAncestorOf(repoRoot, slot.local, slot.remote);
    const remoteInLocal = isAncestorOf(repoRoot, slot.remote, slot.local);
    if (localInRemote && remoteInLocal) {
      refs.push({ ...base, ref: slot.local, scope: 'local', resolution: 'identical', refs_seen: [slot.local, slot.remote] });
    } else if (localInRemote) {
      refs.push({ ...base, ref: slot.remote, scope: 'remote', resolution: 'remote-descendant', refs_seen: [slot.local, slot.remote] });
    } else if (remoteInLocal) {
      refs.push({ ...base, ref: slot.local, scope: 'local', resolution: 'local-descendant', refs_seen: [slot.local, slot.remote] });
    } else {
      refs.push({ ...base, ref: null, scope: null, resolution: 'divergent', divergent: true, refs_seen: [slot.local, slot.remote] });
    }
  }
  return refs.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The commits a ref carries relative to its merge base with the default
 * branch, each with subject, parent count and the files it changed.
 *
 * Merges ARE walked (`rev-list` without `--no-merges`) so the census can
 * account for them by name instead of silently narrowing the denominator;
 * they carry `merge: true` and an empty file list, because `diff-tree` against
 * a multi-parent commit names no single-parent delta.
 *
 * Never throws. A ref whose range cannot be bounded degrades to
 * `{ ok: false, reason: 'no-merge-base' }` and a git failure to
 * `'git-command-failed'` — one sick ref never kills the collection.
 */
function commitsForRef(repoRoot, ref, opts) {
  const o = opts || {};
  // Ask first whether git can be asked at all. Without this probe, "this is
  // not a repository" and "these histories are unrelated" both surface as a
  // failed merge-base and get the same name — and a reason that covers two
  // different facts tells a reader neither of them.
  try {
    git(repoRoot, ['rev-parse', '--git-dir']);
  } catch {
    return { ok: false, ref, base: null, reason: 'git-command-failed', commits: [] };
  }

  let base = null;
  try {
    const def = o.defaultBranch || gitDefaultBranch(repoRoot);
    base = git(repoRoot, ['merge-base', ref, def]).trim();
  } catch {
    return { ok: false, ref, base: null, reason: 'no-merge-base', commits: [] };
  }
  if (!base) return { ok: false, ref, base: null, reason: 'no-merge-base', commits: [] };

  let shas = [];
  try {
    shas = git(repoRoot, ['rev-list', `${base}..${ref}`]).split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return { ok: false, ref, base, reason: 'git-command-failed', commits: [] };
  }

  const commits = [];
  for (const sha of shas) {
    let subject = '';
    let parents = [];
    try {
      const raw = git(repoRoot, ['show', '-s', '--format=%s%x00%P', sha]);
      const [s, p] = raw.split('\0');
      subject = (s || '').trim();
      parents = (p || '').trim().split(/\s+/).filter(Boolean);
    } catch {
      return { ok: false, ref, base, reason: 'git-command-failed', commits: [] };
    }
    const merge = parents.length > 1;
    let files = [];
    if (!merge) {
      try {
        // `-z` is load-bearing, and the mechanism is narrower than "newlines
        // split a path in two": git C-QUOTES a path containing LF in non-`-z`
        // output, so such a path arrives MANGLED (an escaped literal matching
        // no declared path) rather than split. A trailing space is genuinely
        // mutated by `trim()`. Both push coverage down, not up — conceded in
        // the S02 review anyway because the fix is two lines and the repo
        // already fixed this pattern next door: `gitListTracked`
        // (forge-vcs.js) uses `ls-files -z` for exactly this reason. No
        // `trim()` here: with NUL delimitation there is nothing to trim, and
        // trimming is the mutation.
        files = git(repoRoot, ['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', sha])
          .split('\0').filter(Boolean);
      } catch {
        return { ok: false, ref, base, reason: 'git-command-failed', commits: [] };
      }
    }
    commits.push({ sha, subject, merge, files });
  }
  return { ok: true, ref, base, reason: null, commits };
}

/**
 * Split one ref's commits into per-unit buckets plus a NAMED remainder.
 *
 * `ownerId`/`ownerKind` come from the ref name — the caller has already
 * scoped this call, and this function has no way to ask history at large.
 *
 * Loose-task refs (`forge/T-<id>`) attribute the WHOLE range to the task's
 * single unit without requiring an `S##/T##` scope: loose tasks do not use
 * that scope at all (measured — the only commit of `forge/T-20260811190103`
 * carries none), so demanding it would report a task that plainly did work as
 * having written nothing.
 *
 * Reconciliation is returned, not assumed: `walked === attributed +
 * unattributed.length` holds by construction and the caller asserts it.
 */
function attributeCommits(commits, ownerId, ownerKind) {
  const units = new Map();
  const unattributed = [];
  let attributed = 0;

  const put = (key, slice, task, c) => {
    if (!units.has(key)) {
      units.set(key, { unit: key, owner: ownerId, owner_kind: ownerKind, slice, task, commits: [], files: [] });
    }
    const u = units.get(key);
    u.commits.push(c.sha);
    for (const f of c.files) if (!u.files.includes(f)) u.files.push(f);
    attributed++;
  };

  for (const c of commits) {
    if (ownerKind === 'task') {
      // Whole range → the task's one unit. Merges included: the ref itself is
      // the axis here, so a merge inside the range still belongs to this task
      // (it simply contributes no files).
      put(unitKeyFor(ownerId, null, null), null, null, c);
      continue;
    }
    if (c.merge) {
      unattributed.push({ sha: c.sha, subject: c.subject, reason: 'merge-commit' });
      continue;
    }
    const m = UNIT_SCOPE_RE.exec(c.subject);
    if (!m) {
      unattributed.push({ sha: c.sha, subject: c.subject, reason: 'no-unit-marker' });
      continue;
    }
    put(unitKeyFor(ownerId, m[1], m[2]), m[1], m[2], c);
  }

  for (const u of units.values()) u.files.sort();
  return { units: Array.from(units.values()), unattributed, attributed, walked: commits.length };
}

/**
 * svn side (B3). There is no ref axis in Subversion, so the milestone owner
 * has to come from somewhere else — and "somewhere else" is allowed to be
 * exactly two things, both explicit:
 *
 *   1. the message names a full milestone/task id, or
 *   2. the context supplies EXACTLY ONE candidate milestone.
 *
 * Anything else — two or more candidates and no id in the message — is
 * `ambiguous-unit-owner`. Picking "the most likely" candidate there would be
 * the wildcard this module exists to refuse (S01 rule R4): it would raise
 * `units_measured` by inventing ownership.
 */
function attributeSvnRevisions(revisions, opts) {
  const o = opts || {};
  const candidates = Array.isArray(o.milestoneCandidates) ? o.milestoneCandidates.filter(Boolean) : [];
  const units = new Map();
  const unattributed = [];
  const skipped = [];
  let attributed = 0;

  for (const r of (revisions || [])) {
    const msg = typeof r.msg === 'string' ? r.msg : '';
    const subject = msg.split('\n')[0].trim();
    const m = UNIT_SCOPE_RE.exec(subject);
    if (!m) {
      unattributed.push({ sha: `r${r.rev}`, subject, reason: 'no-unit-marker' });
      continue;
    }
    // Owner: a full id spelled out in the message wins over context; context
    // only decides when it is unambiguous on its own.
    const named = candidates.find((c) => msg.includes(c));
    const owner = named || (candidates.length === 1 ? candidates[0] : null);
    if (!owner) {
      skipped.push({ unit: `${m[1]}/${m[2]}`, rev: r.rev, reason: 'ambiguous-unit-owner' });
      unattributed.push({ sha: `r${r.rev}`, subject, reason: 'ambiguous-unit-owner' });
      continue;
    }
    const key = unitKeyFor(owner, m[1], m[2]);
    if (!units.has(key)) {
      units.set(key, { unit: key, owner, owner_kind: entityKind(owner), slice: m[1], task: m[2], commits: [], files: [] });
    }
    const u = units.get(key);
    u.commits.push(`r${r.rev}`);
    for (const p of (r.paths || [])) if (!u.files.includes(p.path)) u.files.push(p.path);
    attributed++;
  }

  for (const u of units.values()) u.files.sort();
  return {
    units: Array.from(units.values()),
    unattributed,
    skipped,
    attributed,
    walked: (revisions || []).length,
  };
}

/**
 * The whole picture for one repository: every unit ref, every commit walked,
 * every remainder named.
 *
 * `opts.svnLog` injects the log reader (defaults to the real
 * `svnLogChangedPaths`) so the `svn-log-failed` degradation is testable on a
 * machine without svn — the reason must be provable, not asserted.
 */
function writtenByUnit(repoRoot, opts) {
  const o = opts || {};
  const vcs = o.vcs || detectVcs(repoRoot);

  if (vcs === 'svn') {
    const reader = typeof o.svnLog === 'function' ? o.svnLog : svnLogChangedPaths;
    // The reader is allowed to THROW (svn binary absent → `spawn svn ENOENT`),
    // and before the S02 review R1 that exception escaped this function
    // entirely: no `skipped` entry, no report, and the CLI's `main` swallowed
    // it into exit 0 — a consumer reading exit code + stdout could not tell
    // failure from success. The comment above promises the opposite in so many
    // words ("the reason must be provable, not asserted"), so the throw is
    // caught here and degrades to the SAME structured `svn-log-failed` shape a
    // non-zero exit produces, carrying the message in `detail`.
    let log;
    try {
      log = reader(repoRoot, o);
    } catch (e) {
      log = { ok: false, error: 'svn-log-failed', detail: (e && e.message) || String(e) };
    }
    if (!log || !log.ok) {
      return {
        vcs: 'svn', repo: repoRoot, units: [], units_measured: 0,
        refs_examined: 0, commits_walked: 0, attributed: 0, unattributed: [],
        skipped: [{ unit: null, reason: 'svn-log-failed', detail: (log && (log.detail || log.error)) || 'svn-log-failed' }],
      };
    }
    const a = attributeSvnRevisions(log.revisions, o);
    return {
      vcs: 'svn', repo: repoRoot,
      units: a.units, units_measured: a.units.length,
      refs_examined: 0,
      commits_walked: a.walked, attributed: a.attributed, unattributed: a.unattributed,
      skipped: a.skipped,
    };
  }

  if (vcs !== 'git') {
    return {
      vcs, repo: repoRoot, units: [], units_measured: 0,
      refs_examined: 0, commits_walked: 0, attributed: 0, unattributed: [],
      skipped: [{ unit: null, reason: 'vcs-unsupported', detail: String(vcs) }],
    };
  }

  const refs = o.refs || listUnitRefs(repoRoot);
  const defaultBranch = o.defaultBranch || gitDefaultBranch(repoRoot);
  const units = [];
  const unattributed = [];
  const skipped = [];
  let walked = 0;
  let attributed = 0;

  for (const r of refs) {
    if (r.divergent || !r.ref) {
      // Two refs for one id and neither contains the other: there is no single
      // range to walk. Both spellings ride along so the reader can reproduce
      // the refusal instead of taking it on faith.
      skipped.push({ unit: r.id, ref: null, refs: r.refs_seen || [], reason: 'ref-divergent' });
      continue;
    }
    const got = commitsForRef(repoRoot, r.ref, { defaultBranch });
    if (!got.ok) {
      skipped.push({ unit: r.id, ref: r.ref, reason: got.reason });
      continue;
    }
    const a = attributeCommits(got.commits, r.id, r.kind);
    walked += a.walked;
    attributed += a.attributed;
    for (const u of a.units) units.push({ ...u, ref: r.ref, kind: r.kind });
    for (const c of a.unattributed) unattributed.push({ ...c, ref: r.ref });
    if (a.units.length === 0) {
      // A ref that exists but carries no commit with this unit's scope is a
      // real, nameable outcome — never 0% coverage and never 100%.
      skipped.push({ unit: r.id, ref: r.ref, reason: 'no-attributed-commits' });
    }
  }

  return {
    vcs: 'git', repo: repoRoot, default_branch: defaultBranch,
    units, units_measured: units.length,
    refs_examined: refs.length,
    commits_walked: walked, attributed, unattributed, skipped,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────
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

const USAGE = `forge-unit-delta — files each GSD unit actually wrote, from the VCS

Flags:
  --cwd <path>   repository root (default: process.cwd())
  --json         emit JSON instead of the human-readable form
  --help         this text

Read-only VCS access. Advisory about WHAT it finds — exit 0 whenever a report
was produced, including one that is entirely skipped. Exit 2 ONLY when no
report exists at all (an exception escaped the measurement): a run that
produced nothing must not be indistinguishable from a run that measured and
found nothing (S02 review R2).
`;

function formatReport(rep) {
  const lines = [
    `vcs=${rep.vcs} refs=${rep.refs_examined} units=${rep.units_measured}`,
    `commits: walked=${rep.commits_walked} attributed=${rep.attributed} unattributed=${rep.unattributed.length}`,
  ];
  for (const u of rep.units) lines.push(`  ${u.unit}  ${u.files.length} arquivo(s)`);
  for (const s of rep.skipped) lines.push(`  (skip) ${s.unit || '-'} — ${s.reason}`);
  return lines.join('\n');
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(USAGE); return 0; }
  const cwd = typeof args.cwd === 'string' ? args.cwd : process.cwd();
  try {
    const rep = writtenByUnit(cwd, {});
    process.stdout.write(args.json ? `${JSON.stringify(rep, null, 2)}\n` : `${formatReport(rep)}\n`);
  } catch (e) {
    // No report was written. Exit 0 here would render "the measurement never
    // ran" identically to "the measurement ran and found nothing".
    process.stderr.write(`forge-unit-delta: ${e.message}\n`);
    return 2;
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  listUnitRefs,
  commitsForRef,
  attributeCommits,
  attributeSvnRevisions,
  writtenByUnit,
  unitKeyFor,
  DELTA_REASONS,
  UNIT_SCOPE_RE,
  parseArgs,
  main,
  USAGE,
  _private: { git, formatReport, isAncestorOf },
};
