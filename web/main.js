// Boot (PROTOCOL.md §1 main.js): query flags, device detection, renderer (xr.enabled), scene, store + net, columns
// wiring, optional XR-layer modules through one try/catch loader, animation loop, presence tick, landing overlay,
// window.__ceverything debug handle. Runs with or without the XR layer files and degrades to a 'no-webgl' message.

import * as THREE from 'three';
import { createStore } from './store.js';
import { createNet } from './net.js';
import { createRoom } from './scene/room.js';
import { createTilePool } from './scene/tiles.js';
import { Column } from './scene/column.js';
import { createFX } from './scene/fx.js';
import { createPresence } from './scene/presence.js';
import { createDesktopInput } from './input/desktop.js';
import { createHUD } from './ui/hud.js';
import { drawQR } from './text/qr.js';

// ---------------------------------------------------------------------------- flags + device
const q = new URLSearchParams(location.search);
export const flags = {
  scale: Math.max(0.3, Math.min(2, Number(q.get('scale')) || 1)),
  judge: q.get('judge') === '1', debug: q.get('debug') === '1',
  mode: q.get('mode') === 'ar' ? 'ar' : q.get('mode') === 'vr' ? 'vr' : null,
  hands: q.get('hands') === '1', name: (q.get('name') || '').slice(0, 40), device: q.get('device') || null,
};

export function detectDevice(ua = navigator.userAgent) {
  if (flags.device) return flags.device;
  if (/OculusBrowser|Quest|Meta Quest|Pico/i.test(ua)) return 'quest';
  if (navigator.xr && /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) return 'visionpro';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'phone';
  return 'desktop';
}

/** Optional XR-layer modules: a missing/broken file never breaks the app. Stubs export STUB = true. */
async function loadOptional(path) {
  try { const m = await import(path); return m && !m.STUB ? m : null; } catch (err) { console.warn(`[main] optional module ${path} not loaded:`, err?.message || err); return null; }
}

const device = detectDevice();
const store = createStore();
const net = createNet({ store, device, name: flags.name });
const columns = new Map();
const app = { store, net, columns, device, flags, focusedId: null, selected: null, renderer: null, scene: null, camera: null, started: false, noWebGL: false, debug: flags.debug };
window.__ceverything = { store, net, columns, flags, app, scene: null, stats: () => app.stats?.() || {} };

// ---------------------------------------------------------------------------- landing overlay
const $ = (id) => document.getElementById(id);
const landing = $('landing');
// bind "Open on laptop" synchronously: the optional XR-layer modules below load asynchronously and a click must not race them
$('enter-desktop')?.addEventListener('click', () => start());
function setBadge(id, text, cls) { const e = $(id); if (!e) return; e.textContent = text; e.className = `badge ${cls || ''}`; }
net.on('status', (s) => { setBadge('badge-conn', s === 'open' ? 'connected' : s, s === 'open' ? 'ok' : s === 'reconnecting' ? 'bad' : 'warn'); room?.setReconnecting(s === 'reconnecting'); });
try { drawQR($('qr'), location.href); } catch (err) { console.warn('[main] QR failed', err); }
if ($('landing-url')) $('landing-url').textContent = location.href;

// ---------------------------------------------------------------------------- renderer + scene
let renderer = null; let scene = null; let camera = null; let room = null; let pool = null; let fx = null; let presence = null; let desktop = null; let hud = null;
let mods = { xr: null, voice: null, pylons: null, filetree: null, detail: null, debug3d: null };
let xr = null; let voice = null; let pylons = null; let filetree = null; let detail = null; let debug3d = null;

try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;
  renderer.xr.setFramebufferScaleFactor(0.9);
  renderer.domElement.id = 'gl';
  document.body.prepend(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 80);
  camera.position.set(0, 1.6, 0.6);
  scene.add(camera);
  app.renderer = renderer; app.scene = scene; app.camera = camera; window.__ceverything.scene = scene;
  window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });
} catch (err) {
  console.warn('[main] WebGL unavailable — running without the 3D room:', err?.message || err);
  app.noWebGL = true;
  document.body.classList.add('no-webgl');
  const msg = $('landing-nogl'); if (msg) { msg.hidden = false; msg.textContent = 'WebGL could not start in this browser; the room is unavailable. The session list and transcript still work.'; }
}

