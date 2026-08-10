#!/usr/bin/env node
'use strict';

// The project-facing sweep command is deliberately a thin wire: planning and
// filesystem changes belong to forge-epoch-group, while VCS policy belongs to
// forge-sweep-eligibility.
//
// ── Invocation policy (operator decision, 2026-08-05) ────────────────────────
// This command is HUMAN-INVOKED ONLY. There is deliberately no skill and no
// slash command for it, and its absence is the design — not an oversight.
//
// Compare with `skills/forge-sweep/SKILL.md`, which carries its own
// `## Invocation policy` declaring the opposite: that one IS model-invocable at
// the end of a task or milestone, once the human has validated the work.
//
// The two are destructive at different scales, so they get different owners for
// the decision. `/forge-sweep` prunes know-how files at the close of one cycle,
// where the human validation gate already happened in conversation. This command
// rewrites the whole fragment store (ledger + decisions + memory) into grouped
// containers — in a real project that is hundreds of fragments at once. Having to
// name the command is itself the safety gate: it demonstrates deliberate intent
// in a way no skill can, because a skill exists precisely to be invocable without
// the user asking for it by name.
//
// Consequences, so a future reader does not "fix" the gap:
//   - Ambiguous phrasing ("run the sweep", "clean this up") ALWAYS means
//     /forge-sweep, never this command. Treating a vague request as a possible
//     sweep-project — even only to ask which one — already weakens the gate.
//   - An agent must not offer this as a natural next step at the end of a cycle.
//     Running the read-only preview on request is fine (it is the default); only
//     --apply and --undo require the operator to ask explicitly.
//   - A proposal to add a /forge-sweep-project skill, or any auto-invocation
//     surface, contradicts this decision.
//
// The confirmation prompt below (askForConfirmation) implements the same policy
// at runtime: --apply and --undo require typing "sim", and --yes is the explicit
// opt-out for non-interactive callers.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const epochGroup = require('./forge-epoch-group');
const { createRegistry, formatPreview } = require('./forge-sweep-registry');
const { createEligibility, isVcsQueryFailure } = require('./forge-sweep-eligibility');
const journal = require('./forge-sweep-journal');
const { parseGroup, isGroupedFile } = require('./forge-grouped-file');

const USAGE = [
  'Uso: node scripts/forge-sweep-project.js [opções]',
  '',
  'Opções:',
  '  --cwd <dir>  Diretório do projeto (padrão: diretório atual)',
  '  --apply      Aplica o plano depois de confirmação explícita',
  '  --yes        Confirma a aplicação/desfazer sem pergunta interativa',
  '  --force      Prossegue sem VCS; não haverá como desfazer',
  '  --undo       Desfaz o registro mais recente do journal (exclusivo com --apply/--force)',
  '  --list       Lista os containers de varredura existentes (leitura pura, exclusivo com --apply/--undo)',
  '  --json       Emite o relatório no formato JSON',
  '  --help       Mostra esta ajuda',
  '',
  'Códigos de saída: 0 sucesso, 1 erro de execução, 2 argumentos inválidos.',
].join('\n');

function buildRegistry() {
  const registry = createRegistry();
  registry.register({
    name: 'agrupar-unidades-encerradas',
    description: 'Agrupa unidades encerradas comprovadas em containers de varredura reversíveis.',
    // D11: deliberately omit includeWrapperDirs; wrapper readers listed in
    // docs/wrapper-dir-readers.md still include entries that break.
    plan: ctx => epochGroup.plan(ctx.cwd),
    apply: (ctx, groupingPlan) => epochGroup.apply(ctx.cwd, groupingPlan),
  });
  return registry;
}

