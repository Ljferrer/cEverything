// Pylons (PROTOCOL.md §1 scene/pylons.js, §5; DESIGN.md "PYLONS"): three fixed landmarks shared by every session.
// browser (−2.5, 0, −1.0): octagonal wire prism 2.2 m + wire sphere r 0.25 at y 2.45 — packets land on the sphere, it
// flashes amber for 300 ms and a sprite under it shows the query/url (40 chars) for 4 s. terminal (+2.5, 0, −1.0): wire
// box 1.6 m with a 0.5 × 0.3 m screen plane at y 1.4 showing the last command (60 chars) and its exit code. files
// (0, 0, −3.2): the file tree (scene/filetree.js) — this module only places the base + label and routes packets to the
// touched node. Packets: 0.05 m cubes along a quadratic Bezier (fx.flyPacket), 600 ms out on tool.start, 600 ms back on
// tool.complete; target "self" flashes the column's own base. Positions come from store.pylons × flags.scale.

import * as THREE from 'three';
import { CATEGORY_COLORS, CATEGORY_OF_TOOL, TARGET_OF_CATEGORY } from '/shared/protocol.js';
import { makeTextSprite, makeTextPlane } from '../text/canvas-text.js';

export const DEFAULT_PYLONS = Object.freeze([
  { kind: 'browser', x: -2.5, z: -1.0, label: 'web' },
  { kind: 'terminal', x: 2.5, z: -1.0, label: 'terminal' },
  { kind: 'files', x: 0, z: -3.2, label: 'codebase' },
]);
export const PACKET_MS = 600;
export const QUERY_SPRITE_MS = 4000;
export const SPHERE_Y = 2.45;
export const SCREEN_Y = 1.4;
export const FILES_Y = 0.4;

const RETURN_OK = '#22D3EE';
const RETURN_FAIL = '#EF4444';

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const hostOf = (url) => { try { return new URL(url).host + (new URL(url).pathname.length > 1 ? '/…' : ''); } catch { return clip(url, 40); } };

function edges(geo) { return new THREE.EdgesGeometry(geo); }

