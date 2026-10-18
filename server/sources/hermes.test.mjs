// hermes.mjs against a fake Hermes gateway: a `ws` server on an ephemeral port
// per case that greets with `gateway.ready` and answers JSON-RPC requests. Its
// `event` helper sends the verified Hermes envelope
// `{jsonrpc:'2.0', method:'event', params:{type, session_id, seq, payload}}`
// with `session_id` on the envelope only, so the mapping cases prove the
// envelope is unwrapped. Each case is named for the plan 2 End state it proves.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { isServerEvent } from '../../shared/protocol.mjs';
import * as hermes from './hermes.mjs';

const started = [];
const gateways = [];
after(async () => {
  for (const s of started) await s.stop?.();
  for (const g of gateways) await g.close();
});

/**
 * A fake gateway. `sessions` answers `session.active_list`; `history` answers
 * `session.history`; `onRequest(msg, g)` may return `{result}` or `{error}` to
 * override any reply, or `false` to send none.
 */
async function gateway({ sessions = [], history = () => ({ messages: [] }), onRequest = () => undefined } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const g = {
    port: wss.address().port,
    requests: [],
    upgrade: null,
    socket: null,
    sessions,
    waiters: [],
    /** While true, a new connection gets no `gateway.ready` until `releaseReady()`. */
    holdReady: false,
    held: [],
    env() {
      return { HERMES_WS_URL: `ws://127.0.0.1:${this.port}/api/ws`, HERMES_DASHBOARD_SESSION_TOKEN: 'devtoken' };
    },
    seq: 0,
    send(obj) {
      this.socket.send(JSON.stringify(obj));
    },
    /** One event in the verified envelope; `session_id` rides the envelope, not the payload. */
    event(type, params) {
      const { session_id, ...payload } = params;
      this.seq += 1;
      this.send({ jsonrpc: '2.0', method: 'event', params: { type, session_id, seq: this.seq, payload } });
    },
    /** The pre-envelope bare notification `{method:<type>, params}`, kept as a read fallback. */
    bareEvent(type, params) {
      this.send({ jsonrpc: '2.0', method: type, params });
    },
    calls(method) {
      return this.requests.filter((r) => r.method === method);
    },
    /** Send `gateway.ready` on every connection `holdReady` held back. */
    releaseReady() {
      for (const ws of this.held.splice(0)) {
        this.socket = ws;
        this.event('gateway.ready', { version: 'fake' });
      }
    },
    /** Resolve once a request with `method` has arrived `n` times. */
    received(method, n = 1, ms = 5000) {
      return new Promise((resolve, reject) => {
        const check = () => this.calls(method).length >= n;
        if (check()) return resolve();
        const t = setTimeout(() => reject(new Error(`no ${method} x${n}; got ${JSON.stringify(this.requests.map((r) => r.method))}`)), ms);
        this.waiters.push({ check, resolve: () => (clearTimeout(t), resolve()) });
      });
    },
    close: () => new Promise((resolve) => wss.close(resolve)),
  };
  wss.on('connection', (ws, req) => {
    g.socket = ws;
    g.upgrade = { url: req.url, origin: req.headers.origin };
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      g.requests.push(msg);
      for (const w of [...g.waiters]) if (w.check()) {
        g.waiters.splice(g.waiters.indexOf(w), 1);
        w.resolve();
      }
      if (msg.id === undefined || !msg.method) return;
      const custom = onRequest(msg, g);
      if (custom === false) return;
      let reply = custom;
      if (reply === undefined) {
        if (msg.method === 'session.active_list') reply = { result: { sessions: g.sessions } };
        else if (msg.method === 'session.history') reply = { result: history(msg.params) };
        else reply = { result: {} };
      }
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }));
    });
    if (g.holdReady) g.held.push(ws);
    else g.event('gateway.ready', { version: 'fake' });
  });
  gateways.push(g);
  return g;
}

