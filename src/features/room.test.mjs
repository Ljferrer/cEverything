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
  assert.deepEqual([pos('c').x, pos('c').z], [mod.GRID_COLUMNS[2], mod.FIRST_ROW_Z]);
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
  for (const k of ['k1', 'k2', 'k3']) {
    assert.ok(pos(k).z < pos('p').z - 1, `${k} behind its parent`);
    assert.ok(Math.abs(pos(k).x - pos('p').x) <= 1.2 + 1e-9, `${k} within its parent's row width`);
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

test('roots fill rows of three, 4 m apart, receding 5 m per row, and every slot stays clear of every pylon', async () => {
  store.clear();
  const { mod, session, pos } = await room();
  for (let i = 0; i < 9; i++) session(`r${i}`);
  assert.deepEqual([pos('r0').x, pos('r0').z], [0, mod.FIRST_ROW_Z]);
  assert.deepEqual([pos('r1').x, pos('r1').z], [-4, mod.FIRST_ROW_Z]);
  assert.deepEqual([pos('r3').x, pos('r3').z], [0, mod.FIRST_ROW_Z - mod.ROW_GAP]);
  for (let i = 0; i < 9; i++) {
    for (let j = i + 1; j < 9; j++) assert.ok(pos(`r${i}`).distanceTo(pos(`r${j}`)) >= 4, `r${i} r${j}`);
    for (const { x, z } of Object.values(PLACE)) assert.ok(Math.hypot(pos(`r${i}`).x - x, pos(`r${i}`).z - z) >= 3, `r${i} vs pylon`);
  }
});
