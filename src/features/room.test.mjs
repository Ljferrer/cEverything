// room.js fixed slots under node with a fake bus and a Map-backed
// localStorage: a resolve/load hook swaps troika-three-text for a stub, as
// laptop.test.mjs does. Each test imports a fresh room.js (a query string
// makes a new module instance), so module state never leaks between tests.
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const STUB_URL = new URL('./troika-stub.virtual.mjs', import.meta.url).href;
const STUB_SOURCE = `
import { Object3D } from 'three';
export class Text extends Object3D {
  text = '';
  sync() {}
  dispose() {}
}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'troika-three-text') return { url: STUB_URL, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === STUB_URL) return { format: 'module', source: STUB_SOURCE, shortCircuit: true };
    return next(url, context);
  },
});

const { PLACE } = await import('./pylons.js');

let fresh = 0;
const store = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
});

async function room() {
  const mod = await import(`./room.js?fresh=${fresh++}`);
  const bus = new EventTarget();
  mod.install({ scene: new THREE.Scene(), bus });
  const session = (sid, parent = null, phase = null) =>
    bus.dispatchEvent(
      new CustomEvent('session', { detail: { t: 'session', sid, title: sid, status: 'working', parent, phase } }),
    );
  const pos = (sid) => mod.getObelisk(sid).position.clone();
  return { mod, session, pos };
}

test('a third root moves neither earlier root', async () => {
  store.clear();
  const { mod, session, pos } = await room();
  session('a');
  session('b');
  const a = pos('a');
  const b = pos('b');
  session('c');
  assert.ok(pos('a').equals(a));
  assert.ok(pos('b').equals(b));
  const third = mod.rootSlotPoint(2);
  assert.deepEqual([pos('c').x, pos('c').z], [third.x, third.z]);
  assert.ok(pos('c').distanceTo(a) > 1 && pos('c').distanceTo(b) > 1);
});

test('a new cherub moves no sibling, and cherubs float small in ranks behind their parent', async () => {
  store.clear();
  const { mod, session, pos } = await room();
  session('p');
  for (let k = 0; k < 8; k++) session(`k${k}`, 'p', 'research');
  const k1 = pos('k1');
  session('k9', 'p', 'build');
  assert.ok(pos('k1').equals(k1), 'a new cherub moves no sibling');
  const { ox, oz } = mod.rootSlotPoint(0);
  const behind = (k) => (pos(k).x - pos('p').x) * ox + (pos(k).z - pos('p').z) * oz;
  const across = (k) => (pos(k).x - pos('p').x) * -oz + (pos(k).z - pos('p').z) * ox;
  for (let k = 0; k < 8; k++) {
    assert.ok(behind(`k${k}`) >= mod.RANK_FIRST - 1e-9, `k${k} floats behind its parent`);
    assert.ok(Math.abs(across(`k${k}`)) <= (mod.RANK_COLS / 2) * mod.RANK_STEP * (1 + mod.RANK_FAN) + 1e-9, `k${k} stays within its rank`);
    assert.ok(pos(`k${k}`).y >= mod.RANK_BASE * 0.9, `k${k} floats above the floor`);
    assert.equal(mod.getObelisk(`k${k}`).scale.x, mod.CHILD_SCALE);
  }
  assert.ok(Math.abs(across('k0')) < mod.RANK_STEP && Math.abs(across('k1')) < mod.RANK_STEP, 'a rank fills from the middle out');
  assert.ok(behind('k6') > behind('k0') && pos('k6').y > pos('k0').y, 'the next rank sits further back and higher');
});

test('WAR swarms of 160 cherubs fill stands that never collide, with each other or any chat, on any path', async () => {
  store.clear();
  const { mod, session, pos } = await room();
  const R = 12; // three chats on each path
  for (let i = 0; i < R; i++) session(`r${i}`);
  const N = 160;
  const swarms = [0, 1, 2, 3, 4, 5, 6, 7]; // the first two chats on every path, side by side and across the plaza
  for (const r of swarms) for (let k = 0; k < N; k++) session(`w${r}-${k}`, `r${r}`);
  const all = swarms.flatMap((r) => [...Array(N).keys()].map((k) => ({ r, p: pos(`w${r}-${k}`) })));
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const d = all[i].p.distanceTo(all[j].p);
      if (d < 0.5) assert.fail(`cherubs of r${all[i].r} and r${all[j].r} meet (${d.toFixed(2)} m)`);
    }
    for (let r = 0; r < R; r++) {
      if (r !== all[i].r && flat(all[i].p, pos(`r${r}`)) < 1.2) assert.fail(`a cherub of r${all[i].r} stands in r${r}`);
    }
  }
  const one = all.filter((c) => c.r === 0).map((c) => c.p);
  assert.ok(Math.max(...one.map((c) => c.y)) < 12, 'a stand, not a tower');
  assert.ok(Math.max(...one.map((c) => flat(c, pos('r0')))) > 8, 'the ranks run far behind the chat');
  const { ox, oz } = mod.rootSlotPoint(0);
  const width = (cs) => { const a = cs.map((c) => (c.x - pos('r0').x) * -oz + (c.z - pos('r0').z) * ox); return Math.max(...a) - Math.min(...a); };
  assert.ok(width(one.slice(-6)) > width(one.slice(0, 6)) * 1.3, 'the back rank spreads wider than the front: a fan, not a pillar');
});

test('a reload with a stored slot map restores every position', async () => {
  store.clear();
  const first = await room();
  for (const sid of ['a', 'b', 'c']) first.session(sid);
  first.session('k1', 'b');
  first.session('k2', 'b');
  const before = Object.fromEntries(['a', 'b', 'c', 'k1', 'k2'].map((s) => [s, first.pos(s)]));

  // A new page: sessions arrive in another order, and a newcomer comes first.
  const second = await room();
  second.session('new');
  for (const sid of ['c', 'b', 'a']) second.session(sid);
  second.session('k2', 'b');
  second.session('k1', 'b');
  for (const [sid, p] of Object.entries(before)) assert.ok(second.pos(sid).equals(p), sid);
  for (const p of Object.values(before)) assert.ok(second.pos('new').distanceTo(p) > 1);
});

test('the room works with no localStorage at all', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError');
    },
  });
  try {
    const { session, pos } = await room();
    session('a');
    session('b');
    assert.ok(pos('a').distanceTo(pos('b')) > 1);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', saved);
  }
});

test('four paths leave the center in cardinal directions, and every chat stays clear of the paths, the others, and the pylons', async () => {
  store.clear();
  const { mod, session, pos } = await room();
  const N = 24;
  for (let i = 0; i < N; i++) session(`r${i}`);
  for (let k = 0; k < 6; k++) session(`r${k}-kid`, `r${k}`);
  assert.deepEqual(mod.PATHS.map((h) => h.name), ['north', 'east', 'south', 'west']);
  for (let k = 0; k < 4; k++) {
    const far = mod.pathPoint(k, 40);
    const h = mod.PATHS[k];
    assert.ok(far.x * h.x + far.z * h.z > 35, `path ${h.name} runs out along its heading`);
    assert.ok(Math.abs(far.x * -h.z + far.z * h.x) <= h.swing + 1e-9, `path ${h.name} swings at most its own swing`);
  }
  // No pinwheel: turning the layout a quarter turn must not map the paths onto each other.
  const quarter = (p) => ({ x: -p.z, z: p.x });
  const turned = quarter(mod.pathPoint(0, 20));
  const east = mod.pathPoint(1, 20);
  assert.ok(Math.hypot(turned.x - east.x, turned.z - east.z) > 2, 'a quarter turn of the north path is not the east path');
  const near = (k) => mod.pathPoint(k, 2);
  for (let k = 0; k < 4; k++) {
    const h = mod.PATHS[k];
    assert.ok(Math.abs(near(k).x * -h.z + near(k).z * h.x) < 0.2, `path ${h.name} leaves the center straight`);
  }
  for (let i = 0; i < N; i++) {
    const slot = mod.rootSlotPoint(i);
    assert.equal(slot.path, i % 4, `r${i} takes path ${i % 4}`);
    const p = mod.pathPoint(slot.path, slot.s);
    const side = (pos(`r${i}`).x - p.x) * p.lx + (pos(`r${i}`).z - p.z) * p.lz;
    assert.ok(Math.abs(Math.abs(side) - mod.PATH_SIDE) < 1e-9, `r${i} stands PATH_SIDE from its path`);
    assert.equal(Math.sign(side), Math.floor(i / 4) % 2 === 0 ? 1 : -1, `r${i} alternates sides along its path`);
  }
  const pathPts = [0, 1, 2, 3].flatMap((k) => Array.from({ length: 1000 }, (_, i) => mod.pathPoint(k, i * 0.05)));
  const fromPath = (q) => Math.min(...pathPts.map((p) => Math.hypot(q.x - p.x, q.z - p.z)));
  const all = [...Array(N).keys()].map((i) => `r${i}`).concat([...Array(6).keys()].map((k) => `r${k}-kid`));
  for (const sid of all) {
    assert.ok(fromPath(pos(sid)) >= 2, `${sid} leaves every path clear (${fromPath(pos(sid)).toFixed(2)} m)`);
    for (const { x, z } of Object.values(PLACE)) assert.ok(Math.hypot(pos(sid).x - x, pos(sid).z - z) >= 10, `${sid} vs pylon`);
  }
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) assert.ok(pos(`r${i}`).distanceTo(pos(`r${j}`)) >= 3.5, `r${i} r${j} ${pos(`r${i}`).distanceTo(pos(`r${j}`)).toFixed(2)}`);
  const forms = new Set();
  for (let k = 0; k < 4; k++) {
    const mark = mod.landmarkOf(k);
    assert.ok(mark, `path ${mod.PATHS[k].name} ends in a landmark`);
    const end = mod.pathPoint(k, mod.pathRibbonLength(k));
    assert.ok(Math.hypot(mark.position.x - end.x, mark.position.z - end.z) <= mod.LANDMARK_PAST + 1e-6, 'it stands at the end of its path');
    assert.equal(mark.position.y, mod.LANDMARK_Y, 'it floats');
    forms.add(mark.children[0].geometry.type);
  }
  assert.equal(forms.size, 4, 'each path ends in a different shape');
  const tracks = new Set(mod.PATHS.map((h) => h.track));
  const curves = new Set(mod.PATHS.map((h) => `${h.swing}/${h.wave}`));
  assert.equal(tracks.size, 4, 'each path has its own track style');
  assert.equal(curves.size, 4, 'each path has its own curve');
  for (let k = 0; k < 4; k++) {
    const last = Math.max(...[...Array(N).keys()].filter((i) => i % 4 === k).map((i) => mod.rootSlotPoint(i).s));
    assert.ok(mod.pathRibbonLength(k) > last, `the lit ${mod.PATHS[k].name} path reaches past its farthest chat`);
  }
});
