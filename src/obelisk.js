// One session = one obelisk (PIN-1): a stone base in its state color, a title label, and
// a vertical stack of message slabs, newest at the bottom. The look is a homage to the
// SEELE monoliths: a matte black body with red edges stands behind the stack,
// and a red glyph ("Ψ 03") over a red "SOUND ONLY" line tops it. A Codex session
// (`session.harness === 'codex'`) gets its own look from LOOKS: teal stone,
// teal edges, a terminal glyph (">_ 04"), and a "CODEX" line. Each frame `update(camera)`
// picks a LOD band per slab (PIN-13) and shows full text, the mid summary, or a
// role-colored bar. Slabs stack by measured height (src/stack.js): troika lays
// text out asynchronously, so every `sync` re-runs the layout when it completes,
// and every band change with unchanged text re-runs it at once.
// `setState`, `setBeacon`, and `slabMesh` are the later plans' seams.
//
// Each slab is a card: a thin outline in its role color frames the text. User cards get larger bold text,
// a full-strength outline, and a dark panel; thinking and tool cards are
// smaller and dimmer. A text card is its measured text plus CARD_PAD above and
// below, so SLAB_GAP stays open between outlines. The far band hides the outline and panel, since the bar
// already reads as one card and the room has many far slabs.
//
// Pick targets (PIN-22): every slab mesh carries userData {sid, slabId} and the
// base carries userData {sid, kind:'base'}. The body, its edges, the glyph,
// the SOUND ONLY line, and each card's outline and panel never take a pick: a
// ray that misses a slab must not land on the body and fork the session.
import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { lod, midSummary, coneScale } from './lod.js';
import { colorFor, stateColor, MONOLITH_BLACK, MONOLITH_RED, CODEX_STONE, CODEX_TEAL } from './colors.js';
import { BAR_HEIGHT, slabHeight, stackLayout } from './stack.js';

export const BASE_SIZE = 1.2;
export const BASE_HEIGHT = 0.1;
export const SLAB_WIDTH = 1.5;
export const STACK_BOTTOM = BASE_HEIGHT + 0.16; // room above the base for the title
export const MAX_VISIBLE = 40;
export const TITLE_SIZE = 0.09;
export const MAX_KEPT = 200; // older slabs are disposed; the relay caches the same count
export const CHERUB_KEPT = 4; // a subagent keeps only its last few slabs, so a swarm of hundreds stays light
export const BODY_WIDTH = 1.65;
export const BODY_DEPTH = 0.06;
export const GLYPH_SIZE = 0.2;
export const SOUND_SIZE = 0.045;
export const MIN_BODY_TOP = 1.8; // a short stack still stands as a tall monolith
const BODY_GAP = 0.02; // the body's front face sits this far behind the slab text
export const CARD_PAD = 0.012; // the outline sits this far above and below the slab text
export const ROLE_FONT = Object.freeze({ user: 0.06, assistant: 0.04, thinking: 0.034, tool: 0.034 });
const DIM_ROLES = new Set(['thinking', 'tool']);
const PANEL_COLOR = 0x0a1a26; // a dark blue-black behind user text

// Shared by every obelisk: the body is a unit box scaled to the stack height.
const BODY_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
export const BODY_MATERIAL = new THREE.MeshBasicMaterial({ color: MONOLITH_BLACK });
const EDGE_GEOMETRY = new THREE.EdgesGeometry(BODY_GEOMETRY);
const EDGE_MATERIAL = new THREE.LineBasicMaterial({ color: MONOLITH_RED });
export const CODEX_BODY_MATERIAL = new THREE.MeshBasicMaterial({ color: CODEX_STONE });
const CODEX_EDGE_MATERIAL = new THREE.LineBasicMaterial({ color: CODEX_TEAL });
const noPick = () => {};

