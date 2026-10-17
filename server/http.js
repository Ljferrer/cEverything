// Static file server (PROTOCOL.md §1 http.js): web/ at /, node_modules/three (build/ + examples/jsm/ only) at
// /vendor/three/, server/protocol.js at /shared/protocol.js. No caching, path-traversal safe.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(HERE, '..');

export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json',
});

export function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** Resolve `rel` under `root`; returns null when it escapes root. */
export function safeJoin(root, rel) {
  const cleaned = rel.replace(/\0/g, '');
  const resolved = path.resolve(root, '.' + path.posix.normalize('/' + cleaned));
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

function placeholderHTML(info) {
  const label = info?.label ? String(info.label) : 'server';
  return `<!doctype html><html><head><meta charset="utf-8"><title>cEverything</title>
<style>body{font:16px system-ui;background:#0b0f14;color:#e5e7eb;margin:0;display:grid;place-items:center;height:100vh}
main{max-width:36em;padding:2em}code{background:#1f2937;padding:.1em .3em;border-radius:3px}</style></head>
<body><main><h1>cEverything</h1><p>The server is up (<code>${escapeHTML(label)}</code>) but <code>web/index.html</code> is not built yet.</p>
<p>WebSocket hub: <code>/ws</code> · protocol: <a href="/shared/protocol.js">/shared/protocol.js</a> · health: <a href="/health">/health</a></p></main></body></html>`;
}

function escapeHTML(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
  res.end(buf);
}

/**
 * createStaticHandler({ rootDir, webDir, protocolFile, threeDir, log, info }) → (req, res) => void
 * `info()` optionally returns runtime info for /health and the placeholder page.
 */
export function createStaticHandler(opts = {}) {
  const rootDir = opts.rootDir || ROOT_DIR;
  const webDir = opts.webDir || path.join(rootDir, 'web');
  const threeDir = opts.threeDir || path.join(rootDir, 'node_modules', 'three');
  const protocolFile = opts.protocolFile || path.join(HERE, 'protocol.js');
  const log = opts.log || (() => {});
  const info = typeof opts.info === 'function' ? opts.info : () => ({});

  const mounts = [
    { prefix: '/vendor/three/build/', dir: path.join(threeDir, 'build') },
    { prefix: '/vendor/three/examples/jsm/', dir: path.join(threeDir, 'examples', 'jsm') },
  ];

  async function serveFile(req, res, file) {
    let st;
    try { st = await fsp.stat(file); } catch { return false; }
    if (st.isDirectory()) {
      const idx = path.join(file, 'index.html');
      try { st = await fsp.stat(idx); file = idx; } catch { return false; }
    }
    if (!st.isFile()) return false;
    const headers = { 'Content-Type': mimeOf(file), 'Content-Length': st.size, 'Cache-Control': 'no-store', 'Last-Modified': st.mtime.toUTCString() };
    if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return true; }
    res.writeHead(200, headers);
    const stream = fs.createReadStream(file);
    stream.on('error', (err) => { log('static read error', file, err.message); if (!res.headersSent) send(res, 500, 'read error'); else res.destroy(); });
    stream.pipe(res);
    return true;
  }

  return async function handler(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
      const url = new URL(req.url || '/', 'http://localhost');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'bad request'); }
      if (pathname.includes('\0')) return send(res, 400, 'bad request');

      if (pathname === '/health') {
        return send(res, 200, JSON.stringify({ ok: true, ...safeInfo(info) }), 'application/json; charset=utf-8');
      }
      if (pathname === '/shared/protocol.js') {
        return (await serveFile(req, res, protocolFile)) || send(res, 404, 'protocol.js missing');
      }
      for (const m of mounts) {
        if (pathname.startsWith(m.prefix)) {
          const file = safeJoin(m.dir, pathname.slice(m.prefix.length));
          if (!file) return send(res, 403, 'forbidden');
          return (await serveFile(req, res, file)) || send(res, 404, 'not found');
        }
      }
      if (pathname.startsWith('/vendor/')) return send(res, 404, 'only /vendor/three/build/ and /vendor/three/examples/jsm/ are served');

      const file = safeJoin(webDir, pathname === '/' ? '/index.html' : pathname);
      if (!file) return send(res, 403, 'forbidden');
      if (await serveFile(req, res, file)) return undefined;
      if (pathname === '/' || pathname === '/index.html') return send(res, 404, placeholderHTML(safeInfo(info)), 'text/html; charset=utf-8');
      return send(res, 404, 'not found');
    } catch (err) {
      log('http error', err && err.stack ? err.stack : err);
      if (!res.headersSent) send(res, 500, 'internal error');
      else res.destroy();
      return undefined;
    }
  };
}

function safeInfo(info) { try { return info() || {}; } catch { return {}; } }

export default { createStaticHandler, mimeOf, safeJoin, MIME, ROOT_DIR };
