#!/usr/bin/env node
'use strict';

// The project-facing sweep command is deliberately a thin wire: planning and
// filesystem changes belong to forge-epoch-group, while VCS policy belongs to
// forge-sweep-eligibility.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const epochGroup = require('./forge-epoch-group');
const { createRegistry, formatPreview } = require('./forge-sweep-registry');
const { createEligibility, isVcsQueryFailure } = require('./forge-sweep-eligibility');
const journal = require('./forge-sweep-journal');

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
  // An interactive prompt would have to share stdout with the report, breaking
  // the single-JSON-document invariant; require the non-interactive path.
  if (options.json && options.apply && !options.yes) throw new Error('--json --apply exige --yes');
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
      // The policy module owns this sentence; matching it by predicate keeps a
      // rename from silently degrading the exit code that automation reads.
      if (isVcsQueryFailure(item.reason)) return item.reason;
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

function reportPayload(result, eligibility, extraLines, journalInfo) {
  return {
    preview: result.preview,
    applied: result.applied,
    vcs: eligibility.vcs,
    forced: eligibility.forced,
    messages: extraLines,
    results: result.results,
    // Additive envelope field (gate convention): absent journalInfo keeps the
    // payload byte-identical to every pre-T04 caller/test.
    journal: journalInfo || { id: null, recorded: false },
  };
}