// Shared by every card: a unit rectangle (x -0.5..0.5, y 0..1) scaled to the
// slab, one outline material per role, and one panel for user cards.
const OUTLINE_GEOMETRY = new THREE.BufferGeometry().setFromPoints(
  [[-0.5, 0], [0.5, 0], [0.5, 0], [0.5, 1], [0.5, 1], [-0.5, 1], [-0.5, 1], [-0.5, 0]].map(([x, y]) => new THREE.Vector3(x, y, 0)),
);
const outlineMaterials = new Map();
function outlineMaterial(role) {
  if (!outlineMaterials.has(role)) {
    const strong = role === 'user';
    outlineMaterials.set(role, new THREE.LineBasicMaterial({ color: colorFor(role), transparent: !strong, opacity: strong ? 1 : 0.45 }));
  }
  return outlineMaterials.get(role);
}
const PANEL_GEOMETRY = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);

// The far-band bar: one shared plane, one solid material per role.
const BAR_GEOMETRY = new THREE.PlaneGeometry(SLAB_WIDTH, BAR_HEIGHT).translate(0, BAR_HEIGHT / 2, 0);
const barMaterials = new Map();
function barMaterial(role) {
  if (!barMaterials.has(role)) barMaterials.set(role, new THREE.MeshBasicMaterial({ color: colorFor(role) }));
  return barMaterials.get(role);
}

// The base: a shared stone box whose vertex colors darken the sides and light
// the top, times the obelisk's own material color (its state color, which
// state.js sets and pulses), with the shared red edges of the body.
const BASE_GEOMETRY = new THREE.BoxGeometry(BASE_SIZE, BASE_HEIGHT, BASE_SIZE);
BASE_GEOMETRY.setAttribute(
  'color',
  new THREE.Float32BufferAttribute(
    Array.from({ length: 24 }, (_, v) => (Math.floor(v / 4) === 2 ? [0.7, 0.7, 0.7] : [0.18, 0.18, 0.18])).flat(),
    3,
  ),
); // BoxGeometry faces: +x, -x, +y (top), -y, +z, -z, four vertices each
const BASE_EDGES = new THREE.EdgesGeometry(BASE_GEOMETRY);
const PANEL_MATERIAL = new THREE.MeshBasicMaterial({ color: PANEL_COLOR });

const SYMBOLS = ['Δ', 'Θ', 'Λ', 'Ξ', 'Π', 'Σ', 'Φ', 'Ψ', 'Ω', 'Γ'];
const CODEX_SYMBOLS = ['>_', '$_', '{ }', '[ ]', '</>', '::', '#!', '~/'];
const numbers = new Map(); // sid -> creation-order number, so a rebuilt obelisk keeps its glyph

/** The look per harness: SEELE for Claude Code, Hermes, and synthetic; teal stone for Codex. */
export const LOOKS = Object.freeze({
  seele: Object.freeze({ body: BODY_MATERIAL, edges: EDGE_MATERIAL, accent: MONOLITH_RED, symbols: SYMBOLS, motto: 'SOUND ONLY' }),
  codex: Object.freeze({ body: CODEX_BODY_MATERIAL, edges: CODEX_EDGE_MATERIAL, accent: CODEX_TEAL, symbols: CODEX_SYMBOLS, motto: 'CODEX' }),
});

export function lookFor(harness) {
  return harness === 'codex' ? LOOKS.codex : LOOKS.seele;
}

/** The glyph for a sid: a symbol from a hash of the sid, then its two-digit creation number. */
export function glyphFor(sid, symbols = SYMBOLS) {
  if (!numbers.has(sid)) numbers.set(sid, numbers.size + 1);
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < sid.length; i++) h = Math.imul(h ^ sid.charCodeAt(i), 0x01000193);
  return `${symbols[(h >>> 0) % symbols.length]} ${String(numbers.get(sid)).padStart(2, '0')}`;
}

/** A text's measured height once troika has laid it out, else `fallback`. */
function textHeight(t, fallback) {
  const b = t.textRenderInfo?.blockBounds;
  return b ? b[3] - b[1] : fallback;
}

const _slabPos = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _selfPos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _toSelf = new THREE.Vector3();

