// Pinned detail plane (PROTOCOL.md §1 scene/detail.js; DESIGN.md "Pinch-select a tile"): a 0.6 × 0.45 m canvas plane
// (1024 × 768) opened by select, pinned at reading height on the line viewer→column but never farther than READING
// reach (0.85 m) from the head, 0.38 m toward the viewer's right, yaw following the viewer. 24 px mono on 768 px over
// 0.45 m is ~0.010 m cap height: at 0.85 m that is ~0.67° (≈ 23 px on Vision Pro, ≈ 13 px on Quest 3S), readable from
// the start position without walking — Vision Pro cannot walk closer (immersion limits). Shows the complete text /
// tool args pretty-printed / unified diff with +/− coloring. Stays until the next select, Esc, or a tap on the plane
// itself (its hitbox is on HIT_LAYER with userData.kind 'detail').
// Redraws in place when the message streams (rev changes). `current()` feeds presence.hover so the laptop sees which
// tile the headset person is inspecting.

import * as THREE from 'three';
import { ROLE_COLORS } from '/shared/protocol.js';
import { makeCanvas, makeTexture, sharedPlaneGeometry, font, wrapText, roundRect } from '../text/canvas-text.js';
import { HIT_LAYER } from './column-parts.js';

export const PLANE = Object.freeze({ w: 0.6, h: 0.45, px: 1024, py: 768, reachM: 0.85, minM: 0.4, sideOffset: 0.38, aheadOfColumn: 0.1, maxLines: 38 });
const ROLE_LABEL = { user: 'you', assistant: 'agent', thinking: 'thinking', tool_call: 'tool call', tool_result: 'tool result', system: 'system' };

function timeOf(ts) { if (!Number.isFinite(ts)) return ''; const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; }

/** Body text for a message: full text, pretty tool args, or the diff. Exported for tests. */
export function bodyFor(msg) {
  const t = msg.tool || {};
  if (t.meta?.diff) return { text: t.meta.diff, mono: true, diff: true };
  if (msg.role === 'tool_call') {
    const parts = [];
    if (t.args && typeof t.args === 'object') { try { parts.push(JSON.stringify(t.args, null, 2)); } catch { parts.push(String(t.args)); } }
    else if (typeof t.args === 'string') parts.push(t.args);
    if (t.preview) parts.push(`preview: ${t.preview}`);
    if (msg.text && msg.text !== msg.summary) parts.push(msg.text);
    return { text: parts.join('\n') || msg.summary || '', mono: true, diff: false };
  }
  if (msg.role === 'tool_result') {
    const meta = t.meta || {};
    const tail = [];
    if (Number.isFinite(meta.exitCode)) tail.push(`exit ${meta.exitCode}`);
    if (meta.url) tail.push(meta.url);
    if (meta.path) tail.push(meta.path);
    return { text: `${msg.text || msg.summary || ''}${tail.length ? `\n— ${tail.join(' · ')}` : ''}`, mono: true, diff: false };
  }
  return { text: msg.text || msg.summary || '', mono: false, diff: false };
}

