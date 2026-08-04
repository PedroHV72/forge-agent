#!/usr/bin/env node
'use strict';

// The project-facing sweep command is deliberately a thin wire: planning and
// filesystem changes belong to forge-epoch-group, while VCS policy belongs to
// forge-sweep-eligibility.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const epochGroup = require('./forge-epoch-group');
const { createRegistry, formatPreview } = require('./forge-sweep-registry');
const { createEligibility } = require('./forge-sweep-eligibility');

const USAGE = [
  'Uso: node scripts/forge-sweep-project.js [opções]',
  '',
  'Opções:',
  '  --cwd <dir>  Diretório do projeto (padrão: diretório atual)',
  '  --apply      Aplica o plano depois de confirmação explícita',
  '  --yes        Confirma a aplicação sem pergunta interativa',
  '  --force      Prossegue sem VCS; não haverá como desfazer',
  '  --json       Emite o relatório no formato JSON',
  '  --help       Mostra esta ajuda',
  '',
  'Códigos de saída: 0 sucesso, 1 erro de execução, 2 argumentos inválidos.',
].join('\n');

function buildRegistry() {
  const registry = createRegistry();
  registry.register({
    name: 'agrupar-epocas-seladas',
    description: 'Agrupa fragmentos de épocas seladas em containers reversíveis.',
    // D11: deliberately omit includeWrapperDirs; wrapper readers listed in
    // docs/wrapper-dir-readers.md still include entries that break.
    plan: ctx => epochGroup.plan(ctx.cwd),
    apply: (ctx, groupingPlan) => epochGroup.apply(ctx.cwd, groupingPlan),
  });
  return registry;
}

function parseArgs(argv) {
  const options = { cwd: process.cwd(), apply: false, yes: false, force: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cwd') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--cwd exige um diretório');
      options.cwd = value;
      index += 1;
    } else if (arg === '--apply') options.apply = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`argumento desconhecido: ${arg}`);
  }
  if (options.yes && !options.apply) throw new Error('--yes exige --apply');
  if (options.force && !options.apply) throw new Error('--force exige --apply');
  return options;
}

function resolveCwd(candidate) {
  const cwd = path.resolve(candidate);
  let stat;
  try { stat = fs.statSync(cwd); }
  catch (error) { throw new Error(`não foi possível acessar --cwd: ${error.message}`); }
  if (!stat.isDirectory()) throw new Error('--cwd precisa apontar para um diretório');
  return cwd;
}

function resultErrors(result) {
  const errors = [];
  for (const operation of result.preview.operations) {
    if (operation.error) errors.push(`${operation.name}: ${operation.error}`);
  }
  for (const entry of result.results || []) {
    if (entry.error) errors.push(`${entry.name}: ${entry.error}`);
  }
  return errors;
}

function eligibilityError(result) {
  for (const operation of result.preview.operations) {
    for (const item of operation.skipped || []) {
      if (typeof item.reason === 'string' && item.reason.startsWith('falha ao consultar estado do VCS:')) {
        return item.reason;
      }
    }
  }
  return null;
}

function countReport(result) {
  const lines = [];
  for (const entry of result.results || []) {
    if (!entry.result) continue;
    for (const written of entry.result.written || []) lines.push(`escrito: ${written}`);
    const counts = entry.result.counts;
    if (counts) {
      lines.push(`arquivos: ${counts.filesBefore} → ${counts.filesAfter}`);
      lines.push(`pastas: ${counts.dirsBefore} → ${counts.dirsAfter}`);
    }
    for (const item of entry.result.skipped || []) lines.push(`pulado após aplicar: ${item.path} — ${item.reason}`);
  }
  return lines;
}

function reportPayload(result, eligibility, extraLines) {
  return {
    preview: result.preview,
    applied: result.applied,
    vcs: eligibility.vcs,
    forced: eligibility.forced,
    messages: extraLines,
    results: result.results,
  };
}

function writeReport(options, result, eligibility, extraLines) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(reportPayload(result, eligibility, extraLines), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatPreview(result.preview)}\n`);
  // Keep an explicit section even for an empty plan, so the dry-run output
  // always reports skipped work rather than implying that it was omitted.
  if (result.preview.totals.skipped === 0) process.stdout.write('Pulados: nenhum\n');
  for (const line of extraLines) process.stdout.write(`${line}\n`);
}

function askForConfirmation() {
  // readline owns the terminal prompt; its question API is asynchronous, so
  // main's TTY branch first creates a dry preview and asks before its apply run.
  return new Promise(resolve => {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
    terminal.question('Confirmar aplicação? Digite "sim": ', answer => {
      terminal.close();
      resolve(answer.trim().toLowerCase() === 'sim');
    });
  });
}

function statusLines(eligibility) {
  if (eligibility.vcs !== 'none') return [];
  if (eligibility.forced) return ['sem VCS — não há como desfazer', 'prosseguiu forçado'];
  return ['sem VCS — não há como desfazer', '0 elegíveis'];
}

async function main(argv) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    const cwd = resolveCwd(options.cwd);
    const ctx = { cwd };
    const eligibility = createEligibility(cwd, { force: options.force });
    const registry = buildRegistry();
    const messages = statusLines(eligibility);

    if (!options.apply) {
      const result = registry.run(ctx, { filter: eligibility.filter });
      writeReport(options, result, eligibility, messages);
      return resultErrors(result).length || eligibilityError(result) ? 1 : 0;
    }

    if (!options.yes && !process.stdin.isTTY) {
      const result = registry.run(ctx, { filter: eligibility.filter });
      messages.push('aplicação não confirmada fora de TTY; use --yes para confirmar');
      writeReport(options, result, eligibility, messages);
      return resultErrors(result).length || eligibilityError(result) ? 1 : 0;
    }

    if (!options.yes) {
      const preview = registry.run(ctx, { filter: eligibility.filter });
      if (!options.json) writeReport(options, preview, eligibility, messages);
      if (!(await askForConfirmation())) {
        if (options.json) {
          process.stdout.write(`${JSON.stringify(reportPayload(preview, eligibility, messages.concat('aplicação não confirmada')), null, 2)}\n`);
        } else {
          process.stdout.write('aplicação não confirmada\n');
        }
        return resultErrors(preview).length || eligibilityError(preview) ? 1 : 0;
      }
    }

    let previewWasWritten = !options.yes;
    const result = registry.run(ctx, {
      filter: eligibility.filter,
      confirm: (preview) => {
        if (!previewWasWritten) {
          // In JSON mode the final envelope retains the preview and result in
          // one valid document.  The registry has still completed previewing
          // before this explicit --yes confirmation is accepted.
          if (!options.json) writeReport(options, { applied: false, preview, results: [] }, eligibility, messages);
          previewWasWritten = true;
        }
        return true;
      },
    });
    const applyLines = countReport(result);
    if (options.json) {
      const payload = reportPayload(result, eligibility, messages.concat(applyLines));
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      for (const line of applyLines) process.stdout.write(`${line}\n`);
    }
    const errors = resultErrors(result);
    const policyError = eligibilityError(result);
    if (policyError) errors.push(policyError);
    for (const error of errors) process.stderr.write(`${error}\n`);
    return errors.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`forge-sweep-project: ${error.message}\n`);
    return 1;
  }
}

module.exports = { buildRegistry, main, parseArgs, resolveCwd };

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
