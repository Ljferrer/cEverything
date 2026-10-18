// The shared room (PIN-22 seam): a floor grid and one obelisk per `session`
// along four winding paths. Lit ribbons on the floor mark the paths: each
// leaves the center straight in a cardinal direction (north -z, east +x, south
// +z, west -x), then winds toward the tool monolith at its end. Each path has
// its own curve and its own track (see PATHS): a lit ribbon, stepping stones,
// twin rails, or a line of lights. Their first bends do not all turn the
// same way round, and their swings differ, so the four never read as a
// pinwheel or any rotational symbol. Chats fill the paths in
// turn and alternate sides along each, so one walk along a path passes every
// chat on it. Subagents float behind their parent like cherubs, small, in
// tiered ranks (see RANK_*); a WAR swarm of a hundred or more fills a rising
// stand behind its chat. One floor label per shared `phase`
// (PIN-21). A session takes the next free slot when first seen and
// keeps it, so nothing moves when another chat arrives: the room is spatial
// memory. When the relay's chat list leaves chats out (the CHATS pick, or a
// smaller relay), the slots pack down to the chats in the room, in their old
// order, and each path shrinks to just past its last chat. The sid -> slot
// map lives in localStorage, so a reload puts every known sid back where it
// was. Routes `slab`, `delta`, and `state` to the matching obelisk.
import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { Obelisk } from '../obelisk.js';

export const RING_RADIUS = 3; // distance to the first row (kept for callers)
export const CHILD_RADIUS = 1; // reach of a child row around its parent (kept for callers)
export const CHILD_SCALE = 0.3; // a subagent cherub, against its parent
// Each path, in its own frame: bend * swing * sin(2 pi u / wave) to the
// walker's right at u meters out along its heading, eased in over the first
// PATH_RAMP meters so it leaves the center straight.
export const PATH_RAMP = 10;
export const PATH_WIDTH = 1.4; // the width of every track on the floor
// Root slots: slot n goes on path n % 4, as chat floor(n / 4) along it. Chats
// alternate left and right, PATH_SIDE from the center line, one every CHAT_GAP
// of path length, starting FIRST_S out (the center stays an open plaza).
export const PATH_SIDE = 3.2;
export const CHAT_GAP = 3.5; // room for both neighbors' wings, even on the inside of a bend
export const FIRST_S = 12;
/**
 * The four paths, in slot order. `(x, z)` is the heading; `bend` is the first
 * turn (+1 the walker's right, -1 the left); `swing` and `wave` set the curve
 * in meters; `track` and `color` set what lies on the floor.
 */
export const PATHS = Object.freeze([
  Object.freeze({ name: 'north', x: 0, z: -1, bend: -1, swing: 5, wave: 48, track: 'ribbon', color: 0xff3b1f }),
  Object.freeze({ name: 'east', x: 1, z: 0, bend: -1, swing: 3, wave: 34, track: 'stones', color: 0xffb74d }),
  Object.freeze({ name: 'south', x: 0, z: 1, bend: 1, swing: 7, wave: 64, track: 'rails', color: 0xdddddd }),
  Object.freeze({ name: 'west', x: -1, z: 0, bend: 1, swing: 2.5, wave: 30, track: 'lights', color: 0xb388ff }),
]);
/** The largest sideways swing of any path. */
export const PATH_SWING = Math.max(...PATHS.map((p) => p.swing));
// Cherub slots (at parent scale 1): ranks behind the parent, like seats in a
// stand. Each rank holds RANK_COLS cherubs RANK_STEP apart, filled from the
// middle out; the first rank floats RANK_FIRST behind the parent and RANK_BASE
// up, and each rank after it RANK_BACK further back and RANK_RISE higher, so
// every cherub shows over the rank in front, and spreads RANK_FAN wider than
// it, so a big swarm fans out like a tail. The ranks run diagonally away
// from both the path and the center (the parent's `back`), so the stands of
// neighboring chats, even on two paths, run side by side and never cross.
export const RANK_COLS = 6;
export const RANK_STEP = 0.6;
export const RANK_FIRST = 1.4;
export const RANK_BACK = 0.55;
export const RANK_BASE = 0.6;
export const RANK_RISE = 0.35;
export const RANK_FAN = 0.03; // each rank spreads this much wider than the one in front, so the stand fans out
const RANK_ORDER = Object.freeze([-0.5, 0.5, -1.5, 1.5, -2.5, 2.5]); // column offsets, middle out
export const BOB_M = 0.05; // cherubs bob this far up and down
const BOB_HZ = 0.25;
const STORE_KEY = 'obelisks.slots.v3'; // slot numbers keep their order on the path, so v3 maps still apply

