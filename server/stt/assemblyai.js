// AssemblyAI Streaming v3 engine: one upstream realtime WebSocket per talking client.
// wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&format_turns=true, header Authorization: <key>.
// Raw PCM16 LE mono binary frames in; JSON Turn messages {transcript, end_of_turn, turn_is_formatted} out.
// v3 ends a Turn at every pause while the mic is still held, so completed turns are ACCUMULATED: partials carry
// "<finished turns> <current turn>" and the single final transcript (all turns joined) is emitted once the client
// stopped the utterance (Termination / final-wait timeout) or the socket fails.
// Untestable against the real endpoint without a key: written defensively (buffers until open, times out, never throws
// into the hub); test/stt.test.mjs drives it against a mock v3 server.

import { WebSocket } from 'ws';

export const DEFAULT_URL = 'wss://streaming.assemblyai.com/v3/ws';
const OPEN_TIMEOUT_MS = 8000;
const FINAL_WAIT_MS = 3000;
const MAX_BUFFERED_BYTES = 16000 * 2 * 20; // 20 s of audio while waiting for the socket

export function buildUrl(base = DEFAULT_URL, { sampleRate = 16000, formatTurns = true } = {}) {
  const u = new URL(base);
  u.searchParams.set('sample_rate', String(sampleRate));
  u.searchParams.set('format_turns', formatTurns ? 'true' : 'false');
  u.searchParams.set('encoding', 'pcm_s16le');
  return u.toString();
}

export function createAssemblyAIEngine(opts = {}) {
  const apiKey = opts.apiKey;
  const log = opts.log || (() => {});
  const url = buildUrl(opts.url || DEFAULT_URL, { sampleRate: opts.sampleRate || 16000, formatTurns: opts.formatTurns !== false });
  const formatTurns = opts.formatTurns !== false;
  if (!apiKey) throw new Error('createAssemblyAIEngine: apiKey required');

  return {
    name: 'assemblyai',
    available: true,
    url,
    /**
     * createUtterance({ clientId, sessionId, onTranscript(text, final), onError(err), onDone() })
     * → { push(buffer), stop(), close() }
     */
    createUtterance(handlers = {}) {
      const label = `[stt ${handlers.clientId || '?'}→${handlers.sessionId || '?'}]`;
      let ws = null;
      let open = false;
      let closed = false;
      let stopped = false;
      const finals = [];      // completed turns (end_of_turn, formatted when format_turns is on), in order
      let current = '';       // the turn still being spoken
      let finalSent = false;
      let buffered = [];
      let bufferedBytes = 0;
      let finalTimer = null;
      let openTimer = null;
      const joined = () => [...finals, current].filter((s) => s && s.trim()).join(' ').replace(/\s+/g, ' ').trim();
      const emit = (text, final) => {
        if (closed && !final) return;
        if (final) { if (finalSent) return; finalSent = true; }
        try { handlers.onTranscript?.(text, final); } catch (err) { log(label, 'onTranscript threw', err.message); }
      };
      const fail = (err) => {
        if (closed) return;
        log(label, 'error:', err?.message || err);
        try { handlers.onError?.(err); } catch { /* ignore */ }
        finish();
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        clearTimeout(finalTimer); clearTimeout(openTimer);
        const all = joined();
        if (!finalSent && all) emit(all, true); // the one final transcript: every turn of the utterance
        try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'done'); else if (ws) ws.terminate?.(); } catch { /* ignore */ }
        ws = null;
        try { handlers.onDone?.(); } catch { /* ignore */ }
      };

      try {
        ws = new WebSocket(url, { headers: { Authorization: apiKey }, handshakeTimeout: OPEN_TIMEOUT_MS });
      } catch (err) {
        queueMicrotask(() => fail(err));
        return { push() {}, stop() { finish(); }, close() { finish(); } };
      }
      openTimer = setTimeout(() => { if (!open) fail(new Error('AssemblyAI socket open timeout')); }, OPEN_TIMEOUT_MS);
      ws.on('open', () => {
        open = true;
        clearTimeout(openTimer);
        for (const chunk of buffered) { try { ws.send(chunk); } catch (err) { fail(err); return; } }
        buffered = []; bufferedBytes = 0;
        if (stopped) sendTerminate();
      });
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'Begin': break;
          case 'Turn': {
            const text = typeof msg.transcript === 'string' ? msg.transcript : '';
            if (!text.trim()) break;
            // with format_turns the raw end_of_turn (turn_is_formatted:false) is followed by the formatted copy: wait for it
            const turnDone = Boolean(msg.end_of_turn) && (!formatTurns || Boolean(msg.turn_is_formatted));
            if (turnDone) { finals.push(text.trim()); current = ''; } else current = text;
            if (!finalSent) emit(joined(), false); // partials always show everything said so far
            break;
          }
          case 'Termination': finish(); break;
          case 'Error': fail(new Error(msg.error || msg.message || 'AssemblyAI error')); break;
          default:
            if (msg.error) fail(new Error(String(msg.error)));
        }
      });
      ws.on('error', (err) => fail(err));
      ws.on('close', (code, reason) => {
        if (!closed) {
          if (code !== 1000 && code !== 1005) log(label, `upstream closed ${code} ${reason ? reason.toString() : ''}`.trim());
          finish();
        }
      });

      function sendTerminate() {
        try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'Terminate' })); } catch (err) { fail(err); return; }
        clearTimeout(finalTimer);
        finalTimer = setTimeout(finish, FINAL_WAIT_MS);
      }

      return {
        push(buf) {
          if (closed || stopped || !buf) return;
          const chunk = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
          if (chunk.length === 0) return;
          if (open && ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(chunk); } catch (err) { fail(err); }
          } else {
            if (bufferedBytes + chunk.length > MAX_BUFFERED_BYTES) return; // drop while waiting
            buffered.push(chunk); bufferedBytes += chunk.length;
          }
        },
        stop() {
          if (closed || stopped) return;
          stopped = true;
          if (open) sendTerminate();
          else finalTimer = setTimeout(finish, OPEN_TIMEOUT_MS); // never connected: give up soon
        },
        close() { finish(); },
      };
    },
    close() { /* per-utterance sockets close themselves */ },
  };
}

export default { createAssemblyAIEngine, buildUrl, DEFAULT_URL };
