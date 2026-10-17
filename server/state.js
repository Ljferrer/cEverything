// Canonical state + reducers (PROTOCOL.md §1 state.js). No I/O. applyEvent mutates the given state in place
// and returns it (so both `applyEvent(state, ev)` and `state = applyEvent(state, ev)` work).

import { CATEGORIES, CATEGORY_OF_TOOL } from './protocol.js';
import { activityForTool, describeToolCall, clip, firstSentence, SESSION_SUMMARY_MAX } from './sources/normalize.js';

export const MAX_MESSAGES_PER_SESSION = 400;
export const TOOL_HISTORY_LEN = 8;

export function createState() {
  return {
    sessions: {},      // id → Session
    order: [],         // session ids in first-seen order (drives default placement)
    messages: {},      // sessionId → Message[] (oldest first, ≤ 400)
    layout: {},        // sessionId → Placement
    pylons: defaultPylons(),
    lineage: [],       // { fromSessionId, newSessionId, atMessageId }
    stats: { events: 0, lastEventTs: 0 },
  };
}

export function defaultPylons() {
  return [
    { kind: 'browser', x: -2.5, z: -1.0, label: 'web' },
    { kind: 'terminal', x: 2.5, z: -1.0, label: 'terminal' },
    { kind: 'files', x: 0, z: -3.2, label: 'files' },
  ];
}

/** Default floor placement for the i-th session (0-based), PROTOCOL.md §5. */
export function defaultPlacement(sessionId, index) {
  let r; let deg;
  if (index < 5) { r = 1.8; deg = -60 + 30 * index; }
  else { r = 2.6; deg = -90 + 11.25 + 22.5 * ((index - 5) % 8); if (index >= 13) r += 0.8 * Math.floor((index - 5) / 8); }
  const a = (deg * Math.PI) / 180; // measured from −z toward +x
  const x = r * Math.sin(a);
  const z = -r * Math.cos(a);
  // yaw that turns the column's front (local +z) toward the origin — same formula as web/store.js faceOriginYaw
  return { sessionId, x: round3(x), z: round3(z), rot: round3(Math.atan2(-x, -z)) };
}

const round3 = (v) => Math.round(v * 1000) / 1000;

export function emptyCounts() {
  const byCategory = {};
  for (const c of CATEGORIES) byCategory[c] = 0;
  return { messages: 0, toolCalls: 0, byCategory };
}

function ensureSession(state, sessionId, ts) {
  let s = state.sessions[sessionId];
  if (!s) {
    s = {
      id: sessionId, title: sessionId, status: 'idle', parentId: null, endReason: null,
      startedAt: ts || Date.now(), lastActivityAt: ts || Date.now(), activity: '',
      counts: emptyCounts(), toolHistory: [], currentTool: null, summary: '', attention: null,
    };
    state.sessions[sessionId] = s;
    state.order.push(sessionId);
    if (!state.messages[sessionId]) state.messages[sessionId] = [];
    if (!state.layout[sessionId]) state.layout[sessionId] = defaultPlacement(sessionId, state.order.length - 1);
  }
  return s;
}

function normalizeCounts(c) {
  const out = emptyCounts();
  if (c && typeof c === 'object') {
    out.messages = Number(c.messages) || 0;
    out.toolCalls = Number(c.toolCalls) || 0;
    if (c.byCategory && typeof c.byCategory === 'object') for (const k of CATEGORIES) out.byCategory[k] = Number(c.byCategory[k]) || 0;
  }
  return out;
}

function findMessage(state, sessionId, messageId) {
  const list = state.messages[sessionId];
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].id === messageId) return list[i];
  return null;
}

// ---------------------------------------------------------------------------

