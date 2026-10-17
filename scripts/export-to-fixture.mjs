#!/usr/bin/env node
// Convert a Hermes export JSON ({...session, messages:[rows]} from GET /api/sessions/{id}/export)
// into a fixture file fixtures/<scenario>/<id>.jsonl using normalize.js, with dt from row timestamps.
//
//   node scripts/export-to-fixture.mjs <export.json> [--scenario demo] [--id my-session] [--title "…"] [--max-dt 8000] [--out file.jsonl]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeExport } from '../server/sources/normalize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = { input: null, scenario: 'demo', id: null, title: null, maxDt: 8000, out: null, minDt: 50 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--scenario') o.scenario = next();
    else if (a === '--id') o.id = next();
    else if (a === '--title') o.title = next();
    else if (a === '--max-dt') o.maxDt = Number(next());
    else if (a === '--min-dt') o.minDt = Number(next());
    else if (a === '--out') o.out = next();
    else if (a === '-h' || a === '--help') { o.help = true; }
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.input = a;
  }
  return o;
}

/** Pure: export JSON → array of fixture lines (objects with dt). Exported for tests/reuse. */
export function exportToFixtureLines(exp, { id, title, maxDt = 8000, minDt = 50 } = {}) {
  const sid = id || String(exp.id || exp.session_id || 'session');
  const { session, messages, events } = normalizeExport(exp, { sessionId: sid });
  if (title) session.title = title;
  // every event is anchored to its message's timestamp; tool.start/complete share their message's time
  const tsOf = (ev) => {
    if (ev.kind === 'message.add') return ev.message.ts;
    const m = messages.find((x) => x.id === ev.messageId || x.id === ev.resultMessageId);
    return m ? m.ts : null;
  };
  const lines = [];
  const first = messages[0]?.ts ?? session.startedAt;
  session.status = 'idle'; session.currentTool = null; session.attention = null; session.activity = 'idle';
  session.counts = { messages: 0, toolCalls: 0, byCategory: {} }; session.toolHistory = [];
  lines.push({ dt: 0, sessionId: sid, kind: 'session.upsert', session });
  let prev = first;
  let lastStatus = 'idle';
  const pushStatus = (status, activity) => { if (status !== lastStatus) { lines.push({ dt: 0, sessionId: sid, kind: 'session.status', status, activity }); lastStatus = status; } };
  for (const ev of events) {
    const ts = tsOf(ev) ?? prev;
    let dt = Math.max(0, ts - prev);
    if (dt > maxDt) dt = maxDt;                 // compress long real-world pauses
    if (dt > 0 && dt < minDt) dt = minDt;
    prev = ts;
    const line = { dt, ...ev };
    if (ev.kind === 'message.add') {
      const role = ev.message.role;
      if (role === 'user') { lines.push(line); pushStatus('thinking', 'thinking'); continue; }
      if (role === 'thinking') { pushStatus('thinking', 'thinking'); lines.push(line); continue; }
      if (role === 'assistant') { pushStatus('responding', 'replying'); lines.push(line); continue; }
      if (role === 'tool_call') { lines.push(line); pushStatus('tool', ev.message.summary); continue; }
      lines.push(line); continue;
    }
    lines.push(line);
  }
  const ended = Boolean(exp.ended_at);
  lines.push({ dt: 200, sessionId: sid, kind: 'session.status', status: ended ? 'done' : 'idle', activity: ended ? 'finished' : 'idle', ...(ended ? { attention: { kind: 'done', text: exp.end_reason || 'finished' } } : {}) });
  return { sessionId: sid, lines };
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (err) { console.error(`error: ${err.message}`); process.exit(2); }
  if (o.help || !o.input) {
    console.log('usage: node scripts/export-to-fixture.mjs <export.json> [--scenario demo] [--id <sessionId>] [--title "…"] [--max-dt 8000] [--out file.jsonl]');
    process.exit(o.help ? 0 : 2);
  }
  let exp;
  try { exp = JSON.parse(fs.readFileSync(path.resolve(o.input), 'utf8')); } catch (err) { console.error(`cannot read ${o.input}: ${err.message}`); process.exit(1); }
  if (!exp || typeof exp !== 'object' || !Array.isArray(exp.messages)) { console.error('input is not a Hermes export ({...session, messages:[...]})'); process.exit(1); }
  const { sessionId, lines } = exportToFixtureLines(exp, { id: o.id, title: o.title, maxDt: o.maxDt, minDt: o.minDt });
  const out = o.out ? path.resolve(o.out) : path.join(ROOT, 'fixtures', o.scenario, `${sessionId.replace(/[^\w.-]+/g, '_')}.jsonl`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const total = lines.reduce((s, l) => s + (l.dt || 0), 0);
  console.log(`wrote ${out} — ${lines.length} lines, ${exp.messages.length} rows, ${(total / 1000).toFixed(1)} s of fixture time`);
  const layoutFile = path.join(path.dirname(out), 'layout.json');
  const shown = path.relative(ROOT, layoutFile).startsWith('..') ? layoutFile : path.relative(ROOT, layoutFile);
  if (!fs.existsSync(layoutFile)) console.log(`note: ${shown} does not exist yet; the replayer uses the default §5 arc until you add it`);
}

const isMain = (() => { try { return fs.realpathSync(path.resolve(process.argv[1] || '')) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main();
