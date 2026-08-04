'use strict';

// Standalone seam tests.  Run by the repository runner when the task is
// completed; this file intentionally is not executed during implementation.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createRegistry, formatPreview } = require('./forge-sweep-registry');

function operation(name, overrides = {}) {
  return Object.assign({
    name,
    description: `operação ${name}`,
    plan: () => ({
      targets: [
        { containerPath: `/tmp/${name}-a.md`, members: [{ id: 'a' }] },
        { containerPath: `/tmp/${name}-b.md`, members: [{ id: 'b' }, { id: 'c' }] },
      ],
      skipped: [{ path: `/tmp/${name}-skip-a.md`, reason: 'motivo A' }, { path: `/tmp/${name}-skip-b.md`, reason: 'motivo B' }],
    }),
    apply: () => ({ written: 1 }),
  }, overrides);
}

function testRegistrationAndSeam() {
  const registry = createRegistry();
  const fake = operation('fake');
  registry.register(fake);
  assert.deepStrictEqual(registry.list(), [fake]);
  const preview = registry.preview({ cwd: '/tmp' });
  assert.strictEqual(preview.operations.length, 1);
  assert.strictEqual(preview.operations[0].targets.length, 2);
  assert.strictEqual(preview.operations[0].skipped.length, 2);
  assert.strictEqual(preview.totals.targets, 2);
  assert.strictEqual(preview.totals.skipped, 2);
  const text = formatPreview(preview);
  assert(text.includes('/tmp/fake-a.md'));
  assert(text.includes('/tmp/fake-b.md'));
  assert(text.includes('/tmp/fake-skip-a.md — motivo A'));
  assert(text.includes('/tmp/fake-skip-b.md — motivo B'));
}

function testTwoOperationsPreserveOrder() {
  const registry = createRegistry();
  registry.register(operation('first'));
  registry.register(operation('second'));
  assert.deepStrictEqual(registry.preview({}).operations.map(item => item.name), ['first', 'second']);
  assert.throws(() => registry.register(operation('first')), /já registrada/);
  assert.throws(() => registry.register(null), /objeto/);
  assert.throws(() => registry.register({ name: 'bad', description: 'x' }), /plan/);
}

function testDryRun() {
  let applied = 0;
  const registry = createRegistry();
  registry.register(operation('dry', { apply: () => { applied += 1; } }));
  for (const opts of [{}, { confirm: () => false }, { confirm: () => 'yes' }]) {
    const result = registry.run({}, opts);
    assert.strictEqual(result.applied, false);
    assert.strictEqual(result.results.length, 0);
  }
  assert.strictEqual(applied, 0);
}

function testPreviewBeforeConfirm() {
  const calls = [];
  const registry = createRegistry();
  registry.register(operation('ordered', { plan: () => { calls.push('plan'); return { targets: [] }; } }));
  const result = registry.run({}, { confirm: preview => {
    calls.push('confirm');
    assert.strictEqual(preview.operations[0].name, 'ordered');
    return false;
  } });
  assert.strictEqual(result.applied, false);
  assert.deepStrictEqual(calls, ['plan', 'confirm']);
}

function testInjectedFilter() {
  let received;
  const registry = createRegistry();
  registry.register(operation('filtered', { apply: (ctx, plan) => { received = plan; return { ok: true }; } }));
  const result = registry.run({}, { filter: target => target.containerPath.endsWith('-a.md')
    ? { eligible: false, reason: 'fora da política' } : { eligible: true }, confirm: () => true });
  assert.strictEqual(result.applied, true);
  assert.strictEqual(received.targets.length, 1);
  assert.strictEqual(received.targets[0].containerPath, '/tmp/filtered-b.md');
  assert(result.preview.operations[0].skipped.some(item => item.reason === 'fora da política'));
}

function testFailureIsolation() {
  const registry = createRegistry();
  registry.register(operation('broken', { plan: () => { throw new Error('planejamento quebrou'); } }));
  registry.register(operation('healthy'));
  const preview = registry.preview({});
  assert.strictEqual(preview.operations[0].error, 'planejamento quebrou');
  assert.strictEqual(preview.operations[1].targets.length, 2);
  assert.strictEqual(preview.totals.failed, 1);
  const result = registry.run({}, { confirm: () => true });
  assert.strictEqual(result.results[1].name, 'healthy');
}

function testApplyFailureIsolation() {
  let healthyApplied = false;
  const registry = createRegistry();
  registry.register(operation('apply-broken', { apply: () => { throw new Error('aplicação quebrou'); } }));
  registry.register(operation('apply-healthy', { apply: () => { healthyApplied = true; } }));
  const result = registry.run({}, { confirm: () => true });
  assert.strictEqual(healthyApplied, true);
  assert.strictEqual(result.results[0].error, 'aplicação quebrou');
  assert.strictEqual(result.results[1].name, 'apply-healthy');
}

function testHygiene() {
  const source = fs.readFileSync(path.join(__dirname, 'forge-sweep-registry.js'), 'utf8');
  assert(!source.includes("require('./forge-"));
  assert(!source.includes('child_process'));
}

function testFormattingDetails() {
  const text = formatPreview({
    operations: [{
      name: 'detalhes',
      description: 'descrição',
      targets: [{ path: 'alvo-sem-container', members: [] }, { name: 'alvo-nome' }],
      skipped: [{ path: 'um.md', reason: 'motivo único' }],
      error: null,
    }],
    totals: { operations: 1, targets: 2, skipped: 1, failed: 0 },
  });
  assert(text.includes('alvo-sem-container — 0 membro(s)'));
  assert(text.includes('alvo-nome — 0 membro(s)'));
  assert(text.includes('um.md — motivo único'));
  assert(text.includes('Totais:'));
}

function testFilteredPlanKeepsExistingSkippedItems() {
  let appliedPlan;
  const registry = createRegistry();
  registry.register(operation('keeps-skips', {
    apply: (ctx, plan) => { appliedPlan = plan; return {}; },
  }));
  registry.run({}, {
    filter: () => ({ eligible: false, reason: 'recusa uniforme' }),
    confirm: preview => {
      assert.strictEqual(preview.operations[0].skipped.length, 4);
      return true;
    },
  });
  assert.strictEqual(appliedPlan.targets.length, 0);
  assert.strictEqual(appliedPlan.skipped.length, 4);
}

testRegistrationAndSeam();
testTwoOperationsPreserveOrder();
testDryRun();
testPreviewBeforeConfirm();
testInjectedFilter();
testFailureIsolation();
testApplyFailureIsolation();
testHygiene();
testFormattingDetails();
testFilteredPlanKeepsExistingSkippedItems();
