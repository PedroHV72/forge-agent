#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateCodeDirBoundary } = require('./forge-isolation.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-isolation-Ω space-'));
const workspace = path.join(root, 'workspace – root');
const repo = path.join(workspace, 'repo');
const secondRepo = path.join(workspace, 'second-repo');
const outside = path.join(root, 'outside');
for (const directory of [workspace, repo, secondRepo, outside]) fs.mkdirSync(directory, { recursive: true });

try {
  const accepted = validateCodeDirBoundary({ workspaceRoot: workspace, codeDir: repo, declaredCodeDir: repo, repoRoots: [repo] });
  assert.strictEqual(accepted.ok, true);
  assert.strictEqual(accepted.reason_code, 'code-dir-verified');

  assert.strictEqual(validateCodeDirBoundary({ workspaceRoot: workspace, codeDir: outside, declaredCodeDir: outside, repoRoots: [outside] }).reason_code, 'code-dir-outside-workspace');
  assert.strictEqual(validateCodeDirBoundary({ workspaceRoot: workspace, codeDir: repo, declaredCodeDir: repo, repoRoots: [repo, secondRepo] }).reason_code, 'multirepo-refused');
  assert.strictEqual(validateCodeDirBoundary({ workspaceRoot: workspace, codeDir: repo, declaredCodeDir: secondRepo, repoRoots: [repo] }).reason_code, 'code-dir-undeclared');
  assert.strictEqual(validateCodeDirBoundary({ workspaceRoot: workspace, codeDir: repo, declaredCodeDir: repo, repoRoots: [] }).reason_code, 'multirepo-refused');
  assert.strictEqual(validateCodeDirBoundary({ workspaceRoot: workspace, codeDir: repo, declaredCodeDir: repo }).reason_code, 'multirepo-refused');

  // The same lexical vectors are exercised for every supported adapter label;
  // the pure boundary never consults shell quoting or process.platform.
  for (const platform of ['win32', 'darwin', 'linux']) {
    const result = validateCodeDirBoundary({ platform, workspaceRoot: workspace, codeDir: repo, declaredCodeDir: repo, repoRoots: [repo] });
    assert.deepStrictEqual(result, accepted, `${platform} boundary is identical`);
  }
  console.log('forge-isolation boundary tests passed (single-repo; 3 platform vectors)');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
