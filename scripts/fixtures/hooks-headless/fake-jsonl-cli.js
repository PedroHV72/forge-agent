#!/usr/bin/env node
'use strict';

const args = process.argv.slice(2);
const runtime = args.includes('exec') ? 'codex' : 'claude';
const scenario = args.find((arg) => /^(success|resume|partial|malformed|truncated|timeout|orphan|needs-input|secret)$/.test(arg)) || 'success';
const line = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (scenario === 'timeout') { setInterval(() => {}, 1000); }
else if (runtime === 'codex') {
  if (scenario === 'malformed') process.stdout.write('{bad json}\n');
  else if (scenario === 'truncated') process.stdout.write('{"type":"thread.started"');
  else {
    line({ type: 'thread.started', thread_id: scenario === 'resume' ? 'thread-resume' : 'thread-new', event_id: 'start-1' });
    if (scenario === 'orphan') process.exit(0);
    if (scenario === 'partial') {
      line({ type: 'usage', delta: true, usage: { input_tokens: 2, output_tokens: 1 } });
      line({ type: 'usage', delta: true, usage: { input_tokens: 3, output_tokens: 4 } });
    }
    if (scenario === 'secret') line({ type: 'item.completed', item: { type: 'agent_message', text: 'TOKEN_SENTINEL' } });
    else line({ type: 'item.completed', item: { type: 'agent_message', text: 'codex ok' } });
    line(scenario === 'needs-input' ? { type: 'needs_input' } : { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 5 } });
  }
} else {
  if (scenario === 'malformed') process.stdout.write('not-json\n');
  else if (scenario === 'truncated') process.stdout.write('{"type":"system"');
  else {
    line({ type: 'system', subtype: 'init', session_id: scenario === 'resume' ? 'session-resume' : 'session-new' });
    if (scenario === 'orphan') process.exit(0);
    line({ type: 'assistant', message: { content: [{ type: 'text', text: scenario === 'secret' ? 'TOKEN_SENTINEL' : 'claude ok' }], usage: { input_tokens: 4, output_tokens: 2 } } });
    line(scenario === 'needs-input' ? { type: 'needs_input' } : { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 4, output_tokens: 2 } });
  }
}
