// node:test — Hermes live adapter against a mock dashboard + API server (no real Hermes needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.js';
import { createHermesSource } from '../server/sources/hermes.js';
import { createState, applyEvent } from '../server/state.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 5000, label = 'condition') {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(10);
  }
}

test('hermes adapter: polls a mock dashboard, diffs by row id, redacts, writes via the API server', async () => {
  const http = await import('node:http');
  const T = 1760700000;
  const rows = [
    { id: 1, role: 'user', content: 'Check CI and tell me if main is green. Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123', timestamp: T },
    { id: 2, role: 'assistant', content: '', reasoning: 'I should look at the pipeline page.', tool_calls: JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'web_extract', arguments: JSON.stringify({ url: 'https://ci.example.dev/p/1' }) } }]), timestamp: T + 1 },
  ];
  const posts = [];
  const sessionsRow = { id: 'h1', title: 'ci-watch', model: 'claude-sonnet-4.5', started_at: T, last_activity_at: T + 1, is_active: true, message_count: 2, tool_call_count: 1 };
  const dash = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/api/sessions') return json(200, { sessions: [sessionsRow], total: 1 });
    if (u.pathname === '/api/sessions/h1/messages') return json(200, { session_id: 'h1', messages: [...rows].reverse() });
    if (/^\/api\/sessions\/[^/]+\/messages$/.test(u.pathname)) return json(200, { messages: [] }); // forked / new sessions have no rows yet
    return json(404, { detail: 'not found' });
  });
  const apiSrv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      posts.push({ path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.writeHead(req.url.endsWith('/fork') ? 201 : 200, { 'Content-Type': 'application/json' });
      if (req.url.endsWith('/fork')) return res.end(JSON.stringify({ session: { id: 'h1-fork', title: 'ci-watch fork', parent_session_id: 'h1', started_at: T + 5 } }));
      if (req.url === '/api/sessions') return res.end(JSON.stringify({ session: { id: 'h2', title: 'fresh', started_at: T + 6 } }));
      res.end(JSON.stringify({ reply: 'ok' }));
    });
  });
  await new Promise((r) => dash.listen(0, '127.0.0.1', r));
  await new Promise((r) => apiSrv.listen(0, '127.0.0.1', r));
  const prev = { ...process.env };
  process.env.HERMES_DASHBOARD = `http://127.0.0.1:${dash.address().port}`;
  process.env.HERMES_API = `http://127.0.0.1:${apiSrv.address().port}`;
  process.env.HERMES_API_KEY = 'test-key-123';
  process.env.HERMES_WS = '0';
  const live = await startServer({ port: 0, host: '127.0.0.1', source: 'hermes', quiet: true, log: () => {} });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${live.port}/ws`);
    const frames = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'join', device: 'desktop', name: 't' }));
    const hello = await waitFor(() => frames.find((f) => f.t === 'hello'), 2000, 'hello');
    assert.equal(hello.source, 'hermes');
    assert.match(hello.sourceInfo.label, /^LIVE/);
    await waitFor(() => live.state.sessions.h1, 4000, 'session polled');
    await waitFor(() => (live.state.messages.h1 || []).length === 3, 4000, 'messages polled');
    const msgs = live.state.messages.h1;
    assert.deepEqual(msgs.map((m) => `${m.role}:${m.id}`), ['user:1', 'thinking:2:r', 'tool_call:2:c1']);
    assert.ok(msgs[0].text.includes('ghp_[REDACTED]') && !msgs[0].text.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'), 'redacted before broadcast');
    assert.equal(live.state.sessions.h1.title, 'ci-watch');
    // Hermes row counts are authoritative in live mode: 3 tiles (user, thinking, tool_call) must not become 3 msgs / 2 tools
    assert.equal(live.state.sessions.h1.countsAuthoritative, true);
    assert.deepEqual([live.state.sessions.h1.counts.messages, live.state.sessions.h1.counts.toolCalls], [2, 1], 'counts come from message_count / tool_call_count');
    assert.equal(live.state.sessions.h1.counts.byCategory.web, 1); assert.deepEqual(live.state.sessions.h1.toolHistory, ['web']);
    assert.equal(live.state.sessions.h1.status, 'tool', 'newest row is a tool_call without result');
    assert.equal(live.state.sessions.h1.currentTool?.name, 'web_extract');
    await waitFor(() => frames.some((f) => f.t === 'event' && f.kind === 'tool.start' && f.callId === 'c1'), 2000, 'tool.start broadcast');
    // a second poll must not re-emit the same rows; a new tool row completes the call
    await sleep(1200);
    assert.equal(live.state.messages.h1.length, 3, 'no duplicates across polls');
    rows.push({ id: 3, role: 'tool', tool_call_id: 'c1', tool_name: 'web_extract', content: 'Pipeline #1 · main · passed', timestamp: T + 3 });
    rows.push({ id: 4, role: 'assistant', content: 'main is green (pipeline #1 passed).', timestamp: T + 4 });
    sessionsRow.message_count = 4; sessionsRow.last_activity_at = T + 4;
    await waitFor(() => (live.state.messages.h1 || []).length === 5, 4000, 'new rows polled');
    const complete = await waitFor(() => frames.find((f) => f.t === 'event' && f.kind === 'tool.complete' && f.callId === 'c1'), 2000, 'tool.complete');
    assert.equal(complete.messageId, '2:c1'); assert.equal(complete.ok, true); assert.equal(complete.durationMs, 2000);
    assert.equal(live.state.sessions.h1.status, 'idle', 'assistant row older than the live window → idle');
    // writes
    let n = 0;
    const cmd = async (name, fields) => { const id = `h_${++n}`; ws.send(JSON.stringify({ t: 'command', id, name, ...fields })); return waitFor(() => frames.find((f) => (f.t === 'ack' || f.t === 'error') && f.inReplyTo === id), 3000, name); };
    const sent = await cmd('send', { sessionId: 'h1', text: 'Now deploy it.', via: 'keyboard' });
    assert.equal(sent.t, 'ack');
    await waitFor(() => posts.some((p) => p.path === '/api/sessions/h1/chat'), 2000, 'chat POST');
    const post = posts.find((p) => p.path === '/api/sessions/h1/chat');
    assert.equal(post.auth, 'Bearer test-key-123'); assert.deepEqual(post.body, { message: 'Now deploy it.' });
    assert.ok(frames.some((f) => f.t === 'event' && f.kind === 'message.add' && f.message.id === sent.result.messageId && f.message.role === 'user'), 'optimistic user tile');
    assert.ok(!frames.some((f) => f.t === 'event' && f.kind === 'message.add' && f.message.role === 'assistant' && f.message.text.length && f.message.id !== '4'), 'never fakes a reply');
    // the row Hermes writes for that chat replaces the optimistic tile (same text) instead of duplicating it; via carries over
    rows.push({ id: 5, role: 'user', content: 'Now deploy it.', timestamp: T + 5 }); sessionsRow.message_count = 5;
    const retired = await waitFor(() => frames.find((f) => f.t === 'event' && f.kind === 'message.complete' && f.messageId === sent.result.messageId && f.hidden === true), 4000, 'optimistic tile retired');
    assert.ok(retired);
    const polledUser = live.state.messages.h1.find((m) => m.id === '5');
    assert.equal(polledUser?.via, 'keyboard');
    assert.equal(live.state.messages.h1.filter((m) => m.role === 'user' && !m.hidden && m.text === 'Now deploy it.').length, 1, 'exactly one visible user tile');
    await waitFor(() => live.state.sessions.h1.counts.messages === 5, 3000, 'counts follow Hermes');
    const forked = await cmd('fork', { sessionId: 'h1' });
    assert.equal(forked.t, 'ack'); assert.equal(forked.result.newSessionId, 'h1-fork');
    assert.equal(live.state.sessions['h1-fork'].parentId, 'h1');
    assert.ok(frames.some((f) => f.t === 'event' && f.kind === 'fork' && f.newSessionId === 'h1-fork'));
    assert.ok(frames.some((f) => f.t === 'event' && f.kind === 'layout.column' && f.sessionId === 'h1-fork'));
    const made = await cmd('new', { title: 'fresh' });
    assert.equal(made.result.sessionId, 'h2'); assert.equal(live.state.sessions.h2.title, 'fresh');
    const intr = await cmd('interrupt', { sessionId: 'h1' });
    assert.equal(intr.t, 'error'); assert.equal(intr.code, 'not_supported');
    const fx = await cmd('fixture.control', { action: 'pause' });
    assert.equal(fx.code, 'not_supported');
    const unknown = await cmd('send', { sessionId: 'nope', text: 'x', via: 'voice' });
    assert.equal(unknown.code, 'unknown_session');
    ws.close();
  } finally {
    await live.close();
    dash.close(); apiSrv.close();
    for (const k of ['HERMES_DASHBOARD', 'HERMES_API', 'HERMES_API_KEY', 'HERMES_WS']) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
});

test('hermes adapter without an API key refuses writes with source_unavailable and starts while Hermes is down', async () => {
  const prev = { ...process.env };
  process.env.HERMES_DASHBOARD = 'http://127.0.0.1:1'; // nothing listens here
  delete process.env.HERMES_API_KEY;
  process.env.HERMES_WS = '0';
  const live = await startServer({ port: 0, host: '127.0.0.1', source: 'hermes', quiet: true, log: () => {} });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${live.port}/ws`);
    const frames = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'join', device: 'desktop' }));
    const hello = await waitFor(() => frames.find((f) => f.t === 'hello'), 2000, 'hello');
    assert.match(hello.sourceInfo.label, /unreachable/);
    assert.equal(hello.sourceInfo.hasApiKey, false);
    const snap = await waitFor(() => frames.find((f) => f.t === 'snapshot'), 2000, 'snapshot');
    assert.deepEqual(snap.sessions, []);
    ws.send(JSON.stringify({ t: 'command', id: 'k1', name: 'new', title: 'x' }));
    const err = await waitFor(() => frames.find((f) => f.t === 'error' && f.inReplyTo === 'k1'), 3000, 'error');
    assert.equal(err.code, 'source_unavailable'); assert.match(err.message, /HERMES_API_KEY/);
    ws.close();
  } finally {
    await live.close();
    for (const k of ['HERMES_DASHBOARD', 'HERMES_API_KEY', 'HERMES_WS']) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
});