// ---------------------------------------------------------------------------- actions (shared by desktop input, HUD, XR layer)
const actions = {
  focusedId: () => app.focusedId,
  selectedTile: () => app.selected,
  focusSession(id) {
    if (app.focusedId === id) return;
    columns.get(app.focusedId)?.setFocused(false);
    app.focusedId = store.sessions.has(id) ? id : null;
    columns.get(app.focusedId)?.setFocused(true);
    hud?.setFocused(app.focusedId);
  },
  selectTile(record) {
    app.selected = record || null;
    pool?.setOutline('select', record);
    hud?.setSelected(record ? record.msg.id : null);
    if (record) { actions.focusSession(record.column.id); detail?.open?.(record.msg, record.world, record.column); } else detail?.close?.();
  },
  selectMessage(sessionId, messageId) { const col = columns.get(sessionId); const r = col?.tileRecord(messageId); if (r) actions.selectTile(r); else hud?.setSelected(messageId); },
  closeDetail() { detail?.close?.(); },
  send(sessionId, text, via = 'keyboard') { return net.cmd('send', { sessionId, text, via }).catch((err) => hud?.toast(`send failed: ${err.message}`, 'bad')); },
  pipe(fromSessionId, fromMessageId, toSessionId) { return net.cmd('pipe', { fromSessionId, fromMessageId, toSessionId }).then(() => hud?.toast('piped', 'ok')).catch((err) => hud?.toast(`pipe failed: ${err.message}`, 'bad')); },
  fork(sessionId, { x, z } = {}) { const f = { sessionId }; if (Number.isFinite(x) && Number.isFinite(z)) { f.x = x; f.z = z; } return net.cmd('fork', f).then(() => hud?.toast('forked', 'ok')).catch((err) => hud?.toast(`fork failed: ${err.message}`, 'bad')); },
  move(sessionId, placement, { final = true } = {}) { if (!final && !net.open) return; return net.cmd('layout.move', { sessionId, x: placement.x, z: placement.z, rot: placement.rot }).catch((err) => { if (final) hud?.toast(`move failed: ${err.message}`, 'bad'); }); },
  approve(sessionId, requestId, allow) { const f = { sessionId, allow: Boolean(allow) }; if (requestId) f.requestId = requestId; return net.cmd('approve', f).then(() => hud?.toast(allow ? 'approved' : 'denied', allow ? 'ok' : 'warn')).catch((err) => hud?.toast(`approve failed: ${err.message}`, 'bad')); },
  interrupt(sessionId) { return net.cmd('interrupt', { sessionId }).then(() => hud?.toast('interrupted', 'ok')).catch((err) => hud?.toast(`interrupt: ${err.message}`, 'warn')); },
  newSession(title) { const f = {}; if (title) f.title = title; return net.cmd('new', f).then((r) => { if (r?.sessionId) actions.focusSession(r.sessionId); hud?.toast('new session', 'ok'); }).catch((err) => hud?.toast(`new: ${err.message}`, 'bad')); },
  fixture(action, value) { const f = { action }; if (value !== undefined) f.value = value; return net.cmd('fixture.control', f).catch((err) => hud?.toast(`${action}: ${err.message}`, 'bad')); },
  cue(name, sessionId) { const f = { action: 'cue', value: name }; if (sessionId) f.sessionId = sessionId; return net.cmd('fixture.control', f).then(() => hud?.toast(`cue: ${name}`, 'ok')).catch((err) => hud?.toast(`cue failed: ${err.message}`, 'bad')); },
  reset() { for (const c of columns.values()) { c.scroll = 0; c.unsummon(); } return net.cmd('fixture.control', { action: 'reset' }).then(() => hud?.toast('demo reset', 'ok')).catch((err) => hud?.toast(`reset: ${err.message}`, 'bad')); },
  recenter(headY) { const h = room?.recenter(headY); hud?.toast(`reading height ${h?.toFixed(2)} m`, 'ok'); },
  toggleDebug() { app.debug = !app.debug; hud?.setFlag('debug', app.debug); debug3d?.toggle?.(app.debug); },
  toggleHelp() { hud?.toggleHelp(); },
  togglePanels() { hud?.togglePanels(); },
  pushToTalk(on, sessionId) {
    if (!voice) { if (on) hud?.toast('voice layer not built yet — type instead', 'warn'); return; }
    if (on) voice.start?.(sessionId || app.focusedId); else voice.stop?.();
  },
  pipeMode(on) { hud?.setFlag('pipe mode', on); },
  topDown(on) { hud?.setFlag('top-down', on); },
  spectator(on) { hud?.setFlag('spectator', on); },
  headsetPose: () => presence?.headsetPose() || null,
  viewer() { return { position: camera?.position || new THREE.Vector3(), yaw: desktop?.viewerYaw() || 0 }; },
};