function writeReport(options, result, eligibility, extraLines, journalInfo) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(reportPayload(result, eligibility, extraLines, journalInfo), null, 2)}\n`);
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
    // EOF closes the interface without ever calling back; refuse rather than
    // leave the promise pending forever.
    terminal.on('close', () => resolve(false));
    terminal.question('Confirmar aplicação? Digite "sim": ', answer => {
      terminal.close();
      resolve(answer.trim().toLowerCase() === 'sim');
    });
  });
}

function statusLines(eligibility, options) {
  if (eligibility.vcs !== 'none') {
    // --force only relaxes the no-VCS refusal.  Saying so beats letting the
    // operator believe the flag took effect on a VCS-backed refusal.
    return options && options.force ? [`--force ignorado: repositório sob ${eligibility.vcs}`] : [];
  }
  if (eligibility.forced) return ['sem VCS — não há como desfazer', 'prosseguiu forçado'];
  return ['sem VCS — não há como desfazer', '0 elegíveis'];
}

/**
 * Identity of an approved plan: the container each target writes plus the ids
 * of the members it absorbs.  The apply run replans from scratch, so this is
 * what the operator actually agreed to move.
 */
function planFingerprint(preview) {
  const rows = [];
  for (const operation of (preview && preview.operations) || []) {
    for (const target of operation.targets || []) {
      const members = (Array.isArray(target.members) ? target.members : [])
        .map(member => String((member && (member.id || member.path)) || ''))
        .sort();
      rows.push(`${operation.name}\0${target.containerPath || target.path || ''}\0${members.join(',')}`);
    }
  }
  return rows.sort().join('\n');
}

/**
 * Reads the operation-level `bases` array applyFilter populates on an
 * accepted preview (see forge-sweep-registry.js): the container path of
 * every accepted target, plus whether any of them was promoted on the
 * `tool-undo` basis (DS8-3 decides refuse-vs-warn on that fact alone).
 */
function acceptedContainers(preview) {
  const containers = [];
  let hasToolUndo = false;
  for (const operation of (preview && preview.operations) || []) {
    // An operation that failed to plan never reaches apply() either (the
    // registry's own run() skips entries with `.error`) — mirror that here
    // so the journal never records a container that will not be written.
    if (operation.error) continue;
    for (const target of operation.targets || []) {
      if (target.containerPath) containers.push(target.containerPath);
    }
    for (const baseEntry of operation.bases || []) {
      if (baseEntry.basis === 'tool-undo') hasToolUndo = true;
    }
  }
  return { containers, hasToolUndo };
}

// Advisory only (S08-RISK.md § W3 — the container itself is the source of
// truth for content). A read failure here never blocks the outcome append;
// the sha just comes back absent for that container. Keys match the journal's
// own relative-POSIX normalization of `containers`, so a reader can join a
// sha256 to the entry's `containers` array by identity.
function sha256OfContainers(cwd, containers) {
  const sha256 = {};
  for (const container of containers) {
    try {
      const buf = fs.readFileSync(container);
      const abs = path.isAbsolute(container) ? container : path.resolve(cwd, container);
      const key = path.relative(cwd, abs).split(path.sep).join('/');
      sha256[key] = crypto.createHash('sha256').update(buf).digest('hex');
    } catch (_) { /* advisory — omit this container's hash */ }
  }
  return sha256;
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
    // Tool-undo is offered structurally for every target: the CLI's single
    // operation (epoch grouping) is always reversible via ungroup+journal in
    // principle. Whether the journal can actually RECORD that guarantee is
    // proven lazily, at the moment of apply (see confirm below) — not here.
    // Probing the journal at bootstrap would touch `.gsd/forge/**` even on a
    // dry-run or an unconfirmed --apply, breaking the pre-existing byte-
    // identical tree-snapshot regressions (must-have 6).
    const eligibility = createEligibility(cwd, { force: options.force, toolUndo: { available: true } });
    const registry = buildRegistry();
    const messages = statusLines(eligibility, options);

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

    let approvedFingerprint = null;
    if (!options.yes) {
      const preview = registry.run(ctx, { filter: eligibility.filter });
      if (!options.json) writeReport(options, preview, eligibility, messages);
      approvedFingerprint = planFingerprint(preview.preview);
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
    let journalId = null;
    let journalRefusal = null;
    const result = registry.run(ctx, {
      filter: eligibility.filter,
      confirm: (preview) => {
        // The apply run replans from scratch, so what the operator approved is
        // not necessarily what would be written.  Refuse on any divergence.
        if (approvedFingerprint !== null && planFingerprint(preview) !== approvedFingerprint) {
          messages.push('plano mudou desde a confirmação');
          return false;
        }
        // DS8-3: the pre-apply intent append is mandatory whenever there is
        // something to write. A failure refuses the WHOLE application when
        // any accepted target depends on the journal (basis tool-undo) — its
        // only recovery route — and never degrades to "proceed anyway" (B2).
        // A failure among vcs-basis-only targets is a warn-and-proceed: the
        // VCS, not the journal, is their guarantee.
        const { containers, hasToolUndo } = acceptedContainers(preview);
        if (containers.length > 0) {
          const probeResult = journal.probe(cwd);
          if (!probeResult.ok) {
            if (hasToolUndo) {
              journalRefusal = `registro de undo indisponível — aplicação recusada: ${probeResult.error}`;
              messages.push(journalRefusal);
              return false;
            }
            process.stderr.write(`registro de undo indisponível — prosseguindo sem journal: ${probeResult.error}\n`);
          } else {
            const intentResult = journal.appendIntent(cwd, { operation: 'agrupar-epocas-seladas', containers });
            if (intentResult.ok) {
              journalId = intentResult.id;
            } else if (hasToolUndo) {
              journalRefusal = `registro de undo indisponível — aplicação recusada: ${intentResult.error}`;
              messages.push(journalRefusal);
              return false;
            } else {
              process.stderr.write(`registro de undo indisponível — prosseguindo sem journal: ${intentResult.error}\n`);
            }
          }
        }
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

    if (result.applied && journalId) {
      const written = [];
      for (const entry of result.results || []) {
        if (entry.result && Array.isArray(entry.result.written)) written.push(...entry.result.written);
      }
      // Advisory outcome: the containers are already durable at this point —
      // the container is the source of truth for undo, not this record — so
      // a failure here only warns, it never affects the exit code (Design).
      const outcomeResult = journal.appendOutcome(cwd, {
        id: journalId,
        phase: 'apply-done',
        written,
        sha256: sha256OfContainers(cwd, written),
      });
      if (!outcomeResult.ok) {
        process.stderr.write(`aviso: falha ao registrar outcome no journal: ${outcomeResult.error}\n`);
      }
    }

    const journalInfo = { id: journalId, recorded: Boolean(journalId) };
    const applyLines = countReport(result);
    if (options.json) {
      const payload = reportPayload(result, eligibility, messages.concat(applyLines), journalInfo);
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      // A refusal inside confirm leaves nothing to count; surface why.
      if (!result.applied) process.stdout.write(`${journalRefusal || 'plano mudou desde a confirmação'}\n`);
      for (const line of applyLines) process.stdout.write(`${line}\n`);
    }
    const errors = resultErrors(result);
    const policyError = eligibilityError(result);
    if (policyError) errors.push(policyError);
    if (journalRefusal) errors.push(journalRefusal);
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
