#!/usr/bin/env node
'use strict';

// Contract tests for the single formulation of "is this destination ours?".
//
// The defect being closed: ownership proof lived INSIDE the file, so a format
// without comment syntax could never carry it and froze on first divergence
// while every run reported success. The digest rung is the proof that does not
// need the file's cooperation.

const assert = require('assert');
const ownership = require('./forge-projection-ownership');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }

try {
  // ── digest ────────────────────────────────────────────────────────────────

  test('line endings are not content — CRLF and LF digest identically', () => {
    assert.strictEqual(
      ownership.digest('a\r\nb\r\n'),
      ownership.digest('a\nb\n'),
      'um checkout com autocrlf reportaria todo destino como editado pelo operador',
    );
  });

  test('different content digests differently — the probe is not constant', () => {
    assert.notStrictEqual(ownership.digest('a\n'), ownership.digest('b\n'));
  });

  // ── decide: the ladder, rung by rung ──────────────────────────────────────

  test('nothing on disk is ours — a fresh install always projects', () => {
    for (const current of [null, undefined]) {
      const v = ownership.decide({ current, recordedDigest: undefined, markerPresent: false });
      assert.deepStrictEqual(v, { ours: true, basis: 'absent' });
    }
  });

  test('a marked file stays ours — the pre-existing rung is never narrowed', () => {
    const v = ownership.decide({ current: 'qualquer coisa', markerPresent: true });
    assert.strictEqual(v.ours, true);
    assert.strictEqual(v.basis, 'marker');
  });

  test('THE FIX: an unmarked file whose bytes match the record is ours', () => {
    const body = '{"schema":1}\n';
    const v = ownership.decide({
      current: body,
      recordedDigest: ownership.digest(body),
      markerPresent: false,
    });
    assert.strictEqual(v.ours, true, 'JSON sem marcador continua congelando');
    assert.strictEqual(v.basis, 'digest');
  });

  test('an unmarked file whose bytes DIFFER from the record is not ours', () => {
    const v = ownership.decide({
      current: '{"schema":1,"editado":true}\n',
      recordedDigest: ownership.digest('{"schema":1}\n'),
      markerPresent: false,
    });
    assert.strictEqual(v.ours, false, 'edição do operador seria sobrescrita');
    assert.strictEqual(v.basis, null);
  });

  test('an unmarked file with NO record is not ours — absence of proof is not proof', () => {
    const v = ownership.decide({ current: 'legado\n', recordedDigest: undefined, markerPresent: false });
    assert.strictEqual(v.ours, false);
  });

  test('--migrate-legacy adopts regardless — the operator escape is unchanged', () => {
    const v = ownership.decide({
      current: 'legado sem marcador\n', recordedDigest: undefined, markerPresent: false, migrateLegacy: true,
    });
    assert.strictEqual(v.ours, true);
    assert.strictEqual(v.basis, 'migrate-legacy');
  });

  test('the digest can GRANT ownership but never revoke it — the documented non-change', () => {
    // A marked file whose bytes no longer match the record: hash-first would call
    // this an operator edit and refuse. That is defensible and deliberately NOT
    // what this module does, because it would turn files that update today into
    // conflicts. Asserted so the decision is on record, not accidental.
    const v = ownership.decide({
      current: 'editado mas ainda marcado\n',
      recordedDigest: ownership.digest('original\n'),
      markerPresent: true,
    });
    assert.strictEqual(v.ours, true);
    assert.strictEqual(v.basis, 'marker');
  });

  test('an empty-string digest record is ignored, not treated as a match', () => {
    const v = ownership.decide({ current: 'x\n', recordedDigest: '', markerPresent: false });
    assert.strictEqual(v.ours, false, 'um registro vazio virou passe livre');
  });

  // ── decide: rung 5, the one the record cannot reach ───────────────────────
  //
  // `recordOf` records what a run WROTE, and a `user_owned` destination is exactly
  // what a run does not write — so rung 4 is structurally unreachable for a file
  // that was already divergent when it shipped. Rung 5 supplies the proof from
  // outside both the file and our record: the source repo's own history.

  test('THE SECOND FIX: bytes matching a past revision of the source are ours', () => {
    const shipped = '{"schema":1}\n';
    const v = ownership.decide({
      current: shipped,
      recordedDigest: undefined,          // never entered the record: it was preserved, not written
      markerPresent: false,               // JSON cannot carry a marker
      releaseDigests: new Set([ownership.digest(shipped), ownership.digest('{"schema":2}\n')]),
    });
    assert.strictEqual(v.ours, true, 'o destino congelado na estreia continua congelado para sempre');
    assert.strictEqual(v.basis, 'release');
  });

  test('bytes matching no revision are still not ours — the rung only grants', () => {
    const v = ownership.decide({
      current: '{"schema":1,"meu":true}\n',
      markerPresent: false,
      releaseDigests: new Set([ownership.digest('{"schema":1}\n')]),
    });
    assert.strictEqual(v.ours, false, 'edição real do operador seria sobrescrita');
    assert.strictEqual(v.basis, null);
  });

  test('the release digests may be a thunk, and it is NOT evaluated when an earlier rung answers', () => {
    // Reading repo history costs git subprocesses. A clean update must not pay for
    // a single one, so laziness is part of the contract and not an optimization.
    let evaluations = 0;
    const thunk = () => { evaluations += 1; return new Set(); };
    ownership.decide({ current: null, releaseDigests: thunk });
    ownership.decide({ current: 'x', markerPresent: true, releaseDigests: thunk });
    ownership.decide({ current: 'x', markerPresent: false, recordedDigest: ownership.digest('x'), releaseDigests: thunk });
    ownership.decide({ current: 'x', markerPresent: false, migrateLegacy: true, releaseDigests: thunk });
    assert.strictEqual(evaluations, 0, `histórico lido sem necessidade ${evaluations} vez(es)`);
    // ...and it IS evaluated once the earlier rungs have all declined.
    ownership.decide({ current: 'x', markerPresent: false, releaseDigests: thunk });
    assert.strictEqual(evaluations, 1);
  });

  test('a throwing thunk degrades to "not ours" — provenance never breaks an install', () => {
    const v = ownership.decide({
      current: 'x', markerPresent: false,
      releaseDigests: () => { throw new Error('git explodiu'); },
    });
    assert.strictEqual(v.ours, false);
    assert.strictEqual(v.basis, null);
  });

  test('an absent or malformed release set is ignored, not treated as a match', () => {
    for (const releaseDigests of [undefined, null, new Set(), [], 'não é conjunto', 42]) {
      assert.strictEqual(ownership.decide({ current: 'x', markerPresent: false, releaseDigests }).ours, false,
        `um conjunto de releases inválido (${JSON.stringify(releaseDigests)}) virou passe livre`);
    }
    assert.strictEqual(ownership.decide({ current: 'x', markerPresent: false, releaseDigests: ['nope', ownership.digest('x')] }).basis, 'release',
      'um Array de digests deveria ser aceito tanto quanto um Set');
  });

  // ── recordOf ──────────────────────────────────────────────────────────────

  test('recordOf keys by resolved path and digests the content', () => {
    const record = ownership.recordOf([{ destination: '/tmp/a/../a/x.json', content: '{"v":1}\n' }]);
    assert.deepStrictEqual(Object.keys(record), [ownership.keyFor('/tmp/a/x.json')]);
    assert.strictEqual(record[ownership.keyFor('/tmp/a/x.json')], ownership.digest('{"v":1}\n'));
  });

  test('a dry-run entry records nothing — bytes that were never written', () => {
    const record = ownership.recordOf([{ destination: '/tmp/x.json', content: '{}', dry_run: true }]);
    assert.deepStrictEqual(record, {},
      'registrar um dry-run faria a PRÓXIMA execução acreditar que é dona de um arquivo que nunca escreveu');
  });

  test('malformed entries are skipped without throwing', () => {
    const record = ownership.recordOf([null, {}, { destination: '/tmp/y' }, { content: 'só conteúdo' }]);
    assert.deepStrictEqual(record, {});
    assert.deepStrictEqual(ownership.recordOf(undefined), {});
  });

  process.stdout.write(`\nforge-projection-ownership: ${passed} passed\n`);
} catch (err) {
  process.stderr.write(`\nFAIL após ${passed} asserções\n${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
}
