// Room furniture (PROTOCOL.md §5): floor grid, honesty floor label, legend sprite, lights, origin marker,
// reading-height anchor + recenter.

import * as THREE from 'three';
import { makeTextPlane, makeTextSprite } from '../text/canvas-text.js';

export const READING_HEIGHT = 1.3;
export const LEGEND_TEXT = 'white = you · cyan = agent · violet = thinking\namber = tool · red = needs you\nlook + pinch to pick up · hold left to talk';

export function createRoom({ scene, scale = 1, ar = false } = {}) {
  const root = new THREE.Group(); root.name = 'room'; scene.add(root);
  if (!ar) scene.background = new THREE.Color(0x0b0f14);

  // floor grid 4 × 4 m, 0.5 m cells (scaled with the room)
  const size = 4 * scale;
  const grid = new THREE.GridHelper(size, Math.round(size / (0.5 * scale)), 0x374151, 0x374151);
  grid.material.transparent = true; grid.material.opacity = 0.9;
  grid.position.y = 0.001; grid.name = 'grid';
  root.add(grid);

  // origin marker (where the headset user starts)
  const originPts = [];
  for (let i = 0; i <= 24; i++) { const a = (i / 24) * Math.PI * 2; originPts.push(new THREE.Vector3(Math.cos(a) * 0.25, 0.002, Math.sin(a) * 0.25)); }
  const origin = new THREE.Line(new THREE.BufferGeometry().setFromPoints(originPts), new THREE.LineBasicMaterial({ color: 0x475569 }));
  origin.name = 'origin';
  root.add(origin);
  const fwd = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.002, -0.25), new THREE.Vector3(0, 0.002, -0.45)]), new THREE.LineBasicMaterial({ color: 0x475569 }));
  root.add(fwd);

  // honesty label on the floor at (0, 0.01, −0.8): flat plane reading sourceInfo.label
  const label = makeTextPlane('…', { widthM: 0.9, heightM: 0.18, fontPx: 56, weight: 700, color: '#fbbf24', bg: 'rgba(15,23,42,0.85)', border: 'rgba(251,191,36,0.6)', maxLines: 1 });
  label.rotation.x = -Math.PI / 2;
  label.position.set(0, 0.01, -0.8 * scale);
  label.name = 'honesty-label';
  root.add(label);

  // legend sprite at (−0.9, 1.0, −1.2)
  const legend = makeTextSprite(LEGEND_TEXT, { widthM: 0.6, heightM: 0.2, width: 768, height: 256, fontPx: 34, color: '#e5e7eb', bg: 'rgba(15,23,42,0.85)', maxLines: 3, align: 'left' });
  legend.position.set(-0.9 * scale, 1.0, -1.2 * scale);
  legend.name = 'legend';
  root.add(legend);

  // lights: MeshBasicMaterial ignores them, but an ambient keeps any stray lit material visible
  const ambient = new THREE.AmbientLight(0xffffff, 1.0);
  root.add(ambient);

  // reconnecting badge (in-room, near the legend) — shown by main.js when the socket drops
  const badge = makeTextSprite('reconnecting…', { widthM: 0.5, heightM: 0.08, fontPx: 40, weight: 700, color: '#fecaca', bg: 'rgba(127,29,29,0.9)', maxLines: 1 });
  badge.position.set(0, 1.7, -1.0 * scale);
  badge.visible = false; badge.name = 'reconnect-badge';
  root.add(badge);

  // placeholder pylon markers (wire boxes + labels) shown until scene/pylons.js draws the real pylons
  const markers = new THREE.Group(); markers.name = 'pylon-markers'; root.add(markers);
  const markerGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.3, 1, 0.3));
  const markerHeights = { browser: 2.2, terminal: 1.6, files: 0.8 };
  const markerColors = { browser: 0xf59e0b, terminal: 0x22c55e, files: 0x14b8a6 };
  function setPylonMarkers(pylons, s = 1, visible = true) {
    while (markers.children.length) { const c = markers.children.pop(); c.traverse((o) => { if (o.disposeText) o.disposeText(); }); markers.remove(c); }
    markers.visible = Boolean(visible);
    for (const p of pylons || []) {
      const g = new THREE.Group();
      const h = markerHeights[p.kind] || 1;
      const box = new THREE.LineSegments(markerGeo, new THREE.LineBasicMaterial({ color: markerColors[p.kind] || 0x9ca3af }));
      box.scale.y = h; box.position.y = h / 2;
      const lbl = makeTextSprite(`${p.label || p.kind}`, { widthM: 0.4, heightM: 0.08, fontPx: 40, weight: 700, color: '#e5e7eb', bg: 'rgba(15,23,42,0.85)', maxLines: 1 });
      lbl.position.y = h + 0.12;
      g.add(box, lbl);
      g.position.set(p.x * s, 0, p.z * s);
      g.userData.pylon = p;
      markers.add(g);
    }
  }

  const room = {
    root, grid, label, legend, badge, origin, markers, setPylonMarkers,
    readingHeight: READING_HEIGHT,
    listeners: new Set(),
    setLabel(text) { label.setText(String(text || '')); },
    setReconnecting(on) { badge.visible = Boolean(on); },
    /** Recenter: reading height = head height − 0.3 (clamped to a sane range). Notifies columns via listeners. */
    recenter(headY) {
      const h = Math.max(0.6, Math.min(2.0, (Number(headY) || 1.6) - 0.3));
      room.readingHeight = h;
      for (const fn of room.listeners) { try { fn(h); } catch (err) { console.error('[room] reading-height listener failed', err); } }
      return h;
    },
    onReadingHeight(fn) { room.listeners.add(fn); return () => room.listeners.delete(fn); },
    setScale(s) {
      label.position.z = -0.8 * s; legend.position.set(-0.9 * s, 1.0, -1.2 * s); badge.position.z = -1.0 * s;
    },
    update(now) { badge.material.opacity = badge.visible ? 0.7 + 0.3 * Math.sin(now * 0.004) : 1; },
    dispose() { label.disposeText(); legend.disposeText(); badge.disposeText(); grid.geometry.dispose(); grid.material.dispose(); },
  };
  return room;
}

export default { createRoom, READING_HEIGHT, LEGEND_TEXT };
