// Hermes live adapter (PROTOCOL.md §4): polls the dashboard REST at 1 Hz (sessions) + staggered 1 Hz per-session
// messages, diffs by row id, runs normalize.js, optional /api/ws token streaming, writes via the API server.
// Starts even when Hermes is down (logs once, retries every 5 s). Never fakes a reply in live mode.
//
// Live tiles: every streamed assistant segment / reasoning block gets a FRESH id (`<sid>:live:<n>` / `…:<n>:r`) and is
// retired (message.complete{hidden:true}) oldest-first when the matching polled row lands; streamed tool calls use
// `<sid>:live:<callId>` and a stream tool.complete always targets the tile that is visible at that moment. Session
// counts come from Hermes (`countsAuthoritative: true`, optional field) so the hub does not double count them.

import { WebSocket } from 'ws';
import { CommandError } from '../hub.js';
import { CATEGORY_OF_TOOL, TARGET_OF_CATEGORY, GLYPH_OF } from '../protocol.js';
import { normalizeSession, normalizeMessages, deriveStatus, redact, redactDeep, clip, parseJSONish, firstLine, describeToolCall, describeToolResult } from './normalize.js';

const SESSIONS_INTERVAL_MS = 1000;
const MESSAGES_INTERVAL_MS = 1000;
const SCHED_TICK_MS = 100;
const RETRY_DOWN_MS = 5000;
const WS_RETRY_MS = 30_000;
const FETCH_TIMEOUT_MS = 4000;
const SESSION_LIMIT = 12;
const MESSAGE_LIMIT = 60;
const MISSING_GRACE_MS = 15_000;   // absent from the listing this long → stop polling, remove the column
const FRESH_SESSION_MS = 60_000;   // sessions created here (fork/new) are never pruned this soon
const OPTIMISTIC_TTL_MS = 120_000; // optimistic user tiles reconcile with the polled row within this window
const LIVE_FIFO_MAX = 50;

export function hermesEnv(env = process.env) {
  return {
    dashboard: (env.HERMES_DASHBOARD || 'http://127.0.0.1:9119').replace(/\/$/, ''),
    api: (env.HERMES_API || 'http://127.0.0.1:8642').replace(/\/$/, ''),
    apiKey: (env.HERMES_API_KEY || '').trim(),
    profile: (env.HERMES_PROFILE || '').trim() || undefined,
    streaming: env.HERMES_WS !== '0',
  };
}

async function fetchJSON(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) { const err = new Error(`${res.status} ${res.statusText}${typeof body === 'string' ? `: ${body.slice(0, 120)}` : body?.detail ? `: ${JSON.stringify(body.detail).slice(0, 120)}` : ''}`); err.status = res.status; err.body = body; throw err; }
    return body;
  } finally { clearTimeout(t); }
}

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * createHermesSource({ dashboard, api, apiKey, profile, streaming, log }) → source
 */
