#!/usr/bin/env node
'use strict';

// forge-claim-audit-write.test.js — the detector WRITES its own section, in all
// three verdicts, and emits the `work-lost` event BY CODE with an additive
// origin marker.
//
// One block per truth of T02-PLAN.md § must_haves.truths:
//
//   A  the section is written for `overlap`, `clean` AND `inconclusive`, and
//      the clean case ASSERTS THE WORK PERFORMED (how many pairs, how many
//      paths) — a clean section never merely exists.
//   B  the upsert is IDEMPOTENT and SURGICAL, proved BY BYTES: a second call
//      yields a byte-identical file, and every other section (including an
//      intra-slice `## File Audit` and a `## Route`) keeps its bytes. Heading
//      disjointness proved in BOTH directions.
//   C  the file's line-ending convention is PRESERVED: CRLF stays CRLF, LF
//      stays LF, counted.
//   D  the write guard refuses `target-missing`, `target-symlink` and
//      `outside-gsd`, and on each refusal the target keeps its bytes.
//   E  the `work-lost` event is appended BY THIS MODULE on `overlap`, carrying
//      `origin: 'code'` + `emitter`, and is NOT emitted on `clean` nor on
//      `inconclusive` — the three directions.
//   F  `originOf` classifies a REAL historical narrated line as `narrated` and
//      a freshly emitted one as `code` — both directions.
//   G  POSITIVE CONTROL, end to end BY SPAWN over a real git repo with a
//      PLANTED overlap: exit 0 read from the process, verdict `overlap`, the
//      disputed file NAMED in the section on disk, the `work-lost` line with
//      `origin: 'code'` on disk.
//   H  a failure to append NEVER swallows the finding: `event_written: false`
//      + `event_error`, section still written, exit still 0.
//   I  `exit 0` stays unconditional — asserted by SPAWN in four cases.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-claim-audit.js');
const {
  compareClaimAudit, formatClaimAuditMd, upsertClaimAuditSection, emitWorkLostEvent,
  originOf, AUDIT_SECTION_HEADING, AUDIT_SECTION_ANCHOR, WORK_LOST_EMITTER, WORK_LOST_ORIGINS,
} = require('./forge-claim-audit.js');
const { upsertRouteSection } = require('./forge-route-audit.js');

