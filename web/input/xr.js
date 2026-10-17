// XR input layer (PROTOCOL.md §1 input/xr.js, §6 "XR input rules"; DESIGN.md grafts). Session entry through
// navigator.xr.requestSession with { optionalFeatures: ['local-floor','bounded-floor', 'hand-tracking' (Quest or
// ?hands=1 only), 'layers'] } honoring ?mode=vr|ar (default: ar when immersive-ar is supported, else vr); an XRButton
// (three/addons) is created with the same init so Quest Browser's offerSession prompt works too (hidden where WebXR is
// missing). Controllers 0..3 are created BEFORE the session starts and listened to; the XRSession itself is also
// listened to (selectstart/select/selectend/squeezestart/squeezeend) and the ray is resolved from
// inputSource.targetRaySpace via frame.getPose — the targeting truth on Vision Pro (eye gaze at selectstart). Rays are
// plain THREE.Lines, hands small spheres per joint (one InstancedMesh per hand); no XRControllerModelFactory /
// XRHandModelFactory. Head ray → gazed column (200 ms dwell, cosmetic + presence.gazeSessionId) and the mic sphere;
// the tap-vs-drag machine lives in ./xr-gestures.js. Presence (head, hands, gazeSessionId, hover, ray) at 10 Hz.

import * as THREE from 'three';
import { XRButton } from 'three/addons/webxr/XRButton.js';
import { HIT_LAYER, GAZE_LAYER } from '../scene/column-parts.js';
import { TILE } from '../scene/tiles.js';
import { createGestures } from './xr-gestures.js';

export const GAZE_DWELL_MS = 200;
export const PRESENCE_MS = 100;
export const RAY_LENGTH = 2.5;
export const MIC_LOCAL = Object.freeze({ z: 0.25, r: 0.06, hitR: 0.08 });
export const SESSION_EVENTS = Object.freeze(['selectstart', 'select', 'selectend', 'squeezestart', 'squeeze', 'squeezeend']);
const DEDUPE_MS = 40;

