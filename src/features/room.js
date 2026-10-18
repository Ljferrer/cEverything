// The shared room (PIN-22 seam): a floor grid and one obelisk per `session`
// along a single walking aisle. The aisle runs straight ahead of the viewer
// (-z); chats alternate left and right of it, so one walk down the aisle
// passes every chat. Children stand in short rows on the far side of their
// parent, away from the aisle, at 0.6 scale, with one floor label per shared
// `phase` (PIN-21). A session takes the next free slot when first seen and
// keeps it, so nothing ever moves: the room is spatial memory. The sid -> slot
// map lives in localStorage, so a reload puts every known sid back where it
// was. Routes `slab`, `delta`, and `state` to the matching obelisk.
import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { Obelisk } from '../obelisk.js';

export const RING_RADIUS = 3; // distance to the first row (kept for callers)
export const CHILD_RADIUS = 1; // reach of a child row around its parent (kept for callers)
export const CHILD_SCALE = 0.6;
// Root slots: alternate left and right of the aisle, 2.5 m from its center
// line, one pair every 4 m, starting 3 m ahead of the viewer.
export const AISLE_OFFSET = 2.5;
export const FIRST_ROW_Z = -3;
export const ROW_GAP = 4;
// Child slots: rows of four running along the aisle, 0.8 m apart, starting
// 1.4 m outward from the parent and stepping 1 m further out per row.
const CHILD_ALONG = Object.freeze([-1.2, -0.4, 0.4, 1.2]);
const CHILD_FIRST_ROW = 1.4;
const CHILD_ROW_GAP = 1;
const STORE_KEY = 'obelisks.slots.v3'; // v3: aisle slots; older maps are ignored

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

export function rootSlotPoint(n) {
  const side = n % 2 === 0 ? -1 : 1; // first chat on the left
  return { x: side * AISLE_OFFSET, z: FIRST_ROW_Z - Math.floor(n / 2) * ROW_GAP };
}

/** Child slot n of a parent at (px, pz): rows along the aisle, on the far side from it. */
export function childSlotPoint(n, px, pz, scale = 1) {
  const out = px < 0 ? -1 : 1; // away from the aisle center line
  const along = CHILD_ALONG[n % CHILD_ALONG.length];
  const row = Math.floor(n / CHILD_ALONG.length);
  return { x: px + out * (CHILD_FIRST_ROW + row * CHILD_ROW_GAP) * scale, z: pz + along * scale };
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
  const rows = new Map(); // phase -> positions of its children
  for (const child of children) {
    const slot = childSlot(child.sid, parent.sid);
    const p = childSlotPoint(slot, parent.position.x, parent.position.z, parent.scale.x);
    place(child, p.x, p.z, parent.scale.x * CHILD_SCALE);
    placeChildren(child, all, seen);
    if (child.session.phase) {
      if (!rows.has(child.session.phase)) rows.set(child.session.phase, []);
      rows.get(child.session.phase).push(p);
    }
  }
  for (const [phase, points] of rows) {
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
    // The label lies on the floor between the parent and its children's rows.
    const z = points.reduce((sum, q) => sum + q.z, 0) / points.length;
    const nearest = points.reduce((a, q) => (Math.abs(q.x - parent.position.x) < Math.abs(a.x - parent.position.x) ? q : a));
    label.position.set((nearest.x + parent.position.x) / 2, 0.01, z);
  }
}
