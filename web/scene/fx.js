// Tiny tween helper + room effects (PROTOCOL.md §1 scene/fx.js): packets along quadratic Beziers (tool.start/complete),
// pipe arc, fork ghost, lineage dashed lines, grow animation. Everything is pooled; nothing allocates per frame.

import * as THREE from 'three';

export const ease = {
  linear: (t) => t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  outBack: (t) => { const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
};

/** createTweens() → { add({ms, ease, onUpdate(k, t), onDone}), update(now), count } */
export function createTweens() {
  const list = [];
  return {
    add({ ms = 300, ease: fn = ease.outCubic, onUpdate, onDone, delay = 0 }) {
      const tw = { start: performance.now() + delay, ms, fn, onUpdate, onDone, done: false, cancel() { tw.done = true; } };
      list.push(tw);
      return tw;
    },
    update(now) {
      for (let i = list.length - 1; i >= 0; i--) {
        const tw = list[i];
        if (tw.done) { list.splice(i, 1); continue; }
        if (now < tw.start) continue;
        const t = Math.min(1, (now - tw.start) / tw.ms);
        try { tw.onUpdate?.(tw.fn(t), t); } catch (err) { console.error('[fx] tween update failed', err); tw.done = true; }
        if (t >= 1) { tw.done = true; list.splice(i, 1); try { tw.onDone?.(); } catch (err) { console.error('[fx] tween done failed', err); } }
      }
    },
    get count() { return list.length; },
  };
}

const PACKET_POOL = 24;
const ARC_POOL = 8;
const ARC_POINTS = 24;

const _a = new THREE.Vector3(); const _b = new THREE.Vector3(); const _c = new THREE.Vector3();

/** Quadratic Bezier point: control = midpoint + lift (m) up. */
export function bezier(out, from, to, lift, t) {
  _c.addVectors(from, to).multiplyScalar(0.5); _c.y += lift;
  const u = 1 - t;
  out.set(
    u * u * from.x + 2 * u * t * _c.x + t * t * to.x,
    u * u * from.y + 2 * u * t * _c.y + t * t * to.y,
    u * u * from.z + 2 * u * t * _c.z + t * t * to.z,
  );
  return out;
}

export function createFX(scene) {
  const tweens = createTweens();
  const root = new THREE.Group(); root.name = 'fx'; scene.add(root);

  // ------------------------------------------------------------ packets (0.05 m cubes)
  const packetGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
  const packets = [];
  for (let i = 0; i < PACKET_POOL; i++) {
    const m = new THREE.Mesh(packetGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 }));
    m.visible = false; m.frustumCulled = true; root.add(m); packets.push({ mesh: m, busy: false });
  }
  function takePacket() { return packets.find((p) => !p.busy) || null; }

  /** flyPacket({ from, to, color, ms=600, lift=1.0, onDone }) — world-space Vector3s (copied). */
  function flyPacket({ from, to, color = '#F59E0B', ms = 600, lift = 1.0, onDone }) {
    const p = takePacket();
    if (!p) { onDone?.(); return null; }
    p.busy = true;
    const a = from.clone(); const b = to.clone();
    p.mesh.material.color.set(color); p.mesh.material.opacity = 1; p.mesh.visible = true; p.mesh.scale.setScalar(1);
    return tweens.add({ ms, ease: ease.inOutQuad,
      onUpdate(k) { bezier(p.mesh.position, a, b, lift, k); p.mesh.rotation.y += 0.15; },
      onDone() { p.mesh.visible = false; p.busy = false; onDone?.(); } });
  }

  // ------------------------------------------------------------ arcs (pipe)
  const arcs = [];
  for (let i = 0; i < ARC_POOL; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_POINTS * 3), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.9 }));
    line.visible = false; line.frustumCulled = false; root.add(line); arcs.push({ line, busy: false });
  }
  /** pipeArc({ from, to, ms=600, color }) → cyan arc drawn progressively + packet, fades out after. */
  function pipeArc({ from, to, ms = 600, color = '#22D3EE', onDone }) {
    const arc = arcs.find((x) => !x.busy);
    const a = from.clone(); const b = to.clone();
    if (arc) {
      arc.busy = true; arc.line.visible = true; arc.line.material.color.set(color); arc.line.material.opacity = 0.9;
      const pos = arc.line.geometry.attributes.position;
      for (let i = 0; i < ARC_POINTS; i++) { bezier(_a, a, b, 1.0, i / (ARC_POINTS - 1)); pos.setXYZ(i, _a.x, _a.y, _a.z); }
      pos.needsUpdate = true;
      arc.line.geometry.setDrawRange(0, 1);
      tweens.add({ ms, ease: ease.inOutQuad, onUpdate(k) { arc.line.geometry.setDrawRange(0, Math.max(2, Math.round(k * ARC_POINTS))); },
        onDone() { tweens.add({ ms: 500, onUpdate(k) { arc.line.material.opacity = 0.9 * (1 - k); }, onDone() { arc.line.visible = false; arc.busy = false; } }); } });
    }
    flyPacket({ from: a, to: b, color, ms, onDone });
  }

  // ------------------------------------------------------------ fork ghost
  const ghostGeo = new THREE.BoxGeometry(0.4, 1.6, 0.1);
  const ghost = new THREE.Mesh(ghostGeo, new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.3, wireframe: true }));
  ghost.visible = false; root.add(ghost);
  /** forkGhost({ from, to, ms=400 }) — translucent column silhouette gliding parent → child, then fades. */
  function forkGhost({ from, to, ms = 400, onDone }) {
    const a = from.clone(); const b = to.clone();
    ghost.visible = true; ghost.material.opacity = 0.3;
    ghost.position.copy(a); ghost.position.y = 0.8;
    tweens.add({ ms, onUpdate(k) { ghost.position.lerpVectors(a, b, k); ghost.position.y = 0.8; },
      onDone() { tweens.add({ ms: 400, onUpdate(k) { ghost.material.opacity = 0.3 * (1 - k); }, onDone() { ghost.visible = false; onDone?.(); } }); } });
  }

  // ------------------------------------------------------------ lineage dashed lines (base → base)
  const lineage = new Map(); // key → { line, from: Vector3, to: Vector3 }
  function setLineage(key, from, to, color = 0x9ca3af) {
    let e = lineage.get(key);
    if (!e) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color, dashSize: 0.08, gapSize: 0.06, transparent: true, opacity: 0.8 }));
      line.frustumCulled = false; root.add(line);
      e = { line, from: new THREE.Vector3(), to: new THREE.Vector3() };
      lineage.set(key, e);
    }
    e.from.copy(from); e.to.copy(to);
    const pos = e.line.geometry.attributes.position;
    pos.setXYZ(0, from.x, from.y + 0.03, from.z); pos.setXYZ(1, to.x, to.y + 0.03, to.z); pos.needsUpdate = true;
    e.line.computeLineDistances();
    e.line.material.color.set(color);
    return e;
  }
  function removeLineage(key) {
    const e = lineage.get(key);
    if (!e) return;
    root.remove(e.line); e.line.geometry.dispose(); e.line.material.dispose(); lineage.delete(key);
  }

  // ------------------------------------------------------------ flashes (temporary color on any material)
  function flash(material, color = '#F59E0B', ms = 300) {
    if (!material || !material.color) return;
    const orig = material.color.getHex();
    material.color.set(color);
    tweens.add({ ms, onUpdate() {}, onDone() { material.color.setHex(orig); } });
  }

  /** grow(object, ms=200): scale 0 → 1 with a slight overshoot. */
  function grow(object, ms = 200) {
    object.scale.setScalar(0.001);
    return tweens.add({ ms, ease: ease.outBack, onUpdate(k) { object.scale.setScalar(Math.max(0.001, k)); }, onDone() { object.scale.setScalar(1); } });
  }

  function update(now) { tweens.update(now); }

  function stats() { return { tweens: tweens.count, packets: packets.filter((p) => p.busy).length, arcs: arcs.filter((a) => a.busy).length, lineage: lineage.size }; }

  return { root, tweens, flyPacket, pipeArc, forkGhost, setLineage, removeLineage, flash, grow, update, stats, ease, bezier };
}

export default { createFX, createTweens, ease, bezier };
