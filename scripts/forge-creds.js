#!/usr/bin/env node
// forge-creds — credential vault for external CLIs (railway, vercel, fly, ...).
//
// WHY THIS EXISTS
// ---------------
// Forge already stores Claude account tokens in the Keychain (forge-accounts),
// but every other credential had no home. MCPs with secrets fall back to a
// `.env` file, which is plaintext on disk, easy to commit by accident, and
// readable by anything the user runs. A token pasted into a shell command also
// lands in shell history.
//
// This generalises the forge-accounts pattern:
//   - the non-secret registry (service, name, env var, notes) is a JSON file
//   - the secret itself lives in the macOS Keychain, never in the registry
//   - commands run through `--exec`, which puts the secret in the CHILD's
//     environment and nowhere else
//
// DELIBERATELY NO `--print`
// -------------------------
// forge-accounts has `--token` because a shell needs `$( )` substitution for
// relaunch. Here there is no such need, and an agent that can print a secret
// will eventually print it into a transcript. `--exec` covers the real use and
// keeps the value out of stdout entirely.
//
// KNOWN LIMITATION (verified, not assumed)
// ----------------------------------------
// `security add-generic-password` requires the secret in argv: passing it on
// stdin with a bare `-w` stores an EMPTY value (tested). So during the write
// the secret is briefly visible to `ps` on this machine. It never touches the
// shell history or a file, and the window is one exec. On a shared machine,
// prefer `--exec` with a credential added from a trusted session.
//
// Library exports:
//   registryPath(), load(), save(list)
//   add({service,name,secret,envVar,note}) / remove(service,name)
//   get(service, name)            → secret | null   (for --exec only)
//   list()                        → entries without secrets
//   envVarFor(service)            → conventional variable name
//
// CLI:
//   node forge-creds.js --add <service> <name> [--env VAR] [--note "..."]   (secret on stdin)
//   node forge-creds.js --list [--json]
//   node forge-creds.js --exec <service> <name> -- <command> [args...]
//   node forge-creds.js --remove <service> <name>
//   node forge-creds.js --services

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const IS_DARWIN = process.platform === 'darwin';
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const REGISTRY_FILE = process.env.FORGE_CREDS_REGISTRY
  || path.join(CLAUDE_DIR, 'forge-credentials.json');
const FALLBACK_FILE = process.env.FORGE_CREDS_REGISTRY
  ? `${process.env.FORGE_CREDS_REGISTRY}.secrets`
  : path.join(CLAUDE_DIR, 'forge-credentials-secrets.json');
const KEYCHAIN_ACCT = os.userInfo().username;

// ── Known services ───────────────────────────────────────────────────────────
// The environment variable each CLI reads. Getting this wrong means the command
// runs unauthenticated and fails in a way that looks like a bad token, so the
// mapping is explicit rather than guessed from the service name.
const SERVICES = {
  railway:    { env: 'RAILWAY_TOKEN',        cli: 'railway',  label: 'Railway' },
  vercel:     { env: 'VERCEL_TOKEN',         cli: 'vercel',   label: 'Vercel' },
  fly:        { env: 'FLY_API_TOKEN',        cli: 'flyctl',   label: 'Fly.io' },
  github:     { env: 'GITHUB_TOKEN',         cli: 'gh',       label: 'GitHub' },
  supabase:   { env: 'SUPABASE_ACCESS_TOKEN',cli: 'supabase', label: 'Supabase' },
  cloudflare: { env: 'CLOUDFLARE_API_TOKEN', cli: 'wrangler', label: 'Cloudflare' },
  netlify:    { env: 'NETLIFY_AUTH_TOKEN',   cli: 'netlify',  label: 'Netlify' },
  openai:     { env: 'OPENAI_API_KEY',       cli: null,       label: 'OpenAI' },
  figma:      { env: 'FIGMA_API_KEY',        cli: null,       label: 'Figma' },
  brave:      { env: 'BRAVE_API_KEY',        cli: null,       label: 'Brave Search' },
};

function envVarFor(service) {
  const known = SERVICES[String(service).toLowerCase()];
  if (known) return known.env;
  // Unknown service: SERVICE_TOKEN is the common convention, and the caller can
  // always override with --env.
  return `${String(service).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`;
}

