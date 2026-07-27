#!/usr/bin/env node
'use strict';

// TASK-018 — the refusal explains itself, and the doctor can list every plan that will
// hit it. Two units under test:
//   1. forge-code-dir.js `hint` — actionable prose on each refusal, verdict untouched.
//   2. forge-doctor.js checkPlanRepoDeclared — which PENDING plans lack `repo:`.
// Both counterfactual by construction: pre-change, `hint` is undefined and the doctor
// export does not exist.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { spawnSync } = require('child_process');

const { resolveCodeDir, hintFor } = require('./forge-code-dir.js');
const { checkPlanRepoDeclared, VALID_CHECKS } = require('./forge-doctor.js');

const DOCTOR_CLI = path.join(__dirname, 'forge-doctor.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL ${name}\n    ${error && error.message}\n`);
  }
}

function mkTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `forge-${label}-`));
}

function mkGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function writePlan(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

// ── 1. hint on the resolver ─────────────────────────────────────────────────

function withMultiRepoFixture(fn) {
  const root = mkTmp('t018-resolve');
  try {
    const api = path.join(root, 'api');
    const web = path.join(root, 'web');
    mkGitRepo(api);
    mkGitRepo(web);
    const wt = name => path.join(root, '.forge-worktrees', 'TASK-018', name);
    const iso = {
      mode: 'worktree',
      repos: [
        { path: api, branch: 'forge/TASK-018', worktree: wt('api'), status: 'created' },
        { path: web, branch: 'forge/TASK-018', worktree: wt('web'), status: 'created' },
      ],
    };
    fn({ root, api, web, iso, wt });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('plan without repo: in a multi-repo workspace refuses AND explains itself', () => {
  withMultiRepoFixture(({ root, iso }) => {
    // Greenfield paths (nothing on disk) so the fs probe cannot resolve them.
    const plan = writePlan(path.join(root, 'plan-none.md'), [
      '---', 'id: T01', 'writes:', '  - "does/not/exist/a.ts"', '---', '', '# plan',
    ]);
    const out = resolveCodeDir({ isoResult: iso, planPath: plan, cwd: root, run: 'TASK-018' });
    assert.strictEqual(out.status, 'undeclared', 'verdict must stay a refusal');
    assert.ok(out.hint && out.hint.length > 0, 'hint must not be empty on refusal');
    assert.ok(out.hint.includes('repo:'), 'hint must name the `repo:` field');
    assert.ok(/forge-doctor/.test(out.hint), 'hint must point at /forge-doctor');
    assert.ok(/automaticamente/.test(out.hint), 'hint must say nothing fills it automatically (D3)');
  });
});

test('a valid repo: declaration still resolves, with an empty hint (D4 — no verdict regressed)', () => {
  withMultiRepoFixture(({ root, iso, web, wt }) => {
    const plan = writePlan(path.join(root, 'plan-declared.md'), [
      '---', 'id: T01', 'repo: web', 'writes:', '  - "does/not/exist/a.ts"', '---', '', '# plan',
    ]);
    const out = resolveCodeDir({ isoResult: iso, planPath: plan, cwd: root, run: 'TASK-018' });
    assert.strictEqual(out.status, 'ok');
    assert.strictEqual(out.resolution, 'declared');
    assert.strictEqual(out.code_dir, wt('web'));
    assert.strictEqual(out.repo, web);
    assert.strictEqual(out.hint, '', 'an accepted resolution carries no hint');
  });
});

test('unknown and conflicting declarations produce distinct, non-empty hints', () => {
  withMultiRepoFixture(({ root, iso }) => {
    const unknownPlan = writePlan(path.join(root, 'plan-unknown.md'), [
      '---', 'id: T01', 'repo: nonesuch', 'writes:', '  - "does/not/exist/a.ts"', '---', '', '# plan',
    ]);
    const unknown = resolveCodeDir({ isoResult: iso, planPath: unknownPlan, cwd: root });
    assert.strictEqual(unknown.status, 'undeclared');
    assert.strictEqual(unknown.declared_repo_status, 'unknown');
    assert.ok(unknown.hint.includes('nonesuch'), 'unknown hint names the bad value');

    // `repo: api` while every declared path attributes to web/ → conflict.
    const conflictPlan = writePlan(path.join(root, 'plan-conflict.md'), [
      '---', 'id: T02', 'repo: api', 'writes:', '  - "web/src/a.ts"', '---', '', '# plan',
    ]);
    const conflict = resolveCodeDir({ isoResult: iso, planPath: conflictPlan, cwd: root });
    assert.strictEqual(conflict.status, 'undeclared');
    assert.strictEqual(conflict.declared_repo_status, 'conflict');
    assert.ok(conflict.hint.length > 0, 'conflict hint is not empty');
    assert.ok(/writes:/.test(conflict.hint), 'conflict hint offers both sides of the fix');
    assert.notStrictEqual(conflict.hint, unknown.hint, 'each cause gets its own explanation');
  });
});

test('cross-repo refusal explains splitting the unit', () => {
  withMultiRepoFixture(({ root, iso }) => {
    const plan = writePlan(path.join(root, 'plan-both.md'), [
      '---', 'id: T03', 'writes:', '  - "api/src/a.ts"', '  - "web/src/b.ts"', '---', '', '# plan',
    ]);
    const out = resolveCodeDir({ isoResult: iso, planPath: plan, cwd: root });
    assert.strictEqual(out.status, 'cross-repo');
    assert.ok(out.hint.length > 0 && /divida/i.test(out.hint), 'cross-repo hint tells the operator to split');
  });
});

test('hintFor is pure and silent for accepted statuses', () => {
  assert.strictEqual(hintFor({ status: 'ok' }), '');
  assert.strictEqual(hintFor({ status: 'shared' }), '');
  assert.strictEqual(hintFor(), '');
});

// ── 2. the doctor layer ─────────────────────────────────────────────────────

test('single-repo workspace skips the check entirely', () => {
  const root = mkTmp('t018-single');
  try {
    mkGitRepo(root);
    writePlan(path.join(root, '.gsd', 'tasks', 'TASK-900', 'TASK-900-PLAN.md'),
      ['---', 'id: TASK-900', '---', '', '# plan']);
    const r = checkPlanRepoDeclared(root);
    assert.strictEqual(r.skipped, 'single-repo');
    assert.deepStrictEqual(r.plans, []);
    assert.strictEqual(r.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('multi-repo workspace lists ONLY the pending plan without repo:', () => {
  const root = mkTmp('t018-doctor');
  try {
    mkGitRepo(path.join(root, 'api'));
    mkGitRepo(path.join(root, 'web'));
    const slice = path.join(root, '.gsd', 'milestones', 'M001', 'slices', 'S01', 'tasks');

    // (1) pending, no repo: → the only expected finding.
    writePlan(path.join(slice, 'T01', 'T01-PLAN.md'), ['---', 'id: T01', '---', '', '# plan']);
    // (2) no repo: but already executed (sibling SUMMARY) → ignored.
    writePlan(path.join(slice, 'T02', 'T02-PLAN.md'), ['---', 'id: T02', '---', '', '# plan']);
    fs.writeFileSync(path.join(slice, 'T02', 'T02-SUMMARY.md'), '# done\n', 'utf8');
    // (3) archived → never read.
    writePlan(path.join(root, '.gsd', 'archive', 'M000', 'slices', 'S01', 'tasks', 'T09', 'T09-PLAN.md'),
      ['---', 'id: T09', '---', '', '# plan']);
    // (4) declares repo: → fine.
    writePlan(path.join(slice, 'T03', 'T03-PLAN.md'), ['---', 'id: T03', 'repo: api', '---', '', '# plan']);
    // (5) status: DONE → ignored even without a SUMMARY sibling.
    writePlan(path.join(slice, 'T04', 'T04-PLAN.md'), ['---', 'id: T04', 'status: DONE', '---', '', '# plan']);

    const r = checkPlanRepoDeclared(root);
    assert.strictEqual(r.ok, true, 'the layer is advisory — it never fails');
    assert.deepStrictEqual(r.plans, ['.gsd/milestones/M001/slices/S01/tasks/T01/T01-PLAN.md']);
    assert.ok(/sidecar-code-dir-undeclared/.test(r.message), 'the message names the consequence');
    assert.ok(/--fix/.test(r.message), 'the message states that --fix does not fill it (D3)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loose tasks under .gsd/tasks are scanned too', () => {
  const root = mkTmp('t018-loose');
  try {
    mkGitRepo(path.join(root, 'api'));
    mkGitRepo(path.join(root, 'web'));
    writePlan(path.join(root, '.gsd', 'tasks', 'TASK-901', 'TASK-901-PLAN.md'),
      ['---', 'id: TASK-901', '---', '', '# plan']);
    const r = checkPlanRepoDeclared(root);
    assert.deepStrictEqual(r.plans, ['.gsd/tasks/TASK-901/TASK-901-PLAN.md']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepted checks (--check dispatch) and advertised checks (unknown-check + --help) are set-equal', () => {
  // ACCEPTED: every name in VALID_CHECKS must be dispatched (exit 0/1, never 2 "unknown check").
  // A workspace with zero repos is fine — every check tolerates that; we only care exit != 2.
  const root = mkTmp('t018-guard');
  try {
    for (const name of VALID_CHECKS) {
      const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', name, '--cwd', root], { encoding: 'utf8' });
      assert.notStrictEqual(r.status, 2, `--check ${name} must be accepted, got exit ${r.status}: ${r.stderr}`);
    }

    // ADVERTISED (unknown-check stderr message): parse the "Valid: a, b, c, all" line.
    const bad = spawnSync(process.execPath, [DOCTOR_CLI, '--check', '__nope__', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(bad.status, 2, 'unknown check must exit 2');
    const stderrMatch = /Valid: (.+)\n?$/.exec(bad.stderr);
    assert.ok(stderrMatch, 'unknown-check stderr must list valid checks');
    const advertisedStderr = stderrMatch[1].split(',').map(s => s.trim()).filter(s => s !== 'all');

    // ADVERTISED (--help text): parse the "run check: a | b | c |\n  all" block.
    const help = spawnSync(process.execPath, [DOCTOR_CLI, '--help'], { encoding: 'utf8' });
    const helpMatch = /run check: ([\s\S]+?)\n\s*all\n/.exec(help.stdout);
    assert.ok(helpMatch, '--help stdout must list valid checks');
    const advertisedHelp = helpMatch[1].split('|').map(s => s.trim()).filter(Boolean);

    const accepted = VALID_CHECKS.slice().sort();
    assert.deepStrictEqual(advertisedStderr.slice().sort(), accepted, 'unknown-check message must match VALID_CHECKS exactly');
    assert.deepStrictEqual(advertisedHelp.slice().sort(), accepted, '--help text must match VALID_CHECKS exactly');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
