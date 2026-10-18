// Pure projectile tests (PIN-56): `curvePoint` is plain math, and the pool runs
// against a minimal fake THREE, so no three import and no DOM. Each case is
// named for the End state it proves in docs/plans/2026-10-17-obelisks-4-pylons.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curvePoint, createPool, FLIGHT_MS } from './projectile.js';

test('ES3 curvePoint starts at from, ends at to, and lifts the midpoint above the chord', () => {
  const from = { x: 1, y: 2, z: 3 };
  const to = { x: -4, y: 0.5, z: 7 };
  assert.deepEqual(curvePoint(0, from, to), from);
  assert.deepEqual(curvePoint(1, from, to), to);
  const mid = curvePoint(0.5, from, to);
  const chord = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 };
  assert.ok(Math.abs(mid.x - chord.x) <= 1e-9, `x ${mid.x} vs ${chord.x}`);
  assert.ok(Math.abs(mid.z - chord.z) <= 1e-9, `z ${mid.z} vs ${chord.z}`);
  assert.ok(mid.y - chord.y > 1e-6, `y ${mid.y} not above ${chord.y}`);
});

// Minimal fake THREE: just enough surface for the pool to build and move spheres.
class FakeVec {
  x = 0; y = 0; z = 0;
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
class Group {
  children = [];
  add(o) { this.children.push(o); return this; }
  remove(o) { this.children = this.children.filter((c) => c !== o); return this; }
}
class Mesh {
  constructor(geometry, material) { this.geometry = geometry; this.material = material; }
  position = new FakeVec();
  visible = true;
}
class SphereGeometry {}
class MeshBasicMaterial { constructor(opts) { Object.assign(this, opts); } }
const THREE = { Group, Mesh, SphereGeometry, MeshBasicMaterial };

test('ES9a createPool caps live spheres at 32 and recycles the oldest under a burst of 40', () => {
  const parent = new Group();
  const pool = createPool({ THREE, parent });
  assert.equal(parent.children.length, 1, 'one group attached to parent');
  const from = { x: 0, y: 0, z: 0 };
  const to = { x: 5, y: 1, z: 0 };
  const fired = [];
  for (let i = 0; i < 40; i++) fired.push(pool.fire(from, to, 1000 + i));
  assert.ok(pool.liveCount() <= 32, `liveCount ${pool.liveCount()}`);
  assert.equal(pool.liveCount(), 32);
  // The 33rd launch reused the sphere of the 1st (the oldest live one), and so on.
  assert.equal(fired[32], fired[0], 'oldest sphere recycled');
  assert.equal(fired[39], fired[7]);
  assert.notEqual(fired[32], fired[1], 'the second-oldest was not the one recycled');
  const live = parent.children[0].children.filter((m) => m.visible);
  assert.equal(live.length, 32);
  // After the flight time every sphere lands and hides.
  pool.update(1000 + 40 + FLIGHT_MS);
  assert.equal(pool.liveCount(), 0);
  assert.equal(parent.children[0].children.filter((m) => m.visible).length, 0);
  pool.dispose();
  assert.equal(parent.children.length, 0, 'dispose detaches the group');
});

test('a long flight arcs higher: the lift grows with the chord, never below LIFT', async () => {
  const { LIFT, LIFT_PER_M } = await import('./projectile.js');
  const lift = (to) => curvePoint(0.5, { x: 0, y: 0, z: 0 }, to).y;
  assert.ok(Math.abs(lift({ x: 2, y: 0, z: 0 }) - LIFT / 2) < 1e-9, 'a short flight keeps the LIFT floor');
  assert.ok(Math.abs(lift({ x: 30, y: 0, z: 0 }) - (LIFT_PER_M * 30) / 2) < 1e-9, 'a 30 m flight lifts by its share of the chord');
});

test('a tracer grows behind the sphere, holds after it lands, then fades out and hides', async () => {
  const THREE3 = await import('three');
  const { createTracers, traceOpacity, tracePoints, TRACE_SEGMENTS, TRACE_HOLD_MS, TRACE_FADE_MS, TRACE_OPACITY } = await import('./projectile.js');
  assert.equal(tracePoints(0), 2);
  assert.equal(tracePoints(FLIGHT_MS / 2), TRACE_SEGMENTS / 2 + 1);
  assert.equal(tracePoints(FLIGHT_MS * 3), TRACE_SEGMENTS + 1, 'the whole arc shows once the sphere lands');
  assert.equal(traceOpacity(FLIGHT_MS + TRACE_HOLD_MS), TRACE_OPACITY, 'full strength through the hold');
  assert.ok(Math.abs(traceOpacity(FLIGHT_MS + TRACE_HOLD_MS + TRACE_FADE_MS / 2) - TRACE_OPACITY / 2) < 1e-9);

  const parent = new THREE3.Group();
  const tracers = createTracers({ THREE: THREE3, parent, size: 2 });
  const from = { x: 0, y: 1, z: 0 };
  const to = { x: 20, y: 7, z: -10 };
  const line = tracers.trace(from, to, 1000);
  assert.equal(line.visible, true);
  const pos = line.geometry.getAttribute('position');
  assert.deepEqual([pos.getX(0), pos.getY(0), pos.getZ(0)], [0, 1, 0], 'the tracer starts at the tool call');
  assert.deepEqual([pos.getX(TRACE_SEGMENTS), pos.getY(TRACE_SEGMENTS), pos.getZ(TRACE_SEGMENTS)], [20, 7, -10], 'and ends at the pylon');
  tracers.update(1000 + FLIGHT_MS / 2);
  assert.equal(line.geometry.drawRange.count, TRACE_SEGMENTS / 2 + 1, 'half drawn at half flight');
  tracers.update(1000 + FLIGHT_MS + 100);
  assert.equal(line.visible, true, 'it stays after the sphere lands');
  assert.equal(line.material.opacity, TRACE_OPACITY);
  tracers.update(1000 + FLIGHT_MS + TRACE_HOLD_MS + TRACE_FADE_MS);
  assert.equal(line.visible, false, 'it hides once faded');
  assert.equal(tracers.liveCount(), 0);
  tracers.trace(from, to, 2000);
  tracers.trace(from, to, 2001);
  assert.equal(tracers.trace(from, to, 2002), line, 'a full set reuses the oldest tracer');
});