/** @type {Map<string, Obelisk>} */
const obelisks = new Map();
/** @type {Map<string, Text>} keyed `${parent sid}\u0000${phase}` */
const phaseLabels = new Map();
let room = null;
const ribbons = []; // the lit paths on the floor, one per heading; each grows with its chats
const landmarks = []; // one distinct floating shape at the end of each path
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
  // The relay sends its chat list before any session, and again when it changes.
  bus.addEventListener('chats', (e) => packSlots(e.detail.include ?? e.detail.chats.map((c) => c.sid)));
  bus.addEventListener('slab', shown((d) => getObelisk(d.sid)?.addSlab(d)));
  bus.addEventListener('delta', shown((d) => getObelisk(d.sid)?.appendDelta(d)));
  bus.addEventListener('state', shown((d) => getObelisk(d.sid)?.setState(d.status)));
  bus.addEventListener('frame', (e) => {
    const t = (e.detail.now ?? performance.now()) / 1000;
    landmarks.forEach((m, k) => m.rotation.set(0.4 * Math.sin(t * 0.5 + k), t * LANDMARK_SPIN * (k % 2 ? -1 : 1), 0));
    for (const o of obelisks.values()) {
      const f = o.userData.float;
      if (f) o.position.y = f.y + BOB_M * Math.sin(2 * Math.PI * BOB_HZ * t + f.phase);
      o.update(e.detail.camera);
    }
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

/**
 * Keep the stored slots of `sids` (the main chats in the room), in their
 * stored order, packed from 0, and forget every other chat's slot. When the
 * slots are already packed, as when a chat is added, nothing moves.
 */
export function packSlots(sids) {
  const listed = new Set(sids);
  // A main chat the list leaves out leaves the room, with every subagent under it.
  const rootSid = (o) => {
    let r = o;
    for (let i = 0; i < 16 && r.session.parent && obelisks.has(r.session.parent); i++) r = obelisks.get(r.session.parent);
    return r.sid;
  };
  const gone = [...obelisks.values()].filter((o) => !listed.has(rootSid(o)));
  for (const o of gone) {
    room?.remove(o);
    o.dispose();
    obelisks.delete(o.sid);
  }
  const kept = sids.filter((sid) => Number.isInteger(slots.root[sid])).sort((a, b) => slots.root[a] - slots.root[b]);
  const next = Object.fromEntries(kept.map((sid, i) => [sid, i]));
  const same = Object.keys(next).length === Object.keys(slots.root).length && kept.every((sid) => slots.root[sid] === next[sid]);
  if (same && !gone.length) return;
  slots.root = next;
  saveSlots();
  if (room) layout();
}

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

// Arc length tables, one per path, grown on demand: samples[k][i] is path k at u = i * PATH_DU.
const PATH_DU = 0.05;
const ramp = (u) => {
  const t = Math.min(1, Math.max(0, u / PATH_RAMP));
  return t * t * (3 - 2 * t); // smoothstep: flat at the center, full swing past PATH_RAMP
};
/** Path k's sideways offset to the walker's right at u meters out. */
const pathX = (k, u) => {
  const { bend, swing, wave } = PATHS[k];
  return bend * swing * Math.sin((2 * Math.PI * u) / wave) * ramp(u);
};
const tables = PATHS.map(() => [{ u: 0, s: 0 }]);

/**
 * The point `s` meters along path `k` (an index into PATHS): `{x, z}` plus the
 * unit heading `(tx, tz)` and the unit left normal `(lx, lz)` (the left hand
 * of a walker on the path). Every path has the same shape in its own frame.
 */
export function pathPoint(k, s) {
  const samples = tables[k];
  while (samples.at(-1).s < s) {
    const { u, s: prev } = samples.at(-1);
    const u2 = u + PATH_DU;
    samples.push({ u: u2, s: prev + Math.hypot(pathX(k, u2) - pathX(k, u), PATH_DU) });
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
  const f = PATHS[k];
  const rx = -f.z; // the walker's right
  const rz = f.x;
  const side = pathX(k, u);
  const h = 0.01;
  const dx = (pathX(k, u + h) - pathX(k, Math.max(0, u - h))) / (u + h - Math.max(0, u - h));
  const len = Math.hypot(dx, 1);
  const tx = (f.x + rx * dx) / len;
  const tz = (f.z + rz * dx) / len;
  return { x: f.x * u + rx * side, z: f.z * u + rz * side, tx, tz, lx: tz, lz: -tx };
}

/**
 * Root slot n: path n % 4, alternate sides along it, first on the left.
 * `(ox, oz)` is the chat's back: the unit direction its cherub ranks run,
 * away from the path and out along it, half and half.
 */
export function rootSlotPoint(n) {
  const k = n % PATHS.length;
  const i = Math.floor(n / PATHS.length);
  const s = FIRST_S + i * CHAT_GAP;
  const p = pathPoint(k, s);
  const side = i % 2 === 0 ? 1 : -1; // +1 left, -1 right
  const sx = side * p.lx; // straight away from the path
  const sz = side * p.lz;
  const bx = sx + p.tx;
  const bz = sz + p.tz;
  const len = Math.hypot(bx, bz);
  return { x: p.x + sx * PATH_SIDE, z: p.z + sz * PATH_SIDE, ox: bx / len, oz: bz / len, s, path: k };
}

/**
 * Cherub slot n of a parent at `(x, y, z)` whose back is `(ox, oz)`: rank
 * floor(n / RANK_COLS), filled from the middle out, each rank further back and
 * higher. Returns the cherub's `{x, y, z, ox, oz}`; its own cherubs rank the same way behind it.
 */
export function childSlotPoint(n, { x, y = 0, z, ox, oz }, scale = 1) {
  const rank = Math.floor(n / RANK_COLS);
  const across = RANK_ORDER[n % RANK_COLS] * RANK_STEP * (1 + rank * RANK_FAN) * scale;
  const back = (RANK_FIRST + rank * RANK_BACK) * scale;
  return {
    x: x + -oz * across + ox * back,
    y: y + (RANK_BASE + rank * RANK_RISE) * scale,
    z: z + ox * across + oz * back,
    ox,
    oz,
  };
}

/** Points along path `k` every `step` meters out to `length`, each with its left normal. */
function along(k, length, step) {
  const n = Math.max(2, Math.ceil(length / step));
  return Array.from({ length: n + 1 }, (_, i) => pathPoint(k, (i / n) * length));
}

/** Push a flat quad (two triangles) centered at `p`, `w` across and `d` along the path, just above the floor. */
function quad(pos, index, p, w, d) {
  const b = pos.length / 3;
  const [ax, az, lx, lz] = [p.tx * d / 2, p.tz * d / 2, p.lx * w / 2, p.lz * w / 2];
  for (const [sa, sl] of [[-1, 1], [-1, -1], [1, 1], [1, -1]]) pos.push(p.x + sa * ax + sl * lx, 0.01, p.z + sa * az + sl * lz);
  index.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
}

/** Each track draws as one object, so a longer path never adds draw calls. */
const TRACKS = {
  /** A solid lit strip. */
  ribbon(k, length, material) {
    const pos = [];
    const index = [];
    const pts = along(k, length, 0.5);
    const h = PATH_WIDTH / 2;
    pts.forEach((p, i) => {
      pos.push(p.x + p.lx * h, 0.01, p.z + p.lz * h, p.x - p.lx * h, 0.01, p.z - p.lz * h);
      if (i < pts.length - 1) index.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    });
    return new THREE.Mesh(indexed(pos, index), material.mesh);
  },
  /** Square stepping stones, one every 1.1 m. */
  stones(k, length, material) {
    const pos = [];
    const index = [];
    for (const p of along(k, length, 1.1)) quad(pos, index, p, PATH_WIDTH * 0.7, 0.7);
    return new THREE.Mesh(indexed(pos, index), material.mesh);
  },
  /** Two rails at the track's edges, with a tie across every 0.8 m. */
  rails(k, length, material) {
    const pts = along(k, length, 0.4);
    const h = PATH_WIDTH / 2;
    const v = [];
    pts.forEach((p, i) => {
      if (i > 0) {
        const q = pts[i - 1];
        for (const sl of [1, -1]) v.push(q.x + sl * q.lx * h, 0.02, q.z + sl * q.lz * h, p.x + sl * p.lx * h, 0.02, p.z + sl * p.lz * h);
      }
      if (i % 2 === 0) v.push(p.x + p.lx * h, 0.02, p.z + p.lz * h, p.x - p.lx * h, 0.02, p.z - p.lz * h);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    return new THREE.LineSegments(g, material.line);
  },
  /** A line of glowing lights down the center, one every 0.9 m. */
  lights(k, length, material) {
    const v = along(k, length, 0.9).flatMap((p) => [p.x, 0.06, p.z]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    return new THREE.Points(g, material.points);
  },
};

function indexed(pos, index) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

/** Path `k`'s track from the center to `length` meters, in its own style and color. */
function pathRibbon(k, length) {
  const { track, color, name } = PATHS[k];
  const material = {
    mesh: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide }),
    line: new THREE.LineBasicMaterial({ color }),
    points: new THREE.PointsMaterial({ color, size: 0.22, sizeAttenuation: true }),
  };
  const obj = TRACKS[track](k, length, material);
  obj.name = `path:${name}`;
  obj.userData = { kind: 'path', path: k, track, length };
  obj.raycast = () => {}; // a track never takes a pick
  return obj;
}

// One shape per path, in PATHS order, each its own form so a path is known by its end.
const LANDMARK_SHAPES = Object.freeze([
  () => new THREE.TorusKnotGeometry(0.9, 0.28, 96, 12, 2, 3),
  () => new THREE.IcosahedronGeometry(1.2, 0),
  () => new THREE.OctahedronGeometry(1.3, 0),
  () => new THREE.TorusGeometry(1.1, 0.35, 12, 36),
]);
export const LANDMARK_Y = 2.6; // the shapes float at this height
export const LANDMARK_PAST = 3; // and stand this far past the end of their lit path
const LANDMARK_SPIN = 0.3; // radians per second

/** The floating shape at the end of path `k`: wireframe in SEELE red, solid black inside so it reads against the sky. */
function makeLandmark(k) {
  const geometry = LANDMARK_SHAPES[k]();
  const g = new THREE.Group();
  g.name = `landmark:${PATHS[k].name}`;
  g.userData = { kind: 'landmark', path: k };
  const core = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x050505 }));
  const wire = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 1), new THREE.LineBasicMaterial({ color: 0xff2a1a }));
  for (const part of [core, wire]) {
    part.raycast = () => {}; // a landmark never takes a pick
    g.add(part);
  }
  return g;
}

