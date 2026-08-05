'use strict';

// Generic operation registry for sweep commands.  Operations own their plan
// and apply semantics; this module only coordinates a list of them.

function assertOperation(operation) {
  if (!operation || typeof operation !== 'object') {
    throw new TypeError('operação deve ser um objeto');
  }
  if (typeof operation.name !== 'string' || !operation.name.trim()) {
    throw new TypeError('operação precisa de name não-vazio');
  }
  if (typeof operation.description !== 'string' || !operation.description.trim()) {
    throw new TypeError('operação precisa de description não-vazia');
  }
  if (typeof operation.plan !== 'function') {
    throw new TypeError('operação precisa de plan(ctx)');
  }
  if (typeof operation.apply !== 'function') {
    throw new TypeError('operação precisa de apply(ctx, plan)');
  }
}

function normalizePlan(operation, value) {
  const plan = value && typeof value === 'object' ? value : {};
  return {
    name: operation.name,
    description: operation.description,
    targets: Array.isArray(plan.targets) ? plan.targets.slice() : [],
    skipped: Array.isArray(plan.skipped) ? plan.skipped.slice() : [],
    // Additive: populated only by applyFilter when a filter decision reports
    // a `basis`. No operation ever supplies this itself — it is generic
    // metadata about the filter's decision, not about the operation.
    bases: [],
    error: null,
  };
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function totalsFor(operations) {
  return {
    operations: operations.length,
    targets: operations.reduce((sum, item) => sum + item.targets.length, 0),
    skipped: operations.reduce((sum, item) => sum + item.skipped.length, 0),
    failed: operations.reduce((sum, item) => sum + (item.error ? 1 : 0), 0),
  };
}

function createRegistry() {
  const operations = [];

  function register(operation) {
    assertOperation(operation);
    if (operations.some(item => item.name === operation.name)) {
      throw new Error(`operação já registrada: ${operation.name}`);
    }
    operations.push(operation);
    return operation;
  }

  function list() {
    return operations.slice();
  }

  function preview(ctx) {
    const entries = [];
    for (const operation of operations) {
      try {
        entries.push(normalizePlan(operation, operation.plan(ctx)));
      } catch (error) {
        entries.push({
          name: operation.name,
          description: operation.description,
          targets: [],
          skipped: [],
          error: errorMessage(error),
        });
      }
    }
    return { operations: entries, totals: totalsFor(entries) };
  }

  function applyFilter(preview, filter, ctx) {
    for (const entry of preview.operations) {
      if (entry.error) continue;
      const accepted = [];
      if (!Array.isArray(entry.bases)) entry.bases = [];
      for (const target of entry.targets) {
        let decision;
        try {
          decision = filter(target, entry, ctx);
        } catch (error) {
          decision = { eligible: false, reason: errorMessage(error) };
        }
        if (decision && decision.eligible === false) {
          entry.skipped.push({
            path: target.path || target.containerPath || String(target),
            reason: decision.reason || 'recusado pelo filtro',
          });
        } else {
          accepted.push(target);
          // Generic over any decision shape: an accepted decision without a
          // `basis` field (e.g. the S05 fake-operation seam's `{ eligible:
          // true }`) leaves `bases` untouched — no operation-specific code
          // enters this seam.
          if (decision && decision.basis) {
            entry.bases.push({
              path: target.path || target.containerPath || String(target),
              basis: decision.basis,
              note: decision.note || null,
            });
          }
        }
      }
      entry.targets = accepted;
    }
    preview.totals = totalsFor(preview.operations);
    return preview;
  }

  function run(ctx, opts = {}) {
    const previewResult = applyFilter(
      preview(ctx),
      typeof opts.filter === 'function' ? opts.filter : () => ({ eligible: true }),
      ctx,
    );
    if (typeof opts.confirm !== 'function' || opts.confirm(previewResult) !== true) {
      return { applied: false, preview: previewResult, results: [] };
    }

    const results = [];
    for (const operation of operations) {
      const entry = previewResult.operations.find(item => item.name === operation.name);
      if (!entry || entry.error) {
        results.push({ name: operation.name, error: entry && entry.error ? entry.error : 'plano indisponível' });
        continue;
      }
      try {
        results.push({ name: operation.name, result: operation.apply(ctx, {
          targets: entry.targets,
          skipped: entry.skipped,
        }) });
      } catch (error) {
        entry.error = errorMessage(error);
        results.push({ name: operation.name, error: entry.error });
      }
    }
    previewResult.totals = totalsFor(previewResult.operations);
    return { applied: true, preview: previewResult, results };
  }

  return { register, list, preview, run };
}

function formatPreview(preview) {
  const lines = ['Prévia do sweep'];
  for (const operation of (preview && preview.operations) || []) {
    lines.push(`\n${operation.name}: ${operation.description}`);
    if (operation.error) lines.push(`falha: ${operation.error}`);
    const bases = Array.isArray(operation.bases) ? operation.bases : [];
    for (const target of operation.targets || []) {
      const identity = target.containerPath || target.path || target.name || 'alvo sem identificação';
      const count = Array.isArray(target.members) ? target.members.length : 0;
      // Same fallback order applyFilter used to key `bases` — deliberately
      // distinct from `identity` above, which favours containerPath for
      // display. A target absent from `bases` (no basis was reported for
      // it) keeps the legacy line byte-identical.
      const matchKey = target.path || target.containerPath || String(target);
      const basisEntry = bases.find(item => item.path === matchKey);
      let line = `alvo: ${identity} — ${count} membro(s)`;
      if (basisEntry) {
        line += basisEntry.basis === 'tool-undo'
          ? ' — elegível por undo de ferramenta'
          : ' — elegível por VCS';
      }
      lines.push(line);
      if (basisEntry && basisEntry.note) lines.push(`  ${basisEntry.note}`);
    }
    if (operation.skipped && operation.skipped.length) {
      lines.push('Pulados:');
      for (const item of operation.skipped) {
        lines.push(`${item.path || 'item sem caminho'} — ${item.reason || 'motivo não informado'}`);
      }
    }
  }
  const totals = preview && preview.totals;
  if (totals) lines.push(`\nTotais: ${totals.operations} operação(ões), ${totals.targets} alvo(s), ${totals.skipped} pulado(s), ${totals.failed} falha(s)`);
  return lines.join('\n');
}

module.exports = { createRegistry, formatPreview };
