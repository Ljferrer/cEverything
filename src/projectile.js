// Projectile math and pool for the pylons feature (plan 4, PIN-52). Imports
// nothing from three (PIN-56): the caller passes its `THREE` namespace in, so a
// test can pass a fake one. `curvePoint` is a quadratic Bezier whose control
// point is the chord midpoint lifted by LIFT; the pool is time-based (`now` in
// ms from the caller's clock), keeps at most `size` spheres live, and recycles
// the oldest live sphere when every sphere is in flight. `createTracers` leaves
// a line along each arc: it draws behind the sphere as it flies, holds after
// it lands, then fades out.

/** Flight time of one projectile, ms. */
export const FLIGHT_MS = 1000;
/** Least height added to the chord midpoint for the Bezier control point, m. */
export const LIFT = 1.2;
/** A long flight arcs higher: the lift is at least this share of the chord length. */
export const LIFT_PER_M = 0.15;
export const RADIUS = 0.05;
export const COLOR = 0xffb74d; // amber, the `tool` role color in src/colors.js

/** Point at `t` in [0, 1] on the arc from `from` to `to`; returns a plain {x, y, z}. */
export function curvePoint(t, from, to) {
  const cx = (from.x + to.x) / 2;
  const chord = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const cy = (from.y + to.y) / 2 + Math.max(LIFT, LIFT_PER_M * chord);
  const cz = (from.z + to.z) / 2;
  const u = 1 - t;
  const a = u * u;
  const b = 2 * u * t;
  const c = t * t;
  return {
    x: a * from.x + b * cx + c * to.x,
    y: a * from.y + b * cy + c * to.y,
    z: a * from.z + b * cz + c * to.z,
  };
}

/**
 * Build `size` hidden spheres into one `THREE.Group` attached to `parent`.
 * @returns {{fire(from, to, now): object, update(now): void, liveCount(): number, dispose(): void}}
 */
export function createPool({ THREE, parent, size = 32 }) {
  const group = new THREE.Group();
  const geometry = new THREE.SphereGeometry(RADIUS, 8, 6);
  const material = new THREE.MeshBasicMaterial({ color: COLOR, wireframe: true });
  /** @type {Array<{mesh: object, from: object|null, to: object|null, start: number, live: boolean}>} */
  const slots = [];
  for (let i = 0; i < size; i++) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    group.add(mesh);
    slots.push({ mesh, from: null, to: null, start: -Infinity, live: false });
  }
  parent.add(group);

  function pick() {
    let oldest = null;
    for (const s of slots) {
      if (!s.live) return s;
      if (!oldest || s.start < oldest.start) oldest = s;
    }
    return oldest;
  }

  return {
    /** Launch a sphere from `from` toward `to` at `now`; returns the sphere mesh. */
    fire(from, to, now) {
      const s = pick();
      s.from = { x: from.x, y: from.y, z: from.z };
      s.to = { x: to.x, y: to.y, z: to.z };
      s.start = now;
      s.live = true;
      s.mesh.position.set(from.x, from.y, from.z);
      s.mesh.visible = true;
      return s.mesh;
    },
    /** Move every live sphere along its arc by elapsed time; hide it on arrival. */
    update(now) {
      for (const s of slots) {
        if (!s.live) continue;
        const t = (now - s.start) / FLIGHT_MS;
        if (t >= 1) {
          s.live = false;
          s.mesh.visible = false;
          continue;
        }
        const p = curvePoint(t < 0 ? 0 : t, s.from, s.to);
        s.mesh.position.set(p.x, p.y, p.z);
      }
    },
    liveCount() {
      let n = 0;
      for (const s of slots) if (s.live) n++;
      return n;
    },
    /** Detach the group from `parent`. */
    dispose() {
      parent.remove(group);
    },
  };
}

/** Points per tracer line: TRACE_SEGMENTS segments along the arc. */
export const TRACE_SEGMENTS = 32;
/** How long a tracer holds at full strength after its sphere lands, ms. */
export const TRACE_HOLD_MS = 3000;
/** How long a tracer takes to fade out after the hold, ms. */
export const TRACE_FADE_MS = 5000;
export const TRACE_OPACITY = 0.85;

/** A tracer's opacity `age` ms after launch: full through the flight and the hold, then a linear fade to 0. */
export function traceOpacity(age) {
  if (age < 0) return 0;
  const fadeAt = FLIGHT_MS + TRACE_HOLD_MS;
  if (age <= fadeAt) return TRACE_OPACITY;
  return Math.max(0, TRACE_OPACITY * (1 - (age - fadeAt) / TRACE_FADE_MS));
}

/** How many arc points a tracer draws `age` ms after launch: it grows behind the sphere, then shows whole. */
export function tracePoints(age) {
  const t = Math.max(0, Math.min(1, age / FLIGHT_MS));
  return Math.max(2, Math.ceil(t * TRACE_SEGMENTS) + 1);
}

/**
 * Build `size` hidden tracer lines into one `THREE.Group` attached to `parent`.
 * `trace(from, to, now)` lays a line along the same arc a sphere flies;
 * `update(now)` grows, holds, and fades each one. The oldest is reused when all are live.
 * @returns {{trace(from, to, now): object, update(now): void, liveCount(): number, dispose(): void}}
 */
export function createTracers({ THREE, parent, size = 32 }) {
  const group = new THREE.Group();
  const slots = [];
  for (let i = 0; i < size; i++) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((TRACE_SEGMENTS + 1) * 3), 3));
    const material = new THREE.LineBasicMaterial({ color: COLOR, transparent: true, opacity: 0, depthWrite: false });
    const line = new THREE.Line(geometry, material);
    line.visible = false;
    line.frustumCulled = false; // the arc moves, so its bounding sphere never updates
    line.raycast = () => {}; // a tracer never takes a pick
    group.add(line);
    slots.push({ line, start: -Infinity, live: false });
  }
  parent.add(group);

  const pick = () => slots.find((s) => !s.live) ?? slots.reduce((a, b) => (b.start < a.start ? b : a));

  return {
    /** Lay a tracer along the arc from `from` to `to`, starting at `now`; returns the line. */
    trace(from, to, now) {
      const s = pick();
      const pos = s.line.geometry.getAttribute('position');
      for (let i = 0; i <= TRACE_SEGMENTS; i++) {
        const p = curvePoint(i / TRACE_SEGMENTS, from, to);
        pos.setXYZ(i, p.x, p.y, p.z);
      }
      pos.needsUpdate = true;
      s.start = now;
      s.live = true;
      s.line.geometry.setDrawRange(0, tracePoints(0));
      s.line.material.opacity = traceOpacity(0);
      s.line.visible = true;
      return s.line;
    },
    /** Grow, hold, and fade every live tracer; hide one once it has faded out. */
    update(now) {
      for (const s of slots) {
        if (!s.live) continue;
        const age = now - s.start;
        const opacity = traceOpacity(age);
        if (opacity <= 0 && age > FLIGHT_MS) {
          s.live = false;
          s.line.visible = false;
          continue;
        }
        s.line.material.opacity = opacity;
        s.line.geometry.setDrawRange(0, tracePoints(age));
      }
    },
    liveCount() {
      return slots.filter((s) => s.live).length;
    },
    /** Detach the group from `parent`. */
    dispose() {
      parent.remove(group);
    },
  };
}
