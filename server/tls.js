// --tls support: load certs/server.{key,crt} or generate a self-signed cert with openssl (SAN = LAN IPs + localhost).
// Returns { key, cert } Buffers or null (caller falls back to HTTP with a warning).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function lanAddresses() {
  const out = [];
  try {
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.internal) continue;
        if (a.family !== 'IPv4' && a.family !== 4) continue;
        out.push({ name, address: a.address });
      }
    }
  } catch { /* no interfaces */ }
  // prefer private ranges, then everything else, stable order
  const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => score(a.address) - score(b.address)).map((a) => a.address);
}

/** The exact openssl command we run (printed so the user can re-run it by hand). */
export function opensslCommand({ certsDir, hosts }) {
  const key = path.join(certsDir, 'server.key');
  const crt = path.join(certsDir, 'server.crt');
  const san = hosts.map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') ? `IP:${h}` : `DNS:${h}`)).join(',');
  const args = ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '825',
    '-keyout', key, '-out', crt, '-subj', '/CN=cEverything', '-addext', `subjectAltName=${san}`];
  return { bin: 'openssl', args, key, crt, display: ['openssl', ...args.map((a) => (/[\s,=/]/.test(a) && !a.startsWith('/') ? `"${a}"` : a))].join(' ') };
}

/**
 * ensureCerts({ certsDir, hosts?, log? }) → { key, cert, generated } | null
 */
export function ensureCerts(opts = {}) {
  const certsDir = path.resolve(opts.certsDir || path.join(process.cwd(), 'certs'));
  const log = opts.log || console.log;
  const keyFile = path.join(certsDir, 'server.key');
  const crtFile = path.join(certsDir, 'server.crt');
  if (fs.existsSync(keyFile) && fs.existsSync(crtFile)) {
    try {
      return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(crtFile), generated: false, keyFile, crtFile };
    } catch (err) {
      log(`[tls] could not read ${keyFile}/${crtFile}: ${err.message}`);
      return null;
    }
  }
  const hosts = Array.from(new Set(['localhost', '127.0.0.1', ...(opts.hosts || lanAddresses())]));
  const cmd = opensslCommand({ certsDir, hosts });
  log(`[tls] generating self-signed certificate (SAN: ${hosts.join(', ')})`);
  log(`[tls] $ ${cmd.display}`);
  try { fs.mkdirSync(certsDir, { recursive: true }); } catch (err) { log(`[tls] cannot create ${certsDir}: ${err.message}`); return null; }
  const probe = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    log('[tls] WARNING: openssl not found on PATH — run scripts/make-cert.sh on a machine with openssl, or copy certs/server.{key,crt} here. Falling back to HTTP.');
    return null;
  }
  const res = spawnSync(cmd.bin, cmd.args, { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    // older openssl without -addext: retry via a temporary config file
    const cfg = path.join(certsDir, 'openssl.cnf');
    const san = hosts.map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? `IP:${h}` : `DNS:${h}`)).join(',');
    fs.writeFileSync(cfg, `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=cEverything\n[v3]\nsubjectAltName=${san}\n`);
    const res2 = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '825', '-keyout', keyFile, '-out', crtFile, '-config', cfg], { encoding: 'utf8' });
    if (res2.error || res2.status !== 0) {
      log(`[tls] WARNING: openssl failed (${(res.stderr || res2.stderr || res.error?.message || '').trim().split('\n').pop()}). Falling back to HTTP.`);
      return null;
    }
  }
  try {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(crtFile), generated: true, keyFile, crtFile };
  } catch (err) {
    log(`[tls] WARNING: certificate files missing after generation: ${err.message}. Falling back to HTTP.`);
    return null;
  }
}

export default { ensureCerts, lanAddresses, opensslCommand };
