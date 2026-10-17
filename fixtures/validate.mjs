#!/usr/bin/env node
// fixtures/validate.mjs — checks a fixture scenario against docs/PROTOCOL.md §3 (and §2.2/§2.3 shapes).
//   node fixtures/validate.mjs [fixtures/demo] [--quiet]
// Exit code 1 on any error. Also validates fixtures/raw/*.json export-shaped files.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const KINDS = new Set(['session.upsert', 'session.remove', 'session.status', 'message.add', 'message.delta', 'message.complete', 'tool.start', 'tool.complete', 'layout.column', 'fork', 'pipe', 'pylons']);
const STATUS = new Set(['idle', 'thinking', 'responding', 'tool', 'waiting_on_you', 'done', 'error']);
const ROLES = new Set(['user', 'assistant', 'thinking', 'tool_call', 'tool_result', 'system']);
const CATS = new Set(['web', 'files', 'coding', 'memory', 'delegating', 'images', 'messaging', 'waiting', 'tools']);
const TARGETS = new Set(['browser', 'files', 'terminal', 'self']);
const ATT = new Set(['approval', 'clarify', 'done', 'error']);
const META_KEYS = new Set(['path', 'diff', 'url', 'query', 'command', 'exitCode']);
const SECRET = /sk-[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || 'fixtures/demo');
const rawDir = path.resolve(dir, '../raw');
const errors = [], warnings = [];
const err = (f, n, msg) => errors.push(`${f}${n ? ':' + n : ''}: ${msg}`);
const warn = (f, n, msg) => warnings.push(`${f}${n ? ':' + n : ''}: ${msg}`);
const cps = (s) => [...String(s)].length;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isStr = (x) => typeof x === 'string';