// ── Runner ─────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    if (e && e.__skip) {
      skipped++;
      // A skip is NAMED and loud. A silently dropped case is the very defect
      // this suite exists to prevent, one level up.
      console.log(`  ⊘ ${name} — PULADO: ${e.message}`);
      return;
    }
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function skip(msg) { const e = new Error(msg); e.__skip = true; throw e; }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}\n     expected: ${expected}\n     actual:   ${actual}`);
  }
}
function throws(fn, needle, msg) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  assert(threw !== null, msg || 'expected a throw, got none');
  assert(String(threw.message).includes(needle),
    `${msg || 'wrong throw'} — esperava "${needle}", veio: ${threw.message}`);
}

const tmpRoots = [];
function mktmp(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-claim-audit-w-${label}-`));
  tmpRoots.push(dir);
  return dir;
}
function cleanup() {
  for (const d of tmpRoots) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ── Result builders (pure core, no disk — that is the point) ───────────────
const ABS_A = process.platform === 'win32' ? 'C:\\wt\\alpha' : '/wt/alpha';

function result(kind) {
  const base = {
    milestone: 'M-x', slice: 'S07', code_dir: ABS_A,
    declared: { byUnit: new Map(), notes: [] },
  };
  if (kind === 'inconclusive') {
    return compareClaimAudit({ ...base, written: { units: [], skipped: [] }, claims: { claims: [], sources: [], skipped: [], notes: [] } });
  }
  const claimPaths = kind === 'overlap' ? ['scripts/a.js'] : ['scripts/z.js'];
  return compareClaimAudit({
    ...base,
    written: { units: [{ unit: 'M-x::S07/T02', owner: 'M-x', slice: 'S07', task: 'T02', files: ['scripts/a.js', 'scripts/b.js'] }], skipped: [] },
    claims: {
      claims: [{
        run: 'RUN-B', source: 'run-registry', paths: claimPaths,
        claim: { paths: claimPaths, code_dir: ABS_A }, scope_source: 'code-dir', scope: null, note: null,
      }],
      sources: [{ source: 'run-registry', consulted: true, contributed: 1, runs_examined: 2 }],
      skipped: [], notes: [],
    },
  });
}

// A SUMMARY carrying the neighbours this section must never touch: the
// intra-slice `## File Audit` of sub-step 1.6, a `## Route` owned by
// forge-route-audit, and a `## Forward Intelligence`.
function summaryFixture(eol) {
  return [
    '# S07-SUMMARY', '',
    '## Resumo', '', 'Texto do resumo.', '',
    '## File Audit', '', '- unexpected: nenhum', '- missing: nenhum', '',
    '## Route', '', '_Advisory_', '', '- rota configurada rodou em 2/2 tasks.', '',
    '## Forward Intelligence', '', '- nada a reportar.', '',
  ].join(eol);
}

function sectionsOf(text) {
  const out = new Map();
  const parts = text.split(/(?=^## )/m);
  for (const p of parts) {
    const head = (p.split(/\r?\n/)[0] || '').trim();
    if (head.startsWith('## ')) out.set(head, p);
  }
  return out;
}

function writeSummary(dir, eol) {
  const gsd = path.join(dir, '.gsd', 'milestones', 'M-x', 'slices', 'S07');
  fs.mkdirSync(gsd, { recursive: true });
  const p = path.join(gsd, 'S07-SUMMARY.md');
  fs.writeFileSync(p, summaryFixture(eol || '\n'), 'utf8');
  return p;
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco A: a seção é escrita nos TRÊS veredictos, e a limpa AFIRMA o trabalho feito (truth 1)');

for (const verdict of ['overlap', 'clean', 'inconclusive']) {
  test(`veredicto ${verdict}: a seção é emitida com heading, veredicto na 1ª bullet e censo na 2ª`, () => {
    const r = result(verdict);
    eq(r.verdict, verdict, 'fixture não produziu o veredicto pretendido');
    const md = formatClaimAuditMd(r);
    assert(md.startsWith(`${AUDIT_SECTION_HEADING}\n`), `heading ausente: ${md.slice(0, 60)}`);
    const bullets = md.split('\n').filter((l) => l.startsWith('- '));
    assert(bullets[0].includes(`**${verdict}**`), `veredicto fora da 1ª bullet: ${bullets[0]}`);
    assert(bullets[1].startsWith('- Censo:'), `censo fora da 2ª bullet: ${bullets[1]}`);
  });
}

test('o caso CLEAN afirma o trabalho feito: nomeia quantos PARES e quantos CAMINHOS, não só existe', () => {
  const r = result('clean');
  eq(r.verdict, 'clean');
  eq(r.census.pairs_compared, 1);
  eq(r.census.paths_compared, 2, 'dois arquivos escritos entraram na comparação');
  const md = formatClaimAuditMd(r);
  assert(/Confrontei 1 par\(es\) sobre 2 caminho\(s\)/.test(md),
    `a seção limpa tem de AFIRMAR pares e caminhos; veio:\n${md}`);
  assert(/não achei colisão/.test(md), 'a alegação de ausência de colisão tem de estar escrita');
});

test('o caso INCONCLUSIVE jamais é apresentado como limpo', () => {
  const md = formatClaimAuditMd(result('inconclusive'));
  assert(md.includes('Não é uma afirmação de limpeza'), `veio:\n${md}`);
  assert(!/não achei colisão/.test(md), 'inconclusive não pode usar a frase do caso limpo');
});

test('o caso OVERLAP nomeia arquivo, unidade e contraparte', () => {
  const md = formatClaimAuditMd(result('overlap'));
  assert(md.includes('M-x::S07/T02'), 'a unidade tem de ser nomeada');
  assert(md.includes('RUN-B'), 'a contraparte tem de ser nomeada');
  assert(md.includes('scripts/a.js'), 'o arquivo em disputa tem de ser nomeado');
});

test('toda linha de skipped[] aparece com sua razão — nenhum descarte silencioso', () => {
  const r = result('clean');
  r.skipped.push({ kind: 'pair', id: 'X × Y', reason: 'different-code-dir', detail: 'D2' });
  const md = formatClaimAuditMd(r);
  assert(md.includes('X × Y') && md.includes('different-code-dir'), `veio:\n${md}`);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco B: upsert idempotente e CIRÚRGICO, provado por bytes (truth 2)');

test('segunda invocação produz arquivo BYTE-IDÊNTICO (nenhuma segunda seção appendada)', () => {
  const dir = mktmp('idem');
  const p = writeSummary(dir);
  const md = formatClaimAuditMd(result('overlap'));
  eq(upsertClaimAuditSection(p, md, dir).written, true);
  const first = fs.readFileSync(p);
  eq(upsertClaimAuditSection(p, md, dir).written, true);
  const second = fs.readFileSync(p);
  assert(Buffer.compare(first, second) === 0, 'a segunda escrita mudou bytes — upsert não é idempotente');
  const occurrences = second.toString('utf8').split(AUDIT_SECTION_HEADING).length - 1;
  eq(occurrences, 1, 'a seção foi appendada duas vezes');
});

test('os bytes de TODAS as outras seções ficam idênticos (incluindo `## File Audit` intra-slice e `## Route`)', () => {
  const dir = mktmp('surgery');
  const p = writeSummary(dir);
  const before = sectionsOf(fs.readFileSync(p, 'utf8'));
  eq(upsertClaimAuditSection(p, formatClaimAuditMd(result('overlap')), dir).written, true);
  const after = sectionsOf(fs.readFileSync(p, 'utf8'));
  for (const head of ['## Resumo', '## File Audit', '## Route', '## Forward Intelligence']) {
    assert(before.has(head), `fixture perdeu ${head}`);
    eq(after.get(head), before.get(head), `os bytes de ${head} foram alterados`);
  }
  assert(after.has(AUDIT_SECTION_HEADING), 'a seção cross-run não foi escrita');
});

test('disjunção de heading nas DUAS direções, no nível do regex', () => {
  const intra = /^## File Audit\r?$/m;
  assert(!intra.test(AUDIT_SECTION_HEADING), 'o âncora intra-slice casou o heading cross-run');
  assert(!AUDIT_SECTION_ANCHOR.test('## File Audit'), 'o âncora cross-run casou o heading intra-slice');
  assert(AUDIT_SECTION_ANCHOR.test(AUDIT_SECTION_HEADING), 'o âncora cross-run não casa o próprio heading');
  assert(intra.test('## File Audit'), 'controle positivo: o âncora intra-slice casa o próprio heading');
});

test('o dono vizinho escrevendo a SUA seção (`## Route`, forge-route-audit) não toca a cross-run', () => {
  const dir = mktmp('neighbour');
  const p = writeSummary(dir);
  eq(upsertClaimAuditSection(p, formatClaimAuditMd(result('overlap')), dir).written, true);
  const mine = sectionsOf(fs.readFileSync(p, 'utf8')).get(AUDIT_SECTION_HEADING);
  eq(upsertRouteSection(p, '## Route\n\n_Advisory_\n\n- reescrita pelo vizinho.\n', dir).written, true);
  const after = sectionsOf(fs.readFileSync(p, 'utf8'));
  eq(after.get(AUDIT_SECTION_HEADING), mine, 'o upsert vizinho alterou a seção cross-run');
  assert(after.get('## Route').includes('reescrita pelo vizinho'), 'controle positivo: o vizinho de fato reescreveu a dele');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco C: convenção de fim de linha preservada (truth 3)');

test('um SUMMARY CRLF continua CRLF, e a seção injetada adota CRLF', () => {
  const dir = mktmp('crlf');
  const p = writeSummary(dir, '\r\n');
  const before = fs.readFileSync(p, 'utf8');
  const crlfBefore = (before.match(/\r\n/g) || []).length;
  const loneBefore = (before.match(/(?<!\r)\n/g) || []).length;
  eq(loneBefore, 0, 'fixture CRLF não devia ter LF solto');
  eq(upsertClaimAuditSection(p, formatClaimAuditMd(result('clean')), dir).written, true);
  const after = fs.readFileSync(p, 'utf8');
  eq((after.match(/(?<!\r)\n/g) || []).length, 0, 'apareceu LF solto num arquivo CRLF');
  assert((after.match(/\r\n/g) || []).length > crlfBefore, 'a seção não foi adicionada');
});

test('um SUMMARY LF continua LF (nenhum CR introduzido)', () => {
  const dir = mktmp('lf');
  const p = writeSummary(dir, '\n');
  eq(upsertClaimAuditSection(p, formatClaimAuditMd(result('clean')), dir).written, true);
  const after = fs.readFileSync(p, 'utf8');
  eq((after.match(/\r/g) || []).length, 0, 'apareceu CR num arquivo LF');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco D: as três recusas nomeadas do guard, com o alvo BYTE-IDÊNTICO (truth 4)');

test('target-missing: alvo inexistente é recusado por nome', () => {
  const dir = mktmp('missing');
  writeSummary(dir);
  const ghost = path.join(dir, '.gsd', 'milestones', 'M-x', 'slices', 'S07', 'NAO-EXISTE.md');
  const r = upsertClaimAuditSection(ghost, formatClaimAuditMd(result('clean')), dir);
  eq(r.written, false);
  eq(r.reason, 'target-missing');
  assert(!fs.existsSync(ghost), 'o guard criou o arquivo que recusou');
});

test('outside-gsd: alvo fora de <cwd>/.gsd é recusado e o alvo fica byte-idêntico', () => {
  const dir = mktmp('outside');
  writeSummary(dir);
  const outside = path.join(dir, 'FORA.md');
  fs.writeFileSync(outside, summaryFixture('\n'), 'utf8');
  const before = sha(outside);
  const r = upsertClaimAuditSection(outside, formatClaimAuditMd(result('clean')), dir);
  eq(r.written, false);
  eq(r.reason, 'outside-gsd');
  eq(sha(outside), before, 'o alvo recusado foi mutado');
});

test('target-symlink: link é recusado por nome e o alvo real fica byte-idêntico', () => {
  const dir = mktmp('symlink');
  const real = writeSummary(dir);
  const before = sha(real);
  const link = path.join(path.dirname(real), 'LINK-SUMMARY.md');
  // Duas formas do MESMO ramo (`lstat().isSymbolicLink()`). O symlink de
  // arquivo exige privilégio no Windows; a junction de diretório não, e o
  // `lstat` a reporta igualmente como link — então o ramo é exercido de fato
  // nos dois sistemas, em vez de virar um pulo permanente na plataforma onde
  // este repo roda.
  let kind = 'file-symlink';
  try {
    fs.symlinkSync(real, link, 'file');
  } catch (_) {
    try {
      fs.symlinkSync(path.dirname(real), link, 'junction');
      kind = 'dir-junction';
    } catch (e2) {
      skip(`nenhuma forma de link criável neste ambiente (${e2.code}) — recusa não exercida`);
    }
  }
  assert(fs.lstatSync(link).isSymbolicLink(), `controle positivo: o ${kind} deve ser visto como link pelo lstat`);
  const r = upsertClaimAuditSection(link, formatClaimAuditMd(result('clean')), dir);
  eq(r.written, false, `a recusa não aconteceu (forma: ${kind})`);
  eq(r.reason, 'target-symlink');
  eq(sha(real), before, 'o alvo real foi mutado através do link');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco E: o evento work-lost é emitido POR CÓDIGO só em overlap (truth 5)');

function eventsPath(dir) { return path.join(dir, '.gsd', 'forge', 'events.jsonl'); }

test('overlap: a linha é appendada com origin:code + emitter e os campos do achado', () => {
  const dir = mktmp('ev-overlap');
  const r = emitWorkLostEvent(dir, result('overlap'));
  eq(r.event_written, true, `evento não escrito: ${r.event_error}`);
  eq(r.event_lines, 1);
  const lines = fs.readFileSync(eventsPath(dir), 'utf8').trim().split('\n');
  eq(lines.length, 1);
  const ev = JSON.parse(lines[0]);
  eq(ev.event, 'work-lost');
  eq(ev.origin, 'code');
  eq(ev.emitter, WORK_LOST_EMITTER);
  eq(ev.milestone, 'M-x');
  eq(ev.slice, 'S07');
  eq(ev.unit, 'M-x::S07/T02');
  eq(ev.other_run, 'RUN-B');
  assert(Array.isArray(ev.files) && ev.files.length > 0, 'os arquivos em disputa têm de viajar na linha');
});

for (const verdict of ['clean', 'inconclusive']) {
  test(`${verdict}: NENHUMA linha é emitida (o evento é o achado, não o relatório)`, () => {
    const dir = mktmp(`ev-${verdict}`);
    const r = emitWorkLostEvent(dir, result(verdict));
    eq(r.event_written, false);
    eq(r.event_error, null, 'ausência de achado não é erro');
    eq(r.event_skipped, 'no-finding');
    assert(!fs.existsSync(eventsPath(dir)), 'o log foi criado sem achado');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco F: originOf classifica narrada × emitida por código, nas DUAS direções (truth 6)');

// Linha HISTÓRICA real, copiada verbatim de um events.jsonl de produção
// (WDMA, 2026-08-13): a forma escrita à mão, sem marcador.
const HISTORICAL = '{"ts":"2026-08-13T04:07:30Z","event":"work-lost","milestone":"M-20260812160209-resize-coluna-arrasto","slice":"S02","unit":"execute-task/S02-T02","cause":"concurrent-run-overwrite","other_run":"T-20260813031731-corrigir-janela-linhas","files":["component-grid-shadow-styled.js","component-grid-shadow.vue"]}';

test('a linha histórica narrada é classificada `narrated` e permanece LEGÍVEL', () => {
  eq(originOf(HISTORICAL), 'narrated');
  const ev = JSON.parse(HISTORICAL);
  eq(ev.event, 'work-lost', 'o nome do evento não mudou — a legibilidade histórica é preservada');
  assert(ev.files.length === 2, 'os campos históricos continuam legíveis');
});

test('a linha emitida por este módulo é classificada `code`', () => {
  const dir = mktmp('origin-code');
  emitWorkLostEvent(dir, result('overlap'));
  const line = fs.readFileSync(eventsPath(dir), 'utf8').trim();
  eq(originOf(line), 'code');
  eq(originOf(JSON.parse(line)), 'code', 'aceita objeto já parseado');
});

test('marcador PELA METADE não vira `code` (o par origin+emitter é o marcador)', () => {
  eq(originOf({ event: 'work-lost', origin: 'code' }), 'narrated');
  eq(originOf({ event: 'work-lost', emitter: WORK_LOST_EMITTER }), 'narrated');
});

test('o conjunto é fechado e uma linha que não é work-lost é LOUD no seam', () => {
  eq(WORK_LOST_ORIGINS.length, 2);
  assert(WORK_LOST_ORIGINS.includes('code') && WORK_LOST_ORIGINS.includes('narrated'));
  eq(WORK_LOST_ORIGINS.includes(originOf(HISTORICAL)), true);
  throws(() => originOf('{"event":"dispatch"}'), 'só classifica linhas work-lost');
  throws(() => originOf('nao-e-json'), 'ilegível');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco H: falha ao appendar NUNCA engole o achado (truth 8)');

test('events.jsonl inescrevível → event_written:false + event_error, e a seção AINDA é escrita', () => {
  const dir = mktmp('ev-fail');
  const p = writeSummary(dir);
  // O caminho do log existe como DIRETÓRIO: o append falha com EISDIR nos dois
  // sistemas operacionais, sem depender de permissão de arquivo.
  fs.mkdirSync(eventsPath(dir), { recursive: true });
  const r = result('overlap');
  const up = upsertClaimAuditSection(p, formatClaimAuditMd(r), dir);
  const ev = emitWorkLostEvent(dir, r);
  eq(up.written, true, 'a seção tem de ser escrita mesmo com o evento falhando');
  eq(ev.event_written, false);
  assert(ev.event_error && ev.event_error.length > 0, 'a falha tem de ser NOMEADA, não engolida');
  assert(fs.readFileSync(p, 'utf8').includes('scripts/a.js'), 'o achado continua nomeado na seção');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco G/I: CONTROLE POSITIVO ponta-a-ponta por SPAWN + exit 0 incondicional (truths 7 e 9)');

function runCli(args, cwd) {
  return spawnSync(process.execPath, [MODULE].concat(args), { cwd, encoding: 'utf8' });
}
function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const MILESTONE = 'M-20260813133328-lease-escrita-cross-run';

/**
 * A REAL workspace: a git repo whose `forge/<milestone>` branch carries a
 * commit scoped `feat(S07/T02):` touching `scripts/a.js`, plus another run
 * whose live claim names that very file from the SAME code_dir. That is the
 * planted overlap — nothing is stubbed on the way to the verdict.
 */
function plantWorkspace(label, opts) {
  // `claimPath` is what the COUNTERPART claims. Default: the very file this
  // slice writes (the planted overlap). Point it elsewhere and the same
  // fixture produces a GENUINELY clean verdict — which is the only way the
  // unconditionality assert can bite. A "clean" case that is actually
  // `inconclusive` passes green over the exact defect it exists to catch
  // (measured: the first version of this suite did precisely that).
  const claimPath = (opts && opts.claimPath) || 'scripts/a.js';
  const cwd = mktmp(label);
  const repo = path.join(cwd, 'code');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'chore: base']);
  git(repo, ['checkout', '-b', `forge/${MILESTONE}`]);
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'a.js'), '// escrito por esta slice\n');
  git(repo, ['add', path.join('scripts', 'a.js')]);
  git(repo, ['commit', '-m', 'feat(S07/T02): escreve scripts/a.js']);

  const runsDir = path.join(cwd, '.gsd', 'forge', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const rec = (id, claim) => fs.writeFileSync(
    path.join(runsDir, `${id}.json`),
    `${JSON.stringify({ id, kind: 'milestone', active: true, cwd: repo, code_dir: repo, write_claim: claim }, null, 2)}\n`,
    'utf8',
  );
  rec(MILESTONE, null);
  // A CONTRAPARTE: outra run, MESMO code_dir, claimando o arquivo escrito aqui.
  rec('RUN-CONTRAPARTE', { paths: [claimPath], code_dir: repo, ts: new Date().toISOString() });

  const summary = path.join(cwd, '.gsd', 'milestones', MILESTONE, 'slices', 'S07', 'S07-SUMMARY.md');
  fs.mkdirSync(path.dirname(summary), { recursive: true });
  fs.writeFileSync(summary, summaryFixture('\n'), 'utf8');
  return { cwd, repo, summary };
}

let planted = null;
try { planted = plantWorkspace('positive-control'); } catch (e) { planted = { error: e.message }; }

test('CONTROLE POSITIVO: sobreposição plantada → exit 0 do PROCESSO, verdict overlap, arquivo e contraparte NOMEADOS na seção em disco, linha work-lost origin:code em disco', () => {
  if (planted.error) skip(`fixture git indisponível: ${planted.error}`);
  const { cwd, repo, summary } = planted;
  const res = runCli(['--milestone', MILESTONE, '--slice', 'S07', '--cwd', cwd, '--code-dir', repo,
    '--run', MILESTONE, '--write', summary, '--json'], cwd);
  eq(res.status, 0, `exit code LIDO DO PROCESSO tem de ser 0, veio ${res.status} — stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  eq(out.verdict, 'overlap', `o detector não mordeu a sobreposição plantada — censo: ${JSON.stringify(out.census)} / skipped: ${JSON.stringify(out.skipped)}`);

  const written = fs.readFileSync(summary, 'utf8');
  assert(written.includes(AUDIT_SECTION_HEADING), 'a seção não foi escrita em disco');
  assert(written.includes('scripts/a.js'), 'o arquivo em disputa não foi NOMEADO na seção em disco');
  assert(written.includes('RUN-CONTRAPARTE'), 'a contraparte não foi NOMEADA na seção em disco');

  const log = fs.readFileSync(eventsPath(cwd), 'utf8').trim().split('\n').filter(Boolean);
  const lost = log.map((l) => JSON.parse(l)).filter((e) => e.event === 'work-lost');
  assert(lost.length >= 1, 'nenhuma linha work-lost em disco');
  eq(originOf(lost[lost.length - 1]), 'code', 'a linha em disco não carrega o marcador de origem');
  assert(lost[lost.length - 1].files.includes('scripts/a.js'), 'a linha não nomeia o arquivo em disputa');
});

test('exit 0 com RECUSA de escrita (alvo fora do .gsd)', () => {
  if (planted.error) skip(`fixture git indisponível: ${planted.error}`);
  const { cwd, repo } = planted;
  const outside = path.join(cwd, 'FORA.md');
  fs.writeFileSync(outside, '# fora\n', 'utf8');
  const res = runCli(['--milestone', MILESTONE, '--slice', 'S07', '--cwd', cwd, '--code-dir', repo,
    '--write', outside, '--json'], cwd);
  eq(res.status, 0, `exit code tem de ser 0, veio ${res.status}`);
  assert(res.stderr.includes('refused: outside-gsd'), `stderr humano deve nomear a recusa; veio: ${res.stderr}`);
  eq(fs.readFileSync(outside, 'utf8'), '# fora\n', 'o alvo recusado foi mutado');
});

test('exit 0 com FALHA de evento (log inescrevível), e a seção ainda escrita', () => {
  const p = plantWorkspace('evfail-cli');
  const evFile = eventsPath(p.cwd);
  fs.mkdirSync(evFile, { recursive: true });
  const res = runCli(['--milestone', MILESTONE, '--slice', 'S07', '--cwd', p.cwd, '--code-dir', p.repo,
    '--run', MILESTONE, '--write', p.summary, '--json'], p.cwd);
  eq(res.status, 0, `exit code tem de ser 0, veio ${res.status} — stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  eq(out.verdict, 'overlap');
  eq(out.event_written, false, 'a falha de evento tem de aparecer no relatório');
  assert(out.event_error, 'event_error tem de ser nomeado');
  assert(fs.readFileSync(p.summary, 'utf8').includes(AUDIT_SECTION_HEADING), 'a seção deixou de ser escrita por causa do evento');
});

test('workspace GENUINAMENTE limpo (pares confrontados, zero colisão): exit 0, seção escrita mesmo assim, nenhum evento', () => {
  let p;
  try { p = plantWorkspace('cli-clean', { claimPath: 'scripts/outro-arquivo.js' }); } catch (e) { skip(`fixture git indisponível: ${e.message}`); }
  const res = runCli(['--milestone', MILESTONE, '--slice', 'S07', '--cwd', p.cwd, '--code-dir', p.repo,
    '--run', MILESTONE, '--write', p.summary, '--json'], p.cwd);
  eq(res.status, 0, `exit code tem de ser 0, veio ${res.status} — stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  // O piso: este caso tem de ser CLEAN de verdade. Um `inconclusive` disfarçado
  // de limpo faria o assert seguinte passar sem nunca exercer a omissão.
  eq(out.verdict, 'clean', `o fixture precisa ser genuinamente limpo — censo: ${JSON.stringify(out.census)}`);
  assert(out.census.pairs_compared > 0, 'clean sem par confrontado seria o piso violado');
  const written = fs.readFileSync(p.summary, 'utf8');
  assert(written.includes(AUDIT_SECTION_HEADING),
    'seção OMITIDA quando limpa — é exatamente o defeito de origem que esta task fecha');
  assert(/Confrontei \d+ par\(es\) sobre \d+ caminho\(s\)/.test(written),
    'a seção limpa em disco tem de AFIRMAR o trabalho feito, não só existir');
  const log = fs.existsSync(eventsPath(p.cwd))
    ? fs.readFileSync(eventsPath(p.cwd), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  eq(log.filter((e) => e.event === 'work-lost').length, 0, 'evento emitido sem achado');
});

test('workspace sem .gsd nenhum: exit 0 e recusa nomeada (advisory absoluto)', () => {
  const cwd = mktmp('cli-bare');
  const res = runCli(['--milestone', MILESTONE, '--slice', 'S07', '--cwd', cwd, '--code-dir', cwd,
    '--write', path.join(cwd, '.gsd', 'x.md'), '--json'], cwd);
  eq(res.status, 0, `exit code tem de ser 0, veio ${res.status}`);
  assert(res.stderr.includes('refused:'), `a recusa deve ser nomeada no stderr; veio: ${res.stderr}`);
});

// ── Suite close ────────────────────────────────────────────────────────────
cleanup();

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
