// The shared room (PIN-22 seam): a floor grid and one obelisk per `session`
// along a single winding path. A lit ribbon on the floor marks the path: it
// leaves the viewer heading -z and swings left and right in a slow S toward
// the tool monoliths. Chats alternate sides of it, so one walk along the path
// passes every chat. Children stand in short rows behind their parent, on the
// side away from the path, at 0.6 scale, with one floor label per shared
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
// The path: x = PATH_SWING * sin(2 pi u / PATH_WAVE) at depth z = -u, so it
// starts on the viewer's line of sight and swings 5 m to each side.
export const PATH_SWING = 5;
export const PATH_WAVE = 48;
export const PATH_WIDTH = 1.4; // the lit ribbon on the floor
// Root slots: alternate left and right of the path, PATH_SIDE from its center
// line, one chat every CHAT_GAP of path length, starting FIRST_S along it.
export const PATH_SIDE = 3.2;
export const CHAT_GAP = 2.6;
export const FIRST_S = 3;
// Child slots: rows of four running along the path, 1 m apart, starting
// 1.6 m outward from the parent and stepping 1 m further out per row.
const CHILD_ALONG = Object.freeze([-1.5, -0.5, 0.5, 1.5]);
const CHILD_FIRST_ROW = 1.6;
const CHILD_ROW_GAP = 1;
const STORE_KEY = 'obelisks.slots.v3'; // slot numbers keep their order on the path, so v3 maps still apply

/** @type {Map<string, Obelisk>} */
const obelisks = new Map();
/** @type {Map<string, Text>} keyed `${parent sid}\u0000${phase}` */
const phaseLabels = new Map();
let room = null;
let ribbon = null; // the lit path on the floor; it grows with the chats
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
  // A faint red grid over the floor texture, in the SEELE red.
  const grid = new THREE.GridHelper(12, 24, 0x5a0e08, 0x2a0604);
  grid.material.transparent = true;
  grid.material.opacity = 0.4;
  room.add(grid);
  scene.add(room);

  // While timeline.js holds the room scrubbed back (`bus.scrubbed`), only its re-emitted (`replayed`) frames apply.
  const shown = (fn) => (e) => (!bus.scrubbed || e.detail?.replayed) && fn(e.detail);
  bus.addEventListener('session', shown(onSession));
  bus.addEventListener('slab', shown((d) => getObelisk(d.sid)?.addSlab(d)));
  bus.addEventListener('delta', shown((d) => getObelisk(d.sid)?.appendDelta(d)));
  bus.addEventListener('state', shown((d) => getObelisk(d.sid)?.setState(d.status)));
  bus.addEventListener('frame', (e) => {
    for (const o of obelisks.values()) o.update(e.detail.camera);
  });
}

/** Remove every obelisk and phase label from the scene; the slot map stays, so a rebuild lands in the same places. */
export function reset() {
  for (const o of obelisks.values()) {
    room?.remove(o);
    o.dispose();
  }
  obelisks.clear();
  for (const label of phaseLabels.values()) {
    room?.remove(label);
    label.dispose();
  }
  phaseLabels.clear();
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

// Arc length table for the path, grown on demand: samples[i] is the point at u = i * PATH_DU.
const PATH_DU = 0.05;
const pathX = (u) => PATH_SWING * Math.sin((2 * Math.PI * u) / PATH_WAVE);
const samples = [{ u: 0, s: 0 }];

/**
 * The path point `s` meters along it: `{x, z}` plus the unit heading `(tx, tz)`
 * and the unit left normal `(lx, lz)` (the left hand of a walker on the path).
 */
export function pathPoint(s) {
  while (samples.at(-1).s < s) {
    const { u, s: prev } = samples.at(-1);
    const u2 = u + PATH_DU;
    samples.push({ u: u2, s: prev + Math.hypot(pathX(u2) - pathX(u), PATH_DU) });
  }
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].s < s) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const u = b.s === a.s ? a.u : a.u + ((s - a.s) / (b.s - a.s)) * (b.u - a.u);
  const dx = ((2 * Math.PI * PATH_SWING) / PATH_WAVE) * Math.cos((2 * Math.PI * u) / PATH_WAVE);
  const len = Math.hypot(dx, 1);
  const tx = dx / len;
  const tz = -1 / len;
  return { x: pathX(u), z: -u, tx, tz, lx: tz, lz: -tx };
}

