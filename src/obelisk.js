// One session = one obelisk (PIN-1): a wireframe base box, a title label, and
// a vertical stack of message slabs, newest on top. Each frame `update(camera)`
// picks a LOD band per slab (PIN-13) and shows full text, the mid summary, or a
// role-colored bar. Slabs stack by measured height (src/stack.js): troika lays
// text out asynchronously, so every `sync` re-runs the layout when it completes,
// and every band change with unchanged text re-runs it at once.
// `setState` and `setBeacon` are the plan 6 seams.
//
// Pick targets (PIN-22): every slab mesh carries userData {sid, slabId} and the
// base carries userData {sid, kind:'base'}.
import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { lod, midSummary } from './lod.js';
import { colorFor, stateColor } from './colors.js';
import { BAR_HEIGHT, slabHeight, stackLayout } from './stack.js';

export const BASE_SIZE = 0.5;
export const BASE_HEIGHT = 0.1;
export const SLAB_WIDTH = 0.6;
export const STACK_BOTTOM = BASE_HEIGHT + 0.16; // room above the base for the title
export const MAX_VISIBLE = 40;
export const MAX_KEPT = 200; // older slabs are disposed; the relay caches the same count

const _slabPos = new THREE.Vector3();
const _camPos = new THREE.Vector3();

function makeText(text, fontSize, color, onSync) {
  const t = new Text();
  t.text = text;
  t.fontSize = fontSize;
  t.color = color;
  t.sdfGlyphSize = 64;
  t.maxWidth = SLAB_WIDTH;
  t.anchorX = 'center';
  t.anchorY = 'bottom';
  t.sync(onSync);
  return t;
}

export class Obelisk extends THREE.Group {
  /** @param {{sid:string, title:string, status:string, parent?:string|null, phase?:string|null}} session */
  constructor(session) {
    super();
    this.sid = session.sid;
    this.session = { ...session };
    this.status = session.status;
    this.userData = { sid: session.sid, kind: 'obelisk' };
    /** @type {Array<THREE.Group & {slabId:string, role:string, full:string, band:string|null, text:Text, bar:THREE.Mesh}>} */
    this.slabs = [];
    this.toolCount = 0;

    this.base = new THREE.Mesh(
      new THREE.BoxGeometry(BASE_SIZE, BASE_HEIGHT, BASE_SIZE),
      new THREE.MeshBasicMaterial({ wireframe: true, color: stateColor(session.status) }),
    );
    this.base.position.y = BASE_HEIGHT / 2;
    this.base.userData = { sid: session.sid, kind: 'base' };
    this.add(this.base);

    this.title = makeText(session.title, 0.06, 0xffffff);
    this.title.position.y = BASE_HEIGHT + 0.02;
    this.title.userData = { sid: session.sid, kind: 'base' }; // a title hit selects the obelisk, like its base
    this.add(this.title);

    this.stack = new THREE.Group();
    this.stack.position.y = STACK_BOTTOM;
    this.add(this.stack);

    this.beacon = new THREE.Mesh(
      new THREE.ConeGeometry(0.08, 0.3, 6),
      new THREE.MeshBasicMaterial({ wireframe: true, color: 0xffffff }),
    );
    this.beacon.visible = false;
    this.beacon.userData = { sid: session.sid, kind: 'base' };
    this.add(this.beacon);
    this.#layoutStack();
  }

  setTitle(title) {
    this.session.title = title;
    if (this.title.text !== title) {
      this.title.text = title;
      this.title.sync();
    }
  }

  /** Plan 6 seam: recolor the base for a session status. */
  setState(status) {
    this.status = status;
    this.session.status = status;
    this.base.material.color.setHex(stateColor(status));
  }

  /** Plan 6 seam: show or hide the beacon above the stack. */
  setBeacon(on) {
    this.beacon.visible = Boolean(on);
  }

