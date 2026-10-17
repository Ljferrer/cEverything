// The shared room (PIN-22 seam): a floor grid, one obelisk per `session` on a
// 3 m ring, children on a 1 m ring around their parent at 0.6 scale with one
// floor label per shared `phase` (PIN-21). Routes `slab`, `delta`, and `state`
// to the matching obelisk. Later plans read `getObelisk(sid)` and
// `allObelisks()`; they never edit this file.
import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { Obelisk } from '../obelisk.js';

export const RING_RADIUS = 3;
export const CHILD_RADIUS = 1;
export const CHILD_SCALE = 0.6;
const PHASE_LABEL_RADIUS = CHILD_RADIUS + 0.4;

/** @type {Map<string, Obelisk>} */
const obelisks = new Map();
/** @type {Map<string, Text>} keyed `${parent sid}\u0000${phase}` */
const phaseLabels = new Map();
let room = null;

/** The obelisk for a session id, or null. */
export function getObelisk(sid) {
  return obelisks.get(sid) ?? null;
}

/** Every obelisk in the room; each is a THREE.Group with `sid` and `userData.sid`. */
export function allObelisks() {
  return [...obelisks.values()];
}

export function install({ scene, bus }) {
  room = new THREE.Group();
  room.name = 'room';
  room.add(new THREE.GridHelper(12, 24, 0x335566, 0x1b2a33));
  scene.add(room);

  bus.addEventListener('session', (e) => onSession(e.detail));
  bus.addEventListener('slab', (e) => getObelisk(e.detail.sid)?.addSlab(e.detail));
  bus.addEventListener('delta', (e) => getObelisk(e.detail.sid)?.appendDelta(e.detail));
  bus.addEventListener('state', (e) => getObelisk(e.detail.sid)?.setState(e.detail.status));
  bus.addEventListener('frame', (e) => {
    for (const o of obelisks.values()) o.update(e.detail.camera);
  });
}

function onSession(session) {
  let o = obelisks.get(session.sid);
  if (!o) {
    o = new Obelisk(session);
    obelisks.set(session.sid, o);
    room.add(o);
  } else {
    o.session = { ...session };
    o.setTitle(session.title);
    o.setState(session.status);
  }
  layout();
}

// Angle i of n on a ring, starting straight ahead of the default camera (-z).
function ringPoint(i, n, radius, cx, cz) {
  const a = (i / Math.max(n, 1)) * Math.PI * 2;
  return { x: cx + radius * Math.sin(a), z: cz - radius * Math.cos(a), a };
}

function place(o, x, z, scale) {
  o.position.set(x, 0, z);
  o.scale.setScalar(scale);
  o.lookAt(0, 0, 0); // text faces +z, so the obelisk faces the room center
}

const byPhaseThenSid = (a, b) =>
  (a.session.phase ?? '').localeCompare(b.session.phase ?? '') || a.sid.localeCompare(b.sid);

/** Re-place every obelisk and phase label. Idempotent; runs on every `session` event. */
export function layout() {
  const all = [...obelisks.values()];
  const roots = all.filter((o) => !o.session.parent || !obelisks.has(o.session.parent)).sort(byPhaseThenSid);
  const seen = new Set();
  roots.forEach((o, i) => {
    const p = ringPoint(i, roots.length, RING_RADIUS, 0, 0);
    place(o, p.x, p.z, 1);
    placeChildren(o, all, seen);
  });
  for (const [key, label] of phaseLabels) {
    if (seen.has(key)) continue;
    room.remove(label);
    label.dispose();
    phaseLabels.delete(key);
  }
}

function placeChildren(parent, all, seen) {
  const children = all.filter((o) => o.session.parent === parent.sid).sort(byPhaseThenSid);
  if (!children.length) return;
  const arcs = new Map(); // phase -> angles of its children
  children.forEach((child, i) => {
    const p = ringPoint(i, children.length, CHILD_RADIUS, parent.position.x, parent.position.z);
    place(child, p.x, p.z, parent.scale.x * CHILD_SCALE);
    placeChildren(child, all, seen);
    if (child.session.phase) {
      if (!arcs.has(child.session.phase)) arcs.set(child.session.phase, []);
      arcs.get(child.session.phase).push(p.a);
    }
  });
  for (const [phase, angles] of arcs) {
    const key = `${parent.sid}\u0000${phase}`;
    seen.add(key);
    let label = phaseLabels.get(key);
    if (!label) {
      label = new Text();
      label.text = phase;
      label.fontSize = 0.08;
      label.color = 0x8899aa;
      label.sdfGlyphSize = 64;
      label.anchorX = 'center';
      label.anchorY = 'middle';
      label.rotation.x = -Math.PI / 2; // lies on the floor
      label.userData = { kind: 'phase', parent: parent.sid, phase };
      label.sync();
      phaseLabels.set(key, label);
      room.add(label);
    }
    // Siblings sort by phase, so a phase's arc is contiguous: its label sits under the arc's middle.
    const mid = angles.reduce((s, a) => s + a, 0) / angles.length;
    const r = PHASE_LABEL_RADIUS * parent.scale.x;
    label.position.set(parent.position.x + r * Math.sin(mid), 0.01, parent.position.z - r * Math.cos(mid));
  }
}
