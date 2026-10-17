// Obelisk glue under node. troika-three-text needs a DOM, so a resolve/load
// hook swaps it for a stub Text whose `sync` queues its callback until the
// test measures it. three itself loads fine under node.
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const STUB_URL = new URL('./troika-stub.virtual.mjs', import.meta.url).href;
const STUB_SOURCE = `
import { Object3D } from 'three';
export class Text extends Object3D {
  static pending = [];
  text = '';
  textRenderInfo = null;
  sync(cb) { Text.pending.push({ text: this, cb }); }
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

const { Text } = await import('troika-three-text');
const { Obelisk, STACK_BOTTOM } = await import('./obelisk.js');
const { BAR_HEIGHT } = await import('./stack.js');

// Oracle measurement, independent of stack.js: about 30 characters per
// wrapped line at fontSize 0.04, 0.048 m per line, anchorY bottom.
const LINE = 0.048;
function measure(text) {
  return Math.ceil(text.length / 30) * LINE;
}
function flushSyncs() {
  const batch = Text.pending.splice(0);
  for (const { text, cb } of batch) {
    text.textRenderInfo = { blockBounds: [-0.3, 0, 0.3, measure(text.text)] };
    cb?.();
  }
}

function cameraAt(z) {
  const cam = new THREE.Object3D();
  cam.position.set(0, STACK_BOTTOM, z);
  cam.updateMatrixWorld(true);
  return cam;
}

// The visible height of a slab as the viewer sees it: the bar when the text
// is hidden, else the measured text span.
function shownHeight(slab) {
  return slab.text.visible ? measure(slab.text.text) : BAR_HEIGHT;
}

function assertNoOverlap(obelisk) {
  const shown = obelisk.slabs.filter((s) => s.visible);
  for (let i = 0; i + 1 < shown.length; i++) {
    const top = shown[i].position.y + shownHeight(shown[i]);
    assert.ok(top <= shown[i + 1].position.y + 1e-9, `slab ${shown[i].slabId} (top ${top.toFixed(3)}) draws over ${shown[i + 1].slabId} (bottom ${shown[i + 1].position.y.toFixed(3)})`);
  }
}

function roomWith(texts) {
  const obelisk = new Obelisk({ sid: 's1', title: 'T', status: 'idle' });
  texts.forEach((text, i) => obelisk.addSlab({ id: `a${i}`, role: 'assistant', text }));
  flushSyncs();
  obelisk.updateMatrixWorld(true);
  return obelisk;
}

const LONG = ['alpha '.repeat(30).trim(), 'beta '.repeat(36).trim(), 'gamma '.repeat(20).trim()]; // 179, 179, 119 chars: 4 to 6 lines each
const SHORT = ['one short line', 'two lines of text that wrap once at thirty', 'three']; // all under 80 chars

test('a fresh stack lays out by measured height once the first syncs land', () => {
  const o = roomWith(LONG);
  assert.deepEqual(o.slabs.map((s) => s.band), [null, null, null]);
  assertNoOverlap(o);
  assert.ok(o.slabs[1].position.y >= measure(LONG[0]), 'the second slab clears the six-line first slab');
});

test('far to near with changed text re-lays out when the full text lands', () => {
  const o = roomWith(LONG);
  o.update(cameraAt(3));
  flushSyncs();
  o.update(cameraAt(6)); // the stack packs at bar height
  o.updateMatrixWorld(true);
  o.update(cameraAt(1)); // summaries become full texts: a sync is queued
  assert.equal(Text.pending.length, 3);
  flushSyncs(); // the full texts land, taller than their summaries
  assert.deepEqual(o.slabs.map((s) => s.band), ['near', 'near', 'near']);
  assert.deepEqual(o.slabs.map((s) => s.text.text), LONG);
  assertNoOverlap(o);
});

test('a mid stack lays out by measured height after the first sync', () => {
  const o = roomWith(LONG);
  o.update(cameraAt(3));
  flushSyncs(); // the mid summaries land
  o.updateMatrixWorld(true);
  assert.deepEqual(o.slabs.map((s) => s.band), ['mid', 'mid', 'mid']);
  assertNoOverlap(o);
});

test('a far retreat packs the stack at bar height', () => {
  const o = roomWith(LONG);
  o.update(cameraAt(3));
  flushSyncs();
  o.update(cameraAt(6));
  assert.deepEqual(o.slabs.map((s) => s.band), ['far', 'far', 'far']);
  assert.deepEqual(o.slabs.map((s) => s.text.visible), [false, false, false]);
  assertNoOverlap(o);
  assert.ok(o.slabs[1].position.y < 2 * BAR_HEIGHT, 'bars sit at bar pitch');
});

test('far to mid with unchanged summaries re-lays out at the measured heights without a new sync', () => {
  const o = roomWith(LONG);
  o.update(cameraAt(3));
  flushSyncs();
  const summaries = o.slabs.map((s) => s.text.text);
  o.update(cameraAt(6));
  o.updateMatrixWorld(true);
  o.update(cameraAt(3));
  assert.deepEqual(o.slabs.map((s) => s.band), ['mid', 'mid', 'mid']);
  assert.deepEqual(o.slabs.map((s) => s.text.text), summaries, 'the summaries did not change');
  assert.equal(Text.pending.length, 0, 'no sync was queued, so no callback can rescue the layout');
  assertNoOverlap(o);
  assert.ok(o.slabs[1].position.y >= measure(summaries[0]), 'the second slab clears the first summary');
});

test('far to near for short slabs re-lays out at the measured heights without a new sync', () => {
  const o = roomWith(SHORT);
  o.update(cameraAt(6));
  o.updateMatrixWorld(true);
  o.update(cameraAt(3)); // mid collapses to near for short text
  assert.deepEqual(o.slabs.map((s) => s.band), ['near', 'near', 'near']);
  assert.deepEqual(o.slabs.map((s) => s.text.text), SHORT, 'the full texts did not change');
  assert.equal(Text.pending.length, 0);
  assertNoOverlap(o);
  assert.ok(o.slabs[2].position.y >= measure(SHORT[0]) + measure(SHORT[1]), 'the third slab clears the two-line second slab');
});

test('the beacon rides above the stack top in every band', () => {
  const o = roomWith(LONG);
  const topOf = () => o.slabs.at(-1).position.y + shownHeight(o.slabs.at(-1)) + STACK_BOTTOM;
  o.update(cameraAt(3));
  flushSyncs();
  assert.ok(o.beacon.position.y > topOf());
  o.update(cameraAt(6));
  assert.ok(o.beacon.position.y > topOf());
  o.updateMatrixWorld(true);
  o.update(cameraAt(3));
  assert.ok(o.beacon.position.y > topOf());
});
