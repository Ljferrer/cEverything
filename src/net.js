// A reconnecting WebSocket to the relay (PIN-9). Every server event arrives
// on `bus` under its `t` name; `send(cmd)` ships a client command. The page's
// `?key=` rides onto the socket URL so the relay can mark this client as an
// editor (PIN-23).
import { isServerEvent } from '../shared/protocol.mjs';

/** Build the relay socket URL from a `location`-like object. */
export function relayUrl(loc = globalThis.location) {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const key = new URLSearchParams(loc.search).get('key');
  return `${scheme}//${loc.host}/relay${key ? `?key=${encodeURIComponent(key)}` : ''}`;
}

export function createNet(bus, { url = relayUrl(), reconnectMs = 1000, WebSocketImpl = globalThis.WebSocket } = {}) {
  let ws = null;
  let closed = false;
  let timer = null;
  const queue = [];

  const net = {
    connected: false,
    send(cmd) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(cmd));
      else queue.push(cmd);
    },
    close() {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    },
  };

  function connect() {
    if (closed) return;
    ws = new WebSocketImpl(url);
    ws.addEventListener('open', () => {
      net.connected = true;
      bus.emit('connected', { url });
      while (queue.length) ws.send(JSON.stringify(queue.shift()));
    });
    ws.addEventListener('message', (e) => {
      let frame;
      try {
        frame = JSON.parse(e.data);
      } catch {
        return;
      }
      if (isServerEvent(frame)) bus.emit(frame.t, frame);
    });
    ws.addEventListener('close', () => {
      net.connected = false;
      bus.emit('disconnected', { url });
      if (!closed) timer = setTimeout(connect, reconnectMs);
    });
    ws.addEventListener('error', () => {});
  }

  connect();
  return net;
}
