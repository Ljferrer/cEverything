// Projectile math and pool for the pylons feature (plan 4, PIN-52). Imports
// nothing from three (PIN-56): the caller passes its `THREE` namespace in, so a
// test can pass a fake one. `curvePoint` is a quadratic Bezier whose control
// point is the chord midpoint lifted by LIFT; the pool is time-based (`now` in
// ms from the caller's clock), keeps at most `size` spheres live, and recycles
// the oldest live sphere when every sphere is in flight.

/** Flight time of one projectile, ms. */
export const FLIGHT_MS = 600;
/** Height added to the chord midpoint for the Bezier control point, m. */
export const LIFT = 1.2;
export const RADIUS = 0.05;
export const COLOR = 0xffb74d; // amber, the `tool` role color in src/colors.js

/** Point at `t` in [0, 1] on the arc from `from` to `to`; returns a plain {x, y, z}. */
export function curvePoint(t, from, to) {
  const cx = (from.x + to.x) / 2;
  const cy = (from.y + to.y) / 2 + LIFT;
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
