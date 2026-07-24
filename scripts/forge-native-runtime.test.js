#!/usr/bin/env node
'use strict';

// Static contracts for Claude Code native-runtime integration. These checks
// intentionally avoid a YAML dependency so they also run in a clean install.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  process.stdout.write(`  ✓ ${name}\n`);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function frontmatter(content, fileName) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert(match, `${fileName} must start with YAML frontmatter`);

  const fields = Object.create(null);
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (field) fields[field[1]] = field[2];
  }
  return fields;
}

function csvField(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const agentDir = path.join(root, 'agents');
const agentFiles = fs.readdirSync(agentDir)
  .filter((name) => /^forge-.*\.md$/.test(name))
  .sort();

test('every Forge agent has a bounded positive integer maxTurns', () => {
  assert(agentFiles.length > 0, 'expected at least one agents/forge-*.md file');

  for (const fileName of agentFiles) {
    const fields = frontmatter(read(path.join('agents', fileName)), fileName);
    assert.match(
      fields.maxTurns || '',
      /^[1-9]\d*$/,
      `${fileName} maxTurns must be a positive integer`,
    );

    const maxTurns = Number(fields.maxTurns);
    assert(
      maxTurns >= 4 && maxTurns <= 100,
      `${fileName} maxTurns=${maxTurns} is outside the reasonable 4..100 bound`,
    );
  }
});

test('forge-memory uses low effort and a short turn budget', () => {
  const fields = frontmatter(read(path.join('agents', 'forge-memory.md')), 'forge-memory.md');
  assert.strictEqual(fields.effort, 'low');
  assert(Number(fields.maxTurns) <= 24, 'forge-memory should stay cheaper than implementation agents');
});

test('orchestrator skills allow native SendMessage continuation', () => {
  for (const skill of ['forge-auto', 'forge-next', 'forge-task']) {
    const fileName = path.join('skills', skill, 'SKILL.md');
    const fields = frontmatter(read(fileName), fileName);
    assert(
      csvField(fields['allowed-tools']).includes('SendMessage'),
      `${fileName} allowed-tools must include SendMessage`,
    );
  }
});

test('dialectic review reuses the reviewer and keeps a compatibility fallback', () => {
  const review = read(path.join('shared', 'forge-review.md'));
  assert.match(review, /REVIEWER_AGENT_ID/);
  assert.match(review, /SendMessage\s*\(\s*\{[\s\S]*?to:\s*REVIEWER_AGENT_ID/);
  assert.match(review, /Compatibility fallback/i);
  assert.match(review, /review-resume-fallback/);
  assert.match(review, /legacy fresh dispatch/i);
  assert.match(review, /CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1/);
  assert.match(review, /Forge never enables that experimental\s+flag itself/i);
});

test('SubagentStop repairs result-producing agents but excludes forge-memory', () => {
  const hook = read(path.join('scripts', 'forge-hook.js'));
  const setMatch = hook.match(/const RESULT_BLOCK_AGENTS\s*=\s*new Set\(\[([\s\S]*?)\]\);/);
  assert(setMatch, 'forge-hook.js must declare RESULT_BLOCK_AGENTS as a literal Set');

  const members = new Set(
    Array.from(setMatch[1].matchAll(/['"](forge-[a-z-]+)['"]/g), (match) => match[1]),
  );

  assert(!members.has('forge-memory'), 'command-only forge-memory must not be blocked');
  assert(members.has('forge-executor'), 'forge-executor must be protected by the result contract');
  assert(members.has('forge-worker'), 'forge-worker must be protected by the result contract');
  assert(members.has('forge-completer'), 'forge-completer must be protected by the result contract');
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