  /** A `slab` event: one new slab on top (or a replacement when the id repeats). */
  addSlab({ id, role, text }) {
    const existing = this.#find(id);
    if (existing) {
      existing.full = text;
      this.#apply(existing, existing.band ?? 'near');
      return existing;
    }
    const slab = new THREE.Group();
    slab.slabId = id;
    slab.role = role;
    slab.full = text;
    slab.band = null;
    slab.userData = { sid: this.sid, slabId: id };

    slab.text = makeText(text, 0.04, colorFor(role), () => this.#layoutStack());
    slab.text.userData = { sid: this.sid, slabId: id };
    slab.add(slab.text);

    slab.bar = new THREE.Mesh(
      new THREE.PlaneGeometry(SLAB_WIDTH, BAR_HEIGHT),
      new THREE.MeshBasicMaterial({ wireframe: true, color: colorFor(role) }),
    );
    slab.bar.position.y = BAR_HEIGHT / 2;
    slab.bar.visible = false;
    slab.bar.userData = { sid: this.sid, slabId: id };
    slab.add(slab.bar);

    this.slabs.push(slab);
    this.stack.add(slab);
    if (role === 'tool') {
      this.toolCount += 1;
      for (const s of this.slabs) if (s.band === 'mid') this.#apply(s, 'mid');
    }
    this.#layoutStack();
    return slab;
  }

  /** A `delta` event: append to the open slab with that id (else the newest of that role, else a new slab). */
  appendDelta({ id, role, text }) {
    let slab = this.#find(id);
    if (!slab) {
      for (let i = this.slabs.length - 1; i >= 0 && !slab; i--) if (this.slabs[i].role === role) slab = this.slabs[i];
    }
    if (!slab) return this.addSlab({ id, role, text });
    slab.full += text;
    this.#apply(slab, slab.band ?? 'near');
    return slab;
  }

  /** Per frame: pick each visible slab's LOD band from its distance to the camera. */
  update(camera) {
    camera.getWorldPosition(_camPos);
    for (const slab of this.slabs) {
      if (!slab.visible) continue;
      slab.getWorldPosition(_slabPos);
      const band = lod(_slabPos.distanceTo(_camPos), slab.full.length, slab.band);
      if (band !== slab.band) this.#apply(slab, band);
    }
  }

  dispose() {
    for (const slab of this.slabs) this.#drop(slab);
    this.slabs.length = 0;
    this.title.dispose();
    this.base.geometry.dispose();
    this.base.material.dispose();
    this.beacon.geometry.dispose();
    this.beacon.material.dispose();
  }

  #find(id) {
    for (let i = this.slabs.length - 1; i >= 0; i--) if (this.slabs[i].slabId === id) return this.slabs[i];
    return null;
  }

  #apply(slab, band) {
    slab.band = band;
    if (band === 'far') {
      slab.text.visible = false;
      slab.bar.visible = true;
      this.#layoutStack(); // the bar is shorter than the text it replaces
      return;
    }
    slab.bar.visible = false;
    slab.text.visible = true;
    const want = band === 'near' ? slab.full : midSummary(slab.full, this.toolCount);
    if (slab.text.text !== want) {
      slab.text.text = want;
      slab.text.sync(() => this.#layoutStack());
    } else {
      this.#layoutStack(); // same text, new band: a far bar may have just become this text again
    }
  }

  // Oldest at the bottom, newest on top, each slab's bottom at the summed
  // measured heights of the slabs below it; only the last MAX_VISIBLE show,
  // slabs past MAX_KEPT are disposed, and the beacon rides above the top.
  #layoutStack() {
    while (this.slabs.length > MAX_KEPT) this.#drop(this.slabs.shift());
    const firstVisible = Math.max(0, this.slabs.length - MAX_VISIBLE);
    const shown = this.slabs.slice(firstVisible);
    const { offsets, height } = stackLayout(
      shown.map((slab) => slabHeight({ band: slab.band, textRenderInfo: slab.text.textRenderInfo })),
    );
    this.slabs.forEach((slab, i) => {
      slab.visible = i >= firstVisible;
      if (slab.visible) slab.position.y = offsets[i - firstVisible];
    });
    this.beacon.position.y = STACK_BOTTOM + height + 0.25;
  }

  #drop(slab) {
    this.stack.remove(slab);
    slab.text.dispose();
    slab.bar.geometry.dispose();
    slab.bar.material.dispose();
  }
}

export function createObelisk(session) {
  return new Obelisk(session);
}