function collector() {
  const frames = [];
  const waiters = [];
  const emit = (f) => {
    frames.push(f);
    for (const w of [...waiters]) if (w.pred(frames)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(frames);
    }
  };
  const until = (pred, ms = 5000) =>
    new Promise((resolve, reject) => {
      if (pred(frames)) return resolve(frames);
      const t = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(frames)}`)), ms);
      waiters.push({ pred, resolve: (v) => (clearTimeout(t), resolve(v)) });
    });
  return { frames, emit, until };
}

async function startAgainst(g, { argv = [], env = {} } = {}) {
  const c = collector();
  const handle = await hermes.start({ emit: c.emit, argv, env: { ...g.env(), ...env } });
  started.push(handle);
  return { ...c, handle };
}

const session = (session_id, status, extra = {}) => ({ session_id, title: session_id.toUpperCase(), status, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('ES1 handshake, six-status attach, error event, tool and message mapping, export shapes', async () => {
  const sids = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const statuses = ['idle', 'starting', 'waiting', 'working', 'streaming', 'resuming'];
  const g = await gateway({
    sessions: sids.map((sid, i) => session(sid, statuses[i])),
    onRequest(msg, gw) {
      if (msg.method === 'prompt.submit') {
        gw.event('message.complete', { session_id: msg.params.session_id, role: 'user', content: msg.params.text });
        return { result: {} };
      }
      return undefined;
    },
  });
  const { frames, until, handle } = await startAgainst(g);

  assert.equal(typeof handle.stop, 'function');
  assert.equal(typeof hermes.sendCommand, 'function');
  assert.equal(typeof hermes.titleOf, 'function');
  assert.equal(typeof hermes.slabText, 'function');

  const url = new URL(g.upgrade.url, 'ws://x');
  assert.equal(url.searchParams.get('token'), 'devtoken');
  assert.ok(typeof g.upgrade.origin === 'string' && g.upgrade.origin.startsWith('http://'), 'an Origin header is sent');
  const caps = g.calls('client.capabilities');
  assert.equal(caps.length, 1);
  assert.deepEqual(caps[0].params, { server_requests: true });
  assert.deepEqual(
    g.calls('session.resume').map((r) => r.params),
    sids.map((sid) => ({ session_id: sid, omit_messages: false, close_on_disconnect: false })),
  );

  g.event('tool.start', { session_id: 's1', tool_id: 'tool-1', name: 'web_search', args: { q: 'bun ws' } });
  g.event('message.complete', { session_id: 's1', role: 'assistant', message_id: 'm1', content: 'Here is the answer.' });
  g.event('message.complete', { session_id: 's1', role: 'user', content: 'fresh' });
  g.event('error', { session_id: 's2', message: 'boom' });
  await until((f) => f.some((x) => x.t === 'state' && x.sid === 's2' && x.status === 'error'));

  await hermes.sendCommand('prompt.submit', { session_id: 's1', text: 'typed' });
  await sleep(50);

  const sessions = frames.filter((f) => f.t === 'session');
  assert.deepEqual(sessions.map((f) => f.sid), sids, 'exactly one session frame per attached sid');
  assert.ok(sessions.every((f) => f.harness === 'hermes'));
  assert.ok(sessions.every((f) => !('phase' in f) && !('parent' in f)), 'absent optional fields are omitted');
  const states = frames.filter((f) => f.t === 'state' && f.status !== 'error');
  assert.deepEqual(
    states.map((f) => [f.sid, f.status]),
    [['s1', 'idle'], ['s2', 'working'], ['s3', 'waiting'], ['s4', 'working'], ['s5', 'streaming'], ['s6', 'working']],
  );
  assert.deepEqual(frames.filter((f) => f.t === 'state' && f.status === 'error'), [{ t: 'state', sid: 's2', status: 'error' }]);
  const tools = frames.filter((f) => f.t === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].phase, 'start');
  assert.equal(tools[0].sid, 's1');
  assert.equal(tools[0].id, 'tool-1');
  assert.equal(tools[0].name, 'web_search');
  const assistant = frames.filter((f) => f.t === 'slab' && f.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].text, 'Here is the answer.');
  const user = frames.filter((f) => f.t === 'slab' && f.role === 'user');
  assert.equal(user.length, 1);
  assert.equal(user[0].text, 'fresh');
  assert.ok(!frames.some((f) => f.t === 'slab' && f.text === 'typed'), 'the say echo within 3 s emits no slab');
  assert.ok(frames.length > 0);
  for (const f of frames) assert.ok(isServerEvent(f), `invalid frame ${JSON.stringify(f)}`);
  assert.equal(hermes.titleOf('s1'), 'S1');
  assert.equal(hermes.slabText('s1', 'm1'), 'Here is the answer.');
});

test('ES2 --seed 2 creates Seed 1 and Seed 2 and submits one scripted prompt each', async () => {
  let n = 0;
  const g = await gateway({
    onRequest(msg) {
      if (msg.method === 'session.create') {
        n += 1;
        return { result: { session_id: `s${n}`, title: msg.params.title } };
      }
      return undefined;
    },
  });
  await startAgainst(g, { argv: ['--seed', '2'] });
  await g.received('prompt.submit', 2);
  assert.deepEqual(g.calls('session.create').map((r) => r.params.title), ['Seed 1', 'Seed 2']);
  const submits = g.calls('prompt.submit').map((r) => r.params);
  assert.deepEqual(submits.map((p) => p.session_id), ['s1', 's2']);
  assert.equal(submits.length, 2);
  assert.ok(submits.every((p) => hermes.SEED_PROMPTS.includes(p.text)), 'each text is a member of the scripted list');
  assert.notEqual(submits[0].text, submits[1].text, 'two distinct prompts');
  assert.equal(hermes.SEED_PROMPTS.length, 3);
});

test('ES9 session.branch reaches the gateway and its reply attaches the sibling without a re-list', async () => {
  const g = await gateway({
    sessions: [session('s1', 'idle')],
    onRequest(msg) {
      if (msg.method === 'session.branch') return { result: { session_id: 's2', title: 'S1 fork', parent: 's1' } };
      return undefined;
    },
  });
  const { frames, until } = await startAgainst(g);
  assert.equal(g.calls('session.active_list').length, 1);
  await hermes.sendCommand('session.branch', { session_id: 's1', name: 'S1 fork' });
  const branch = g.calls('session.branch');
  assert.equal(branch.length, 1);
  assert.deepEqual([branch[0].method, branch[0].params], ['session.branch', { session_id: 's1', name: 'S1 fork' }]);
  await until((f) => f.some((x) => x.t === 'session' && x.sid === 's2'));
  const sibling = frames.find((f) => f.t === 'session' && f.sid === 's2');
  assert.ok(isServerEvent(sibling));
  const { status, ...rest } = sibling;
  assert.deepEqual(rest, { t: 'session', sid: 's2', parent: 's1', harness: 'hermes', title: 'S1 fork', kind: 'chat' });
  assert.equal(typeof status, 'string');
  assert.equal(g.calls('session.active_list').length, 1, 'no second active_list');
  assert.equal(frames.filter((f) => f.t === 'session').length, 2);
});

test('a v0.22.2 list entry ({id, session_key}) attaches by id and resumes by session_key; a refused resume still announces the session', async () => {
  const g = await gateway({
    sessions: [
      { id: 'a1', session_key: '20261017_170415_a2330b', title: 'Live', status: 'working' },
      { id: 'lazy', session_key: '20261017_170700_6ef76e', title: 'Lazy', status: 'idle' },
    ],
    onRequest(msg) {
      if (msg.method === 'session.resume' && msg.params.session_id !== '20261017_170415_a2330b') {
        return { error: { code: 4007, message: 'session not found' } };
      }
      return undefined;
    },
  });
  const { frames } = await startAgainst(g);
  assert.deepEqual(g.calls('session.resume').map((r) => r.params.session_id), ['20261017_170415_a2330b', '20261017_170700_6ef76e']);
  const sessionFrames = frames.filter((f) => f.t === 'session');
  assert.deepEqual(sessionFrames.map((f) => [f.sid, f.title, f.status]), [['a1', 'Live', 'working'], ['lazy', 'Lazy', 'idle']]);
  assert.ok(sessionFrames.every(isServerEvent));
  assert.ok(!frames.some((f) => f.t === 'state' && f.status === 'error'), 'a refused resume is not an error state');
});

test('ES12 sessions.changed re-lists and upserts; a known sid never re-emits a session frame', async () => {
  const g = await gateway({ sessions: [session('s1', 'idle'), session('s2', 'working')] });
  const { frames, until } = await startAgainst(g);
  assert.deepEqual(frames.filter((f) => f.t === 'session').map((f) => f.sid), ['s1', 's2']);
  g.sessions = [session('s1', 'idle'), session('s2', 'working'), session('s3', 'waiting')];
  g.event('sessions.changed', {});
  await until((f) => f.some((x) => x.t === 'session' && x.sid === 's3'));
  g.event('sessions.changed', {});
  await g.received('session.active_list', 3);
  await sleep(50);
  const sessions = frames.filter((f) => f.t === 'session');
  assert.deepEqual(sessions.map((f) => f.sid), ['s1', 's2', 's3']);
  assert.ok(sessions.every((f) => f.harness === 'hermes' && isServerEvent(f)));
  assert.equal(g.calls('session.resume').length, 3, 'resume once per sid');
});

test('ES13 no listener on the configured port: start rejects within the connect timeout and leaves nothing open', async () => {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  const t0 = Date.now();
  await assert.rejects(
    hermes.start({ emit: () => {}, argv: [], env: { HERMES_WS_URL: `ws://127.0.0.1:${port}/api/ws`, HERMES_DASHBOARD_SESSION_TOKEN: 'devtoken' } }),
  );
  assert.ok(Date.now() - t0 < 3000, 'rejected within HERMES_CONNECT_TIMEOUT_MS');
});

