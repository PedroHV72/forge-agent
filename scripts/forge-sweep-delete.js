#!/usr/bin/env node
'use strict';

// forge-sweep-delete — operação `delete-wrappers` do registry de sweep.
//
// HUMAN-INVOKED ONLY, no molde de forge-sweep-dedupe.js: deletar fisicamente o
// invólucro de uma unidade fechada é decisão destrutiva do operador. Não há
// skill nem slash command. Dry-run é o default; --apply exige confirmação.
//
// Ordem dura de gates (S04-PLAN § Ordem dura) — nada degrada para "prossegue":
//   (1) emenda D11 lida do FRAGMENTO de decisões (nunca .gsd/DECISIONS.md);
//   (2) índice-verde re-medido via measureGreen — green !== true, retorno
//       não-objeto ou throw são RECUSA nomeada, nunca omissão;
//   (3) por alvo: fence de fase ativa → fechamento em 4 camadas (1–3 gate) →
//       eligibility com base `vcs` ESTRITA (sem toolUndo: esta operação
//       destrói bytes e não tem journal de conteúdo para devolvê-los).
//
// apply() RE-EXECUTA (1) e (2) por conta própria (D-2): um plano/preview
// anterior nunca é evidência do estado no momento do apply.
//
// A base de undo desta operação é o VCS, e só ele — o relatório nomeia o
// comando exato. Por isso o journal recebe apenas PONTEIROS (S08) e sua falha
// pré-apply é warn, não recusa.
//
// Esta operação NÃO cria container nenhum: D11 continua proibindo containerizar
// invólucros (os leitores congelados de forge-wrapper-readers.js). Nenhum
// require de forge-epoch-group/forge-grouped-file existe neste arquivo.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { activeUnits, isUnitBlocked } = require('./forge-sweep-active-phase');
const { createRegistry, formatPreview } = require('./forge-sweep-registry');
const { createEligibility, isVcsQueryFailure } = require('./forge-sweep-eligibility');
const { measureGreen } = require('./forge-index-green');
const { checkClosure, renderClosureSection } = require('./forge-wrapper-closure');
const decisions = require('./forge-decisions');
const journal = require('./forge-sweep-journal');

const OPERATION = 'delete-wrappers';

// Fonte única da string: T03 grava a emenda importando esta constante
// (`node -p "require('./scripts/forge-sweep-delete').D11_AMENDMENT_DECISION"`),
// nunca re-digitando o texto no fragmento.
const D11_AMENDMENT_DECISION = 'Emenda D11 — exceção: deleção física de invólucros pós-destilação';
const D11_AMENDMENT_UNIT_ID = 'M-20260814222313-sweep-curadoria';

const WRAPPER_ROOTS = [
  path.join('.gsd', 'milestones'),
  path.join('.gsd', 'tasks'),
  path.join('.gsd', 'archive'),
];

const USAGE = [
  'Uso: node scripts/forge-sweep-delete.js [opções]', '',
  '  --cwd <dir>  Diretório do projeto (padrão: diretório atual)',
  '  --apply      Deleta os invólucros elegíveis após confirmação explícita',
  '  --yes        Confirma --apply sem pergunta',
  '  --json       Emite um único documento JSON',
  '  --help       Mostra esta ajuda', '',
  'Desfazer é responsabilidade do VCS — o relatório de aplicação nomeia o comando exato.',
  'Códigos de saída: 0 sucesso, 1 erro ou recusa, 2 argumentos inválidos.',
].join('\n');

// ── Gate (1): emenda D11 no FRAGMENTO de decisões ────────────────────────────
function validWhen(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  return !Number.isNaN(Date.parse(text));
}

function checkD11Amendment(cwd) {
  let fragment;
  try {
    fragment = decisions.readFragment(cwd, D11_AMENDMENT_UNIT_ID);
  } catch (error) {
    return { ok: false, reason: 'd11-amendment-unavailable', error: error.message };
  }
  if (!fragment) return { ok: false, reason: 'd11-amendment-missing', detail: 'fragmento ausente' };
  const list = Array.isArray(fragment.decisions) ? fragment.decisions : [];
  const hit = list.find(item => item
    && typeof item.decision === 'string'
    && item.decision.trim() === D11_AMENDMENT_DECISION
    && validWhen(item.when));
  if (!hit) return { ok: false, reason: 'd11-amendment-missing', detail: 'decisão datada ausente no fragmento' };
  return { ok: true, when: hit.when instanceof Date ? hit.when.toISOString() : String(hit.when).trim() };
}