async function validateFile(file) {
  const name = path.basename(file), sid = name.replace(/\.jsonl$/, '');
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] !== '') err(name, lines.length, 'file must end with a newline'); else lines.pop();
  const ids = new Map(), streaming = new Set(), calls = new Map(), completes = new Set(), results = new Set();
  const thinkingSeen = new Set(), assistantSeen = new Set();
  const s = { file: name, sid, events: 0, messages: 0, deltas: 0, ms: 0, roles: {}, diffs: 0, longThinking: 0, statuses: new Set(), upsert: null, lastStatus: null, parentId: null };
  lines.forEach((raw, i) => {
    const n = i + 1;
    let ev;
    try { ev = JSON.parse(raw); } catch (e) { return err(name, n, `invalid JSON: ${e.message}`); }
    s.events++;
    if (!isNum(ev.dt) || ev.dt < 0) err(name, n, 'dt must be a number >= 0');
    if (ev.sessionId !== sid) err(name, n, `sessionId ${JSON.stringify(ev.sessionId)} != file stem ${sid}`);
    if (!KINDS.has(ev.kind)) err(name, n, `unknown kind ${JSON.stringify(ev.kind)}`);
    for (const k of ['t', 'seq', 'ts']) if (k in ev) err(name, n, `fixture lines must not carry "${k}"`);
    if (SECRET.test(raw)) err(name, n, 'secret-looking token in fixture text');
    if (n === 1 && (ev.dt !== 0 || ev.kind !== 'session.upsert')) err(name, n, 'first line must be {"dt":0,…,"kind":"session.upsert"}');
    s.ms += ev.dt || 0;
    switch (ev.kind) {
      case 'session.upsert': {
        const S = ev.session;
        if (!S || typeof S !== 'object') { err(name, n, 'session.upsert needs session'); break; }
        if (S.id !== sid) err(name, n, `session.id ${S.id} != ${sid}`);
        for (const k of ['title', 'activity', 'summary']) if (!isStr(S[k])) err(name, n, `session.${k} must be a string`);
        if (!STATUS.has(S.status)) err(name, n, `session.status ${S.status} invalid`);
        if (!isNum(S.startedAt) || !isNum(S.lastActivityAt)) err(name, n, 'startedAt/lastActivityAt must be numbers');
        if (!S.counts || !isNum(S.counts.messages) || !isNum(S.counts.toolCalls) || typeof S.counts.byCategory !== 'object') err(name, n, 'counts shape');
        if (!Array.isArray(S.toolHistory)) err(name, n, 'toolHistory must be an array');
        if (cps(S.summary) > 80) err(name, n, `session.summary > 80 chars (${cps(S.summary)})`);
        if (S.attention && !ATT.has(S.attention.kind)) err(name, n, 'attention.kind invalid');
        if (n === 1) { s.upsert = S; s.parentId = S.parentId ?? null; }
        break;
      }
      case 'session.status': {
        if (!STATUS.has(ev.status)) err(name, n, `status ${ev.status} invalid`);
        if (ev.status === 'waiting_on_you') {
          if (!ev.attention || !ATT.has(ev.attention.kind) || !isStr(ev.attention.text)) err(name, n, 'waiting_on_you requires attention {kind,text}');
        } else if (ev.attention && ev.attention.kind !== 'done' && ev.attention.kind !== 'error') err(name, n, 'attention set on a non-waiting status must be done/error');
        if (ev.attention && !isNum(ev.attention.since)) err(name, n, 'attention.since must be a number');
        s.statuses.add(ev.status); s.lastStatus = ev.status;
        break;
      }
      case 'message.add': {
        const M = ev.message;
        if (!M || typeof M !== 'object') { err(name, n, 'message.add needs message'); break; }
        if (!isStr(M.id)) err(name, n, 'message.id string');
        else if (ids.has(M.id)) err(name, n, `duplicate message id ${M.id} (first at line ${ids.get(M.id)})`); else ids.set(M.id, n);
        if (M.sessionId !== sid) err(name, n, 'message.sessionId mismatch');
        if (!ROLES.has(M.role)) err(name, n, `role ${M.role} invalid`);
        if (!isNum(M.ts)) err(name, n, 'message.ts number');
        if (!isStr(M.text)) err(name, n, 'message.text string');
        if (!isStr(M.summary) || cps(M.summary) > 100) err(name, n, `summary missing or > 100 chars`);
        if (!isStr(M.glyph) || cps(M.glyph) < 1 || cps(M.glyph) > 2) err(name, n, `glyph must be 1–2 chars, got ${JSON.stringify(M.glyph)}`);
        if (M.streaming) streaming.add(M.id);
        s.messages++; s.roles[M.role] = (s.roles[M.role] || 0) + 1;
        if (M.role === 'thinking') {
          thinkingSeen.add(M.id);
          if (!M.id.endsWith(':r')) err(name, n, 'thinking id must end with ":r"');
          if (assistantSeen.has(M.id.slice(0, -2))) err(name, n, 'thinking must precede its assistant message');
        }
        if (M.role === 'assistant') assistantSeen.add(M.id);
        if (M.role === 'tool_call') {
          const T = M.tool;
          if (!T || T.callId !== M.id && !isStr(T.callId)) err(name, n, 'tool_call needs tool.callId');
          else {
            if (!isStr(T.name) || !CATS.has(T.category) || !TARGETS.has(T.target)) err(name, n, 'tool {name,category,target} invalid');
            if (T.args && typeof T.args !== 'object') err(name, n, 'tool.args must be an object');
            calls.set(T.callId, { line: n, msgId: M.id, started: false });
          }
        }
        if (M.role === 'tool_result') {
          if (!M.parentMessageId || !ids.has(M.parentMessageId)) err(name, n, 'tool_result.parentMessageId must reference an earlier tool_call');
          if (!M.tool || typeof M.tool.ok !== 'boolean') err(name, n, 'tool_result.tool.ok boolean');
          else results.add(M.tool.callId);
          if (M.tool?.meta) for (const k of Object.keys(M.tool.meta)) if (!META_KEYS.has(k)) err(name, n, `unknown ToolMeta key ${k}`);
        }
        if (M.role === 'user' && M.via && !['voice', 'keyboard', 'pipe', 'agent', 'replay'].includes(M.via)) err(name, n, `via ${M.via} invalid`);
        break;
      }
      case 'message.delta':
        if (!streaming.has(ev.messageId)) err(name, n, `delta for non-streaming/unknown message ${ev.messageId}`);
        if (!isStr(ev.text) || !ev.text.length) err(name, n, 'delta.text non-empty string');
        else if (ev.text.length > 60 || ev.text.length < 1) warn(name, n, `delta chunk ${ev.text.length} chars (expected 20–60)`);
        s.deltas++;
        break;
      case 'message.complete':
        if (!ids.has(ev.messageId)) err(name, n, `complete for unknown message ${ev.messageId}`);
        if (streaming.has(ev.messageId)) { streaming.delete(ev.messageId); if (isStr(ev.text) && ev.text.length > 1200 && ev.messageId.endsWith(':r')) s.longThinking++; }
        if ('text' in ev && !isStr(ev.text)) err(name, n, 'complete.text must be a string when present');
        break;
      case 'tool.start': {
        const c = calls.get(ev.callId);
        if (!c) err(name, n, `tool.start for unknown callId ${ev.callId}`);
        else { if (c.msgId !== ev.messageId) err(name, n, 'tool.start.messageId must be the tool_call message id'); c.started = true; c.startLine = n; }
        if (!isStr(ev.name) || !CATS.has(ev.category) || !TARGETS.has(ev.target)) err(name, n, 'tool.start {name,category,target}');
        if (typeof ev.args !== 'object' || !isStr(ev.preview)) err(name, n, 'tool.start needs args object + preview string');
        break;
      }
      case 'tool.complete': {
        const c = calls.get(ev.callId);
        if (!c || !c.started) err(name, n, `tool.complete without tool.start for ${ev.callId}`);
        if (completes.has(ev.callId)) err(name, n, `duplicate tool.complete ${ev.callId}`); completes.add(ev.callId);
        if (typeof ev.ok !== 'boolean' || !isNum(ev.durationMs) || !isStr(ev.preview) || !isStr(ev.name)) err(name, n, 'tool.complete {ok,durationMs,preview,name}');
        if (!results.has(ev.callId)) err(name, n, 'tool.complete must follow its tool_result message.add');
        if (ev.meta) {
          for (const k of Object.keys(ev.meta)) if (!META_KEYS.has(k)) err(name, n, `unknown ToolMeta key ${k}`);
          if (ev.meta.diff) { const d = ev.meta.diff; if (!/^--- /m.test(d) || !/^\+\+\+ /m.test(d) || !/^@@ /m.test(d)) err(name, n, 'meta.diff is not a unified diff'); else s.diffs++; }
        }
        break;
      }
      case 'layout.column': if (!ev.placement || !isNum(ev.placement.x) || !isNum(ev.placement.z) || !isNum(ev.placement.rot)) err(name, n, 'placement {x,z,rot}'); break;
      case 'pylons': if (!Array.isArray(ev.pylons)) err(name, n, 'pylons array'); break;
      case 'fork': if (!isStr(ev.fromSessionId) || !isStr(ev.newSessionId)) err(name, n, 'fork {fromSessionId,newSessionId}'); break;
      case 'pipe': if (!isStr(ev.fromSessionId) || !isStr(ev.toSessionId) || !isStr(ev.newMessageId)) err(name, n, 'pipe fields'); break;
      default: break;
    }
  });
  for (const [callId, c] of calls) {
    if (!c.started) err(name, c.line, `tool_call ${callId} never followed by tool.start`);
    if (!completes.has(callId)) err(name, c.line, `tool_call ${callId} never completed (tool_result + tool.complete)`);
  }
  for (const id of streaming) err(name, 0, `streaming message ${id} never completed`);
  if (!s.upsert) err(name, 1, 'missing session.upsert');
  return s;
}

