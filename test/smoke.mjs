#!/usr/bin/env node
// Smoke test (PROTOCOL.md §1 test/smoke.mjs): start the server in fixture mode on a random port, open / in headless
// Chromium (Playwright, SwiftShader WebGL), click "Open on laptop", wait for ≥ 6 sessions and ≥ 30 tiles, assert zero
// console errors / page errors, press T and save test-results/topdown.png + the default view test-results/desktop.png.
// Exit non-zero on any failure. If WebGL cannot start, the store/network path is still asserted and the gap reported.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-results');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 60000;
const HEADLESS = process.env.SMOKE_HEADED !== '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);
const failures = [];
const fail = (msg) => { failures.push(msg); console.error('[smoke] FAIL', msg); };

async function waitFor(page, fn, label, timeout = TIMEOUT_MS, arg = undefined) {
  const start = Date.now();
  for (;;) {
    let v;
    try { v = await page.evaluate(fn, arg); } catch (err) { v = null; if (!/Execution context was destroyed/.test(err.message)) throw err; }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
}

/** Resolve import-map specifiers inside the page: a module script shares the document's import map (page.evaluate cannot use import.meta). */
async function resolveImports(page, specifiers) {
  await page.addScriptTag({ type: 'module', content: `window.__importMap = { ${specifiers.map((s) => `${JSON.stringify(s)}: import.meta.resolve(${JSON.stringify(s)})`).join(', ')} };` });
  return waitFor(page, () => window.__importMap || null, 'import map resolution', 5000);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const api = await startServer({ port: 0, host: '127.0.0.1', fixture: 'fixtures/demo', speed: 8, loop: true, quiet: true, log: () => {} });
  const url = `http://127.0.0.1:${api.port}/?name=smoke`;
  log(`server on ${url} (source ${api.source.kind}, ${Object.keys(api.state.sessions).length} sessions loaded)`);

  const browser = await chromium.launch({ headless: HEADLESS, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = []; const pageErrors = []; const consoleAll = []; const responses = new Map();
  page.on('console', (m) => { consoleAll.push(`${m.type()}: ${m.text()}`); if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
  page.on('requestfailed', (req) => consoleErrors.push(`request failed: ${req.url()} ${req.failure()?.errorText || ''}`));
  page.on('response', (res) => { responses.set(new URL(res.url()).pathname, res.status()); if (res.status() >= 400) consoleErrors.push(`HTTP ${res.status()} ${res.url()}`); });
  // the room must never reach outside the laptop: no CDN fonts, no GLTF profiles, no analytics. Abort + fail on any other host.
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== '127.0.0.1') { consoleErrors.push(`external request blocked: ${u.href}`); return route.abort(); }
    return route.continue();
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await waitFor(page, () => Boolean(window.__ceverything && window.__ceverything.store), 'window.__ceverything');
    const info = await waitFor(page, () => { const a = window.__ceverything.app; return a ? { noWebGL: a.noWebGL, device: a.device } : null; }, 'app handle');
    log(`app booted: device=${info.device} noWebGL=${info.noWebGL}`);

    // landing: the desktop button must be visible; ENTER XR hidden (no WebXR in headless Chromium)
    const btn = page.getByRole('button', { name: 'Open on laptop' });
    await btn.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
    const xrHidden = await page.evaluate(() => document.getElementById('enter-xr').hidden);
    if (!xrHidden) fail('ENTER XR button should be hidden where WebXR is unsupported');
    await btn.click();
    await waitFor(page, () => window.__ceverything.app.started === true, 'app.started');

    // network + store path
    await waitFor(page, () => window.__ceverything.net.status === 'open' && window.__ceverything.store.clientId, 'websocket hello');
    const sessions = await waitFor(page, () => { const n = window.__ceverything.store.sessions.size; return n >= 6 ? n : null; }, 'store.sessions.size >= 6');
    log(`sessions: ${sessions}`);
    const tiles = await waitFor(page, () => { const s = window.__ceverything.stats(); return s.tiles >= 30 ? s.tiles : null; }, 'tiles >= 30');
    log(`tiles: ${tiles}`);
    const label = await page.evaluate(() => window.__ceverything.store.sourceInfo.label);
    if (label !== 'FIXTURE REPLAY') fail(`sourceInfo.label expected FIXTURE REPLAY, got ${label}`);
    const hudRows = await page.evaluate(() => document.querySelectorAll('#hud-sessions .sess').length);
    if (hudRows < 6) fail(`HUD session list shows ${hudRows} rows (< 6)`);

    if (!info.noWebGL) {
      const columns = await waitFor(page, () => { const n = window.__ceverything.columns.size; return n >= 6 ? n : null; }, 'columns >= 6');
      log(`columns: ${columns}`);
      const stats = await page.evaluate(() => window.__ceverything.stats());
      log(`stats: ${JSON.stringify(stats)}`);
      if (!(stats.calls > 0)) fail(`renderer draw calls = ${stats.calls}; expected > 0`);
      if (!(stats.bars + stats.summary + stats.full > 0)) fail('no tile is rendered as bar or plane');
      // hover a column's title plate through the real raycaster and check the hover state (pick one that projects
      // onto the canvas rather than under a HUD panel)
      const probe = await page.evaluate(() => {
        const app = window.__ceverything.app;
        for (const col of window.__ceverything.columns.values()) {
          const v = col.titlePosition().project(app.camera);
          const x = (v.x + 1) / 2 * window.innerWidth; const y = (1 - v.y) / 2 * window.innerHeight;
          if (document.elementFromPoint(x, y)?.id === 'gl') return { x, y, id: col.id };
        }
        return null;
      });
      if (!probe) fail('no column title projects onto the canvas');
      else {
        await page.mouse.move(probe.x, probe.y);
        await sleep(100);
        const hover = await page.evaluate(() => window.__ceverything.app.desktop.hoverInfo());
        if (!hover || hover.sessionId !== probe.id) fail(`hover over title of ${probe.id} not detected (got ${JSON.stringify(hover)})`);
        await page.mouse.click(probe.x, probe.y);
        await sleep(100);
        const focused = await page.evaluate(() => window.__ceverything.app.focusedId);
        if (focused !== probe.id) fail(`click should focus ${probe.id}, focused ${focused}`);
        // hover a tile of that column (newest tile at reading height) → tile hover with messageId. The fixture keeps
        // streaming, so the stack can shift between the projection and the pointer event: retry a few times.
        let tileOk = false; let lastTry = null;
        for (let attempt = 0; attempt < 4 && !tileOk; attempt++) {
          const tileProbe = await page.evaluate((id) => {
            const app = window.__ceverything.app; const col = window.__ceverything.columns.get(id); const r = col.tiles[0]; if (!r) return null;
            const v = r.world.clone().project(app.camera);
            const x = (v.x + 1) / 2 * window.innerWidth; const y = (1 - v.y) / 2 * window.innerHeight;
            return { x, y, messageId: r.msg.id, el: document.elementFromPoint(x, y)?.id };
          }, probe.id);
          if (!tileProbe) { await sleep(200); continue; }
          await page.mouse.move(tileProbe.x + 1, tileProbe.y + 1); await page.mouse.move(tileProbe.x, tileProbe.y); await sleep(120);
          const th = await page.evaluate(() => window.__ceverything.app.desktop.hoverInfo());
          lastTry = { tileProbe, th };
          if (th && th.messageId && (th.messageId === tileProbe.messageId || th.sessionId === probe.id)) { tileOk = true; log(`tile hover ok: ${th.messageId}${th.messageId !== tileProbe.messageId ? ' (stack shifted during the probe)' : ''}`); }
        }
        if (!tileOk) fail(`tile hover not detected: ${JSON.stringify(lastTry)}`);
        await page.mouse.move(640, 400);
      }
      await sleep(600);
      await page.screenshot({ path: path.join(OUT, 'desktop.png') });
      log('saved test-results/desktop.png');
      await page.keyboard.press('T');
      await sleep(700);
      const topDown = await page.evaluate(() => window.__ceverything.app.desktop.topDown);
      if (!topDown) fail('T did not switch to the top-down view');
      await page.screenshot({ path: path.join(OUT, 'topdown.png') });
      log('saved test-results/topdown.png');
      await page.keyboard.press('T');
    } else {
      fail('WebGL did not initialize headless: 3D assertions skipped (store/network path verified)');
      await page.screenshot({ path: path.join(OUT, 'desktop.png') });
    }

    // import map + vendored three: 'three' and 'three/addons/' resolve to /vendor/three/ on this origin, and the two addons
    // the client needs (OrbitControls for the laptop, XRButton for the headsets) were actually fetched with 200
    const im = await resolveImports(page, ['three', 'three/addons/webxr/XRButton.js', 'three/addons/controls/OrbitControls.js']);
    for (const [k, v] of Object.entries(im)) if (!v.startsWith(`http://127.0.0.1:${api.port}/vendor/three/`)) fail(`import map: ${k} resolved to ${v}`);
    for (const p of ['/vendor/three/build/three.module.js', '/vendor/three/examples/jsm/webxr/XRButton.js', '/vendor/three/examples/jsm/controls/OrbitControls.js', '/shared/protocol.js', '/input/xr.js']) {
      if (responses.get(p) !== 200) fail(`${p} was not loaded with 200 (got ${responses.get(p)})`);
    }
    log(`import map ok: ${Object.values(im).map((v) => new URL(v).pathname).join(' ')}`);

    // a command round-trip through the real hub: send a message to the focused session
    const sent = await page.evaluate(async () => {
      const { app, store, net } = window.__ceverything; const sid = app.focusedId || store.order[0];
      const before = store.messagesOf(sid).length;
      await net.cmd('send', { sessionId: sid, text: 'smoke test says hi', via: 'keyboard' });
      await new Promise((r) => setTimeout(r, 300));
      return { sid, before, after: store.messagesOf(sid).length };
    });
    if (!(sent.after > sent.before)) fail(`send did not produce a message.add (${sent.before} → ${sent.after})`);
    else log(`send ok: ${sent.sid} ${sent.before} → ${sent.after} messages`);

    // cue needs_you → approval card in the HUD → Approve → the session leaves waiting_on_you. The replay is paused around
    // this step: the fixture's own replayed session.status lines for the cued session would otherwise race the cue
    // (cancelScripts only clears scripted-reply timers, not the jsonl timeline) and flip the card away within the 5 s wait.
    const cueSid = await page.evaluate(async () => {
      const { store, net } = window.__ceverything; const sid = store.order.find((id) => store.sessions.get(id).status !== 'waiting_on_you' && store.sessions.get(id).status !== 'done');
      await net.cmd('fixture.control', { action: 'pause' });
      await net.cmd('fixture.control', { action: 'cue', value: 'needs_you', sessionId: sid });
      return sid;
    });
    await waitFor(page, (sid) => window.__ceverything.store.sessions.get(sid)?.status === 'waiting_on_you', 'waiting_on_you after cue', 15000, cueSid).catch((e) => fail(e.message));
    const card = page.locator(`#hud-approvals .approval[data-id="${cueSid}"]`);
    try {
      await card.waitFor({ state: 'visible', timeout: 5000 });
      const beaconVisible = await page.evaluate((sid) => window.__ceverything.columns.get(sid)?.beacon.group.visible, cueSid);
      if (!info.noWebGL && !beaconVisible) fail('beacon not visible for the waiting_on_you column');
      await card.getByRole('button', { name: 'Approve' }).click();
      await waitFor(page, (sid) => window.__ceverything.store.sessions.get(sid)?.status !== 'waiting_on_you', 'approval resolved', 15000, cueSid);
      log(`approval ok: ${cueSid}`);
    } catch (err) { fail(`approval card flow: ${err.message}`); }
    await page.evaluate(() => window.__ceverything.net.cmd('fixture.control', { action: 'play' }).catch(() => {}));

    // fork + pipe + move + pause/play round-trips through the hub and the store reducers
    const rt = await page.evaluate(async () => {
      const { store, net, columns, app } = window.__ceverything; const out = {};
      const sid = store.order[0]; const before = store.sessions.size;
      const f = await net.cmd('fork', { sessionId: sid });
      await new Promise((r) => setTimeout(r, 400));
      out.fork = { newSessionId: f.newSessionId, sessions: store.sessions.size, before, column: columns.has(f.newSessionId), lineage: store.lineage.some((l) => l.newSessionId === f.newSessionId), placement: store.layout.get(f.newSessionId) };
      const msgs = store.messagesOf(sid); const fromMsg = msgs.find((m) => m.role === 'assistant') || msgs[0];
      const target = store.order.find((id) => id !== sid && id !== f.newSessionId);
      const tBefore = store.messagesOf(target).length;
      await net.cmd('pipe', { fromSessionId: sid, fromMessageId: fromMsg.id, toSessionId: target });
      await new Promise((r) => setTimeout(r, 400));
      const piped = store.messagesOf(target).slice(tBefore).find((m) => m.via === 'pipe');
      out.pipe = { target, added: store.messagesOf(target).length - tBefore, via: piped?.via, from: piped?.from, text: piped?.text?.slice(0, 40) };
      await net.cmd('layout.move', { sessionId: target, x: 1.5, z: -2.5, rot: 0.3 });
      await new Promise((r) => setTimeout(r, 100));
      out.move = { ...store.layout.get(target), slide: Boolean(columns.get(target)?.slide) };
      await net.cmd('fixture.control', { action: 'pause' });
      await new Promise((r) => setTimeout(r, 100));
      out.paused = store.sourceInfo.paused;
      await net.cmd('fixture.control', { action: 'play' });
      await new Promise((r) => setTimeout(r, 100));
      out.playing = store.sourceInfo.paused === false;
      out.focused = app.focusedId;
      return out;
    });
    log(`round trips: ${JSON.stringify(rt)}`);
    if (!(rt.fork.sessions === rt.fork.before + 1 && rt.fork.lineage && rt.fork.placement)) fail(`fork did not create a session + lineage + placement: ${JSON.stringify(rt.fork)}`);
    if (!info.noWebGL && !rt.fork.column) fail('fork did not create a column');
    if (!(rt.pipe.added >= 1 && rt.pipe.via === 'pipe' && rt.pipe.from)) fail(`pipe did not add a piped user tile: ${JSON.stringify(rt.pipe)}`);
    if (!(Math.abs(rt.move.x - 1.5) < 1e-6 && Math.abs(rt.move.z + 2.5) < 1e-6)) fail(`layout.move not mirrored: ${JSON.stringify(rt.move)}`);
    if (!(rt.paused === true && rt.playing)) fail(`fixture pause/play not reflected in sourceInfo: paused=${rt.paused} playing=${rt.playing}`);

    // reconnect: drop the socket, expect reconnecting → open with a lastSeq resume (seq keeps growing, no snapshot reset)
    const rc = await page.evaluate(async () => {
      const { net, store } = window.__ceverything; const seqBefore = store.seq; const snaps = store.stats.snapshots;
      const statuses = []; const off = net.on('status', (s) => statuses.push(s)); const offC = net.on('close', (e) => statuses.push(`close:${e.code}`));
      const attemptsBefore = net.attempts; const dropped = net.dropForTest();
      const t0 = Date.now();
      while (net.status === 'open' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));   // wait for the close to land
      while (net.status !== 'open' && Date.now() - t0 < 12000) await new Promise((r) => setTimeout(r, 50));  // then for the resume (0.5 s backoff)
      await new Promise((r) => setTimeout(r, 300));
      off(); offC();
      return { statuses, dropped, attempts: net.attempts - attemptsBefore, socket: net.socketState(), ms: Date.now() - t0, seqBefore, seqAfter: store.seq, snapshots: store.stats.snapshots - snaps, status: net.status, sessions: store.sessions.size };
    });
    log(`reconnect: ${JSON.stringify(rc)}`);
    if (rc.status !== 'open' || !rc.statuses.includes('reconnecting')) fail(`reconnect did not go reconnecting → open: ${JSON.stringify(rc)}`);
    if (rc.seqAfter < rc.seqBefore) fail('seq went backwards after reconnect');
    if (rc.snapshots !== 0) log('note: server sent a fresh snapshot instead of a replay (gap too large or ring reset) — acceptable');

    await sleep(300);
  } catch (err) {
    fail(err.stack || String(err));
    try { await page.screenshot({ path: path.join(OUT, 'failure.png') }); } catch { /* ignore */ }
  }

  const ignorable = (t) => /favicon\.ico/.test(t);
  const errs = consoleErrors.filter((t) => !ignorable(t));
  if (errs.length) fail(`console errors:\n  ${errs.join('\n  ')}`);
  if (pageErrors.length) fail(`page errors:\n  ${pageErrors.join('\n  ')}`);
  if (process.env.SMOKE_VERBOSE) console.log(consoleAll.join('\n'));

  await Promise.race([browser.close(), sleep(10000)]); // a crashed Chromium must not hang the run
  await api.close();
  if (failures.length) { console.error(`[smoke] ${failures.length} failure(s)`); process.exit(1); }
  log('PASS');
}

main().catch((err) => { console.error('[smoke] crashed', err); process.exit(1); });
