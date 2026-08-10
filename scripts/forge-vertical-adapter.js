#!/usr/bin/env node
'use strict';

// Thin presentation/input bridge. It delegates every lifecycle decision to
// forge-orchestrate and never reads a provider home, lease file or transcript.
const orchestrate = require('./forge-orchestrate');

const HOSTS = Object.freeze(['claude', 'codex']);
function error(code, message) { const value = new Error(message); value.code = code; return value; }
function host(value) { if (!HOSTS.includes(value)) throw error('invalid-host', `host_runtime inválido: ${value}`); return value; }
function present(runtime, result) {
  return { adapter_runtime: host(runtime), result };
}
function invoke(runtime, operation, input, options) {
  const selected = host(runtime);
  if (operation === 'handoff') {
    const payload = input || {};
    const previous = payload.previous_host_runtime || payload.from_runtime;
    return handoff(previous, selected, payload);
  }
  if (!['init', 'status', 'next'].includes(operation)) throw error('invalid-operation', `operação não suportada: ${operation}`);
  return present(selected, orchestrate.run(operation, { ...(input || {}), host_runtime: selected }, options));
}
function collect(runtime, input, response, options) {
  const selected = host(runtime);
  const payload = { ...(input || {}), host_runtime: selected, response };
  return invoke(selected, 'next', payload, options);
}
function handoff(fromRuntime, toRuntime, input) {
  const from = host(fromRuntime); const to = host(toRuntime);
  if (from === to) throw error('invalid-handoff', 'handoff requer hosts distintos');
  return present(to, orchestrate.handoff({ ...(input || {}), host_runtime: to, previous_host_runtime: from }));
}
function serialize(value) { return JSON.stringify(value); }
function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host') out.host = argv[++i];
    else if (arg === '--operation') out.operation = argv[++i];
    else if (arg === '--json') out.json = argv[++i] || '{}';
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw error('invalid-request', `opção desconhecida: ${arg}`);
  }
  return out;
}
function main(argv = process.argv.slice(2), output = process.stdout.write.bind(process.stdout), errorOutput = process.stderr.write.bind(process.stderr)) {
  try {
    const args = parseArgs(argv);
    if (args.help) { output('Usage: forge-vertical-adapter.js --host claude|codex --operation init|status|next|handoff --json JSON\n'); return 0; }
    const result = invoke(args.host, args.operation, JSON.parse(args.json || '{}'));
    output(`${serialize(result)}\n`); return 0;
  } catch (cause) { errorOutput(`forge-vertical-adapter: ${cause.code || 'failed'}: ${cause.message}\n`); return 1; }
}
if (require.main === module) process.exitCode = main();
module.exports = { HOSTS, host, present, invoke, collect, handoff, serialize, parseArgs, main };
