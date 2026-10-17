// Column = one session (PROTOCOL.md §5): base plate, status ring, glance panel, tile stack at a fixed 0.14 m pitch
// (newest at reading height, older tiles stacking upward, 300 ms shift), 60-tile window + spire "+N earlier",
// local scroll + summon, slide on layout.column (400 ms), beacon for waiting_on_you, hitboxes for input.

import * as THREE from 'three';
import { TILE, LOD } from './tiles.js';
import { makeBase, makeRing, updateRing, makeGlance, makeBeacon, makeHitboxes } from './column-parts.js';
import { makeTextSprite } from '../text/canvas-text.js';
import { ease } from './fx.js';

export const WINDOW = 60;
export const SHIFT_MS = 300;
export const SLIDE_MS = 400;
export const GROW_MS = 200;
export const SUMMON_DIST = 0.9;
export const SUMMON_MIN = 0.45;
export const SUMMON_MARGIN = 0.25;
export const SPIRE_TOP = 30;

const _v = new THREE.Vector3();

/** Yaw that makes a column at (x, z) face the point (tx, tz). */
export function faceYaw(x, z, tx, tz) { return Math.atan2(tx - x, tz - z); }

/**
 * Summon distance that lands the column INSIDE the active full-LOD band (DESIGN graft: "glides to 0.9 m … at full
 * LOD"): min(0.9, max(0.45, fullThreshold·scale − 0.25)) → 0.9 m on Quest/desktop, 0.65 m on Vision Pro (t1 0.9),
 * 0.54 m at ?scale=0.66 on Quest. With the head ~0.3 m above reading height the nearest tiles then sit well under t1.
 */
export function summonDistance(fullThreshold, scale = 1) {
  const t1 = Number(fullThreshold);
  if (!Number.isFinite(t1) || t1 <= 0) return SUMMON_DIST;
  return Math.min(SUMMON_DIST, Math.max(SUMMON_MIN, t1 * (Number(scale) > 0 ? Number(scale) : 1) - SUMMON_MARGIN));
}