test('ES13b gateway.ready never arrives: start rejects at the connect timeout', async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  gateways.push({ close: () => new Promise((resolve) => wss.close(resolve)) });
  const t0 = Date.now();
  await assert.rejects(
    hermes.start({
      emit: () => {},
      argv: [],
      env: { HERMES_WS_URL: `ws://127.0.0.1:${wss.address().port}/api/ws`, HERMES_CONNECT_TIMEOUT_MS: '200' },
    }),
    /gateway\.ready/,
  );
  const took = Date.now() - t0;
  assert.ok(took >= 150 && took < 2000, `took ${took} ms`);
});

test('ES13c gateway.ready arrives but session.active_list never answers: start rejects at the handshake timeout and closes the socket (#36)', async () => {
  const g = await gateway({ onRequest: (msg) => (msg.method === 'session.active_list' ? false : undefined) });
  gateways.push(g);
  const t0 = Date.now();
  await assert.rejects(
    hermes.start({ emit: () => {}, argv: [], env: { ...g.env(), HERMES_HANDSHAKE_TIMEOUT_MS: '300' } }),
    /no handshake reply within 300 ms/,
  );
  const took = Date.now() - t0;
  assert.ok(took >= 250 && took < 2000, `took ${took} ms`);
  assert.equal(g.calls('session.active_list').length, 1);
  await new Promise((resolve) => (g.socket.readyState === g.socket.CLOSED ? resolve() : g.socket.once('close', resolve)));
});