export function createPylons({ scene, store, fx, flags = {}, room, columns, hud, app } = {}) {
  const scale = Number(flags.scale) > 0 ? Number(flags.scale) : 1;
  const root = new THREE.Group(); root.name = 'pylons'; scene.add(root);
  const groups = {};        // kind → THREE.Group (positioned + facing the origin)
  const parts = {};         // kind → { sphere, query, screen, screenFrame, ... }
  const timers = { queryUntil: 0, screenFlashUntil: 0 };
  let pylons = [];

  // ---------------------------------------------------------------- geometry
  function buildBrowser() {
    const g = new THREE.Group(); g.name = 'pylon:browser';
    const base = new THREE.LineSegments(edges(new THREE.BoxGeometry(0.3, 0.02, 0.3)), new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.8 }));
    base.position.y = 0.01;
    const prism = new THREE.LineSegments(edges(new THREE.CylinderGeometry(0.15, 0.15, 2.2, 8, 1, false)), new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.6 }));
    prism.position.y = 1.1;
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf59e0b, wireframe: true, transparent: true, opacity: 0.85 }));
    sphere.position.y = SPHERE_Y; sphere.name = 'browser-sphere';
    const query = makeTextSprite('', { widthM: 0.8, heightM: 0.09, width: 768, height: 86, fontPx: 36, color: '#fde68a', bg: 'rgba(69,26,3,0.85)', maxLines: 1 });
    query.position.y = SPHERE_Y - 0.38; query.visible = false;
    const label = makeTextSprite('web', { widthM: 0.36, heightM: 0.08, fontPx: 40, weight: 700, color: '#fde68a', bg: 'rgba(15,23,42,0.85)', maxLines: 1 });
    label.position.y = SPHERE_Y + 0.42;
    g.add(base, prism, sphere, query, label);
    parts.browser = { sphere, query, label, base, prism, pop: 0 };
    return g;
  }

  function buildTerminal() {
    const g = new THREE.Group(); g.name = 'pylon:terminal';
    const base = new THREE.LineSegments(edges(new THREE.BoxGeometry(0.3, 0.02, 0.3)), new THREE.LineBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.8 }));
    base.position.y = 0.01;
    const box = new THREE.LineSegments(edges(new THREE.BoxGeometry(0.3, 1.6, 0.3)), new THREE.LineBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.6 }));
    box.position.y = 0.8;
    const screen = makeTextPlane('$ _', { widthM: 0.5, heightM: 0.3, width: 512, height: 308, fontPx: 30, mono: true, align: 'left', color: '#86efac', bg: 'rgba(3,7,18,0.92)', border: 'rgba(34,197,94,0.5)', maxLines: 4, padding: 20 });
    screen.position.set(0, SCREEN_Y, 0.17);
    const screenFrame = new THREE.LineSegments(edges(new THREE.BoxGeometry(0.52, 0.32, 0.01)), new THREE.LineBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.9 }));
    screenFrame.position.copy(screen.position);
    const label = makeTextSprite('terminal', { widthM: 0.36, heightM: 0.08, fontPx: 40, weight: 700, color: '#bbf7d0', bg: 'rgba(15,23,42,0.85)', maxLines: 1 });
    label.position.y = 1.75;
    g.add(base, box, screen, screenFrame, label);
    parts.terminal = { screen, screenFrame, label, base, box, lastCommand: '' };
    return g;
  }

  function buildFiles() {
    const g = new THREE.Group(); g.name = 'pylon:files';
    const base = new THREE.LineSegments(edges(new THREE.BoxGeometry(0.3, 0.02, 0.3)), new THREE.LineBasicMaterial({ color: 0x14b8a6, transparent: true, opacity: 0.8 }));
    base.position.y = 0.01;
    // fallback root cube (hidden when scene/filetree.js draws the real tree)
    const cube = new THREE.LineSegments(edges(new THREE.BoxGeometry(0.1, 0.1, 0.1)), new THREE.LineBasicMaterial({ color: 0x14b8a6 }));
    cube.position.y = FILES_Y;
    const label = makeTextSprite('codebase', { widthM: 0.36, heightM: 0.08, fontPx: 40, weight: 700, color: '#99f6e4', bg: 'rgba(15,23,42,0.85)', maxLines: 1 });
    label.position.y = 0.14;
    g.add(base, cube, label);
    parts.files = { base, cube, label };
    return g;
  }

  groups.browser = buildBrowser(); groups.terminal = buildTerminal(); groups.files = buildFiles();
  root.add(groups.browser, groups.terminal, groups.files);

  // ---------------------------------------------------------------- placement
  function setPylons(list) {
    const src = Array.isArray(list) && list.length ? list : (store?.pylons?.length ? store.pylons : DEFAULT_PYLONS);
    pylons = DEFAULT_PYLONS.map((d) => ({ ...d, ...(src.find((p) => p.kind === d.kind) || {}) }));
    for (const p of pylons) {
      const g = groups[p.kind]; if (!g) continue;
      g.position.set(p.x * scale, 0, p.z * scale);
      g.rotation.y = Math.atan2(-g.position.x, -g.position.z); // face the origin (the user's start)
      const label = parts[p.kind]?.label; if (label && p.label) label.setText(p.label);
    }
    room?.setPylonMarkers?.([], scale, false); // hide the placeholders drawn before this module loaded
  }

  /** World position a packet aims at for a PylonKind (null for "self" / unknown). */
  function positionOf(kind) {
    const g = groups[kind]; if (!g) return null;
    const y = kind === 'browser' ? SPHERE_Y : kind === 'terminal' ? SCREEN_Y : FILES_Y;
    g.updateMatrixWorld(true); // a pylons event + tool.start can land in the same tick, before the next render
    return g.localToWorld(new THREE.Vector3(0, y, kind === 'terminal' ? 0.17 : 0));
  }

  function targetFor(kind, ev, msg) {
    if (kind === 'files') { const t = app?.filetree?.targetFor?.(ev, msg); if (t) return t; }
    return positionOf(kind);
  }

  function kindFor(ev, msg) {
    if (ev?.target) return ev.target;
    if (msg?.tool?.target) return msg.tool.target;
    return TARGET_OF_CATEGORY(ev?.category || msg?.tool?.category || CATEGORY_OF_TOOL(ev?.name || msg?.tool?.name));
  }

  // ---------------------------------------------------------------- arrivals
  function arriveBrowser(ev, msg) {
    const b = parts.browser; const now = performance.now();
    fx.flash(b.sphere.material, '#FDE68A', 300);
    b.pop = now;
    const a = ev?.args || msg?.tool?.args || {};
    const text = a.query ? `🔍 ${clip(a.query, 40)}` : a.url ? `🌐 ${hostOf(a.url)}` : clip(ev?.preview || msg?.summary || ev?.name || 'web', 40);
    b.query.setText(text); b.query.visible = true; timers.queryUntil = now + QUERY_SPRITE_MS;
  }
  function arriveTerminal(ev, msg) {
    const t = parts.terminal; const a = ev?.args || msg?.tool?.args || {};
    const cmd = a.command || ev?.meta?.command || msg?.tool?.meta?.command || ev?.preview || ev?.name || '';
    t.lastCommand = `$ ${clip(cmd, 60)}`;
    t.screen.setText(t.lastCommand);
    fx.flash(t.screenFrame.material, '#86EFAC', 300); timers.screenFlashUntil = performance.now() + 300;
  }
  function completeTerminal(ev) {
    const t = parts.terminal;
    const code = ev?.meta?.exitCode;
    const tail = Number.isFinite(code) ? ` → exit ${code}` : ev?.ok === false ? ' → failed' : ' → ok';
    const dur = Number.isFinite(ev?.durationMs) ? ` (${(ev.durationMs / 1000).toFixed(1)} s)` : '';
    t.screen.setText(`${t.lastCommand || '$ …'}\n${tail}${dur}`);
    fx.flash(t.screenFrame.material, ev?.ok === false ? RETURN_FAIL : RETURN_OK, 300);
  }

  // ---------------------------------------------------------------- tool.start / tool.complete
  /** Packet tile → pylon on tool.start; "self" flashes the column base. `from` is the tile's world position. */
  function onToolStart(ev, from, column) {
    const msg = store?.message?.(ev.messageId) || null;
    const kind = kindFor(ev, msg);
    const category = ev.category || msg?.tool?.category || CATEGORY_OF_TOOL(ev.name);
    const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.tools;
    const to = kind === 'self' ? null : targetFor(kind, ev, msg);
    if (!to) { if (column?.base?.material) fx.flash(column.base.material, color, 300); return null; }
    const origin = from ? from.clone() : column?.worldOf?.() || new THREE.Vector3();
    return fx.flyPacket({ from: origin, to, color, ms: PACKET_MS, lift: 1.0, onDone: () => {
      if (kind === 'browser') arriveBrowser(ev, msg);
      else if (kind === 'terminal') arriveTerminal(ev, msg);
      else if (kind === 'files') app?.filetree?.onToolStart?.(ev, msg);
    } });
  }

  /** Packet pylon → tile on tool.complete (cyan, red when ok === false); updates the terminal screen. */
  function onToolComplete(ev, to, column) {
    const msg = store?.message?.(ev.messageId) || null;
    const kind = kindFor({ target: msg?.tool?.target, category: msg?.tool?.category, name: ev.name }, msg);
    const color = ev.ok === false ? RETURN_FAIL : RETURN_OK;
    if (kind === 'terminal') completeTerminal(ev);
    const from = kind === 'self' ? null : targetFor(kind, ev, msg);
    if (!from) { if (column?.base?.material) fx.flash(column.base.material, color, 300); return null; }
    const dest = to ? to.clone() : column?.worldOf?.() || new THREE.Vector3();
    return fx.flyPacket({ from, to: dest, color, ms: PACKET_MS, lift: 1.0 });
  }

  // ---------------------------------------------------------------- per frame
  function update(now, dt) {
    const b = parts.browser;
    b.sphere.rotation.y += (dt || 0.016) * 0.4;
    if (b.pop) { const k = Math.min(1, (now - b.pop) / 300); b.sphere.scale.setScalar(1 + 0.3 * Math.sin(k * Math.PI)); if (k >= 1) { b.pop = 0; b.sphere.scale.setScalar(1); } }
    if (b.query.visible && now > timers.queryUntil) b.query.visible = false;
    if (app?.filetree && parts.files.cube.visible) parts.files.cube.visible = false;
  }

  const offs = [];
  if (store?.on) {
    offs.push(store.on('pylons', (ev) => setPylons(ev.pylons)));
    offs.push(store.on('snapshot', () => setPylons(store.pylons)));
  }
  setPylons(store?.pylons);

  return {
    root, groups, parts, DEFAULT_PYLONS,
    update, setPylons, positionOf, targetFor, onToolStart, onToolComplete,
    get pylons() { return pylons; },
    stats() { return { pylons: pylons.length, lastCommand: parts.terminal.lastCommand, query: parts.browser.query.visible ? parts.browser.query.userData.text : '' }; },
    dispose() {
      for (const off of offs) off();
      scene.remove(root);
      root.traverse((o) => { if (o.disposeText) o.disposeText(); else { o.geometry?.dispose?.(); if (o.material && !o.material.map) o.material.dispose?.(); } });
    },
  };
}

export default { createPylons, DEFAULT_PYLONS, PACKET_MS };