// ---------------------------------------------------------------------------- columns ↔ store wiring
function ensureColumn(id) {
  if (!scene) return null;
  let col = columns.get(id);
  const s = store.sessions.get(id);
  if (!s) return null;
  if (!col) {
    col = new Column({ session: s, placement: store.placement(id), store, pool, fx, scale: flags.scale, readingHeight: room.readingHeight });
    scene.add(col.group);
    columns.set(id, col);
    if (id === app.focusedId) col.setFocused(true);
  }
  return col;
}

/**
 * Snapshot resync (first join or a reconnect whose lastSeq fell out of the ring): every Column is rebuilt from the
 * store. In-flight gestures, outlines and the detail plane would otherwise keep pointing at disposed columns, and the
 * viewer's local summon/scroll state would snap back, so those are cancelled / carried over by session id.
 */
function rebuildColumns() {
  xr?.gestures?.cancelAll?.();
  actions.selectTile(null);
  pool?.setOutline('hover', null);
  const view = new Map();
  for (const col of columns.values()) { view.set(col.id, { summoned: col.summoned, summonPose: col.summonPose, scroll: col.scroll }); col.dispose(); }
  columns.clear();
  for (const id of store.order) { const col = ensureColumn(id); const v = view.get(id); if (col && v && (v.summoned || v.scroll > 0)) col.restoreView(v); }
  refreshLineage();
  refreshPylons();
  if (!app.focusedId || !store.sessions.has(app.focusedId)) actions.focusSession(store.order[0] || null);
  pool?.forceLod?.();
}

function refreshLineage() {
  if (!fx) return;
  const keep = new Set();
  const link = (from, to) => { const a = columns.get(from); const b = columns.get(to); if (!a || !b) return; keep.add(to); fx.setLineage(to, a.basePosition(), b.basePosition(), 0x9ca3af); };
  for (const l of store.lineage) link(l.fromSessionId, l.newSessionId);
  for (const s of store.sessions.values()) if (s.parentId && store.sessions.has(s.parentId)) link(s.parentId, s.id);
  for (const col of columns.values()) if (!keep.has(col.id)) fx.removeLineage(col.id);
}

function pylonPosition(kind) {
  const p = store.pylons.find((x) => x.kind === kind);
  if (pylons?.positionOf) { const v = pylons.positionOf(kind); if (v) return v; }
  if (!p) return null;
  return new THREE.Vector3(p.x * flags.scale, kind === 'browser' ? 2.45 : kind === 'terminal' ? 1.4 : 0.4, p.z * flags.scale);
}
function refreshPylons() { room?.setPylonMarkers(store.pylons, flags.scale, !pylons); pylons?.setPylons?.(store.pylons); }

const toolColor = { web: '#F59E0B', coding: '#22C55E', files: '#14B8A6' };
function onToolStart(ev) {
  const col = columns.get(ev.sessionId); if (!col) return;
  col.setSession(store.sessions.get(ev.sessionId));
  const from = col.tileRecord(ev.messageId)?.world?.clone() || col.worldOf();
  if (pylons?.onToolStart) { pylons.onToolStart(ev, from, col); return; }
  const target = ev.target && ev.target !== 'self' ? pylonPosition(ev.target) : null;
  if (target) fx.flyPacket({ from, to: target, color: toolColor[ev.category] || '#F59E0B' });
  else fx.flash(col.base.material, '#F59E0B', 300);
}
function onToolComplete(ev) {
  const col = columns.get(ev.sessionId); if (!col) return;
  col.setSession(store.sessions.get(ev.sessionId));
  if (ev.quiet) return; // optional field: a completion re-targeted onto the polled tile (live mode) — its packet already flew
  const to = col.tileRecord(ev.messageId)?.world?.clone() || col.worldOf();
  const msg = store.message(ev.messageId);
  if (pylons?.onToolComplete) pylons.onToolComplete(ev, to, col);
  else { const from = msg?.tool?.target && msg.tool.target !== 'self' ? pylonPosition(msg.tool.target) : null; if (from) fx.flyPacket({ from, to, color: '#22D3EE' }); }
  if (ev.meta?.diff || ev.meta?.path) filetree?.onToolComplete?.(ev, msg);
}

