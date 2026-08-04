#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('-o');
  const output = outputIndex >= 0 ? args[outputIndex + 1] : null;
  let request = {}; try { request = JSON.parse(input); } catch {}
  if (request.mode === 'timeout') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    if (request.pid_file) fs.writeFileSync(request.pid_file, String(child.pid));
    setInterval(() => {}, 1000); return;
  }
  if (output) fs.writeFileSync(output, JSON.stringify({ args, input }));
});
