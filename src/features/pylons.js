// Pylons and projectiles (plan 4, PIN-2): four tool monoliths stand far out
// past the end of the hall and rise past the camera's far plane, so no top ever
// shows; a `tool` start
// fires a pooled sphere from the
// calling slab (or the obelisk base) to the tool's pylon, leaves a tracer line
// along its arc, and lights the pylon for 2 s (PIN-52, PIN-53, PIN-55); a filesystem `complete` writes the file's
// basename and `+n/-m` on the filesystem pylon (PIN-54); every label turns to
// the camera each frame. Frames for a sid with no obelisk and for spawning
// tools are dropped (PIN-50). This is the only plan 4 file
// that adds objects to the scene (PIN-56); it never edits plan 1's files.
// Each pylon also has a textured face box inside its wireframe, from a
// Higgsfield render in public/assets/pylon-<name>.jpg, framed by red edges in
// the SEELE style. The face stays hidden until its texture loads, so a missing
// file keeps the plain edge frame, and the face brightens with the edges
// during the glow.
import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { getObelisk as roomGetObelisk } from './room.js';
import { PYLONS, pylonFor, shouldFire, diffCounts } from '../pylon-map.js';
import { createPool, createTracers } from '../projectile.js';
import { MONOLITH_RED, MONOLITH_BLACK } from '../colors.js';

export const PYLON_RADIUS = 5; // legacy; placement now comes from PLACE
export const PYLON_HEIGHT = 15; // the textured face at the foot, where labels sit and tool calls land
export const PYLON_RISE = 2000; // the column: far past the camera's far plane, so it never ends in view
export const PYLON_WIDTH = 3.2;
export const PYLON_DEPTH = 0.7; // a flat monolith, broad face toward the path
export const GLOW_MS = 2000;
const BASE_COLOR = new THREE.Color(MONOLITH_RED); // the SEELE red edges
const GLOW_COLOR = new THREE.Color(0xffffff);
const FACE_IDLE = new THREE.Color(0.75, 0.75, 0.75); // the face texture, a little dimmed
const FACE_GLOW = new THREE.Color(2.6, 1.8, 1.8); // over 1, so the dark stone and red emblem flare
const FACE_INSET = 0.98; // inside the edge frame, so its edges never z-fight the face
const BOX_EDGES = new THREE.EdgesGeometry(new THREE.BoxGeometry(PYLON_WIDTH, PYLON_RISE, PYLON_DEPTH));
const BODY_INSET = 0.96; // the black column sits inside the face and the edge frame
const BODY_GEOMETRY = new THREE.BoxGeometry(PYLON_WIDTH * BODY_INSET, PYLON_RISE, PYLON_DEPTH * BODY_INSET);
const STARTS_KEPT = 256; // remembered `start` args; a lost `complete` never leaks past this

/**
 * Far placement (PIN-51, revised for the winding path): the four monoliths
 * stand in a shallow arc past the end of the path (24 chats reach about
 * z = -80), so they loom at its end and every tool call arcs a long way out.
 */
export const PLACE = Object.freeze({
  browser: { x: -28, z: -98 },
  shell: { x: -10, z: -108 },
  other: { x: 10, z: -108 },
  filesystem: { x: 28, z: -98 },
});

/** The face texture URL for a pylon name. */
export const textureUrl = (name) => `/assets/pylon-${name}.jpg`;

/** Load a texture in the background; a failed load (or no DOM, as under node) only logs. */
function loadTexture(url, onLoad) {
  const fail = () => console.log(`pylons: ${url} failed to load`);
  try {
    new THREE.TextureLoader().load(url, onLoad, undefined, fail);
  } catch {
    fail();
  }
}

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();

function makeLabel(text, fontSize, y, anchorY) {
  const t = new Text();
  t.text = text;
  t.fontSize = fontSize;
  t.color = 0xffffff;
  t.sdfGlyphSize = 64;
  t.maxWidth = PYLON_WIDTH * 4;
  t.anchorX = 'center';
  t.anchorY = anchorY;
  t.position.set(0, y, PYLON_DEPTH / 2 + 0.05); // just in front of the face toward the room
  t.sync();
  return t;
}