// ── Gate (2): índice verde, re-medido ────────────────────────────────────────
// O cabeçalho de forge-index-green.js escreveu o contrato PARA este consumidor:
// exit é sempre 0 e quem bloqueia é quem chama. Throw e retorno não-objeto são
// os equivalentes in-process de falha de spawn e stdout não-JSON, e recusam
// igualmente — a convenção advisory deste repo seguiria em frente por omissão.
function checkIndexGreen(cwd, opts) {
  const measure = (opts && typeof opts.measureGreen === 'function') ? opts.measureGreen : measureGreen;
  let report;
  try {
    report = measure(cwd);
  } catch (error) {
    return { ok: false, reason: 'index-gate-unavailable', detail: `medição lançou: ${error.message}` };
  }
  if (!report || typeof report !== 'object') {
    return { ok: false, reason: 'index-gate-unavailable', detail: 'medição retornou valor não-objeto' };
  }
  if (report.green !== true) {
    const reasons = Array.isArray(report.reasons) ? report.reasons : [];
    return {
      ok: false,
      reason: 'index-not-green',
      detail: `f2_recall=${report.f2_recall}; reasons=${reasons.length ? reasons.join(', ') : '(nenhum)'}`,
      reasons,
      f2_recall: report.f2_recall,
    };
  }
  return { ok: true, f2_recall: report.f2_recall };
}

function runGates(cwd, opts) {
  const amendment = checkD11Amendment(cwd);
  if (!amendment.ok) {
    return { ok: false, reason: amendment.reason, detail: amendment.detail || amendment.error || null };
  }
  const green = checkIndexGreen(cwd, opts);
  if (!green.ok) return { ok: false, reason: green.reason, detail: green.detail || null };
  return { ok: true, amendment, green };
}

// ── Enumeração dos invólucros ────────────────────────────────────────────────
// Raiz ausente entra no censo com razão própria (dir-missing) — "não olhei"
// nunca some do relatório.
function enumerateWrappers(cwd) {
  const candidates = [];
  const census = [];
  for (const rel of WRAPPER_ROOTS) {
    const root = path.join(cwd, rel);
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      census.push({ path: toPosix(rel), reason: error.code === 'ENOENT' ? 'dir-missing' : `dir-unreadable: ${error.message}` });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      candidates.push({
        unitId: entry.name,
        dir,
        root: toPosix(rel),
        // Chaves que o registry e a eligibility usam para identificar o alvo.
        path: dir,
        containerPath: dir,
        // Deletar o diretório deleta cada arquivo dentro dele: os membros são
        // enumerados para que a eligibility classifique o estado de VCS de
        // TODOS eles. O `git status` reporta arquivos, não o diretório — um
        // alvo que só expusesse o dir passaria por cima de um invólucro
        // inteiramente ignorado sem nunca ser classificado.
        members: listFilesRecursive(dir).map(file => ({ path: file })),
      });
    }
  }
  return { candidates, census };
}

function listFilesRecursive(dir) {
  const files = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return files; }
  for (const entry of entries) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(next));
    else files.push(next);
  }
  return files;
}

function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

function relPosix(cwd, target) {
  return toPosix(path.relative(cwd, target));
}

function undoCommand(vcs, relativePath) {
  if (vcs === 'svn') return `svn revert -R ${relativePath}`;
  return `git checkout -- ${relativePath}`;
}

// ── plan(ctx) ────────────────────────────────────────────────────────────────
function deletePlan(ctx) {
  const cwd = ctx.cwd;
  const skipped = [];
  const gates = runGates(cwd, ctx.gateOpts);
  if (!gates.ok) {
    // O registry normaliza o plano para {targets, skipped}; a recusa viaja no
    // ctx (molde ctx.dedupeVerdict) E como linha nomeada em skipped, para que
    // o preview textual nunca mostre um silêncio no lugar de uma recusa.
    ctx.deleteRefusal = { reason: gates.reason, detail: gates.detail };
    skipped.push({ path: '.gsd', reason: `${gates.reason}: ${gates.detail || 'sem detalhe'}` });
    return { targets: [], skipped };
  }
  ctx.deleteRefusal = null;
  ctx.deleteGates = { amendment_when: gates.amendment.when, f2_recall: gates.green.f2_recall };

  const { candidates, census } = enumerateWrappers(cwd);
  for (const item of census) skipped.push(item);

  let phase;
  try { phase = activeUnits(cwd); }
  catch (error) { phase = { ok: false, reason: `active-phase-unknown: ${error.message}` }; }

  const targets = [];
  for (const candidate of candidates) {
    const rel = relPosix(cwd, candidate.dir);
    if (!phase || phase.ok !== true) {
      skipped.push({ path: rel, reason: 'active-phase-unknown' });
      continue;
    }
    const blocked = isUnitBlocked(phase, { unitId: candidate.unitId, milestoneId: candidate.unitId }).blocked === true
      || (Array.isArray(phase.units) && phase.units.some(unit => unit && unit.milestoneId === candidate.unitId));
    if (blocked) {
      skipped.push({ path: rel, reason: 'active-phase' });
      continue;
    }
    let closure;
    try { closure = checkClosure(cwd, candidate.unitId); }
    catch (error) { skipped.push({ path: rel, reason: `closure-unavailable: ${error.message}` }); continue; }
    if (closure.ok !== true) {
      skipped.push({ path: rel, reason: closureRefusalReason(closure) });
      continue;
    }
    targets.push(Object.assign({}, candidate, { relPath: rel, closure }));
  }
  return { targets, skipped };
}

