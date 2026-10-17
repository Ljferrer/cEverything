#!/usr/bin/env node
// Two laptop clients in one room (DESIGN.md "shared state proof"): page A and page B join the same server; everything
// A does must show up in B's store AND B's scene through the hub's event stream, never through local state.
//   presence   → B sees A's camera pyramid + name; A's tile hover paints the blue outline on B's copy of that tile
//   layout.move from A → B's store.layout + B's column slides (event carries by = A's clientId)
//   fork from A → B gets session.upsert + layout.column + fork: new column, lineage, cloned tiles
//   pipe from A → B's target column grows a '[from <title>]: …' user tile with via 'pipe'
//   cue needs_you + approve from A → B shows the approval card + beacon, then both clear
//   reset from A → forks gone on both, the seven columns come back at layout.json places
// Also: every request of both pages must stay on 127.0.0.1 (external hosts are aborted and fail the run), the import map
// resolves to /vendor/three/, and both consoles stay free of errors.
//
// By default this starts its own server (fixtures/demo @ speed 8, random port). Set E2E_URL=http://127.0.0.1:8795/ to
// run against a server started separately with `node server/index.js --fixture fixtures/demo --speed 8 --port 8795`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 60000;
const HEADLESS = process.env.SMOKE_HEADED !== '1';
const EXTERNAL = process.env.E2E_URL || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[two-clients]', ...a);
const failures = [];
const fail = (msg) => { failures.push(msg); console.error('[two-clients] FAIL', msg); };
const check = (cond, msg) => { if (!cond) fail(msg); return Boolean(cond); };

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

/** Open one laptop client: route guard, console capture, landing → room, hello. */
async function openClient(browser, baseUrl, name) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } }); // two SwiftShader pages share one CPU: keep them light
  const c = { page, name, errors: [], pageErrors: [], consoleAll: [], responses: new Map(), id: null };
  const allowedHost = new URL(baseUrl).hostname;
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== allowedHost) { c.errors.push(`external request blocked: ${u.href}`); return route.abort(); }
    return route.continue();
  });
  page.on('console', (m) => { c.consoleAll.push(`${m.type()}: ${m.text()}`); if (m.type() === 'error') c.errors.push(m.text()); });
  page.on('pageerror', (err) => c.pageErrors.push(err.message || String(err)));
  page.on('requestfailed', (req) => c.errors.push(`request failed: ${req.url()} ${req.failure()?.errorText || ''}`));
  page.on('response', (res) => { c.responses.set(new URL(res.url()).pathname, res.status()); if (res.status() >= 400) c.errors.push(`HTTP ${res.status()} ${res.url()}`); });
  await page.goto(`${baseUrl}?name=${encodeURIComponent(name)}`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await waitFor(page, () => Boolean(window.__ceverything && window.__ceverything.store), `${name}: window.__ceverything`);
  const btn = page.getByRole('button', { name: 'Open on laptop' });
  await btn.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  await btn.click();
  await waitFor(page, () => window.__ceverything.app.started === true && window.__ceverything.net.status === 'open' && window.__ceverything.store.clientId, `${name}: started + hello`);
  // record every event B/A receive (kind, session, by, seq) so cross-client assertions can look at the wire, not just state
  await page.evaluate(() => {
    const { store } = window.__ceverything;
    window.__e2e = { events: [] };
    store.on('event', (ev) => window.__e2e.events.push({ kind: ev.kind, sessionId: ev.sessionId, by: ev.by, seq: ev.seq, placement: ev.placement, newSessionId: ev.newSessionId, fromSessionId: ev.fromSessionId, toSessionId: ev.toSessionId }));
  });
  c.id = await page.evaluate(() => window.__ceverything.store.clientId);
  const info = await page.evaluate(() => ({ noWebGL: window.__ceverything.app.noWebGL, device: window.__ceverything.app.device }));
  log(`${name}: clientId ${c.id} device=${info.device} noWebGL=${info.noWebGL}`);
  if (info.noWebGL) fail(`${name}: WebGL did not initialize headless`);
  return c;
}

