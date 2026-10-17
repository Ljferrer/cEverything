// WebSocket hub at /ws (PROTOCOL.md §2): join → hello + snapshot|replay, monotonic seq events, 5000-event ring buffer,
// presence relay (≤ 10 Hz / client, dropped under backpressure), command validation + routing, STT bridging.

import { WebSocketServer, WebSocket } from 'ws';
import { validateCommand } from './protocol.js';
import { applyEvent, snapshot as snapshotState } from './state.js';
import { redact } from './sources/normalize.js';

export const RING_SIZE = 5000;
export const PRESENCE_MIN_INTERVAL_MS = 100; // 10 Hz
export const PRESENCE_BACKPRESSURE_BYTES = 512 * 1024;
export const CLIENT_KILL_BYTES = 16 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export class CommandError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

let clientCounter = 0;
function newClientId() {
  clientCounter += 1;
  return `c_${clientCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * createHub({ server, state, source, stt, log, ringSize, path })
 * source: { kind, info(), start(hub), stop(), handleCommand(cmd, ctx) }  (handleCommand may throw CommandError)
 */
export function createHub(opts) {
  const { server, state } = opts;
  const log = opts.log || (() => {});
  const ringSize = opts.ringSize || RING_SIZE;
  let source = opts.source;
  let stt = opts.stt;
  const clients = new Map(); // clientId → client record
  const ring = [];           // last N events (frames incl. seq)
  let seq = Number(opts.startSeq) || 0;
  // instance epoch (optional field on hello/join): seq restarts at 0 with every server start, so a client that kept its
  // lastSeq across a restart must get a snapshot, not a replay of this instance's unrelated events with higher seqs
  const epoch = typeof opts.epoch === 'string' && opts.epoch ? opts.epoch : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const wss = new WebSocketServer({ server, path: opts.path || '/ws', maxPayload: MAX_FRAME_BYTES, clientTracking: false });

  const hub = {
    get clients() { return clients; },
    get latestSeq() { return seq; },
    get epoch() { return epoch; },
    get ring() { return ring; },
    get source() { return source; },
    get stt() { return stt; },
    setSource(s) { source = s; broadcastSourceInfo(); },
    setSTT(e) { stt = e; },
    emit, broadcast, sendTo, broadcastSourceInfo, close,
    helloFor, snapshotFrame, presenceList,
    clientCount() { return clients.size; },
  };

  // ------------------------------------------------------------------ events
  function emit(ev) {
    if (!ev || typeof ev !== 'object' || !ev.kind) throw new Error('emit: event with kind required');
    seq += 1;
    const frame = { t: 'event', seq, ts: Number.isFinite(ev.ts) ? ev.ts : Date.now(), ...ev };
    frame.t = 'event'; frame.seq = seq;
    applyEvent(state, frame);
    ring.push(frame);
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
    broadcast(frame);
    return frame;
  }

  function serialize(frame) { return typeof frame === 'string' ? frame : JSON.stringify(frame); }

  function sendTo(client, frame) {
    const ws = client.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > CLIENT_KILL_BYTES) { log(`[hub] ${client.id} too far behind (${ws.bufferedAmount} B) — closing`); ws.terminate(); return false; }
    try { ws.send(serialize(frame)); return true; } catch (err) { log(`[hub] send to ${client.id} failed: ${err.message}`); return false; }
  }

  function broadcast(frame, exceptId) {
    const data = serialize(frame);
    for (const c of clients.values()) {
      if (exceptId && c.id === exceptId) continue;
      if (!c.joined) continue;
      sendTo(c, data);
    }
  }

  function sourceInfo() { try { return source?.info?.() || { label: 'UNKNOWN' }; } catch { return { label: 'UNKNOWN' }; } }
  function broadcastSourceInfo() { broadcast({ t: 'source', sourceInfo: sourceInfo() }); }

  function helloFor(client) {
    return {
      t: 'hello', clientId: client.id, serverTime: Date.now(), source: source?.kind || 'fixture',
      sourceInfo: sourceInfo(), voice: { engine: stt?.available ? stt.name : 'none' }, latestSeq: seq, epoch,
    };
  }

  function presenceList(exceptId) {
    const out = [];
    for (const c of clients.values()) if (c.joined && c.id !== exceptId) out.push(presenceOf(c));
    return out;
  }

  function presenceOf(c) {
    return { clientId: c.id, device: c.device, name: c.name, ...(c.presence || {}) };
  }

  function snapshotFrame(exceptId) {
    const snap = snapshotState(state);
    return { t: 'snapshot', seq, ...snap, presence: presenceList(exceptId) };
  }

  // ------------------------------------------------------------------ connections
  wss.on('connection', (ws, req) => {
    const client = {
      id: newClientId(), ws, joined: false, device: 'unknown', name: '', presence: null,
      lastPresenceAt: 0, droppedPresence: 0, utterance: null, utteranceSession: null, isAlive: true,
      remote: req?.socket?.remoteAddress || '', connectedAt: Date.now(),
    };
    clients.set(client.id, client);
    ws.on('pong', () => { client.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { sendTo(client, { t: 'error', inReplyTo: null, code: 'bad_command', message: 'binary frames are not used; send JSON text' }); return; }
      let frame;
      try { frame = JSON.parse(data.toString('utf8')); } catch { sendTo(client, { t: 'error', inReplyTo: null, code: 'bad_command', message: 'invalid JSON' }); return; }
      handleFrame(client, frame).catch((err) => {
        log(`[hub] ${client.id} handler crashed: ${err && err.stack ? err.stack : err}`);
        sendTo(client, { t: 'error', inReplyTo: frame?.id || null, code: 'bad_command', message: 'internal error' });
      });
    });
    ws.on('close', () => onClose(client));
    ws.on('error', (err) => { log(`[hub] ${client.id} socket error: ${err.message}`); });
  });

  wss.on('error', (err) => log(`[hub] server error: ${err.message}`));

  const heartbeat = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.isAlive) { log(`[hub] ${c.id} heartbeat timeout`); try { c.ws.terminate(); } catch { /* ignore */ } continue; }
      c.isAlive = false;
      try { c.ws.ping(); } catch { /* ignore */ }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  function onClose(client) {
    if (!clients.has(client.id)) return;
    clients.delete(client.id);
    stopUtterance(client);
    if (client.joined) broadcast({ t: 'presence.left', clientId: client.id });
    log(`[hub] ${client.id} left (${clients.size} connected)`);
  }

  async function handleFrame(client, frame) {
    if (!frame || typeof frame !== 'object') { sendTo(client, { t: 'error', inReplyTo: null, code: 'bad_command', message: 'frame must be an object' }); return; }
    if (frame.t === 'join') { handleJoin(client, frame); return; }
    if (frame.t === 'ping') { sendTo(client, { t: 'pong', ts: Date.now() }); return; }
    if (frame.t === 'command') {
      if (!client.joined) handleJoin(client, { device: 'unknown', name: '' }); // lenient: implicit join
      await handleCommand(client, frame);
      return;
    }
    sendTo(client, { t: 'error', inReplyTo: frame.id || null, code: 'bad_command', message: `unknown frame type ${JSON.stringify(frame.t)}` });
  }

  function handleJoin(client, frame) {
    client.device = typeof frame.device === 'string' && frame.device ? frame.device : 'unknown';
    client.name = typeof frame.name === 'string' ? frame.name.slice(0, 40) : '';
    const wasJoined = client.joined;
    client.joined = true;
    sendTo(client, helloFor(client));
    const lastSeq = Number.isFinite(frame.lastSeq) ? Math.floor(frame.lastSeq) : null;
    const oldestInRing = ring.length ? ring[0].seq : seq + 1;
    // a join that names an epoch must name ours; one without (older clients, tests) is trusted on seq alone
    const sameEpoch = frame.epoch === undefined || frame.epoch === null || String(frame.epoch) === epoch;
    if (lastSeq !== null && !sameEpoch) log(`[hub] ${client.id} resumed from another server instance (epoch ${frame.epoch}) — sending a snapshot`);
    const canReplay = sameEpoch && lastSeq !== null && lastSeq <= seq && (lastSeq + 1 >= oldestInRing || lastSeq === seq) && (ring.length > 0 || lastSeq === seq);
    if (canReplay) {
      let n = 0;
      for (const ev of ring) if (ev.seq > lastSeq) { sendTo(client, ev); n++; }
      // presence of others after a resume (not in the ring)
      for (const p of presenceList(client.id)) sendTo(client, { t: 'presence', ...p });
      log(`[hub] ${client.id} resumed from seq ${lastSeq} (${n} replayed, ${client.device})`);
    } else {
      sendTo(client, snapshotFrame(client.id));
      log(`[hub] ${client.id} joined (${client.device}${client.name ? ` "${client.name}"` : ''}) snapshot @${seq}`);
    }
    if (!wasJoined) broadcast({ t: 'presence', ...presenceOf(client) }, client.id);
  }

  // ------------------------------------------------------------------ commands
  async function handleCommand(client, cmd) {
    const v = validateCommand(cmd);
    if (!v.ok) { sendTo(client, { t: 'error', inReplyTo: cmd.id || null, code: 'bad_command', message: v.error }); return; }
    const reply = (result) => sendTo(client, result === undefined ? { t: 'ack', inReplyTo: cmd.id, ok: true } : { t: 'ack', inReplyTo: cmd.id, ok: true, result });
    const fail = (code, message) => sendTo(client, { t: 'error', inReplyTo: cmd.id, code, message });
    try {
      switch (cmd.name) {
        case 'presence': {
          const now = Date.now();
          if (now - client.lastPresenceAt < PRESENCE_MIN_INTERVAL_MS) { client.droppedPresence++; reply({ dropped: true }); return; }
          client.lastPresenceAt = now;
          client.presence = {
            head: cmd.head ?? client.presence?.head ?? undefined,
            hands: cmd.hands ?? client.presence?.hands ?? undefined,
            gazeSessionId: cmd.gazeSessionId === undefined ? (client.presence?.gazeSessionId ?? null) : cmd.gazeSessionId,
            hover: cmd.hover === undefined ? (client.presence?.hover ?? null) : cmd.hover,
            ray: cmd.ray === undefined ? (client.presence?.ray ?? null) : cmd.ray,
          };
          const frame = JSON.stringify({ t: 'presence', ...presenceOf(client) });
          for (const c of clients.values()) {
            if (c.id === client.id || !c.joined) continue;
            if (c.ws.bufferedAmount > PRESENCE_BACKPRESSURE_BYTES) { c.droppedPresence++; continue; } // drop under backpressure
            sendTo(c, frame);
          }
          reply();
          return;
        }
        case 'layout.move': {
          if (!state.sessions[cmd.sessionId]) { fail('unknown_session', `no session ${cmd.sessionId}`); return; }
          const ev = emit({ sessionId: cmd.sessionId, kind: 'layout.column', placement: { sessionId: cmd.sessionId, x: cmd.x, z: cmd.z, rot: cmd.rot }, by: client.id });
          reply({ seq: ev.seq });
          return;
        }
        case 'voice.text': {
          broadcast({ t: 'transcript', clientId: client.id, sessionId: cmd.sessionId, text: redact(String(cmd.text)), final: Boolean(cmd.final) });
          reply();
          return;
        }
        case 'audio.start': {
          if (!state.sessions[cmd.sessionId]) { fail('unknown_session', `no session ${cmd.sessionId}`); return; }
          startUtterance(client, cmd.sessionId);
          reply({ engine: stt?.available ? stt.name : 'none' });
          return;
        }
        case 'audio.chunk': {
          if (!client.utterance) { fail('bad_command', 'audio.chunk before audio.start'); return; }
          let buf;
          try { buf = Buffer.from(cmd.data, 'base64'); } catch { fail('bad_command', 'audio.chunk: data must be base64'); return; }
          client.utterance.push(buf);
          reply();
          return;
        }
        case 'audio.stop': {
          if (client.utterance) client.utterance.stop();
          reply();
          return;
        }
        case 'fixture.control': {
          if (!source || source.kind !== 'fixture') { fail('not_supported', 'fixture.control is only available in fixture mode'); return; }
          const result = await source.handleCommand(cmd, { clientId: client.id, hub });
          reply(result);
          return;
        }
        default: {
          if (!source || typeof source.handleCommand !== 'function') { fail('source_unavailable', 'no active source'); return; }
          const result = await source.handleCommand(cmd, { clientId: client.id, hub });
          reply(result);
        }
      }
    } catch (err) {
      const code = err && typeof err.code === 'string' && ['bad_command', 'unknown_session', 'source_unavailable', 'not_supported'].includes(err.code) ? err.code : 'source_unavailable';
      if (!(err instanceof CommandError)) log(`[hub] command ${cmd.name} failed: ${err && err.stack ? err.stack : err}`);
      fail(code, err?.message || String(err));
    }
  }

  // ------------------------------------------------------------------ voice
  function startUtterance(client, sessionId) {
    stopUtterance(client);
    client.utteranceSession = sessionId;
    if (!stt) { sendTo(client, { t: 'voice.unavailable', reason: 'no STT engine' }); return; }
    client.utterance = stt.createUtterance({
      clientId: client.id, sessionId,
      onTranscript: (text, final) => broadcast({ t: 'transcript', clientId: client.id, sessionId, text: redact(String(text || '')), final: Boolean(final) }),
      onUnavailable: (reason) => sendTo(client, { t: 'voice.unavailable', reason: String(reason || 'voice unavailable') }),
      onError: (err) => sendTo(client, { t: 'voice.unavailable', reason: `stt error: ${err?.message || err}` }),
      onDone: () => { if (client.utterance) { client.utterance = null; } },
    });
  }

  function stopUtterance(client) {
    if (client.utterance) { try { client.utterance.close(); } catch { /* ignore */ } client.utterance = null; }
  }

  function close() {
    clearInterval(heartbeat);
    for (const c of clients.values()) { stopUtterance(c); try { c.ws.close(1001, 'server shutdown'); } catch { /* ignore */ } }
    clients.clear();
    return new Promise((resolve) => wss.close(() => resolve()));
  }

  return hub;
}

export default { createHub, CommandError, RING_SIZE };
