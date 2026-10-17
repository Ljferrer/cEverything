// The Hermes source (PIN-9, PIN-30, PIN-31, PIN-34, PIN-35, PIN-36): the one
// authenticated loopback socket to the Hermes gateway. It speaks JSON-RPC 2.0
// over `ws`, attaches every session it learns of, and normalizes gateway events
// to plan 1's protocol frames.
//
// Start contract (PIN-31): `start` rejects when the first connect fails or
// `gateway.ready` is late (HERMES_CONNECT_TIMEOUT_MS, default 3000 ms), so the
// relay skips this source and falls back to synthetic. After the capabilities
// ack and the first `session.active_list` attach it resolves to `{stop()}`;
// only then does a socket close start the background retry every 5 s
// (HERMES_RETRY_MS shortens it for tests).
//
// Wire shape (verified in the plan Context against hermes-agent
// `tui_gateway/contracts/events.py` at 59ee4989): every event is the envelope
// `{jsonrpc:'2.0', method:'event', params:{type, session_id, seq, payload}}`;
// `unwrapEvent` flattens it to `[type, {...payload, session_id}]`. A bare
// notification `{method:<type>, params}` or an `{event, payload}` pair is read
// as a fallback. A frame with both `id` and `method` is a request from Hermes
// and is answered -32601 (PIN-35).
import { WebSocket } from 'ws';

export const DEFAULT_WS_URL = 'ws://127.0.0.1:9119/api/ws';
export const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
export const RETRY_MS = 5000;
export const ECHO_WINDOW_MS = 3000;
/** Scripted seed prompts (PIN-33), aimed at web_search, write_file, and terminal in turn. */
export const SEED_PROMPTS = Object.freeze([
  'Search the web for the latest three.js release notes and summarize the WebXR changes in three bullets.',
  'Write a file named notes/obelisks.md with a short paragraph describing a VR room where agent sessions stand as obelisks.',
  'Run `ls -la` in the terminal and tell me which entry was modified most recently.',
]);

const STATUS_MAP = {
  starting: 'working',
  resuming: 'working',
  idle: 'idle',
  waiting: 'waiting',
  working: 'working',
  streaming: 'streaming',
  error: 'error',
};
const mapStatus = (s) => STATUS_MAP[s] ?? 'idle';

// Module state: one socket, one session table. `start` resets it.
let emit = () => {};
let ws = null;
let stopped = true;
let attachedOnce = false;
let retryTimer = null;
let nextId = 1;
const pending = new Map();
/** sid → last `session` frame. */
const sessions = new Map();
/** sid → Map<slab id, accumulated text>. */
const slabs = new Map();
/** sid → in-flight attach promise (idempotent attach, PIN-35). */
const attaching = new Map();
/** sids resumed on the current socket; cleared on close so a reconnect resumes again. */
const resumed = new Set();
/** `${sid}/${role}` → open slab id for events that carry no message_id. */
const openSlab = new Map();
/** sid → open tool id for a `tool.complete` without `tool_id`. */
const openTool = new Map();
const seq = new Map();
/** `{session_id, text, ts}` per prompt.submit sent, so the echoed user message is not shown twice. */
let echoes = [];

function reset(emitFn) {
  emit = emitFn;
  nextId = 1;
  pending.clear();
  sessions.clear();
  slabs.clear();
  attaching.clear();
  resumed.clear();
  openSlab.clear();
  openTool.clear();
  seq.clear();
  echoes = [];
  attachedOnce = false;
}

const nextSeq = (sid) => {
  const n = (seq.get(sid) ?? 0) + 1;
  seq.set(sid, n);
  return n;
};

/** Text of a Hermes message body: a string as is, an array's text blocks joined. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('');
  if (v && typeof v === 'object' && typeof v.text === 'string') return v.text;
  return '';
}
const bodyOf = (p) => textOf(p.delta ?? p.text ?? p.content ?? p.message);

function remember(sid, id, text) {
  let m = slabs.get(sid);
  if (!m) slabs.set(sid, (m = new Map()));
  m.set(id, text);
}

/** Title from the last `session` frame; '' for an unknown sid (commands then use the sid). */
export function titleOf(sid) {
  return sessions.get(sid)?.title ?? '';
}

/** Accumulated slab text from memory; '' when unknown. */
export function slabText(sid, id) {
  return slabs.get(sid)?.get(id) ?? '';
}

// ---- JSON-RPC layer ----

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error(`hermes socket not open for ${method}`));
    const id = nextId++;
    pending.set(id, { resolve, reject, method, params });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function rejectPending(reason) {
  for (const [id, p] of pending) {
    pending.delete(id);
    p.reject(new Error(reason));
  }
}

/**
 * Send one JSON-RPC request to Hermes and resolve to its result (PIN-34). A
 * `session.create` or `session.branch` reply attaches the new session; a
 * `prompt.submit` is remembered so its echoed user message emits no slab.
 */
