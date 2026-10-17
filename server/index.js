#!/usr/bin/env node
// cEverything server CLI (PROTOCOL.md §1):
//   node server/index.js [--port 8787] [--host 0.0.0.0] [--tls] [--source fixture|hermes]
//                        [--fixture fixtures/demo] [--speed 4] [--no-loop] [--public-url https://…]
// Prints LAN + public URLs and a QR code at startup. Also exports startServer() for tests.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { createStaticHandler, ROOT_DIR } from './http.js';
import { createHub } from './hub.js';
import { createState } from './state.js';
import { createFixtureSource } from './sources/fixture.js';
import { createHermesSource } from './sources/hermes.js';
import { createSTT } from './stt/index.js';
import { ensureCerts, lanAddresses } from './tls.js';

const HELP = `cEverything server

  node server/index.js [options]

  --port <n>            TCP port (default 8787)
  --host <addr>         bind address (default 0.0.0.0)
  --tls                 HTTPS with certs/server.{key,crt} (generated with openssl if missing)
  --source <kind>       fixture | hermes (default fixture; HERMES_DASHBOARD set → still fixture unless asked)
  --fixture <dir>       scenario directory (default fixtures/demo)
  --speed <x>           fixture replay speed (default 4)
  --no-loop             stop at the end of the fixture instead of looping
  --paused              start the fixture paused
  --public-url <url>    tunnel URL to print + encode in the QR code
  --no-qr               skip the QR code
  --quiet               less logging
  -h, --help            this text

Env: ASSEMBLYAI_API_KEY, HERMES_DASHBOARD, HERMES_API, HERMES_API_KEY, HERMES_PROFILE (a .env file in the repo root is read).
`;