function parseArgs(argv) {
  const options = { cwd: process.cwd(), apply: false, yes: false, force: false, undo: false, list: false, json: false, help: false };
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
    else if (arg === '--undo') options.undo = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`argumento desconhecido: ${arg}`);
  }
  // --undo is a distinct mode; it never composes with a plan-apply run.
  if (options.undo && options.apply) throw new Error('--undo é exclusivo com --apply');
  if (options.undo && options.force) throw new Error('--undo é exclusivo com --force');
  // --list is read-only enumeration; it never composes with a mutating mode.
  if (options.list && options.apply) throw new Error('--list é exclusivo com --apply');
  if (options.list && options.undo) throw new Error('--list é exclusivo com --undo');
  if (options.list && options.force) throw new Error('--list é exclusivo com --force');
  if (options.yes && !options.apply && !options.undo) throw new Error('--yes exige --apply ou --undo');
  if (options.force && !options.apply) throw new Error('--force exige --apply');
  // An interactive prompt would have to share stdout with the report, breaking
  // the single-JSON-document invariant; require the non-interactive path.
  if (options.json && options.apply && !options.yes) throw new Error('--json --apply exige --yes');
  if (options.json && options.undo && !options.yes) throw new Error('--json --undo exige --yes');
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

function askForConfirmation(promptText) {
  // readline owns the terminal prompt; its question API is asynchronous, so
  // main's TTY branch first creates a dry preview and asks before its apply run.
  return new Promise(resolve => {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
    // EOF closes the interface without ever calling back; refuse rather than
    // leave the promise pending forever.
    terminal.on('close', () => resolve(false));
    terminal.question(promptText || 'Confirmar aplicação? Digite "sim": ', answer => {
      terminal.close();
      resolve(answer.trim().toLowerCase() === 'sim');
    });
  });
}

// R16 triage: the D11 gate (wrapper dirs excluded from this CLI's plan) is
// closed by design — see buildRegistry above — but a closed gate that never
// appears in the output is indistinguishable from one that silently broke.
// This line is informative, not a warning: it proves the gate ran.
function wrapperGateLine(cwd) {
  const count = epochGroup.countProtectedWrapperDirs(cwd);
  return `${count} invólucro(s) protegido(s) (gate D11 fechado — não incluído nesta varredura)`;
}

