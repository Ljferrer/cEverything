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

test('a new child moves no sibling, and each stands in a row behind its parent', async () => {
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
  for (const k of ['k1', 'k2', 'k3']) {
    const dx = pos(k).x - pos('p').x;
    const dz = pos(k).z - pos('p').z;
    assert.ok(dx * ox + dz * oz > 1, `${k} stands behind its parent, away from the path`);
    assert.ok(Math.abs(dx * -oz + dz * ox) <= 1.5 + 1e-9, `${k} within its parent's row length`);
  }
  assert.equal(mod.getObelisk('k3').scale.x, mod.CHILD_SCALE);
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

test('roots alternate sides of a winding path, and every chat stays clear of the path, the others, and the pylons', async () => {
  store.clear();
  const { mod, session, pos } = await room();
  const N = 24;
  for (let i = 0; i < N; i++) session(`r${i}`);
  for (let k = 0; k < 6; k++) session(`r${k}-kid`, `r${k}`);
  const xs = [];
  for (let i = 0; i < N; i++) {
    const slot = mod.rootSlotPoint(i);
    const p = mod.pathPoint(slot.s);
    const side = (pos(`r${i}`).x - p.x) * p.lx + (pos(`r${i}`).z - p.z) * p.lz;
    assert.ok(Math.abs(Math.abs(side) - mod.PATH_SIDE) < 1e-9, `r${i} stands PATH_SIDE from the path`);
    assert.equal(Math.sign(side), i % 2 === 0 ? 1 : -1, `r${i} on the ${i % 2 === 0 ? 'left' : 'right'}`);
    xs.push(p.x);
  }
  assert.ok(Math.max(...xs) - Math.min(...xs) > 2 * mod.PATH_SWING * 0.9, 'the path swings side to side, not a straight hallway');
  // Distance to the path: sample it finely.
  const pathPts = Array.from({ length: 2000 }, (_, i) => mod.pathPoint(i * 0.05));
  const fromPath = (q) => Math.min(...pathPts.map((p) => Math.hypot(q.x - p.x, q.z - p.z)));
  const all = [...Array(N).keys()].map((i) => `r${i}`).concat([...Array(6).keys()].map((k) => `r${k}-kid`));
  for (const sid of all) {
    assert.ok(fromPath(pos(sid)) >= 2, `${sid} leaves the path clear (${fromPath(pos(sid)).toFixed(2)} m)`);
    for (const { x, z } of Object.values(PLACE)) assert.ok(Math.hypot(pos(sid).x - x, pos(sid).z - z) >= 10, `${sid} vs pylon`);
  }
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) assert.ok(pos(`r${i}`).distanceTo(pos(`r${j}`)) >= 3.5, `r${i} r${j} ${pos(`r${i}`).distanceTo(pos(`r${j}`)).toFixed(2)}`);
  const ribbon = mod.pathRibbonLength();
  assert.ok(ribbon > mod.rootSlotPoint(N - 1).s, 'the lit path reaches past the farthest chat');
});
