// Fixture loading: fixtures/<scenario>/*.jsonl + layout.json + pylons.json → timeline (PROTOCOL.md §3).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { validateEvent } from '../protocol.js';

/** loadScenario(dir) → { name, dir, files:[{sessionId, file, lines:[{offset, ev}]}], layout, pylons, warnings } */
export async function loadScenario(dir) {
  const abs = path.resolve(dir);
  const warnings = [];
  let names;
  try { names = (await fsp.readdir(abs)).filter((n) => n.endsWith('.jsonl')).sort(); } catch (err) { throw new Error(`fixture dir ${abs}: ${err.message}`); }
  if (!names.length) throw new Error(`fixture dir ${abs} has no *.jsonl files`);
  const files = [];
  for (const name of names) {
    const file = path.join(abs, name);
    const text = await fsp.readFile(file, 'utf8');
    const lines = [];
    let offset = 0; let sessionId = null; let lineNo = 0;
    for (const raw of text.split('\n')) {
      lineNo += 1;
      const s = raw.trim();
      if (!s) continue;
      let obj;
      try { obj = JSON.parse(s); } catch (err) { warnings.push(`${name}:${lineNo} invalid JSON (${err.message})`); continue; }
      const { dt, ...ev } = obj;
      if (!ev.sessionId && sessionId) ev.sessionId = sessionId;
      const v = validateEvent(ev);
      if (!v.ok) { warnings.push(`${name}:${lineNo} ${v.error}`); continue; }
      if (sessionId === null) {
        sessionId = ev.sessionId;
        if (ev.kind !== 'session.upsert' || (dt || 0) !== 0) warnings.push(`${name}: first line should be {"dt":0,…,"kind":"session.upsert"}`);
      }
      offset += Math.max(0, Number(dt) || 0);
      lines.push({ offset, ev });
    }
    if (lines.length) files.push({ sessionId, file: name, lines });
  }
  const layout = await readJSON(path.join(abs, 'layout.json'), {});
  const pylons = await readJSON(path.join(abs, 'pylons.json'), null);
  return { name: path.basename(abs), dir: abs, files, layout: layout && typeof layout === 'object' ? layout : {}, pylons: Array.isArray(pylons) ? pylons : null, warnings };
}

async function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

/** Merge files into one timeline sorted by absolute offset (stable by file order). */
export function buildTimeline(scenario) {
  const items = [];
  scenario.files.forEach((f, fi) => f.lines.forEach((l, li) => items.push({ offset: l.offset, fi, li, sessionId: f.sessionId, ev: l.ev })));
  items.sort((a, b) => a.offset - b.offset || a.fi - b.fi || a.li - b.li);
  return items;
}

/** Suffix every message/call id in an event for loop N (> 0) so columns keep growing. */
export function suffixIds(ev, loop) {
  if (!loop) return ev;
  const sfx = `~${loop}`;
  const fix = (id) => (id === undefined || id === null ? id : `${id}${sfx}`);
  const out = { ...ev };
  if (out.message) {
    out.message = { ...out.message, id: fix(out.message.id) };
    if (out.message.parentMessageId) out.message.parentMessageId = fix(out.message.parentMessageId);
    if (out.message.tool) out.message.tool = { ...out.message.tool, callId: fix(out.message.tool.callId) };
    if (out.message.from) out.message.from = { ...out.message.from, messageId: fix(out.message.from.messageId) };
  }
  for (const k of ['messageId', 'callId', 'atMessageId', 'fromMessageId', 'newMessageId', 'resultMessageId']) if (out[k] !== undefined) out[k] = fix(out[k]);
  if (out.kind === 'session.status' && out.attention?.requestId) out.attention = { ...out.attention, requestId: fix(out.attention.requestId) };
  return out;
}