export async function sendCommand(method, params = {}) {
  if (method === 'prompt.submit' && typeof params.text === 'string') {
    echoes.push({ session_id: params.session_id, text: params.text, ts: Date.now() });
  }
  let result;
  try {
    result = await request(method, params);
  } catch (err) {
    if (typeof params.session_id === 'string' && sessions.has(params.session_id)) {
      emit({ t: 'state', sid: params.session_id, status: 'error' });
    }
    throw err;
  }
  if ((method === 'session.create' || method === 'session.branch') && typeof result?.session_id === 'string') {
    attach({
      session_id: result.session_id,
      title: result.title ?? params.title ?? params.name ?? result.session_id,
      status: result.status,
      parent_session_id: result.parent ?? result.parent_session_id,
    }).catch(() => {});
  }
  return result;
}

function onMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  if (msg.id !== undefined && typeof msg.method === 'string') {
    // A request from Hermes (PIN-35): refused, never surfaced.
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) {
      const err = new Error(msg.error.message ?? `hermes error ${msg.error.code}`);
      err.code = msg.error.code;
      p.reject(err);
    } else p.resolve(msg.result ?? {});
    return;
  }
  const ev = unwrapEvent(msg);
  if (ev) onEvent(ev[0], ev[1]);
}

/**
 * `[type, params]` of an event frame, or null for a non-event. The verified
 * envelope `{method:'event', params:{type, session_id, seq, payload}}` yields
 * the payload with `session_id` from the envelope (the payload's own as a
 * fallback). A bare `{method:<type>, params}` notification or an
 * `{event, payload}` pair yields its fields as they are.
 */
function unwrapEvent(msg) {
  if (msg.method === 'event' && typeof msg.params?.type === 'string') {
    const ep = msg.params;
    const payload = ep.payload && typeof ep.payload === 'object' ? ep.payload : {};
    return [ep.type, { ...payload, session_id: ep.session_id ?? payload.session_id }];
  }
  if (typeof msg.method === 'string') return [msg.method, msg.params ?? msg.payload ?? {}];
  if (typeof msg.event === 'string') return [msg.event, msg.payload ?? msg.params ?? {}];
  return null;
}

// ---- Attach (PIN-11, PIN-35) ----

function sessionFrame(info) {
  const sid = info.session_id;
  const frame = {
    t: 'session',
    sid,
    harness: 'hermes',
    kind: 'chat',
    title: typeof info.title === 'string' && info.title ? info.title : sid,
    status: mapStatus(info.status),
  };
  const parent = info.parent_session_id ?? info.parent;
  if (typeof parent === 'string' && parent) frame.parent = parent;
  return frame;
}

function seedHistory(sid, history) {
  const messages = Array.isArray(history) ? history : Array.isArray(history?.messages) ? history.messages : [];
  for (const m of messages) {
    if (m?.role !== 'user' && m?.role !== 'assistant') continue;
    const id = typeof m.message_id === 'string' ? m.message_id : typeof m.id === 'string' ? m.id : `${sid}:${nextSeq(sid)}`;
    const text = textOf(m.content ?? m.text);
    remember(sid, id, text);
    const ts = typeof m.ts === 'number' ? m.ts : typeof m.timestamp === 'number' ? m.timestamp : Date.now();
    emit({ t: 'slab', sid, id, role: m.role, text, ts });
  }
}

/**
 * Resume, announce, seed history, and report state for one session; idempotent
 * by sid and safe under concurrent calls. The `session` frame goes out before
 * the history slabs because a client drops a slab for a sid it has no obelisk
 * for yet (`src/features/room.js`), the order the relay's own backfill uses.
 */
function attach(info) {
  const sid = info?.session_id;
  if (typeof sid !== 'string' || !sid) return Promise.resolve();
  const inFlight = attaching.get(sid);
  if (inFlight) return inFlight;
  const p = (async () => {
    const known = sessions.has(sid);
    if (!resumed.has(sid)) {
      try {
        await request('session.resume', { session_id: sid, omit_messages: false, close_on_disconnect: false });
        resumed.add(sid);
      } catch {
        if (known) emit({ t: 'state', sid, status: 'error' });
        else {
          const frame = sessionFrame({ ...info, status: 'error' });
          sessions.set(sid, frame);
          emit(frame);
          emit({ t: 'state', sid, status: 'error' });
        }
        return;
      }
    }
    if (!known) {
      let history = null;
      try {
        history = await request('session.history', { session_id: sid });
      } catch {
        history = null;
      }
      const frame = sessionFrame(info);
      sessions.set(sid, frame);
      emit(frame);
      if (history) seedHistory(sid, history);
      emit({ t: 'state', sid, status: frame.status });
    } else {
      const prev = sessions.get(sid);
      const next = sessionFrame({ ...prev, ...info, status: info.status ?? prev.status });
      sessions.set(sid, next);
      if (next.status !== prev.status) emit({ t: 'state', sid, status: next.status });
    }
  })().finally(() => attaching.delete(sid));
  attaching.set(sid, p);
  return p;
}

