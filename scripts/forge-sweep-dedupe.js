#!/usr/bin/env node
'use strict';

// This command is HUMAN-INVOKED ONLY.  It deliberately has no skill or slash
// command: deduplicating a fragment store is a destructive operator decision.
// Preview is safe by default; --apply and --undo require explicit confirmation.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const memory = require('./forge-memory');
const { findDuplicateGroups } = require('./forge-memory-dupes');
const { activeUnits, isUnitBlocked } = require('./forge-sweep-active-phase');
const { writeVault, restoreVault } = require('./forge-sweep-vault');
const { createRegistry, formatPreview } = require('./forge-sweep-registry');
const { createEligibility, isVcsQueryFailure } = require('./forge-sweep-eligibility');
const journal = require('./forge-sweep-journal');

const OPERATION = 'dedupe-memoria';
const USAGE = [
  'Uso: node scripts/forge-sweep-dedupe.js [opções]', '',
  '  --cwd <dir>  Diretório do projeto (padrão: diretório atual)',
  '  --apply      Remove duplicatas após confirmação explícita',
  '  --undo       Restaura a aplicação mais recente',
  '  --yes        Confirma --apply ou --undo sem pergunta',
  '  --json       Emite um único documento JSON',
  '  --help       Mostra esta ajuda', '',
  'Códigos de saída: 0 sucesso, 1 erro de execução, 2 argumentos inválidos.',
].join('\n');

function parseArgs(argv) {
  const options = { cwd: process.cwd(), apply: false, undo: false, yes: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cwd') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--cwd exige um diretório');
      options.cwd = value; index += 1;
    } else if (arg === '--apply') options.apply = true;
    else if (arg === '--undo') options.undo = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`argumento desconhecido: ${arg}`);
  }
  if (options.apply && options.undo) throw new Error('--undo é exclusivo com --apply');
  if (options.yes && !options.apply && !options.undo) throw new Error('--yes exige --apply ou --undo');
  if (options.json && (options.apply || options.undo) && !options.yes) throw new Error('--json com operação destrutiva exige --yes');
  return options;
}

function resolveCwd(candidate) {
  const cwd = path.resolve(candidate);
  let stat;
  try { stat = fs.statSync(cwd); } catch (error) { throw new Error(`não foi possível acessar --cwd: ${error.message}`); }
  if (!stat.isDirectory()) throw new Error('--cwd precisa apontar para um diretório');
  return cwd;
}

function targetFor(group, byKey) {
  const survivor = byKey.get(group.survivor.storageKey);
  const losers = group.losers.map(item => byKey.get(item.storageKey)).filter(Boolean);
  if (!survivor || losers.length !== group.losers.length) throw new Error('fragmento do censo não está mais disponível');
  return {
    name: group.digest,
    store: 'memory',
    survivor: { storageKey: survivor.storageKey, path: survivor.path, unitId: survivor.unitId, milestoneId: survivor.milestoneId },
    members: losers.map(item => ({ storageKey: item.storageKey, path: item.path, unitId: item.unitId, milestoneId: item.milestoneId })),
    // Registry filters and preview key targets by this loser path.
    path: losers[0].path,
    // The eligibility boundary checks members and containerPath.  This is the
    // survivor's read-only vault input, not a new wrapper/container on disk.
    containerPath: survivor.path,
  };
}

function phaseSkipReason(phase) {
  // activeUnits deliberately exposes only a boolean safety result to callers.
  // Keep the CLI vocabulary stable even when its diagnostic wording changes.
  return !phase || phase.ok !== true ? 'active-phase-unknown' : null;
}

function targetLabel(target) {
  const survivor = target && target.survivor && target.survivor.storageKey;
  const losers = (target && target.members || []).map(member => member.storageKey).join(', ');
  return `sobrevivente ${survivor || 'desconhecido'}; perdedores ${losers || 'nenhum'}`;
}

function countTargets(plan) {
  return (plan && Array.isArray(plan.targets)) ? plan.targets.length : 0;
}

function dedupePlan(ctx) {
  const skipped = [];
  let census;
  let entries;
  try {
    census = findDuplicateGroups(ctx.cwd);
    // Kept on the short-lived command context because registry normalisation
    // intentionally exposes only targets/skipped. The textual preview still
    // needs to make a real empty census distinguishable from silence.
    ctx.dedupeVerdict = census.verdict;
    entries = memory.listFragments(ctx.cwd);
  } catch (error) {
    return { targets: [], skipped: [{ path: '.gsd/memory', reason: `censo-indisponível: ${error.message}` }] };
  }
  const byKey = new Map(entries.map(entry => [entry.storageKey, entry]));
  let phase;
  try { phase = activeUnits(ctx.cwd); }
  catch (error) { phase = { ok: false, reason: `active-phase-unknown: ${error.message}` }; }
  const targets = [];
  for (const group of census.groups) {
    let target;
    try { target = targetFor(group, byKey); }
    catch (error) { skipped.push({ path: group.survivor.storageKey, reason: `censo-indisponível: ${error.message}` }); continue; }
    const phaseReason = phaseSkipReason(phase);
    if (phaseReason) {
      skipped.push({ path: target.path, reason: phaseReason });
      continue;
    }
    const blocked = [target.survivor].concat(target.members).some(member =>
      isUnitBlocked(phase, member).blocked === true);
    if (blocked) { skipped.push({ path: target.path, reason: 'active-phase' }); continue; }
    targets.push(target);
  }
  for (const item of census.skipped || []) skipped.push({ path: item.key, reason: item.reason });
  return { targets, skipped, verdict: census.verdict };
}

