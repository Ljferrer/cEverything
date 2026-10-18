// pylons.js under node with a fake bus and an injected getObelisk: a
// resolve/load hook swaps troika-three-text for a stub Text that extends
// Object3D, so three loads but no renderer and no DOM. Covers the filesystem
// detail label, the labels turning to the camera, and the textured faces
// (an injected loader stands in for TextureLoader, which needs a DOM).
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const STUB_URL = new URL('./troika-stub.virtual.mjs', import.meta.url).href;
const STUB_SOURCE = `
import { Object3D } from 'three';
export class Text extends Object3D {
  text = '';
  sync() {}
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

const THREE = await import('three');
const { install, detailText, textureUrl, GLOW_MS } = await import('./pylons.js');

function fakeBus() {
  const bus = Object.assign(new EventTarget(), { selected: null, selectedSlab: null, talking: null });
  bus.emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  return bus;
}

function setup(load = () => {}) {
  const bus = fakeBus();
  const scene = new THREE.Scene();
  const obelisk = new THREE.Object3D(); // no slabs, so a start launches from the obelisk itself
  install({ scene, bus, getObelisk: (sid) => (sid === 's1' ? obelisk : null), load });
  const detail = scene.getObjectByName('pylon:filesystem:detail');
  return { bus, scene, detail };
}

const DIFF = '--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n same';

test('detailText keeps only the basename and +n/-m', () => {
  assert.equal(detailText('/Users/me/proj/src/features/pylons.js', 2, 1), 'pylons.js\n+2/-1');
  assert.equal(detailText('C:\\proj\\src\\main.js', 0, 3), 'main.js\n+0/-3');
  assert.equal(detailText('README.md', 5, 0), 'README.md\n+5/-0');
  assert.equal(detailText('', 0, 0), '\n+0/-0');
});

test('a filesystem complete writes the basename and counts on the detail label', () => {
  const { bus, detail } = setup();
  bus.emit('tool', {
    t: 'tool', sid: 's1', id: 'c1', name: 'Edit', phase: 'complete',
    args: { file_path: '/Users/me/GitHub/cEverything/src/features/pylons.js' }, diff: DIFF,
  });
  assert.equal(detail.text, 'pylons.js\n+2/-1');
});

test('a complete with null args takes the path cached from its start', () => {
  const { bus, detail } = setup();
  bus.emit('tool', { t: 'tool', sid: 's1', id: 'c2', name: 'write_file', phase: 'start', args: { path: '/srv/app/deep/dir/notes.txt' } });
  bus.emit('tool', { t: 'tool', sid: 's1', id: 'c2', name: 'write_file', phase: 'complete', args: null, diff: DIFF });
  assert.equal(detail.text, 'notes.txt\n+2/-1');
});

test('every pylon label faces the camera after a frame, even from behind a pylon', () => {
  const { bus, scene, detail } = setup();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(9, 1.6, 0.5); // outside the filesystem pylon at x = 5, behind its labels
  bus.emit('frame', { dt: 0.016, camera });
  scene.updateMatrixWorld(true);

  const labels = [detail, ...['browser', 'filesystem', 'shell', 'other'].map((n) => {
    const group = scene.getObjectByName(`pylon:${n}`);
    return group.children.find((c) => !c.isMesh && !c.isLine && c !== detail);
  })];
  assert.equal(labels.length, 5);
  const facing = new THREE.Vector3();
  const toCamera = new THREE.Vector3();
  for (const label of labels) {
    label.getWorldDirection(facing); // troika text faces +z
    toCamera.copy(camera.position).sub(label.getWorldPosition(new THREE.Vector3())).normalize();
    assert.ok(facing.dot(toCamera) > 0.999, `label "${label.name || label.parent.name}" faces the camera`);
  }
});

const NAMES = ['browser', 'filesystem', 'shell', 'other'];

/** A loader that records each request and loads only when told to. */
function fakeLoader() {
  const pending = new Map();
  const load = (url, onLoad) => pending.set(url, onLoad);
  return { load, pending, loadAll: () => pending.forEach((onLoad) => onLoad(new THREE.Texture())) };
}

test('each pylon asks for its texture and keeps the wireframe look until it loads', () => {
  const loader = fakeLoader();
  const { scene } = setup(loader.load);
  assert.deepEqual([...loader.pending.keys()], NAMES.map((n) => `/assets/pylon-${n}.jpg`));
  assert.equal(textureUrl('shell'), '/assets/pylon-shell.jpg');
  for (const n of NAMES) {
    const face = scene.getObjectByName(`pylon:${n}:face`);
    assert.equal(face.visible, false, `${n} face hidden before its texture loads`);
    assert.equal(face.material.map, null);
  }
  loader.loadAll();
  for (const n of NAMES) {
    const face = scene.getObjectByName(`pylon:${n}:face`);
    assert.equal(face.visible, true, `${n} face shown once its texture loads`);
    assert.ok(face.material.map?.isTexture);
    assert.equal(face.material.map.colorSpace, THREE.SRGBColorSpace);
  }
});

test('with no DOM the default loader fails quietly and the faces stay hidden', () => {
  const bus = fakeBus();
  const scene = new THREE.Scene();
  install({ scene, bus, getObelisk: () => null });
  for (const n of NAMES) assert.equal(scene.getObjectByName(`pylon:${n}:face`).visible, false);
});

test('a tool start brightens the textured face and it settles after the glow', (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const loader = fakeLoader();
  const { bus, scene } = setup(loader.load);
  loader.loadAll();
  const face = scene.getObjectByName('pylon:shell:face');
  const idle = face.material.color.clone();

  bus.emit('tool', { t: 'tool', sid: 's1', id: 'b1', name: 'Bash', phase: 'start', args: { command: 'ls' } });
  bus.emit('frame', { dt: 0.016 });
  assert.ok(face.material.color.r > 1, `shell face flares past 1 (r = ${face.material.color.r})`);
  assert.ok(face.material.color.r > face.material.color.g, 'the flare leans red');
  assert.ok(scene.getObjectByName('pylon:browser:face').material.color.equals(idle), 'other pylons stay idle');

  const edges = scene.getObjectByName('pylon:shell').children.find((c) => c.isLineSegments);
  assert.ok(edges, 'the pylon is framed by edge lines, not a wireframe box');
  assert.ok(edges.material.color.g > 0.5, 'the edges glow toward white');

  now += GLOW_MS;
  bus.emit('frame', { dt: 0.016 });
  assert.ok(face.material.color.equals(idle), 'the face returns to its idle tint');
  assert.equal(edges.material.color.getHex(), 0xff2a1a, 'the edges settle back to SEELE red');
});

test('each tool monolith rises with no top in view, and a tool call still lands on its face', async () => {
  const { PYLON_HEIGHT, PYLON_RISE, PLACE } = await import('./pylons.js');
  const { scene, bus } = setup();
  const shell = scene.getObjectByName('pylon:shell');
  shell.updateMatrixWorld(true);
  const top = new THREE.Box3().setFromObject(scene.getObjectByName('pylon:shell:body')).max.y;
  const farthest = Math.hypot(PLACE.shell.x, PLACE.shell.z, top) ; // camera near the origin to the column top
  assert.ok(top >= 1000, `the column rises ${top} m`);
  assert.ok(farthest > 500, 'its top sits far past any camera far plane the room uses');
  bus.emit('tool', { t: 'tool', sid: 's1', id: 'b2', name: 'Bash', phase: 'start', args: { command: 'ls' } });
  let end = null;
  scene.getObjectByName('pylons').traverse((o) => {
    if (o.isLine && !o.isLineSegments && o.visible) end = new THREE.Vector3().fromBufferAttribute(o.geometry.getAttribute('position'), o.geometry.getAttribute('position').count - 1);
  });
  assert.ok(end, 'the call left a tracer');
  assert.ok(Math.abs(end.y - PYLON_HEIGHT / 2) < 1e-6, `the tracer ends at the face center (y ${end.y}), not up the column`);
  assert.ok(PYLON_RISE > PYLON_HEIGHT);
});
