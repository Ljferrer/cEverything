// Column building blocks (split out of column.js to stay under ~500 lines): base plate, status ring, glance panel,
// beacon, hitboxes. Geometry is shared across columns; materials are per column (they animate).

import * as THREE from 'three';
import { CATEGORY_COLORS } from '/shared/protocol.js';
import { makeTextSprite } from '../text/canvas-text.js';

export const HIT_LAYER = 1;   // raycast targets for pointer / controller rays
export const GAZE_LAYER = 2;  // head-ray only (column cylinder)

export const STATUS_COLORS = Object.freeze({
  idle: '#FFFFFF', thinking: '#A78BFA', responding: '#38BDF8', tool: '#F59E0B', waiting_on_you: '#EF4444', done: '#22C55E', error: '#EF4444',
});

const shared = {};
function geo(name, make) { if (!shared[name]) shared[name] = make(); return shared[name]; }

export function makeBase() {
  const edges = geo('baseEdges', () => new THREE.EdgesGeometry(new THREE.BoxGeometry(0.40, 0.05, 0.40)));
  const mat = new THREE.LineBasicMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.8 });
  const base = new THREE.LineSegments(edges, mat);
  base.position.y = 0.025;
  base.name = 'base';
  return base;
}

/** Status ring: circle r 0.25, 32 segments, dashed so rotation is visible. */
export function makeRing() {
  const g = geo('ring', () => {
    const pts = [];
    for (let i = 0; i <= 32; i++) { const a = (i / 32) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * 0.25, 0, Math.sin(a) * 0.25)); }
    return new THREE.BufferGeometry().setFromPoints(pts);
  });
  const mat = new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, dashSize: 0.09, gapSize: 0.0 });
  const ring = new THREE.Line(g, mat);
  ring.computeLineDistances();
  ring.position.y = 0.02;
  ring.name = 'ring';
  ring.userData.status = 'idle';
  return ring;
}

/** Per-frame ring animation by status (PROTOCOL §5). */
export function updateRing(ring, status, now) {
  const mat = ring.material;
  const t = now * 0.001;
  if (ring.userData.status !== status) { ring.userData.status = status; mat.color.set(STATUS_COLORS[status] || '#FFFFFF'); }
  mat.gapSize = 0; mat.opacity = 1; ring.scale.setScalar(1);
  switch (status) {
    case 'thinking': mat.opacity = 0.45 + 0.45 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2)); break;            // violet pulse 1 Hz
    case 'responding': mat.gapSize = 0.05; ring.rotation.y = -t * Math.PI; break;                             // cyan rotate 1 rev / 2 s
    case 'tool': mat.gapSize = 0.05; ring.rotation.y = -t * Math.PI; break;                                   // amber rotate
    case 'waiting_on_you': ring.scale.setScalar(1 + 0.075 + 0.075 * Math.sin(t * Math.PI * 2)); break;       // red scale-pulse 1.0↔1.15 @ 1 Hz
    case 'done': break;                                                                                      // green steady
    case 'error': break;                                                                                     // red steady
    default: mat.opacity = 0.4; break;                                                                      // idle white 40 %
  }
}

/** Glance panel: title (y 1.15) · activity (y 1.05) · tool-history cubes (y 0.90) · counts (y 0.75). */
export function makeGlance() {
  const group = new THREE.Group(); group.name = 'glance';
  const title = makeTextSprite('', { widthM: 0.36, heightM: 0.08, fontPx: 36, weight: 700, bg: 'rgba(15,23,42,0.9)', maxLines: 1 });
  title.position.y = 1.15;
  const activity = makeTextSprite('', { widthM: 0.36, heightM: 0.06, fontPx: 34, color: '#cbd5e1', bg: 'rgba(15,23,42,0.75)', maxLines: 1 });
  activity.position.y = 1.05;
  const counts = makeTextSprite('', { widthM: 0.30, heightM: 0.05, fontPx: 32, color: '#9ca3af', bg: 'rgba(15,23,42,0.6)', maxLines: 1 });
  counts.position.y = 0.75;
  const cubeGeo = geo('historyCube', () => new THREE.BoxGeometry(0.04, 0.04, 0.04));
  const history = new THREE.InstancedMesh(cubeGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), 8);
  history.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(8 * 3), 3);
  history.count = 0; history.position.y = 0.90; history.frustumCulled = false; history.name = 'toolHistory';
  group.add(title, activity, counts, history);
  const m = new THREE.Matrix4(); const c = new THREE.Color();
  return {
    group, title, activity, counts, history,
    setSession(s) {
      title.setText(`${s.title}${s.model ? ' · ' + shortModel(s.model) : ''}`);
      activity.setText(s.activity || statusWord(s.status));
      counts.setText(`${s.counts?.messages ?? 0} msgs · ${s.counts?.toolCalls ?? 0} tools`);
      const hist = (s.toolHistory || []).slice(-8);
      const n = hist.length; const pitch = 0.045;
      for (let i = 0; i < n; i++) {
        m.makeTranslation((i - (n - 1) / 2) * pitch, 0, 0);
        history.setMatrixAt(i, m);
        c.set(CATEGORY_COLORS[hist[i]] || CATEGORY_COLORS.tools);
        history.setColorAt(i, c);
      }
      history.count = n;
      history.instanceMatrix.needsUpdate = true;
      if (history.instanceColor) history.instanceColor.needsUpdate = true;
    },
    setHighlight(on) { title.scale.set(0.36 * (on ? 1.2 : 1), 0.08 * (on ? 1.2 : 1), 1); },
    dispose() { title.disposeText(); activity.disposeText(); counts.disposeText(); history.material.dispose(); },
  };
}