// Traduz as razões do módulo de fechamento ('ledger:no-ledger-entry') para o
// vocabulário nomeado desta operação, sem re-implementar as camadas.
function closureRefusalReason(closure) {
  const reasons = Array.isArray(closure.reasons) ? closure.reasons : [];
  const bare = reasons.map(item => String(item).split(':').slice(1).join(':') || String(item));
  return bare.length ? bare.join(', ') : 'fechamento-indisponível';
}

// ── apply(ctx, plan) ─────────────────────────────────────────────────────────
function applyDelete(ctx, plan) {
  const cwd = ctx.cwd;
  const skipped = (plan.skipped || []).slice();
  // D-2: os gates são re-executados AQUI, do zero. O plano recebido pode ter
  // sido medido há minutos; o estado que autoriza a deleção é o de agora.
  const gates = runGates(cwd, ctx.gateOpts);
  if (!gates.ok) {
    return {
      error: gates.reason,
      detail: gates.detail || null,
      deleted: [],
      skipped,
      report: [`aplicação recusada no apply: ${gates.reason} — ${gates.detail || 'sem detalhe'}`],
    };
  }

  const targets = plan.targets || [];
  if (targets.length === 0) {
    return { deleted: [], skipped, report: ['nenhum invólucro elegível — nada deletado'] };
  }

  const containers = targets.map(target => target.dir);
  const intent = journal.appendIntent(cwd, { operation: OPERATION, containers });
  if (intent.ok !== true) {
    // Regra S08 para alvos all-vcs: a garantia de undo desta operação é o VCS,
    // não o journal — a falha do intent é avisada e não recusa a aplicação.
    process.stderr.write(`${OPERATION}: aviso — registro de intenção falhou (${intent.error}); prosseguindo, undo é o VCS\n`);
  }

  const deleted = [];
  const report = [];
  for (const target of targets) {
    try {
      fs.rmSync(target.dir, { recursive: true });
      deleted.push(target.relPath);
    } catch (error) {
      skipped.push({ path: target.relPath, reason: `delete-failed: ${error.message}` });
      continue;
    }
    report.push(`### ${target.unitId} — ${target.relPath}`);
    report.push(renderClosureSection(target.closure).trimEnd());
    report.push(`- desfazer (VCS ${ctx.vcs || 'git'}): ${undoCommand(ctx.vcs, target.relPath)}`);
    report.push('');
  }

  if (intent.ok === true) {
    const outcome = journal.appendOutcome(cwd, { id: intent.id, phase: 'apply-done', written: deleted.map(rel => path.join(cwd, rel)) });
    if (outcome.ok !== true) skipped.push({ path: '.gsd/forge/sweep-journal.jsonl', reason: `journal-outcome-failed: ${outcome.error}` });
  }

  return { deleted, skipped, report, journalId: intent.ok === true ? intent.id : null };
}

function buildRegistry() {
  const registry = createRegistry();
  registry.register({
    name: OPERATION,
    description: 'Deleta fisicamente invólucros de unidades fechadas e destiladas; undo é o VCS.',
    plan: deletePlan,
    apply: applyDelete,
  });
  return registry;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const options = { cwd: process.cwd(), apply: false, yes: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cwd') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--cwd exige um diretório');
      options.cwd = value; index += 1;
    } else if (arg === '--apply') options.apply = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`argumento desconhecido: ${arg}`);
  }
  if (options.yes && !options.apply) throw new Error('--yes exige --apply');
  if (options.json && options.apply && !options.yes) throw new Error('--json com operação destrutiva exige --yes');
  return options;
}