export function parseArgs(argv) {
  const o = { port: 8787, host: '0.0.0.0', tls: false, source: 'fixture', fixture: 'fixtures/demo', speed: 4, loop: true, paused: false, publicUrl: '', qr: true, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[i + 1]; if (v === undefined) throw new Error(`${a} needs a value`); i++; return v; };
    const eq = a.includes('=') ? a.slice(a.indexOf('=') + 1) : null;
    const key = eq !== null ? a.slice(0, a.indexOf('=')) : a;
    const val = () => (eq !== null ? eq : next());
    switch (key) {
      case '--port': o.port = Number(val()); break;
      case '--host': o.host = val(); break;
      case '--tls': o.tls = true; break;
      case '--source': o.source = val(); break;
      case '--fixture': o.fixture = val(); break;
      case '--speed': o.speed = Number(val()); break;
      case '--no-loop': o.loop = false; break;
      case '--loop': o.loop = true; break;
      case '--paused': o.paused = true; break;
      case '--public-url': o.publicUrl = val(); break;
      case '--no-qr': o.qr = false; break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown option ${a} (try --help)`);
    }
  }
  if (!Number.isFinite(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port must be 0..65535');
  if (!Number.isFinite(o.speed) || o.speed <= 0) throw new Error('--speed must be > 0');
  if (o.source !== 'fixture' && o.source !== 'hermes') throw new Error('--source must be fixture or hermes');
  return o;
}

/** Minimal .env loader (KEY=VALUE, # comments); never overrides existing env. */
export function loadDotEnv(file = path.join(ROOT_DIR, '.env'), env = process.env) {
  try {
    if (!fs.existsSync(file)) return 0;
    let n = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (env[m[1]] === undefined) { env[m[1]] = v; n++; }
    }
    return n;
  } catch { return 0; }
}

/**
 * startServer(options) → { server, hub, state, source, stt, port, urls, close() }
 * options: parseArgs() output (+ log). Used by the CLI and by tests (port 0 = random).
 */
export async function startServer(options = {}) {
  const o = { ...parseArgs([]), ...options };
  const log = o.log || (o.quiet ? () => {} : (...a) => console.log(...a));
  const state = createState();
  const stt = createSTT({ env: process.env, log });

  let source;
  if (o.source === 'hermes') {
    source = createHermesSource({ log });
  } else {
    source = createFixtureSource({ dir: path.resolve(ROOT_DIR, o.fixture), speed: o.speed, loop: o.loop, paused: o.paused, log });
    await source.load();
  }

  const handler = createStaticHandler({ rootDir: ROOT_DIR, log, info: () => ({ source: source.kind, sourceInfo: source.info(), clients: hub ? hub.clientCount() : 0, latestSeq: hub ? hub.latestSeq : 0, voice: stt.available ? stt.name : 'none' }) });

  let tlsOpts = null;
  if (o.tls) {
    tlsOpts = ensureCerts({ certsDir: path.join(ROOT_DIR, 'certs'), log });
    if (!tlsOpts) log('[tls] WARNING: continuing over plain HTTP — WebXR on a headset needs HTTPS (or a tunnel)');
  }
  const server = tlsOpts ? https.createServer({ key: tlsOpts.key, cert: tlsOpts.cert }, handler) : http.createServer(handler);
  server.on('error', (err) => log(`[http] server error: ${err.message}`));

  const hub = createHub({ server, state, source, stt, log });
  // let sources reach canonical state through the hub too
  Object.defineProperty(hub, 'state', { value: state, enumerable: false });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => { server.off('error', reject); resolve(); });
  });
  const port = server.address().port;
  const scheme = tlsOpts ? 'https' : 'http';
  const urls = [];
  const hosts = o.host === '0.0.0.0' || o.host === '::' || o.host === '' ? ['localhost', ...lanAddresses()] : [o.host];
  for (const h of hosts) urls.push(`${scheme}://${h}:${port}/`);
  if (o.publicUrl) urls.unshift(o.publicUrl.replace(/\/?$/, '/'));

  source.start(hub, state);

  const api = {
    server, hub, state, source, stt, port, urls, scheme, tls: Boolean(tlsOpts),
    async close() {
      try { source.stop(); } catch { /* ignore */ }
      try { stt.close?.(); } catch { /* ignore */ }
      await hub.close();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return api;
}

export function printBanner(api, o, log = console.log) {
  log('');
  log(`cEverything — ${o.source === 'hermes' ? 'LIVE Hermes adapter' : `fixture replay (${path.relative(ROOT_DIR, path.resolve(ROOT_DIR, o.fixture))} @ ${o.speed}×${o.loop ? ', loop' : ''})`}${api.tls ? ' · TLS' : ''}`);
  log(`voice: ${api.stt.available ? api.stt.name : 'none (laptop Web Speech / keyboard only)'}`);
  log('');
  log('Open on this laptop / LAN:');
  for (const u of api.urls) log(`  ${u}`);
  if (!api.tls && !o.publicUrl) log('  (headsets need HTTPS: run with --tls, or a tunnel: cloudflared tunnel --url http://localhost:' + api.port + ' and pass --public-url)');
  log('');
  if (o.qr !== false) {
    const target = o.publicUrl ? api.urls[0] : (api.urls.find((u) => !u.includes('localhost')) || api.urls[0]);
    log(`QR for ${target}`);
    try { qrcode.generate(target, { small: true }, (code) => log(code)); } catch (err) { log(`(QR unavailable: ${err.message})`); }
  }
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (err) { console.error(`error: ${err.message}\n`); console.error(HELP); process.exit(2); }
  if (o.help) { console.log(HELP); return; }
  loadDotEnv();
  let api;
  try { api = await startServer(o); } catch (err) { console.error(`error: ${err.message}`); process.exit(1); }
  printBanner(api, o);
  const shutdown = async (sig) => { console.log(`\n${sig}: shutting down`); try { await api.close(); } finally { process.exit(0); } };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function isMain() {
  if (!process.argv[1]) return false;
  const here = fileURLToPath(import.meta.url);
  try { return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(here); } catch { return path.resolve(process.argv[1]) === here; }
}

if (isMain()) main();

export default { startServer, parseArgs, loadDotEnv, printBanner };
