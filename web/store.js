// Client mirror of the canonical state (PROTOCOL.md §2): pure data + indexes + a tiny event bus.
// Nothing here touches three.js or the DOM. net.js feeds frames in; scene/ui modules subscribe.

import { CATEGORIES, CATEGORY_OF_TOOL, TARGET_OF_CATEGORY, GLYPH_OF } from '/shared/protocol.js';

export const MAX_MESSAGES_PER_SESSION = 400;
export const TOOL_HISTORY_LEN = 8;
export const SUMMARY_MAX = 100;

/** Default floor placement for the i-th session (0-based) when layout is missing (PROTOCOL §5). */
export function defaultPlacement(sessionId, index) {
  let r; let deg;
  if (index < 5) { r = 1.8; deg = -60 + 30 * index; }
  else { r = 2.6; deg = -90 + 11.25 + 22.5 * ((index - 5) % 8); if (index >= 13) r += 0.8 * Math.floor((index - 5) / 8); }
  const a = (deg * Math.PI) / 180;      // measured from −z toward +x
  const x = r * Math.sin(a);
  const z = -r * Math.cos(a);
  return { sessionId, x: round3(x), z: round3(z), rot: round3(faceOriginYaw(x, z)) };
}

/** Yaw (three.js rotation.y) that makes an object whose front is local +z face the origin from (x, z). */
export function faceOriginYaw(x, z) { return Math.atan2(-x, -z); }

const round3 = (v) => Math.round(v * 1000) / 1000;

export function firstSentence(text, max = SUMMARY_MAX) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^.*?[.!?](\s|$)/);
  const s = m ? m[0].trim() : t;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

