// PURE text helpers shared by the normalizer and the tool describers. No Node imports.

export const SUMMARY_MAX = 100;
export const SESSION_SUMMARY_MAX = 80;

export function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** First sentence of a text (≤ max chars). */
export function firstSentence(text, max = SUMMARY_MAX) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const m = flat.match(/^.*?[.!?](?=\s|$)/);
  const sentence = m ? m[0] : flat;
  return clip(sentence, max);
}

/** Hermes timestamps are unix float seconds; tolerate ms and ISO strings. Returns ms. */
export function toMs(ts, fallback = 0) {
  if (ts === null || ts === undefined || ts === '') return fallback;
  if (typeof ts === 'number') return ts > 1e12 ? Math.round(ts) : Math.round(ts * 1000);
  if (typeof ts === 'string') {
    const n = Number(ts);
    if (Number.isFinite(n)) return toMs(n, fallback);
    const d = Date.parse(ts);
    return Number.isFinite(d) ? d : fallback;
  }
  return fallback;
}

export function parseJSONish(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

export function hostOf(url) {
  try { const u = new URL(String(url)); return u.host + (u.pathname !== '/' ? u.pathname : ''); } catch { return String(url || ''); }
}

export function firstLine(text) {
  return String(text ?? '').split('\n').find((l) => l.trim()) || '';
}