async function listAndAttach() {
  const result = await request('session.active_list', {});
  const list = Array.isArray(result) ? result : Array.isArray(result?.sessions) ? result.sessions : [];
  for (const info of list) await attach(info);
}

// ---- Event mapping (PIN-30) ----

const shortArgs = (args) => {
  if (args === undefined || args === null) return '';
  const s = typeof args === 'string' ? args : JSON.stringify(args);
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
};

/** The slab id for a message event: `message_id`, else the open slab for the sid and role, else a new `<sid>:<seq>`. */
function slabIdFor(sid, role, p, { open }) {
  if (typeof p.message_id === 'string' && p.message_id) return p.message_id;
  const key = `${sid}/${role}`;
  if (!open) {
    const id = `${sid}:${nextSeq(sid)}`;
    openSlab.set(key, id);
    return id;
  }
  let id = openSlab.get(key);
  if (!id) {
    id = `${sid}:${nextSeq(sid)}`;
    openSlab.set(key, id);
  }
  return id;
}

function openSlabFrame(sid, id, role, text) {
  remember(sid, id, text);
  emit({ t: 'slab', sid, id, role, text, ts: Date.now() });
}

function deltaFrame(sid, id, role, text) {
  const known = slabs.get(sid)?.get(id);
  if (known === undefined) return openSlabFrame(sid, id, role, text);
  if (!text) return;
  remember(sid, id, known + text);
  emit({ t: 'delta', sid, id, role, text });
}

function completeFrame(sid, id, role, full) {
  openSlab.delete(`${sid}/${role}`);
  const known = slabs.get(sid)?.get(id);
  if (known === undefined) return openSlabFrame(sid, id, role, full);
  const tail = full.slice(known.length);
  if (tail) {
    remember(sid, id, known + tail);
    emit({ t: 'delta', sid, id, role, text: tail });
  }
}

function echoed(sid, text) {
  const now = Date.now();
  echoes = echoes.filter((e) => now - e.ts <= ECHO_WINDOW_MS);
  const i = echoes.findIndex((e) => e.session_id === sid && e.text === text);
  if (i < 0) return false;
  echoes.splice(i, 1);
  return true;
}

function onEvent(name, p) {
  if (name === 'gateway.ready') return;
  if (name === 'sessions.changed') {
    listAndAttach().catch(() => {});
    return;
  }
  const sid = typeof p?.session_id === 'string' ? p.session_id : null;
  if (!sid) return;
  switch (name) {
    case 'session.info':
    case 'session.status':
      attach(p).catch(() => {});
      return;
    case 'error':
      emit({ t: 'state', sid, status: 'error' });
      return;
    case 'message.start': {
      if (p.role === 'user') return;
      const id = slabIdFor(sid, 'assistant', p, { open: false });
      openSlabFrame(sid, id, 'assistant', '');
      return;
    }
    case 'message.delta': {
      if (p.role === 'user') return;
      deltaFrame(sid, slabIdFor(sid, 'assistant', p, { open: true }), 'assistant', bodyOf(p));
      return;
    }
    case 'message.complete': {
      const text = bodyOf(p);
      if (p.role === 'user') {
        if (echoed(sid, text)) return;
        const id = typeof p.message_id === 'string' && p.message_id ? p.message_id : `${sid}:${nextSeq(sid)}`;
        openSlabFrame(sid, id, 'user', text);
        return;
      }
      completeFrame(sid, slabIdFor(sid, 'assistant', p, { open: true }), 'assistant', text);
      return;
    }
    case 'reasoning.delta':
    case 'thinking.delta':
      deltaFrame(sid, slabIdFor(sid, 'thinking', p, { open: true }), 'thinking', bodyOf(p));
      return;
    case 'reasoning.available':
      completeFrame(sid, slabIdFor(sid, 'thinking', p, { open: true }), 'thinking', bodyOf(p));
      return;
    case 'tool.start': {
      const id = typeof p.tool_id === 'string' && p.tool_id ? p.tool_id : `${sid}:tool:${nextSeq(sid)}`;
      openTool.set(sid, id);
      const name = typeof p.name === 'string' ? p.name : 'tool';
      openSlabFrame(sid, id, 'tool', `${name} ${shortArgs(p.args)}`.trim());
      const frame = { t: 'tool', sid, id, name, phase: 'start' };
      if (p.args !== undefined && p.args !== null) frame.args = p.args;
      emit(frame);
      return;
    }
    case 'tool.complete': {
      const id = typeof p.tool_id === 'string' && p.tool_id ? p.tool_id : openTool.get(sid) ?? `${sid}:tool:${nextSeq(sid)}`;
      if (openTool.get(sid) === id) openTool.delete(sid);
      const frame = { t: 'tool', sid, id, name: typeof p.name === 'string' ? p.name : 'tool', phase: 'complete' };
      if (typeof p.summary === 'string') frame.summary = p.summary;
      if (typeof p.inline_diff === 'string') frame.diff = p.inline_diff;
      emit(frame);
      return;
    }
    default:
      return;
  }
}

