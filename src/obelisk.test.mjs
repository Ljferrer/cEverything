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
const { Obelisk, STACK_BOTTOM, TITLE_SIZE, BASE_HEIGHT, MIN_BODY_TOP, CARD_PAD, glyphFor } = await import('./obelisk.js');
const { BAR_HEIGHT, SLAB_GAP } = await import('./stack.js');
const { stateColor, MONOLITH_BLACK, ROLE_COLORS } = await import('./colors.js');

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

// The visible top of a slab above its origin as the viewer sees it: the bar
// when the text is hidden, else the text's offset plus its measured span.
function shownHeight(slab) {
  return slab.text.visible ? slab.text.position.y + measure(slab.text.text) : BAR_HEIGHT;
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

test('slabMesh returns the slab object for an id, null for an unknown one', () => {
  const o = roomWith(SHORT);
  const m = o.slabMesh('a1');
  assert.ok(m, 'found');
  assert.equal(m.slabId, 'a1');
  assert.deepEqual(m.userData, { sid: 's1', slabId: 'a1' });
  assert.equal(m.parent, o.stack, 'the returned object is the one placed in the stack');
  assert.equal(o.slabMesh('zz'), null);
});

test('update turns the obelisk about Y to face the camera, so its text never reads mirrored', () => {
  const o = new Obelisk({ sid: 'face', title: 'T', status: 'idle' });
  const cam = (x, z) => {
    const c = new THREE.Object3D();
    c.position.set(x, STACK_BOTTOM, z);
    c.updateMatrixWorld(true);
    return c;
  };
  for (const [x, z] of [[0, 3], [3, 0], [0, -4], [-2, -2]]) {
    o.update(cam(x, z));
    o.updateMatrixWorld(true);
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);
    const toCam = new THREE.Vector3(x, 0, z).normalize();
    assert.ok(facing.dot(toCam) > 0.999, `camera at (${x}, ${z}): facing ${facing.toArray().map((n) => n.toFixed(2))}`);
    assert.equal(o.rotation.x, 0);
    assert.equal(o.rotation.z, 0);
  }
});

test('the title sits on top of the stack and the beacon above the title', () => {
  const o = new Obelisk({ sid: 'top', title: 'A title', status: 'waiting' });
  o.addSlab({ id: 'x1', role: 'user', text: 'one' });
  o.addSlab({ id: 'x2', role: 'assistant', text: 'two' });
  const topOfStack = Math.max(...o.slabs.map((s) => s.position.y)) + STACK_BOTTOM;
  assert.ok(o.title.position.y > topOfStack, `title ${o.title.position.y} above stack top ${topOfStack}`);
  assert.ok(o.beacon.position.y > o.title.position.y + 3 * TITLE_SIZE, 'beacon clears a three-line title');
});

test('two obelisks get different glyphs, each a symbol and a two-digit number', () => {
  const a = new Obelisk({ sid: 'glyph-a', title: 'A', status: 'idle' });
  const b = new Obelisk({ sid: 'glyph-b', title: 'B', status: 'idle' });
  assert.match(a.glyph.text, /^\S \d{2}$/);
  assert.match(b.glyph.text, /^\S \d{2}$/);
  assert.notEqual(a.glyph.text, b.glyph.text);
  assert.equal(Number(b.glyph.text.slice(-2)), Number(a.glyph.text.slice(-2)) + 1, 'numbered in creation order');
});

test('the glyph is stable for a sid, even for a rebuilt obelisk', () => {
  const first = new Obelisk({ sid: 'glyph-stable', title: 'S', status: 'idle' });
  new Obelisk({ sid: 'glyph-other', title: 'O', status: 'idle' });
  const again = new Obelisk({ sid: 'glyph-stable', title: 'S', status: 'idle' });
  assert.equal(again.glyph.text, first.glyph.text);
  assert.equal(glyphFor('glyph-stable'), first.glyph.text);
});

test('a short stack stands as a tall monolith with the glyph at its top', () => {
  const o = roomWith(SHORT);
  const top = o.body.position.y + o.body.scale.y / 2;
  assert.ok(Math.abs(top - MIN_BODY_TOP) < 1e-9, `body top ${top}`);
  assert.ok(o.glyph.position.y > o.sound.position.y && o.sound.position.y > o.title.position.y + measure(o.title.text));
  assert.ok(top - (o.glyph.position.y + measure(o.glyph.text)) < 0.1, 'the glyph sits at the top');
});