test('ES14 session.history seeds one user and one assistant slab and drops the tool-role message', async () => {
  const g = await gateway({
    sessions: [session('s1', 'idle')],
    history: () => ({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
        { role: 'tool', content: 'x' },
      ],
    }),
  });
  const { frames } = await startAgainst(g);
  const slabs = frames.filter((f) => f.t === 'slab');
  assert.deepEqual(slabs.map((s) => [s.role, s.text]), [['user', 'q'], ['assistant', 'a']]);
  assert.ok(slabs.every((s) => s.sid === 's1' && isServerEvent(s)));
  assert.equal(hermes.slabText('s1', slabs[1].id), 'a');
  const sessionAt = frames.findIndex((f) => f.t === 'session' && f.sid === 's1');
  const firstSlabAt = frames.findIndex((f) => f.t === 'slab');
  const stateAt = frames.findIndex((f) => f.t === 'state' && f.sid === 's1');
  assert.ok(sessionAt >= 0 && sessionAt < firstSlabAt, 'the session frame precedes the seeded slabs');
  assert.ok(stateAt > frames.findLastIndex((f) => f.t === 'slab'), 'the state frame follows the seeded slabs');
});

test('a bare gateway.ready and bare events are read as a fallback to the envelope', async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  gateways.push({ close: () => new Promise((resolve) => wss.close(resolve)) });
  let socket = null;
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id === undefined || !msg.method) return;
      const result = msg.method === 'session.active_list' ? { sessions: [session('s1', 'idle')] } : msg.method === 'session.history' ? { messages: [] } : {};
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'gateway.ready', params: { version: 'bare' } }));
  });
  const c = collector();
  const handle = await hermes.start({
    emit: c.emit,
    argv: [],
    env: { HERMES_WS_URL: `ws://127.0.0.1:${wss.address().port}/api/ws`, HERMES_CONNECT_TIMEOUT_MS: '500' },
  });
  started.push(handle);
  socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'message.complete', params: { session_id: 's1', role: 'assistant', message_id: 'b1', content: 'bare' } }));
  socket.send(JSON.stringify({ event: 'error', payload: { session_id: 's1' } }));
  await c.until((f) => f.some((x) => x.t === 'state' && x.status === 'error'));
  assert.deepEqual(c.frames.filter((f) => f.t === 'slab').map((f) => [f.id, f.text]), [['b1', 'bare']]);
});

