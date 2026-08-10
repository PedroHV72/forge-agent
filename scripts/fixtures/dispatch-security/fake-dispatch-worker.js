#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const scenario = process.argv[2] || 'success';
const payload = { protocol_version: '1.0.0', scenario, argv: process.argv.slice(2) };

if (scenario === 'malformed') process.stdout.write('{not-json');
else if (scenario === 'timeout' || scenario === 'orphan') setInterval(() => {}, 1000);
else if (scenario === 'protected-state') {
  fs.mkdirSync(path.join(process.cwd(), '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), '.gsd', 'forbidden.json'), '{}');
  process.stdout.write(JSON.stringify({ ...payload, status: 'failed', reason_code: 'protected-state-path' }));
} else if (scenario === 'overlap') {
  fs.writeFileSync(path.join(process.cwd(), process.argv[3]), 'worker-overlap\n');
  process.stdout.write(JSON.stringify({ ...payload, status: 'failed', reason_code: 'surgical-reset-overlap' }));
} else if (scenario === 'transient') {
  process.stdout.write(JSON.stringify({ ...payload, status: 'failed', reason_code: 'provider-transient', error_class: 'transient' }));
} else if (scenario === 'capability-denied') {
  process.stdout.write(JSON.stringify({ ...payload, status: 'failed', reason_code: 'capability-missing', error_class: 'terminal' }));
} else if (scenario === 'terminal') {
  process.stdout.write(JSON.stringify({ ...payload, status: 'failed', reason_code: 'worker-refused', error_class: 'terminal' }));
} else process.stdout.write(JSON.stringify({ ...payload, status: 'succeeded', reason_code: 'policy-allowed' }));