test('the body reaches from the base to above the glyph and grows with a tall stack', () => {
  const o = roomWith([...LONG, ...LONG, ...LONG]);
  const bottom = () => o.body.position.y - o.body.scale.y / 2;
  const top = () => o.body.position.y + o.body.scale.y / 2;
  const stackTop = o.slabs.at(-1).position.y + measure(LONG.at(-1)) + STACK_BOTTOM;
  assert.ok(Math.abs(bottom() - BASE_HEIGHT) < 1e-9, `body bottom ${bottom()} sits on the base`);
  assert.ok(top() > MIN_BODY_TOP, 'this stack is taller than the floor');
  assert.ok(o.title.position.y > stackTop && o.glyph.position.y > o.sound.position.y && o.sound.position.y > o.title.position.y, 'stack, title, SOUND ONLY, glyph, bottom to top');
  assert.ok(top() > o.glyph.position.y + measure(o.glyph.text), 'the body clears the glyph');
  assert.ok(o.beacon.position.y > top(), 'the beacon rides above the body');
  assert.ok(o.body.position.z + o.body.scale.z / 2 < 0, 'the body stands behind the slab text');
  const before = o.body.scale.y;
  const text = 'a fourth slab that wraps onto two lines';
  o.addSlab({ id: 'a9', role: 'user', text });
  flushSyncs();
  assert.ok(Math.abs(o.body.scale.y - before - (measure(text) + 2 * CARD_PAD + SLAB_GAP)) < 1e-9, 'the body grows by the new card and its gap');
});

test('setState still recolors the base, not the shared body', () => {
  const o = new Obelisk({ sid: 'state', title: 'S', status: 'idle' });
  o.setState('error');
  assert.equal(o.base.material.color.getHex(), stateColor('error'));
  assert.equal(o.children.find((c) => c.userData?.kind === 'base'), o.base, "state.js's baseOf still finds the base");
  assert.equal(o.body.material.color.getHex(), MONOLITH_BLACK);
  o.setBeacon(true);
  assert.equal(o.beacon.visible, true);
});

test('a ray through the body between slabs is not a pick', () => {
  const o = roomWith(SHORT);
  const gapY = STACK_BOTTOM + o.slabs[1].position.y - SLAB_GAP / 2; // between the first two cards
  const ray = new THREE.Raycaster(new THREE.Vector3(0.33, gapY, 2), new THREE.Vector3(0, 0, -1));
  const hits = ray.intersectObject(o, true).map((h) => h.object);
  assert.ok(hits.length === 0, `no hit, got ${hits.map((h) => h.type)}`);
  const into = new THREE.Raycaster(new THREE.Vector3(0, BASE_HEIGHT / 2, 2), new THREE.Vector3(0, 0, -1));
  assert.equal(into.intersectObject(o, true)[0]?.object, o.base, 'the base still takes a pick in front of the body');
});

function mixedRoom() {
  const o = new Obelisk({ sid: 'cards', title: 'C', status: 'idle' });
  ['user', 'assistant', 'thinking', 'tool', 'user'].forEach((role, i) => o.addSlab({ id: `c${i}`, role, text: `${role} message number ${i} that wraps` }));
  flushSyncs();
  o.updateMatrixWorld(true);
  return o;
}

test('every slab gets exactly one outline in its role color, framing its measured text', () => {
  const o = mixedRoom();
  for (const slab of o.slabs) {
    const lines = slab.children.filter((c) => c.isLineSegments);
    assert.equal(lines.length, 1, `${slab.slabId} has one outline`);
    assert.equal(lines[0], slab.outline);
    assert.equal(slab.outline.material.color.getHex(), ROLE_COLORS[slab.role], `${slab.role} outline color`);
    assert.ok(Math.abs(slab.outline.scale.y - (measure(slab.text.text) + 2 * CARD_PAD)) < 1e-9, `${slab.slabId} outline height`);
  }
  assert.equal(o.slabs[1].outline.geometry, o.slabs[2].outline.geometry, 'outlines share one geometry');
  assert.equal(o.slabs[0].outline.material, o.slabs[4].outline.material, 'same role, same material');
});