async function validateScenario() {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  if (!names.length) err(dir, 0, 'no *.jsonl files');
  const stats = [];
  for (const f of names) stats.push(await validateFile(path.join(dir, f)));
  let layout = {}, pylons = [];
  try { layout = JSON.parse(await readFile(path.join(dir, 'layout.json'), 'utf8')); } catch (e) { err('layout.json', 0, e.message); }
  try { pylons = JSON.parse(await readFile(path.join(dir, 'pylons.json'), 'utf8')); } catch (e) { err('pylons.json', 0, e.message); }
  for (const s of stats) {
    const p = layout[s.sid];
    if (!p) err('layout.json', 0, `no placement for ${s.sid}`);
    else if (!isNum(p.x) || !isNum(p.z) || !isNum(p.rot)) err('layout.json', 0, `${s.sid}: placement needs numeric x, z, rot`);
    if (s.parentId && !stats.some((o) => o.sid === s.parentId)) err(s.file, 1, `parentId ${s.parentId} is not a session in this scenario`);
  }
  for (const k of Object.keys(layout)) if (!stats.some((s) => s.sid === k)) warn('layout.json', 0, `placement for unknown session ${k}`);
  if (!Array.isArray(pylons)) err('pylons.json', 0, 'must be an array');
  else for (const p of pylons) if (!TARGETS.has(p.kind) || p.kind === 'self' || !isNum(p.x) || !isNum(p.z) || !isStr(p.label)) err('pylons.json', 0, `bad pylon ${JSON.stringify(p)}`);
  // columns must not overlap each other or a pylon (base 0.40 m; keep ≥ 0.6 m apart)
  const pts = [...Object.entries(layout).map(([k, v]) => [k, v]), ...pylons.map((p) => [`pylon:${p.kind}`, p])];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const d = Math.hypot(pts[i][1].x - pts[j][1].x, pts[i][1].z - pts[j][1].z);
    if (d < 0.6) warn('layout.json', 0, `${pts[i][0]} and ${pts[j][0]} are only ${d.toFixed(2)} m apart`);
  }
  // scenario-level expectations for the default demo (PROTOCOL §3)
  if (path.basename(dir) === 'demo') {
    if (stats.length < 6) err('demo', 0, `needs ≥ 6 sessions, has ${stats.length}`);
    if (!stats.some((s) => s.messages > 80)) err('demo', 0, 'one session must exceed 80 messages (spire path)');
    if (!stats.some((s) => s.lastStatus === 'waiting_on_you')) err('demo', 0, 'one session must end parked at waiting_on_you');
    if (!stats.some((s) => s.lastStatus === 'done')) err('demo', 0, 'one session must end with status done');
    if (!stats.some((s) => s.diffs >= 3)) err('demo', 0, 'one session needs ≥ 3 tool.complete with meta.diff');
    if (!stats.some((s) => s.longThinking >= 3)) err('demo', 0, 'one session needs ≥ 3 streamed thinking messages > 1200 chars');
    if (!stats.some((s) => s.parentId)) err('demo', 0, 'one session must have a parentId (delegate child)');
    const longest = Math.max(...stats.map((s) => s.ms));
    if (longest < 180_000 || longest > 300_000) warn('demo', 0, `longest file plays ${(longest / 1000).toFixed(0)} s at speed 1 (target ≈ 240 s)`);
  }
  return stats;
}

