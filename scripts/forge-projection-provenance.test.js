#!/usr/bin/env node
'use strict';

// forge-projection-provenance.test.js — the freeze has an exit, and the exit does
// not adopt what it cannot prove.
//
// The defect: `recordOf` records only what a run WROTE, and a `user_owned`
// destination is exactly what a run does not write. So a destination that was
// already divergent when the digest rung shipped never enters the record, and
// every later run finds no marker and no record and preserves it again — forever.
// Measured on a real 4.8.0 → 4.15.0 update that exited 0: 110 ownership entries
// and not one for the four destinations that same run reported as `user_owned`,
// two of which were byte-identical to their 4.8.0 upstream content.
//
// Every fixture here is a synthetic git repo under os.tmpdir(). Nothing depends
// on this repository's own history or tags, so the suite means the same thing in
// CI, on a shallow clone, and five releases from now.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const provenance = require('./forge-projection-provenance.js');
const ownership = require('./forge-projection-ownership.js');
const claudeRenderer = require('./forge-claude-renderer.js');

let passed = 0;
const dirs = [];
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function temp(label) { const value = fs.mkdtempSync(path.join(os.tmpdir(), `forge-prov-${label}-`)); dirs.push(value); return value; }
function cleanup() { for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } } }

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} falhou: ${result.stderr || result.error}`);
  return result.stdout;
}

// A named skip, never a silent pass: a suite that quietly does nothing when git is
// absent is indistinguishable from one that proves something.
const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8', shell: false });
if (!gitProbe || gitProbe.status !== 0) {
  process.stdout.write('SKIP forge-projection-provenance: git indisponível neste ambiente; nada foi provado\n');
  process.exit(0);
}

function repoWithHistory(label, revisions) {
  const root = temp(label);
  spawnSync('git', ['init', '-q', root], { encoding: 'utf8', shell: false });
  git(root, ['config', 'user.email', 'forge@test.invalid']);
  git(root, ['config', 'user.name', 'Forge Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  // The public surfaces the source-manifest audit requires, so the same fixture
  // can drive the renderer end-to-end below.
  for (const dir of ['agents', 'commands', path.join('skills', 'forge-x'), path.join('shared', 'templates', 'dispatch')]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, dir.includes('skills') ? 'SKILL.md' : 'a.md'), '# fixture\n');
  }
  for (const [index, body] of revisions.entries()) {
    fs.writeFileSync(path.join(root, 'thing.json'), body);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', `rev${index + 1}`]);
  }
  return root;
}

function minimalManifest() {
  const surface = (id, dir) => ({
    source_id: id, owner: 'orchestration', inputs: [dir], render_targets: [{ path: dir, recursive: true }],
    capability: `cap-${id}`, security_role: 'operator', newline: 'lf', origin_header: 'fixture', common: { format: 'markdown' },
  });
  return {
    schema_version: '1.0.0',
    sources: [
      surface('agents', 'agents'), surface('commands', 'commands'), surface('skills', 'skills'),
      surface('dispatch-templates', 'shared/templates/dispatch'),
      {
        source_id: 'configuration', owner: 'configuration', inputs: ['thing.json'],
        render_targets: [{ path: 'thing.json', recursive: false }], capability: 'configuration-forge',
        security_role: 'public', newline: 'lf', origin_header: 'fixture', common: { format: 'json' },
      },
    ],
  };
}

const V1 = '{"schema":1}\n';
const V2 = '{"schema":2}\n';

try {
  // ── A. history answers the question ────────────────────────────────────────

  test('every content a path ever held is in the digest set', () => {
    const repo = repoWithHistory('history', [V1, V2]);
    const result = provenance.historyDigests({ repo, sourcePath: 'thing.json' });
    assert.strictEqual(result.reason, 'ok');
    assert.strictEqual(result.revisions, 2, `revisões distintas esperadas: 2, veio ${result.revisions}`);
    assert(result.digests.has(ownership.digest(V1)), 'a revisão antiga — a que congela instalações — ficou de fora');
    assert(result.digests.has(ownership.digest(V2)));
    assert(!result.digests.has(ownership.digest('{"editado":true}\n')), 'o conjunto aceitou bytes que nunca existiram');
  });

  test('line endings are not content — a CRLF copy of an old revision still matches', () => {
    // This is issue #104 terrain: a Windows checkout hands back CRLF for a file we
    // committed as LF. Comparing git blob ids would depend on whichever clean
    // filter this machine happens to apply; digesting normalized bytes does not.
    const repo = repoWithHistory('crlf', [V1, V2]);
    const resolver = provenance.createResolver({ repo });
    const verdict = resolver.verdictFor('thing.json', V1.replace(/\n/g, '\r\n'));
    assert.strictEqual(verdict.matched, true, 'uma cópia CRLF da nossa própria saída foi lida como edição do operador');
    assert.strictEqual(verdict.reason, provenance.REASONS.RELEASE_MATCH);
  });

  test('bytes that were never committed are named operator-edit, not adopted', () => {
    const repo = repoWithHistory('edited', [V1, V2]);
    const verdict = provenance.createResolver({ repo }).verdictFor('thing.json', '{"schema":2,"meu":true}\n');
    assert.strictEqual(verdict.matched, false);
    assert.strictEqual(verdict.reason, provenance.REASONS.OPERATOR_EDIT);
    assert(verdict.revisions > 0, 'reason operator-edit exige que o histórico tenha sido lido de fato');
  });

  test('the revision bound is honoured and truncation is reported, never assumed harmless', () => {
    const repo = repoWithHistory('bound', [V1, V2, '{"schema":3}\n']);
    const bounded = provenance.historyDigests({ repo, sourcePath: 'thing.json', limit: 1 });
    assert.strictEqual(bounded.truncated, true, 'histórico maior que o limite passou sem dizer que foi cortado');
    assert.strictEqual(bounded.revisions, 1);
    const full = provenance.historyDigests({ repo, sourcePath: 'thing.json' });
    assert.strictEqual(full.truncated, false);
    assert.strictEqual(full.revisions, 3);
  });

  test('a partial read never says operator-edit — that word is reserved for a full history', () => {
    // Blaming the operator for our own blind spot is a confident, unmeasured claim.
    // Truncated read (and, identically, a shallow clone) answers shallow-history.
    const repo = repoWithHistory('shallow', [V1, V2, '{"schema":3}\n']);
    const bounded = provenance.createResolver({ repo, limit: 1 });
    const verdict = bounded.verdictFor('thing.json', V1); // V1 is real, but outside the bound
    assert.strictEqual(verdict.matched, false);
    assert.strictEqual(verdict.reason, provenance.REASONS.SHALLOW_HISTORY,
      'uma leitura parcial acusou o operador de ter editado o que ela simplesmente não conseguiu ver');
    // Control: with the whole history the same bytes ARE ours, so the reason above
    // is about visibility and not about these bytes.
    assert.strictEqual(provenance.createResolver({ repo }).verdictFor('thing.json', V1).reason, provenance.REASONS.RELEASE_MATCH);
  });

  // ── B. degradation is named, never silent ──────────────────────────────────

  test('a directory that is not a git work tree answers no-git, with an empty set', () => {
    const plain = temp('no-git');
    fs.writeFileSync(path.join(plain, 'thing.json'), V1);
    const result = provenance.historyDigests({ repo: plain, sourcePath: 'thing.json' });
    assert.strictEqual(result.reason, provenance.REASONS.NO_GIT);
    assert.strictEqual(result.digests.size, 0);
    assert.strictEqual(provenance.createResolver({ repo: plain }).verdictFor('thing.json', V1).reason, provenance.REASONS.NO_GIT,
      'sem git a resposta precisa continuar sendo "não consegui olhar", nunca "provei que é seu"');
  });

  test('a synthesized artifact with no source file answers no-source', () => {
    const repo = repoWithHistory('synth', [V1]);
    assert.strictEqual(provenance.historyDigests({ repo, sourcePath: 'config.toml' }).reason, provenance.REASONS.NO_SOURCE);
  });

  test('a source file with no revisions answers no-history', () => {
    const repo = repoWithHistory('untracked', [V1]);
    fs.writeFileSync(path.join(repo, 'novo.json'), '{"novo":1}\n');
    assert.strictEqual(provenance.historyDigests({ repo, sourcePath: 'novo.json' }).reason, provenance.REASONS.NO_HISTORY);
  });

  test('a failing git answers git-failed and carries the diagnosis', () => {
    const repo = repoWithHistory('failing', [V1]);
    const result = provenance.historyDigests({
      repo,
      sourcePath: 'thing.json',
      git: (args) => (args[0] === 'rev-parse'
        ? { status: 0, stdout: Buffer.from('.git\n') }
        : { status: 128, stdout: Buffer.alloc(0), stderr: Buffer.from('fatal: repositório corrompido\n') }),
    });
    assert.strictEqual(result.reason, provenance.REASONS.GIT_FAILED);
    assert.match(result.error, /corrompido/);
    assert.strictEqual(result.digests.size, 0);
  });

  test('history is read at most once per source path in a run', () => {
    const repo = repoWithHistory('memo', [V1, V2]);
    let calls = 0;
    const real = provenance.historyDigests;
    const resolver = provenance.createResolver({
      repo,
      git: (args, input) => { calls += 1; return spawnSync('git', ['-C', repo, ...args], { encoding: 'buffer', shell: false, input: input === undefined ? undefined : Buffer.from(String(input), 'utf8') }); },
    });
    resolver.digestsFor('thing.json');
    const afterFirst = calls;
    resolver.digestsFor('thing.json');
    resolver.verdictFor('thing.json', V1);
    assert.strictEqual(calls, afterFirst, `histórico relido: ${calls} chamadas contra ${afterFirst} da primeira consulta`);
    assert(afterFirst > 0 && afterFirst <= 4, `orçamento de subprocessos por caminho estourou: ${afterFirst}`);
    assert.strictEqual(typeof real, 'function');
  });

  // ── C. the renderer end-to-end: a frozen destination thaws ─────────────────

  test('THE FIX: an unmarked destination holding an old revision is adopted, and stays adopted', () => {
    const repo = repoWithHistory('adopt', [V1, V2]);
    const home = temp('adopt-home');
    const options = {
      repo, manifest: minimalManifest(), projectRoot: repo,
      claudeHome: path.join(home, '.claude'), forgeHome: path.join(home, '.forge-agent'), update: true,
    };
    const destination = path.join(options.claudeHome, 'thing.json');
    fs.mkdirSync(options.claudeHome, { recursive: true });
    fs.writeFileSync(destination, V1); // a 4.8.0-era projection: no marker, no record

    // Control first: with the rung disabled this is the OLD behavior — the exact
    // permanent freeze being closed. Without this control the next assert could
    // pass for a reason unrelated to provenance.
    const frozen = claudeRenderer.write({ ...options, ownership: {}, provenance: null });
    assert(frozen.conflicts.some((item) => item.destination === destination),
      'controle: sem a rampa de release este destino deveria estar congelado');
    assert.strictEqual(fs.readFileSync(destination, 'utf8'), V1, 'controle: o congelado foi escrito');

    const adopted = claudeRenderer.write({ ...options, ownership: {} });
    const entry = adopted.written.find((item) => item.destination === destination);
    assert(entry, `o destino congelado não foi adotado; conflitos: ${JSON.stringify(adopted.conflicts)}`);
    assert.strictEqual(entry.reason, 'release-adopted');
    assert.strictEqual(fs.readFileSync(destination, 'utf8'), V2, 'adotou mas não atualizou os bytes');
    assert(!adopted.conflicts.some((item) => item.destination === destination));
    // The report and the action cannot contradict each other: `release-match` is
    // the one provenance reason a PRESERVED destination must never carry. (Caught
    // for real: removing the rung leaves the conflict claiming the bytes are ours
    // while refusing to touch them.)
    assert(!adopted.conflicts.some((item) => item.provenance === provenance.REASONS.RELEASE_MATCH),
      `um destino preservado alega que os bytes são nossos: ${JSON.stringify(adopted.conflicts)}`);

    // Self-sustaining: the run that adopted also recorded, so the NEXT run owns it
    // by record alone. The manual copy that never passes through the installer is
    // precisely what re-froze before, so this is the half that ends the cycle.
    assert(adopted.ownership[ownership.keyFor(destination)], 'a adoção não gravou digest — o ciclo recomeça no próximo update');
    const again = claudeRenderer.write({ ...options, ownership: adopted.ownership, provenance: null });
    assert(!again.conflicts.some((item) => item.destination === destination),
      'com o registro em mão o destino voltou a ser conflito — a adoção não se auto-sustenta');
  });

  test('a clean render spawns no git at all — history is read only for destinations that reach the rung', () => {
    const repo = repoWithHistory('clean', [V1, V2]);
    const home = temp('clean-home');
    let calls = 0;
    const counting = provenance.createResolver({
      repo,
      git: (args, input) => { calls += 1; return spawnSync('git', ['-C', repo, ...args], { encoding: 'buffer', shell: false, input: input === undefined ? undefined : Buffer.from(String(input), 'utf8') }); },
    });
    const options = {
      repo, manifest: minimalManifest(), projectRoot: repo,
      claudeHome: path.join(home, '.claude'), forgeHome: path.join(home, '.forge-agent'), ownership: {}, provenance: counting,
    };
    const fresh = claudeRenderer.write(options);           // nothing on disk: rung 1 answers everything
    assert(fresh.written.length > 0, 'controle: o render limpo não escreveu nada, então não mede nada');
    assert.strictEqual(calls, 0, `um render limpo gastou ${calls} subprocessos de git`);
    const second = claudeRenderer.write({ ...options, ownership: fresh.ownership, update: true }); // all already-current
    assert.strictEqual(second.conflicts.length, 0);
    assert.strictEqual(calls, 0, `um update sem conflito gastou ${calls} subprocessos de git`);
    assert.deepStrictEqual(counting.consulted(), [], 'a proveniência foi consultada sem necessidade');
  });

  test('a genuinely edited destination stays preserved, and says why', () => {
    const repo = repoWithHistory('preserve', [V1, V2]);
    const home = temp('preserve-home');
    const options = {
      repo, manifest: minimalManifest(), projectRoot: repo,
      claudeHome: path.join(home, '.claude'), forgeHome: path.join(home, '.forge-agent'), update: true, ownership: {},
    };
    const destination = path.join(options.claudeHome, 'thing.json');
    fs.mkdirSync(options.claudeHome, { recursive: true });
    fs.writeFileSync(destination, '{"schema":1,"meu":true}\n');

    const report = claudeRenderer.write(options);
    const conflict = report.conflicts.find((item) => item.destination === destination);
    assert(conflict, 'a edição real do operador foi adotada — exatamente o que a rampa não pode fazer');
    assert.strictEqual(fs.readFileSync(destination, 'utf8'), '{"schema":1,"meu":true}\n', 'os bytes do operador foram sobrescritos');
    assert.strictEqual(conflict.provenance, provenance.REASONS.OPERATOR_EDIT,
      'o preservado não diz em que base foi preservado — "provei que é seu" e "não consegui olhar" não podem ler igual');
    assert.match(conflict.digest, /^[0-9a-f]{64}$/, 'o conflito não registra o digest observado');
    assert(conflict.revisions_checked > 0, 'o conflito alega edição sem ter lido revisão nenhuma');
  });

  test('outside a git repo the renderer preserves and names no-git — the rung never guesses', () => {
    const plain = temp('render-no-git');
    for (const dir of ['agents', 'commands', path.join('skills', 'forge-x'), path.join('shared', 'templates', 'dispatch')]) {
      fs.mkdirSync(path.join(plain, dir), { recursive: true });
      fs.writeFileSync(path.join(plain, dir, dir.includes('skills') ? 'SKILL.md' : 'a.md'), '# fixture\n');
    }
    fs.writeFileSync(path.join(plain, 'thing.json'), V2);
    const home = temp('render-no-git-home');
    const destination = path.join(home, '.claude', 'thing.json');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(destination, V1);
    const report = claudeRenderer.write({
      repo: plain, manifest: minimalManifest(), projectRoot: plain,
      claudeHome: path.join(home, '.claude'), forgeHome: path.join(home, '.forge-agent'), update: true, ownership: {},
    });
    const conflict = report.conflicts.find((item) => item.destination === destination);
    assert(conflict, 'sem histórico para consultar, o destino tinha de continuar preservado');
    assert.strictEqual(conflict.provenance, provenance.REASONS.NO_GIT);
    assert.strictEqual(fs.readFileSync(destination, 'utf8'), V1);
  });

  process.stdout.write(`\nforge-projection-provenance: ${passed} passed, 0 failed\n`);
} catch (error) {
  process.stderr.write(`\nFAIL após ${passed} asserções\n${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
} finally {
  cleanup();
}
