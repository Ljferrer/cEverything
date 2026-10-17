// Reconnecting WebSocket client (PROTOCOL.md §2): join/hello/snapshot, lastSeq resume, 0.5→8 s backoff,
// command promises resolved by ack/error, frames applied to the store. Presence is fire-and-forget (≤ 10 Hz).

const BACKOFF_MIN = 500;
const BACKOFF_MAX = 8000;
const COMMAND_TIMEOUT_MS = 15000;
const QUEUE_MAX = 64;
const PRESENCE_MIN_INTERVAL = 100;

export class CommandError extends Error {
  constructor(code, message, frame) { super(message || code); this.code = code; this.frame = frame; }
}

/**
 * createNet({ store, device, name, url? }) → net
 * net.connect(), net.close(), net.cmd(name, fields) → Promise<ack.result>, net.sendPresence(fields), net.on('status', fn)
 * status ∈ 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'
 */
export function createNet({ store, device = 'desktop', name = '', url } = {}) {
  const wsUrl = url || defaultUrl();
  const listeners = new Map();
  const pending = new Map();      // cmd id → { resolve, reject, timer, name }
  const queue = [];               // commands waiting for an open socket
  let ws = null;
  let status = 'idle';
  let backoff = BACKOFF_MIN;
  let attempts = 0;
  let reconnectTimer = null;
  let closedByUser = false;
  let cmdCounter = 0;
  let lastPresenceAt = 0;
  let rtt = 0;
  let pingTimer = null;
  let epoch = null; // the server instance we last heard from (hello.epoch, optional): a join after a server restart must snapshot

  const net = {
    get status() { return status; },
    get url() { return wsUrl; },
    get attempts() { return attempts; },
    get rtt() { return rtt; },
    get open() { return Boolean(ws && ws.readyState === WebSocket.OPEN && status === 'open'); },
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type)?.delete(fn); },
    connect, close, cmd, sendPresence, sendRaw,
    stats() { return { status, attempts, pending: pending.size, queued: queue.length, rtt, epoch }; },
    /** Test hook: drop the socket without marking it user-closed, so the backoff/resume path runs. */
    dropForTest() { const sock = ws; if (sock) { try { sock.close(4000, 'test drop'); } catch { /* ignore */ } } return sock ? sock.readyState : -1; },
    socketState() { return ws ? ws.readyState : -1; },
  };

  function emit(type, payload) {
    const set = listeners.get(type);
    if (set) for (const fn of [...set]) { try { fn(payload); } catch (err) { console.error('[net] listener failed', err); } }
  }

  function setStatus(s) {
    if (s === status) return;
    status = s;
    store?.setConnected?.(s === 'open');
    emit('status', s);
  }

  function connect() {
    closedByUser = false;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    setStatus(attempts === 0 ? 'connecting' : 'reconnecting');
    attempts += 1;
    let sock;
    try { sock = new WebSocket(wsUrl); } catch (err) { console.warn('[net] WebSocket construction failed', err); scheduleReconnect(); return; }
    ws = sock;
    sock.onopen = () => {
      if (sock !== ws) return;
      backoff = BACKOFF_MIN;
      const join = { t: 'join', device, name };
      if (store && store.seq > 0) { join.lastSeq = store.seq; if (epoch) join.epoch = epoch; }
      sock.send(JSON.stringify(join));
      // joined when hello arrives; flush on hello
    };
    sock.onmessage = (e) => { if (sock === ws) onMessage(e.data); };
    sock.onerror = () => { /* onclose follows */ };
    sock.onclose = (e) => {
      if (sock !== ws) return;
      ws = null;
      stopPing();
      emit('close', { code: e.code, reason: e.reason });
      if (closedByUser) { setStatus('closed'); return; }
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (closedByUser) return;
    setStatus('reconnecting');
    const jitter = backoff * (0.8 + Math.random() * 0.4);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, jitter);
    backoff = Math.min(BACKOFF_MAX, backoff * 2);
  }

  function close() {
    closedByUser = true;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    stopPing();
    const sock = ws; ws = null;
    if (sock) { try { sock.close(1000, 'client closed'); } catch { /* ignore */ } }
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new CommandError('closed', `connection closed before ${p.name} (${id}) was answered`)); }
    pending.clear();
    setStatus('closed');
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => { if (net.open) { pingSentAt = performance.now(); sendRaw({ t: 'ping' }); } }, 15000);
  }
  function stopPing() { if (pingTimer) clearInterval(pingTimer); pingTimer = null; }
  let pingSentAt = 0;

  function onMessage(data) {
    let frame;
    try { frame = JSON.parse(data); } catch { console.warn('[net] bad JSON frame'); return; }
    if (!frame || typeof frame !== 'object') return;
    switch (frame.t) {
      case 'hello':
        epoch = typeof frame.epoch === 'string' ? frame.epoch : null;
        store?.applyHello(frame);
        setStatus('open');
        startPing();
        flushQueue();
        emit('hello', frame);
        break;
      case 'snapshot':
        store?.applySnapshot(frame);
        emit('snapshot', frame);
        break;
      case 'event':
        store?.applyEvent(frame);
        break;
      case 'presence':
        store?.applyPresence(frame);
        break;
      case 'presence.left':
        store?.removePresence(frame.clientId);
        break;
      case 'transcript':
        store?.emit('transcript', frame);
        emit('transcript', frame);
        break;
      case 'voice.unavailable':
        store?.emit('voice.unavailable', frame);
        emit('voice.unavailable', frame);
        break;
      case 'source':
        store?.setSourceInfo(frame.sourceInfo);
        break;
      case 'ack':
      case 'error': {
        const p = frame.inReplyTo ? pending.get(frame.inReplyTo) : null;
        if (p) {
          pending.delete(frame.inReplyTo);
          clearTimeout(p.timer);
          if (frame.t === 'ack') p.resolve(frame.result === undefined ? { ok: true } : frame.result);
          else p.reject(new CommandError(frame.code || 'error', frame.message || frame.code, frame));
        } else if (frame.t === 'error') {
          console.warn('[net] server error', frame.code, frame.message);
          store?.emit('error', frame);
        }
        emit(frame.t, frame);
        break;
      }
      case 'pong':
        rtt = Math.round(performance.now() - pingSentAt);
        break;
      default:
        break;
    }
    emit('frame', frame);
  }

  function sendRaw(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); return true; } catch (err) { console.warn('[net] send failed', err); return false; }
  }

  /** Send a command; resolves with ack.result (or {ok:true}), rejects with CommandError. Queued while offline. */
  function cmd(name, fields = {}, { timeout = COMMAND_TIMEOUT_MS } = {}) {
    cmdCounter += 1;
    const id = `cmd_${cmdCounter}`;
    const frame = { t: 'command', id, name, ...fields };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new CommandError('timeout', `${name} (${id}) timed out after ${timeout} ms`));
        const qi = queue.findIndex((q) => q.frame.id === id);
        if (qi >= 0) { queue.splice(qi, 1); reject(new CommandError('offline', `${name} (${id}) could not be sent: offline`)); }
      }, timeout);
      const entry = { resolve, reject, timer, name, frame };
      if (net.open) { pending.set(id, entry); if (!sendRaw(frame)) { pending.delete(id); queue.push(entry); } }
      else {
        if (queue.length >= QUEUE_MAX) { const dropped = queue.shift(); clearTimeout(dropped.timer); dropped.reject(new CommandError('offline', 'command queue overflow')); }
        queue.push(entry);
      }
    });
  }

  function flushQueue() {
    while (queue.length && net.open) {
      const entry = queue.shift();
      pending.set(entry.frame.id, entry);
      if (!sendRaw(entry.frame)) { pending.delete(entry.frame.id); queue.unshift(entry); break; }
    }
  }

  /** Presence is best-effort: ≤ 10 Hz, dropped while offline, acks ignored. */
  function sendPresence(fields) {
    const now = performance.now();
    if (!net.open || now - lastPresenceAt < PRESENCE_MIN_INTERVAL) return false;
    lastPresenceAt = now;
    cmdCounter += 1;
    const frame = { t: 'command', id: `p_${cmdCounter}`, name: 'presence', ...fields };
    return sendRaw(frame);
  }

  return net;
}

export function defaultUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export default { createNet, CommandError, defaultUrl };