async function validateRaw() {
  let files = [];
  try { files = (await readdir(rawDir)).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(await readFile(path.join(rawDir, f), 'utf8')); } catch (e) { err(f, 0, e.message); continue; }
    for (const k of ['id', 'title', 'model', 'source', 'started_at']) if (!(k in doc)) err(f, 0, `export missing ${k}`);
    if (!Array.isArray(doc.messages)) { err(f, 0, 'messages must be an array'); continue; }
    const callIds = new Set();
    doc.messages.forEach((m, i) => {
      for (const k of ['id', 'session_id', 'role', 'content', 'tool_calls', 'tool_call_id', 'tool_name', 'timestamp', 'reasoning', 'reasoning_content', 'finish_reason']) if (!(k in m)) err(f, i + 1, `row missing ${k}`);
      if (m.session_id !== doc.id) err(f, i + 1, 'row.session_id != export.id');
      if (!['user', 'assistant', 'tool', 'system'].includes(m.role)) err(f, i + 1, `role ${m.role}`);
      if (m.tool_calls != null) {
        if (typeof m.tool_calls !== 'string') err(f, i + 1, 'tool_calls must be a JSON STRING');
        else try { for (const c of JSON.parse(m.tool_calls)) { if (!c.id || c.function?.name == null) err(f, i + 1, 'tool_calls entry shape'); callIds.add(c.id); JSON.parse(c.function.arguments); } } catch (e) { err(f, i + 1, `tool_calls: ${e.message}`); }
      }
      if (m.role === 'tool' && !callIds.has(m.tool_call_id)) err(f, i + 1, `tool row ${m.tool_call_id} has no preceding tool_calls entry`);
      if (m.role !== 'assistant' && (m.reasoning || m.reasoning_content)) err(f, i + 1, 'reasoning only on assistant rows');
    });
    if (!doc.messages.some((m) => m.role === 'assistant' && m.reasoning)) err(f, 0, 'needs a reasoning-bearing assistant row');
    if (!doc.messages.some((m) => m.tool_calls && JSON.parse(m.tool_calls).length >= 2)) err(f, 0, 'needs a row with ≥ 2 tool_calls');
    if (!quiet) console.log(`raw/${f}: ${doc.messages.length} rows, ${callIds.size} tool calls — ok`);
  }
}

const stats = await validateScenario();
await validateRaw();
if (!quiet) {
  console.table(stats.map((s) => ({ file: s.file, events: s.events, messages: s.messages, deltas: s.deltas, 'diffs': s.diffs, 'long✎': s.longThinking, seconds: +(s.ms / 1000).toFixed(1), last: s.lastStatus, roles: Object.entries(s.roles).map(([k, v]) => `${k}:${v}`).join(' ') })));
  console.log(`scenario plays ${(Math.max(...stats.map((s) => s.ms)) / 1000).toFixed(1)} s at speed 1 · ${stats.reduce((a, s) => a + s.events, 0)} events · ${stats.reduce((a, s) => a + s.messages, 0)} messages`);
}
for (const w of warnings) console.warn('WARN', w);
for (const e of errors) console.error('ERROR', e);
console.log(errors.length ? `${errors.length} error(s)` : 'fixtures valid');
process.exit(errors.length ? 1 : 0);
