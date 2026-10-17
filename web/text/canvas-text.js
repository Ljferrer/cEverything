// Canvas text utilities (PROTOCOL.md §1 text/canvas-text.js): word-wrap + measure, CanvasTexture factory,
// LRU cache (96 textures) for labels/sprites, system fonts only, sRGB color space, mipmaps.

import * as THREE from 'three';

export const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const MONO_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
export const LRU_CAPACITY = 96;

export function font(px, { weight = 500, mono = false, italic = false } = {}) {
  return `${italic ? 'italic ' : ''}${weight} ${px}px ${mono ? MONO_FAMILY : FONT_FAMILY}`;
}

let _measureCtx = null;
function measureCtx() {
  if (!_measureCtx) { const c = document.createElement('canvas'); c.width = 16; c.height = 16; _measureCtx = c.getContext('2d'); }
  return _measureCtx;
}

/** Width in px of `text` with `fontSpec`. */
export function measureText(text, fontSpec) {
  const ctx = measureCtx();
  ctx.font = fontSpec;
  return ctx.measureText(String(text)).width;
}

/**
 * Word-wrap `text` to at most `maxWidth` px; returns up to `maxLines` lines. Long words are split by character.
 * Explicit newlines are honoured. If the text is longer than fits, the last line ends with "…" (and truncated=true).
 */
export function wrapText(text, fontSpec, maxWidth, maxLines = 3) {
  const ctx = measureCtx();
  ctx.font = fontSpec;
  const lines = [];
  const paragraphs = String(text ?? '').replace(/\r/g, '').split('\n');
  let truncated = false;
  outer: for (let p = 0; p < paragraphs.length; p++) {
    const words = paragraphs[p].split(/\s+/).filter((w, i, arr) => w.length || arr.length === 1);
    let line = '';
    if (!words.length) { if (lines.length >= maxLines) { truncated = true; break; } lines.push(''); continue; }
    for (let w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (ctx.measureText(candidate).width <= maxWidth) { line = candidate; continue; }
      if (line) { if (lines.length >= maxLines) { truncated = true; break outer; } lines.push(line); line = ''; }
      // word alone too wide: split by characters
      while (ctx.measureText(w).width > maxWidth && w.length > 1) {
        let cut = w.length;
        while (cut > 1 && ctx.measureText(w.slice(0, cut)).width > maxWidth) cut = Math.floor(cut * 0.8);
        if (lines.length >= maxLines) { truncated = true; break outer; }
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      line = w;
    }
    if (lines.length >= maxLines) { truncated = true; break; }
    lines.push(line);
    if (p < paragraphs.length - 1 && lines.length >= maxLines) { truncated = true; break; }
  }
  if (truncated) {
    if (!lines.length) lines.push('');
    const i = lines.length - 1;
    let last = lines[i].replace(/[\s.,;:]+$/, '');
    while (last.length && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    lines[i] = last + '…';
  }
  return { lines, truncated };
}

/** Create a 2D canvas + context with device-independent pixel size. */
export function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: true });
  return { canvas, ctx };
}

/** CanvasTexture configured for text: sRGB, mipmaps, trilinear filtering, anisotropy. */
export function makeTexture(canvas, { anisotropy = 4 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Rounded rect path helper. */
export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Draw a label into ctx: background pill + wrapped text. opts: { fontPx, color, bg, align, padding, mono, maxLines, border }
 * Returns the wrapped lines.
 */
export function drawLabel(ctx, width, height, text, opts = {}) {
  const { fontPx = 40, color = '#e5e7eb', bg = 'rgba(15,23,42,0.85)', align = 'center', padding = 16, mono = false, maxLines = 2, border = null, weight = 500 } = opts;
  ctx.clearRect(0, 0, width, height);
  if (bg) { ctx.fillStyle = bg; roundRect(ctx, 1, 1, width - 2, height - 2, 18); ctx.fill(); }
  if (border) { ctx.strokeStyle = border; ctx.lineWidth = 4; roundRect(ctx, 2, 2, width - 4, height - 4, 18); ctx.stroke(); }
  const f = font(fontPx, { mono, weight });
  ctx.font = f;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = align;
  const { lines } = wrapText(text, f, width - padding * 2, maxLines);
  const lineH = fontPx * 1.2;
  const total = lineH * lines.length;
  const x = align === 'center' ? width / 2 : align === 'right' ? width - padding : padding;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x, height / 2 - total / 2 + lineH * (i + 0.5));
  return lines;
}

// ---------------------------------------------------------------------------
// LRU texture cache for labels (sprites / small planes). Key = kind|size|text|opts.

class LRU {
  constructor(capacity) { this.capacity = capacity; this.map = new Map(); this.hits = 0; this.misses = 0; }
  get(key) {
    const v = this.map.get(key);
    if (v === undefined) { this.misses++; return undefined; }
    this.map.delete(key); this.map.set(key, v); this.hits++;
    return v;
  }
  set(key, value, onEvict) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const [k, v] = this.map.entries().next().value;
      this.map.delete(k);
      if (onEvict) onEvict(v, k);
    }
  }
  get size() { return this.map.size; }
}

