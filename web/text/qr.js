// Tiny QR encoder (byte mode, EC level L, versions 1–10, all 8 masks with penalty scoring) + canvas drawing.
// No dependencies; pure functions so it can be unit-tested in Node (encode) and drawn in the browser (drawQR).

const EXP = new Uint8Array(512); const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

// version → [ecCodewordsPerBlock, [blocksGroup1, dataPerBlock1], [blocksGroup2, dataPerBlock2]] for level L
const EC_L = {
  1: [7, [1, 19], [0, 0]], 2: [10, [1, 34], [0, 0]], 3: [15, [1, 55], [0, 0]], 4: [20, [1, 80], [0, 0]], 5: [26, [1, 108], [0, 0]],
  6: [18, [2, 68], [0, 0]], 7: [20, [2, 78], [0, 0]], 8: [24, [2, 97], [0, 0]], 9: [30, [2, 116], [0, 0]], 10: [18, [2, 68], [2, 69]],
};
const ALIGN = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

function dataCapacity(v) { const [, g1, g2] = EC_L[v]; return g1[0] * g1[1] + g2[0] * g2[1]; }

function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= gmul(g[j], EXP[i]); }
    g = next;
  }
  return g;
}

function rsEncode(data, n) {
  const gen = rsGenerator(n);
  const res = new Array(n).fill(0);
  for (const b of data) {
    const factor = b ^ res[0];
    res.shift(); res.push(0);
    if (factor) for (let j = 0; j < n; j++) res[j] ^= gmul(gen[j + 1], factor);
  }
  return res;
}

function utf8(text) { return Array.from(new TextEncoder().encode(String(text))); }

function buildCodewords(bytes, v) {
  const cap = dataCapacity(v);
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4); push(bytes.length, v >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);
  const total = cap * 8;
  push(0, Math.min(4, total - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; data.push(b); }
  for (let pad = 0xec; data.length < cap; pad ^= 0xfd) data.push(pad);
  const [ec, g1, g2] = EC_L[v];
  const blocks = []; let off = 0;
  for (const [count, len] of [g1, g2]) for (let i = 0; i < count; i++) { const d = data.slice(off, off + len); off += len; blocks.push({ d, e: rsEncode(d, ec) }); }
  const out = [];
  const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

/** encode(text, { mask? }) → { size, modules: Uint8Array(size*size) (1 = dark), version, mask }. `mask` forces a pattern (tests). */
export function encode(text, { mask: forcedMask } = {}) {
  const bytes = utf8(text);
  let v = 1; while (v <= 10 && bytes.length > dataCapacity(v) - (v >= 10 ? 3 : 2)) v++;
  if (v > 10) throw new Error(`QR: text too long (${bytes.length} bytes, max ${dataCapacity(10) - 3})`);
  const size = 17 + 4 * v;
  const modules = new Uint8Array(size * size);
  const isFunc = new Uint8Array(size * size);
  const set = (x, y, dark, func = true) => { modules[y * size + x] = dark ? 1 : 0; if (func) isFunc[y * size + x] = 1; };

  // finders + separators
  for (const [fx, fy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = -1; y <= 7; y++) for (let x = -1; x <= 7; x++) {
      const px = fx + x; const py = fy + y; if (px < 0 || py < 0 || px >= size || py >= size) continue;
      const on = x >= 0 && x <= 6 && y >= 0 && y <= 6 && (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
      set(px, py, on);
    }
  }
  // timing
  for (let i = 8; i < size - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
  // alignment
  for (const pos of ALIGN[v] || []) for (const pos2 of ALIGN[v] || []) {
    if ((pos < 9 && pos2 < 9) || (pos < 9 && pos2 > size - 10) || (pos > size - 10 && pos2 < 9)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos + dx, pos2 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // reserve format areas (+ dark module)
  for (let i = 0; i < 9; i++) { if (i === 6) continue; set(i, 8, 0); set(8, i, 0); } // (6, 8) / (8, 6) belong to the timing pattern
  for (let i = 0; i < 8; i++) { set(size - 1 - i, 8, 0); set(8, size - 1 - i, 0); }
  set(8, size - 8, 1);
  // version info (v ≥ 7)
  if (v >= 7) {
    let rem = v; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) & 1 ? 0x1f25 : 0);
    const info = (v << 12) | rem;
    for (let i = 0; i < 18; i++) { const bit = (info >> i) & 1; const a = Math.floor(i / 3); const b = size - 11 + (i % 3); set(a, b, bit); set(b, a, bit); }
  }

  // data placement (zigzag)
  const cw = buildCodewords(bytes, v);
  let bitIdx = 0; const totalBits = cw.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j; const upward = ((right + 1) & 2) === 0; const y = upward ? size - 1 - vert : vert;
        if (isFunc[y * size + x]) continue;
        let dark = 0;
        if (bitIdx < totalBits) { dark = (cw[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1; bitIdx++; }
        modules[y * size + x] = dark;
      }
    }
  }

  // choose mask by penalty
  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  let best = null;
  for (let m = 0; m < 8; m++) {
    if (Number.isInteger(forcedMask) && m !== forcedMask) continue;
    const grid = new Uint8Array(modules);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFunc[y * size + x] && MASKS[m](x, y)) grid[y * size + x] ^= 1;
    writeFormat(grid, size, m);
    const p = penalty(grid, size);
    if (!best || p < best.p) best = { p, m, grid };
  }
  return { size, modules: best.grid, version: v, mask: best.m };
}

function writeFormat(grid, size, mask) {
  const data = (0b01 << 3) | mask; // level L = 01
  let rem = data; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) & 1 ? 0x537 : 0);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const put = (x, y, bit) => { grid[y * size + x] = bit; };
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    // first copy: down the column x = 8 beside the top-left finder, then along row y = 8
    if (i <= 5) put(8, i, bit); else if (i === 6) put(8, 7, bit); else if (i === 7) put(8, 8, bit); else if (i === 8) put(7, 8, bit); else put(14 - i, 8, bit);
    // second copy: along row y = 8 under the top-right finder, then down column x = 8 beside the bottom-left finder
    if (i < 8) put(size - 1 - i, 8, bit); else put(8, size - 15 + i, bit);
  }
}

function penalty(g, n) {
  let p = 0;
  for (let y = 0; y < n; y++) { let run = 1; for (let x = 1; x < n; x++) { if (g[y * n + x] === g[y * n + x - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
  for (let x = 0; x < n; x++) { let run = 1; for (let y = 1; y < n; y++) { if (g[y * n + x] === g[(y - 1) * n + x]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const c = g[y * n + x]; if (c === g[y * n + x + 1] && c === g[(y + 1) * n + x] && c === g[(y + 1) * n + x + 1]) p += 3; }
  let dark = 0; for (let i = 0; i < n * n; i++) dark += g[i];
  p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return p;
}

/** Draw a QR of `text` into a canvas element (quiet zone 4 modules). */
export function drawQR(canvas, text, { dark = '#0b0f14', light = '#ffffff', px } = {}) {
  if (!canvas) return null;
  const qr = encode(text);
  const quiet = 4; const cells = qr.size + quiet * 2;
  const size = px || canvas.width || 256;
  const scale = Math.max(1, Math.floor(size / cells));
  canvas.width = canvas.height = cells * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = light; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = dark;
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.modules[y * qr.size + x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
  return qr;
}

export default { encode, drawQR };
