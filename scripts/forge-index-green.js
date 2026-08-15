'use strict';

// forge-index-green.js — Gate "índice verde" (D-2), re-medível por S04 no apply.
//
// Compõe três medições já testadas (measureF2, buildUnitAxis, buildSubjectAxis)
// e avalia os três critérios de D-2 JUNTOS, sem inventar nenhum número novo:
//   1. f2_recall >= F2_THRESHOLD
//   2. eixo unidade: 100% dos fatos LIDOS carregam unidade (facts_not_read enumerado)
//   3. relatório do eixo assunto presente — NENHUM threshold aqui (D-2 proíbe régua
//      no assunto; a presença do relatório é o único requisito)
//
// Contrato para S04 (o consumidor deste gate): este gate NUNCA bloqueia por exit
// code — exit é sempre 0 (convenção deste repo: gate advisory falha loud dentro
// do JSON, nunca pelo processo). Quem bloqueia é o CONSUMIDOR. S04 deve tratar
// `green !== true`, stdout não-JSON, e falha de spawn como RECUSA da deleção.
// A convenção advisory default deste repo faria S04 seguir em frente por
// omissão — essa linha existe exatamente para impedir essa armadilha.
//
// O gate é READ-ONLY: nenhuma chamada aqui escreve índice, journal ou store.
// Zero-dep, CommonJS.

const path = require('path');
const { measureF2 } = require('./forge-index-f2');
const { buildFileIndex } = require('./forge-memory-index');
const { buildUnitAxis, buildSubjectAxis } = require('./forge-memory-axes');

// D-2 threshold: 0.99 é o piso de recall abaixo do qual o índice deixa de ser
// evidência confiável para a deleção que S04 executa (S02-PLAN.md § Design,
// ponto 1) — não é um número arbitrário, é o limiar acima do qual o próprio
// desenho do gate considera o risco de apagar um fato vivo aceitável.
const F2_THRESHOLD = 0.99;

function computeUnitAxisCriterion(axis) {
  const coverage = (axis && axis.coverage) || {};
  const factsWithUnit = Number(coverage.facts_with_unit || 0);
  const factsTotal = Number(coverage.facts_total || 0);
  const notRead = coverage.facts_not_read || {};
  const unreadableCount = Number(notRead.unreadable_fragments || 0);
  const skippedCount = Number(notRead.fragments_skipped_by_store || 0);
  const readFailed = !!(axis && axis.fragment_listing_failed);
  const indexPartial = !!(axis && axis.partial);
  const countsMatch = factsWithUnit === factsTotal;
  // A gate that only checks "100% of what I saw" while silently dropping
  // fragments the store could not read/kept, would technically satisfy the
  // narrow "facts lidos" wording while making a claim no operator can trust —
  // any fragment lost before or during the read (unreadable OR skipped by the
  // store) is enumerated in facts_not_read AND fails this criterion, because
  // an index that lost data is not evidence of structural completeness.
  const noLostFragments = unreadableCount === 0 && skippedCount === 0;
  const ok = countsMatch && !readFailed && !indexPartial && noLostFragments;
  return {
    ok,
    readFailed,
    indexPartial,
    countsMatch,
    noLostFragments,
    measured: `${factsWithUnit}/${factsTotal}`,
    facts_not_read: coverage.facts_not_read || null,
  };
}

function computeSubjectReportCriterion(axis) {
  const ok = !!(axis && axis.coverage && typeof axis.coverage.facts_total === 'number');
  return { ok };
}

function errorReport(error) {
  return {
    green: false,
    criteria: [],
    f2_recall: null,
    resolution_rate: null,
    unit_axis: { facts_with_unit: 0, facts_total: 0, facts_not_read: null },
    subject_report_present: false,
    reasons: [`gate-error:${(error && error.message) || String(error)}`],
    measured_at: new Date().toISOString(),
  };
}

// measureGreen is the library entry point AND is what the CLI calls — it must
// never throw on its own (a fragment that fails mid-read, e.g., throws inside
// measureF2/buildFileIndex, not just inside the CLI process boundary). The CLI
// wraps this call again as defense-in-depth, but the "exceção interna → JSON
// green:false + gate-error, exit 0" contract (T05-PLAN.md Steps 3/4) belongs
// to this function, not only to its caller.
function measureGreen(cwd, opts) {
  try {
    return measureGreenUnsafe(cwd, opts);
  } catch (error) {
    return errorReport(error);
  }
}

