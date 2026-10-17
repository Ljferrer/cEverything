import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from './bus.js';
import { hitToEvent, applySelection, rootOf, shouldInstallLaptop, latchLast } from './input.js';

// A tiny stand-in for a three.js subtree: userData lives on the mesh or on an
// ancestor, and a raycast hit names the deepest mesh.
const node = (userData, parent = null) => ({ userData, parent });

test('hitToEvent maps a base hit to select kind:base', () => {
  const base = node({ sid: 'syn-a', kind: 'base' });
  assert.deepEqual(hitToEvent({ object: base, distance: 1 }), { type: 'select', sid: 'syn-a', kind: 'base', slabId: null, object: base });
});

test('hitToEvent maps a slab hit to select kind:slab and reads userData up the parent chain', () => {
  const slab = node({ sid: 'syn-b', slabId: 'm7' });
  const glyphs = node({}, slab);
  const ev = hitToEvent({ object: glyphs, distance: 2 });
  assert.deepEqual(ev, { type: 'select', sid: 'syn-b', kind: 'slab', slabId: 'm7', object: glyphs });
});

test('hitToEvent maps no hit, and a hit with no obelisk userData, to miss', () => {
  assert.deepEqual(hitToEvent(undefined), { type: 'miss' });
  assert.deepEqual(hitToEvent(null), { type: 'miss' });
  assert.deepEqual(hitToEvent({ object: node({ floor: true }), distance: 3 }), { type: 'miss' });
});

test('applySelection emits select, sets bus.selected, and sets selectedSlab only on a slab', () => {
  const bus = createBus();
  const seen = [];
  for (const t of ['select', 'miss']) bus.addEventListener(t, (e) => seen.push([t, e.detail]));
  const slab = node({ sid: 'a', slabId: 's1' });
  applySelection(bus, hitToEvent({ object: slab }));
  assert.equal(bus.selected, 'a');
  assert.deepEqual(bus.selectedSlab, { sid: 'a', slabId: 's1' });
  assert.deepEqual(seen.at(-1), ['select', { sid: 'a', kind: 'slab', slabId: 's1', object: slab }]);
  // A base select on another obelisk moves `selected` and keeps the slab (plan 6's pipe reads both).
  const base = node({ sid: 'b', kind: 'base' });
  applySelection(bus, hitToEvent({ object: base }));
  assert.equal(bus.selected, 'b');
  assert.deepEqual(bus.selectedSlab, { sid: 'a', slabId: 's1' });
  assert.deepEqual(seen.at(-1), ['select', { sid: 'b', kind: 'base', slabId: null, object: base }]);
  // A miss emits `miss` and leaves the selection alone.
  applySelection(bus, hitToEvent(undefined));
  assert.deepEqual(seen.at(-1), ['miss', {}]);
  assert.equal(bus.selected, 'b');
});

test('rootOf accepts an Object3D or an obelisk wrapper that carries one', () => {
  const obj = { isObject3D: true };
  assert.equal(rootOf(obj), obj);
  assert.equal(rootOf({ group: obj }), obj);
  assert.equal(rootOf({ root: obj }), obj);
  assert.equal(rootOf(null), null);
  assert.equal(rootOf({}), null);
});

test('shouldInstallLaptop: ?mode=laptop, no navigator.xr, or immersive-vr unsupported installs; supported does not', async () => {
  const loc = (search) => ({ search });
  const xr = (supported) => ({ xr: { isSessionSupported: async (m) => m === 'immersive-vr' && supported } });
  assert.equal(await shouldInstallLaptop(loc('?mode=laptop'), xr(true)), true);
  assert.equal(await shouldInstallLaptop(loc(''), {}), true);
  // The phone view: Chrome exposes navigator.xr without immersive-vr.
  assert.equal(await shouldInstallLaptop(loc(''), xr(false)), true);
  assert.equal(await shouldInstallLaptop(loc('?share=x'), xr(true)), false);
  // A rejected probe means no VR session can start, so the laptop view installs.
  assert.equal(await shouldInstallLaptop(loc(''), { xr: { isSessionSupported: async () => { throw new Error('nope'); } } }), true);
});

test('latchLast holds a frame emitted before a late subscriber, follows later frames, and stops', async () => {
  const bus = createBus();
  const latched = latchLast(bus, 'mode');
  assert.equal(latched.last, null);
  // The frame lands while the install probe is still pending.
  bus.emit('mode', { t: 'mode', mode: 'synthetic', canEdit: false });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(latched.last, { t: 'mode', mode: 'synthetic', canEdit: false });
  // A later frame replaces it; the mirror arm of the finding (frame after the await).
  bus.emit('mode', { t: 'mode', mode: 'live', canEdit: true });
  assert.deepEqual(latched.last, { t: 'mode', mode: 'live', canEdit: true });
  // Another event type is not latched.
  bus.emit('session', { t: 'session', sid: 'x' });
  assert.equal(latched.last.t, 'mode');
  latched.stop();
  bus.emit('mode', { t: 'mode', mode: 'replay', canEdit: true });
  assert.deepEqual(latched.last, { t: 'mode', mode: 'live', canEdit: true });
});