function makePylon(name, load) {
  const g = new THREE.Group();
  g.name = `pylon:${name}`;
  const box = new THREE.LineSegments(BOX_EDGES, new THREE.LineBasicMaterial({ color: BASE_COLOR.getHex() }));
  box.raycast = () => {}; // nothing picks a pylon
  box.position.y = PYLON_RISE / 2;
  box.userData = { kind: 'pylon', pylon: name };
  g.add(box);
  const body = new THREE.Mesh(BODY_GEOMETRY, new THREE.MeshBasicMaterial({ color: MONOLITH_BLACK }));
  body.name = `pylon:${name}:body`;
  body.raycast = () => {};
  body.position.y = PYLON_RISE / 2;
  g.add(body);
  const face = new THREE.Mesh(
    new THREE.BoxGeometry(PYLON_WIDTH * FACE_INSET, PYLON_HEIGHT * FACE_INSET, PYLON_DEPTH * FACE_INSET),
    new THREE.MeshBasicMaterial({ color: FACE_IDLE }),
  );
  face.name = `pylon:${name}:face`;
  face.position.y = PYLON_HEIGHT / 2;
  face.visible = false; // shown once the texture arrives
  face.userData = { kind: 'pylon', pylon: name };
  g.add(face);
  load(textureUrl(name), (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    face.material.map = tex;
    face.material.needsUpdate = true;
    face.visible = true;
  });
  const label = makeLabel(name, 1.2, PYLON_HEIGHT + 0.4, 'bottom');
  g.add(label);
  const p = PLACE[name];
  g.position.set(p.x, 0, p.z);
  g.lookAt(0, 0, 0); // the broad face turns back up the path; install turns the labels to the camera each frame
  return { group: g, box, face, label, glowUntil: -Infinity };
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

export function install({ scene, bus, getObelisk = roomGetObelisk, load = loadTexture }) {
  const group = new THREE.Group();
  group.name = 'pylons';
  scene.add(group);

  /** @type {Record<string, {group: THREE.Group, box: THREE.Mesh, face: THREE.Mesh, label: Text, glowUntil: number}>} */
  const pylons = {};
  for (const name of PYLONS) {
    pylons[name] = makePylon(name, load);
    group.add(pylons[name].group);
  }
  // Second label on the filesystem pylon: the last completed file's basename and +n/-m (PIN-54).
  const detail = makeLabel('', 0.7, PYLON_HEIGHT / 2, 'middle');
  detail.name = 'pylon:filesystem:detail';
  pylons.filesystem.group.add(detail);
  // Every label turns to the camera each frame, so none reads mirrored from behind.
  const labels = [detail, ...PYLONS.map((name) => pylons[name].label)];

  const pool = createPool({ THREE, parent: group });
  const tracers = createTracers({ THREE, parent: group });
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
    if (bus.scrubbed && !frame.replayed) return; // timeline.js holds the room scrubbed back
    const obelisk = getObelisk(frame.sid);
    if (!shouldFire(frame, Boolean(obelisk))) return;
    const pylon = pylonFor(frame.name);
    if (frame.phase === 'start') {
      remember(frame.id, frame.args);
      if (frame.replayed && !frame.playback) return; // a timeline rebuild fires no projectile; Play does
      const now = Date.now();
      // A slab past plan 1's MAX_VISIBLE cap (src/obelisk.js) is hidden and
      // keeps a stale position (its #layoutStack sets `slab.visible`), so a
      // hidden slab takes PIN-55's own base fallback, like a missing slab does.
      const slab = obelisk.slabs?.find((s) => s.slabId === frame.id);
      const launch = slab && slab.visible ? slab : baseOf(obelisk);
      launch.getWorldPosition(_from);
      pylons[pylon].face.getWorldPosition(_to); // the face center, not the endless column's
      pool.fire(_from, _to, now);
      tracers.trace(_from, _to, now);
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
    tracers.update(now);
    for (const name of PYLONS) {
      const p = pylons[name];
      const k = Math.max(0, Math.min(1, (p.glowUntil - now) / GLOW_MS));
      p.box.material.color.copy(BASE_COLOR).lerp(GLOW_COLOR, k);
      p.face.material.color.copy(FACE_IDLE).lerp(FACE_GLOW, k);
    }
  }
}