/** Stand landmark `k` just past the end of its lit path, `length` meters out. */
function placeLandmark(k, length) {
  if (!landmarks[k]) {
    landmarks[k] = makeLandmark(k);
    room.add(landmarks[k]);
  }
  const p = pathPoint(k, length);
  landmarks[k].position.set(p.x + p.tx * LANDMARK_PAST, LANDMARK_Y, p.z + p.tz * LANDMARK_PAST);
}

/** The floating shape at the end of path `k`, or null before the first layout. */
export const landmarkOf = (k) => landmarks[k] ?? null;

/** The length of lit path `k` on the floor, 0 before the first layout. */
export const pathRibbonLength = (k) => ribbons[k]?.userData.length ?? 0;

/** Lay ribbon `k` to just past its farthest chat (at least the first stretch); rebuilt whenever that length changes, so it grows and shrinks. */
function layPath(k, farthest) {
  const length = Math.max(FIRST_S + CHAT_GAP, farthest + CHAT_GAP * 2);
  if (ribbons[k] && ribbons[k].userData.length === length) return;
  if (ribbons[k]) {
    room.remove(ribbons[k]);
    ribbons[k].geometry.dispose();
    ribbons[k].material.dispose();
  }
  ribbons[k] = pathRibbon(k, length);
  room.add(ribbons[k]);
  placeLandmark(k, length);
}


