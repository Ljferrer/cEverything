// Pylons and projectiles (plan 4, PIN-2): four wireframe pylons at the compass
// points, radius 5 m (PIN-51); a `tool` start fires a pooled sphere from the
// calling slab (or the obelisk base) to the tool's pylon and lights the pylon
// for 2 s (PIN-52, PIN-53, PIN-55); a filesystem `complete` writes the path and
// `+n/-m` on the filesystem pylon (PIN-54). Frames for a sid with no obelisk
// and for spawning tools are dropped (PIN-50). This is the only plan 4 file
// that adds objects to the scene (PIN-56); it never edits plan 1's files.
import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { getObelisk } from './room.js';
import { PYLONS, pylonFor, shouldFire, diffCounts } from '../pylon-map.js';
import { createPool } from '../projectile.js';

export const PYLON_RADIUS = 5;
export const PYLON_HEIGHT = 3;
export const PYLON_WIDTH = 0.6;
export const GLOW_MS = 2000;
const BASE_COLOR = new THREE.Color(0x546e7a); // slate, the idle state color
const GLOW_COLOR = new THREE.Color(0xffffff);
const STARTS_KEPT = 256; // remembered `start` args; a lost `complete` never leaks past this

/** Compass placement (PIN-51): browser north, filesystem east, shell south, other west. */
const PLACE = Object.freeze({
  browser: { x: 0, z: -PYLON_RADIUS },
  filesystem: { x: PYLON_RADIUS, z: 0 },
  shell: { x: 0, z: PYLON_RADIUS },
  other: { x: -PYLON_RADIUS, z: 0 },
});

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();

function makeLabel(text, fontSize, y, anchorY) {
  const t = new Text();
  t.text = text;
  t.fontSize = fontSize;
  t.color = 0xffffff;
  t.sdfGlyphSize = 64;
  t.maxWidth = 2.4;
  t.anchorX = 'center';
  t.anchorY = anchorY;
  t.position.set(0, y, PYLON_WIDTH / 2 + 0.02); // just in front of the face toward the room
  t.sync();
  return t;
}

function makePylon(name) {
  const g = new THREE.Group();
  g.name = `pylon:${name}`;
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(PYLON_WIDTH, PYLON_HEIGHT, PYLON_WIDTH),
    new THREE.MeshBasicMaterial({ wireframe: true, color: BASE_COLOR.getHex() }),
  );
  box.position.y = PYLON_HEIGHT / 2;
  box.userData = { kind: 'pylon', pylon: name };
  g.add(box);
  g.add(makeLabel(name, 0.24, PYLON_HEIGHT + 0.1, 'bottom'));
  const p = PLACE[name];
  g.position.set(p.x, 0, p.z);
  g.lookAt(0, 0, 0); // troika text faces +z, so the labels face the room center
  return { group: g, box, glowUntil: -Infinity };
}

/** The base mesh under an obelisk (userData.kind === 'base'), or the obelisk itself. */
function baseOf(obelisk) {
  if (obelisk.base?.userData?.kind === 'base') return obelisk.base;
  let found = null;
  obelisk.traverse((o) => {
    if (!found && o.userData?.kind === 'base') found = o;
  });
  return found ?? obelisk;
}

export function install({ scene, bus }) {
  const group = new THREE.Group();
  group.name = 'pylons';
  scene.add(group);

  /** @type {Record<string, {group: THREE.Group, box: THREE.Mesh, glowUntil: number}>} */
  const pylons = {};
  for (const name of PYLONS) {
    pylons[name] = makePylon(name);
    group.add(pylons[name].group);
  }
  // Second label on the filesystem pylon: the last completed path and +n/-m (PIN-54).
  const detail = makeLabel('', 0.14, PYLON_HEIGHT / 2, 'middle');
  pylons.filesystem.group.add(detail);

  const pool = createPool({ THREE, parent: group });
  /** @type {Map<string, object>} `start` args by tool call id, until its `complete`. */
  const starts = new Map();

  bus.addEventListener('tool', (e) => onTool(e.detail));
  bus.addEventListener('frame', () => tick(Date.now()));

  function onTool(frame) {
    if (!frame || typeof frame !== 'object') return;
    const obelisk = getObelisk(frame.sid);
    if (!shouldFire(frame, Boolean(obelisk))) return;
    const pylon = pylonFor(frame.name);
    if (frame.phase === 'start') {
      remember(frame.id, frame.args);
      const now = Date.now();
      // A slab older than the visible window keeps a stale position, so a
      // hidden slab falls back to the base like a missing one does.
      const slab = obelisk.slabs?.find((s) => s.slabId === frame.id);
      const launch = slab && slab.visible ? slab : baseOf(obelisk);
      launch.getWorldPosition(_from);
      pylons[pylon].box.getWorldPosition(_to);
      pool.fire(_from, _to, now);
      pylons[pylon].glowUntil = now + GLOW_MS; // a repeat restarts the timer
    } else if (frame.phase === 'complete') {
      if (pylon === 'filesystem') {
        const args = frame.args ?? starts.get(frame.id) ?? {};
        const path = args.path ?? args.file_path ?? '';
        const { added, removed } = diffCounts(frame.diff);
        detail.text = `${path}\n+${added}/-${removed}`;
        detail.sync();
      }
      starts.delete(frame.id);
    }
  }

  function remember(id, args) {
    if (id == null || !args) return;
    starts.delete(id);
    starts.set(id, args);
    if (starts.size > STARTS_KEPT) starts.delete(starts.keys().next().value);
  }

  function tick(now) {
    pool.update(now);
    for (const name of PYLONS) {
      const p = pylons[name];
      const k = Math.max(0, Math.min(1, (p.glowUntil - now) / GLOW_MS));
      p.box.material.color.copy(BASE_COLOR).lerp(GLOW_COLOR, k);
    }
  }
}
