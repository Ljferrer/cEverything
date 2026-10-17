// Tile painters: draw a Message into a pooled canvas at summary (512×128) or full (512×192) LOD (PROTOCOL.md §5).
// Pure canvas drawing; no three.js. Colors per §5 (role colors + category chips).

import { ROLE_COLORS, CATEGORY_COLORS } from '/shared/protocol.js';
import { font, wrapText, roundRect } from './canvas-text.js';

export const SUMMARY_SIZE = Object.freeze({ width: 512, height: 128 });
export const FULL_SIZE = Object.freeze({ width: 512, height: 192 });

const ROLE_LABEL = { user: 'you', assistant: 'agent', thinking: 'thinking', tool_call: 'tool', tool_result: 'result', system: 'system' };

/** Primary color for a message (hex string). */
export function roleColor(msg) {
  if (msg.role === 'tool_result' && msg.tool && msg.tool.ok === false) return ROLE_COLORS.error;
  return ROLE_COLORS[msg.role] || ROLE_COLORS.system;
}

export function categoryColor(msg) {
  const cat = msg.tool?.category;
  return (cat && CATEGORY_COLORS[cat]) || CATEGORY_COLORS.tools;
}

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function timeOf(ts) {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function dashedBorder(ctx, w, h, color) {
  ctx.save();
  ctx.setLineDash([14, 10]);
  ctx.strokeStyle = color; ctx.lineWidth = 4;
  roundRect(ctx, 3, 3, w - 6, h - 6, 14); ctx.stroke();
  ctx.restore();
}

function frame(ctx, w, h, msg) {
  const color = roleColor(msg);
  ctx.clearRect(0, 0, w, h);
  // background: dark slate, tinted by role
  ctx.fillStyle = 'rgba(10,14,22,0.92)';
  roundRect(ctx, 1, 1, w - 2, h - 2, 14); ctx.fill();
  ctx.fillStyle = hexToRgba(color, msg.role === 'tool_result' ? 0.06 : 0.14);
  roundRect(ctx, 1, 1, w - 2, h - 2, 14); ctx.fill();
  if (msg.role === 'thinking') dashedBorder(ctx, w, h, hexToRgba(color, 0.9));
  else if (msg.role === 'tool_result') { ctx.strokeStyle = hexToRgba(color, 0.95); ctx.lineWidth = 4; roundRect(ctx, 3, 3, w - 6, h - 6, 14); ctx.stroke(); }
  else { ctx.strokeStyle = hexToRgba(color, 0.55); ctx.lineWidth = 3; roundRect(ctx, 2, 2, w - 4, h - 4, 14); ctx.stroke(); }
  // category chip on the left edge for tool calls; role stripe otherwise
  if (msg.role === 'tool_call') { ctx.fillStyle = categoryColor(msg); roundRect(ctx, 4, 4, 22, h - 8, 8); ctx.fill(); }
  else { ctx.fillStyle = hexToRgba(color, 0.9); roundRect(ctx, 4, 8, 8, h - 16, 4); ctx.fill(); }
  return color;
}

/** Summary LOD: role glyph + ≤ 2 lines of summary (~48 chars). */
export function paintSummary(ctx, msg, size = SUMMARY_SIZE) {
  const { width: w, height: h } = size;
  const color = frame(ctx, w, h, msg);
  const glyph = msg.glyph || '?';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.font = font(glyph.length > 1 ? 40 : 56, { weight: 700 });
  ctx.fillText(glyph, 70, h / 2);
  const textX = 118; const maxW = w - textX - 16;
  const f = font(36, { weight: 500, mono: msg.role === 'tool_call' || msg.role === 'tool_result' });
  const text = msg.summary || msg.text || '';
  const { lines } = wrapText(text, f, maxW, 2);
  ctx.font = f; ctx.textAlign = 'left';
  ctx.fillStyle = msg.role === 'thinking' ? hexToRgba(color, 0.95) : '#e5e7eb';
  const lineH = 44; const total = lineH * lines.length;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], textX, h / 2 - total / 2 + lineH * (i + 0.5));
  if (msg.streaming) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(w - 22, 22, 7, 0, Math.PI * 2); ctx.fill(); }
}

/** Full LOD: header (role · time · tool/duration) + 3 wrapped lines (~130 chars) ending in "…" when longer. */
export function paintFull(ctx, msg, size = FULL_SIZE) {
  const { width: w, height: h } = size;
  const color = frame(ctx, w, h, msg);
  const x0 = 40;
  // header
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.font = font(22, { weight: 700 });
  ctx.fillStyle = color;
  let head = ROLE_LABEL[msg.role] || msg.role;
  if (msg.role === 'tool_call' && msg.tool) head = `${msg.glyph || ''} ${msg.tool.name}`.trim();
  if (msg.role === 'tool_result' && msg.tool) head = `↩ ${msg.tool.name || 'result'}${msg.tool.ok === false ? ' ✗' : ''}${Number.isFinite(msg.tool.durationMs) ? ` · ${(msg.tool.durationMs / 1000).toFixed(1)} s` : ''}`;
  if (msg.via === 'voice') head += ' · 🎤'; else if (msg.via === 'pipe' && msg.from) head += ' · piped';
  ctx.fillText(head, x0, 24);
  ctx.textAlign = 'right'; ctx.fillStyle = '#9ca3af'; ctx.font = font(20, { weight: 500 });
  ctx.fillText(timeOf(msg.ts), w - 18, 24);
  // body
  const mono = msg.role === 'tool_call' || msg.role === 'tool_result';
  const f = font(mono ? 26 : 28, { weight: 500, mono });
  let body = msg.text || '';
  if (msg.role === 'tool_call') body = toolArgsText(msg);
  if (!body) body = msg.summary || '';
  const { lines } = wrapText(body, f, w - x0 - 18, 3);
  ctx.font = f; ctx.textAlign = 'left';
  ctx.fillStyle = msg.role === 'thinking' ? hexToRgba(color, 0.95) : '#f3f4f6';
  const lineH = 40; const top = 50;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x0, top + lineH * (i + 0.5));
  if (msg.streaming) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(w - 22, h - 22, 7, 0, Math.PI * 2); ctx.fill(); }
}

/** Compact one-line-per-arg rendering of tool args for the full tile. */
export function toolArgsText(msg) {
  const t = msg.tool || {};
  const a = t.args;
  if (t.meta?.command) return `$ ${t.meta.command}`;
  if (!a || typeof a !== 'object') return msg.summary || t.preview || '';
  const parts = [];
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined || v === null) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}: ${s.length > 160 ? s.slice(0, 159) + '…' : s}`);
    if (parts.length >= 4) break;
  }
  return parts.join('\n') || msg.summary || '';
}

/** Paint by LOD name. */
export function paintTile(ctx, msg, lod) {
  if (lod === 'full') paintFull(ctx, msg);
  else paintSummary(ctx, msg);
}

export default { paintSummary, paintFull, paintTile, roleColor, categoryColor, toolArgsText, SUMMARY_SIZE, FULL_SIZE };