function statusLines(eligibility, options, cwd) {
  const gateLine = wrapperGateLine(cwd);
  if (eligibility.vcs !== 'none') {
    // --force only relaxes the no-VCS refusal.  Saying so beats letting the
    // operator believe the flag took effect on a VCS-backed refusal.
    return (options && options.force ? [`--force ignorado: repositório sob ${eligibility.vcs}`] : []).concat(gateLine);
  }
  if (eligibility.forced) return ['sem VCS — não há como desfazer', 'prosseguiu forçado', gateLine];
  return ['sem VCS — não há como desfazer', '0 elegíveis', gateLine];
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

// Looks up the operation name recorded on the matching apply-intent line
// (same id, sibling record). Advisory only — a miss just narrows the
// preview text, it never blocks the undo.
function operationNameFor(entries, id) {
  const intent = entries.find(entry => entry.id === id && entry.phase === 'apply-intent');
  return (intent && intent.operation) || 'desconhecida';
}

function resolveUndoContainers(cwd, entry) {
  const containers = [];
  for (const rel of entry.containers || []) {
    const abs = journal._private.safeContainerPath(cwd, rel);
    // latestUndoable already validated safety+presence for this exact entry;
    // a miss here would mean the disk changed between the two reads. Skip
    // rather than throw — the per-container try/catch below is the one
    // sanctioned isolation boundary (Design).
    if (abs) containers.push({ rel, abs });
  }
  return containers;
}

function undoPreviewLines(entry, operationName, containers) {
  const lines = [
    'Prévia do desfazer',
    `registro: ${entry.id} (${entry.ts}, operação: ${operationName})`,
  ];
  for (const container of containers) {
    let unitCount = '?';
    try {
      const parsed = parseGroup(fs.readFileSync(container.abs));
      unitCount = String(parsed.units.length);
    } catch (_) { /* advisory — preview still lists the container */ }
    lines.push(`  - ${container.rel} (${unitCount} unidades)`);
  }
  return lines;
}

function undoNothingPayload(message) {
  return { undo: { journalId: null, restored: [], alreadyPresent: [], errors: [] }, messages: [message] };
}

/**
 * --undo mode: resolves the latest undoable journal record, previews its
 * containers, confirms (TTY "sim" / --yes), then restores each container via
 * epochGroup.ungroup with per-container failure isolation (Design/B1). Never
 * touches the VCS — restoring is 100% delegated to ungroup.
 */
async function runUndo(cwd, options) {
  const listed = journal.latestUndoable(cwd);
  if (!listed.ok) {
    process.stderr.write(`forge-sweep-project: ${listed.error}\n`);
    return 1;
  }
  const entry = listed.entry;
  if (!entry) {
    const message = 'nada para desfazer';
    if (options.json) process.stdout.write(`${JSON.stringify(undoNothingPayload(message), null, 2)}\n`);
    else process.stdout.write(`${message}\n`);
    return 0;
  }

  const allEntries = journal.listEntries(cwd);
  const operationName = operationNameFor(allEntries.ok ? allEntries.entries : [], entry.id);
  const containers = resolveUndoContainers(cwd, entry);
  const previewLines = undoPreviewLines(entry, operationName, containers);

  // --json --undo always carries --yes (parseArgs enforces it), so the
  // interactive/no-TTY branches below are only reachable in text mode.
  if (!options.json) for (const line of previewLines) process.stdout.write(`${line}\n`);

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      process.stdout.write('desfazer não confirmado fora de TTY; use --yes para confirmar\n');
      return 0;
    }
    const confirmed = await askForConfirmation('Confirmar desfazer? Digite "sim": ');
    if (!confirmed) {
      process.stdout.write('desfazer não confirmado\n');
      return 0;
    }
  }

  const restored = [];
  const alreadyPresent = [];
  const errors = [];
  for (const container of containers) {
    const recordedSha = entry.sha256 && entry.sha256[container.rel];
    if (recordedSha) {
      try {
        const actualSha = crypto.createHash('sha256').update(fs.readFileSync(container.abs)).digest('hex');
        if (actualSha !== recordedSha) {
          process.stderr.write(`aviso: sha256 divergente para ${container.rel} (registrado vs disco) — prosseguindo com o parse do container\n`);
        }
      } catch (_) { /* advisory — the ungroup below is still the source of truth */ }
    }
    try {
      const result = epochGroup.ungroup(cwd, container.abs);
      restored.push(...result.restored);
      alreadyPresent.push(...result.alreadyPresent);
    } catch (error) {
      // Isolation by item (Design/B1): one conflicting container never stops
      // the rest, and it survives on disk (ungroup only unlinks after every
      // unit in it restores cleanly).
      errors.push({ container: container.rel, error: error.message });
    }
  }

  if (errors.length === 0) {
    const outcomeResult = journal.appendOutcome(cwd, { id: entry.id, phase: 'undo-done', written: restored });
    if (!outcomeResult.ok) {
      process.stderr.write(`aviso: falha ao registrar undo-done no journal: ${outcomeResult.error}\n`);
    }
  }

  const payload = {
    undo: {
      journalId: entry.id,
      restored,
      alreadyPresent,
      errors: errors.map(item => `${item.container}: ${item.error}`),
    },
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const path_ of restored) process.stdout.write(`restaurado: ${path_}\n`);
    process.stdout.write(`desfeito: ${restored.length} restaurado(s), ${alreadyPresent.length} já presente(s)\n`);
    for (const item of errors) process.stderr.write(`${item.container}: ${item.error}\n`);
  }
  return errors.length ? 1 : 0;
}

/**
 * --list mode: pure read-only enumeration of grouped containers across the
 * three fragment stores (ledger, decisions, memory). No VCS query, no
 * journal touch, no filesystem write — must-have #4's byte-identical
 * before/after snapshot is what this function is built to satisfy.
 */