const reducers = {
  'session.upsert'(state, ev) {
    const incoming = ev.session || {};
    const id = String(incoming.id || ev.sessionId);
    const existing = state.sessions[id];
    const s = ensureSession(state, id, ev.ts);
    const hadMessages = (state.messages[id] || []).length > 0;
    // metadata wins from the event; derived fields are kept when we already track messages
    for (const k of ['title', 'status', 'model', 'cwd', 'gitBranch', 'parentId', 'endReason', 'startedAt', 'lastActivityAt', 'activity', 'summary', 'attention', 'source']) {
      if (incoming[k] !== undefined) s[k] = incoming[k];
    }
    // optional field: a live source that knows the real row counts (Hermes) owns counts/toolHistory; message.add then
    // stops incrementing them for this session (otherwise seeded counts + per-tile increments double count)
    const authoritative = incoming.countsAuthoritative === true;
    if (authoritative) s.countsAuthoritative = true;
    if (!existing || !hadMessages || authoritative) {
      if (incoming.counts) s.counts = normalizeCounts(incoming.counts);
      if (Array.isArray(incoming.toolHistory)) s.toolHistory = incoming.toolHistory.slice(-TOOL_HISTORY_LEN);
    }
    if ((!existing || !hadMessages) && incoming.currentTool !== undefined) s.currentTool = incoming.currentTool;
    if (s.attention === undefined) s.attention = null;
    if (s.parentId === undefined) s.parentId = null;
    if (!s.title) s.title = id;
    if (ev.ts) s.lastActivityAt = Math.max(s.lastActivityAt || 0, ev.ts);
  },
  'session.remove'(state, ev) {
    const id = ev.sessionId;
    delete state.sessions[id];
    delete state.messages[id];
    delete state.layout[id];
    state.order = state.order.filter((x) => x !== id);
    state.lineage = state.lineage.filter((l) => l.fromSessionId !== id && l.newSessionId !== id);
  },
  'session.status'(state, ev) {
    const s = ensureSession(state, ev.sessionId, ev.ts);
    s.status = ev.status;
    if (typeof ev.activity === 'string') s.activity = ev.activity;
    if (ev.status === 'waiting_on_you') s.attention = ev.attention || s.attention || { kind: 'approval', text: 'waiting for you', since: ev.ts };
    else if (ev.attention !== undefined) s.attention = ev.attention;
    else if (ev.status !== 'done' && ev.status !== 'error') s.attention = null;
    if (ev.status !== 'tool') s.currentTool = null;
    if (ev.status === 'thinking' && !ev.activity) s.activity = 'thinking';
    if (ev.ts) s.lastActivityAt = ev.ts;
  },
  'message.add'(state, ev) {
    const m = ev.message;
    if (!m || !m.id) return;
    const sid = ev.sessionId || m.sessionId;
    const s = ensureSession(state, sid, ev.ts);
    const list = state.messages[sid];
    const existing = findMessage(state, sid, m.id);
    // idempotent upsert (streaming restarts, replays); a re-added tile is visible again unless the event hides it
    if (existing) { Object.assign(existing, m, { hidden: m.hidden ?? false }); return; }
    const msg = { ...m, sessionId: sid, ts: m.ts || ev.ts || Date.now() };
    if (!msg.summary) msg.summary = firstSentence(msg.text || '');
    list.push(msg);
    while (list.length > MAX_MESSAGES_PER_SESSION) list.shift();
    if (!s.countsAuthoritative) s.counts.messages += 1;
    s.lastActivityAt = Math.max(s.lastActivityAt || 0, msg.ts);
    if (msg.role === 'user' && !s.summary) s.summary = clip(msg.text, SESSION_SUMMARY_MAX);
    if (msg.role === 'tool_call') {
      const cat = msg.tool?.category || CATEGORY_OF_TOOL(msg.tool?.name);
      if (!s.countsAuthoritative) { s.counts.toolCalls += 1; s.counts.byCategory[cat] = (s.counts.byCategory[cat] || 0) + 1; }
      s.toolHistory.push(cat);
      while (s.toolHistory.length > TOOL_HISTORY_LEN) s.toolHistory.shift();
    }
  },
  'message.delta'(state, ev) {
    const msg = findMessage(state, ev.sessionId, ev.messageId);
    if (!msg) return;
    msg.text = (msg.text || '') + (ev.text || '');
    msg.streaming = true;
    msg.summary = firstSentence(msg.text);
    const s = state.sessions[ev.sessionId];
    if (s && ev.ts) s.lastActivityAt = ev.ts;
  },
  'message.complete'(state, ev) {
    const msg = findMessage(state, ev.sessionId, ev.messageId);
    if (!msg) return;
    if (typeof ev.text === 'string') msg.text = ev.text;
    msg.streaming = false;
    msg.summary = firstSentence(msg.text);
    if (ev.hidden) msg.hidden = true;
  },
  'tool.start'(state, ev) {
    const s = ensureSession(state, ev.sessionId, ev.ts);
    const category = ev.category || CATEGORY_OF_TOOL(ev.name);
    s.currentTool = { callId: ev.callId, name: ev.name, category, since: ev.ts || Date.now() };
    const msg = findMessage(state, ev.sessionId, ev.messageId);
    const meta = { ...describeToolCall(ev.name, ev.args || {}).meta, ...(msg?.tool?.meta || {}) };
    s.activity = activityForTool(ev.name, meta, ev.args || {});
    if (ev.ts) s.lastActivityAt = ev.ts;
  },
  'tool.complete'(state, ev) {
    const s = ensureSession(state, ev.sessionId, ev.ts);
    if (s.currentTool && s.currentTool.callId === ev.callId) s.currentTool = null;
    const msg = findMessage(state, ev.sessionId, ev.messageId);
    if (msg && msg.tool) {
      if (typeof ev.ok === 'boolean') msg.tool.ok = ev.ok;
      if (typeof ev.durationMs === 'number') msg.tool.durationMs = ev.durationMs;
      if (ev.meta) msg.tool.meta = { ...(msg.tool.meta || {}), ...ev.meta };
    }
    const name = ev.name || msg?.tool?.name || 'tool';
    const meta = ev.meta || msg?.tool?.meta || {};
    s.activity = completedActivity(name, meta, ev.ok);
    if (ev.ts) s.lastActivityAt = ev.ts;
  },
  'layout.column'(state, ev) {
    const p = ev.placement;
    if (!p) return;
    const sid = p.sessionId || ev.sessionId;
    ensureSession(state, sid, ev.ts);
    state.layout[sid] = { sessionId: sid, x: Number(p.x) || 0, z: Number(p.z) || 0, rot: Number(p.rot) || 0 };
  },
  fork(state, ev) {
    if (!ev.fromSessionId || !ev.newSessionId) return;
    state.lineage.push({ fromSessionId: ev.fromSessionId, newSessionId: ev.newSessionId, atMessageId: ev.atMessageId });
    const child = state.sessions[ev.newSessionId];
    if (child && !child.parentId) child.parentId = ev.fromSessionId;
  },
  pipe() { /* the piped user message arrives as its own message.add */ },
  pylons(state, ev) {
    if (Array.isArray(ev.pylons)) state.pylons = ev.pylons.map((p) => ({ kind: p.kind, x: Number(p.x) || 0, z: Number(p.z) || 0, label: p.label || p.kind }));
  },
};