test('hermes /api/ws frames (CONTEXT §3f/§3g envelope) map to live tiles, deltas and tool events', async () => {
  const state = createState();
  const events = [];
  const hub = { emit(ev) { const f = { t: 'event', seq: events.length + 1, ts: Date.now(), ...ev }; applyEvent(state, f); events.push(f); return f; }, broadcastSourceInfo() {}, broadcast() {} };
  const src = createHermesSource({ dashboard: 'http://127.0.0.1:1', api: 'http://127.0.0.1:1', apiKey: '', streaming: false, log: () => {} });
  src.start(hub, state);
  try {
    const T = 1760700000;
    src.ingestSessions([{ id: 'live1', title: 'streamed', started_at: T, last_activity_at: T, is_active: true }]);
    assert.ok(state.sessions.live1, 'tracked session');
    const streamFrom = events.length; // session.upsert / session.status from the poll
    const frame = (type, payload, extra = {}) => ({ jsonrpc: '2.0', method: 'event', params: { type, session_id: 'live1', payload, seq: 1, ...extra } });
    assert.equal(src.handleStreamFrame({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 1 } } }).type, 'gateway.ready');
    src.handleStreamFrame(frame('reasoning.delta', { text: 'Let me look. ' }));
    src.handleStreamFrame(frame('message.delta', { text: 'Checking ' }));
    src.handleStreamFrame(frame('message.delta', { text: null })); // §3g segment boundary → the next text is a NEW tile
    src.handleStreamFrame(frame('message.delta', { text: 'the pipeline.' }));
    src.handleStreamFrame(frame('tool.start', { tool_id: 'call_7', name: 'patch', args: { path: 'src/a.js', old_string: 'x', new_string: 'y' }, preview: 'src/a.js' }));
    src.handleStreamFrame(frame('tool.complete', { tool_id: 'call_7', name: 'patch', duration_s: 1.5, inline_diff: '--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-x\n+y', summary: 'patched src/a.js' }));
    src.handleStreamFrame(frame('message.complete', { text: 'Checking the pipeline.', reasoning: 'Let me look.' }));
    src.handleStreamFrame({ jsonrpc: '2.0', id: 'w1', result: { ok: true } }); // a JSON-RPC response → ignored
    src.handleStreamFrame(frame('message.delta', { text: 'x' }, { session_id: 'ghost' })); // unknown session → ignored
    const tag = (e) => `${e.kind}:${e.messageId || e.message?.id}`;
    const kinds = events.slice(streamFrom).map(tag);
    assert.deepEqual(kinds, [
      'message.add:live1:live:1:r', 'message.delta:live1:live:1:r',
      'message.add:live1:live:1', 'message.delta:live1:live:1',
      'message.complete:live1:live:1', 'message.complete:live1:live:1:r',              // boundary closes segment 1
      'message.add:live1:live:2', 'message.delta:live1:live:2',
      'message.add:live1:live:call_7', 'tool.start:live1:live:call_7', 'tool.complete:live1:live:call_7',
      'message.complete:live1:live:2',                                                  // message.complete closes the open segment
    ]);
    const msgs = state.messages.live1;
    assert.equal(msgs.find((m) => m.id === 'live1:live:1').text, 'Checking ');
    assert.equal(msgs.find((m) => m.id === 'live1:live:2').text, 'the pipeline.', 'multi-segment turns keep the streamed text per segment');
    assert.equal(msgs.find((m) => m.id === 'live1:live:1:r').role, 'thinking');
    assert.equal(msgs.find((m) => m.id === 'live1:live:1:r').parentMessageId, 'live1:live:1');
    const start = events.find((e) => e.kind === 'tool.start');
    assert.equal(start.callId, 'call_7'); assert.equal(start.category, 'files'); assert.equal(start.target, 'files'); assert.equal(start.live, true);
    assert.deepEqual(start.args, { path: 'src/a.js', old_string: 'x', new_string: 'y' });
    const complete = events.find((e) => e.kind === 'tool.complete');
    assert.equal(complete.durationMs, 1500); assert.equal(complete.ok, true); assert.match(complete.meta.diff, /^--- a\/src\/a\.js/); assert.equal(complete.preview, 'patched src/a.js');
    assert.equal(msgs.find((m) => m.id === 'live1:live:call_7').tool.meta.diff, complete.meta.diff, 'diff lands on the live tool tile');
    // polled rows: each retires the OLDEST finished live tile of its role; the live tool tile is retired and the completion
    // that already landed on it moves onto the polled tile (quiet: no second packet); no duplicate tool.start/complete
    const n = events.length;
    src.ingestMessages('live1', [
      { id: 38, role: 'assistant', content: 'Checking ', reasoning: 'Let me look.', timestamp: T + 1 },
      { id: 40, role: 'assistant', content: '', tool_calls: JSON.stringify([{ id: 'call_7', type: 'function', function: { name: 'patch', arguments: '{"path":"src/a.js","old_string":"x","new_string":"y"}' } }]), timestamp: T + 2 },
      { id: 41, role: 'tool', tool_call_id: 'call_7', tool_name: 'patch', content: '{"success":true}', timestamp: T + 3 },
      { id: 42, role: 'assistant', content: 'the pipeline.', timestamp: T + 4 },
    ]);
    const after = events.slice(n).filter((e) => !e.kind.startsWith('session.')).map(tag);
    assert.deepEqual(after, [
      'message.complete:live1:live:1:r', 'message.add:38:r',
      'message.complete:live1:live:1', 'message.add:38',
      'message.complete:live1:live:call_7', 'message.add:40:call_7', 'tool.complete:40:call_7',
      'message.add:41',
      'message.complete:live1:live:2', 'message.add:42',
    ], 'polled rows retire live tiles oldest-first; completion re-targeted; no duplicate tool.start');
    for (const e of events.slice(n)) if (e.kind === 'message.complete') assert.equal(e.hidden, true, `${e.messageId} retired hidden`);
    const moved = events.slice(n).find((e) => e.kind === 'tool.complete');
    assert.equal(moved.quiet, true); assert.equal(moved.durationMs, 1500); assert.match(moved.meta.diff, /^--- a\/src\/a\.js/);
    assert.equal(msgs.find((m) => m.id === '40:call_7').tool.durationMs, 1500, 'the visible tile carries the completion');
    for (const id of ['live1:live:1', 'live1:live:1:r', 'live1:live:2', 'live1:live:call_7']) assert.equal(msgs.find((m) => m.id === id).hidden, true, `${id} hidden`);
    assert.deepEqual(msgs.filter((m) => !m.hidden).map((m) => m.id), ['38:r', '38', '40:call_7', '41', '42']);
    // REGRESSION (id reuse): the next turn streams into a fresh, visible tile — it must not inherit hidden:true
    src.handleStreamFrame(frame('message.delta', { text: 'turn two' }));
    const t2 = msgs.find((m) => m.id === 'live1:live:3');
    assert.ok(t2 && !t2.hidden && t2.streaming && t2.text === 'turn two', `second turn streams visibly: ${JSON.stringify(t2)}`);
    src.handleStreamFrame(frame('message.complete', { text: 'turn two' }));
    // reversed order: the polled tool_call row lands BEFORE the stream's tool.complete → the completion targets the polled tile
    src.handleStreamFrame(frame('tool.start', { tool_id: 'call_8', name: 'terminal', args: { command: 'npm test' } }));
    src.ingestMessages('live1', [{ id: 50, role: 'assistant', content: '', tool_calls: [{ id: 'call_8', type: 'function', function: { name: 'terminal', arguments: '{"command":"npm test"}' } }], timestamp: T + 6 }]);
    assert.equal(msgs.find((m) => m.id === 'live1:live:call_8').hidden, true, 'live tool tile retired by the polled row');
    src.handleStreamFrame(frame('tool.complete', { tool_id: 'call_8', name: 'terminal', duration_s: 2, result_text: '{"output":"ok","exit_code":0}' }));
    let c8 = events.filter((e) => e.kind === 'tool.complete' && e.callId === 'call_8');
    assert.equal(c8.length, 1); assert.equal(c8[0].messageId, '50:call_8', 'completion targets the visible polled tile, not the hidden live one');
    assert.equal(msgs.find((m) => m.id === '50:call_8').tool.durationMs, 2000);
    src.ingestMessages('live1', [{ id: 51, role: 'tool', tool_call_id: 'call_8', tool_name: 'terminal', content: '{"output":"ok","exit_code":0}', timestamp: T + 7 }]);
    c8 = events.filter((e) => e.kind === 'tool.complete' && e.callId === 'call_8');
    assert.equal(c8.length, 1, 'the polled result row does not complete the call a second time');
    assert.ok(msgs.some((m) => m.id === '51' && m.role === 'tool_result'));
    // flat shapes are tolerated too
    assert.equal(src.handleStreamFrame({ method: 'message.delta', params: { session_id: 'live1', text: '!' } }).type, 'message.delta');
    assert.equal(src.handleStreamFrame('garbage'), null);
  } finally { src.stop(); }
});