/** Device from WebXR support + UA (exported for tests): quest | visionpro | unknown. */
export function detectXRDevice({ ar = false, vr = false, ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') } = {}) {
  if (/OculusBrowser|Quest|Meta Quest|Pico/i.test(ua)) return 'quest';
  if (!ar && vr && /AppleWebKit|Safari/i.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/i.test(ua)) return 'visionpro';
  return 'unknown';
}

/** Session init per PROTOCOL §6: hand-tracking only on Quest or with ?hands=1 (never by default on Vision Pro). */
export function sessionInitFor({ device = 'unknown', hands = false } = {}) {
  const optionalFeatures = ['local-floor', 'bounded-floor'];
  if (hands || device === 'quest') optionalFeatures.push('hand-tracking');
  optionalFeatures.push('layers');
  return { optionalFeatures };
}

const round3 = (v) => Math.round(v * 1000) / 1000;

export function createXRInput({ renderer, scene, camera, store, net, columns, pool, fx, room, presence, actions, flags = {}, device = 'unknown', hud, app } = {}) {
  const xr = {
    sendsPresence: false, isPresenting: false, mode: null, device, supported: { ar: null, vr: null }, button: null, session: null,
    controllers: [], hands: [], gazed: null, ready: null, gestures: null,
  };
  const wantHands = Boolean(flags.hands) || device === 'quest';
  const inv = new THREE.MeshBasicMaterial({ visible: false });
  const _m = new THREE.Matrix4(); const _p = new THREE.Vector3(); const _q = new THREE.Quaternion(); const _d = new THREE.Vector3(); const _o = new THREE.Vector3();
  const raycaster = new THREE.Raycaster(); raycaster.layers.set(HIT_LAYER);
  const gazeCaster = new THREE.Raycaster(); gazeCaster.layers.set(GAZE_LAYER);
  const recent = new Map();          // event type → { inputSource, t } (dedupe controller-level vs session-level)
  const slotOf = new Map();          // inputSource → controller index
  const squeezeKeys = new WeakMap(); // inputSource → key object for squeeze gestures
  const stats = { selects: 0, sessions: 0, presence: 0, controllerEvents: 0, sessionEvents: 0, duplicates: 0 };
  let savedBackground; let lastPresence = 0; let sessionHandlers = null;

  function log(msg, level = 'log') {
    (level === 'warn' ? console.warn : console.log)(`[xr] ${msg}`);
    if (level !== 'log') app?.debug3d?.log?.(`[xr] ${msg}`, level);
  }
  function viewerCamera() { return renderer.xr.isPresenting ? renderer.xr.getCamera() : camera; }
  function viewer() {
    const cam = viewerCamera(); cam.getWorldPosition(_p); cam.getWorldQuaternion(_q);
    _d.set(0, 0, -1).applyQuaternion(_q);
    return { position: _p.clone(), yaw: Math.atan2(-_d.x, -_d.z), forward: _d.clone() };
  }

  // ------------------------------------------------------------------ support probe + device refinement + XRButton
  xr.ready = (async () => {
    if (typeof navigator === 'undefined' || !navigator.xr) { xr.supported = { ar: false, vr: false }; buildButton(); return xr.supported; }
    for (const m of ['ar', 'vr']) { try { xr.supported[m] = Boolean(await navigator.xr.isSessionSupported(`immersive-${m}`)); } catch (err) { xr.supported[m] = false; log(`isSessionSupported(${m}) failed: ${err?.message || err}`, 'warn'); } }
    const refined = detectXRDevice({ ar: xr.supported.ar, vr: xr.supported.vr });
    if (!flags.device && refined !== 'unknown' && refined !== xr.device && (xr.device === 'desktop' || xr.device === 'unknown' || xr.device === 'phone')) {
      log(`device refined ${xr.device} → ${refined} (ar=${xr.supported.ar} vr=${xr.supported.vr})`);
      xr.device = refined; if (app) app.device = refined; pool?.setDevice?.(refined);
    }
    buildButton();
    return xr.supported;
  })();

  function autoMode() { return xr.supported.ar ? 'ar' : 'vr'; }
  function buildButton() {
    if (xr.button) return;
    const supported = Boolean(xr.supported.ar || xr.supported.vr);
    if (flags.mode && flags.mode !== autoMode()) { log(`XRButton skipped: ?mode=${flags.mode} differs from the auto mode ${autoMode()} (ENTER XR uses requestSession directly)`); return; }
    try {
      const extras = sessionInitFor({ device: xr.device, hands: flags.hands }).optionalFeatures.filter((f) => f === 'hand-tracking');
      const el = XRButton.createButton(renderer, { optionalFeatures: extras });
      el.id = 'xr-button'; el.hidden = !supported; el.style.zIndex = '40'; el.style.left = '12px'; el.style.bottom = '12px'; el.style.width = 'auto';
      el.setAttribute('aria-hidden', supported ? 'false' : 'true');
      if (!supported) el.setAttribute('disabled', '');
      document.body.appendChild(el);
      xr.button = el;
    } catch (err) { log(`XRButton failed: ${err?.message || err}`, 'warn'); }
  }

  // ------------------------------------------------------------------ controllers 0..3 (before any session) + rays
  const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  for (let i = 0; i < 4; i++) {
    const c = renderer.xr.getController(i);
    c.name = `controller:${i}`; c.userData.index = i; c.userData.inputSource = null;
    const ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
    ray.scale.z = RAY_LENGTH; ray.visible = false; ray.frustumCulled = false; ray.name = 'ray';
    c.add(ray); c.userData.ray = ray;
    c.addEventListener('connected', (e) => onConnected(i, e.data));
    c.addEventListener('disconnected', (e) => onDisconnected(i, e.data));
    for (const type of SESSION_EVENTS) c.addEventListener(type, (e) => onControllerEvent(i, type, e.data));
    scene.add(c);
    xr.controllers.push(c);
  }
  function onConnected(i, inputSource) {
    const c = xr.controllers[i];
    c.userData.inputSource = inputSource || null;
    if (inputSource) slotOf.set(inputSource, i);
    const mode = inputSource?.targetRayMode || '?';
    c.userData.ray.visible = Boolean(inputSource) && mode !== 'gaze' && mode !== 'screen';
    c.userData.ray.material.color.set(inputSource?.handedness === 'left' ? 0xfbbf24 : 0xffffff);
    log(`controller #${i} connected: ${mode} ${inputSource?.handedness || '-'} hand=${Boolean(inputSource?.hand)} [${(inputSource?.profiles || []).join(',')}]`);
  }
  function onDisconnected(i, inputSource) {
    const c = xr.controllers[i];
    if (inputSource) { slotOf.delete(inputSource); xr.gestures?.cancel(inputSource); const sk = squeezeKeys.get(inputSource); if (sk) xr.gestures?.cancel(sk); }
    c.userData.inputSource = null; c.userData.ray.visible = false;
    log(`controller #${i} disconnected`);
  }

  // ------------------------------------------------------------------ hands (optional): one InstancedMesh of spheres per hand
  const jointGeo = new THREE.SphereGeometry(1, 8, 6);
  if (wantHands) {
    for (let i = 0; i < 2; i++) {
      const group = renderer.xr.getHand(i); group.name = `hand:${i}`;
      const mesh = new THREE.InstancedMesh(jointGeo, new THREE.MeshBasicMaterial({ color: 0xe5e7eb, wireframe: true, transparent: true, opacity: 0.8 }), 25);
      mesh.count = 0; mesh.frustumCulled = false; mesh.visible = false; mesh.name = `hand-joints:${i}`;
      scene.add(group); scene.add(mesh);
      const h = { index: i, group, mesh, inputSource: null, jointList: null };
      group.addEventListener('connected', (e) => { h.inputSource = e.data; h.jointList = null; mesh.visible = Boolean(e.data?.hand); log(`hand #${i} connected (${e.data?.handedness})`); });
      group.addEventListener('disconnected', () => { h.inputSource = null; h.jointList = null; mesh.visible = false; mesh.count = 0; });
      group.addEventListener('pinchstart', (e) => log(`hand pinch start ${e.handedness}`));
      xr.hands.push(h);
    }
  }
  const _s = new THREE.Vector3();
  function updateHands() {
    for (const h of xr.hands) {
      if (!h.inputSource || !h.inputSource.hand || !h.group.visible) { if (h.mesh.count) { h.mesh.count = 0; h.mesh.instanceMatrix.needsUpdate = true; } continue; }
      let n = 0;
      // WebXRController fills `joints` lazily over the first frames; cache the array once all 25 exist (no per-frame Object.values)
      if (!h.jointList || h.jointList.length < 25) h.jointList = Object.values(h.group.joints || {});
      for (const joint of h.jointList) {
        if (!joint.visible || n >= 25) continue;
        const r = Math.max(0.004, Math.min(0.02, joint.jointRadius || 0.008));
        _m.multiplyMatrices(h.group.matrixWorld, joint.matrix).decompose(_p, _q, _s);
        _m.compose(_p, _q, _s.set(r, r, r));
        h.mesh.setMatrixAt(n++, _m);
      }
      h.mesh.count = n; h.mesh.instanceMatrix.needsUpdate = true; h.mesh.visible = n > 0;
    }
  }
  function handWorldPosition(handedness) {
    for (const h of xr.hands) if (h.inputSource?.handedness === handedness && h.mesh.visible) { const j = h.group.joints?.['index-finger-tip'] || h.group.joints?.wrist; if (j && j.visible) { _m.multiplyMatrices(h.group.matrixWorld, j.matrix); return _p.setFromMatrixPosition(_m).clone(); } }
    for (const c of xr.controllers) if (c.userData.inputSource?.handedness === handedness && c.userData.ray.visible) return c.getWorldPosition(new THREE.Vector3());
    return null;
  }

  // ------------------------------------------------------------------ rays
  function rayFromFrame(inputSource, frame, out = { o: new THREE.Vector3(), d: new THREE.Vector3() }) {
    try {
      const ref = renderer.xr.getReferenceSpace();
      const pose = inputSource && frame && ref ? frame.getPose(inputSource.targetRaySpace, ref) : null;
      if (!pose) return null;
      _m.fromArray(pose.transform.matrix);
      out.o.set(0, 0, 0).applyMatrix4(_m);
      out.d.set(0, 0, -1).transformDirection(_m).normalize();
      return out;
    } catch { return null; }
  }
  function rayFromController(inputSource, out = { o: new THREE.Vector3(), d: new THREE.Vector3() }) {
    const i = slotOf.get(inputSource);
    const c = i === undefined ? null : xr.controllers[i];
    if (!c) return null;
    c.getWorldPosition(out.o); c.getWorldQuaternion(_q); out.d.set(0, 0, -1).applyQuaternion(_q).normalize();
    return out;
  }
  function headRay(out = { o: new THREE.Vector3(), d: new THREE.Vector3() }) {
    const cam = viewerCamera(); cam.getWorldPosition(out.o); cam.getWorldQuaternion(_q); out.d.set(0, 0, -1).applyQuaternion(_q).normalize();
    return out;
  }

  // ------------------------------------------------------------------ hit targets
  const beaconGeo = new THREE.SphereGeometry(0.25, 8, 6);
  function ensureBeaconHit(col) {
    if (col.beacon.group.userData.hit) return col.beacon.group.userData.hit;
    const s = new THREE.Mesh(beaconGeo, inv); s.position.y = 2.6; s.layers.set(HIT_LAYER); s.userData = { kind: 'beacon', column: col, hit: true }; s.name = 'hit:beacon';
    col.beacon.group.add(s); col.beacon.group.userData.hit = s;
    // Object3D.add() leaves matrixWorld at identity until the next column.update(); Mesh.raycast uses matrixWorld, so
    // without this the first pick after a column enters waiting_on_you tests a 0.25 m sphere at the world origin
    s.updateMatrixWorld(true);
    return s;
  }
  function hitTargets() {
    const out = [];
    for (const col of columns.values()) {
      if (col.removed) continue;
      out.push(col.hit.base, col.hit.title, col.hit.stack);
      if (col.session?.status === 'waiting_on_you') out.push(ensureBeaconHit(col));
    }
    if (mic.hit.visible) out.push(mic.hit);
    if (app?.detail?.isOpen && app.detail.hitbox) out.push(app.detail.hitbox);
    return out;
  }
  // the gaze cylinder list is rebuilt only when the column set changes (or once a second), not allocated per frame
  const gazeCache = { list: [], size: -1, at: 0 };
  function gazeTargets() {
    const now = performance.now();
    if (gazeCache.size !== columns.size || now - gazeCache.at > 1000) {
      gazeCache.list.length = 0;
      for (const col of columns.values()) if (!col.removed) gazeCache.list.push(col.hit.gaze);
      gazeCache.size = columns.size; gazeCache.at = now;
    }
    return gazeCache.list;
  }

  /** Tile record nearest the hit height (robust during the 300 ms stack shift, unlike index rounding). */
  function tileNear(column, worldPoint) {
    _p.copy(worldPoint); column.group.worldToLocal(_p);
    let best = null; let bd = Infinity;
    for (const r of column.tiles) { const d = Math.abs(r.y - _p.y); if (d < bd) { bd = d; best = r; } }
    return best && bd <= TILE.pitch * 0.6 ? best : null;
  }

  /** Pick along a ray: column parts (tile via stack hitbox), beacon, mic, detail plane, else the floor, else null. */
  function pickRay(ray) {
    raycaster.set(ray.o, ray.d); raycaster.far = 30;
    const hits = raycaster.intersectObjects(hitTargets(), false);
    for (const h of hits) {
      const ud = h.object.userData; if (!ud) continue;
      if (ud.kind === 'stack') { const record = tileNear(ud.column, h.point) || ud.column.tileAt(h.point); if (!record) continue; return { kind: 'tile', column: ud.column, record, point: h.point, distance: h.distance }; }
      if (ud.kind === 'mic') return { kind: 'mic', column: mic.column, point: h.point, distance: h.distance };
      if (ud.kind === 'detail') return { kind: 'detail', column: null, point: h.point, distance: h.distance };
      return { kind: ud.kind, column: ud.column, point: h.point, distance: h.distance };
    }
    if (ray.d.y < -1e-4) { const t = -ray.o.y / ray.d.y; if (t > 0 && t < 30) return { kind: 'floor', column: null, point: ray.o.clone().addScaledVector(ray.d, t), distance: t }; }
    return null;
  }
  function pickGazeColumn(ray) {
    gazeCaster.set(ray.o, ray.d); gazeCaster.far = 30;
    const hits = gazeCaster.intersectObjects(gazeTargets(), false);
    return hits.length ? hits[0].object.userData.column : null;
  }

  // ------------------------------------------------------------------ gestures + haptics
  function haptic(g, intensity = 0.5, ms = 40) {
    try { const act = g?.inputSource?.gamepad?.hapticActuators?.[0]; if (act?.pulse) act.pulse(intensity, ms); } catch { /* optional */ }
  }
  xr.gestures = createGestures({ scene, columns, actions, hud, app, pick: pickRay, pickGazeColumn, viewer, haptic, log: (m) => { if (app?.debug) log(`gesture ${m}`); } });

  function describe(inputSource, idx) {
    const i = idx ?? slotOf.get(inputSource);
    return `#${i === undefined ? '?' : i} ${inputSource?.targetRayMode || '?'} ${inputSource?.handedness || '-'}${inputSource?.hand ? ' hand' : ''} [${(inputSource?.profiles || []).slice(0, 3).join(',')}]`;
  }

  function dispatch(type, inputSource, ray, idx, via) {
    const now = performance.now();
    const r = recent.get(type);
    if (r && r.inputSource === inputSource && now - r.t < DEDUPE_MS) { stats.duplicates++; return; }
    recent.set(type, { inputSource, t: now });
    if (!ray) ray = rayFromController(inputSource) || headRay();
    const info = `${type} ${describe(inputSource, idx)} via ${via}`;
    app?.debug3d?.setInputInfo?.(info);
    if (type !== 'select' && type !== 'squeeze') log(info);
    stats.selects++;
    const left = inputSource?.handedness === 'left';
    switch (type) {
      case 'selectstart': app?.voice?.cancel?.(true); xr.gestures.begin(inputSource, ray, now, { inputSource, index: idx }); break;
      case 'selectend': xr.gestures.end(inputSource, ray, now); break;
      case 'squeezestart': {
        if (!left) break; // right squeeze is intentionally unbound (trigger/pinch does everything on the right)
        let k = squeezeKeys.get(inputSource); if (!k) { k = { squeeze: true, inputSource }; squeezeKeys.set(inputSource, k); }
        app?.voice?.cancel?.(true);
        xr.gestures.begin(k, ray, now, { inputSource, index: idx, talkOnly: true });
        break;
      }
      case 'squeezeend': { const k = squeezeKeys.get(inputSource); if (k) xr.gestures.end(k, ray, now); break; }
      default: break;
    }
  }
  function onSessionEvent(event) {
    stats.sessionEvents++;
    const is = event.inputSource;
    const ray = rayFromFrame(is, event.frame);
    dispatch(event.type, is, ray, slotOf.get(is), ray ? 'session+frame' : 'session');
  }
  function onControllerEvent(i, type, inputSource) {
    stats.controllerEvents++;
    // the session-level listener (authoritative pose) runs in the same dispatch; defer so it wins and this is the fallback
    queueMicrotask(() => dispatch(type, inputSource, rayFromController(inputSource), i, 'controller'));
  }

  // ------------------------------------------------------------------ session lifecycle
  function onSessionStart() {
    const session = renderer.xr.getSession();
    xr.session = session; xr.isPresenting = true; xr.sendsPresence = true; stats.sessions++;
    xr.mode = session.environmentBlendMode && session.environmentBlendMode !== 'opaque' ? 'ar' : 'vr';
    sessionHandlers = { ev: onSessionEvent, isc: onInputSourcesChange, vis: () => log(`visibility ${session.visibilityState}`), end: onSessionEnd };
    for (const t of SESSION_EVENTS) session.addEventListener(t, sessionHandlers.ev);
    session.addEventListener('inputsourceschange', sessionHandlers.isc);
    session.addEventListener('visibilitychange', sessionHandlers.vis);
    if (xr.mode === 'ar') { savedBackground = scene.background; scene.background = null; }
    const landing = document.getElementById('landing'); if (landing) { landing.classList.add('hidden'); setTimeout(() => { landing.hidden = true; }, 400); }
    if (!app?.started) window.__ceverything?.start?.();
    // a session started from the browser's own offer prompt (XRButton offerSession) skipped the ENTER handler: acquire the mic now
    if (app?.voice && !/ok/.test(String(app.voice.micState || ''))) { try { Promise.resolve(app.voice.probe()).catch(() => {}); } catch { /* optional */ } }
    hud?.setFlag?.(`xr ${xr.mode}`, true);
    log(`session started: mode=${xr.mode} blend=${session.environmentBlendMode} inputs=${session.inputSources?.length ?? 0} device=${xr.device} hands=${wantHands}`);
    for (const is of session.inputSources || []) log(`input ${describe(is)}`);
  }
  function onSessionEnd() {
    const session = xr.session;
    if (session && sessionHandlers) { for (const t of SESSION_EVENTS) session.removeEventListener(t, sessionHandlers.ev); session.removeEventListener('inputsourceschange', sessionHandlers.isc); session.removeEventListener('visibilitychange', sessionHandlers.vis); }
    sessionHandlers = null; xr.session = null; xr.isPresenting = false; xr.sendsPresence = false;
    xr.gestures.cancelAll();
    if (xr.mode === 'ar' && savedBackground !== undefined) { scene.background = savedBackground; savedBackground = undefined; }
    setGazed(null);
    for (const c of xr.controllers) { c.userData.ray.visible = false; c.userData.inputSource = null; }
    slotOf.clear(); recent.clear();
    hud?.setFlag?.(`xr ${xr.mode}`, false);
    // handover: the 2D page offers a one-tap re-entry (removing the headset ends the immersive session)
    const landing = document.getElementById('landing'); const btn = document.getElementById('enter-xr');
    if (landing) { landing.hidden = false; landing.classList.remove('hidden'); }
    if (btn) { btn.hidden = false; btn.textContent = 'RE-ENTER XR'; }
    hud?.toast?.('XR session ended — tap RE-ENTER XR to continue', 'warn');
    log('session ended');
    xr.mode = null;
  }
  function onInputSourcesChange(e) {
    for (const is of e.removed || []) { xr.gestures.cancel(is); const sk = squeezeKeys.get(is); if (sk) xr.gestures.cancel(sk); }
    log(`inputsourceschange +${(e.added || []).length} −${(e.removed || []).length}: ${[...(e.session?.inputSources || [])].map((is) => describe(is)).join(' | ') || 'none'}`);
  }
  renderer.xr.addEventListener('sessionstart', onSessionStart);
  renderer.xr.addEventListener('sessionend', onSessionEnd);

  async function enter(hint) {
    if (typeof navigator === 'undefined' || !navigator.xr) throw new Error('WebXR is not available here (needs HTTPS and a headset browser)');
    await xr.ready;
    let mode = flags.mode || (hint === 'ar' || hint === 'vr' ? hint : null) || autoMode();
    if (mode === 'ar' && !xr.supported.ar) mode = 'vr';
    if (mode === 'vr' && !xr.supported.vr && xr.supported.ar) mode = 'ar';
    if (!xr.supported[mode]) throw new Error(`immersive-${mode} is not supported on this device`);
    const init = sessionInitFor({ device: xr.device, hands: flags.hands });
    log(`requesting immersive-${mode} with ${JSON.stringify(init.optionalFeatures)}`);
    const session = await navigator.xr.requestSession(`immersive-${mode}`, init);
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
    return session;
  }
  async function exit() { const s = xr.session || renderer.xr.getSession(); if (s) await s.end(); }

  // ------------------------------------------------------------------ mic sphere (gazed column; scales with the mic RMS)
  const mic = (() => {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(MIC_LOCAL.r, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.9 }));
    const hit = new THREE.Mesh(new THREE.SphereGeometry(MIC_LOCAL.hitR, 8, 6), inv);
    hit.layers.set(HIT_LAYER); hit.userData = { kind: 'mic', hit: true }; hit.name = 'hit:mic';
    sphere.visible = false; hit.visible = false; sphere.name = 'mic-sphere'; sphere.frustumCulled = false;
    scene.add(sphere, hit);
    return { sphere, hit, column: null };
  })();
  function updateMic(now) {
    const voice = app?.voice;
    const talkingCol = voice?.talking && voice.target ? columns.get(voice.target) : null;
    const col = talkingCol || xr.gazed;
    mic.column = col && !col.removed ? col : null;
    const show = Boolean(mic.column) && xr.isPresenting;
    mic.sphere.visible = show; mic.hit.visible = show;
    if (!show) return;
    _p.set(0, mic.column.readingHeight ?? 1.3, MIC_LOCAL.z).applyMatrix4(mic.column.group.matrixWorld);
    mic.sphere.position.copy(_p); mic.hit.position.copy(_p);
    const talking = Boolean(voice?.talking);
    const engine = voice?.engine || 'none';
    mic.sphere.material.color.set(engine === 'none' ? 0x6b7280 : talking ? 0xef4444 : 0xffffff);
    const rms = talking ? Math.min(1, (voice?.rms || 0) * 6) : 0;
    mic.sphere.scale.setScalar(1 + rms * 2 + (talking ? 0.1 * Math.sin(now * 0.02) : 0));
  }

  // ------------------------------------------------------------------ head gaze (200 ms dwell; cosmetic + presence)
  const gaze = { candidate: null, since: 0 };
  const _headRay = { o: new THREE.Vector3(), d: new THREE.Vector3() };
  function setGazed(col) {
    if (xr.gazed === col) return;
    xr.gazed?.setGazed(false);
    xr.gazed = col || null;
    xr.gazed?.setGazed(true);
  }
  function updateGaze(now) {
    const cand = pickGazeColumn(headRay(_headRay));
    if (cand !== gaze.candidate) { gaze.candidate = cand; gaze.since = now; }
    else if (now - gaze.since >= GAZE_DWELL_MS) setGazed(cand);
  }

  // ------------------------------------------------------------------ presence (10 Hz while presenting)
  function sendPresence(now) {
    if (now - lastPresence < PRESENCE_MS || !net?.open) return;
    lastPresence = now;
    const hands = [handWorldPosition('left'), handWorldPosition('right')].map((v) => (v ? { p: [round3(v.x), round3(v.y), round3(v.z)] } : null));
    let ray = null;
    for (const c of xr.controllers) if (c.userData.inputSource && c.userData.inputSource.handedness !== 'left' && c.userData.ray.visible) { c.getWorldPosition(_o); c.getWorldQuaternion(_q); _d.set(0, 0, -1).applyQuaternion(_q); ray = { o: [round3(_o.x), round3(_o.y), round3(_o.z)], d: [round3(_d.x), round3(_d.y), round3(_d.z)] }; break; }
    // head pose last: handWorldPosition / the ray loop reuse the _p/_q scratch vectors
    const cam = viewerCamera(); cam.getWorldPosition(_p); cam.getWorldQuaternion(_q);
    const hover = app?.detail?.current?.() || xr.gestures.hoverInfo() || null;
    stats.presence++;
    net.sendPresence({ head: { p: [round3(_p.x), round3(_p.y), round3(_p.z)], q: [round3(_q.x), round3(_q.y), round3(_q.z), round3(_q.w)] }, hands, gazeSessionId: xr.gazed?.id || null, hover, ray });
  }

  // ------------------------------------------------------------------ per frame
  const _ray = { o: new THREE.Vector3(), d: new THREE.Vector3() };
  function update(time, frame, dt) {
    void dt;
    if (!renderer.xr.isPresenting) { if (mic.sphere.visible) { mic.sphere.visible = false; mic.hit.visible = false; } return; }
    const now = performance.now();
    // active gestures follow their input source's live ray (frame pose first, controller pose as fallback)
    for (const [key, g] of xr.gestures.active) {
      const is = g.inputSource;
      const ray = (is && rayFromFrame(is, frame, _ray)) || (is && rayFromController(is, _ray)) || null;
      if (ray) xr.gestures.move(key, ray, now);
    }
    for (const c of xr.controllers) if (c.userData.ray.visible) c.userData.ray.material.color.set(xr.gestures.active.has(c.userData.inputSource) ? 0x22d3ee : c.userData.inputSource?.handedness === 'left' ? 0xfbbf24 : 0xffffff);
    updateHands();
    updateGaze(now);
    updateMic(now);
    xr.gestures.update(now);
    sendPresence(now);
  }

  /** Test / emulator hook: feed a select or squeeze event without an XRSession (same dedupe + gesture path). */
  function inject(type, inputSource, ray) { if (!SESSION_EVENTS.includes(type)) throw new Error(`inject: unknown event ${type}`); dispatch(type, inputSource, ray || null, slotOf.get(inputSource), 'inject'); }

  Object.assign(xr, {
    enter, exit, update, pickRay, pickGazeColumn, headRay, viewer, log, inject,
    rayFromFrame, rayFromController, sessionInit: () => sessionInitFor({ device: xr.device, hands: flags.hands }),
    mic, wantHands,
    stats() { return { ...stats, presenting: xr.isPresenting, mode: xr.mode, device: xr.device, supported: xr.supported, controllers: xr.controllers.filter((c) => c.userData.inputSource).length, hands: xr.hands.filter((h) => h.inputSource).length, gazed: xr.gazed?.id || null, gestures: xr.gestures.stats() }; },
    dispose() {
      renderer.xr.removeEventListener('sessionstart', onSessionStart); renderer.xr.removeEventListener('sessionend', onSessionEnd);
      xr.gestures.dispose(); for (const c of xr.controllers) scene.remove(c); for (const h of xr.hands) { scene.remove(h.group); scene.remove(h.mesh); }
      scene.remove(mic.sphere, mic.hit); xr.button?.remove();
    },
  });
  return xr;
}

export default { createXRInput, detectXRDevice, sessionInitFor, GAZE_DWELL_MS, PRESENCE_MS };