store.on('snapshot', () => { if (scene) rebuildColumns(); room?.setLabel(store.sourceInfo.label); });
store.on('source', (info) => room?.setLabel(info.label));
store.on('session.created', (s) => { ensureColumn(s.id); if (!app.focusedId) actions.focusSession(s.id); });
store.on('session.upsert', (ev) => { const col = ensureColumn(ev.sessionId); col?.setSession(store.sessions.get(ev.sessionId)); if (col) col.setPlacement(store.placement(ev.sessionId), true); refreshLineage(); });
store.on('session.status', (ev) => { const col = columns.get(ev.sessionId); if (col) col.setSession(store.sessions.get(ev.sessionId)); if (ev.status === 'waiting_on_you' && !flags.judge) hud?.toast(`${store.sessions.get(ev.sessionId)?.title || ev.sessionId} needs you`, 'warn'); });
store.on('session.remove', (ev) => { const col = columns.get(ev.sessionId); if (col) { columns.delete(ev.sessionId); col.fadeOut(); fx?.removeLineage(ev.sessionId); } if (app.focusedId === ev.sessionId) actions.focusSession(store.order[0] || null); });
store.on('message.add', (ev) => {
  if (ev.duplicate) { if (ev.unhidden) columns.get(ev.sessionId)?.addMessage(store.message(ev.message.id) || ev.message); return; } // a re-added hidden tile comes back
  const col = ensureColumn(ev.sessionId); if (col) { col.addMessage(ev.message); col.setSession(store.sessions.get(ev.sessionId)); }
});
store.on('message.complete', (ev) => { if (ev.hidden) columns.get(ev.sessionId)?.removeMessage(ev.messageId); });
store.on('tool.start', onToolStart);
store.on('tool.complete', onToolComplete);
store.on('layout.column', (ev) => { const col = ensureColumn(ev.placement?.sessionId || ev.sessionId); if (!col) return; if (ev.by === store.clientId && col.dragging) return; col.setPlacement(store.placement(col.id), true); refreshLineage(); });
store.on('fork', (ev) => { refreshLineage(); const a = columns.get(ev.fromSessionId); const b = columns.get(ev.newSessionId); if (a && b) fx.forkGhost({ from: a.basePosition(), to: b.basePosition() }); });
store.on('pipe', (ev) => { const a = columns.get(ev.fromSessionId); const b = columns.get(ev.toSessionId); if (!a || !b) return; const from = a.tileRecord(ev.fromMessageId)?.world?.clone() || a.worldOf(); fx.pipeArc({ from, to: b.basePosition() }); });
store.on('pylons', refreshPylons);

// ---------------------------------------------------------------------------- scene modules
if (scene) {
  room = createRoom({ scene, scale: flags.scale, ar: flags.mode === 'ar' });
  pool = createTilePool({ scene, device, scale: flags.scale });
  fx = createFX(scene);
  presence = createPresence({ scene, store, resolveTile: (sid, mid) => { const col = columns.get(sid); const r = mid ? col?.tileRecord(mid) : null; return r ? { world: r.world, quaternion: col.group.quaternion } : null; } });
  room.onReadingHeight((h) => { for (const c of columns.values()) c.setReadingHeight(h); });
  desktop = createDesktopInput({ renderer, camera, scene, store, net, columns, pool, fx, room, actions, flags });
  app.room = room; app.pool = pool; app.fx = fx; app.presence = presence; app.desktop = desktop;
}
hud = createHUD({ store, net, actions, flags });
app.hud = hud;
hud.setVoice(store.voice?.engine || '—');
store.on('hello', () => hud.setVoice(voice?.engine || store.voice?.engine || 'none'));