// ---- Connect, start, retry ----

/** Open the socket and resolve on the `gateway.ready` event (envelope or bare); reject on error, close, or the connect timeout, with the socket closed. */
function connect(env) {
  const url = new URL(env.HERMES_WS_URL ?? DEFAULT_WS_URL);
  const token = env.HERMES_DASHBOARD_SESSION_TOKEN;
  if (token !== undefined) url.searchParams.set('token', token);
  const timeoutMs = Number(env.HERMES_CONNECT_TIMEOUT_MS ?? DEFAULT_CONNECT_TIMEOUT_MS) || DEFAULT_CONNECT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url, { headers: { Origin: `http://${url.host}` } });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners('message');
      try {
        sock.terminate();
      } catch {}
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`no gateway.ready within ${timeoutMs} ms`)), timeoutMs);
    sock.on('error', (err) => fail(err));
    sock.on('close', () => fail(new Error('hermes socket closed before gateway.ready')));
    sock.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg && typeof msg === 'object' && unwrapEvent(msg)?.[0] === 'gateway.ready') {
        settled = true;
        clearTimeout(timer);
        sock.removeAllListeners('error');
        sock.removeAllListeners('close');
        sock.removeAllListeners('message');
        resolve(sock);
      }
    });
  });
}

/** Handshake on a ready socket: capabilities, then list and attach. */
async function handshake(sock) {
  ws = sock;
  sock.on('message', onMessage);
  sock.on('error', () => {});
  sock.on('close', onClose);
  try {
    await request('client.capabilities', { server_requests: true });
  } catch {
    // An older gateway without the method still streams events.
  }
  await listAndAttach();
}

function onClose() {
  rejectPending('hermes socket closed');
  resumed.clear();
  if (ws) ws.removeAllListeners();
  ws = null;
  if (stopped || !attachedOnce) return;
  scheduleRetry();
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    if (stopped) return;
    try {
      const sock = await connect(currentEnv);
      if (stopped) return sock.terminate();
      await handshake(sock);
    } catch {
      if (!stopped) scheduleRetry();
    }
  }, retryMs(currentEnv));
}

const retryMs = (env) => Number(env.HERMES_RETRY_MS) > 0 ? Number(env.HERMES_RETRY_MS) : RETRY_MS;

let currentEnv = process.env;

/** Parse `--seed N` from argv; 0 when absent or not a positive integer. */
export function seedCount(argv) {
  const i = argv.indexOf('--seed');
  const raw = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--seed='))?.slice(7);
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

async function seed(n) {
  for (let i = 1; i <= n; i += 1) {
    const result = await sendCommand('session.create', { title: `Seed ${i}` });
    const sid = result?.session_id;
    if (typeof sid !== 'string') continue;
    await sendCommand('prompt.submit', { session_id: sid, text: SEED_PROMPTS[(i - 1) % SEED_PROMPTS.length] });
  }
}

/** Stop the source: close the socket and clear the retry timer. */
export async function stop() {
  stopped = true;
  clearTimeout(retryTimer);
  retryTimer = null;
  rejectPending('hermes source stopped');
  if (ws) {
    const sock = ws;
    ws = null;
    sock.removeAllListeners();
    sock.on('error', () => {});
    sock.terminate();
  }
}

/**
 * Connect to the Hermes gateway, attach every active session, seed `--seed N`
 * sessions, and resolve to `{stop}`. Rejects when the host does not answer
 * within the connect timeout so the relay falls back to synthetic (PIN-31).
 * The relay's own `sendCommand` argument (a client-command router) is not
 * used: command modules reach this source through the exported `sendCommand`.
 */
export async function start({ emit: emitFn, argv = process.argv, env = process.env } = {}) {
  await stop();
  reset(typeof emitFn === 'function' ? emitFn : () => {});
  stopped = false;
  currentEnv = env;
  const sock = await connect(env);
  try {
    await handshake(sock);
  } catch (err) {
    await stop();
    throw err;
  }
  attachedOnce = true;
  const n = seedCount(argv);
  if (n > 0) {
    try {
      await seed(n);
    } catch (err) {
      console.error('[hermes] seed failed:', err.message);
    }
  }
  return { stop };
}
