// In-room debug console (PROTOCOL.md §1 ui/debug3d.js; DESIGN.md graft "debug3d"): a 1024 × 256 canvas plane that
// follows the camera 1.2 m ahead and 0.4 m below the eye line, showing the last 8 console lines (console.log/warn/error
// are hooked while visible, plus window errors / unhandled rejections) and the live XR input-source index +
// targetRayMode + handedness + profiles of the last select event (input/xr.js calls setInputInfo on every select).
// Toggled by ?debug=1 or the laptop key D (main.js actions.toggleDebug → toggle). Hidden under ?judge=1.

import * as THREE from 'three';
import { makeCanvas, makeTexture, sharedPlaneGeometry, font, roundRect } from '../text/canvas-text.js';

export const LINES = 8;
export const SIZE = Object.freeze({ px: 1024, py: 256, w: 0.8, h: 0.2, ahead: 1.2, below: 0.4 });
export const REDRAW_MS = 200; // ≤ 5 Hz

const LEVEL_COLOR = { log: '#e5e7eb', info: '#e5e7eb', warn: '#fde68a', error: '#fca5a5', xr: '#67e8f9' };

function fmt(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ').replace(/\s+/g, ' ').slice(0, 160);
}

export function createDebug3D({ scene, camera, renderer, flags = {}, app } = {}) {
  const { canvas, ctx } = makeCanvas(SIZE.px, SIZE.py);
  const texture = makeTexture(canvas);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const plane = new THREE.Mesh(sharedPlaneGeometry(), material);
  plane.scale.set(SIZE.w, SIZE.h, 1); plane.renderOrder = 100; plane.frustumCulled = false; plane.visible = false; plane.name = 'debug3d';
  scene.add(plane);

  const st = { visible: false, lines: [], inputInfo: '—', selects: 0, dirty: true, lastDraw: 0, hooked: false, orig: null, lastInputAt: 0 };
  const _p = new THREE.Vector3(); const _f = new THREE.Vector3(); const _q = new THREE.Quaternion(); const _target = new THREE.Vector3();
  let placed = false;

  function push(level, text) {
    st.lines.push({ level, text: String(text), t: Date.now() });
    while (st.lines.length > LINES) st.lines.shift();
    st.dirty = true;
  }

  // ------------------------------------------------------------- console hooks (only while visible)
  const onWindowError = (e) => push('error', `window: ${e?.message || e?.reason?.message || e?.reason || 'error'}`);
  function hook() {
    if (st.hooked) return;
    st.hooked = true;
    st.orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const level of ['log', 'info', 'warn', 'error']) {
      const orig = st.orig[level];
      console[level] = (...args) => { try { push(level, fmt(args)); } catch { /* never break logging */ } return orig.apply(console, args); };
    }
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onWindowError);
  }
  function unhook() {
    if (!st.hooked) return;
    st.hooked = false;
    for (const level of ['log', 'info', 'warn', 'error']) console[level] = st.orig[level];
    window.removeEventListener('error', onWindowError);
    window.removeEventListener('unhandledrejection', onWindowError);
  }

  // ------------------------------------------------------------- drawing
  function draw(now) {
    const w = SIZE.px; const h = SIZE.py;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(2,6,23,0.88)'; roundRect(ctx, 1, 1, w - 2, h - 2, 16); ctx.fill();
    ctx.strokeStyle = 'rgba(103,232,249,0.6)'; ctx.lineWidth = 3; roundRect(ctx, 2, 2, w - 4, h - 4, 16); ctx.stroke();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    // top line: XR input info
    ctx.font = font(24, { weight: 700, mono: true }); ctx.fillStyle = LEVEL_COLOR.xr;
    const age = st.lastInputAt ? ` (${((now - st.lastInputAt) / 1000).toFixed(1)} s ago)` : '';
    ctx.fillText(`XR ${st.selects ? `#${st.selects} ` : ''}${st.inputInfo}${age}`.slice(0, 95), 18, 22);
    // stats on the right
    let stats = '';
    try { const s = app?.stats?.() || {}; stats = `fps ${s.fps ?? '–'} · tiles ${s.tiles ?? '–'} · planes ${(s.summary ?? 0) + (s.full ?? 0)} · calls ${s.calls ?? '–'} · net ${s.net ?? '–'}`; } catch { stats = ''; }
    ctx.textAlign = 'right'; ctx.font = font(20, { mono: true }); ctx.fillStyle = '#94a3b8';
    ctx.fillText(stats, w - 18, 22);
    ctx.textAlign = 'left';
    // console lines
    ctx.font = font(21, { mono: true });
    const lineH = (h - 44) / LINES;
    for (let i = 0; i < st.lines.length; i++) {
      const l = st.lines[i];
      ctx.fillStyle = LEVEL_COLOR[l.level] || LEVEL_COLOR.log;
      const d = new Date(l.t);
      const stamp = `${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} `;
      let text = stamp + l.text;
      while (text.length > 1 && ctx.measureText(text).width > w - 36) text = text.slice(0, -1);
      ctx.fillText(text, 18, 44 + lineH * (i + 0.5));
    }
    texture.needsUpdate = true;
    st.dirty = false; st.lastDraw = now;
  }

  function placeAt(cam, snap) {
    cam.getWorldPosition(_p); cam.getWorldQuaternion(_q);
    _f.set(0, 0, -1).applyQuaternion(_q); _f.y = 0;
    if (_f.lengthSq() < 1e-6) _f.set(0, 0, -1); else _f.normalize();
    _target.copy(_p).addScaledVector(_f, SIZE.ahead); _target.y = _p.y - SIZE.below;
    if (snap || !placed) { plane.position.copy(_target); placed = true; } else plane.position.lerp(_target, 0.15);
    plane.lookAt(_p.x, plane.position.y, _p.z);
  }

  function toggle(on) {
    const want = on === undefined ? !st.visible : Boolean(on);
    if (flags.judge && want) { push('warn', 'debug3d hidden under ?judge=1'); return false; }
    st.visible = want;
    plane.visible = want;
    if (want) { hook(); placed = false; push('log', 'debug3d on (D toggles)'); st.dirty = true; }
    else unhook();
    return st.visible;
  }

  function update(now) {
    if (!st.visible) return;
    const cam = renderer?.xr?.isPresenting ? renderer.xr.getCamera() : camera;
    if (cam) placeAt(cam, false);
    if ((st.dirty || now - st.lastDraw > 1000) && now - st.lastDraw >= REDRAW_MS) draw(now);
  }

  const dbg = {
    plane, canvas,
    toggle, update,
    log(line, level = 'log') { push(level, line); },
    /** Called by input/xr.js on every select/squeeze event: index · targetRayMode · handedness · profiles. */
    setInputInfo(info) { st.inputInfo = String(info || '—'); st.selects++; st.lastInputAt = performance.now(); st.dirty = true; },
    get visible() { return st.visible; },
    get lines() { return st.lines.map((l) => l.text); },
    get inputInfo() { return st.inputInfo; },
    stats() { return { visible: st.visible, lines: st.lines.length, selects: st.selects, hooked: st.hooked }; },
    dispose() { unhook(); scene.remove(plane); texture.dispose(); material.dispose(); },
  };
  return dbg;
}

export default { createDebug3D, LINES, SIZE };