test('an envelope whose payload carries no session_id maps by the envelope session_id; a session_id-less envelope emits nothing', async () => {
  const g = await gateway({ sessions: [session('s1', 'idle')] });
  const { frames, until } = await startAgainst(g);
  g.send({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', seq: 1, payload: { role: 'assistant', message_id: 'x', content: 'no sid' } } });
  g.send({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', session_id: 's1', seq: 2, payload: { role: 'assistant', message_id: 'e1', content: 'enveloped' } } });
  await until((f) => f.some((x) => x.id === 'e1'));
  assert.deepEqual(frames.filter((f) => f.t === 'slab').map((f) => [f.sid, f.id, f.text]), [['s1', 'e1', 'enveloped']]);
});

test('ES15 a request from the gateway is answered with -32601 and emits nothing', async () => {
  const g = await gateway({ sessions: [session('s1', 'idle')] });
  const { frames } = await startAgainst(g);
  const before = frames.length;
  const reply = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no reply to id 99')), 2000);
    g.socket.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id === 99) {
        clearTimeout(t);
        resolve(msg);
      }
    });
  });
  g.send({ jsonrpc: '2.0', id: 99, method: 'approval.request', params: {} });
  const msg = await reply;
  assert.equal(msg.jsonrpc, '2.0');
  assert.equal(msg.id, 99);
  assert.equal(msg.error?.code, -32601);
  await sleep(20);
  assert.equal(frames.length, before, 'no frame for the request');
});

test('message.start, delta and complete stream one assistant slab; thinking and tool ids map the same way', async () => {
  const g = await gateway({ sessions: [session('s1', 'working')] });
  const { frames, until } = await startAgainst(g);
  g.event('message.start', { session_id: 's1', role: 'assistant', message_id: 'm1' });
  g.event('message.delta', { session_id: 's1', role: 'assistant', message_id: 'm1', delta: 'Hel' });
  g.event('message.delta', { session_id: 's1', role: 'assistant', message_id: 'm1', delta: 'lo' });
  g.event('message.complete', { session_id: 's1', role: 'assistant', message_id: 'm1', content: 'Hello!' });
  g.event('reasoning.delta', { session_id: 's1', delta: 'hmm' });
  g.event('tool.start', { session_id: 's1', name: 'terminal', args: { cmd: 'ls' } });
  g.bareEvent('tool.complete', { session_id: 's1', name: 'terminal', summary: '3 files', inline_diff: '+a' });
  await until((f) => f.some((x) => x.t === 'tool' && x.phase === 'complete'));
  const forM1 = frames.filter((f) => f.id === 'm1');
  assert.deepEqual(forM1.map((f) => [f.t, f.text]), [['slab', ''], ['delta', 'Hel'], ['delta', 'lo'], ['delta', '!']]);
  assert.equal(forM1[0].role, 'assistant');
  assert.equal(hermes.slabText('s1', 'm1'), 'Hello!');
  const thinking = frames.filter((f) => f.role === 'thinking');
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0].t, 'slab');
  assert.equal(thinking[0].text, 'hmm');
  const tools = frames.filter((f) => f.t === 'tool');
  assert.equal(tools.length, 2);
  assert.equal(tools[0].id, tools[1].id, 'the fallback tool id carries from start to complete');
  assert.match(tools[0].id, /^s1:tool:\d+$/);
  assert.deepEqual(tools[1], { t: 'tool', sid: 's1', id: tools[0].id, name: 'terminal', phase: 'complete', summary: '3 files', diff: '+a' });
  assert.equal(frames.find((f) => f.t === 'slab' && f.role === 'tool').text, 'terminal {"cmd":"ls"}');
  for (const f of frames) assert.ok(isServerEvent(f), `invalid frame ${JSON.stringify(f)}`);
});

