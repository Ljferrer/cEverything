// Entry: renderer, scene, camera, bus, net, then every feature in filename
// order (PIN-16, PIN-17). Later plans add files under src/features/ and never
// edit this file.
//
// Per-frame seams: `bus` emits `frame {dt, camera, renderer}` on every render,
// and the install ctx carries `onFrame(cb)`: each registered `cb(dt, now)` runs
// inside `renderer.setAnimationLoop` on every render, immersive sessions
// included (a bare Object3D's `onBeforeRender` never fires there).
import * as THREE from 'three';
import { createBus } from './bus.js';
import { createNet } from './net.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setFoveation(0.3);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(0, 1.6, 3);

// Create all three controller slots up front: three.js r186 drops input sources
// once every created slot is taken, and the Vision Pro transient pointer needs slot 2.
for (const i of [0, 1, 2]) scene.add(renderer.xr.getController(i));

const bus = createBus();
const net = createNet(bus);

/** @type {Array<(dt:number, now:number) => void>} */
const frameCallbacks = [];
const onFrame = (cb) => {
  frameCallbacks.push(cb);
};

const ctx = { scene, camera, renderer, bus, net, onFrame };
const features = import.meta.glob('./features/*.js', { eager: true });
for (const path of Object.keys(features).sort()) {
  features[path].install?.(ctx);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
renderer.setAnimationLoop((now) => {
  const dt = clock.getDelta();
  bus.emit('frame', { dt, camera, renderer });
  for (const cb of frameCallbacks) {
    try { cb(dt, now); } catch (err) { console.error('[onFrame]', err); }
  }
  renderer.render(scene, camera);
});