// optional XR-layer modules (one loader; the app runs without them)
(async () => {
  mods = {
    xr: await loadOptional('./input/xr.js'), voice: await loadOptional('./input/voice.js'), pylons: await loadOptional('./scene/pylons.js'),
    filetree: await loadOptional('./scene/filetree.js'), detail: await loadOptional('./scene/detail.js'), debug3d: await loadOptional('./ui/debug3d.js'),
  };
  const ctx = { renderer, scene, camera, store, net, columns, pool, fx, room, presence, actions, flags, device, hud, app };
  try { if (scene && mods.pylons?.createPylons) { pylons = mods.pylons.createPylons(ctx); app.pylons = pylons; refreshPylons(); } } catch (err) { console.warn('[main] pylons failed', err); }
  try { if (scene && mods.filetree?.createFileTree) { filetree = mods.filetree.createFileTree(ctx); app.filetree = filetree; } } catch (err) { console.warn('[main] filetree failed', err); }
  try { if (scene && mods.detail?.createDetail) { detail = mods.detail.createDetail(ctx); app.detail = detail; } } catch (err) { console.warn('[main] detail failed', err); }
  try { if (scene && mods.debug3d?.createDebug3D) { debug3d = mods.debug3d.createDebug3D(ctx); app.debug3d = debug3d; if (app.debug) debug3d.toggle?.(true); } } catch (err) { console.warn('[main] debug3d failed', err); }
  try { if (mods.voice?.createVoice) { voice = mods.voice.createVoice(ctx); app.voice = voice; hud.setVoice(voice.engine || store.voice?.engine || 'none'); } } catch (err) { console.warn('[main] voice failed', err); }
  try { if (scene && mods.xr?.createXRInput) { xr = mods.xr.createXRInput(ctx); app.xr = xr; } } catch (err) { console.warn('[main] xr failed', err); }
  await setupLanding();
})();

async function setupLanding() {
  const enterXR = $('enter-xr');
  let xrOk = false;
  try { if (navigator.xr && renderer) xrOk = (await navigator.xr.isSessionSupported('immersive-vr')) || (await navigator.xr.isSessionSupported('immersive-ar')); } catch { xrOk = false; }
  if (enterXR) {
    enterXR.hidden = !xrOk;
    // The mic must be requested on the 2D page before XR (PROTOCOL §6), inside a user gesture. Safari (Vision Pro) keeps
    // that activation alive for only ~1 s across awaits and re-prompts on every page load, so there the FIRST tap is an
    // explicit mic step (AudioContext created + resumed synchronously, getUserMedia started, no requestSession) and the
    // SECOND tap enters XR with the stream already live. Chromium (Quest Browser) keeps the activation long enough for
    // one bounded probe + requestSession in a single tap; when the stream is already live, enter first and probe in parallel.
    const safariLike = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|OculusBrowser|Firefox|FxiOS/.test(navigator.userAgent);
    const micStepPending = () => Boolean(voice && safariLike && voice.needsMicGesture?.());
    const micBadge = () => setBadge('badge-mic', voice?.micState || 'mic: n/a', voice?.micState?.includes('ok') ? 'ok' : 'warn');
    const relabel = () => { if (!xr?.isPresenting) enterXR.textContent = micStepPending() ? 'ALLOW MIC' : 'ENTER XR'; };
    enterXR.addEventListener('click', async () => {
      if (!xr) { hud.toast('XR layer not built yet (web/input/xr.js) — open on the laptop instead', 'warn'); return; }
      enterXR.disabled = true;
      if (micStepPending()) {
        voice.prime(); // synchronous: AudioContext + resume() + getUserMedia kick-off inside this click
        enterXR.textContent = 'ALLOWING MIC…';
        try { await voice.probe(); } catch { /* mic optional */ }
        micBadge();
        enterXR.disabled = false; enterXR.textContent = 'ENTER XR';
        hud.toast(voice.micLive?.() ? 'mic ready — tap ENTER XR' : `${voice.micState} — tap ENTER XR (voice via laptop)`, voice.micLive?.() ? 'ok' : 'warn');
        return;
      }
      enterXR.textContent = 'ENTERING…';
      const live = Boolean(voice?.micLive?.());
      if (voice && !live) {
        voice.prime?.();
        try { await Promise.race([voice.probe(), new Promise((r) => setTimeout(r, 3500))]); } catch { /* mic optional */ } // Chromium: bounded
      }
      micBadge();
      try {
        await xr.enter(flags.mode || (device === 'quest' ? 'ar' : 'vr'));
        enterXR.textContent = 'RE-ENTER XR'; start();
        if (voice && live) Promise.resolve(voice.probe?.()).then(micBadge).catch(() => {}); // stream alive → graph warm-up in parallel
      } catch (err) { console.warn('[main] enter XR failed', err); hud.toast(`enter XR failed: ${err.message} — tap ENTER again`, 'bad'); enterXR.textContent = 'ENTER XR (tap again)'; }
      enterXR.disabled = false;
    });
    relabel();
  }
  if (!xrOk) document.body.classList.add('desktop-only');
  setBadge('badge-mic', voice ? (voice.micState || 'mic: ready on enter') : 'mic: voice layer missing', voice ? 'ok' : 'warn');
}

