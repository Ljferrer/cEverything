// Pylons and projectiles (plan 4, PIN-2): four wireframe pylons at the compass
// points, radius 5 m (PIN-51); a `tool` start fires a pooled sphere from the
// calling slab (or the obelisk base) to the tool's pylon and lights the pylon
// for 2 s (PIN-52, PIN-53, PIN-55); a filesystem `complete` writes the file's
// basename and `+n/-m` on the filesystem pylon (PIN-54); every label turns to
// the camera each frame. Frames for a sid with no obelisk and for spawning
// tools are dropped (PIN-50). This is the only plan 4 file
// that adds objects to the scene (PIN-56); it never edits plan 1's files.
import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { getObelisk as roomGetObelisk } from './room.js';
import { PYLONS, pylonFor, shouldFire, diffCounts } from '../pylon-map.js';
import { createPool } from '../projectile.js';

export const PYLON_RADIUS = 5; // legacy; placement now comes from PLACE
export const PYLON_HEIGHT = 3;
export const PYLON_WIDTH = 0.6;
export const GLOW_MS = 2000;
const BASE_COLOR = new THREE.Color(0x546e7a); // slate, the idle state color
const GLOW_COLOR = new THREE.Color(0xffffff);
const STARTS_KEPT = 256; // remembered `start` args; a lost `complete` never leaks past this

/**
 * Wall placement (PIN-51, revised for the aisle): two pylons on each side
 * wall, well outside the chats and their child rows (which reach about 5 m
 * from the aisle center line), so the aisle and the floor around each chat
 * stay clear and every tool call flies across the room.
 */
export const PLACE = Object.freeze({
  browser: { x: -8, z: -4 },
  filesystem: { x: 8, z: -4 },
  shell: { x: -8, z: -12 },
  other: { x: 8, z: -12 },
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
  const label = makeLabel(name, 0.24, PYLON_HEIGHT + 0.1, 'bottom');
  g.add(label);
  const p = PLACE[name];
  g.position.set(p.x, 0, p.z);
  g.lookAt(0, 0, 0); // the labels sit on the face toward the room center; install turns them to the camera each frame
  return { group: g, box, label, glowUntil: -Infinity };
}

/** The filesystem detail text (PIN-54): the file's basename and `+n/-m`, short enough to fit the pylon. */
export function detailText(path, added, removed) {
  const name = String(path).split(/[\\/]/).pop();
  return `${name}\n+${added}/-${removed}`;
}

/** The base mesh under an obelisk (`Obelisk#base`), or the obelisk itself. */
function baseOf(obelisk) {
  return obelisk.base ?? obelisk;
}

export function install({ scene, bus, getObelisk = roomGetObelisk }) {
  const group = new THREE.Group();
  group.name = 'pylons';
  scene.add(group);

  /** @type {Record<string, {group: THREE.Group, box: THREE.Mesh, label: Text, glowUntil: number}>} */
  const pylons = {};
  for (const name of PYLONS) {
    pylons[name] = makePylon(name);
    group.add(pylons[name].group);
  }
  // Second label on the filesystem pylon: the last completed file's basename and +n/-m (PIN-54).
  const detail = makeLabel('', 0.14, PYLON_HEIGHT / 2, 'middle');
  detail.name = 'pylon:filesystem:detail';
  pylons.filesystem.group.add(detail);
  // Every label turns to the camera each frame, so none reads mirrored from behind.
  const labels = [detail, ...PYLONS.map((name) => pylons[name].label)];

  const pool = createPool({ THREE, parent: group });
  /** @type {Map<string, object>} `start` args by tool call id, until its `complete`. */
  const starts = new Map();

  bus.addEventListener('tool', (e) => onTool(e.detail));
  bus.addEventListener('frame', (e) => {
    tick(Date.now());
    const camera = e.detail?.camera;
    if (camera) for (const label of labels) label.lookAt(camera.position);
  });

  function onTool(frame) {
    if (!frame || typeof frame !== 'object') return;
    const obelisk = getObelisk(frame.sid);
    if (!shouldFire(frame, Boolean(obelisk))) return;
    const pylon = pylonFor(frame.name);
    if (frame.phase === 'start') {
      remember(frame.id, frame.args);
      const now = Date.now();
      // A slab past plan 1's MAX_VISIBLE cap (src/obelisk.js) is hidden and
      // keeps a stale position (its #layoutStack sets `slab.visible`), so a
      // hidden slab takes PIN-55's own base fallback, like a missing slab does.
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
        detail.text = detailText(path, added, removed);
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
