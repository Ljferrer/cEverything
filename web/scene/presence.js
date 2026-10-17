// Remote participants (PROTOCOL.md §5 presence): headset = wire cone at the head + 0.03 m hand spheres + 2 m dotted
// gaze ray; laptop = wire camera pyramid; hover outline on the tile the other person is pointing at. Poses arrive at
// ≤ 10 Hz and are interpolated. Stale avatars (no frame for 30 s) are hidden.

import * as THREE from 'three';
import { makeTextSprite } from '../text/canvas-text.js';
import { TILE } from './tiles.js';

const STALE_MS = 30000;
const LERP = 10; // 1/s

const geo = {};
function g(name, make) { if (!geo[name]) geo[name] = make(); return geo[name]; }

function headsetHead() {
  const cone = new THREE.Mesh(g('cone', () => new THREE.ConeGeometry(0.08, 0.15, 8, 1, true)), new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true }));
  cone.rotation.x = -Math.PI / 2; // point along −z (the look direction)
  return cone;
}

function laptopHead() {
  // camera pyramid: apex at the eye, base 0.12 × 0.08 at 0.12 m in front
  const pts = [
    [0, 0, 0], [-0.06, 0.04, -0.12], [0, 0, 0], [0.06, 0.04, -0.12], [0, 0, 0], [-0.06, -0.04, -0.12], [0, 0, 0], [0.06, -0.04, -0.12],
    [-0.06, 0.04, -0.12], [0.06, 0.04, -0.12], [0.06, 0.04, -0.12], [0.06, -0.04, -0.12], [0.06, -0.04, -0.12], [-0.06, -0.04, -0.12], [-0.06, -0.04, -0.12], [-0.06, 0.04, -0.12],
  ];
  const pyramid = new THREE.LineSegments(g('pyramid', () => new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p)))), new THREE.LineBasicMaterial({ color: 0x3b82f6 }));
  return pyramid;
}