function makeText(text, fontSize, color, onSync) {
  const t = new Text();
  t.text = text;
  t.fontSize = fontSize;
  t.color = color;
  t.sdfGlyphSize = 64;
  t.maxWidth = SLAB_WIDTH;
  t.overflowWrap = 'break-word'; // long paths, URLs and ids wrap inside the slab instead of running off it
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
    this.maxKept = session.parent ? CHERUB_KEPT : MAX_KEPT;
    /** @type {Array<THREE.Group & {slabId:string, role:string, full:string, band:string|null, text:Text, bar:THREE.Mesh}>} */
    this.slabs = [];
    this.toolCount = 0;
    this.look = lookFor(session.harness);

    this.base = new THREE.Mesh(BASE_GEOMETRY, new THREE.MeshBasicMaterial({ vertexColors: true, color: stateColor(session.status) }));
    this.base.position.y = BASE_HEIGHT / 2;
    this.base.userData = { sid: session.sid, kind: 'base' };
    const baseEdges = new THREE.LineSegments(BASE_EDGES, this.look.edges);
    baseEdges.raycast = noPick;
    this.base.add(baseEdges);
    this.add(this.base);

    // The title rides on top of the stack (set in #layoutStack), where it stays
    // readable from across the room instead of hiding under the slabs.
    this.title = makeText(session.title, TITLE_SIZE, 0xffffff, () => this.#layoutStack());
    this.title.userData = { sid: session.sid, kind: 'base' }; // a title hit selects the obelisk, like its base
    this.add(this.title);

    this.body = new THREE.Mesh(BODY_GEOMETRY, this.look.body);
    this.body.raycast = noPick;
    const edges = new THREE.LineSegments(EDGE_GEOMETRY, this.look.edges);
    edges.raycast = noPick;
    this.body.add(edges);
    this.add(this.body);

    this.glyph = makeText(glyphFor(session.sid, this.look.symbols), GLYPH_SIZE, this.look.accent, () => this.#layoutStack());
    this.glyph.raycast = noPick;
    this.add(this.glyph);
    this.sound = makeText(this.look.motto, SOUND_SIZE, this.look.accent, () => this.#layoutStack());
    this.sound.letterSpacing = 0.15;
    this.sound.raycast = noPick;
    this.add(this.sound);

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
      this.title.sync(() => this.#layoutStack());
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

  /**
   * Seam for plans 2 and 4: the scene object of the slab with `slabId`, or null.
   * It is the Group placed in the stack (userData {sid, slabId}) that holds the
   * slab's text and bar, so its world position is the slab's.
   */
  slabMesh(slabId) {
    return this.#find(slabId);
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

    const color = DIM_ROLES.has(role) ? new THREE.Color(colorFor(role)).multiplyScalar(0.7).getHex() : colorFor(role);
    slab.text = makeText(text, ROLE_FONT[role] ?? ROLE_FONT.assistant, color, () => this.#layoutStack());
    if (role === 'user') slab.text.fontWeight = 'bold';
    slab.text.position.y = CARD_PAD;
    slab.text.userData = { sid: this.sid, slabId: id };
    slab.add(slab.text);

    slab.outline = new THREE.LineSegments(OUTLINE_GEOMETRY, outlineMaterial(role));
    slab.outline.raycast = noPick;
    slab.add(slab.outline);
    if (role === 'user') {
      slab.panel = new THREE.Mesh(PANEL_GEOMETRY, PANEL_MATERIAL);
      slab.panel.position.z = -0.004; // behind the text, in front of the body
      slab.panel.raycast = noPick;
      slab.add(slab.panel);
    }

    slab.bar = new THREE.Mesh(BAR_GEOMETRY, barMaterial(role));
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
    // Turn about the vertical axis to face the viewer, so slab text never
    // reads mirrored from an orbit camera outside the ring. A headset at the
    // room center sees the same facing room.js's lookAt(0, 0, 0) gave.
    this.getWorldPosition(_selfPos);
    this.rotation.set(0, Math.atan2(_camPos.x - _selfPos.x, _camPos.z - _selfPos.z), 0);
    // Forward cone: one scale for the whole obelisk from the horizontal angle
    // between the viewer's facing and this obelisk (see coneScale in lod.js).
    camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    _toSelf.subVectors(_selfPos, _camPos);
    _toSelf.y = 0;
    const flat = camera.isCamera && _fwd.lengthSq() > 1e-6 && _toSelf.lengthSq() > 1e-6;
    const scale = flat ? coneScale(_fwd.normalize().dot(_toSelf.normalize())) : 1;
    for (const slab of this.slabs) {
      if (!slab.visible) continue;
      slab.getWorldPosition(_slabPos);
      const band = lod(_slabPos.distanceTo(_camPos) * scale, slab.full.length, slab.band);
      if (band !== slab.band) this.#apply(slab, band);
    }
  }

  dispose() {
    for (const slab of this.slabs) this.#drop(slab);
    this.slabs.length = 0;
    this.title.dispose();
    this.glyph.dispose();
    this.sound.dispose(); // the body's geometry and materials are shared, so they stay
    this.base.material.dispose(); // the base geometry and edges are shared
    this.beacon.geometry.dispose();
    this.beacon.material.dispose();
  }

  #find(id) {
    for (let i = this.slabs.length - 1; i >= 0; i--) if (this.slabs[i].slabId === id) return this.slabs[i];
    return null;
  }

  #apply(slab, band) {
    slab.band = band;
    slab.outline.visible = band !== 'far';
    if (slab.panel) slab.panel.visible = band !== 'far';
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

  // Newest at the bottom, so the stack grows upward like a chat log: each new
  // slab lands on the base and pushes the older ones up. Each slab's bottom is
  // at the summed measured heights of the slabs below it; only the last MAX_VISIBLE show,
  // slabs past MAX_KEPT are disposed. Above the stack go the title, the SOUND
  // ONLY line, and the glyph; the body reaches from the base to above the
  // glyph, at least to MIN_BODY_TOP with the glyph at its top, and the beacon
  // rides above the body.
  #layoutStack() {
    while (this.slabs.length > this.maxKept) this.#drop(this.slabs.shift());
    const firstVisible = Math.max(0, this.slabs.length - MAX_VISIBLE);
    const shown = this.slabs.slice(firstVisible);
    const heights = shown.map(
      (slab) => slabHeight({ band: slab.band, textRenderInfo: slab.text.textRenderInfo }) + (slab.band === 'far' ? 0 : 2 * CARD_PAD),
    );
    const { offsets, height } = stackLayout(heights.toReversed()); // stackLayout runs bottom to top
    this.slabs.forEach((slab, i) => {
      slab.visible = i >= firstVisible;
      if (!slab.visible) return;
      const j = i - firstVisible;
      const h = heights[j];
      slab.position.y = offsets[shown.length - 1 - j];
      slab.outline.scale.set(SLAB_WIDTH + 2 * CARD_PAD, h, 1);
      slab.panel?.scale.copy(slab.outline.scale);
    });
    this.title.position.y = STACK_BOTTOM + height + 0.04;
    const soundH = textHeight(this.sound, SOUND_SIZE * 1.2);
    const glyphH = textHeight(this.glyph, GLYPH_SIZE * 1.2);
    const titleTop = this.title.position.y + textHeight(this.title, TITLE_SIZE * 1.2);
    const top = Math.max(titleTop + 0.04 + soundH + 0.02 + glyphH + 0.06, MIN_BODY_TOP);
    this.glyph.position.y = top - 0.06 - glyphH;
    this.sound.position.y = this.glyph.position.y - 0.02 - soundH;
    this.body.scale.set(BODY_WIDTH, top - BASE_HEIGHT, BODY_DEPTH);
    this.body.position.set(0, (BASE_HEIGHT + top) / 2, -(BODY_GAP + BODY_DEPTH / 2));
    this.beacon.position.y = top + 0.25;
  }

  #drop(slab) {
    this.stack.remove(slab); // the outline, panel, and bar share their geometry and materials
    slab.text.dispose();
  }
}

export function createObelisk(session) {
  return new Obelisk(session);
}
