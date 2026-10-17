#!/usr/bin/env node
// Headless shape test for the XR layer (no headset): starts the server in fixture mode, opens / in headless Chromium
// (which has no WebXR device), and asserts that web/input/xr.js + voice.js + pylons.js + filetree.js + detail.js +
// debug3d.js load and degrade cleanly: no exceptions, ENTER XR hidden, XRButton hidden/disabled, xr.enter() rejects
// with a clean error, xr.update() is a no-op. It then drives the gesture state machine with synthetic rays (tap tile →
// detail plane, carry tile → pipe, hold base 0.6 s → summon, title pull → fork, base drag → layout.move, floor hold →
// recenter, left pinch → push-to-talk), the voice pending tile + 2 s countdown → send {via:'voice'}, the file tree and
// the pylon packet routing. Zero console errors / page errors / failed requests, like test/smoke.mjs.

import { chromium } from 'playwright';
import { startServer } from '../server/index.js';

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS) || 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[xr-shape]', ...a);
const failures = [];
const fail = (msg) => { failures.push(msg); console.error('[xr-shape] FAIL', msg); };
const check = (cond, msg) => { if (!cond) fail(msg); return Boolean(cond); };

async function waitFor(page, fn, label, timeout = TIMEOUT_MS, arg) {
  const start = Date.now();
  for (;;) {
    let v; try { v = await page.evaluate(fn, arg); } catch (err) { if (!/Execution context was destroyed/.test(err.message)) throw err; }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
}

async function main() {
  const api = await startServer({ port: 0, host: '127.0.0.1', fixture: 'fixtures/demo', speed: 8, loop: true, quiet: true, log: () => {} });
  const url = `http://127.0.0.1:${api.port}/?name=xr-shape&debug=1`;
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = []; const pageErrors = []; const consoleAll = [];
  page.on('console', (m) => { consoleAll.push(`${m.type()}: ${m.text()}`); if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
  page.on('requestfailed', (req) => consoleErrors.push(`request failed: ${req.url()} ${req.failure()?.errorText || ''}`));
  page.on('response', (res) => { if (res.status() >= 400) consoleErrors.push(`HTTP ${res.status()} ${res.url()}`); });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await waitFor(page, () => Boolean(window.__ceverything?.app?.xr && window.__ceverything.app.voice && window.__ceverything.app.pylons && window.__ceverything.app.filetree && window.__ceverything.app.detail && window.__ceverything.app.debug3d), 'all XR-layer modules created (not stubs)');
    await waitFor(page, () => window.__ceverything.net.status === 'open' && window.__ceverything.store.sessions.size >= 6, 'hello + 6 sessions');
    await waitFor(page, () => window.__ceverything.columns.size >= 6 && window.__ceverything.stats().tiles >= 20, 'columns + tiles');

    // ---- 1. degradation without a WebXR device
    const shape = await page.evaluate(async () => {
      const { app } = window.__ceverything; const xr = app.xr;
      await xr.ready;
      let enterError = null;
      try { await xr.enter('vr'); } catch (err) { enterError = err.message; }
      let updateError = null;
      try { xr.update(0, null, 0.016); xr.update(16, null, 0.016); } catch (err) { updateError = err.message; }
      const btn = document.getElementById('xr-button');
      return {
        hasXR: Boolean(navigator.xr), supported: xr.supported, presenting: xr.isPresenting, sendsPresence: xr.sendsPresence, enterError, updateError,
        enterHidden: document.getElementById('enter-xr').hidden, xrButton: btn ? { hidden: btn.hidden, disabled: btn.hasAttribute('disabled'), text: btn.textContent } : null,
        controllers: xr.controllers.length, hands: xr.hands.length, device: xr.device, sessionInit: xr.sessionInit(), wantHands: xr.wantHands,
        micVisible: xr.mic.sphere.visible, stats: xr.stats(),
      };
    });
    log(`shape: ${JSON.stringify(shape)}`);
    check(shape.controllers === 4, 'controllers 0..3 must exist before any session');
    check(shape.presenting === false && shape.sendsPresence === false, 'not presenting without a device');
    check(typeof shape.enterError === 'string' && shape.enterError.length > 0, 'xr.enter() must reject with a clean error where WebXR is missing');
    check(shape.updateError === null, `xr.update must be a no-op without a session (got ${shape.updateError})`);
    check(shape.enterHidden, 'ENTER XR must be hidden where WebXR is unsupported');
    if (shape.xrButton) check(shape.xrButton.hidden && shape.xrButton.disabled, `XRButton must be hidden + disabled without WebXR: ${JSON.stringify(shape.xrButton)}`);
    check(shape.sessionInit.optionalFeatures.includes('local-floor') && shape.sessionInit.optionalFeatures.includes('layers'), 'sessionInit must request local-floor + layers');
    check(!shape.sessionInit.optionalFeatures.includes('hand-tracking') || shape.wantHands, 'hand-tracking only when wanted');
    check(shape.hands === 0, 'no hand groups on a desktop device without ?hands=1');

    // ---- 2. gesture state machine driven with synthetic rays (camera → targets)
    const gest = await page.evaluate(async () => {
      const { app, columns, store } = window.__ceverything; const xr = app.xr; const G = xr.gestures;
      const out = {}; const t0 = performance.now();
      await window.__ceverything.net.cmd('fixture.control', { action: 'pause' }); // freeze the stacks so synthetic rays stay on their targets
      await new Promise((r) => setTimeout(r, 400));
      const camPos = app.camera.position.clone();
      const rayTo = (target, from = camPos) => { const d = target.clone().sub(from).normalize(); return { o: from.clone(), d }; };
      const cols = [...columns.values()].filter((c) => c.tiles.length > 2);
      const src = cols[0]; const dst = [...columns.values()].find((c) => c !== src && !c.removed && Math.hypot(c.group.position.x - src.group.position.x, c.group.position.z - src.group.position.z) > 0.9);
      const tile = src.tiles[1];
      // (a) tap a tile → detail plane opens + selection
      const r1 = rayTo(tile.world);
      const pick1 = xr.pickRay(r1);
      out.pick = pick1 ? { kind: pick1.kind, column: pick1.column?.id, msg: pick1.record?.msg.id } : null;
      G.begin('k1', r1, t0, { inputSource: { handedness: 'right', targetRayMode: 'tracked-pointer', profiles: ['test'] } });
      G.move('k1', r1, t0 + 60);
      G.end('k1', r1, t0 + 120);
      await new Promise((r) => setTimeout(r, 50));
      out.detail = { open: app.detail.isOpen, msg: app.detail.message?.id, selected: app.selected?.msg.id, current: app.detail.current() };
      // (b) tap on the detail plane closes it
      const dp = app.detail.group.position.clone();
      const r2 = rayTo(dp);
      G.begin('k2', r2, t0 + 200, { inputSource: { handedness: 'right' } }); G.end('k2', r2, t0 + 260);
      out.detailClosed = !app.detail.isOpen;
      // (c) carry a tile over another column → pipe
      const before = store.messagesOf(dst.id).length;
      const r3 = rayTo(tile.world);
      G.begin('k3', r3, t0 + 300, { inputSource: { handedness: 'right' } });
      const g3 = G.active.get('k3'); const dist = g3.dist;
      // move the carried point horizontally toward the destination base, keeping it at the hit distance
      const steps = 12; const target = new (tile.world.constructor)(dst.group.position.x, tile.world.y, dst.group.position.z);
      for (let i = 1; i <= steps; i++) {
        const p = tile.world.clone().lerp(target, i / steps);
        const d = p.clone().sub(camPos).normalize();
        const o2 = p.clone().sub(d.clone().multiplyScalar(dist)); // the hand moves so the carried point stays at the hit distance
        G.move('k3', { o: o2, d }, t0 + 300 + i * 40);
      }
      out.carry = { mode: g3.mode, target: g3.target?.id, ghost: G.visuals.carryGhost.visible, ring: G.visuals.dropRing.visible };
      G.end('k3', null, t0 + 900);
      await new Promise((r) => setTimeout(r, 500));
      const piped = store.messagesOf(dst.id).slice(before).find((m) => m.via === 'pipe');
      out.pipe = { added: store.messagesOf(dst.id).length - before, via: piped?.via, from: piped?.from?.messageId, expected: g3.record?.msg.id };
      // (d) hold the base 0.6 s without moving → summon (local), hold again → send back
      const base = src.group.position.clone(); base.y = 0.05;
      const r4 = rayTo(base);
      G.begin('k4', r4, t0 + 1000, { inputSource: { handedness: 'right' } });
      G.move('k4', r4, t0 + 1300); const dwellMid = G.visuals.dwellRing.visible;
      G.move('k4', r4, t0 + 1650);
      out.summon = { mode: G.active.get('k4')?.mode, summoned: src.summoned, dwellMid, pose: src.summonPose };
      G.end('k4', r4, t0 + 1700);
      src.unsummon();
      // (e) pull the title plate > 0.5 m sideways → fork {x,z}
      const sessionsBefore = store.sessions.size;
      const title = src.titlePosition();
      const r5 = rayTo(title);
      G.begin('k5', r5, t0 + 2000, { inputSource: { handedness: 'right' } });
      const far = title.clone(); far.x += 1.2; far.y = 0.0;
      for (let i = 1; i <= 6; i++) { const p = title.clone().lerp(far, i / 6); p.y = Math.max(0.01, p.y); G.move('k5', rayTo(p), t0 + 2000 + i * 50); }
      out.fork = { mode: G.active.get('k5')?.mode, ghost: G.visuals.forkGhost.visible, point: G.active.get('k5')?.forkPoint ? 1 : 0 };
      G.end('k5', null, t0 + 2400);
      await new Promise((r) => setTimeout(r, 500));
      out.fork.sessions = store.sessions.size; out.fork.before = sessionsBefore;
      // (f) drag a base on the floor → layout.move (prediction + final)
      const mover = [...columns.values()].find((c) => c !== src && c !== dst && !c.removed) || dst;
      // aim at the base's floor point: the drag keeps the grab offset (column − floor hit at begin), so with a zero offset the
      // column must land exactly on `dest`; the move only starts once the ray's floor point travelled > 0.15 m
      const b6 = mover.group.position.clone(); b6.y = 0;
      G.begin('k6', rayTo(b6), t0 + 3000, { inputSource: { handedness: 'right' } });
      out.movePick = xr.pickRay(rayTo(b6))?.kind;
      G.move('k6', rayTo(b6.clone().add(new (camPos.constructor)(0.05, 0, 0.05))), t0 + 3060); // 7 cm of floor drift: still a hold, not a move
      out.moveAfterDrift = G.active.get('k6')?.mode;
      const dest = b6.clone(); dest.x += 0.6; dest.z -= 0.4; dest.y = 0;
      for (let i = 1; i <= 5; i++) { const p = b6.clone().lerp(dest, i / 5); p.y = 0; G.move('k6', rayTo(p), t0 + 3000 + i * 120); }
      out.move = { mode: G.active.get('k6')?.mode, dragging: mover.dragging, x: mover.group.position.x, z: mover.group.position.z };
      G.end('k6', null, t0 + 3700);
      await new Promise((r) => setTimeout(r, 400));
      out.move.layout = store.layout.get(mover.id); out.move.dest = { x: dest.x, z: dest.z };
      // (g) floor hold 1 s → recenter to head height − 0.3
      const floorPt = camPos.clone(); floorPt.y = 0; floorPt.z -= 1.0;
      G.begin('k7', rayTo(floorPt), t0 + 4000, { inputSource: { handedness: 'right' } });
      G.move('k7', rayTo(floorPt), t0 + 5050);
      out.recenter = { mode: G.active.get('k7')?.mode, readingHeight: app.room.readingHeight, head: camPos.y };
      G.end('k7', rayTo(floorPt), t0 + 5100);
      // (h) left pinch with the ray hitting nothing → push-to-talk → voice.start (engine-dependent) and stop
      const upRay = { o: camPos.clone(), d: new (camPos.constructor)(0, 1, 0) };
      app.focusedId = src.id;
      G.begin('k8', upRay, t0 + 6000, { inputSource: { handedness: 'left' } });
      out.talk = { mode: G.active.get('k8')?.mode, target: G.active.get('k8')?.talkTarget, voiceTalking: app.voice.talking, engine: app.voice.engine };
      G.end('k8', upRay, t0 + 6300);
      app.voice.cancel(true);
      // (i) left pinch on a tile talks to THAT column (never a grab / carry, even when the hand moves)
      const r9 = rayTo(src.tiles[0].world); const p9 = xr.pickRay(r9);
      out.leftPick = p9 ? { kind: p9.kind, column: p9.column?.id } : null;
      G.begin('k9', r9, t0 + 7000, { inputSource: { handedness: 'left' } });
      for (let i = 1; i <= 4; i++) { const p = src.tiles[0].world.clone(); p.x += 0.3 * i; G.move('k9', rayTo(p), t0 + 7000 + i * 50); }
      out.leftTapOnly = G.active.get('k9')?.mode; out.leftTalkTarget = G.active.get('k9')?.talkTarget;
      G.end('k9', null, t0 + 7300);
      app.voice.cancel(true);
      // (i2) a left SQUEEZE (talkOnly) with the ray on a tile is push-to-talk as well, never a tap that opens the detail plane
      app.detail.close();
      G.begin('k9b', r9, t0 + 7400, { inputSource: { handedness: 'left' }, talkOnly: true });
      out.leftSqueeze = { mode: G.active.get('k9b')?.mode, target: G.active.get('k9b')?.talkTarget };
      G.end('k9b', r9, t0 + 7450);
      out.leftSqueeze.detailOpen = app.detail.isOpen;
      app.voice.cancel(true);
      // (i3) a long hold on a column part is not a tap (a 1 s floor/beacon hold must never approve or select)
      G.begin('k9c', r1, t0 + 7500, { inputSource: { handedness: 'right' } });
      G.end('k9c', r1, t0 + 8400);
      out.longHold = { mode: 'ended', detailOpen: app.detail.isOpen };
      // (j) beacon tap approves a waiting_on_you column
      const waiting = [...columns.values()].find((c) => c.session.status === 'waiting_on_you');
      if (waiting) {
        const beacon = waiting.group.localToWorld(new (camPos.constructor)(0, 2.6, 0));
        const rb = rayTo(beacon);
        const pb = xr.pickRay(rb);
        G.begin('k10', rb, t0 + 8000, { inputSource: { handedness: 'right' } }); G.end('k10', rb, t0 + 8100);
        await new Promise((r) => setTimeout(r, 1500)); // the fixture's scripted continue flips the status after a 300–600 ms gap
        out.beacon = { pick: pb?.kind, status: store.sessions.get(waiting.id)?.status, id: waiting.id };
      } else out.beacon = { skipped: true };
      // (k) the dispatch path (session/controller events): inject selectstart/selectend with a fake input source → tap + debug3d info
      const fakeSource = { handedness: 'right', targetRayMode: 'transient-pointer', profiles: ['generic-hand'] };
      const rk = rayTo(src.tiles[0].world);
      xr.inject('selectstart', fakeSource, rk); xr.inject('selectstart', fakeSource, rk); // the second one is a duplicate (controller-level echo) and must be ignored
      await new Promise((r) => setTimeout(r, 60));
      xr.inject('selectend', fakeSource, rk);
      out.inject = { detailOpen: app.detail.isOpen, duplicates: xr.stats().duplicates, selects: xr.stats().selects };
      app.detail.close();
      out.gestures = G.stats();
      out.debugInput = app.debug3d.inputInfo;
      await window.__ceverything.net.cmd('fixture.control', { action: 'play' });
      return out;
    });
    log(`gestures: ${JSON.stringify(gest)}`);
    check(gest.pick?.kind === 'tile', `ray pick on a tile → tile (got ${JSON.stringify(gest.pick)})`);
    check(gest.detail.open && gest.detail.msg === gest.pick?.msg && gest.detail.current?.messageId === gest.pick?.msg, `tap tile opens the detail plane for that message: ${JSON.stringify(gest.detail)}`);
    check(gest.detailClosed, 'tap on the detail plane closes it');
    check(gest.carry.mode === 'carry' && gest.carry.target && gest.carry.ghost && gest.carry.ring, `tile carry over another column shows ghost + drop ring: ${JSON.stringify(gest.carry)}`);
    check(gest.pipe.added >= 1 && gest.pipe.via === 'pipe' && gest.pipe.from === gest.pipe.expected, `carry release → pipe command → piped tile: ${JSON.stringify(gest.pipe)}`);
    check(gest.summon.mode === 'done' && gest.summon.summoned && gest.summon.dwellMid, `base hold 0.6 s → summon: ${JSON.stringify(gest.summon)}`);
    check(gest.fork.mode === 'fork' && gest.fork.ghost && gest.fork.point && gest.fork.sessions === gest.fork.before + 1, `title pull → fork: ${JSON.stringify(gest.fork)}`);
    check(gest.movePick === 'base' && gest.moveAfterDrift === 'pending', `7 cm of floor drift on a base hold stays a hold (pick ${gest.movePick}, mode ${gest.moveAfterDrift})`);
    check(gest.move.mode === 'move' && gest.move.dragging && gest.move.layout && Math.abs(gest.move.layout.x - gest.move.dest.x) < 0.05 && Math.abs(gest.move.layout.z - gest.move.dest.z) < 0.05, `base drag → layout.move: ${JSON.stringify(gest.move)}`);
    check(gest.recenter.mode === 'done' && Math.abs(gest.recenter.readingHeight - (gest.recenter.head - 0.3)) < 0.01, `floor hold → recenter: ${JSON.stringify(gest.recenter)}`);
    check(gest.talk.mode === 'talk' || gest.talk.mode === 'done', `left pinch on nothing → talk: ${JSON.stringify(gest.talk)}`);
    check((gest.leftTapOnly === 'talk' && gest.leftTalkTarget === gest.leftPick?.column) || gest.leftTapOnly === 'done', `left pinch on a tile talks to that column, never grabs (got ${gest.leftTapOnly} → ${gest.leftTalkTarget}, pick ${JSON.stringify(gest.leftPick)})`);
    check((gest.leftSqueeze.mode === 'talk' && gest.leftSqueeze.target === gest.leftPick?.column) || gest.leftSqueeze.mode === 'done', `left squeeze on a tile is push-to-talk: ${JSON.stringify(gest.leftSqueeze)}`);
    check(gest.leftSqueeze.detailOpen === false, 'left squeeze on a tile never opens the detail plane');
    check(gest.longHold.detailOpen === false, 'a 900 ms hold on a tile is not a tap (detail stays closed)');
    check(gest.inject.detailOpen && gest.inject.duplicates >= 1 && /transient-pointer right/.test(gest.debugInput), `injected select events go through dispatch + dedupe + debug3d: ${JSON.stringify(gest.inject)} info=${gest.debugInput}`);
    if (!gest.beacon.skipped) check(gest.beacon.pick === 'beacon' && gest.beacon.status !== 'waiting_on_you', `beacon tap → approve: ${JSON.stringify(gest.beacon)}`);

    // ---- 3. voice: pending tile + countdown → send {via:'voice'}; cancel path; remote ghost tile
    const voice = await page.evaluate(async () => {
      const { app, store } = window.__ceverything; const v = app.voice; const out = { engine: v.engine, micState: v.micState };
      const sid = store.order.find((id) => store.sessions.get(id).status !== 'done');
      const before = store.messagesOf(sid).length;
      v.onTranscript('yes go ahead and run it', false, sid, true);
      await new Promise((r) => requestAnimationFrame(r));
      out.partial = { ...v.pending, planeVisible: app.scene.getObjectByName('voice-pending')?.visible };
      v.onTranscript('yes go ahead and run it', true, sid, true);
      out.final = { ...v.pending };
      out.cancelled = v.cancel(true); out.afterCancel = v.pending;
      v.onTranscript('second try, send this', true, sid, true);
      await new Promise((r) => setTimeout(r, 2600));
      const msgs = store.messagesOf(sid).slice(before);
      const sent = msgs.find((m) => m.via === 'voice');
      out.sent = { added: msgs.length, text: sent?.text, via: sent?.via, pendingAfter: v.pending };
      // remote teammate's live transcript → ghost tile on that column (no send from us)
      const b2 = store.messagesOf(sid).length;
      store.emit('transcript', { clientId: 'c_remote', sessionId: sid, text: 'remote partial…', final: false });
      out.remote = { pending: v.stats().pending };
      store.emit('transcript', { clientId: 'c_remote', sessionId: sid, text: 'remote final', final: true });
      await new Promise((r) => setTimeout(r, 3400)); // REMOTE_LINGER_MS is 2.5 s; leave slack for slow software-rendered frames
      out.remote.after = v.stats().pending; out.remote.added = store.messagesOf(sid).length - b2;
      out.startNone = v.engine === 'none' ? v.start(sid) : 'skipped';
      return out;
    });
    log(`voice: ${JSON.stringify(voice)}`);
    check(voice.partial.text && voice.partial.countdownMs === null && voice.partial.planeVisible, `partial transcript → pending tile without countdown: ${JSON.stringify(voice.partial)}`);
    check(voice.final.final && voice.final.countdownMs > 1500, `final transcript starts the 2 s countdown: ${JSON.stringify(voice.final)}`);
    check(voice.cancelled && voice.afterCancel === null, 'cancel() clears the countdown');
    check(voice.sent.via === 'voice' && voice.sent.text === 'second try, send this' && voice.sent.pendingAfter === null, `countdown → send {via:'voice'}: ${JSON.stringify(voice.sent)}`);
    check(voice.remote.pending >= 1 && voice.remote.after === 0, `remote transcript shows + clears a ghost tile: ${JSON.stringify(voice.remote)}`);

    // ---- 4. pylons + file tree + detail + debug3d shapes
    const scene = await page.evaluate(async () => {
      const { app, store, columns } = window.__ceverything; const out = {};
      const p = app.pylons; const b = p.positionOf('browser'); const t = p.positionOf('terminal'); const f = p.positionOf('files');
      out.pylons = { browser: b && [b.x, b.y, b.z].map((v) => +v.toFixed(2)), terminal: t && [t.x, t.y, t.z].map((v) => +v.toFixed(2)), files: f && [f.x, f.y, f.z].map((v) => +v.toFixed(2)), self: p.positionOf('self'), markersHidden: app.room.markers.visible === false };
      // fake a web tool round trip through the packet path (replay paused: the story's own web_extract / terminal calls
      // would otherwise overwrite the query sprite and the terminal screen inside the 800 ms waits)
      await window.__ceverything.net.cmd('fixture.control', { action: 'pause' });
      await new Promise((r) => setTimeout(r, 300));
      const col = [...columns.values()][0]; const msg = store.messagesOf(col.id)[0];
      const fxBefore = app.fx.stats().packets;
      p.onToolStart({ sessionId: col.id, messageId: msg.id, callId: 'x1', name: 'web_search', category: 'web', target: 'browser', args: { query: 'visionOS webxr' } }, col.worldOf(), col);
      out.packetFlying = app.fx.stats().packets > fxBefore;
      await new Promise((r) => setTimeout(r, 800));
      out.query = p.stats().query;
      p.onToolStart({ sessionId: col.id, messageId: msg.id, callId: 'x2', name: 'terminal', category: 'coding', target: 'terminal', args: { command: 'npm test' } }, col.worldOf(), col);
      await new Promise((r) => setTimeout(r, 800));
      p.onToolComplete({ sessionId: col.id, messageId: msg.id, callId: 'x2', name: 'terminal', ok: true, durationMs: 1200, meta: { exitCode: 0 } }, col.worldOf(), col);
      out.terminal = p.stats().lastCommand;
      // file tree: nodes from fixture paths, diff card on a patch
      const ft = app.filetree; out.tree = ft.stats();
      ft.onToolComplete({ sessionId: col.id, messageId: msg.id, callId: 'x3', name: 'patch', ok: true, meta: { path: 'src/parser.js', diff: '--- a/src/parser.js\n+++ b/src/parser.js\n@@ -1,3 +1,4 @@\n-old\n+new\n+more\n ctx' } }, null);
      out.treeAfter = ft.stats();
      out.node = ft.nodePosition('src/parser.js');
      out.deep = ft.segmentsOf('a/b/c/d/e/f.js');
      // detail: open via actions, redraw on rev change
      const rec = col.tiles[0];
      app.detail.open(rec.msg, rec.world, col);
      out.detail = { open: app.detail.isOpen, stats: app.detail.stats(), facing: app.detail.group.rotation.y };
      app.detail.close();
      // debug3d: toggled by ?debug=1, logs lines, follows the camera
      const d = app.debug3d; console.log('[xr-shape] debug line'); await new Promise((r) => setTimeout(r, 300)); d.update(performance.now());
      out.debug = { visible: d.visible, lines: d.lines.length, hasLine: d.lines.some((l) => /debug line/.test(l)), pos: [d.plane.position.x, d.plane.position.y, d.plane.position.z].map((v) => +v.toFixed(2)), cam: [app.camera.position.x, app.camera.position.y, app.camera.position.z].map((v) => +v.toFixed(2)) };
      await window.__ceverything.net.cmd('fixture.control', { action: 'play' });
      return out;
    });
    log(`scene: ${JSON.stringify(scene)}`);
    check(scene.pylons.browser && Math.abs(scene.pylons.browser[0] + 2.5) < 0.01 && Math.abs(scene.pylons.browser[1] - 2.45) < 0.01 && scene.pylons.markersHidden, `browser pylon at (−2.5, 2.45, −1) and placeholders hidden: ${JSON.stringify(scene.pylons)}`);
    check(scene.pylons.self === null && scene.pylons.files && Math.abs(scene.pylons.files[2] + 3.2) < 0.01, 'files pylon at z −3.2; self has no position');
    check(scene.packetFlying && /visionOS/.test(scene.query), `web packet flies and the query sprite shows: ${JSON.stringify({ flying: scene.packetFlying, query: scene.query })}`);
    check(/npm test/.test(scene.terminal), `terminal screen shows the last command: ${scene.terminal}`);
    check(scene.tree.nodes > 0 && scene.tree.nodes <= 40 && scene.treeAfter.diffVisible && scene.treeAfter.touchedFiles >= 1 && scene.node, `file tree built lazily + diff card: ${JSON.stringify(scene.treeAfter)}`);
    check(scene.deep.length === 4 && scene.deep[3] === 'd/e/f.js', `paths collapse to 4 levels: ${JSON.stringify(scene.deep)}`);
    check(scene.detail.open && scene.detail.stats.drawnChars > 0, `detail plane draws text: ${JSON.stringify(scene.detail)}`);
    check(scene.debug.visible && scene.debug.hasLine && Math.abs(scene.debug.pos[1] - (scene.debug.cam[1] - 0.4)) < 0.05, `debug3d visible under ?debug=1, hooks console, sits 0.4 m below the eye line: ${JSON.stringify(scene.debug)}`);

    await sleep(300);
  } catch (err) {
    fail(err.stack || String(err));
  }

  const errs = consoleErrors.filter((t) => !/favicon\.ico/.test(t));
  if (errs.length) fail(`console errors:\n  ${errs.join('\n  ')}`);
  if (pageErrors.length) fail(`page errors:\n  ${pageErrors.join('\n  ')}`);
  if (process.env.SMOKE_VERBOSE) console.log(consoleAll.join('\n'));
  await Promise.race([browser.close(), sleep(10000)]); // a crashed Chromium must not hang the run
  await api.close();
  if (failures.length) { console.error(`[xr-shape] ${failures.length} failure(s)`); process.exit(1); }
  log('PASS');
}

main().catch((err) => { console.error('[xr-shape] crashed', err); process.exit(1); });