export function createDetail({ scene, camera, renderer, store, flags = {}, room, app } = {}) {
  const { canvas, ctx } = makeCanvas(PLANE.px, PLANE.py);
  const texture = makeTexture(canvas);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const plane = new THREE.Mesh(sharedPlaneGeometry(), material);
  plane.scale.set(PLANE.w, PLANE.h, 1); plane.name = 'detail-plane'; plane.renderOrder = 4; plane.frustumCulled = false;
  const group = new THREE.Group(); group.name = 'detail'; group.visible = false;
  const hitbox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }));
  hitbox.scale.set(PLANE.w + 0.04, PLANE.h + 0.04, 0.05); hitbox.layers.set(HIT_LAYER); hitbox.userData = { kind: 'detail', hit: true }; hitbox.name = 'hit:detail';
  group.add(plane, hitbox);
  scene.add(group);

  const st = { msg: null, rev: -1, column: null, openedAt: 0, drawnChars: 0, distance: 0 };
  const _cam = new THREE.Vector3(); const _col = new THREE.Vector3(); const _f = new THREE.Vector3();

  function viewerCamera() { return renderer?.xr?.isPresenting ? renderer.xr.getCamera() : camera; }

  function draw(msg) {
    const w = PLANE.px; const h = PLANE.py;
    const color = msg.role === 'tool_result' && msg.tool?.ok === false ? ROLE_COLORS.error : (ROLE_COLORS[msg.role] || ROLE_COLORS.system);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(8,12,20,0.95)'; roundRect(ctx, 1, 1, w - 2, h - 2, 22); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 5; roundRect(ctx, 3, 3, w - 6, h - 6, 22); ctx.stroke();
    ctx.fillStyle = color; roundRect(ctx, 6, 14, 12, h - 28, 6); ctx.fill();
    // header
    const session = store?.sessions?.get?.(msg.sessionId);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = font(34, { weight: 700 }); ctx.fillStyle = color;
    let head = ROLE_LABEL[msg.role] || msg.role;
    if (msg.tool?.name) head += ` · ${msg.tool.name}`;
    if (msg.via === 'voice') head += ' · 🎤 voice'; else if (msg.via === 'pipe') head += ` · piped${msg.from ? ' from ' + (store?.sessions?.get?.(msg.from.sessionId)?.title || msg.from.sessionId) : ''}`;
    ctx.fillText(head, 40, 40);
    ctx.textAlign = 'right'; ctx.fillStyle = '#9ca3af'; ctx.font = font(26);
    ctx.fillText(`${session?.title || msg.sessionId} · ${timeOf(msg.ts)}${msg.streaming ? ' · streaming…' : ''}`, w - 28, 40);
    if (msg.tool && (Number.isFinite(msg.tool.durationMs) || msg.tool.ok !== undefined)) {
      ctx.textAlign = 'left'; ctx.fillStyle = msg.tool.ok === false ? '#fca5a5' : '#86efac'; ctx.font = font(24);
      ctx.fillText(`${msg.tool.ok === false ? '✗ failed' : msg.tool.ok === true ? '✓ ok' : ''}${Number.isFinite(msg.tool.durationMs) ? ` · ${(msg.tool.durationMs / 1000).toFixed(1)} s` : ''}${msg.tool.category ? ` · ${msg.tool.category}` : ''}`, 40, 78);
    }
    // body
    const body = bodyFor(msg);
    const f = font(body.mono ? 24 : 28, { mono: body.mono });
    ctx.font = f;
    const maxW = w - 40 - 28; const top = 104; const lineH = body.mono ? 30 : 34;
    const maxLines = Math.min(PLANE.maxLines, Math.floor((h - top - 40) / lineH));
    let lines;
    if (body.diff) lines = body.text.replace(/\r/g, '').split('\n').slice(0, maxLines).map((l) => { let t = l; while (t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -1); return t; });
    else lines = wrapText(body.text, f, maxW, maxLines).lines;
    let drawn = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (body.diff) ctx.fillStyle = l.startsWith('+') && !l.startsWith('+++') ? '#22C55E' : l.startsWith('-') && !l.startsWith('---') ? '#EF4444' : l.startsWith('@@') ? '#38bdf8' : '#9ca3af';
      else ctx.fillStyle = msg.role === 'thinking' ? '#c4b5fd' : '#f3f4f6';
      ctx.textAlign = 'left';
      ctx.fillText(l, 40, top + lineH * (i + 0.5));
      drawn += l.length;
    }
    const total = body.text.length;
    const rest = Math.max(0, total - drawn);
    if (rest > total * 0.02 && rest > 8) { ctx.fillStyle = '#64748b'; ctx.font = font(24); ctx.fillText(`… (+${rest} chars — full text in the laptop transcript)`, 40, h - 24); }
    ctx.textAlign = 'right'; ctx.fillStyle = '#475569'; ctx.font = font(22); ctx.fillText('tap plane / Esc to close', w - 28, h - 24);
    texture.needsUpdate = true;
    st.rev = msg.rev; st.drawnChars = drawn;
  }

  /** Viewer-relative placement: along head→column, at min(column distance − 0.1, 0.85 m) from the head, offset to the right. */
  function place(anchorWorld, column) {
    const cam = viewerCamera(); cam.getWorldPosition(_cam);
    _col.copy(column.group.position);
    _f.set(_col.x - _cam.x, 0, _col.z - _cam.z);
    const dist = _f.length();
    if (dist < 1e-6) _f.set(0, 0, -1); else _f.divideScalar(dist);
    const rx = -_f.z; const rz = _f.x; // viewer's right (horizontal)
    const d = Math.max(PLANE.minM, Math.min(dist - PLANE.aheadOfColumn, PLANE.reachM));
    const rh = column.readingHeight ?? room?.readingHeight ?? 1.3;
    const y = Math.max(rh, Math.min((anchorWorld?.y ?? rh), rh + 0.6)) + 0.1;
    group.position.set(_cam.x + _f.x * d + rx * PLANE.sideOffset, y, _cam.z + _f.z * d + rz * PLANE.sideOffset);
    st.distance = d;
    face();
    group.updateMatrixWorld(true); // the hitbox is raycast against matrixWorld: make a tap right after opening pick the plane, not its old place
  }
  function face() { const cam = viewerCamera(); cam.getWorldPosition(_cam); group.lookAt(_cam.x, group.position.y, _cam.z); }

  function open(message, anchorWorld, column) {
    if (!message || !column) return false;
    st.msg = message; st.column = column; st.openedAt = performance.now();
    place(anchorWorld, column);
    draw(message);
    group.visible = true;
    return true;
  }
  function close() { if (!group.visible) return false; group.visible = false; st.msg = null; st.column = null; return true; }

  function update(now, cam) {
    if (!group.visible || !st.msg) return;
    void cam;
    face();
    if (st.column?.removed) { close(); return; }
    const live = store?.message?.(st.msg.id) || st.msg;
    if (live !== st.msg) st.msg = live;
    if (live.rev !== st.rev) draw(live);
    if (live.hidden) close();
  }

  const offs = [];
  if (store?.on) offs.push(store.on('session.remove', (ev) => { if (st.msg?.sessionId === ev.sessionId) close(); }));

  return {
    group, plane, hitbox, canvas,
    open, close, update,
    get isOpen() { return group.visible; },
    get message() { return st.msg; },
    current() { return st.msg && group.visible ? { sessionId: st.msg.sessionId, messageId: st.msg.id } : null; },
    stats() { return { open: group.visible, messageId: st.msg?.id || null, rev: st.rev, drawnChars: st.drawnChars, distance: st.distance }; },
    dispose() { for (const off of offs) off(); scene.remove(group); texture.dispose(); material.dispose(); hitbox.geometry.dispose(); hitbox.material.dispose(); },
  };
}

export default { createDetail, bodyFor, PLANE };