const cache = new LRU(LRU_CAPACITY);
const inUse = new Map(); // texture → refcount (so we never dispose a texture a live sprite still shows)

function retain(tex) { inUse.set(tex, (inUse.get(tex) || 0) + 1); }
function release(tex) {
  if (!tex) return;
  const n = (inUse.get(tex) || 0) - 1;
  if (n <= 0) { inUse.delete(tex); if (tex.userData.evicted) tex.dispose(); } else inUse.set(tex, n);
}
function onEvict(tex) { tex.userData.evicted = true; if (!inUse.has(tex)) tex.dispose(); }

/**
 * Cached label texture. opts: { width=512, height=128, fontPx, color, bg, align, mono, maxLines, border }
 */
export function labelTexture(text, opts = {}) {
  const width = opts.width || 512; const height = opts.height || 128;
  const key = `${width}x${height}|${text}|${opts.fontPx || ''}|${opts.color || ''}|${opts.bg || ''}|${opts.align || ''}|${opts.mono ? 'm' : ''}|${opts.maxLines || ''}|${opts.border || ''}|${opts.weight || ''}`;
  let tex = cache.get(key);
  if (tex) return tex;
  const { canvas, ctx } = makeCanvas(width, height);
  drawLabel(ctx, width, height, text, opts);
  tex = makeTexture(canvas);
  tex.userData.key = key;
  cache.set(key, tex, onEvict);
  return tex;
}

/**
 * A text sprite sized in meters. opts: { widthM=0.36, heightM=0.09, ...labelTexture opts }.
 * sprite.setText(text) swaps the cached texture; sprite.disposeText() releases it.
 */
export function makeTextSprite(text, opts = {}) {
  const widthM = opts.widthM || 0.36; const heightM = opts.heightM || 0.09;
  const width = opts.width || 512; const height = opts.height || Math.round(width * heightM / widthM);
  const o = { ...opts, width, height };
  const mat = new THREE.SpriteMaterial({ map: null, transparent: true, depthWrite: false, sizeAttenuation: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(widthM, heightM, 1);
  sprite.userData.text = null;
  sprite.setText = (t) => {
    const s = String(t ?? '');
    if (s === sprite.userData.text) return;
    const tex = labelTexture(s, o);
    release(mat.map);
    retain(tex);
    mat.map = tex;
    mat.needsUpdate = true;
    sprite.userData.text = s;
    sprite.visible = s.length > 0;
  };
  sprite.disposeText = () => { release(mat.map); mat.map = null; mat.dispose(); };
  sprite.setText(text);
  return sprite;
}

/** A flat text plane (not billboarded) in meters; same API as makeTextSprite. */
export function makeTextPlane(text, opts = {}) {
  const widthM = opts.widthM || 0.8; const heightM = opts.heightM || 0.2;
  const width = opts.width || 512; const height = opts.height || Math.round(width * heightM / widthM);
  const o = { ...opts, width, height };
  const mat = new THREE.MeshBasicMaterial({ map: null, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(sharedPlaneGeometry(), mat);
  mesh.scale.set(widthM, heightM, 1);
  mesh.userData.text = null;
  mesh.setText = (t) => {
    const s = String(t ?? '');
    if (s === mesh.userData.text) return;
    const tex = labelTexture(s, o);
    release(mat.map); retain(tex);
    mat.map = tex; mat.needsUpdate = true;
    mesh.userData.text = s;
    mesh.visible = s.length > 0;
  };
  mesh.disposeText = () => { release(mat.map); mat.map = null; mat.dispose(); };
  mesh.setText(text);
  return mesh;
}

let _plane = null;
/** Shared unit plane geometry (1×1) — scale the mesh instead of allocating geometry. */
export function sharedPlaneGeometry() { if (!_plane) _plane = new THREE.PlaneGeometry(1, 1); return _plane; }

export function cacheStats() { return { size: cache.size, capacity: LRU_CAPACITY, hits: cache.hits, misses: cache.misses, inUse: inUse.size }; }

export default { font, measureText, wrapText, makeCanvas, makeTexture, roundRect, drawLabel, labelTexture, makeTextSprite, makeTextPlane, sharedPlaneGeometry, cacheStats };
