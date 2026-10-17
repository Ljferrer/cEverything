// Tile pools + LOD (PROTOCOL.md §5): far = one InstancedMesh of color bars for ALL columns (capacity 4000, one draw
// call); mid/near = pooled textured planes (48 summary 512×128, 12 full 512×192). LOD by head→tile distance at 5 Hz
// with 0.15 m hysteresis and per-device thresholds; textures redraw only when (messageId, lod, rev) changes.

import * as THREE from 'three';
import { makeCanvas, makeTexture, sharedPlaneGeometry } from '../text/canvas-text.js';
import { paintTile, roleColor, SUMMARY_SIZE, FULL_SIZE } from '../text/tile-paint.js';

export const LOD = Object.freeze({ GLYPH: 0, SUMMARY: 1, FULL: 2 });
export const LOD_NAME = ['glyph', 'summary', 'full'];
export const THRESHOLDS = Object.freeze({
  desktop: [1.2, 3.0], quest: [1.2, 3.0], phone: [1.2, 3.0], unknown: [1.2, 3.0], visionpro: [0.9, 2.0],
});
export const HYSTERESIS = 0.15;
export const LOD_INTERVAL_MS = 200; // 5 Hz
export const TILE = Object.freeze({ w: 0.36, h: 0.12, d: 0.02, pitch: 0.14, barH: 0.06, fullH: 0.135 });
export const POOL = Object.freeze({ summary: 48, full: 12, bars: 4000 });

const _m = new THREE.Matrix4(); const _q = new THREE.Quaternion(); const _p = new THREE.Vector3(); const _s = new THREE.Vector3();
const _color = new THREE.Color();
// '#RRGGBB' → THREE.Color, parsed once: Color.set(string) runs the CSS regex path and the bars are recolored every frame
const BAR_COLORS = new Map();
function barColor(hex) { let c = BAR_COLORS.get(hex); if (!c) { c = new THREE.Color(hex); BAR_COLORS.set(hex, c); } return c; }

/** A plane slot owns one canvas + texture for its lifetime; redrawn in place. */
function makeSlot(lod) {
  const size = lod === LOD.FULL ? FULL_SIZE : SUMMARY_SIZE;
  const { canvas, ctx } = makeCanvas(size.width, size.height);
  const texture = makeTexture(canvas);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: true });
  const mesh = new THREE.Mesh(sharedPlaneGeometry(), material);
  mesh.scale.set(TILE.w, lod === LOD.FULL ? TILE.fullH : TILE.h, 1);
  mesh.visible = false; mesh.frustumCulled = true;
  mesh.renderOrder = 2;
  return { lod, canvas, ctx, texture, material, mesh, record: null, key: '' };
}

/**
 * createTilePool({ scene, device, scale }) → pool. Columns register themselves; each frame `update(now, headPos)`
 * writes bar matrices + plane transforms; every 200 ms it runs the LOD pass.
 */