function place(o, { x, y = 0, z, ox, oz }, scale) {
  o.position.set(x, y, z);
  // A cherub floats: the frame loop bobs it about `y`, each on its own phase.
  o.userData.float = y > 0 ? { y, phase: (x * 7.3 + z * 3.1) % (2 * Math.PI) } : null;
  o.userData.out = { x: ox, z: oz }; // the chat's back: its cherub ranks run this way
  o.scale.setScalar(scale);
  o.lookAt(0, 0, 0); // initial facing; obelisk.update(camera) turns it to the viewer
}

const isRoot = (o) => !o.session.parent || !obelisks.has(o.session.parent);

/** Place every obelisk at its fixed slot and every phase label. Idempotent; runs on every `session` event. */
export function layout() {
  const all = [...obelisks.values()]; // arrival order, so a new sid claims the next free slot
  const seen = new Set();
  const farthest = PATHS.map(() => 0);
  for (const o of all.filter(isRoot)) {
    const p = rootSlotPoint(rootSlot(o.sid));
    farthest[p.path] = Math.max(farthest[p.path], p.s);
    place(o, p, 1);
    placeChildren(o, all, seen);
  }
  PATHS.forEach((_, k) => layPath(k, farthest[k]));
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
    const base = parent.userData.float?.y ?? parent.position.y;
    const p = childSlotPoint(slot, { x: parent.position.x, y: base, z: parent.position.z, ox: out.x, oz: out.z }, parent.scale.x);
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