export class Column {
  constructor({ session, placement, store, pool, fx, scale = 1, readingHeight = 1.3 }) {
    this.id = session.id;
    this.session = session;
    this.store = store; this.pool = pool; this.fx = fx;
    this.scale = scale; this.readingHeight = readingHeight;
    this.group = new THREE.Group();
    this.group.name = `column:${session.id}`;
    this.group.userData.column = this;
    this.placement = { sessionId: session.id, x: 0, z: -1.8, rot: 0, ...placement };
    this.records = new Map();   // messageId → record
    this.tiles = [];            // window, index 0 = newest (at reading height)
    this.scroll = 0; this.earlierCount = 0; this.newerCount = 0;
    this.summoned = false; this.summonPose = null;
    this.dragging = false; this.removed = false; this.focused = false; this.gazed = false;
    this.slide = null;

    this.base = makeBase();
    this.ring = makeRing();
    this.glance = makeGlance();
    this.beacon = makeBeacon();
    this.hit = makeHitboxes(this);
    this.spire = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 1.3, 0), new THREE.Vector3(0, SPIRE_TOP, 0)]),
      new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.6 }),
    );
    this.spire.visible = false; this.spire.frustumCulled = false;
    this.earlier = makeTextSprite('', { widthM: 0.30, heightM: 0.06, fontPx: 34, color: '#cbd5e1', bg: 'rgba(15,23,42,0.8)', maxLines: 1 });
    this.earlier.visible = false;
    this.newer = makeTextSprite('', { widthM: 0.30, heightM: 0.06, fontPx: 34, color: '#cbd5e1', bg: 'rgba(15,23,42,0.8)', maxLines: 1 });
    this.newer.visible = false;
    this.group.add(this.base, this.ring, this.glance.group, this.beacon.group, this.spire, this.earlier, this.newer, ...this.hit.all);

    this.applyPose(this.placement.x * this.scale, this.placement.z * this.scale, this.placement.rot);
    this.group.updateMatrixWorld(true);
    this.pool.registerColumn(this);
    this.rebuildWindow(false);
    this.setSession(session);
  }

  // ------------------------------------------------------------------ session / glance
  setSession(s) {
    this.session = s;
    this.glance.setSession(s);
    this.beacon.setAttention(s.attention, s.status === 'waiting_on_you');
    this.group.userData.status = s.status;
  }

  setFocused(on) { this.focused = Boolean(on); this.refreshHighlight(); }
  setGazed(on) { this.gazed = Boolean(on); this.refreshHighlight(); }
  refreshHighlight() {
    const on = this.focused || this.gazed;
    this.base.material.color.set(this.focused ? 0xffffff : on ? 0xe5e7eb : 0x9ca3af);
    this.base.material.opacity = on ? 1 : 0.8;
    this.glance.setHighlight(on);
  }

  // ------------------------------------------------------------------ placement
  applyPose(x, z, rot) { this.group.position.set(x, 0, z); this.group.rotation.y = rot; }

  /** Server placement (meters, unscaled). Slides over 400 ms unless animate=false. Ignored while dragging/summoned. */
  setPlacement(p, animate = true) {
    this.placement = { sessionId: this.id, x: Number(p.x) || 0, z: Number(p.z) || 0, rot: Number(p.rot) || 0 };
    if (this.dragging || this.summoned) return;
    this.moveTo(this.placement.x * this.scale, this.placement.z * this.scale, this.placement.rot, animate);
  }

  moveTo(x, z, rot, animate = true) {
    if (!animate) { this.slide = null; this.applyPose(x, z, rot); return; }
    const from = this.group.position.clone();
    const rotFrom = this.group.rotation.y;
    let dRot = rot - rotFrom; while (dRot > Math.PI) dRot -= Math.PI * 2; while (dRot < -Math.PI) dRot += Math.PI * 2;
    this.slide = { from, to: new THREE.Vector3(x, 0, z), rotFrom, rotTo: rotFrom + dRot, start: performance.now() };
  }

  /** Local prediction while the base is dragged (world meters). */
  setDragPosition(x, z, faceOrigin = true) {
    this.dragging = true; this.slide = null;
    const rot = faceOrigin ? faceYaw(x, z, 0, 0) : this.group.rotation.y;
    this.applyPose(x, z, rot);
  }
  endDrag() { this.dragging = false; }
  /** Placement to send with layout.move for the current pose (unscaled meters). */
  poseAsPlacement() { return { sessionId: this.id, x: round3(this.group.position.x / this.scale), z: round3(this.group.position.z / this.scale), rot: round3(this.group.rotation.y) }; }

  setScale(scale) { this.scale = scale; if (!this.summoned && !this.dragging) this.moveTo(this.placement.x * scale, this.placement.z * scale, this.placement.rot, true); }

  // ------------------------------------------------------------------ summon (local)
  summon(viewerPos, viewerYaw, dist = SUMMON_DIST) {
    // three.js yaw: forward = (−sin yaw, 0, −cos yaw); the column lands `dist` ahead of the viewer (see summonDistance), facing them
    const d = Number.isFinite(dist) && dist > 0 ? dist : SUMMON_DIST;
    const fx = viewerPos.x - Math.sin(viewerYaw) * d;
    const fz = viewerPos.z - Math.cos(viewerYaw) * d;
    this.summoned = true;
    this.summonPose = { x: fx, z: fz, rot: faceYaw(fx, fz, viewerPos.x, viewerPos.z), dist: d };
    this.moveTo(fx, fz, this.summonPose.rot, true);
  }
  unsummon() {
    if (!this.summoned) return;
    this.summoned = false; this.summonPose = null;
    this.moveTo(this.placement.x * this.scale, this.placement.z * this.scale, this.placement.rot, true);
  }
  toggleSummon(viewerPos, viewerYaw, dist) { if (this.summoned) this.unsummon(); else this.summon(viewerPos, viewerYaw, dist); }

  /** Per-viewer view state (summon pose, scroll offset) carried over when a snapshot resync rebuilds this column. */
  restoreView({ summoned = false, summonPose = null, scroll = 0 } = {}) {
    if (scroll > 0) { this.scroll = scroll; this.rebuildWindow(false); }
    if (summoned && summonPose) {
      this.summoned = true; this.summonPose = { ...summonPose }; this.slide = null;
      this.applyPose(summonPose.x, summonPose.z, summonPose.rot);
      this.group.updateMatrixWorld(true);
    }
  }

  // ------------------------------------------------------------------ tiles
  visibleMessages() { return this.store.messagesOf(this.id).filter((m) => !m.hidden); }

  /** Recompute the 60-tile window from the store; animate shifts when `animate`. */
  rebuildWindow(animate = true) {
    const msgs = this.visibleMessages();
    const len = msgs.length;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, len - 1)));
    const end = len - this.scroll; const start = Math.max(0, end - WINDOW);
    const now = performance.now();
    const next = [];
    const keep = new Set();
    for (let i = end - 1; i >= start; i--) {
      const msg = msgs[i];
      const idx = end - 1 - i;
      const yTarget = this.readingHeight + idx * TILE.pitch;
      let r = this.records.get(msg.id);
      if (!r) {
        r = { msg, column: this, y: yTarget, yFrom: yTarget, yTarget, animStart: 0, bornAt: animate ? now : 0, scale: animate ? 0.001 : 1,
          lod: LOD.GLYPH, want: LOD.GLYPH, slot: null, dist: Infinity, world: new THREE.Vector3() };
        this.records.set(msg.id, r);
      } else if (r.yTarget !== yTarget) {
        if (animate) { r.yFrom = r.y; r.animStart = now; } else { r.y = yTarget; r.yFrom = yTarget; r.animStart = 0; }
        r.yTarget = yTarget;
      }
      r.msg = msg;
      next.push(r);
      keep.add(msg.id);
    }
    for (const [id, r] of this.records) if (!keep.has(id)) { this.pool.release(r); this.records.delete(id); }
    this.tiles = next;
    this.earlierCount = start;
    this.newerCount = this.scroll;
    this.refreshSpire();
  }

  /** message.add for this session. */
  addMessage(msg) {
    if (msg.hidden) return;
    if (this.scroll > 0) { this.scroll += 1; this.rebuildWindow(false); return; } // hold the scrolled view
    this.rebuildWindow(true);
  }

  /** delta/complete/tool.* — geometry is unchanged; the pool redraws by msg.rev. */
  touchMessage() { /* no-op: pool keys include msg.rev */ }

  removeMessage(msgId) { const r = this.records.get(msgId); if (r) { this.pool.release(r); this.records.delete(msgId); } this.rebuildWindow(false); }

  scrollBy(n) { const len = this.visibleMessages().length; const next = Math.max(0, Math.min(this.scroll + n, Math.max(0, len - 1))); if (next === this.scroll) return; this.scroll = next; this.rebuildWindow(true); }
  scrollHome() { if (this.scroll === 0) return; this.scroll = 0; this.rebuildWindow(true); }

  setReadingHeight(h) { this.readingHeight = h; this.rebuildWindow(true); }

  refreshSpire() {
    const n = this.tiles.length;
    const topY = this.readingHeight + Math.max(0, n - 1) * TILE.pitch;
    if (this.earlierCount > 0) {
      const pos = this.spire.geometry.attributes.position;
      pos.setXYZ(0, 0, topY + TILE.pitch / 2, 0); pos.setXYZ(1, 0, SPIRE_TOP, 0); pos.needsUpdate = true;
      this.spire.visible = true;
      this.earlier.setText(`+${this.earlierCount} earlier`); this.earlier.visible = true; this.earlier.position.y = topY + TILE.pitch + 0.02;
    } else { this.spire.visible = false; this.earlier.visible = false; }
    if (this.newerCount > 0) { this.newer.setText(`+${this.newerCount} newer ↓`); this.newer.visible = true; this.newer.position.y = this.readingHeight - TILE.pitch; }
    else this.newer.visible = false;
    // stack hitbox covers the window
    const h = Math.max(1, n) * TILE.pitch;
    this.hit.stack.scale.set(0.40, h, 0.10);
    this.hit.stack.position.y = this.readingHeight + (Math.max(1, n) - 1) * TILE.pitch / 2;
  }

  /** Record for a message id (null if outside the window). */
  tileRecord(messageId) { const r = this.records.get(messageId); return r && this.tiles.includes(r) ? r : null; }

  /** Record under a world point (from a stack hitbox hit). */
  tileAt(worldPoint) {
    _v.copy(worldPoint); this.group.worldToLocal(_v);
    const idx = Math.round((_v.y - this.readingHeight) / TILE.pitch);
    return idx >= 0 && idx < this.tiles.length ? this.tiles[idx] : null;
  }

  /** World position of a tile record (or of the newest tile when none given). */
  worldOf(record) { const r = record || this.tiles[0]; return r ? r.world.clone() : this.group.localToWorld(new THREE.Vector3(0, this.readingHeight, 0)); }
  basePosition() { return this.group.localToWorld(new THREE.Vector3(0, 0.05, 0)); }
  titlePosition() { return this.group.localToWorld(new THREE.Vector3(0, 1.15, 0)); }

  // ------------------------------------------------------------------ per frame
  update(now) {
    if (this.slide) {
      const k = Math.min(1, (now - this.slide.start) / SLIDE_MS);
      const e = ease.outCubic(k);
      this.group.position.lerpVectors(this.slide.from, this.slide.to, e);
      this.group.rotation.y = this.slide.rotFrom + (this.slide.rotTo - this.slide.rotFrom) * e;
      if (k >= 1) this.slide = null;
    }
    this.group.updateMatrixWorld(true);
    for (const r of this.tiles) {
      if (r.animStart) {
        const k = Math.min(1, (now - r.animStart) / SHIFT_MS);
        r.y = r.yFrom + (r.yTarget - r.yFrom) * ease.outCubic(k);
        if (k >= 1) r.animStart = 0;
      } else r.y = r.yTarget;
      if (r.bornAt) {
        const k = Math.min(1, (now - r.bornAt) / GROW_MS);
        r.scale = Math.max(0.001, ease.outCubic(k));
        if (k >= 1) { r.scale = 1; r.bornAt = 0; }
      }
      r.world.set(0, r.y, 0).applyMatrix4(this.group.matrixWorld);
    }
    updateRing(this.ring, this.session.status, now);
    this.beacon.update(now);
  }

  /** Fade/scale out then dispose (session.remove). */
  fadeOut(onDone) {
    this.removed = true;
    this.fx.tweens.add({ ms: 300, onUpdate: (k) => { this.group.scale.set(1 - k * 0.999, 1 - k * 0.999, 1 - k * 0.999); }, onDone: () => { this.dispose(); onDone?.(); } });
  }

  dispose() {
    this.pool.unregisterColumn(this);
    this.group.parent?.remove(this.group);
    this.glance.dispose(); this.beacon.dispose();
    this.earlier.disposeText(); this.newer.disposeText();
    this.spire.geometry.dispose(); this.spire.material.dispose();
    this.ring.material.dispose(); this.base.material.dispose(); this.hit.material.dispose();
    this.records.clear(); this.tiles = [];
  }
}

const round3 = (v) => Math.round(v * 1000) / 1000;

export default { Column, faceYaw, summonDistance, WINDOW, SHIFT_MS, SLIDE_MS, SUMMON_DIST };