test('hermes adapter prunes sessions that left the listing after a grace period (never fresh fork/new ones)', async () => {
  const state = createState();
  const events = [];
  const hub = { emit(ev) { const f = { t: 'event', seq: events.length + 1, ts: Date.now(), ...ev }; applyEvent(state, f); events.push(f); return f; }, broadcastSourceInfo() {}, broadcast() {} };
  const src = createHermesSource({ dashboard: 'http://127.0.0.1:1', api: 'http://127.0.0.1:1', apiKey: '', streaming: false, log: () => {} });
  src.start(hub, state);
  try {
    const T = 1760700000;
    const row = (id) => ({ id, title: id, started_at: T, last_activity_at: T, is_active: true });
    src.ingestSessions([row('s'), row('other')]);
    assert.ok(state.sessions.s && state.sessions.other);
    // a listing without 's' marks it missing; it stays for the grace period
    src.ingestSessions([row('other')]);
    assert.ok(src.tracked.has('s') && state.sessions.s, 'still tracked within the grace period');
    assert.ok(src.tracked.get('s').missingSince > 0);
    // simulate the grace period and the fresh-session guard elapsing
    src.tracked.get('s').missingSince -= 20_000; src.tracked.get('s').createdAt -= 120_000;
    src.ingestSessions([row('other')]);
    assert.ok(!src.tracked.has('s'), 'no longer polled');
    assert.ok(!state.sessions.s, 'column removed');
    assert.ok(events.some((e) => e.kind === 'session.remove' && e.sessionId === 's'));
    assert.ok(state.sessions.other && src.tracked.has('other'));
  } finally { src.stop(); }
});