export function emptyCounts() {
  const byCategory = {};
  for (const c of CATEGORIES) byCategory[c] = 0;
  return { messages: 0, toolCalls: 0, byCategory };
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

export function createStore() {
  const listeners = new Map();
  const store = {
    // canonical mirror
    sessions: new Map(),      // id → Session
    order: [],                // session ids, first-seen order (drives default placement)
    messages: new Map(),      // sessionId → Message[] (oldest first, ≤ 400)
    tiles: new Map(),         // messageId → Message (any session)
    layout: new Map(),        // sessionId → Placement
    pylons: [],
    lineage: [],              // { fromSessionId, newSessionId, atMessageId }
    presence: new Map(),      // clientId → Presence (remote participants only)
    // connection-level
    seq: 0, clientId: null, serverTime: 0, source: 'fixture', sourceInfo: { label: '…' }, voice: { engine: 'none' },
    connected: false, stats: { events: 0, snapshots: 0, lastEventAt: 0 },

    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    emit(type, payload) {
      const set = listeners.get(type);
      if (set) for (const fn of [...set]) { try { fn(payload); } catch (err) { console.error(`[store] listener for ${type} failed`, err); } }
    },

    // ---------------------------------------------------------------- frames
    applyHello(frame) {
      store.clientId = frame.clientId;
      store.serverTime = frame.serverTime;
      store.epoch = typeof frame.epoch === 'string' ? frame.epoch : null; // server instance (optional field)
      store.source = frame.source || 'fixture';
      store.sourceInfo = frame.sourceInfo || { label: frame.source === 'hermes' ? 'LIVE' : 'FIXTURE REPLAY' };
      store.voice = frame.voice || { engine: 'none' };
      store.emit('hello', frame);
      store.emit('source', store.sourceInfo);
    },

    applySnapshot(snap) {
      store.sessions.clear(); store.order.length = 0; store.messages.clear(); store.tiles.clear(); store.layout.clear();
      store.lineage = Array.isArray(snap.lineage) ? snap.lineage.slice() : [];
      for (const s of snap.sessions || []) {
        const sess = cleanSession(s, s.id);
        store.sessions.set(sess.id, sess);
        store.order.push(sess.id);
        store.messages.set(sess.id, []);
      }
      for (const [sid, list] of Object.entries(snap.messages || {})) {
        if (!store.sessions.has(sid)) continue;
        const arr = store.messages.get(sid);
        for (const m of list) { const msg = cleanMessage(m, sid); arr.push(msg); store.tiles.set(msg.id, msg); }
      }
      for (const [sid, p] of Object.entries(snap.layout || {})) {
        if (store.sessions.has(sid)) store.layout.set(sid, { sessionId: sid, x: Number(p.x) || 0, z: Number(p.z) || 0, rot: Number(p.rot) || 0 });
      }
      for (const sid of store.order) if (!store.layout.has(sid)) store.layout.set(sid, defaultPlacement(sid, store.order.indexOf(sid)));
      if (Array.isArray(snap.pylons)) store.pylons = snap.pylons.map(cleanPylon);
      store.presence.clear();
      for (const p of snap.presence || []) if (p && p.clientId && p.clientId !== store.clientId) store.presence.set(p.clientId, p);
      if (Number.isFinite(snap.seq)) store.seq = snap.seq;
      store.stats.snapshots += 1;
      store.emit('snapshot', snap);
    },

    /** Apply one server event frame. Returns false when it was a duplicate (seq ≤ known). */
    applyEvent(ev) {
      if (!ev || typeof ev !== 'object') return false;
      if (Number.isFinite(ev.seq)) {
        if (ev.seq <= store.seq) return false;
        store.seq = ev.seq;
      }
      const fn = reducers[ev.kind];
      if (fn) fn(store, ev);
      store.stats.events += 1;
      store.stats.lastEventAt = ev.ts || Date.now();
      store.emit(ev.kind, ev);
      store.emit('event', ev);
      return true;
    },

    applyPresence(p) {
      if (!p || !p.clientId || p.clientId === store.clientId) return;
      const prev = store.presence.get(p.clientId) || {};
      const merged = { ...prev, ...p, lastSeen: Date.now() };
      store.presence.set(p.clientId, merged);
      store.emit('presence', merged);
    },
    removePresence(clientId) {
      const p = store.presence.get(clientId);
      store.presence.delete(clientId);
      store.emit('presence.left', { clientId, presence: p || null });
    },
    setSourceInfo(info) { store.sourceInfo = info || store.sourceInfo; store.emit('source', store.sourceInfo); },
    setConnected(v) { store.connected = Boolean(v); store.emit('connection', store.connected); },

    // ---------------------------------------------------------------- queries
    session(id) { return store.sessions.get(id) || null; },
    messagesOf(id) { return store.messages.get(id) || []; },
    placement(id) {
      const p = store.layout.get(id);
      if (p) return p;
      const idx = Math.max(0, store.order.indexOf(id));
      return defaultPlacement(id, idx);
    },
    message(messageId) { return store.tiles.get(messageId) || null; },
    waiting() { return [...store.sessions.values()].filter((s) => s.status === 'waiting_on_you'); },
    tileCount() { let n = 0; for (const list of store.messages.values()) n += list.length; return n; },
    headsets() { return [...store.presence.values()].filter((p) => p.device === 'quest' || p.device === 'visionpro'); },
  };
  return store;
}

// ---------------------------------------------------------------------------
// reducers (mirror of server/state.js)

function cleanSession(s, idFallback) {
  const id = String(s.id || idFallback);
  const out = {
    id, title: s.title || id, status: s.status || 'idle', model: s.model, cwd: s.cwd, gitBranch: s.gitBranch,
    parentId: s.parentId ?? null, endReason: s.endReason ?? null,
    startedAt: Number(s.startedAt) || Date.now(), lastActivityAt: Number(s.lastActivityAt) || Date.now(),
    activity: typeof s.activity === 'string' ? s.activity : '', counts: normalizeCounts(s.counts),
    toolHistory: Array.isArray(s.toolHistory) ? s.toolHistory.slice(-TOOL_HISTORY_LEN) : [],
    currentTool: s.currentTool || null, summary: typeof s.summary === 'string' ? s.summary : '', attention: s.attention || null,
    source: s.source, countsAuthoritative: s.countsAuthoritative === true, rev: 0,
  };
  return out;
}

function cleanMessage(m, sid) {
  const msg = { ...m, sessionId: sid || m.sessionId, text: typeof m.text === 'string' ? m.text : '', rev: 0 };
  if (!msg.summary) msg.summary = summarize(msg);
  if (!msg.glyph) msg.glyph = GLYPH_OF(msg.role, msg.tool?.category);
  if (msg.role === 'tool_call' && msg.tool) {
    if (!msg.tool.category) msg.tool.category = CATEGORY_OF_TOOL(msg.tool.name);
    if (!msg.tool.target) msg.tool.target = TARGET_OF_CATEGORY(msg.tool.category);
  }
  if (!Number.isFinite(msg.ts)) msg.ts = Date.now();
  return msg;
}

function cleanPylon(p) { return { kind: p.kind, x: Number(p.x) || 0, z: Number(p.z) || 0, label: p.label || p.kind }; }

function summarize(msg) {
  if (msg.role === 'tool_call' && msg.tool) {
    const a = msg.tool.args || {};
    const name = msg.tool.name || 'tool';
    if (name === 'terminal' && a.command) return clip(`$ ${a.command}`);
    if (a.query) return clip(`${name} "${a.query}"`);
    if (a.path) return clip(`${name} ${a.path}`);
    if (a.url) return clip(`${name} ${a.url}`);
    return clip(`${name}${msg.tool.preview ? ' ' + msg.tool.preview : ''}`);
  }
  return firstSentence(msg.text);
}

export function clip(s, max = SUMMARY_MAX) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

function ensureSession(store, sessionId, ts) {
  let s = store.sessions.get(sessionId);
  if (!s) {
    s = cleanSession({ id: sessionId, startedAt: ts, lastActivityAt: ts }, sessionId);
    store.sessions.set(sessionId, s);
    store.order.push(sessionId);
    store.messages.set(sessionId, []);
    if (!store.layout.has(sessionId)) store.layout.set(sessionId, defaultPlacement(sessionId, store.order.length - 1));
    store.emit('session.created', s);
  }
  return s;
}

function findMessage(store, sessionId, messageId) {
  const m = store.tiles.get(messageId);
  if (m && (!sessionId || m.sessionId === sessionId)) return m;
  return null;
}

const reducers = {
  'session.upsert'(store, ev) {
    const incoming = ev.session || {};
    const id = String(incoming.id || ev.sessionId);
    const existing = store.sessions.get(id);
    const s = ensureSession(store, id, ev.ts);
    const hadMessages = (store.messages.get(id) || []).length > 0;
    for (const k of ['title', 'status', 'model', 'cwd', 'gitBranch', 'parentId', 'endReason', 'startedAt', 'lastActivityAt', 'activity', 'summary', 'attention', 'source']) {
      if (incoming[k] !== undefined) s[k] = incoming[k];
    }
    // optional field (mirrors server/state.js): a live source that knows the real counts owns counts/toolHistory,
    // and message.add stops incrementing them for that session
    const authoritative = incoming.countsAuthoritative === true;
    if (authoritative) s.countsAuthoritative = true;
    if (!existing || !hadMessages || authoritative) {
      if (incoming.counts) s.counts = normalizeCounts(incoming.counts);
      if (Array.isArray(incoming.toolHistory)) s.toolHistory = incoming.toolHistory.slice(-TOOL_HISTORY_LEN);
    }
    if ((!existing || !hadMessages) && incoming.currentTool !== undefined) s.currentTool = incoming.currentTool;
    if (s.attention === undefined) s.attention = null;
    if (!s.title) s.title = id;
    if (ev.ts) s.lastActivityAt = Math.max(s.lastActivityAt || 0, ev.ts);
    s.rev++;
  },
  'session.remove'(store, ev) {
    const id = ev.sessionId;
    for (const m of store.messages.get(id) || []) store.tiles.delete(m.id);
    store.sessions.delete(id); store.messages.delete(id); store.layout.delete(id);
    store.order = store.order.filter((x) => x !== id);
    store.lineage = store.lineage.filter((l) => l.fromSessionId !== id && l.newSessionId !== id);
  },
  'session.status'(store, ev) {
    const s = ensureSession(store, ev.sessionId, ev.ts);
    s.status = ev.status;
    if (typeof ev.activity === 'string') s.activity = ev.activity;
    if (ev.status === 'waiting_on_you') s.attention = ev.attention || s.attention || { kind: 'approval', text: 'waiting for you', since: ev.ts };
    else if (ev.attention !== undefined) s.attention = ev.attention;
    else if (ev.status !== 'done' && ev.status !== 'error') s.attention = null;
    if (ev.status !== 'tool') s.currentTool = null;
    if (ev.status === 'thinking' && !ev.activity) s.activity = 'thinking';
    if (ev.ts) s.lastActivityAt = ev.ts;
    s.rev++;
  },
  'message.add'(store, ev) {
    const m = ev.message;
    if (!m || !m.id) return;
    const sid = ev.sessionId || m.sessionId;
    const s = ensureSession(store, sid, ev.ts);
    const list = store.messages.get(sid);
    const existing = findMessage(store, sid, m.id);
    if (existing) {
      // idempotent upsert: a re-added tile is visible again unless the event hides it (ev.unhidden tells the scene to re-stack it)
      const wasHidden = existing.hidden === true;
      Object.assign(existing, m, { hidden: m.hidden ?? false, rev: existing.rev + 1 });
      ev.duplicate = true; if (wasHidden && !existing.hidden) ev.unhidden = true;
      return;
    }
    const msg = cleanMessage({ ...m, ts: m.ts || ev.ts || Date.now() }, sid);
    list.push(msg);
    store.tiles.set(msg.id, msg);
    while (list.length > MAX_MESSAGES_PER_SESSION) { const old = list.shift(); store.tiles.delete(old.id); }
    if (!s.countsAuthoritative) s.counts.messages += 1;
    s.lastActivityAt = Math.max(s.lastActivityAt || 0, msg.ts);
    if (msg.role === 'user' && !s.summary) s.summary = clip(msg.text, 80);
    if (msg.role === 'tool_call') {
      const cat = msg.tool?.category || CATEGORY_OF_TOOL(msg.tool?.name);
      if (!s.countsAuthoritative) { s.counts.toolCalls += 1; s.counts.byCategory[cat] = (s.counts.byCategory[cat] || 0) + 1; }
      s.toolHistory.push(cat);
      while (s.toolHistory.length > TOOL_HISTORY_LEN) s.toolHistory.shift();
    }
    s.rev++;
  },
  'message.delta'(store, ev) {
    const msg = findMessage(store, ev.sessionId, ev.messageId);
    if (!msg) return;
    msg.text = (msg.text || '') + (ev.text || '');
    msg.streaming = true;
    msg.summary = firstSentence(msg.text);
    msg.rev++;
    const s = store.sessions.get(ev.sessionId);
    if (s && ev.ts) s.lastActivityAt = ev.ts;
  },
  'message.complete'(store, ev) {
    const msg = findMessage(store, ev.sessionId, ev.messageId);
    if (!msg) return;
    if (typeof ev.text === 'string') msg.text = ev.text;
    msg.streaming = false;
    msg.summary = firstSentence(msg.text);
    if (ev.hidden) msg.hidden = true;
    msg.rev++;
  },
  'tool.start'(store, ev) {
    const s = ensureSession(store, ev.sessionId, ev.ts);
    const category = ev.category || CATEGORY_OF_TOOL(ev.name);
    s.currentTool = { callId: ev.callId, name: ev.name, category, since: ev.ts || Date.now() };
    const msg = findMessage(store, ev.sessionId, ev.messageId);
    if (msg) { msg.tool = { ...(msg.tool || {}), callId: ev.callId, name: ev.name, category, target: ev.target || TARGET_OF_CATEGORY(category), args: ev.args ?? msg.tool?.args, preview: ev.preview ?? msg.tool?.preview }; msg.rev++; }
    s.activity = activityFor(ev.name, ev.args || {}, msg);
    if (ev.ts) s.lastActivityAt = ev.ts;
    s.rev++;
  },
  'tool.complete'(store, ev) {
    const s = ensureSession(store, ev.sessionId, ev.ts);
    if (s.currentTool && s.currentTool.callId === ev.callId) s.currentTool = null;
    const msg = findMessage(store, ev.sessionId, ev.messageId);
    if (msg) {
      msg.tool = msg.tool || { callId: ev.callId, name: ev.name, category: CATEGORY_OF_TOOL(ev.name) };
      if (typeof ev.ok === 'boolean') msg.tool.ok = ev.ok;
      if (typeof ev.durationMs === 'number') msg.tool.durationMs = ev.durationMs;
      if (ev.meta) msg.tool.meta = { ...(msg.tool.meta || {}), ...ev.meta };
      msg.rev++;
    }
    if (ev.ts) s.lastActivityAt = ev.ts;
    s.rev++;
  },
  'layout.column'(store, ev) {
    const p = ev.placement;
    if (!p) return;
    const sid = p.sessionId || ev.sessionId;
    ensureSession(store, sid, ev.ts);
    store.layout.set(sid, { sessionId: sid, x: Number(p.x) || 0, z: Number(p.z) || 0, rot: Number(p.rot) || 0 });
  },
  fork(store, ev) {
    if (!ev.fromSessionId || !ev.newSessionId) return;
    store.lineage.push({ fromSessionId: ev.fromSessionId, newSessionId: ev.newSessionId, atMessageId: ev.atMessageId });
    const child = store.sessions.get(ev.newSessionId);
    if (child && !child.parentId) { child.parentId = ev.fromSessionId; child.rev++; }
  },
  pipe() { /* the piped user message arrives as its own message.add */ },
  pylons(store, ev) { if (Array.isArray(ev.pylons)) store.pylons = ev.pylons.map(cleanPylon); },
};

function activityFor(name, args, msg) {
  const cat = CATEGORY_OF_TOOL(name);
  const a = args || {};
  if (cat === 'web') {
    if (a.url) return `browsing: ${hostOf(a.url)}`;
    if (a.query) return `searching "${clip(a.query, 50)}"`;
    return `browsing (${name})`;
  }
  if (cat === 'files') return `${name === 'read_file' ? 'reading' : name === 'search_files' ? 'searching' : 'editing'} ${clip(a.path || a.query || '', 50)}`.trim();
  if (cat === 'coding') return `running: ${clip(a.command || name, 50)}`;
  if (cat === 'delegating') return 'delegating a subtask';
  if (cat === 'memory') return `memory: ${name}`;
  return msg?.summary ? clip(msg.summary, 60) : `tool: ${name}`;
}

function hostOf(url) { try { return new URL(url).host; } catch { return clip(url, 40); } }

export default { createStore, defaultPlacement, faceOriginYaw, firstSentence, clip };