export function shortModel(model) {
  if (!model) return '';
  let m = String(model).split('/').pop();
  m = m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  return m.length > 18 ? m.slice(0, 17) + '…' : m;
}

export function statusWord(status) {
  return { idle: 'idle', thinking: 'thinking', responding: 'responding', tool: 'running a tool', waiting_on_you: 'needs you', done: 'done', error: 'error' }[status] || status || '';
}

/** Beacon for waiting_on_you: red octahedron at y 2.6 bobbing, with a thin line down to the base. */
export function makeBeacon() {
  const group = new THREE.Group(); group.name = 'beacon'; group.visible = false;
  const octa = new THREE.Mesh(geo('octa', () => new THREE.OctahedronGeometry(0.12)), new THREE.MeshBasicMaterial({ color: 0xef4444, wireframe: true }));
  octa.position.y = 2.6;
  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.05, 0), new THREE.Vector3(0, 2.48, 0)]);
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.5 }));
  const label = makeTextSprite('', { widthM: 0.36, heightM: 0.06, fontPx: 34, color: '#fecaca', bg: 'rgba(69,10,10,0.85)', maxLines: 1 });
  label.position.y = 2.42;
  group.add(octa, line, label);
  return {
    group, octa, line, label,
    setAttention(att, visible) {
      group.visible = Boolean(visible);
      if (visible) label.setText(att?.text ? `⚑ ${att.text}` : '⚑ needs you');
    },
    update(now) {
      if (!group.visible) return;
      const t = now * 0.001;
      octa.position.y = 2.6 + 0.05 * Math.sin(t * Math.PI * 2);
      octa.rotation.y = t * 1.5;
    },
    dispose() { label.disposeText(); octa.material.dispose(); line.geometry.dispose(); line.material.dispose(); },
  };
}

/** Invisible hit targets on HIT_LAYER (+ gaze cylinder on GAZE_LAYER). userData = { kind, column }. */
export function makeHitboxes(column) {
  const mat = new THREE.MeshBasicMaterial({ visible: false });
  const unit = geo('unitBox', () => new THREE.BoxGeometry(1, 1, 1));
  function box(kind, sx, sy, sz, y, layer = HIT_LAYER) {
    const m = new THREE.Mesh(unit, mat);
    m.scale.set(sx, sy, sz); m.position.y = y;
    m.userData = { kind, column, hit: true };
    m.layers.set(layer);
    m.name = `hit:${kind}`;
    return m;
  }
  const base = box('base', 0.44, 0.10, 0.44, 0.05);
  const title = box('title', 0.40, 0.10, 0.10, 1.15);
  const stack = box('stack', 0.40, 0.14, 0.10, 1.30);
  const gaze = new THREE.Mesh(geo('gazeCyl', () => new THREE.CylinderGeometry(0.30, 0.30, 3.0, 12)), mat);
  gaze.position.y = 1.5; gaze.userData = { kind: 'gaze', column, hit: true }; gaze.layers.set(GAZE_LAYER); gaze.name = 'hit:gaze';
  return { base, title, stack, gaze, all: [base, title, stack, gaze], material: mat };
}

export default { makeBase, makeRing, updateRing, makeGlance, makeBeacon, makeHitboxes, shortModel, statusWord, STATUS_COLORS, HIT_LAYER, GAZE_LAYER };
