// The shared room (PIN-22 seam): a floor grid, one obelisk per `session` on a
// fixed grid of slots, children on a fixed 8-slot 1 m ring around their parent
// at 0.6 scale with one floor label per shared `phase` (PIN-21). A session
// takes the next free slot when first seen and keeps it, so nothing ever moves:
// the room is spatial memory. The sid -> slot map lives in localStorage, so a
// reload puts every known sid back where it was. Routes `slab`, `delta`, and
// `state` to the matching obelisk. Later plans read `getObelisk(sid)` and
// `allObelisks()`; they never edit this file.
import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { Obelisk } from '../obelisk.js';

export const RING_RADIUS = 3;
export const CHILD_RADIUS = 1;
export const CHILD_SCALE = 0.6;
const PHASE_LABEL_RADIUS = CHILD_RADIUS + 0.4;
// 12 root slots at 30 deg on the 3 m ring, then rings of 12 from 7 m out, 2 m
// apart. Outer slots sit half a step (15 deg) off the compass points, so they
// stay 2.5 m clear of the tool pylons at 5 m (pylons.js).
const RING_SLOTS = 12;
const OUTER_RADIUS = 7;
const OUTER_GAP = 2;
const CHILD_SLOTS = 8;
const STORE_KEY = 'obelisks.slots';

/** @type {Map<string, Obelisk>} */
const obelisks = new Map();
/** @type {Map<string, Text>} keyed `${parent sid}\u0000${phase}` */
const phaseLabels = new Map();
let room = null;
/** Slot map: `root` is sid -> slot, `child` is sid -> { parent, slot }. */
let slots = { root: {}, child: {} };

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
  slots = loadSlots();
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

// A per-viewer convenience: the room works the same with no storage at all.
function loadSlots() {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? 'null');
    if (v && typeof v.root === 'object' && typeof v.child === 'object' && v.root && v.child) return v;
  } catch {}
  return { root: {}, child: {} };
}

function saveSlots() {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(slots));
  } catch {}
}

const lowestFree = (taken) => {
  let n = 0;
  while (taken.has(n)) n++;
  return n;
};

// A stored slot stays reserved for its sid even before that sid arrives.
function rootSlot(sid) {
  if (!Number.isInteger(slots.root[sid])) {
    slots.root[sid] = lowestFree(new Set(Object.values(slots.root)));
    saveSlots();
  }
  return slots.root[sid];
}

function childSlot(sid, parent) {
  const own = slots.child[sid];
  if (own?.parent !== parent || !Number.isInteger(own.slot)) {
    const taken = new Set(Object.values(slots.child).filter((c) => c?.parent === parent).map((c) => c.slot));
    slots.child[sid] = { parent, slot: lowestFree(taken) };
    saveSlots();
  }
  return slots.child[sid].slot;
}

// Slot n of the root grid; angle 0 is straight ahead of the default camera (-z).
export function rootSlotPoint(n) {
  const inner = n < RING_SLOTS;
  const ring = inner ? 0 : Math.floor((n - RING_SLOTS) / RING_SLOTS);
  const radius = inner ? RING_RADIUS : OUTER_RADIUS + ring * OUTER_GAP;
  const step = inner ? n : ((n - RING_SLOTS) % RING_SLOTS) + 0.5;
  return ringPoint(step / RING_SLOTS, radius, 0, 0);
}

// Fraction f of a turn on a ring, starting at -z.
function ringPoint(f, radius, cx, cz) {
  const a = f * Math.PI * 2;
  return { x: cx + radius * Math.sin(a), z: cz - radius * Math.cos(a), a };
}

function place(o, x, z, scale) {
  o.position.set(x, 0, z);
  o.scale.setScalar(scale);
  o.lookAt(0, 0, 0); // initial facing; obelisk.update(camera) turns it to the viewer
}

const isRoot = (o) => !o.session.parent || !obelisks.has(o.session.parent);

/** Place every obelisk at its fixed slot and every phase label. Idempotent; runs on every `session` event. */
export function layout() {
  const all = [...obelisks.values()]; // arrival order, so a new sid claims the next free slot
  const seen = new Set();
  for (const o of all.filter(isRoot)) {
    const p = rootSlotPoint(rootSlot(o.sid));
    place(o, p.x, p.z, 1);
    placeChildren(o, all, seen);
  }
  for (const [key, label] of phaseLabels) {
    if (seen.has(key)) continue;
    room.remove(label);
    label.dispose();
    phaseLabels.delete(key);
  }
}

function placeChildren(parent, all, seen) {
  const children = all.filter((o) => o.session.parent === parent.sid);
  if (!children.length) return;
  const arcs = new Map(); // phase -> angles of its children
  for (const child of children) {
    const slot = childSlot(child.sid, parent.sid);
    const p = ringPoint(slot / CHILD_SLOTS, CHILD_RADIUS, parent.position.x, parent.position.z);
    place(child, p.x, p.z, parent.scale.x * CHILD_SCALE);
    placeChildren(child, all, seen);
    if (child.session.phase) {
      if (!arcs.has(child.session.phase)) arcs.set(child.session.phase, []);
      arcs.get(child.session.phase).push(p.a);
    }
  }
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
    // The label sits at the circular mean of its children's slot angles.
    const mid = Math.atan2(
      angles.reduce((s, a) => s + Math.sin(a), 0),
      angles.reduce((s, a) => s + Math.cos(a), 0),
    );
    const r = PHASE_LABEL_RADIUS * parent.scale.x;
    label.position.set(parent.position.x + r * Math.sin(mid), 0.01, parent.position.z - r * Math.cos(mid));
  }
}
