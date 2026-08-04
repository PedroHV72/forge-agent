#!/usr/bin/env node
'use strict';

// One paid-provider-free executable for capability and argv smoke checks.
// It intentionally runs only as: process.execPath [this-file, ...argv].
const args = process.argv.slice(2);
if (args.includes('--version')) process.stdout.write('3.2.0\n');
else if (args.includes('--help')) process.stdout.write('offline fake runtime\n');
else {
  const host = args.includes('--host') ? args[args.indexOf('--host') + 1] : 'codex';
  if (host === 'claude') {
    process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'offline-session' })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'offline-ok' }] } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'result', is_error: false })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'offline-thread' })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'offline-ok' } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);
  }
}
