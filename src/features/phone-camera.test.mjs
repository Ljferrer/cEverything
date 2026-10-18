import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const { deviceQuaternion, dragStep, WALK_PER_PIXEL } = await import('./phone-camera.js');

const look = (q) => new THREE.Vector3(0, 0, -1).applyQuaternion(q);

test('a phone held upright at the starting heading looks straight down the aisle', () => {
  const v = look(deviceQuaternion({ alpha: 120, beta: 90, gamma: 0 }, 0, 120));
  assert.ok(v.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-6, v.toArray().join());
});

test('turning the phone 90 degrees to the left turns the view left', () => {
  const v = look(deviceQuaternion({ alpha: 210, beta: 90, gamma: 0 }, 0, 120));
  assert.ok(v.distanceTo(new THREE.Vector3(-1, 0, 0)) < 1e-6, v.toArray().join());
});

test('tilting the phone up looks up', () => {
  const v = look(deviceQuaternion({ alpha: 0, beta: 135, gamma: 0 }, 0, 0));
  assert.ok(v.y > 0.6, v.toArray().join());
});

test('dragging a finger up walks forward, sideways strafes', () => {
  const fwd = new THREE.Vector3(0, 0, -1), right = new THREE.Vector3(1, 0, 0);
  const s = dragStep(10, -100, fwd, right);
  assert.ok(Math.abs(s.z + 100 * WALK_PER_PIXEL) < 1e-9);
  assert.ok(Math.abs(s.x - 10 * WALK_PER_PIXEL) < 1e-9);
});