export function createHermesSource(opts = {}) {
  const cfg = { ...hermesEnv(), ...opts };
  const log = opts.log || (() => {});
  const host = (() => { try { return new URL(cfg.dashboard).host; } catch { return cfg.dashboard; } })();
  let hub = null; let state = null;
  let timers = [];
  let reachable = false; let loggedDown = false; let downSince = 0;
  let streamingState = 'off'; // off | connecting | on | failed
  let ws = null; let wsLoggedFail = false; let wsRetryAt = 0;
  const tracked = new Map(); // sessionId → tracked entry (see newTracked)

  const source = {
    kind: 'hermes',
    get reachable() { return reachable; },
    get tracked() { return tracked; },
    start, stop, info, handleCommand,
    // exposed for tests
    ingestSessions, ingestMessages,
    handleStreamFrame(msg) { const f = parseStreamFrame(msg); if (f && f.type !== 'gateway.ready') handleStreamEvent(f.type, f.sid, f.payload); return f; },
  };

  function newTracked(row, now, i = 0, n = 1) {
    return {
      row, lastJSON: '', status: null, seenMessageIds: new Set(), seenStarts: new Set(), seenCompletes: new Set(), messages: [],
      knownCalls: new Map(), orphanResults: new Map(), nextAt: now + Math.round((i / Math.max(1, n)) * MESSAGES_INTERVAL_MS),
      inFlight: false, live: null, optimistic: [], createdAt: now, missingSince: 0,
    };
  }

  function info() {
    let label;
    if (!reachable) label = `LIVE (hermes unreachable @${host})`;
    else if (streamingState === 'on') label = `LIVE: hermes@${host}`;
    else label = cfg.streaming ? 'LIVE (polling only)' : `LIVE: hermes@${host}`;
    return { label, host, dashboard: cfg.dashboard, api: cfg.api, hasApiKey: Boolean(cfg.apiKey), reachable, streaming: streamingState, profile: cfg.profile, scenario: null, speed: 1, paused: false };
  }

  function profileQS(sep = '&') { return cfg.profile ? `${sep}profile=${encodeURIComponent(cfg.profile)}` : ''; }

  function start(h, s) {
    hub = h; state = s || h.state;
    const t1 = setInterval(pollSessions, SESSIONS_INTERVAL_MS); t1.unref?.();
    const t2 = setInterval(scheduleTick, SCHED_TICK_MS); t2.unref?.();
    timers = [t1, t2];
    pollSessions();
  }

  function stop() {
    for (const t of timers) clearInterval(t);
    timers = [];
    if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
  }

  // ------------------------------------------------------------------ polling
  let sessionsInFlight = false;
  async function pollSessions() {
    if (sessionsInFlight) return;
    if (!reachable && downSince && Date.now() - downSince < RETRY_DOWN_MS) return; // retry every 5 s while down
    sessionsInFlight = true;
    try {
      const body = await fetchJSON(`${cfg.dashboard}/api/sessions?order=recent&limit=${SESSION_LIMIT}${profileQS()}`);
      const rows = Array.isArray(body?.sessions) ? body.sessions : Array.isArray(body) ? body : [];
      if (!reachable) { reachable = true; loggedDown = false; downSince = 0; log(`[hermes] connected to dashboard ${cfg.dashboard} (${rows.length} sessions)`); hub?.broadcastSourceInfo(); if (cfg.streaming) connectStream(); }
      ingestSessions(rows);
    } catch (err) {
      if (reachable || !loggedDown) { log(`[hermes] dashboard ${cfg.dashboard} unreachable: ${err.message} — retrying every ${RETRY_DOWN_MS / 1000} s`); loggedDown = true; }
      if (reachable) { reachable = false; hub?.broadcastSourceInfo(); }
      downSince = Date.now();
    } finally { sessionsInFlight = false; }
  }

  /** Diff a sessions listing against what we track; emit session.upsert / session.status; prune what left the listing. */
  function ingestSessions(rows) {
    const now = Date.now();
    const seen = new Set();
    rows.forEach((row, i) => {
      const id = String(row?.id ?? '');
      if (!id) return;
      seen.add(id);
      let t = tracked.get(id);
      if (!t) { t = newTracked(row, now, i, rows.length); tracked.set(id, t); }
      t.row = row; t.missingSince = 0;
      if (row.archived === true || row.archived === 1) { if (state?.sessions[id]) hub.emit({ sessionId: id, kind: 'session.remove' }); tracked.delete(id); return; }
      maybeUpsert(t, id, now);
      updateStatus(t, id, now);
    });
    // a session that left `order=recent&limit=12` (busy Hermes, profile switch) stops being polled and leaves the room
    for (const [id, t] of tracked) {
      if (seen.has(id)) continue;
      if (!t.missingSince) { t.missingSince = now; continue; }
      if (now - t.missingSince < MISSING_GRACE_MS || now - t.createdAt < FRESH_SESSION_MS) continue;
      if (state?.sessions[id]) hub.emit({ sessionId: id, kind: 'session.remove' });
      tracked.delete(id);
      log(`[hermes] ${id} left the session listing — column removed`);
    }
  }

  /** Emit session.upsert when anything the glance panel shows changed. Counts/toolHistory come from Hermes + our tiles. */
  function maybeUpsert(t, id, now = Date.now()) {
    const session = normalizeSession(t.row, { messages: t.messages, now });
    const json = JSON.stringify([session.title, session.model, session.cwd, session.gitBranch, session.parentId, session.endReason, session.activity, session.counts, session.toolHistory, t.row?.archived]);
    if (json === t.lastJSON) return;
    t.lastJSON = json;
    hub.emit({ sessionId: id, kind: 'session.upsert', session: { ...session, status: t.status || session.status, countsAuthoritative: true } });
  }

  function updateStatus(t, id, now = Date.now()) {
    const status = deriveStatus(t.row, t.messages, now);
    if (status !== t.status) {
      t.status = status;
      const s = normalizeSession(t.row, { messages: t.messages, now, status });
      hub.emit({ sessionId: id, kind: 'session.status', status, activity: s.activity, attention: s.attention || null });
    }
  }

  function scheduleTick() {
    if (!reachable) return;
    const now = Date.now();
    for (const [id, t] of tracked) {
      if (t.inFlight || t.nextAt > now) continue;
      t.nextAt = now + MESSAGES_INTERVAL_MS;
      pollMessages(id, t);
    }
  }

  async function pollMessages(id, t) {
    t.inFlight = true;
    try {
      const body = await fetchJSON(`${cfg.dashboard}/api/sessions/${encodeURIComponent(id)}/messages?order=latest&limit=${MESSAGE_LIMIT}${profileQS()}`);
      let rows = Array.isArray(body?.messages) ? body.messages : Array.isArray(body) ? body : [];
      rows = [...rows].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0) || (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
      ingestMessages(id, rows);
    } catch (err) {
      if (err.status === 404) { if (state?.sessions[id]) hub.emit({ sessionId: id, kind: 'session.remove' }); tracked.delete(id); }
      else if (reachable) log(`[hermes] messages ${id}: ${err.message}`);
    } finally { t.inFlight = false; }
  }

  /** Normalize a page of rows and emit only what we have not emitted before (diff by id). */
  function ingestMessages(id, rows) {
    const t = tracked.get(id);
    if (!t) return;
    const { events } = normalizeMessages(id, rows, { knownCalls: t.knownCalls, orphanResults: t.orphanResults });
    const live = t.live;
    for (const ev of events) {
      if (ev.kind === 'message.add') {
        const m = ev.message;
        if (t.seenMessageIds.has(m.id)) continue;
        t.seenMessageIds.add(m.id);
        t.messages.push(m);
        if (t.messages.length > 400) t.messages.splice(0, t.messages.length - 400);
        if (m.role === 'user') reconcileOptimistic(t, id, m);
        else if (m.role === 'assistant' && live) retireLive(id, live, 'assistant');
        else if (m.role === 'thinking' && live) retireLive(id, live, 'thinking');
        else if (m.role === 'tool_call' && live?.tools.has(m.tool?.callId)) {
          // the streamed tile for this call becomes the polled row's tile; a completion that already landed moves with it
          const callId = m.tool.callId;
          hub.emit({ sessionId: id, kind: 'message.complete', messageId: `${id}:live:${callId}`, text: '', hidden: true });
          live.tools.delete(callId);
          hub.emit(ev);
          const done = live.toolResults.get(callId);
          if (done) { live.toolResults.delete(callId); hub.emit({ sessionId: id, kind: 'tool.complete', messageId: m.id, callId, ...done, quiet: true }); }
          continue;
        }
        hub.emit(ev);
      } else if (ev.kind === 'tool.start') {
        if (t.seenStarts.has(ev.callId)) continue;
        t.seenStarts.add(ev.callId); hub.emit(ev);
      } else if (ev.kind === 'tool.complete') {
        if (t.seenCompletes.has(ev.callId)) continue;
        t.seenCompletes.add(ev.callId); hub.emit(ev);
      }
    }
    if (t.seenMessageIds.size > 5000) t.seenMessageIds = new Set([...t.seenMessageIds].slice(-2000));
    updateStatus(t, id);
    maybeUpsert(t, id);
  }

  /** A polled assistant/thinking row supersedes the oldest finished live tile of that role (or the one still streaming). */
  function retireLive(sid, live, role) {
    const fifo = role === 'assistant' ? live.doneAssistant : live.doneThinking;
    let mid = fifo.shift();
    if (!mid) { mid = live[role]; if (!mid) return; live[role] = null; }
    hub.emit({ sessionId: sid, kind: 'message.complete', messageId: mid, text: '', hidden: true });
  }

  /** A polled user row that matches an optimistic tile (same text, < 2 min) replaces it; via/from carry over. */
  function reconcileOptimistic(t, sid, m) {
    const now = Date.now();
    t.optimistic = t.optimistic.filter((o) => now - o.ts < OPTIMISTIC_TTL_MS);
    const key = squash(m.text);
    const i = t.optimistic.findIndex((o) => o.key === key);
    if (i < 0) return;
    const [o] = t.optimistic.splice(i, 1);
    hub.emit({ sessionId: sid, kind: 'message.complete', messageId: o.id, text: '', hidden: true });
    if (o.via) m.via = o.via;
    if (o.from) m.from = o.from;
  }

  // ------------------------------------------------------------------ optional /api/ws streaming
  function connectStream() {
    if (!cfg.streaming || ws || Date.now() < wsRetryAt) return;
    streamingState = 'connecting';
    const url = `${cfg.dashboard.replace(/^http/, 'ws')}/api/ws`;
    let ready = false;
    try { ws = new WebSocket(url, { handshakeTimeout: FETCH_TIMEOUT_MS }); } catch (err) { streamFailed(err); return; }
    ws.on('open', () => { /* wait for gateway.ready */ });
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      const frame = parseStreamFrame(msg);
      if (!frame) return;
      if (!ready && frame.type === 'gateway.ready') {
        ready = true; streamingState = 'on'; wsLoggedFail = false;
        try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'client.capabilities', params: { server_requests: false } })); } catch { /* ignore */ }
        log(`[hermes] streaming via ${url}`); hub?.broadcastSourceInfo();
        return;
      }
      handleStreamEvent(frame.type, frame.sid, frame.payload);
    });
    ws.on('error', (err) => streamFailed(err));
    ws.on('close', () => { if (streamingState !== 'failed') streamFailed(new Error('closed')); });
  }

  function streamFailed(err) {
    if (!wsLoggedFail) { log(`[hermes] /api/ws streaming unavailable (${err?.message || err}) — polling only`); wsLoggedFail = true; }
    streamingState = 'failed'; wsRetryAt = Date.now() + WS_RETRY_MS;
    if (ws) { try { ws.terminate?.(); } catch { /* ignore */ } ws = null; }
    hub?.broadcastSourceInfo();
    // timers can fire a millisecond before Date.now() reaches wsRetryAt: clear the guard so this retry always connects
    const t = setTimeout(() => { wsRetryAt = 0; if (reachable && cfg.streaming) connectStream(); }, WS_RETRY_MS); t.unref?.();
  }

  function liveFor(sid) {
    const t = tracked.get(sid);
    if (!t) return null;
    if (!t.live) t.live = { assistant: null, thinking: null, seq: 0, segs: 0, doneAssistant: [], doneThinking: [], tools: new Set(), toolResults: new Map() };
    return t.live;
  }
  function newSegment(live) { live.seq += 1; live.segs += 1; return live.seq; }
  /** Finalize the streaming tile of `role` and queue it for retirement by its polled row. */
  function closeLive(sid, live, role, text) {
    const mid = live[role]; if (!mid) return;
    const ev = { sessionId: sid, kind: 'message.complete', messageId: mid };
    if (typeof text === 'string') ev.text = redact(text);
    hub.emit(ev);
    live[role] = null;
    const fifo = role === 'assistant' ? live.doneAssistant : live.doneThinking;
    fifo.push(mid); if (fifo.length > LIVE_FIFO_MAX) fifo.shift();
  }

  /**
   * §3f envelope: {jsonrpc, method:"event", params:{type, session_id, payload:{…}, seq}}. Also tolerates flat shapes
   * ({method:"message.delta", params:{session_id, text}} / {type:"gateway.ready"}). Returns {type, sid, payload} or null.
   */
  function parseStreamFrame(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const method = msg.method || msg.type || msg.event;
    const params = msg.params && typeof msg.params === 'object' ? msg.params : (msg.data && typeof msg.data === 'object' ? msg.data : msg);
    let type = method === 'event' ? (params.type || params.event || params.kind) : method;
    if (typeof type !== 'string') return null;
    const payload = params.payload && typeof params.payload === 'object' ? params.payload : params;
    const sid = String(params.session_id || params.sessionId || payload.session_id || payload.sessionId || params.session || '');
    return { type, sid, payload };
  }

  function handleStreamEvent(type, sid, p = {}) {
    if (!sid || !state?.sessions[sid]) return;
    const t = tracked.get(sid);
    const live = liveFor(sid);
    if (!live) return;
    const text = typeof p.text === 'string' ? p.text : typeof p.delta === 'string' ? p.delta : null; // §3g: null = segment boundary
    switch (type) {
      case 'message.delta': {
        if (text === null) { closeLive(sid, live, 'assistant'); closeLive(sid, live, 'thinking'); break; } // next text = a new tile
        if (!live.assistant) {
          const n = live.thinking ? live.seq : newSegment(live); // reasoning already opened this segment
          live.assistant = `${sid}:live:${n}`;
          hub.emit({ sessionId: sid, kind: 'message.add', message: { id: live.assistant, sessionId: sid, role: 'assistant', ts: Date.now(), text: '', summary: '', glyph: 'A', streaming: true, live: true } });
        }
        hub.emit({ sessionId: sid, kind: 'message.delta', messageId: live.assistant, text: redact(text) });
        break;
      }
      case 'reasoning.delta': case 'thinking.delta': {
        if (text === null) break;
        if (!live.thinking) {
          if (live.assistant) closeLive(sid, live, 'assistant'); // text already streamed: new reasoning starts a new segment
          const n = newSegment(live);
          live.thinking = `${sid}:live:${n}:r`;
          hub.emit({ sessionId: sid, kind: 'message.add', message: { id: live.thinking, sessionId: sid, role: 'thinking', ts: Date.now(), text: '', summary: 'thinking…', glyph: '✎', streaming: true, live: true, parentMessageId: `${sid}:live:${n}` } });
        }
        hub.emit({ sessionId: sid, kind: 'message.delta', messageId: live.thinking, text: redact(text) });
        break;
      }
      case 'message.complete': {
        const single = live.segs <= 1; // the turn's full text only replaces a single-segment stream
        closeLive(sid, live, 'assistant', single && typeof p.text === 'string' ? p.text : undefined);
        closeLive(sid, live, 'thinking', single && typeof p.reasoning === 'string' ? p.reasoning : undefined);
        live.segs = 0;
        break;
      }
      case 'tool.start': {
        // §3g payload: {tool_id, name, context?, args?, args_text?, preview?, labels?}
        const name = String(p.name || p.tool_name || p.tool || 'tool');
        const callId = String(p.tool_id || p.call_id || p.tool_call_id || p.id || `live_${Date.now().toString(36)}`);
        if (t && t.seenStarts.has(callId)) break;
        const rawArgs = p.args && typeof p.args === 'object' ? p.args : parseJSONish(p.args_text, null);
        const args = redactDeep(rawArgs && typeof rawArgs === 'object' ? rawArgs : {});
        const category = CATEGORY_OF_TOOL(name);
        const target = TARGET_OF_CATEGORY(category);
        const { meta, preview, summary } = describeToolCall(name, args);
        const mid = `${sid}:live:${callId}`;
        const tool = { callId, name, category, target, args, preview: redact(p.preview ? clip(p.preview, 60) : preview) };
        if (Object.keys(meta).length) tool.meta = redactDeep(meta);
        hub.emit({ sessionId: sid, kind: 'message.add', message: { id: mid, sessionId: sid, role: 'tool_call', ts: Date.now(), text: redact(summary), summary: redact(summary), glyph: GLYPH_OF('tool_call', category), tool, live: true } });
        hub.emit({ sessionId: sid, kind: 'tool.start', messageId: mid, callId, name, category, args, preview: tool.preview, target, live: true });
        live.tools.add(callId);
        if (t) t.seenStarts.add(callId); // the polled row's tool.start would be a second packet
        break;
      }
      case 'tool.complete': {
        // §3g payload: {tool_id, name, args?, duration_s?, result?, summary?, result_text?, inline_diff?}
        const name = String(p.name || p.tool_name || p.tool || 'tool');
        const callId = String(p.tool_id || p.call_id || p.tool_call_id || p.id || '');
        if (!callId || (t && t.seenCompletes.has(callId))) break;
        const resultText = typeof p.result_text === 'string' ? p.result_text : typeof p.result === 'string' ? p.result : p.result != null ? JSON.stringify(p.result) : '';
        const { ok: okFromResult, exitCode, diff } = describeToolResult(name, resultText);
        const ok = p.ok === false || Boolean(p.error) || p.status === 'error' || p.status === 'failed' ? false : okFromResult;
        const durationMs = Number.isFinite(Number(p.duration_ms)) ? Number(p.duration_ms) : Number.isFinite(Number(p.duration_s)) ? Math.round(Number(p.duration_s) * 1000) : undefined;
        const meta = {};
        const inline = typeof p.inline_diff === 'string' && p.inline_diff.trim() ? p.inline_diff : diff;
        if (inline) meta.diff = redact(inline);
        if (exitCode !== undefined) meta.exitCode = exitCode;
        const argMeta = p.args && typeof p.args === 'object' ? describeToolCall(name, redactDeep(p.args)).meta : {};
        const preview = clip(redact(p.summary || firstLine(resultText) || p.preview || ''), 60);
        const fields = { name, ok, preview, live: true };
        if (durationMs !== undefined) fields.durationMs = durationMs;
        if (Object.keys(meta).length || Object.keys(argMeta).length) fields.meta = { ...argMeta, ...meta };
        // target = whichever tile is visible now: the live tile, or the polled tool_call tile that already replaced it
        const onLive = live.tools.has(callId);
        const mid = onLive ? `${sid}:live:${callId}` : (state.messages[sid] || []).find((m) => m.role === 'tool_call' && m.tool?.callId === callId && !m.hidden)?.id;
        if (!mid) break; // never saw this call: the polled result row completes it
        hub.emit({ sessionId: sid, kind: 'tool.complete', messageId: mid, callId, ...fields });
        if (onLive) live.toolResults.set(callId, fields); // moves onto the polled tile when its row lands
        if (t) t.seenCompletes.add(callId);
        break;
      }
      default: break;
    }
  }

  // ------------------------------------------------------------------ writes
  function requireApi() {
    if (!reachable) throw new CommandError('source_unavailable', `Hermes dashboard at ${cfg.dashboard} is unreachable${cfg.apiKey ? '' : ' and HERMES_API_KEY is not set'} — start \`hermes dashboard\` (+ \`hermes gateway\` for writes) or run with --source fixture`);
    if (!cfg.apiKey) throw new CommandError('source_unavailable', 'HERMES_API_KEY not set — live writes are disabled (read-only mirror)');
  }
  function apiHeaders() { return { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` }; }
  function requireSession(id) { if (!state?.sessions[id]) throw new CommandError('unknown_session', `no session ${id}`); return state.sessions[id]; }

  async function handleCommand(cmd, ctx = {}) {
    switch (cmd.name) {
      case 'send': {
        requireApi(); requireSession(cmd.sessionId);
        return postChat(cmd.sessionId, cmd.text, cmd.via || 'keyboard', cmd.from, ctx);
      }
      case 'pipe': {
        requireApi();
        const from = requireSession(cmd.fromSessionId); requireSession(cmd.toSessionId);
        const src = (state.messages[cmd.fromSessionId] || []).find((m) => m.id === cmd.fromMessageId);
        if (!src) throw new CommandError('bad_command', `no message ${cmd.fromMessageId} in ${cmd.fromSessionId}`);
        const text = `[from ${from.title}]: ${src.text || src.summary || ''}`.trim();
        const res = await postChat(cmd.toSessionId, text, 'pipe', { sessionId: cmd.fromSessionId, messageId: cmd.fromMessageId }, ctx, true);
        hub.emit({ sessionId: cmd.toSessionId, kind: 'pipe', fromSessionId: cmd.fromSessionId, fromMessageId: cmd.fromMessageId, toSessionId: cmd.toSessionId, newMessageId: res.messageId, by: ctx.clientId });
        return { newMessageId: res.messageId };
      }
      case 'fork': {
        requireApi(); const parent = requireSession(cmd.sessionId);
        const body = await fetchJSON(`${cfg.api}/api/sessions/${encodeURIComponent(cmd.sessionId)}/fork`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ title: cmd.title || `${parent.title} fork` }) }, 15000)
          .catch((err) => { throw new CommandError('source_unavailable', `fork failed: ${err.message}`); });
        const row = body?.session || body;
        const id = String(row?.id || '');
        if (!id) throw new CommandError('source_unavailable', 'fork: API returned no session id');
        const session = normalizeSession({ ...row, parent_session_id: row.parent_session_id || cmd.sessionId, title: row.title || cmd.title || `${parent.title} fork` }, { now: Date.now() });
        const p = state.layout[cmd.sessionId];
        const placement = { sessionId: id, x: Number.isFinite(cmd.x) ? cmd.x : (p ? p.x + 0.8 : 0.8), z: Number.isFinite(cmd.z) ? cmd.z : (p ? p.z : -1.8), rot: p?.rot || 0 };
        hub.emit({ sessionId: id, kind: 'session.upsert', session, by: ctx.clientId });
        hub.emit({ sessionId: id, kind: 'layout.column', placement, by: ctx.clientId });
        hub.emit({ sessionId: id, kind: 'fork', fromSessionId: cmd.sessionId, newSessionId: id, atMessageId: cmd.atMessageId, by: ctx.clientId });
        tracked.set(id, { ...newTracked({ ...row, id }, Date.now()), nextAt: 0 });
        return { newSessionId: id, placement, note: 'Hermes fork copies the whole history; the parent ends as "branched"' };
      }
      case 'new': {
        requireApi();
        const body = await fetchJSON(`${cfg.api}/api/sessions`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(cmd.title ? { title: cmd.title } : {}) }, 15000)
          .catch((err) => { throw new CommandError('source_unavailable', `create failed: ${err.message}`); });
        const row = body?.session || body;
        const id = String(row?.id || '');
        if (!id) throw new CommandError('source_unavailable', 'new: API returned no session id');
        const session = normalizeSession({ ...row, id, title: row.title || cmd.title || 'new session' }, { now: Date.now() });
        hub.emit({ sessionId: id, kind: 'session.upsert', session, by: ctx.clientId });
        if (Number.isFinite(cmd.x) && Number.isFinite(cmd.z)) hub.emit({ sessionId: id, kind: 'layout.column', placement: { sessionId: id, x: cmd.x, z: cmd.z, rot: 0 }, by: ctx.clientId });
        tracked.set(id, { ...newTracked({ ...row, id }, Date.now()), nextAt: 0 });
        return { sessionId: id };
      }
      case 'approve': {
        requireApi(); requireSession(cmd.sessionId);
        // no server_requests stream is open (client.capabilities server_requests:false) → answer as a chat message
        return postChat(cmd.sessionId, cmd.allow ? 'yes' : 'no', 'keyboard', undefined, ctx);
      }
      case 'interrupt': throw new CommandError('not_supported', 'interrupt is not supported over the Hermes REST API');
      default: throw new CommandError('not_supported', `hermes source does not handle ${cmd.name}`);
    }
  }

  /** Optimistically mirror the user message, then POST /api/sessions/{id}/chat. The reply arrives via polling. */
  async function postChat(sessionId, text, via, from, ctx, deferEmit = false) {
    const id = `${sessionId}:u:${Date.now().toString(36)}`;
    const safe = redact(text); // the agent receives the real text; only the mirrored tile (and its summary) is redacted
    const message = { id, sessionId, role: 'user', ts: Date.now(), text: safe, summary: clip(safe, 100), glyph: 'U', via };
    if (from) message.from = from;
    const emitUser = () => hub.emit({ sessionId, kind: 'message.add', message, by: ctx.clientId });
    if (!deferEmit) emitUser();
    const t = tracked.get(sessionId);
    if (t) {
      t.seenMessageIds.add(id);
      t.optimistic.push({ id, key: squash(safe), ts: Date.now(), via, from }); // reconciled with the polled user row
      if (t.optimistic.length > 20) t.optimistic.shift();
    }
    hub.emit({ sessionId, kind: 'session.status', status: 'thinking', activity: 'thinking', attention: null });
    // fire-and-forget: /chat blocks for the whole turn (30–120 s); the poller shows the reply as rows land
    fetchJSON(`${cfg.api}/api/sessions/${encodeURIComponent(sessionId)}/chat`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ message: text }) }, 180_000)
      .catch((err) => { log(`[hermes] chat ${sessionId}: ${err.message}`); hub.emit({ sessionId, kind: 'session.status', status: 'error', attention: { kind: 'error', text: clip(`chat failed: ${err.message}`, 120), since: Date.now() } }); });
    if (deferEmit) emitUser();
    return { messageId: id, note: 'reply arrives via polling' };
  }

  return source;
}

export default { createHermesSource, hermesEnv };