export function createPresence({ scene, store, resolveTile } = {}) {
  const root = new THREE.Group(); root.name = 'presence'; scene.add(root);
  const avatars = new Map(); // clientId → avatar
  const _target = new THREE.Vector3(); const _dir = new THREE.Vector3(); const _q = new THREE.Quaternion();

  function makeAvatar(p) {
    const headset = p.device === 'quest' || p.device === 'visionpro';
    const group = new THREE.Group(); group.name = `presence:${p.clientId}`;
    const head = headset ? headsetHead() : laptopHead();
    group.add(head);
    const name = makeTextSprite(p.name || p.device || 'someone', { widthM: 0.3, heightM: 0.06, fontPx: 34, color: '#e5e7eb', bg: 'rgba(15,23,42,0.8)', maxLines: 1 });
    name.position.y = 0.16;
    head.add(name);
    const hands = [0, 1].map(() => {
      const s = new THREE.Mesh(g('hand', () => new THREE.SphereGeometry(0.03, 10, 8)), new THREE.MeshBasicMaterial({ color: 0xe5e7eb, wireframe: true }));
      s.visible = false; group.add(s); return s;
    });
    const gazeGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -2)]);
    const gaze = new THREE.Line(gazeGeo, new THREE.LineDashedMaterial({ color: headset ? 0x38bdf8 : 0x3b82f6, dashSize: 0.04, gapSize: 0.04, transparent: true, opacity: 0.8 }));
    gaze.computeLineDistances(); gaze.visible = headset; gaze.frustumCulled = false;
    head.add(gaze);
    const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.7 }));
    ray.visible = false; ray.frustumCulled = false; group.add(ray);
    const outline = new THREE.LineSegments(g('outline', () => new THREE.EdgesGeometry(new THREE.BoxGeometry(TILE.w + 0.06, TILE.h + 0.02, TILE.d + 0.02))), new THREE.LineBasicMaterial({ color: 0x3b82f6 }));
    outline.visible = false; outline.frustumCulled = false; root.add(outline);
    group.visible = false;
    root.add(group);
    return { id: p.clientId, device: p.device, headset, group, head, name, hands, gaze, ray, outline, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), hasPose: false, lastSeen: Date.now(), data: p };
  }

  function upsert(p) {
    if (!p || !p.clientId) return;
    let a = avatars.get(p.clientId);
    if (a && a.device !== p.device) { remove(p.clientId); a = null; }
    if (!a) { a = makeAvatar(p); avatars.set(p.clientId, a); }
    a.data = { ...a.data, ...p };
    a.lastSeen = Date.now();
    if (p.name && p.name !== a.name.userData.text) a.name.setText(p.name);
    if (p.head && Array.isArray(p.head.p) && Array.isArray(p.head.q)) {
      a.pos.fromArray(p.head.p); a.quat.fromArray(p.head.q);
      if (!a.hasPose) { a.group.position.copy(a.pos); a.group.quaternion.copy(a.quat); a.hasPose = true; a.group.visible = true; }
    }
    a.handTargets = Array.isArray(p.hands) ? p.hands : a.handTargets;
    a.rayData = p.ray === undefined ? a.rayData : p.ray;
    a.hover = p.hover === undefined ? a.hover : p.hover;
  }

  function remove(clientId) {
    const a = avatars.get(clientId);
    if (!a) return;
    root.remove(a.group); root.remove(a.outline);
    a.name.disposeText(); a.gaze.geometry.dispose(); a.gaze.material.dispose(); a.ray.geometry.dispose(); a.ray.material.dispose();
    a.head.material.dispose(); for (const h of a.hands) h.material.dispose(); a.outline.material.dispose();
    avatars.delete(clientId);
  }

  function rebuild() { for (const id of [...avatars.keys()]) remove(id); for (const p of store.presence.values()) upsert(p); }

  const offs = [];
  if (store) {
    offs.push(store.on('presence', upsert));
    offs.push(store.on('presence.left', ({ clientId }) => remove(clientId)));
    offs.push(store.on('snapshot', rebuild));
  }

  function update(now, dt) {
    const k = Math.min(1, LERP * (dt || 0.016));
    const t = Date.now();
    for (const a of avatars.values()) {
      if (t - a.lastSeen > STALE_MS) { a.group.visible = false; a.outline.visible = false; continue; }
      if (!a.hasPose) continue;
      a.group.visible = true;
      a.group.position.lerp(a.pos, k);
      a.group.quaternion.slerp(a.quat, k);
      // hands (world positions)
      for (let i = 0; i < 2; i++) {
        const h = a.handTargets?.[i];
        const s = a.hands[i];
        if (h && Array.isArray(h.p)) { s.visible = true; _target.fromArray(h.p); a.group.worldToLocal(_target); s.position.lerp(_target, k); } else s.visible = false;
      }
      // pointer ray (world o/d) drawn as a 1 m line
      if (a.rayData && Array.isArray(a.rayData.o) && Array.isArray(a.rayData.d)) {
        a.ray.visible = true;
        _target.fromArray(a.rayData.o); a.group.worldToLocal(_target); a.ray.position.copy(_target);
        _dir.fromArray(a.rayData.d).normalize();
        _q.setFromUnitVectors(new THREE.Vector3(0, 0, -1), _dir);
        a.group.getWorldQuaternion(a.ray.quaternion).invert().multiply(_q);
      } else a.ray.visible = false;
      // hover outline on the tile the other person points at
      const hv = a.hover;
      const tile = hv && hv.sessionId && resolveTile ? resolveTile(hv.sessionId, hv.messageId) : null;
      if (tile && tile.world) { a.outline.visible = true; a.outline.position.copy(tile.world); if (tile.quaternion) a.outline.quaternion.copy(tile.quaternion); }
      else a.outline.visible = false;
    }
  }

  /** First headset participant's head pose (for the laptop spectator camera), or null. */
  function headsetPose() {
    for (const a of avatars.values()) if (a.headset && a.hasPose && a.group.visible) return { position: a.group.position, quaternion: a.group.quaternion, clientId: a.id, name: a.data.name };
    return null;
  }

  return {
    root, avatars, upsert, remove, rebuild, update, headsetPose,
    count() { return avatars.size; },
    dispose() { for (const off of offs) off(); for (const id of [...avatars.keys()]) remove(id); scene.remove(root); },
  };
}

export default { createPresence };