export function createTilePool({ scene, device = 'desktop', scale = 1 } = {}) {
  const root = new THREE.Group(); root.name = 'tiles'; scene.add(root);
  const columns = new Set();
  let thresholds = THRESHOLDS[device] || THRESHOLDS.unknown;
  let roomScale = scale;
  let lastLod = 0;
  const stats = { tiles: 0, bars: 0, summary: 0, full: 0, redraws: 0, lodPasses: 0, lodMs: 0 };

  // ---------------------------------------------------------------- bars
  const barGeo = new THREE.BoxGeometry(TILE.w, TILE.barH, TILE.d);
  const barMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const bars = new THREE.InstancedMesh(barGeo, barMat, POOL.bars);
  bars.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(POOL.bars * 3), 3);
  bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bars.instanceColor.setUsage(THREE.DynamicDrawUsage);
  bars.count = 0; bars.frustumCulled = false; bars.name = 'tile-bars';
  root.add(bars);

  // ---------------------------------------------------------------- planes
  const summarySlots = []; const fullSlots = [];
  for (let i = 0; i < POOL.summary; i++) { const s = makeSlot(LOD.SUMMARY); root.add(s.mesh); summarySlots.push(s); }
  for (let i = 0; i < POOL.full; i++) { const s = makeSlot(LOD.FULL); root.add(s.mesh); fullSlots.push(s); }

  // ---------------------------------------------------------------- outlines (local hover + selection)
  const outlineGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(TILE.w + 0.06, TILE.h + 0.02, TILE.d + 0.02));
  const outlines = {
    hover: new THREE.LineSegments(outlineGeo, new THREE.LineBasicMaterial({ color: 0x3b82f6 })),
    select: new THREE.LineSegments(outlineGeo, new THREE.LineBasicMaterial({ color: 0xffffff })),
  };
  const outlineTargets = { hover: null, select: null };
  for (const o of Object.values(outlines)) { o.visible = false; o.frustumCulled = false; root.add(o); }

  function setOutline(name, record) {
    outlineTargets[name] = record || null;
    if (!record) outlines[name].visible = false;
  }

  // ---------------------------------------------------------------- slot assignment
  function releaseSlot(record) {
    const slot = record.slot;
    if (!slot) return;
    slot.record = null; slot.key = ''; slot.mesh.visible = false; record.slot = null;
  }

  function takeSlot(list) { return list.find((s) => !s.record) || null; }

  function redrawIfNeeded(slot, record) {
    const msg = record.msg;
    const key = `${msg.id}|${slot.lod}|${msg.rev}`;
    if (slot.key === key) return;
    slot.key = key;
    paintTile(slot.ctx, msg, LOD_NAME[slot.lod]);
    slot.texture.needsUpdate = true;
    stats.redraws++;
  }

  function assign(record, lod) {
    if (record.slot && record.slot.lod === lod) { redrawIfNeeded(record.slot, record); record.lod = lod; return true; }
    if (record.slot) releaseSlot(record);
    if (lod === LOD.GLYPH) { record.lod = LOD.GLYPH; return true; }
    const slot = takeSlot(lod === LOD.FULL ? fullSlots : summarySlots);
    if (!slot) return false;
    slot.record = record; record.slot = slot; record.lod = lod;
    slot.mesh.visible = true;
    redrawIfNeeded(slot, record);
    return true;
  }

  /** Wanted LOD from distance with hysteresis around the previous wanted LOD. */
  function wantedLod(prev, d) {
    const t1 = thresholds[0] * roomScale; const t2 = thresholds[1] * roomScale; const h = HYSTERESIS * roomScale;
    if (prev === LOD.FULL) { if (d <= t1 + h) return LOD.FULL; return d <= t2 + h ? LOD.SUMMARY : LOD.GLYPH; }
    if (prev === LOD.SUMMARY) { if (d < t1) return LOD.FULL; if (d <= t2 + h) return LOD.SUMMARY; return LOD.GLYPH; }
    if (d < t1) return LOD.FULL; if (d < t2) return LOD.SUMMARY; return LOD.GLYPH;
  }

  const candidates = [];
  function lodPass(headPos) {
    const t0 = performance.now();
    candidates.length = 0;
    for (const col of columns) {
      for (const r of col.tiles) {
        r.dist = headPos.distanceTo(r.world);
        r.want = wantedLod(r.want ?? LOD.GLYPH, r.dist);
        if (r.want !== LOD.GLYPH) candidates.push(r); else if (r.slot) releaseSlot(r), (r.lod = LOD.GLYPH);
      }
    }
    candidates.sort((a, b) => a.dist - b.dist);
    // nearest ≤ 12 wanting full get full planes; the rest wanting full/summary get summary planes (≤ 48); overflow → glyph
    let fullLeft = POOL.full; let summaryLeft = POOL.summary;
    // first release slots whose lod no longer matches, so they can be reused in this pass
    for (const r of candidates) { if (r.slot && r.slot.lod !== r.want) releaseSlot(r); }
    for (const r of candidates) {
      let lod = r.want;
      if (lod === LOD.FULL) { if (fullLeft > 0) fullLeft--; else lod = LOD.SUMMARY; }
      if (lod === LOD.SUMMARY) { if (summaryLeft > 0) summaryLeft--; else lod = LOD.GLYPH; }
      if (!assign(r, lod)) { if (lod === LOD.FULL && summaryLeft > 0) { summaryLeft--; if (!assign(r, LOD.SUMMARY)) assign(r, LOD.GLYPH); } else assign(r, LOD.GLYPH); }
    }
    stats.lodPasses++;
    stats.lodMs = performance.now() - t0;
  }

  // ---------------------------------------------------------------- per-frame transforms
  function update(now, headPos) {
    // positions: columns update record.world / record.scale themselves in column.update(); here we consume them
    if (now - lastLod >= LOD_INTERVAL_MS) { lastLod = now; lodPass(headPos); }
    const pulse = 0.75 + 0.25 * Math.sin(now * 0.001 * Math.PI); // 0.5 Hz
    let n = 0; let tiles = 0; let summary = 0; let full = 0;
    for (const col of columns) {
      const q = col.group.quaternion;
      for (const r of col.tiles) {
        tiles++;
        const msg = r.msg;
        if (r.slot) {
          const mesh = r.slot.mesh;
          mesh.position.copy(r.world);
          mesh.quaternion.copy(q);
          const sx = TILE.w * r.scale; mesh.scale.set(sx, (r.slot.lod === LOD.FULL ? TILE.fullH : TILE.h) * r.scale, 1);
          const op = msg.role === 'thinking' ? 0.6 : 1;
          r.slot.material.opacity = msg.streaming ? op * pulse : op;
          if (msg.streaming && r.slot.key !== `${msg.id}|${r.slot.lod}|${msg.rev}`) redrawIfNeeded(r.slot, r);
          if (r.slot.lod === LOD.FULL) full++; else summary++;
          continue;
        }
        if (n >= POOL.bars) continue;
        _p.copy(r.world); _s.set(r.scale, r.scale, r.scale);
        _m.compose(_p, q, _s);
        bars.setMatrixAt(n, _m);
        _color.copy(barColor(roleColor(msg)));
        if (msg.role === 'thinking') _color.multiplyScalar(0.6);
        if (msg.streaming) _color.multiplyScalar(pulse);
        bars.setColorAt(n, _color);
        n++;
      }
    }
    bars.count = n;
    // upload only the used range (the buffers are sized for 4000 instances)
    bars.instanceMatrix.clearUpdateRanges(); bars.instanceMatrix.addUpdateRange(0, n * 16); bars.instanceMatrix.needsUpdate = true;
    if (bars.instanceColor) { bars.instanceColor.clearUpdateRanges(); bars.instanceColor.addUpdateRange(0, n * 3); bars.instanceColor.needsUpdate = true; }
    stats.tiles = tiles; stats.bars = n; stats.summary = summary; stats.full = full;
    for (const name of ['hover', 'select']) {
      const r = outlineTargets[name]; const o = outlines[name];
      if (!r || !r.column || !columns.has(r.column) || !r.column.tiles.includes(r)) { o.visible = false; continue; }
      o.visible = true; o.position.copy(r.world); o.quaternion.copy(r.column.group.quaternion);
    }
  }

  function registerColumn(col) { columns.add(col); }
  function unregisterColumn(col) { for (const r of col.tiles) releaseSlot(r); columns.delete(col); }
  function release(record) { releaseSlot(record); record.lod = LOD.GLYPH; record.want = LOD.GLYPH; }
  function setDevice(d) { thresholds = THRESHOLDS[d] || THRESHOLDS.unknown; }
  function setScale(s) { roomScale = Number(s) > 0 ? Number(s) : 1; }
  function forceLod() { lastLod = 0; }

  return {
    root, bars, LOD, TILE, POOL, outlines,
    registerColumn, unregisterColumn, release, update, setDevice, setScale, setOutline, forceLod,
    get thresholds() { return thresholds; },
    stats() { return { ...stats, columns: columns.size, summaryPool: POOL.summary, fullPool: POOL.full } ; },
  };
}

export default { createTilePool, LOD, LOD_NAME, THRESHOLDS, HYSTERESIS, TILE, POOL };