// ── Registry (non-secret) ────────────────────────────────────────────────────
function load() {
  try {
    const j = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    return Array.isArray(j.credentials) ? j.credentials : [];
  } catch { return []; }
}

function save(credentials) {
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  const tmp = `${REGISTRY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, credentials }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, REGISTRY_FILE);
}

function keychainService(service, name) {
  return `forge-cred-${service}-${name}`;
}

// ── Secret storage ───────────────────────────────────────────────────────────
function storeSecret(service, name, secret) {
  if (IS_DARWIN) {
    try {
      // See the header note: the secret must go in argv because `security`
      // stores an empty value when given one on stdin.
      execFileSync('security', [
        'add-generic-password', '-U',
        '-a', KEYCHAIN_ACCT,
        '-s', keychainService(service, name),
        '-w', secret,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      return 'keychain';
    } catch {
      // The Keychain can be unreachable: it is resolved through HOME, so a
      // sandboxed or altered environment has none, and a locked keychain also
      // refuses writes. Falling through to the 0600 file keeps the credential
      // usable instead of silently vanishing — `store` records which was used
      // so `--list` can say so.
    }
  }
  // No Keychain: a 0600 file, created before anything is written to it.
  let store = {};
  try { store = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8')); } catch {}
  store[keychainService(service, name)] = secret;
  fs.mkdirSync(path.dirname(FALLBACK_FILE), { recursive: true });
  const fd = fs.openSync(FALLBACK_FILE, 'w', 0o600);
  fs.writeSync(fd, JSON.stringify(store, null, 2));
  fs.closeSync(fd);
  fs.chmodSync(FALLBACK_FILE, 0o600);
  return 'file';
}

function get(service, name) {
  if (IS_DARWIN) {
    try {
      const v = execFileSync('security', [
        'find-generic-password',
        '-a', KEYCHAIN_ACCT,
        '-s', keychainService(service, name),
        '-w',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
      if (v) return v;
    } catch { /* fall through to the file store */ }
  }
  // Checked on every platform, not just non-darwin: a credential written while
  // the Keychain was unavailable lives here and must still be readable.
  try {
    const store = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8'));
    return store[keychainService(service, name)] || null;
  } catch { return null; }
}

function deleteSecret(service, name) {
  if (IS_DARWIN) {
    try {
      execFileSync('security', [
        'delete-generic-password',
        '-a', KEYCHAIN_ACCT,
        '-s', keychainService(service, name),
      ], { stdio: 'ignore' });
    } catch {}
    // No early return: a copy may also exist in the file store from a moment
    // when the Keychain was unavailable, and leaving it behind would mean
    // "removed" was a lie.
  }
  try {
    const store = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8'));
    delete store[keychainService(service, name)];
    const fd = fs.openSync(FALLBACK_FILE, 'w', 0o600);
    fs.writeSync(fd, JSON.stringify(store, null, 2));
    fs.closeSync(fd);
  } catch {}
}

// ── Operations ───────────────────────────────────────────────────────────────
function add({ service, name, secret, envVar, note }) {
  service = String(service || '').toLowerCase().trim();
  name = String(name || '').trim();
  if (!service || !name) throw new Error('service e name são obrigatórios');
  if (!secret) throw new Error('segredo vazio');

  const store = storeSecret(service, name, secret);
  const credentials = load().filter(c => !(c.service === service && c.name === name));
  credentials.push({
    service,
    name,
    env_var: envVar || envVarFor(service),
    note: note || '',
    store,
    added_at: new Date().toISOString(),
  });
  save(credentials);
  return { service, name, store };
}

function remove(service, name) {
  service = String(service || '').toLowerCase();
  const before = load();
  const after = before.filter(c => !(c.service === service && c.name === name));
  if (after.length === before.length) return false;
  deleteSecret(service, name);
  save(after);
  return true;
}

/// Entries with a `has_secret` flag and never the secret itself.
function list() {
  return load().map(c => ({ ...c, has_secret: !!get(c.service, c.name) }));
}

function find(service, name) {
  service = String(service || '').toLowerCase();
  return load().find(c => c.service === service && c.name === name) || null;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function readStdin() {
  try { return fs.readFileSync(0, 'utf8').replace(/\r?\n$/, ''); }
  catch { return ''; }
}

function usage() {
  return [
    'forge-creds — cofre de credenciais para CLIs externos',
    '',
    'Uso:',
    '  --add <serviço> <nome> [--env VAR] [--note "..."]   segredo vem do stdin',
    '  --list [--json]',
    '  --exec <serviço> <nome> -- <comando> [args...]',
    '  --remove <serviço> <nome>',
    '  --services                                          serviços conhecidos',
    '',
    'Exemplos:',
    '  printf %s "$TOKEN" | forge-creds add railway producao',
    '  forge-creds exec railway producao -- railway status',
    '',
    'O segredo nunca é impresso: use --exec para rodar comandos com ele.',
  ].join('\n');
}

function main(argv) {
  const flag = (n) => argv.indexOf(n);
  const json = argv.includes('--json');

  if (argv.length === 0 || argv.includes('--help')) { console.log(usage()); return 0; }

  if (argv.includes('--services')) {
    const rows = Object.entries(SERVICES).map(([k, v]) => ({ service: k, ...v }));
    if (json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) {
      console.log(`  ${r.service.padEnd(12)} ${r.env.padEnd(24)} ${r.cli || ''}`);
    }
    return 0;
  }

  const iAdd = flag('--add');
  if (iAdd >= 0) {
    const service = argv[iAdd + 1];
    const name = argv[iAdd + 2];
    if (!service || !name) { console.error('forge-creds: --add requer <serviço> <nome>'); return 2; }
    const iEnv = flag('--env');
    const iNote = flag('--note');
    const secret = readStdin();
    if (!secret) {
      console.error('forge-creds: nenhum segredo no stdin.');
      console.error('  ex: printf %s "$TOKEN" | forge-creds add railway producao');
      return 2;
    }
    try {
      const r = add({
        service, name, secret,
        envVar: iEnv >= 0 ? argv[iEnv + 1] : null,
        note: iNote >= 0 ? argv[iNote + 1] : '',
      });
      const entry = find(r.service, r.name);
      console.log(`✓ ${r.service}/${r.name} guardado (${r.store}) → ${entry.env_var}`);
      return 0;
    } catch (e) { console.error(`forge-creds: ${e.message}`); return 1; }
  }

  if (argv.includes('--list')) {
    const rows = list();
    if (json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
    if (!rows.length) { console.log('Nenhuma credencial guardada.'); return 0; }
    for (const c of rows) {
      const mark = c.has_secret ? '●' : '○';
      console.log(`  ${mark} ${c.service}/${c.name}`.padEnd(34)
        + `${c.env_var.padEnd(24)} ${c.note || ''}`);
    }
    if (rows.some(c => !c.has_secret)) {
      console.log('\n  ○ = registrada sem segredo no Keychain — readicione.');
    }
    return 0;
  }

  const iRemove = flag('--remove');
  if (iRemove >= 0) {
    const ok = remove(argv[iRemove + 1], argv[iRemove + 2]);
    console.log(ok ? '✓ removida' : 'não encontrada');
    return ok ? 0 : 1;
  }

  const iExec = flag('--exec');
  if (iExec >= 0) {
    const service = argv[iExec + 1];
    const name = argv[iExec + 2];
    const sep = argv.indexOf('--', iExec + 3);
    if (!service || !name || sep < 0 || !argv[sep + 1]) {
      console.error('forge-creds: --exec <serviço> <nome> -- <comando> [args...]');
      return 2;
    }
    const entry = find(service, name);
    if (!entry) { console.error(`forge-creds: ${service}/${name} não está registrada`); return 1; }
    const secret = get(service, name);
    if (!secret) {
      console.error(`forge-creds: segredo de ${service}/${name} não encontrado — readicione`);
      return 1;
    }
    const cmd = argv[sep + 1];
    const args = argv.slice(sep + 2);
    // The secret enters the child's environment and nothing else: not argv, not
    // stdout, not the parent shell.
    const r = spawnSync(cmd, args, {
      stdio: 'inherit',
      env: { ...process.env, [entry.env_var]: secret },
    });
    if (r.error) { console.error(`forge-creds: ${r.error.message}`); return 127; }
    return r.status === null ? 1 : r.status;
  }

  console.log(usage());
  return 0;
}

module.exports = {
  REGISTRY_FILE, SERVICES,
  load, save, add, remove, get, list, find, envVarFor, keychainService,
};

if (require.main === module) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (e) { console.error(`forge-creds: ${e.message}`); process.exit(1); }
}