async function main() {
  let api = null; let baseUrl = EXTERNAL;
  if (!EXTERNAL) {
    api = await startServer({ port: 0, host: '127.0.0.1', fixture: 'fixtures/demo', speed: 8, loop: true, quiet: true, log: () => {} });
    baseUrl = `http://127.0.0.1:${api.port}/`;
  }
  if (!baseUrl.endsWith('/')) baseUrl += '/';
  log(`server ${api ? 'started in-process' : 'external'} at ${baseUrl}`);
  const layoutJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/demo/layout.json'), 'utf8'));

  const browser = await chromium.launch({ headless: HEADLESS, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let A = null; let B = null;
  try {
    A = await openClient(browser, baseUrl, 'A');
    B = await openClient(browser, baseUrl, 'B');
    for (const c of [A, B]) {
      await waitFor(c.page, () => window.__ceverything.store.sessions.size >= 6 && window.__ceverything.columns.size >= 6 && window.__ceverything.stats().tiles >= 10, `${c.name}: 6 sessions + columns + tiles`);
    }
    const sizes = await Promise.all([A, B].map((c) => c.page.evaluate(() => ({ sessions: window.__ceverything.store.sessions.size, columns: window.__ceverything.columns.size, seq: window.__ceverything.store.seq }))));
    log(`rooms: A ${JSON.stringify(sizes[0])} · B ${JSON.stringify(sizes[1])}`);

    // ---- import map on both origins' pages (served at /): three + addons resolve to this origin's /vendor/three/
    for (const c of [A, B]) {
      const im = await resolveImports(c.page, ['three', 'three/addons/webxr/XRButton.js', 'three/addons/controls/OrbitControls.js']);
      for (const [k, v] of Object.entries(im)) if (!v.startsWith(`${baseUrl}vendor/three/`)) fail(`${c.name}: import map ${k} resolved to ${v}`);
      for (const p of ['/vendor/three/build/three.module.js', '/vendor/three/examples/jsm/webxr/XRButton.js', '/vendor/three/examples/jsm/controls/OrbitControls.js']) if (c.responses.get(p) !== 200) fail(`${c.name}: ${p} not loaded with 200 (${c.responses.get(p)})`);
    }

    // ---- 1. presence: each sees the other (laptop pyramid + name), A's tile hover outlines that tile on B
    const seenA = await waitFor(B.page, (id) => { const p = window.__ceverything.store.presence.get(id); return p && p.head ? { device: p.device, name: p.name } : null; }, 'B sees A presence', 15000, A.id);
    const seenB = await waitFor(A.page, (id) => { const p = window.__ceverything.store.presence.get(id); return p && p.head ? { device: p.device, name: p.name } : null; }, 'A sees B presence', 15000, B.id);
    check(seenA.device === 'desktop' && seenA.name === 'A', `B's presence entry for A: ${JSON.stringify(seenA)}`);
    check(seenB.device === 'desktop' && seenB.name === 'B', `A's presence entry for B: ${JSON.stringify(seenB)}`);
    const avatar = await waitFor(B.page, (id) => { const a = window.__ceverything.app.presence.avatars.get(id); return a && a.hasPose && a.group.visible ? { headset: a.headset, name: a.name.userData.text } : null; }, 'B renders A avatar', 15000, A.id);
    check(avatar && avatar.headset === false && avatar.name === 'A', `B's avatar for A is a laptop pyramid named A: ${JSON.stringify(avatar)}`);
    log(`presence ok: B sees ${JSON.stringify(seenA)} (avatar ${JSON.stringify(avatar)}), A sees ${JSON.stringify(seenB)}`);

    await A.page.evaluate(() => window.__ceverything.net.cmd('fixture.control', { action: 'pause' })); // freeze the stacks for the hover probe
    await sleep(300);
    let hoverOk = false; let lastHover = null;
    for (let attempt = 0; attempt < 5 && !hoverOk; attempt++) {
      const probe = await A.page.evaluate(() => {
        const app = window.__ceverything.app;
        for (const col of window.__ceverything.columns.values()) {
          const r = col.tiles[0]; if (!r) continue;
          const v = r.world.clone().project(app.camera);
          const x = (v.x + 1) / 2 * window.innerWidth; const y = (1 - v.y) / 2 * window.innerHeight;
          if (document.elementFromPoint(x, y)?.id === 'gl') return { x, y, sid: col.id, messageId: r.msg.id };
        }
        return null;
      });
      if (!probe) { await sleep(300); continue; }
      await A.page.mouse.move(probe.x + 1, probe.y + 1); await A.page.mouse.move(probe.x, probe.y); await sleep(150);
      const hv = await A.page.evaluate(() => window.__ceverything.app.desktop.hoverInfo());
      lastHover = { probe, hv };
      if (!hv || !hv.messageId) continue;
      const onB = await waitFor(B.page, ({ id, mid }) => {
        const p = window.__ceverything.store.presence.get(id); const a = window.__ceverything.app.presence.avatars.get(id);
        return p?.hover?.messageId === mid && a?.outline?.visible ? { hover: p.hover, outline: a.outline.visible } : null;
      }, 'B outlines the tile A hovers', 5000, { id: A.id, mid: hv.messageId }).catch(() => null);
      if (onB) { hoverOk = true; log(`hover sync ok: A hovers ${hv.messageId} → B outline on ${JSON.stringify(onB.hover)}`); }
    }
    if (!hoverOk) fail(`A's tile hover did not reach B as a presence outline: ${JSON.stringify(lastHover)}`);
    await A.page.mouse.move(640, 790);
    await A.page.evaluate(() => window.__ceverything.net.cmd('fixture.control', { action: 'play' }));

    // ---- 2. layout.move from A → B store + column slide, event by = A
    const order = await A.page.evaluate(() => window.__ceverything.store.order.slice());
    const moveSid = order[1];
    const target = { x: -1.25, z: -2.35, rot: 0.42 };
    await A.page.evaluate(({ sid, t }) => window.__ceverything.net.cmd('layout.move', { sessionId: sid, x: t.x, z: t.z, rot: t.rot }), { sid: moveSid, t: target });
    const mv = await waitFor(B.page, ({ sid, t }) => {
      const p = window.__ceverything.store.layout.get(sid); if (!p || Math.abs(p.x - t.x) > 1e-6 || Math.abs(p.z - t.z) > 1e-6) return null;
      const ev = window.__e2e.events.filter((e) => e.kind === 'layout.column' && e.sessionId === sid).pop();
      return { placement: p, by: ev?.by, seq: ev?.seq };
    }, 'B receives layout.column', 10000, { sid: moveSid, t: target });
    check(mv.by === A.id, `layout.column on B carries by = A (${mv.by} vs ${A.id})`);
    // the 400 ms slide runs in B's frame loop; two software-rendered pages share one CPU here, so poll instead of sleeping
    const colB = await waitFor(B.page, ({ sid, t }) => { const c = window.__ceverything.columns.get(sid); if (!c || c.slide) return null; const p = { x: c.group.position.x, z: c.group.position.z, rot: c.group.rotation.y }; return Math.abs(p.x - t.x) < 0.02 && Math.abs(p.z - t.z) < 0.02 ? p : null; }, 'B column slide finished', 15000, { sid: moveSid, t: target }).catch(() => null);
    check(colB, `B's column slid to the new floor position (${moveSid} → ${JSON.stringify(target)})`);
    log(`move ok: ${moveSid} → B ${JSON.stringify(mv.placement)} column ${JSON.stringify(colB)}`);

    // ---- 3. fork from A → B gets a new column with lineage + cloned tiles
    const forkSid = order[0];
    const beforeB = await B.page.evaluate(() => ({ sessions: window.__ceverything.store.sessions.size, columns: window.__ceverything.columns.size }));
    const forkRes = await A.page.evaluate((sid) => window.__ceverything.net.cmd('fork', { sessionId: sid }), forkSid);
    const fk = await waitFor(B.page, (id) => {
      const { store, columns } = window.__ceverything; const s = store.sessions.get(id); const col = columns.get(id);
      if (!s || !col) return null;
      return { parentId: s.parentId, title: s.title, lineage: store.lineage.some((l) => l.newSessionId === id), placement: store.layout.get(id), messages: store.messagesOf(id).length, tiles: col.tiles.length, forkEvent: window.__e2e.events.some((e) => e.kind === 'fork' && e.newSessionId === id), sessions: store.sessions.size, columns: columns.size };
    }, 'B receives the fork', 10000, forkRes.newSessionId);
    check(fk.parentId === forkSid && fk.lineage && fk.placement && fk.forkEvent, `fork visible on B with lineage + placement: ${JSON.stringify(fk)}`);
    check(fk.sessions === beforeB.sessions + 1 && fk.columns === beforeB.columns + 1, `B gained exactly one session + column (${beforeB.sessions}→${fk.sessions}, ${beforeB.columns}→${fk.columns})`);
    check(fk.messages >= 1 && fk.tiles >= 1, `B's fork column has cloned tiles: ${fk.messages} msgs / ${fk.tiles} tiles`);
    log(`fork ok: ${forkRes.newSessionId} (${fk.messages} cloned) on B at ${JSON.stringify(fk.placement)}`);

    // ---- 4. pipe from A → B's target column grows a piped user tile
    const pipeTo = order.find((id) => id !== forkSid && id !== moveSid && id !== forkRes.newSessionId);
    const src = await A.page.evaluate((sid) => { const m = window.__ceverything.store.messagesOf(sid); const a = m.find((x) => x.role === 'assistant') || m[0]; return a ? { id: a.id, text: a.text.slice(0, 30) } : null; }, forkSid);
    const tBefore = await B.page.evaluate((sid) => ({ msgs: window.__ceverything.store.messagesOf(sid).length, tiles: window.__ceverything.columns.get(sid)?.tiles.length }), pipeTo);
    await A.page.evaluate(({ from, mid, to }) => window.__ceverything.net.cmd('pipe', { fromSessionId: from, fromMessageId: mid, toSessionId: to }), { from: forkSid, mid: src.id, to: pipeTo });
    const pp = await waitFor(B.page, ({ to, mid }) => {
      const { store, columns } = window.__ceverything;
      const m = store.messagesOf(to).find((x) => x.via === 'pipe' && x.from?.messageId === mid); if (!m) return null;
      const col = columns.get(to);
      return { text: m.text.slice(0, 40), from: m.from, role: m.role, tileInWindow: Boolean(col?.tileRecord(m.id)), tiles: col?.tiles.length, msgs: store.messagesOf(to).length, pipeEvent: window.__e2e.events.some((e) => e.kind === 'pipe' && e.toSessionId === to) };
    }, 'B receives the piped tile', 10000, { to: pipeTo, mid: src.id });
    check(pp.role === 'user' && /^\[from .+\]: /.test(pp.text) && pp.from.sessionId === forkSid, `piped tile on B is a '[from <title>]: …' user message: ${JSON.stringify(pp)}`);
    check(pp.tileInWindow && pp.msgs > tBefore.msgs, `B's column ${pipeTo} grew (${tBefore.msgs}→${pp.msgs} msgs, tile in window)`);
    check(pp.pipeEvent, 'B received the pipe event (arc animation source)');
    log(`pipe ok: ${forkSid}:${src.id} → ${pipeTo} on B: "${pp.text}"`);

    // ---- 5. cue needs_you from A → both show waiting_on_you (B: approval card + beacon); approve from A clears both
    const cueSid = order.find((id) => ![forkSid, moveSid, pipeTo].includes(id)) || moveSid;
    const cue = await A.page.evaluate((sid) => window.__ceverything.net.cmd('fixture.control', { action: 'cue', value: 'needs_you', sessionId: sid }), cueSid);
    for (const c of [A, B]) await waitFor(c.page, (sid) => window.__ceverything.store.sessions.get(sid)?.status === 'waiting_on_you', `${c.name}: waiting_on_you`, 10000, cueSid);
    const cardB = B.page.locator(`#hud-approvals .approval[data-id="${cueSid}"]`);
    await cardB.waitFor({ state: 'visible', timeout: 5000 }).catch((e) => fail(`B approval card: ${e.message}`));
    const beaconB = await B.page.evaluate((sid) => window.__ceverything.columns.get(sid)?.beacon.group.visible, cueSid);
    check(beaconB === true, 'B shows the red beacon on the cued column');
    // the story keeps replaying meanwhile: the cued session must stay parked until someone resolves it (server holds it)
    await sleep(2500);
    const stillB = await B.page.evaluate((sid) => window.__ceverything.store.sessions.get(sid)?.status, cueSid);
    check(stillB === 'waiting_on_you', `cued session stays waiting_on_you while the replay runs (B sees ${stillB})`);
    await A.page.evaluate(({ sid, rid }) => window.__ceverything.net.cmd('approve', { sessionId: sid, requestId: rid, allow: true }), { sid: cueSid, rid: cue.requestId });
    for (const c of [A, B]) await waitFor(c.page, (sid) => window.__ceverything.store.sessions.get(sid)?.status !== 'waiting_on_you', `${c.name}: approval resolved`, 10000, cueSid);
    await waitFor(B.page, (sid) => document.querySelectorAll(`#hud-approvals .approval[data-id="${sid}"]`).length === 0, 'B approval card removed', 5000, cueSid).catch((e) => fail(e.message));
    const afterB = await B.page.evaluate((sid) => ({ status: window.__ceverything.store.sessions.get(sid)?.status, beacon: window.__ceverything.columns.get(sid)?.beacon.group.visible, userTile: window.__ceverything.store.messagesOf(sid).some((m) => m.role === 'user' && /go ahead/i.test(m.text)) }), cueSid);
    check(afterB.beacon === false && afterB.userTile, `B after approve: beacon hidden + 'Yes, go ahead.' tile: ${JSON.stringify(afterB)}`);
    log(`approve ok: ${cueSid} → B ${JSON.stringify(afterB)}`);

    // ---- 6. reset from A → forks gone everywhere, seven columns back at layout.json places
    const seqBefore = await B.page.evaluate(() => window.__ceverything.store.seq);
    await A.page.evaluate(() => window.__ceverything.net.cmd('fixture.control', { action: 'reset' }));
    for (const c of [A, B]) {
      await waitFor(c.page, (id) => !window.__ceverything.store.sessions.has(id), `${c.name}: fork removed`, 10000, forkRes.newSessionId);
      await waitFor(c.page, () => window.__ceverything.store.sessions.size >= 7 && window.__ceverything.columns.size >= 7, `${c.name}: story restarted`, 15000);
    }
    await sleep(800);
    const rs = await B.page.evaluate((layout) => {
      const { store, columns } = window.__ceverything; const out = { sessions: store.sessions.size, columns: columns.size, seq: store.seq, lineage: store.lineage.length, mismatches: [], forkColumn: [...columns.keys()].filter((k) => /~f\d/.test(k)) };
      for (const [sid, p] of Object.entries(layout)) {
        const q = store.layout.get(sid); const c = columns.get(sid);
        if (!q || Math.abs(q.x - p.x) > 1e-6 || Math.abs(q.z - p.z) > 1e-6 || Math.abs(q.rot - p.rot) > 1e-6) out.mismatches.push({ sid, want: p, got: q });
        else if (c && !c.slide && (Math.abs(c.group.position.x - p.x) > 0.02 || Math.abs(c.group.position.z - p.z) > 0.02)) out.mismatches.push({ sid, column: [c.group.position.x, c.group.position.z] });
      }
      return out;
    }, layoutJson);
    check(rs.mismatches.length === 0, `B layout restored to layout.json after reset: ${JSON.stringify(rs.mismatches)}`);
    check(rs.forkColumn.length === 0 && rs.lineage === 0, `no fork columns / lineage left on B after reset: ${JSON.stringify(rs.forkColumn)}`);
    check(rs.seq > seqBefore, `seq keeps growing across the reset (${seqBefore} → ${rs.seq})`);
    const rsA = await A.page.evaluate(() => ({ sessions: window.__ceverything.store.sessions.size, lineage: window.__ceverything.store.lineage.length, forks: [...window.__ceverything.columns.keys()].filter((k) => /~f\d/.test(k)).length }));
    check(rsA.lineage === 0 && rsA.forks === 0, `A also dropped the fork after reset: ${JSON.stringify(rsA)}`);
    log(`reset ok: B ${JSON.stringify({ sessions: rs.sessions, columns: rs.columns, seq: rs.seq })} · A ${JSON.stringify(rsA)}`);

    // ---- 7. both clients ended on the same seq / session set (B may lag by a few ms)
    await sleep(500);
    const fin = await Promise.all([A, B].map((c) => c.page.evaluate(() => ({ seq: window.__ceverything.store.seq, ids: [...window.__ceverything.store.sessions.keys()].sort().join(','), layout: [...window.__ceverything.store.layout.entries()].map(([k, v]) => `${k}:${v.x},${v.z}`).sort().join(' ') }))));
    check(fin[0].ids === fin[1].ids && fin[0].layout === fin[1].layout, `A and B agree on sessions + layout: ${JSON.stringify(fin)}`);
    check(Math.abs(fin[0].seq - fin[1].seq) <= 5, `A and B seq within 5 (${fin[0].seq} vs ${fin[1].seq})`);
  } catch (err) {
    fail(err.stack || String(err));
    try { await A?.page.screenshot({ path: path.join(ROOT, 'test-results', 'two-clients-A-failure.png') }); await B?.page.screenshot({ path: path.join(ROOT, 'test-results', 'two-clients-B-failure.png') }); } catch { /* ignore */ }
  }

  for (const c of [A, B]) {
    if (!c) continue;
    const errs = c.errors.filter((t) => !/favicon\.ico/.test(t));
    if (errs.length) fail(`${c.name} console errors:\n  ${errs.join('\n  ')}`);
    if (c.pageErrors.length) fail(`${c.name} page errors:\n  ${c.pageErrors.join('\n  ')}`);
    if (process.env.SMOKE_VERBOSE) console.log(`--- ${c.name} console ---\n${c.consoleAll.join('\n')}`);
  }
  await Promise.race([browser.close(), sleep(10000)]); // a crashed Chromium must not hang the run
  if (api) await api.close();
  if (failures.length) { console.error(`[two-clients] ${failures.length} failure(s)`); process.exit(1); }
  log('PASS');
}

main().catch((err) => { console.error('[two-clients] crashed', err); process.exit(1); });