function collectContainers(cwd) {
  const rows = [];
  for (const store of epochGroup.STORE_TARGETS) {
    const dir = store.dir(cwd);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = path.join(dir, entry.name);
      let buffer;
      try { buffer = fs.readFileSync(filePath); }
      catch (_) {
        // Unreadable file: fall back to the name-only recognition idiom
        // used by the store readers (forge-memory.js, forge-ledger.js) —
        // DS9-1 promises legacy containers stay listable, and an unreadable
        // one is exactly the case that idiom exists for. Surface it as an
        // error row instead of silently dropping it (review R2).
        if (isGroupedFile(entry.name)) {
          rows.push({
            store: store.name,
            name: entry.name,
            label: path.basename(entry.name, '.md'),
            from: null,
            to: null,
            units: null,
            error: 'container-unreadable',
          });
        }
        continue;
      }
      if (!isGroupedFile(entry.name, buffer)) continue;
      const parsed = parseGroup(buffer);
      const label = parsed.label || path.basename(entry.name, '.md');
      rows.push({
        store: store.name,
        name: entry.name,
        label,
        from: parsed.from,
        to: parsed.to,
        units: parsed.units.length,
      });
    }
  }
  // Deterministic ordering (store, then name) — DS9-1/step 2: --list never
  // reorders by date, which would pretend a chronology the sweep numbers do
  // not carry.
  rows.sort((a, b) => (a.store === b.store ? a.name.localeCompare(b.name) : a.store.localeCompare(b.store)));
  return rows;
}

function formatListRow(row) {
  if (row.error) {
    return `${row.store}: ${row.label} — erro: ${row.error} — unidades não listadas`;
  }
  // A legacy PR-1 container never had grouped_from/grouped_to at all —
  // empty parens would read as "the range is blank", which is misleading;
  // say plainly that no range was ever recorded for it (DS9-1).
  const range = row.from && row.to ? `${row.from} → ${row.to}` : 'faixa não registrada';
  return `${row.store}: ${row.label} (${range}) — ${row.units} unidade(s)`;
}

function listPayload(rows) {
  return {
    containers: rows.map(row => ({
      store: row.store,
      name: row.name,
      label: row.label,
      from: row.from,
      to: row.to,
      units: row.units,
      ...(row.error ? { error: row.error } : {}),
    })),
  };
}

function runList(cwd, options) {
  const rows = collectContainers(cwd);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(listPayload(rows), null, 2)}\n`);
    return 0;
  }
  if (!rows.length) {
    // Silence is indistinguishable from a broken command — always say so.
    process.stdout.write('nenhum container de varredura encontrado\n');
    return 0;
  }
  for (const row of rows) process.stdout.write(`${formatListRow(row)}\n`);
  return 0;
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
    // Pure reads first: --list never queries the VCS, never touches the
    // journal, and never mutates a byte — resolving it before eligibility
    // setup keeps that guarantee structural, not just documented.
    if (options.list) return runList(cwd, options);
    if (options.undo) return await runUndo(cwd, options);
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
    const messages = statusLines(eligibility, options, cwd);

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
            const intentResult = journal.appendIntent(cwd, { operation: 'agrupar-unidades-encerradas', containers });
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

    // R2 fix: `recorded` must reflect whether undo is actually discoverable,
    // not merely whether a journal id was minted. An apply-intent id is
    // truthy on its own (it is the fallback `latestUndoable` now resolves
    // through — see forge-sweep-journal.js), so start optimistic and only
    // flip to false when the apply-done outcome append itself fails.
    let journalOutcomeFailed = false;
    if (result.applied && journalId) {
      const written = [];
      for (const entry of result.results || []) {
        if (entry.result && Array.isArray(entry.result.written)) written.push(...entry.result.written);
      }
      // Advisory outcome: the containers are already durable at this point —
      // the container is the source of truth for undo, not this record — so
      // a failure here never affects the exit code (Design). It DOES,
      // however, need to be reflected in journalInfo.recorded below — the
      // intent record survives and `latestUndoable` still resolves through
      // it, but the caller-facing envelope must not overstate what actually
      // landed durably in this run.
      const outcomeResult = journal.appendOutcome(cwd, {
        id: journalId,
        phase: 'apply-done',
        written,
        sha256: sha256OfContainers(cwd, written),
      });
      if (!outcomeResult.ok) {
        journalOutcomeFailed = true;
        process.stderr.write(`aviso: falha ao registrar outcome no journal: ${outcomeResult.error}\n`);
      }
    }

    const journalInfo = { id: journalId, recorded: Boolean(journalId) && !journalOutcomeFailed };
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