function allFiles(plan) {
  const files = [];
  for (const target of plan.targets || []) {
    if (target.survivor && target.survivor.path) files.push(target.survivor.path);
    for (const member of target.members || []) if (member.path) files.push(member.path);
  }
  return [...new Set(files)];
}

function countPaths(plan) {
  const files = allFiles(plan);
  return { filesBefore: files.length, filesAfter: files.length, dirsBefore: 0, dirsAfter: 0 };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function applyDedupe(ctx, plan) {
  const files = allFiles(plan);
  if (files.length === 0) return { written: [], removed: [], skipped: plan.skipped || [], counts: countPaths(plan) };
  let vault;
  try { vault = writeVault(ctx.cwd, { operation: OPERATION, files }); }
  catch (error) {
    return { written: [], removed: [], skipped: (plan.skipped || []).concat([{ path: '.gsd/forge/sweep-vault', reason: `vault-failed: ${error.message}` }]), error: 'vault-failed', counts: countPaths(plan) };
  }
  if (vault.ok !== true) return { written: [], removed: [], skipped: (plan.skipped || []).concat(vault.skipped || [{ path: '.gsd/forge/sweep-vault', reason: 'vault-indisponível' }]), counts: countPaths(plan) };
  // Intent is the durable recovery pointer. If it fails no fragment is unlinked.
  const intent = journal.appendIntent(ctx.cwd, { operation: OPERATION, containers: [vault.containerPath] });
  if (intent.ok !== true) {
    try { fs.unlinkSync(vault.containerPath); } catch (_) { /* pre-apply cleanup is best effort */ }
    return { written: [], removed: [], skipped: (plan.skipped || []).concat([{ path: vault.containerPath, reason: `journal-intent-failed: ${intent.error}` }]), error: 'journal-intent-failed', counts: countPaths(plan) };
  }
  const removed = [];
  const skipped = (plan.skipped || []).slice();
  for (const target of plan.targets || []) {
    for (const member of target.members || []) {
      try { fs.unlinkSync(member.path); removed.push(member.path); }
      catch (error) { skipped.push({ path: member.path, reason: `remove-failed: ${error.message}` }); }
    }
  }
  const outcome = journal.appendOutcome(ctx.cwd, { id: intent.id, phase: 'apply-done', written: [vault.containerPath], sha256: { [path.relative(ctx.cwd, vault.containerPath).split(path.sep).join('/')]: sha256(vault.containerPath) } });
  if (outcome.ok !== true) skipped.push({ path: vault.containerPath, reason: `journal-outcome-failed: ${outcome.error}` });
  const counts = countPaths(plan); counts.filesAfter -= removed.length;
  return { written: [vault.containerPath], removed, skipped, journalId: intent.id, counts };
}

function buildRegistry() {
  const registry = createRegistry();
  registry.register({ name: OPERATION, description: 'Remove fragmentos de memória duplicados com vault reversível.', plan: dedupePlan, apply: applyDedupe });
  return registry;
}

function planFingerprint(preview) {
  return (preview.operations || []).flatMap(operation => (operation.targets || []).map(target =>
    `${operation.name}\0${target.survivor.path}\0${target.members.map(member => member.path).sort().join(',')}`)).sort().join('\n');
}

function errorsFor(result) {
  const errors = [];
  for (const entry of result.results || []) if (entry.error || (entry.result && entry.result.error)) errors.push(entry.error || entry.result.error);
  return errors;
}

function resultLines(result) {
  const lines = [];
  for (const entry of result.results || []) {
    if (!entry.result) continue;
    for (const written of entry.result.written || []) lines.push(`vault: ${written}`);
    for (const removed of entry.result.removed || []) lines.push(`removido: ${removed}`);
    for (const target of entry.result.targets || []) lines.push(targetLabel(target));
    for (const item of entry.result.skipped || []) lines.push(`pulado após aplicar: ${item.path} — ${item.reason}`);
  }
  return lines;
}

function journalInfo(result) {
  for (const entry of result.results || []) {
    if (entry.result && entry.result.journalId) return { id: entry.result.journalId, recorded: true };
  }
  return { id: null, recorded: false };
}

function hasPolicyError(result) {
  return (result.preview.operations || []).some(operation =>
    (operation.skipped || []).some(item => isVcsQueryFailure(item.reason)));
}

function noTargetMessage(ctx) {
  return ctx.dedupeVerdict === 'NO-TARGET' ? 'veredito NO-TARGET: nenhuma duplicata encontrada' : null;
}

function printPreview(options, result, eligibility, messages) {
  const allMessages = messages.concat(result.applied ? resultLines(result) : []);
  const payload = { preview: result.preview, applied: result.applied, vcs: eligibility.vcs, messages: allMessages, results: result.results || [], journal: journalInfo(result) };
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

async function runUndo(cwd, options) {
  const listed = journal.latestUndoable(cwd);
  if (listed.ok !== true) { process.stderr.write(`dedupe-memoria: ${listed.error}\n`); return 1; }
  if (!listed.entry) { process.stdout.write(options.json ? '{"undo":null,"messages":["nada para desfazer"]}\n' : 'nada para desfazer\n'); return 0; }
  if (!options.yes) {
    if (!process.stdin.isTTY) { process.stdout.write('desfazer não confirmado fora de TTY; use --yes para confirmar\n'); return 0; }
    if (!(await askConfirmation('Confirmar desfazer? Digite "sim": '))) { process.stdout.write('desfazer não confirmado\n'); return 0; }
  }
  const restored = []; const errors = [];
  for (const rel of listed.entry.containers) {
    const container = journal._private.safeContainerPath(cwd, rel);
    if (!container) { errors.push(`${rel}: container inválido`); continue; }
    try {
      const result = restoreVault(cwd, container);
      restored.push(...result.restored);
      for (const refused of result.refused) errors.push(`${refused.path}: ${refused.reason}`);
    } catch (error) { errors.push(`${rel}: ${error.message}`); }
  }
  if (errors.length === 0) {
    const outcome = journal.appendOutcome(cwd, { id: listed.entry.id, phase: 'undo-done', written: restored });
    if (outcome.ok !== true) errors.push(`journal: ${outcome.error}`);
  }
  const payload = { undo: { journalId: listed.entry.id, restored, errors } };
  process.stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : `desfeito: ${restored.length} restaurado(s)\n`);
  return errors.length ? 1 : 0;
}

async function main(argv) {
  let options;
  try { options = parseArgs(argv); } catch (error) { process.stderr.write(`${error.message}\n${USAGE}\n`); return 2; }
  if (options.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  try {
    const cwd = resolveCwd(options.cwd);
    if (options.undo) return runUndo(cwd, options);
    const ctx = { cwd };
    const eligibility = createEligibility(cwd, { toolUndo: { available: true } });
    const registry = buildRegistry();
    const messages = [];
    if (!options.apply) {
      const result = registry.run(ctx, { filter: eligibility.filter });
      const verdict = noTargetMessage(ctx); if (verdict) messages.push(verdict);
      printPreview(options, result, eligibility, messages);
      return errorsFor(result).length || hasPolicyError(result) ? 1 : 0;
    }
    if (!options.yes && !process.stdin.isTTY) {
      const result = registry.run(ctx, { filter: eligibility.filter }); messages.push('aplicação não confirmada fora de TTY; use --yes para confirmar'); printPreview(options, result, eligibility, messages); return 0;
    }
    let approved = null;
    if (!options.yes) {
      const preview = registry.run(ctx, { filter: eligibility.filter }); approved = planFingerprint(preview.preview);
      printPreview(options, preview, eligibility, messages);
      if (!(await askConfirmation('Confirmar aplicação? Digite "sim": '))) return 0;
    }
    let refusal = null;
    const result = registry.run(ctx, { filter: eligibility.filter, confirm: preview => {
      if (approved !== null && approved !== planFingerprint(preview)) { refusal = 'plano mudou desde a confirmação'; return false; }
      if (preview.totals.targets > 0) {
        const probe = journal.probe(cwd);
        if (probe.ok !== true) { refusal = `registro de undo indisponível — aplicação recusada: ${probe.error}`; return false; }
      }
      return true;
    } });
    const verdict = noTargetMessage(ctx); if (verdict) messages.push(verdict);
    if (refusal) messages.push(refusal);
    printPreview(options, result, eligibility, messages);
    return refusal || errorsFor(result).length ? 1 : 0;
  } catch (error) { process.stderr.write(`dedupe-memoria: ${error.message}\n`); return 1; }
}

module.exports = { buildRegistry, main, parseArgs, resolveCwd, _private: { dedupePlan, applyDedupe, targetFor, allFiles, planFingerprint } };
if (require.main === module) {
  main(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    // main()'s internal try/catch is not the sole exit path (runUndo's promise
    // is returned, not awaited), so a rejection must still exit cleanly.
    .catch(error => {
      process.stderr.write(`${(error && error.stack) || error}\n`);
      process.exitCode = 1;
    });
}
