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

test('a new cherub moves no sibling, and cherubs float small on both sides of their parent', async () => {
  store.clear();
  const { mod, session, pos } = await room();
  session('p');
  session('k1', 'p', 'research');
  session('k2', 'p', 'research');
  const k1 = pos('k1');
  const k2 = pos('k2');
  session('k3', 'p', 'build');
  assert.ok(pos('k1').equals(k1));
  assert.ok(pos('k2').equals(k2));
  const { ox, oz } = mod.rootSlotPoint(0);
  const across = (k) => (pos(k).x - pos('p').x) * -oz + (pos(k).z - pos('p').z) * ox;
  assert.ok(across('k1') > 1 && across('k2') < -1, 'the first two take opposite wings');
  const behind = (k) => (pos(k).x - pos('p').x) * ox + (pos(k).z - pos('p').z) * oz;
  for (const k of ['k1', 'k2', 'k3']) assert.ok(behind(k) >= mod.WING_BACK - 1e-9, `${k} floats behind its parent, away from the path`);
  for (const k of ['k1', 'k2', 'k3']) {
    assert.ok(pos(k).y >= mod.WING_BASE * 0.9, `${k} floats above the floor (y ${pos(k).y})`);
    assert.equal(mod.getObelisk(k).scale.x, mod.CHILD_SCALE);
  }
});

test('a WAR swarm of 160 cherubs builds two wings that never collide or reach a neighbor chat', async () => {
  store.clear();
  const { mod, session, pos } = await room();
  for (let i = 0; i < 12; i++) session(`r${i}`);
  const N = 160;
  for (let k = 0; k < N; k++) session(`w${k}`, 'r0');
  const cherubs = [...Array(N).keys()].map((k) => pos(`w${k}`));
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) assert.ok(cherubs[i].distanceTo(cherubs[j]) >= 0.5, `w${i} w${j} ${cherubs[i].distanceTo(cherubs[j]).toFixed(2)}`);
  }
  const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  for (const c of cherubs) {
    assert.ok(flat(c, pos('r0')) >= 1, 'no cherub stands inside its parent');
    for (let r = 1; r < 12; r++) assert.ok(flat(c, pos(`r${r}`)) >= 1.2, `a cherub reaches r${r}`);
  }
  // The next chat on the same path and side (slot 8) carries its own swarm: the two wings must not meet.
  for (let k = 0; k < N; k++) session(`v${k}`, 'r8');
  for (let k = 0; k < N; k++) {
    for (let j = 0; j < N; j++) assert.ok(pos(`w${k}`).distanceTo(pos(`v${j}`)) >= 0.5, `w${k} meets v${j}`);
  }
  assert.ok(Math.max(...cherubs.map((c) => c.y)) > 10, 'a big swarm towers over the path');
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