function start() {
  if (app.started) return;
  app.started = true;
  landing?.classList.add('hidden');
  setTimeout(() => { if (landing) landing.hidden = true; }, 400);
  document.body.classList.add('started');
  hud.hide(false);
  if (!app.focusedId && store.order.length) actions.focusSession(store.order[0]);
}
window.__ceverything.start = start;

// ---------------------------------------------------------------------------- loop
const clock = { last: performance.now(), fps: 60, frames: 0, presenceAt: 0, statsAt: 0 };
const head = new THREE.Vector3();
const frameErrors = new Set();
app.stats = () => ({ fps: Math.round(clock.fps), columns: columns.size, ...(pool ? { tiles: pool.stats().tiles, bars: pool.stats().bars, summary: pool.stats().summary, full: pool.stats().full, redraws: pool.stats().redraws } : { tiles: store.tileCount() }), calls: renderer?.info.render.calls ?? 0, tris: renderer?.info.render.triangles ?? 0, seq: store.seq, net: net.status, presence: store.presence.size });

function frame(time, xrFrame) {
  try { frameBody(time, xrFrame); } catch (err) {
    // one bad frame must not stop the room; report each distinct error once (the smoke test treats it as a failure)
    const key = String(err?.stack || err).slice(0, 200);
    if (!frameErrors.has(key)) { frameErrors.add(key); console.error('[main] frame error', err); }
  }
}

function frameBody(time, xrFrame) {
  const now = performance.now();
  const dt = Math.min(0.1, (now - clock.last) / 1000); clock.last = now;
  clock.fps += (1 / Math.max(dt, 1e-3) - clock.fps) * 0.05;
  clock.frames++;
  const presenting = renderer.xr.isPresenting;
  if (!presenting) desktop.update(dt);
  const cam = presenting ? renderer.xr.getCamera() : camera;
  cam.getWorldPosition(head);
  for (const col of columns.values()) col.update(now);
  pool.update(now, head);
  fx.update(now);
  presence.update(now, dt);
  room.update(now);
  xr?.update?.(time, xrFrame, dt);
  pylons?.update?.(now, dt); filetree?.update?.(now, dt); detail?.update?.(now, cam); debug3d?.update?.(now); voice?.update?.(now);
  if (now - clock.presenceAt > 100 && net.open && !(xr && presenting && xr.sendsPresence)) {
    clock.presenceAt = now;
    const hp = desktop.head();
    net.sendPresence({ head: { p: hp.p.map((v) => +v.toFixed(3)), q: hp.q.map((v) => +v.toFixed(4)) }, hover: desktop.hoverInfo(), gazeSessionId: app.focusedId });
  }
  renderer.render(scene, camera);
  if (now - clock.statsAt > 500) { clock.statsAt = now; hud.setStats(app.stats()); }
}

if (renderer) renderer.setAnimationLoop(frame);
else setInterval(() => hud.setStats(app.stats()), 1000);

net.connect();
console.log(`[cEverything] device=${device} scale=${flags.scale} judge=${flags.judge} debug=${flags.debug} mode=${flags.mode || 'auto'}`);