function completedActivity(name, meta, ok) {
  const cat = CATEGORY_OF_TOOL(name);
  const bad = ok === false ? ' ✗' : '';
  if (cat === 'files' && (name === 'patch' || name === 'write_file' || name === 'edit_file')) return `edited ${clip(meta.path || '', 60)}${bad}`;
  if (cat === 'files') return `read ${clip(meta.path || meta.query || '', 60)}${bad}`;
  if (cat === 'coding') return `ran ${clip(meta.command || name, 50)}${meta.exitCode !== undefined ? ` → exit ${meta.exitCode}` : bad}`;
  if (cat === 'web') return meta.url ? `read ${clip(hostLike(meta.url), 60)}` : `searched "${clip(meta.query || '', 50)}"`;
  if (cat === 'delegating') return 'subtask returned';
  return `${name} done${bad}`;
}

function hostLike(url) { try { return new URL(url).host; } catch { return String(url); } }

/** Apply one event. Unknown kinds are ignored (forward compatibility). Returns state. */
export function applyEvent(state, event) {
  if (!state || !event || typeof event !== 'object') return state;
  const fn = reducers[event.kind];
  if (fn) fn(state, event);
  state.stats.events += 1;
  if (event.ts) state.stats.lastEventTs = event.ts;
  return state;
}

export function applyEvents(state, events) {
  for (const ev of events) applyEvent(state, ev);
  return state;
}

/** Snapshot payload (without t/seq/presence — the hub adds those). Deep-copied so callers can't mutate state. */
export function snapshot(state) {
  const sessions = state.order.map((id) => state.sessions[id]).filter(Boolean);
  const messages = {};
  for (const id of state.order) messages[id] = state.messages[id] || [];
  const layout = {};
  for (const id of state.order) layout[id] = state.layout[id] || defaultPlacement(id, state.order.indexOf(id));
  return structuredClone({ sessions, messages, layout, pylons: state.pylons, lineage: state.lineage });
}

export function getSession(state, id) { return state.sessions[id] || null; }
export function getMessages(state, id) { return state.messages[id] || []; }
export function getPlacement(state, id) { return state.layout[id] || null; }
export function sessionCount(state) { return state.order.length; }

export default { createState, applyEvent, applyEvents, snapshot, defaultPlacement, defaultPylons, emptyCounts, MAX_MESSAGES_PER_SESSION };