function measureGreenUnsafe(cwd, opts) {
  const root = path.resolve(cwd || process.cwd());
  const options = opts || {};
  const reasons = [];

  // Monta o resultado do índice uma vez; buildUnitAxis e buildSubjectAxis
  // consomem o MESMO objeto — nenhum dos dois eixos relê o store por conta
  // própria. measureF2 tem assinatura própria (cwd, opts) e faz sua própria
  // leitura internamente — é uma medição já testada e composta aqui, não
  // recalculada; a leitura duplicada é do módulo F2, não deste gate.
  const result = buildFileIndex(root, options.index || {});
  const unitAxis = buildUnitAxis(result, options.unitAxis || {});
  const subjectAxis = buildSubjectAxis(result, options.subjectAxis || {});
  const f2 = measureF2(root, options.f2 || {});

  const f2Ok = typeof f2.f2_recall === 'number' && f2.f2_recall >= F2_THRESHOLD;
  const unitCriterion = computeUnitAxisCriterion(unitAxis);
  const subjectCriterion = computeSubjectReportCriterion(subjectAxis);

  if (!f2Ok) reasons.push('f2-below-threshold');
  if (unitCriterion.readFailed) reasons.push('fragment-listing-failed');
  else if (unitCriterion.indexPartial) reasons.push('index-partial');
  else if (!unitCriterion.countsMatch || !unitCriterion.noLostFragments) reasons.push('unit-axis-incomplete');
  if (!subjectCriterion.ok) reasons.push('subject-report-missing');

  const green = f2Ok && unitCriterion.ok && subjectCriterion.ok;

  const criteria = [
    {
      name: 'f2_recall',
      ok: f2Ok,
      measured: f2.f2_recall,
      required: F2_THRESHOLD,
    },
    {
      name: 'unit_axis',
      ok: unitCriterion.ok,
      measured: unitCriterion.measured,
      required: 'facts_with_unit === facts_total (dos fatos lidos)',
    },
    {
      // D-2: nenhum threshold pertence a este critério — required documenta
      // isso explicitamente em vez de carregar um número que não existe.
      name: 'subject_report_present',
      ok: subjectCriterion.ok,
      measured: subjectCriterion.ok,
      required: 'relatório presente com coverage.facts_total numérico — sem régua de cobertura',
    },
  ];

  return {
    green,
    criteria,
    f2_recall: f2.f2_recall,
    resolution_rate: f2.resolution_rate,
    unit_axis: {
      facts_with_unit: (unitAxis && unitAxis.coverage && unitAxis.coverage.facts_with_unit) || 0,
      facts_total: (unitAxis && unitAxis.coverage && unitAxis.coverage.facts_total) || 0,
      facts_not_read: (unitAxis && unitAxis.coverage && unitAxis.coverage.facts_not_read) || null,
    },
    subject_report_present: subjectCriterion.ok,
    reasons,
    measured_at: new Date().toISOString(),
  };
}

function parseCliArgs(argv) {
  const result = { cwd: process.cwd(), json: false, valid: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') result.json = true;
    else if (argv[i] === '--cwd' && argv[i + 1] && !argv[i + 1].startsWith('--')) result.cwd = argv[++i];
    else { result.valid = false; break; }
  }
  return result;
}

function renderMarkdown(report) {
  const lines = [
    '# Gate: índice verde',
    '',
    `- green: ${report.green}`,
    `- f2_recall: ${report.f2_recall}`,
    `- resolution_rate: ${report.resolution_rate}`,
    `- unit_axis: ${report.unit_axis.facts_with_unit}/${report.unit_axis.facts_total}`,
    `- subject_report_present: ${report.subject_report_present}`,
    `- reasons: ${report.reasons.length ? report.reasons.join(', ') : '(nenhum)'}`,
    `- measured_at: ${report.measured_at}`,
    '',
  ];
  return lines.join('\n');
}

function runCli(argv) {
  const args = parseCliArgs(argv);
  if (!args.valid) {
    process.stderr.write(JSON.stringify({ error: 'Uso: forge-index-green.js --cwd <dir> [--json]' }) + '\n');
    return 2;
  }
  // Convenção deste repo: gate advisory falha loud DENTRO do JSON, nunca pelo
  // exit code — exceção interna vira green:false + reasons:['gate-error:<msg>']
  // e o processo sai 0 mesmo assim (Steps 3/4 do T05-PLAN.md).
  let report;
  try {
    report = measureGreen(args.cwd);
  } catch (error) {
    report = errorReport(error);
  }
  if (args.json) process.stdout.write(JSON.stringify(report) + '\n');
  else process.stdout.write(renderMarkdown(report));
  return 0;
}

module.exports = {
  measureGreen,
  F2_THRESHOLD,
  runCli,
  // Exported for isolated criterion tests (subject_report_present has no
  // reachable "missing" state through the real store — the axis builder
  // always returns a coverage object — so the suite exercises this criterion
  // directly against a malformed axis shape instead of faking the store).
  computeUnitAxisCriterion,
  computeSubjectReportCriterion,
};
if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
