// Select a slab, then pinch another base to pipe it there (PIN-6). `decide`
// yields `{t:'pipe', from, to, slab}`; this feature gates it on the last
// `mode` frame's canEdit (PIN-73), sends it, clears the selected slab (also on
// every `miss`, PIN-78), logs its send and view-only lines (PIN-79), and, when
// the install ctx has a scene, draws a one-second line from the source slab
// (or the source base when that slab is gone) to the target base (PIN-72).
// `getObelisk` comes from `ctx.getObelisk` (a test's fake) or room.js on first
// use, so node tests never load room.js (PIN-80).
// fork.js must install before pipe.js (filename order in main.js): this feature
// clears bus.selectedSlab after a pipe, and fork.js would read the cleared slab
// as a fork.
import * as THREE from 'three';
import { decide } from '../gesture.js';
import { colorFor } from '../colors.js';

const LINE_MS = 1000;

const baseOf = (obelisk) => obelisk?.children?.find((c) => c.userData?.kind === 'base') ?? null;

export function install(ctx) {
  const { scene, bus, net } = ctx;
  let canEdit = false;
  let getObelisk = ctx.getObelisk ?? null;
  let room = null;
  const withObelisks = (fn) => {
    if (getObelisk) return fn(getObelisk);
    room ??= import('./room.js');
    return room.then((m) => fn((getObelisk = m.getObelisk)));
  };

  bus.addEventListener('mode', (e) => {
    canEdit = e.detail.canEdit === true;
  });

  bus.addEventListener('select', (e) => {
    const payload = e.detail;
    const cmd = decide(payload, bus.selectedSlab, bus.talking ?? null, bus.beacons?.has(payload.sid) ?? false);
    if (cmd?.t !== 'pipe') return;
    if (!canEdit) return console.log(`pipe: suppressed view-only ${cmd.to}`);
    net.send(cmd);
    console.log(`pipe: send ${JSON.stringify(cmd)}`);
    bus.selectedSlab = null;
    if (scene) withObelisks((get) => drawLine(scene, get, cmd));
  });

  bus.addEventListener('miss', () => {
    bus.selectedSlab = null;
  });
}

function drawLine(scene, getObelisk, { from, to, slab }) {
  const source = getObelisk(from);
  const start = source?.slabs?.find((s) => s.slabId === slab) ?? baseOf(source);
  const end = baseOf(getObelisk(to));
  if (!start || !end) return;
  const points = [start.getWorldPosition(new THREE.Vector3()), end.getWorldPosition(new THREE.Vector3())];
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: colorFor('user') }),
  );
  scene.add(line);
  setTimeout(() => {
    scene.remove(line);
    line.geometry.dispose();
    line.material.dispose();
  }, LINE_MS);
}
