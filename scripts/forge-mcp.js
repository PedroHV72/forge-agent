#!/usr/bin/env node
'use strict';

const path = require('path');

const PROTOCOL_VERSION = '1.0.0';
const TRANSPORTS = ['stdio', 'http'];

class McpConfigError extends Error {
  constructor(reason, message) { super(message); this.name = 'McpConfigError'; this.reason_code = reason; }
}

function parse(input) {
  if (typeof input !== 'string') return input;
  try { return JSON.parse(input); } catch (_) { throw new McpConfigError('invalid-json', 'MCP config is not valid JSON'); }
}

function authDescriptor(auth = {}) {
  const required = auth.required === true;
  if (!required) return { required: false, status: 'not-required', reason_code: 'available' };
  if (auth.available !== true) return { required: true, status: 'conditional-unavailable', reason_code: 'auth-conditional-unavailable', kind: auth.kind || 'bearer' };
  const descriptor = { required: true, status: 'available', reason_code: 'available', kind: auth.kind || 'bearer', source: 'runtime-injection' };
  if (typeof auth.env_name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(auth.env_name)) descriptor.env_name = auth.env_name;
  if (typeof auth.header_name === 'string' && /^[A-Za-z0-9-]+$/.test(auth.header_name)) descriptor.header_name = auth.header_name;
  return descriptor;
}

function normalize(input) {
  const raw = parse(input);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new McpConfigError('invalid-config', 'MCP config must be an object');
  const transport = raw.transport || (raw.url ? 'http' : 'stdio');
  if (!TRANSPORTS.includes(transport)) throw new McpConfigError('invalid-transport', 'transport must be stdio or http');
  const id = String(raw.id || '').trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new McpConfigError('invalid-config', 'id must be a safe non-empty identifier');
  const auth = authDescriptor(raw.auth);
  const base = { protocol_version: PROTOCOL_VERSION, id, transport, status: auth.status === 'conditional-unavailable' ? 'conditional-unavailable' : 'available', reason_code: auth.reason_code, auth };
  if (transport === 'stdio') {
    if (typeof raw.command !== 'string' || !path.isAbsolute(raw.command)) throw new McpConfigError('invalid-command', 'stdio command must be an absolute executable');
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== 'string'))) throw new McpConfigError('invalid-command', 'stdio args must be a string array');
    return { ...base, process: { executable: raw.command, args: (raw.args || []).slice(), shell: false } };
  }
  let url;
  try { url = new URL(raw.url); } catch (_) { throw new McpConfigError('invalid-url', 'HTTP MCP requires a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new McpConfigError('invalid-url', 'HTTP MCP URL must use http or https');
  const headers = {};
  for (const [name, value] of Object.entries(raw.headers || {})) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || /^(authorization|proxy-authorization)$/i.test(name)) throw new McpConfigError('credential-in-config', 'credential headers must be runtime-injected');
    if (typeof value !== 'string') throw new McpConfigError('invalid-config', 'header values must be strings');
    headers[name] = value;
  }
  return { ...base, http: { url: url.toString(), headers } };
}

function project(config, host) {
  if (!['claude', 'codex'].includes(host)) throw new McpConfigError('invalid-runtime', 'host must be claude or codex');
  const canonical = normalize(config);
  if (canonical.status !== 'available') return { host, status: canonical.status, reason_code: canonical.reason_code, config: null };
  const value = canonical.transport === 'stdio'
    ? { command: canonical.process.executable, args: canonical.process.args.slice() }
    : { type: 'http', url: canonical.http.url, headers: { ...canonical.http.headers } };
  return { host, status: 'available', reason_code: 'available', config: value, auth: canonical.auth };
}

module.exports = { PROTOCOL_VERSION, TRANSPORTS, McpConfigError, parse, authDescriptor, normalize, project };