test('cards leave a visible gap between their outlines and their text never overlaps', () => {
  const o = mixedRoom();
  assertNoOverlap(o);
  for (let i = 0; i + 1 < o.slabs.length; i++) {
    const [a, b] = [o.slabs[i], o.slabs[i + 1]];
    const top = a.position.y + a.outline.position.y + a.outline.scale.y;
    const bottom = b.position.y + b.outline.position.y;
    assert.ok(a.text.position.y >= CARD_PAD && a.text.position.y + measure(a.text.text) <= a.outline.scale.y + 1e-9, `${a.slabId} text sits inside its outline`);
    assert.ok(bottom - top > 0.01, `gap between ${a.slabId} and ${b.slabId} is ${(bottom - top).toFixed(3)}`);
  }
});

test('user text is larger and bold on a dark panel; thinking and tool text is smaller than assistant', () => {
  const o = mixedRoom();
  const [user, assistant, thinking, tool] = o.slabs;
  assert.ok(user.text.fontSize >= 1.4 * assistant.text.fontSize, `user ${user.text.fontSize} vs assistant ${assistant.text.fontSize}`);
  assert.equal(user.text.fontWeight, 'bold');
  assert.notEqual(assistant.text.fontWeight, 'bold');
  assert.ok(thinking.text.fontSize < assistant.text.fontSize && tool.text.fontSize < assistant.text.fontSize);
  assert.ok(user.panel?.isMesh, 'a user slab has a panel');
  assert.deepEqual(user.panel.scale.toArray(), user.outline.scale.toArray(), 'the panel fills the outline');
  assert.ok(user.panel.position.z < 0 && user.panel.position.z > -0.02, 'the panel sits behind the text, in front of the body');
  assert.equal(assistant.panel, undefined);
  assert.equal(user.outline.material.opacity, 1);
  assert.ok(assistant.outline.material.opacity < 1, 'only the user outline is full strength');
});

test('the far band hides the outline and panel, and near shows them again', () => {
  const o = mixedRoom();
  o.update(cameraAt(6));
  assert.ok(o.slabs.every((s) => s.band === 'far' && !s.outline.visible));
  assert.equal(o.slabs[0].panel.visible, false);
  o.updateMatrixWorld(true);
  o.update(cameraAt(1));
  flushSyncs();
  assert.ok(o.slabs.every((s) => s.band === 'near' && s.outline.visible));
  assert.equal(o.slabs[0].panel.visible, true);
});

test('slab picking userData is unchanged and a ray through a card never hits its outline or panel', () => {
  const o = mixedRoom();
  for (const slab of o.slabs) {
    const want = { sid: 'cards', slabId: slab.slabId };
    assert.deepEqual(slab.userData, want);
    assert.deepEqual(slab.text.userData, want);
    assert.deepEqual(slab.bar.userData, want);
  }
  const user = o.slabs[0];
  const y = STACK_BOTTOM + user.position.y + 0.02; // inside the user card, on its bar's span
  const hits = new THREE.Raycaster(new THREE.Vector3(0.2, y, 2), new THREE.Vector3(0, 0, -1)).intersectObject(o, true).map((h) => h.object);
  assert.ok(hits.length > 0, 'the slab still takes a pick');
  for (const hit of hits) {
    assert.notEqual(hit, user.outline);
    assert.notEqual(hit, user.panel);
    assert.deepEqual(hit.userData, { sid: 'cards', slabId: user.slabId });
  }
  const edge = new THREE.Raycaster(new THREE.Vector3(-0.5 - CARD_PAD, y, 2), new THREE.Vector3(0, 0, -1));
  edge.params.Line.threshold = 0.05;
  assert.ok(edge.intersectObject(o, true).every((h) => h.object !== user.outline), 'a ray on the outline edge does not pick it');
});

test('the forward cone: a real camera facing an obelisk reads it in full, facing away collapses it', () => {
  const o = new Obelisk({ sid: 'cone', title: 'T', status: 'idle' });
  o.addSlab({ id: 'c1', role: 'assistant', text: 'x'.repeat(200) });
  o.updateMatrixWorld(true);
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0, STACK_BOTTOM, 2);
  cam.lookAt(0, STACK_BOTTOM, 0); // facing the obelisk, 2 m away
  cam.updateMatrixWorld(true);
  o.update(cam);
  assert.equal(o.slabs[0].band, 'near');
  cam.lookAt(0, STACK_BOTTOM, 10); // turned around, same spot
  cam.updateMatrixWorld(true);
  o.update(cam);
  assert.equal(o.slabs[0].band, 'far');
});