/** Root slot n: alternate sides of the path, first on the left; `(ox, oz)` points away from the path. */
export function rootSlotPoint(n) {
  const s = FIRST_S + n * CHAT_GAP;
  const p = pathPoint(s);
  const side = n % 2 === 0 ? 1 : -1; // +1 left, -1 right
  const ox = side * p.lx;
  const oz = side * p.lz;
  return { x: p.x + ox * PATH_SIDE, z: p.z + oz * PATH_SIDE, ox, oz, s };
}

/** Child slot n of a parent at `(x, z)` facing away from the path along `(ox, oz)`: rows along the path, behind the parent. */
export function childSlotPoint(n, { x, z, ox, oz }, scale = 1) {
  const along = CHILD_ALONG[n % CHILD_ALONG.length];
  const row = Math.floor(n / CHILD_ALONG.length);
  const out = (CHILD_FIRST_ROW + row * CHILD_ROW_GAP) * scale;
  return { x: x + ox * out - oz * along * scale, z: z + oz * out + ox * along * scale, ox, oz };
}

/** A flat ribbon PATH_WIDTH wide along the path from 0 to `length` meters, just above the floor. */
function pathRibbon(length) {
  const steps = Math.max(2, Math.ceil(length / 0.5));
  const pos = [];
  const index = [];
  for (let i = 0; i <= steps; i++) {
    const p = pathPoint((i / steps) * length);
    const h = PATH_WIDTH / 2;
    pos.push(p.x + p.lx * h, 0.01, p.z + p.lz * h, p.x - p.lx * h, 0.01, p.z - p.lz * h);
    if (i < steps) index.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff3b1f, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }));
  mesh.name = 'path';
  mesh.userData = { kind: 'path', length };
  mesh.raycast = () => {}; // the path never takes a pick
  return mesh;
}

/** The length of the lit path on the floor, 0 before the first layout. */
export const pathRibbonLength = () => ribbon?.userData.length ?? 0;

/** Lay the ribbon to just past the farthest chat, at least the first stretch; rebuilt only when it must grow. */
function layPath(farthest) {
  const length = Math.max(20, farthest + CHAT_GAP * 2);
  if (ribbon && ribbon.userData.length >= length) return;
  if (ribbon) {
    room.remove(ribbon);
    ribbon.geometry.dispose();
  }
  ribbon = pathRibbon(length);
  room.add(ribbon);
}


function place(o, { x, z, ox, oz }, scale) {
  o.position.set(x, 0, z);
  o.userData.out = { x: ox, z: oz }; // away from the path; children line up behind it
  o.scale.setScalar(scale);
  o.lookAt(0, 0, 0); // initial facing; obelisk.update(camera) turns it to the viewer
}

const isRoot = (o) => !o.session.parent || !obelisks.has(o.session.parent);

/** Place every obelisk at its fixed slot and every phase label. Idempotent; runs on every `session` event. */
export function layout() {
  const all = [...obelisks.values()]; // arrival order, so a new sid claims the next free slot
  const seen = new Set();
  let farthest = 0;
  for (const o of all.filter(isRoot)) {
    const p = rootSlotPoint(rootSlot(o.sid));
    farthest = Math.max(farthest, p.s);
    place(o, p, 1);
    placeChildren(o, all, seen);
  }
  layPath(farthest);
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
    const { out } = parent.userData;
    const p = childSlotPoint(slot, { x: parent.position.x, z: parent.position.z, ox: out.x, oz: out.z }, parent.scale.x);
    place(child, p, parent.scale.x * CHILD_SCALE);
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
    // The label lies on the floor between the parent and its nearest child.
    const d = (q) => Math.hypot(q.x - parent.position.x, q.z - parent.position.z);
    const nearest = points.reduce((a, q) => (d(q) < d(a) ? q : a));
    label.position.set((nearest.x + parent.position.x) / 2, 0.01, (nearest.z + parent.position.z) / 2);
  }
}