test('after the first attach a socket close retries in the background and re-attaches without a second session frame', async () => {
  const g = await gateway({ sessions: [session('s1', 'idle')] });
  const { frames } = await startAgainst(g, { env: { HERMES_RETRY_MS: '100' } });
  const firstSocket = g.socket;
  firstSocket.close();
  await g.received('session.active_list', 2, 3000);
  await g.received('session.resume', 2, 3000);
  await sleep(50);
  assert.notEqual(g.socket, firstSocket, 'a new socket connected');
  assert.equal(g.calls('client.capabilities').length, 2);
  assert.deepEqual(frames.filter((f) => f.t === 'session').map((f) => f.sid), ['s1'], 'no second session frame');
  assert.equal(hermes.titleOf('s1'), 'S1');
});

test('stop() closes the socket and schedules no retry', async () => {
  const g = await gateway({ sessions: [session('s1', 'idle')] });
  const { handle } = await startAgainst(g, { env: { HERMES_RETRY_MS: '50' } });
  const closed = new Promise((resolve) => g.socket.once('close', resolve));
  await handle.stop();
  await closed;
  await sleep(200);
  assert.equal(g.calls('session.active_list').length, 1, 'no reconnect after stop');
});

test('an error state is recorded, so a later same-status update emits the recovered state', async () => {
  const g = await gateway({ sessions: [session('s1', 'idle')] });
  const { frames, until } = await startAgainst(g);
  g.event('error', { session_id: 's1', message: 'boom' });
  await until((fs) => fs.some((f) => f.t === 'state' && f.status === 'error'));
  g.event('session.status', { session_id: 's1', status: 'idle' });
  await until((fs) => fs.filter((f) => f.t === 'state').length === 3);
  assert.deepEqual(frames.filter((f) => f.t === 'state').map((f) => f.status), ['idle', 'error', 'idle']);
});

test('a retry whose handshake fails without a close drops that socket before the next retry', async () => {
  const sockets = new Set();
  let lists = 0;
  const g = await gateway({
    sessions: [session('s1', 'idle')],
    onRequest(msg, gw) {
      sockets.add(gw.socket);
      if (msg.method === 'session.active_list') {
        lists += 1;
        if (lists === 2) return { error: { code: -32000, message: 'listing failed' } };
      }
      return undefined;
    },
  });
  const { frames, until } = await startAgainst(g, { env: { HERMES_RETRY_MS: '50' } });
  const first = g.socket;
  first.close();
  await g.received('session.active_list', 3, 3000);
  await g.received('client.capabilities', 3, 3000);
  await sleep(100);
  const [, second, third] = [...sockets];
  assert.equal(sockets.size, 3, 'three connections');
  assert.notEqual(third, second);
  assert.equal(second.readyState, second.CLOSED, 'the socket of the failed handshake is closed');
  const slabsBefore = frames.filter((f) => f.t === 'slab').length;
  g.event('message.complete', { session_id: 's1', role: 'user', message_id: 'm9', content: 'once' });
  await until((fs) => fs.filter((f) => f.t === 'slab').length > slabsBefore);
  await sleep(50);
  assert.equal(frames.filter((f) => f.t === 'slab' && f.id === 'm9').length, 1, 'the live socket is processed once');
});

test('a sid resumed on a socket whose handshake then fails is resumed again on the next socket', async () => {
  let lists = 0;
  let heldList = null;
  const g = await gateway({
    sessions: [session('s1', 'idle')],
    onRequest(msg, gw) {
      if (msg.method === 'session.active_list') {
        lists += 1;
        if (lists !== 2) return undefined;
        // The retry socket learns of s1 (and resumes it) before its listing fails.
        heldList = msg.id;
        gw.event('session.status', { session_id: 's1', status: 'idle' });
        return false;
      }
      if (msg.method === 'session.resume' && heldList !== null) {
        const id = heldList;
        heldList = null;
        setImmediate(() => gw.send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'listing failed' } }));
      }
      return undefined;
    },
  });
  await startAgainst(g, { env: { HERMES_RETRY_MS: '50' } });
  g.socket.close();
  await g.received('session.active_list', 3, 3000);
  await g.received('session.resume', 3, 3000);
  assert.deepEqual(g.calls('session.resume').map((r) => r.params.session_id), ['s1', 's1', 's1'], 'every socket resumes s1');
});

