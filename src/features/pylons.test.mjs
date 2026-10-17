// pylons.js under node with a fake bus and an injected getObelisk: a
// resolve/load hook swaps troika-three-text for a stub Text that extends
// Object3D, so three loads but no renderer and no DOM. Covers the filesystem
// detail label and the labels turning to the camera.
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
const { install, detailText } = await import('./pylons.js');

function fakeBus() {
  const bus = Object.assign(new EventTarget(), { selected: null, selectedSlab: null, talking: null });
  bus.emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  return bus;
}

function setup() {
  const bus = fakeBus();
  const scene = new THREE.Scene();
  const obelisk = new THREE.Object3D(); // no slabs, so a start launches from the obelisk itself
  install({ scene, bus, getObelisk: (sid) => (sid === 's1' ? obelisk : null) });
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
    return group.children.find((c) => !c.isMesh && c !== detail);
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
