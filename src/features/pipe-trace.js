// Pipe traces: when a message is piped from one chat into another, the target
// chat receives a user slab that starts "From <source title>: " (pipe.mjs).
// This feature draws a lasting red arc from the source monolith to the target
// monolith for every such slab, on every client and headset (it reads the
// relay's broadcast slab, not the sender's own click), with a spark that runs
// along the arc once. The newest MAX_TRACES arcs stay; older ones are removed.
import * as THREE from 'three';
import { allObelisks, getObelisk } from './room.js';
import { MONOLITH_RED } from '../colors.js';

export const MAX_TRACES = 24;
export const ARC_LIFT = 1.6; // meters above the higher end at the arc's middle
export const SPARK_MS = 1200;

/** The source title of a piped message, or null: "From <title>: <text>". */
export function pipedFrom(text) {
  const m = /^From (.+?): /s.exec(typeof text === 'string' ? text : '');
  return m ? m[1] : null;
}

/** Find the source obelisk by title, never the target itself; the newest match wins. */
export function findSource(title, targetSid, obelisks) {
  const matches = obelisks.filter((o) => o.sid !== targetSid && o.session?.title === title);
  return matches.at(-1) ?? null;
}

export function install({ scene, bus, getObelisks = allObelisks, findObelisk = getObelisk }) {
  if (!scene || !bus) return;
  const group = new THREE.Group();
  group.name = 'pipe-traces';
  scene.add(group);
  const material = new THREE.LineBasicMaterial({ color: MONOLITH_RED, transparent: true, opacity: 0.85 });
  const sparkGeometry = new THREE.SphereGeometry(0.07, 8, 6);
  const sparkMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const traces = new Map(); // slab id -> {line, spark, curve, born}

  const anchor = (o, out) => {
    o.getWorldPosition(out);
    out.y += 2 * o.scale.y; // near the top of the monolith
    return out;
  };

  bus.addEventListener('slab', (e) => {
    const f = e.detail;
    if (!f || f.role !== 'user' || traces.has(f.id)) return;
    const title = pipedFrom(f.text);
    if (!title) return;
    const target = findObelisk(f.sid);
    const source = findSource(title, f.sid, getObelisks());
    if (!target || !source) return;
    const a = anchor(source, new THREE.Vector3());
    const b = anchor(target, new THREE.Vector3());
    const mid = a.clone().lerp(b, 0.5);
    mid.y = Math.max(a.y, b.y) + ARC_LIFT;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)), material);
    line.raycast = () => {};
    const spark = new THREE.Mesh(sparkGeometry, sparkMaterial);
    spark.raycast = () => {};
    group.add(line, spark);
    traces.set(f.id, { line, spark, curve, born: performance.now() });
    while (traces.size > MAX_TRACES) {
      const [oldId, old] = traces.entries().next().value;
      group.remove(old.line, old.spark);
      old.line.geometry.dispose();
      traces.delete(oldId);
    }
  });

  bus.addEventListener('frame', () => {
    const now = performance.now();
    for (const t of traces.values()) {
      const k = (now - t.born) / SPARK_MS;
      t.spark.visible = k < 1;
      if (k < 1) t.spark.position.copy(t.curve.getPoint(Math.max(0, k)));
    }
  });
}