test('a retry whose connect fails after a new start leaves the new run\'s socket streaming', async () => {
  const g1 = await gateway({ sessions: [session('s1', 'idle')] });
  await startAgainst(g1, { env: { HERMES_RETRY_MS: '50', HERMES_CONNECT_TIMEOUT_MS: '300' } });
  g1.holdReady = true;
  g1.socket.close();
  await sleep(100);
  assert.equal(g1.held.length, 1, 'the retry is connecting while gateway.ready is held');
  const g2 = await gateway({ sessions: [session('s2', 'idle')] });
  const { frames, until } = await startAgainst(g2);
  const live = g2.socket;
  await new Promise((resolve) => g1.held[0].once('close', resolve));
  await sleep(50);
  assert.equal(live.readyState, live.OPEN, 'the new run\'s socket survives the stale retry\'s failure');
  g2.event('message.complete', { session_id: 's2', role: 'user', message_id: 'm2', content: 'still here' });
  await until((fs) => fs.some((f) => f.t === 'slab' && f.id === 'm2'));
  assert.equal(frames.filter((f) => f.t === 'slab' && f.id === 'm2').length, 1);
});

test('a retry whose connect succeeds after a new start closes that late socket and never handshakes on it', async () => {
  const g1 = await gateway({ sessions: [session('s1', 'idle')] });
  await startAgainst(g1, { env: { HERMES_RETRY_MS: '50' } });
  g1.holdReady = true;
  g1.socket.close();
  await sleep(100);
  assert.equal(g1.held.length, 1, 'the retry is connecting while gateway.ready is held');
  const g2 = await gateway({ sessions: [session('s2', 'idle')] });
  const { frames, until } = await startAgainst(g2);
  const live = g2.socket;
  const late = g1.held[0];
  const closed = new Promise((resolve) => late.once('close', () => resolve('closed')));
  g1.releaseReady();
  assert.equal(await Promise.race([closed, sleep(1000).then(() => 'open')]), 'closed', 'the late socket is closed');
  await sleep(50);
  assert.equal(g1.calls('client.capabilities').length, 1, 'no handshake on the late socket');
  assert.equal(live.readyState, live.OPEN, 'the new run\'s socket is still the live one');
  g2.event('message.complete', { session_id: 's2', role: 'user', message_id: 'm3', content: 'still here' });
  await until((fs) => fs.some((f) => f.t === 'slab' && f.id === 'm3'));
  assert.equal(frames.filter((f) => f.t === 'slab' && f.id === 'm3').length, 1);
});

test('a retry still in its attach loop when a new start runs leaks no sid of the earlier gateway into the new run', async () => {
  let resumes = 0;
  const g1 = await gateway({
    sessions: [session('a1', 'idle'), session('a2', 'idle')],
    onRequest(msg) {
      // The first start resumes a1 and a2; the retry's resume of a1 is held, so its loop stops before a2.
      if (msg.method !== 'session.resume') return undefined;
      resumes += 1;
      return resumes === 3 ? false : undefined;
    },
  });
  await startAgainst(g1, { env: { HERMES_RETRY_MS: '50' } });
  g1.socket.close();
  await g1.received('session.resume', 3, 3000);
  const g2 = await gateway({ sessions: [session('b1', 'idle')] });
  const { frames, until } = await startAgainst(g2);
  await until((fs) => fs.some((f) => f.t === 'state' && f.sid === 'b1'));
  await sleep(100);
  assert.deepEqual([...new Set(frames.map((f) => f.sid))], ['b1'], 'the new run carries no sid from the first gateway');
  assert.equal(g2.calls('session.resume').length, 1, 'the earlier run\'s loop sends nothing on the new socket');
  assert.equal(hermes.titleOf('a2'), '', 'the new run\'s table holds no earlier-run sid');
});

test('start resolves before --seed finishes: a held prompt.submit reply never delays the handle', async () => {
  const g = await gateway({
    onRequest(msg) {
      if (msg.method === 'session.create') return { result: { session_id: 'seed1' } };
      if (msg.method === 'prompt.submit') return false;
      return undefined;
    },
  });
  const resolved = startAgainst(g, { argv: ['--seed', '1'], env: { HERMES_CONNECT_TIMEOUT_MS: '1000' } });
  const handle = await Promise.race([resolved, sleep(900).then(() => null)]);
  assert.ok(handle, 'start resolved while prompt.submit was still unanswered');
  assert.equal(typeof handle.handle.stop, 'function');
  await g.received('prompt.submit', 1);
});