function resolveCwd(candidate) {
  const cwd = path.resolve(candidate);
  let stat;
  try { stat = fs.statSync(cwd); } catch (error) { throw new Error(`não foi possível acessar --cwd: ${error.message}`); }
  if (!stat.isDirectory()) throw new Error('--cwd precisa apontar para um diretório');
  return cwd;
}

function errorsFor(result) {
  const errors = [];
  for (const entry of result.results || []) {
    if (entry.error || (entry.result && entry.result.error)) errors.push(entry.error || entry.result.error);
  }
  return errors;
}

function resultLines(result) {
  const lines = [];
  for (const entry of result.results || []) {
    if (!entry.result) continue;
    for (const rel of entry.result.deleted || []) lines.push(`deletado: ${rel}`);
    for (const line of entry.result.report || []) lines.push(line);
  }
  return lines;
}

function hasPolicyError(result) {
  return (result.preview.operations || []).some(operation =>
    (operation.skipped || []).some(item => isVcsQueryFailure(item.reason)));
}

function printResult(options, ctx, result, eligibility, messages) {
  const allMessages = messages.concat(result.applied ? resultLines(result) : []);
  const payload = {
    preview: result.preview,
    applied: result.applied,
    vcs: eligibility.vcs,
    refusal: ctx.deleteRefusal || null,
    gates: ctx.deleteGates || null,
    messages: allMessages,
    results: result.results || [],
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stdout.write(`${formatPreview(result.preview)}\n`);
    if (result.preview.totals.skipped === 0) process.stdout.write('Pulados: nenhum\n');
    for (const message of allMessages) process.stdout.write(`${message}\n`);
  }
}

function askConfirmation(text) {
  return new Promise(resolve => {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
    terminal.on('close', () => resolve(false));
    terminal.question(text, answer => { terminal.close(); resolve(answer.trim().toLowerCase() === 'sim'); });
  });
}

async function main(argv) {
  let options;
  try { options = parseArgs(argv); } catch (error) { process.stderr.write(`${error.message}\n${USAGE}\n`); return 2; }
  if (options.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  try {
    const cwd = resolveCwd(options.cwd);
    const ctx = { cwd };
    // Base `vcs` ESTRITA: nenhum opts.toolUndo é passado — um invólucro
    // untracked/ignorado é sempre recusado, com motivo nomeado em skipped[].
    const eligibility = createEligibility(cwd);
    ctx.vcs = eligibility.vcs;
    const registry = buildRegistry();
    const messages = [];

    if (!options.apply) {
      const result = registry.run(ctx, { filter: eligibility.filter });
      if (ctx.deleteRefusal) messages.push(`recusa: ${ctx.deleteRefusal.reason} — ${ctx.deleteRefusal.detail || 'sem detalhe'}`);
      printResult(options, ctx, result, eligibility, messages);
      return ctx.deleteRefusal || errorsFor(result).length || hasPolicyError(result) ? 1 : 0;
    }

    if (!options.yes && !process.stdin.isTTY) {
      const result = registry.run(ctx, { filter: eligibility.filter });
      messages.push('aplicação não confirmada fora de TTY; use --yes para confirmar');
      printResult(options, ctx, result, eligibility, messages);
      return 0;
    }
    if (!options.yes) {
      const preview = registry.run(ctx, { filter: eligibility.filter });
      printResult(options, ctx, preview, eligibility, messages);
      if (!(await askConfirmation('Confirmar deleção? Digite "sim": '))) return 0;
    }

    const result = registry.run(ctx, { filter: eligibility.filter, confirm: () => true });
    if (ctx.deleteRefusal) messages.push(`recusa: ${ctx.deleteRefusal.reason} — ${ctx.deleteRefusal.detail || 'sem detalhe'}`);
    printResult(options, ctx, result, eligibility, messages);
    return ctx.deleteRefusal || errorsFor(result).length || hasPolicyError(result) ? 1 : 0;
  } catch (error) { process.stderr.write(`${OPERATION}: ${error.message}\n`); return 1; }
}

module.exports = {
  OPERATION,
  D11_AMENDMENT_DECISION,
  D11_AMENDMENT_UNIT_ID,
  checkD11Amendment,
  checkIndexGreen,
  buildRegistry,
  main,
  parseArgs,
  resolveCwd,
  _private: { deletePlan, applyDelete, enumerateWrappers, runGates, undoCommand, closureRefusalReason, validWhen, WRAPPER_ROOTS },
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(error => {
      process.stderr.write(`${(error && error.stack) || error}\n`);
      process.exitCode = 1;
    });
}
