// node:test — hub handshake, resume, fixture replay, commands, validation. Starts the real server on a random port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.js';
import { validateCommand, validateEvent, EVENT_KINDS, COMMAND_NAMES } from '../server/protocol.js';

let api;
let cmdCounter = 0;
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

/** Test client: records every frame, awaits frames by predicate, sends commands and awaits ack/error. */
async function connect({ device = 'desktop', name = 'tester', lastSeq, epoch, join = true } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${api.port}/ws`);
  const frames = [];
  const waiters = [];
  ws.on('message', (data) => {
    const f = JSON.parse(data.toString());
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(f)) { const w = waiters.splice(i, 1)[0]; w.resolve(f); }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const client = {
    ws, frames,
    next(pred, timeout = 5000, label = 'frame') {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout waiting for ${label}`)); } }, timeout);
      });
    },
    /** await a frame that arrives AFTER this call (ignores history) */
    after(pred, timeout = 5000, label = 'frame') {
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout waiting for ${label}`)); } }, timeout);
      });
    },
    events(kind, sessionId) { return frames.filter((f) => f.t === 'event' && (!kind || f.kind === kind) && (!sessionId || f.sessionId === sessionId)); },
    sendRaw(obj) { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); },
    async cmd(name, fields = {}, timeout = 5000) {
      const id = `cmd_${++cmdCounter}`;
      const p = client.after((f) => (f.t === 'ack' || f.t === 'error') && f.inReplyTo === id, timeout, `reply to ${name}`);
      ws.send(JSON.stringify({ t: 'command', id, name, ...fields }));
      return p;
    },
    close() { ws.close(); return new Promise((r) => ws.once('close', r)); },
  };
  if (join) {
    ws.send(JSON.stringify({ t: 'join', device, name, ...(lastSeq !== undefined ? { lastSeq } : {}), ...(epoch !== undefined ? { epoch } : {}) }));
    client.hello = await client.next((f) => f.t === 'hello');
  }
  return client;
}

before(async () => {
  api = await startServer({ port: 0, host: '127.0.0.1', fixture: 'fixtures/_smoke', speed: 8, loop: false, paused: true, quiet: true, log: () => {} });
});
after(async () => { await api.close(); });

test('hello → snapshot shape', async () => {
  const c = await connect();
  assert.equal(c.hello.t, 'hello');
  assert.match(c.hello.clientId, /^c_/);
  assert.equal(typeof c.hello.serverTime, 'number');
  assert.equal(c.hello.source, 'fixture');
  assert.equal(c.hello.sourceInfo.label, 'FIXTURE REPLAY');
  assert.equal(c.hello.sourceInfo.scenario, '_smoke');
  assert.equal(c.hello.sourceInfo.speed, 8);
  assert.equal(c.hello.sourceInfo.paused, true);
  assert.equal(c.hello.voice.engine, 'none');
  assert.equal(typeof c.hello.latestSeq, 'number');
  const snap = await c.next((f) => f.t === 'snapshot');
  assert.equal(snap.seq, c.hello.latestSeq);
  assert.ok(Array.isArray(snap.sessions));
  assert.equal(typeof snap.messages, 'object');
  assert.equal(typeof snap.layout, 'object');
  assert.ok(Array.isArray(snap.pylons) && snap.pylons.length === 3, 'pylons from pylons.json');
  assert.deepEqual(snap.pylons.map((p) => p.kind).sort(), ['browser', 'files', 'terminal']);
  assert.ok(Array.isArray(snap.presence));
  await c.close();
});

test('fixture events arrive live and build sessions in order', async () => {
  const c = await connect();
  await c.next((f) => f.t === 'snapshot');
  const play = await c.cmd('fixture.control', { action: 'play' });
  assert.equal(play.t, 'ack');
  const src = await c.next((f) => f.t === 'source' && f.sourceInfo.paused === false, 2000, 'source frame');
  assert.equal(src.sourceInfo.paused, false);
  // first line of each file is session.upsert, followed by layout.column from layout.json
  const up = await c.next((f) => f.t === 'event' && f.kind === 'session.upsert' && f.sessionId === 'alpha', 4000, 'alpha upsert');
  assert.equal(up.session.title, 'fix-parser-tests');
  assert.equal(typeof up.seq, 'number'); assert.equal(typeof up.ts, 'number');
  const lay = await c.next((f) => f.t === 'event' && f.kind === 'layout.column' && f.sessionId === 'alpha', 4000, 'alpha layout');
  assert.equal(lay.placement.x, -0.9);
  await c.next((f) => f.t === 'event' && f.kind === 'session.status' && f.sessionId === 'beta' && f.status === 'waiting_on_you', 6000, 'beta waiting');
  await c.next((f) => f.t === 'event' && f.kind === 'session.status' && f.sessionId === 'alpha' && f.status === 'idle' && f.seq > up.seq, 6000, 'alpha idle');
  // monotonic seq
  const seqs = c.frames.filter((f) => f.t === 'event').map((f) => f.seq);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'seq monotonic');
  // tool.start/complete pairs + message tiles with via replay
  const starts = c.events('tool.start', 'alpha'); const completes = c.events('tool.complete', 'alpha');
  assert.equal(starts.length, 3); assert.equal(completes.length, 3);
  assert.equal(starts[1].target, 'files'); assert.equal(starts[2].target, 'terminal');
  assert.ok(completes[1].meta.diff.includes('+  if (Array.isArray(node))'));
  const adds = c.events('message.add', 'alpha');
  assert.equal(adds.length, 10);
  assert.ok(adds.every((e) => typeof e.message.via === 'string'), 'every replayed tile has a via');
  assert.equal(adds.find((e) => e.message.id === 'a2:r').message.via, 'replay', 'missing via → replay');
  assert.equal(adds.find((e) => e.message.id === 'a1').message.via, 'keyboard', 'authored via is kept');
  // derived state in a fresh snapshot
  const d = await connect();
  const snap = await d.next((f) => f.t === 'snapshot');
  const alpha = snap.sessions.find((s) => s.id === 'alpha');
  assert.equal(alpha.counts.messages, 10);
  assert.equal(alpha.counts.toolCalls, 3);
  assert.deepEqual(alpha.toolHistory, ['files', 'files', 'coding']);
  assert.equal(alpha.counts.byCategory.files, 2);
  assert.equal(alpha.status, 'idle');
  assert.equal(snap.messages.alpha.length, 10);
  const beta = snap.sessions.find((s) => s.id === 'beta');
  assert.equal(beta.status, 'waiting_on_you');
  assert.equal(beta.attention.kind, 'approval');
  assert.equal(beta.attention.requestId, 'req_beta_1');
  assert.equal(typeof beta.attention.since, 'number');
  assert.equal(snap.layout.beta.x, 0.9);
  assert.equal(snap.sessions.length, 2);
  await c.close(); await d.close();
});

test('join{lastSeq} replays from the ring buffer; stale lastSeq gets a snapshot', async () => {
  const a = await connect();
  await a.next((f) => f.t === 'snapshot');
  const before = a.hello.latestSeq;
  const r1 = await a.cmd('layout.move', { sessionId: 'alpha', x: -1.2, z: -1.5, rot: -0.4 });
  assert.equal(r1.t, 'ack');
  const r2 = await a.cmd('layout.move', { sessionId: 'alpha', x: -1.3, z: -1.5, rot: -0.4 });
  assert.equal(r2.t, 'ack');
  const b = await connect({ lastSeq: before });
  const first = await b.next((f) => f.t === 'event' || f.t === 'snapshot', 2000, 'replay or snapshot');
  assert.equal(first.t, 'event', 'resume should replay events, not snapshot');
  assert.equal(first.seq, before + 1);
  await b.next((f) => f.t === 'event' && f.seq === before + 2);
  assert.ok(!b.frames.some((f) => f.t === 'snapshot'));
  assert.equal(b.frames.filter((f) => f.t === 'event').length, 2);
  const c = await connect({ lastSeq: -5 });
  const snap = await c.next((f) => f.t === 'snapshot' || f.t === 'event', 2000);
  assert.equal(snap.t, 'snapshot', 'gap too large → snapshot');
  assert.equal(snap.layout.alpha.x, -1.3);
  // lastSeq == latestSeq → nothing to replay, no snapshot, but presence of others follows
  const d = await connect({ lastSeq: api.hub.latestSeq });
  await sleep(100);
  assert.ok(!d.frames.some((f) => f.t === 'snapshot'));
  assert.ok(!d.frames.some((f) => f.t === 'event'));
  // instance epoch (optional field): a lastSeq that fits the ring but comes from another server instance → snapshot
  assert.equal(typeof a.hello.epoch, 'string'); assert.equal(a.hello.epoch, api.hub.epoch);
  const e = await connect({ lastSeq: before, epoch: 'previous-server-instance' });
  const ef = await e.next((f) => f.t === 'snapshot' || f.t === 'event', 2000, 'snapshot or event');
  assert.equal(ef.t, 'snapshot', 'foreign epoch → snapshot, never a replay of unrelated seqs');
  const g = await connect({ lastSeq: before, epoch: api.hub.epoch });
  const gf = await g.next((f) => f.t === 'snapshot' || f.t === 'event', 2000, 'snapshot or event');
  assert.equal(gf.t, 'event', 'matching epoch → replay');
  await a.close(); await b.close(); await c.close(); await d.close(); await e.close(); await g.close();
});

test('layout.move broadcasts layout.column with by; unknown session → error', async () => {
  const a = await connect(); const b = await connect();
  await a.next((f) => f.t === 'snapshot'); await b.next((f) => f.t === 'snapshot');
  const p = b.after((f) => f.t === 'event' && f.kind === 'layout.column' && f.sessionId === 'beta');
  const ack = await a.cmd('layout.move', { sessionId: 'beta', x: 1.5, z: -2, rot: 0.7 });
  assert.equal(ack.t, 'ack'); assert.equal(ack.ok, true);
  const ev = await p;
  assert.deepEqual(ev.placement, { sessionId: 'beta', x: 1.5, z: -2, rot: 0.7 });
  assert.equal(ev.by, a.hello.clientId);
  const err = await a.cmd('layout.move', { sessionId: 'nope', x: 0, z: 0, rot: 0 });
  assert.equal(err.t, 'error'); assert.equal(err.code, 'unknown_session');
  await a.close(); await b.close();
});

test('send → user message.add then scripted reply (thinking → assistant stream → tool pair → idle)', async () => {
  const c = await connect();
  await c.next((f) => f.t === 'snapshot');
  const t0 = api.hub.latestSeq;
  const ack = await c.cmd('send', { sessionId: 'alpha', text: 'Also add a test for deeply nested arrays, please.', via: 'keyboard' });
  assert.equal(ack.t, 'ack'); assert.ok(ack.result.messageId);
  const user = await c.next((f) => f.t === 'event' && f.kind === 'message.add' && f.message?.id === ack.result.messageId);
  assert.equal(user.message.role, 'user'); assert.equal(user.message.via, 'keyboard'); assert.equal(user.sessionId, 'alpha');
  const think = await c.next((f) => f.t === 'event' && f.kind === 'session.status' && f.sessionId === 'alpha' && f.status === 'thinking' && f.seq > t0, 3000, 'thinking status');
  assert.ok(think);
  const thinking = await c.next((f) => f.t === 'event' && f.kind === 'message.add' && f.sessionId === 'alpha' && f.message.role === 'thinking' && f.seq > t0, 4000, 'thinking tile');
  const assistant = await c.next((f) => f.t === 'event' && f.kind === 'message.add' && f.sessionId === 'alpha' && f.message.role === 'assistant' && f.seq > t0, 4000, 'assistant tile');
  assert.ok(thinking.seq < assistant.seq, 'thinking before assistant');
  assert.equal(thinking.message.parentMessageId, assistant.message.id);
  assert.equal(assistant.message.streaming, true);
  const delta = await c.next((f) => f.t === 'event' && f.kind === 'message.delta' && f.messageId === assistant.message.id, 3000, 'delta');
  assert.ok(delta.text.length > 0);
  const done = await c.next((f) => f.t === 'event' && f.kind === 'message.complete' && f.messageId === assistant.message.id, 4000, 'complete');
  assert.ok(done.text.length > 10);
  const start = await c.next((f) => f.t === 'event' && f.kind === 'tool.start' && f.sessionId === 'alpha' && f.seq > done.seq, 4000, 'tool.start');
  assert.ok(['read_file', 'patch', 'terminal'].includes(start.name), 'tool drawn from alpha history');
  const callTile = c.events('message.add', 'alpha').find((e) => e.message.id === start.messageId);
  assert.equal(callTile.message.role, 'tool_call'); assert.equal(callTile.message.tool.callId, start.callId);
  const complete = await c.next((f) => f.t === 'event' && f.kind === 'tool.complete' && f.callId === start.callId, 5000, 'tool.complete');
  assert.equal(complete.messageId, start.messageId);
  const result = c.events('message.add', 'alpha').find((e) => e.message.role === 'tool_result' && e.message.parentMessageId === start.messageId);
  assert.ok(result, 'tool_result tile linked to the call');
  await c.next((f) => f.t === 'event' && f.kind === 'session.status' && f.sessionId === 'alpha' && f.status === 'idle' && f.seq > complete.seq, 3000, 'idle');
  assert.equal(api.state.sessions.alpha.counts.messages, 10 + 5);
  await c.close();
});

test('approve resolves waiting_on_you with a scripted continue', async () => {
  const c = await connect();
  await c.next((f) => f.t === 'snapshot');
  assert.equal(api.state.sessions.beta.status, 'waiting_on_you');
  const t0 = api.hub.latestSeq;
  const ack = await c.cmd('approve', { sessionId: 'beta', requestId: 'req_beta_1', allow: true });
  assert.equal(ack.t, 'ack'); assert.equal(ack.result.resolved, true); assert.equal(ack.result.requestId, 'req_beta_1');
  const user = await c.next((f) => f.t === 'event' && f.kind === 'message.add' && f.message?.id === ack.result.messageId);
  assert.equal(user.message.text, 'Yes, go ahead.');
  const st = await c.next((f) => f.t === 'event' && f.kind === 'session.status' && f.sessionId === 'beta' && f.status === 'tool' && f.seq > t0, 3000, 'tool status');
  assert.equal(st.attention, null);
  const start = await c.next((f) => f.t === 'event' && f.kind === 'tool.start' && f.sessionId === 'beta' && f.seq > t0, 3000, 'deploy tool.start');
  assert.equal(start.name, 'terminal');
  assert.equal(start.args.command, 'npm run deploy:staging');
  await c.next((f) => f.t === 'event' && f.kind === 'tool.complete' && f.callId === start.callId, 4000, 'deploy complete');
  await c.next((f) => f.t === 'event' && f.kind === 'session.status' && f.sessionId === 'beta' && f.status === 'idle' && f.seq > start.seq, 4000, 'idle');
  assert.equal(api.state.sessions.beta.attention, null);
  // approving a non-waiting session is acknowledged but not "resolved"
  const ack2 = await c.cmd('approve', { sessionId: 'alpha', allow: false });
  assert.equal(ack2.t, 'ack'); assert.equal(ack2.result.resolved, false);
  await c.close();
});

test('pipe composes [from <title>]: text, emits pipe then user message with via pipe', async () => {
  const c = await connect();
  const snap = await c.next((f) => f.t === 'snapshot');
  const srcMsg = snap.messages.alpha.find((m) => m.id === 'a8');
  assert.ok(srcMsg);
  const ack = await c.cmd('pipe', { fromSessionId: 'alpha', fromMessageId: 'a8', toSessionId: 'beta' });
  assert.equal(ack.t, 'ack');
  const pipe = await c.next((f) => f.t === 'event' && f.kind === 'pipe' && f.newMessageId === ack.result.newMessageId);
  assert.equal(pipe.fromSessionId, 'alpha'); assert.equal(pipe.toSessionId, 'beta'); assert.equal(pipe.fromMessageId, 'a8');
  const add = await c.next((f) => f.t === 'event' && f.kind === 'message.add' && f.message?.id === ack.result.newMessageId);
  assert.ok(add.seq > pipe.seq, 'pipe arc before the tile grows');
  assert.equal(add.sessionId, 'beta');
  assert.equal(add.message.via, 'pipe');
  assert.ok(add.message.text.startsWith('[from fix-parser-tests]: All 12 parser tests pass.'));
  assert.deepEqual(add.message.from, { sessionId: 'alpha', messageId: 'a8' });
  const bad = await c.cmd('pipe', { fromSessionId: 'alpha', fromMessageId: 'nope', toSessionId: 'beta' });
  assert.equal(bad.t, 'error'); assert.equal(bad.code, 'bad_command');
  await c.cmd('interrupt', { sessionId: 'beta' }); // stop the scripted reply so later tests see a quiet beta
  await c.close();
});

test('fork clones messages up to atMessageId into a child 0.8 m to the right', async () => {
  const c = await connect();
  await c.next((f) => f.t === 'snapshot');
  const parentPlace = api.state.layout.alpha;
  const ack = await c.cmd('fork', { sessionId: 'alpha', atMessageId: 'a5' });
  assert.equal(ack.t, 'ack');
  const newId = ack.result.newSessionId;
  assert.ok(newId && newId !== 'alpha');
  assert.equal(ack.result.cloned, 6);
  const up = await c.next((f) => f.t === 'event' && f.kind === 'session.upsert' && f.sessionId === newId);
  assert.equal(up.session.parentId, 'alpha');
  assert.equal(up.session.title, 'fix-parser-tests fork');
  const lay = await c.next((f) => f.t === 'event' && f.kind === 'layout.column' && f.sessionId === newId);
  assert.ok(Math.abs(lay.placement.x - (parentPlace.x + 0.8)) < 1e-6);
  assert.ok(Math.abs(lay.placement.z - parentPlace.z) < 1e-6);
  const fork = await c.next((f) => f.t === 'event' && f.kind === 'fork' && f.newSessionId === newId);
  assert.equal(fork.fromSessionId, 'alpha'); assert.equal(fork.atMessageId, 'a5');
  const clones = c.events('message.add', newId);
  assert.equal(clones.length, 6);
  assert.ok(clones.every((e) => e.seq < fork.seq), 'clones before the fork event');
  assert.equal(clones[0].message.role, 'user');
  assert.equal(clones[1].message.role, 'thinking');
  assert.equal(clones[5].message.role, 'tool_result');
  assert.equal(clones[5].message.parentMessageId, clones[4].message.id, 'parent links remapped');
  assert.equal(clones[5].message.tool.callId, clones[4].message.tool.callId, 'call ids remapped together');
  assert.equal(api.state.sessions[newId].counts.toolCalls, 2);
  // explicit x/z + title
  const ack2 = await c.cmd('fork', { sessionId: 'beta', x: 2.2, z: -0.5, title: 'deploy experiment' });
  assert.equal(ack2.t, 'ack');
  assert.equal(ack2.result.placement.x, 2.2);
  const up2 = await c.next((f) => f.t === 'event' && f.kind === 'session.upsert' && f.sessionId === ack2.result.newSessionId);
  assert.equal(up2.session.title, 'deploy experiment');
  const err = await c.cmd('fork', { sessionId: 'ghost' });
  assert.equal(err.code, 'unknown_session');
  await c.close();
});

test('new creates an empty session with a placement', async () => {
  const c = await connect();
  await c.next((f) => f.t === 'snapshot');
  const ack = await c.cmd('new', { title: 'scratch', x: 0.3, z: -2.4 });
  assert.equal(ack.t, 'ack');
  const up = await c.next((f) => f.t === 'event' && f.kind === 'session.upsert' && f.sessionId === ack.result.sessionId);
  assert.equal(up.session.title, 'scratch'); assert.equal(up.session.status, 'idle');
  const lay = await c.next((f) => f.t === 'event' && f.kind === 'layout.column' && f.sessionId === ack.result.sessionId);
  assert.equal(lay.placement.x, 0.3); assert.equal(lay.placement.z, -2.4);
  assert.deepEqual(api.state.messages[ack.result.sessionId], []);
  await c.close();
});

test('fixture.control: pause/speed/cue/reset', async () => {
  const c = await connect();
  await c.next((f) => f.t === 'snapshot');
  const pause = await c.cmd('fixture.control', { action: 'pause' });
  assert.equal(pause.t, 'ack'); assert.equal(pause.result.paused, true);
  await c.next((f) => f.t === 'source' && f.sourceInfo.paused === true);
  const speed = await c.cmd('fixture.control', { action: 'speed', value: 2 });
  assert.equal(speed.result.speed, 2);
  assert.equal(api.source.info().speed, 2);
  // cues
  const t0 = api.hub.latestSeq;
  const cue = await c.cmd('fixture.control', { action: 'cue', value: 'needs_you', sessionId: 'alpha' });
  assert.equal(cue.t, 'ack'); assert.equal(cue.result.sessionId, 'alpha');
  const wait = await c.next((f) => f.t === 'event' && f.kind === 'session.status' && f.sessionId === 'alpha' && f.status === 'waiting_on_you' && f.seq > t0);
  assert.equal(wait.attention.kind, 'approval'); assert.equal(wait.attention.requestId, cue.result.requestId);
  assert.match(wait.attention.text, /npm test/);
  const deny = await c.cmd('approve', { sessionId: 'alpha', allow: false });
  assert.equal(deny.result.resolved, true);
  await c.next((f) => f.t === 'event' && f.kind === 'session.status' && f.sessionId === 'alpha' && f.status === 'idle' && f.seq > wait.seq, 3000);
  const done = await c.cmd('fixture.control', { action: 'cue', value: 'done', sessionId: 'beta' });
  assert.equal(done.t, 'ack');
  await c.next((f) => f.t === 'event' && f.kind === 'session.status' && f.sessionId === 'beta' && f.status === 'done' && f.seq > t0);
  const web = await c.cmd('fixture.control', { action: 'cue', value: 'web_burst', sessionId: 'alpha' });
  assert.equal(web.t, 'ack');
  await c.next((f) => f.t === 'event' && f.kind === 'tool.start' && f.sessionId === 'alpha' && f.target === 'browser' && f.seq > t0, 3000, 'web burst start');
  const patch = await c.cmd('fixture.control', { action: 'cue', value: 'patch', sessionId: 'alpha' });
  assert.equal(patch.t, 'ack');
  const ps = await c.next((f) => f.t === 'event' && f.kind === 'tool.start' && f.sessionId === 'alpha' && f.name === 'patch' && f.seq > t0, 3000, 'patch start');
  const pc = await c.next((f) => f.t === 'event' && f.kind === 'tool.complete' && f.callId === ps.callId, 4000, 'patch complete');
  assert.ok(pc.meta.diff.startsWith('--- a/'), 'patch cue carries a unified diff');
  const del = await c.cmd('fixture.control', { action: 'cue', value: 'delegate', sessionId: 'alpha' });
  assert.equal(del.t, 'ack');
  const child = await c.next((f) => f.t === 'event' && f.kind === 'session.upsert' && f.sessionId === del.result.childSessionId, 4000, 'child session');
  assert.equal(child.session.parentId, 'alpha');
  // reset: every session removed, then story restarts from the top
  const before = Object.keys(api.state.sessions).length;
  assert.ok(before >= 5);
  const reset = await c.cmd('fixture.control', { action: 'reset' });
  assert.equal(reset.t, 'ack');
  const removes = c.events('session.remove');
  assert.ok(removes.length >= before, `removed ${removes.length} ≥ ${before}`);
  assert.ok(removes.some((e) => e.sessionId === del.result.childSessionId));
  await c.cmd('fixture.control', { action: 'play' });
  await c.cmd('fixture.control', { action: 'speed', value: 16 });
  await waitFor(() => api.state.sessions.beta?.status === 'waiting_on_you' && api.state.sessions.alpha?.status === 'idle' && api.state.messages.alpha?.length === 10, 6000, 'story replayed after reset');
  assert.equal(Object.keys(api.state.sessions).length, 2);
  assert.equal(api.state.layout.alpha.x, -0.9, 'layout restored');
  const err = await c.cmd('fixture.control', { action: 'cue', value: 'explode' });
  assert.equal(err.t, 'error'); assert.equal(err.code, 'bad_command');
  await c.close();
});

test('bad commands produce errors with inReplyTo', async () => {
  const c = await connect();
  await c.next((f) => f.t === 'snapshot');
  const e1 = await c.cmd('explode', {});
  assert.equal(e1.t, 'error'); assert.equal(e1.code, 'bad_command'); assert.match(e1.message, /unknown command/);
  const e2 = await c.cmd('send', { text: 'no session' });
  assert.equal(e2.code, 'bad_command'); assert.match(e2.message, /sessionId/);
  const e3 = await c.cmd('send', { sessionId: 'ghost', text: 'hi', via: 'voice' });
  assert.equal(e3.code, 'unknown_session');
  const e4 = await c.cmd('layout.move', { sessionId: 'alpha', x: 'left', z: 0, rot: 0 });
  assert.equal(e4.code, 'bad_command');
  const e5 = await c.cmd('approve', { sessionId: 'alpha' });
  assert.equal(e5.code, 'bad_command'); assert.match(e5.message, /allow/);
  const e6 = await c.cmd('fixture.control', { action: 'speed', value: -1 });
  assert.equal(e6.code, 'bad_command');
  const e7 = await c.cmd('audio.chunk', { data: 'AAAA' });
  assert.equal(e7.code, 'bad_command'); assert.match(e7.message, /audio.start/);
  // missing id / invalid json / unknown frame type
  const p1 = c.after((f) => f.t === 'error' && f.inReplyTo === null && /id/.test(f.message));
  c.sendRaw({ t: 'command', name: 'send', sessionId: 'alpha', text: 'x' });
  await p1;
  const p2 = c.after((f) => f.t === 'error' && /JSON/.test(f.message));
  c.sendRaw('{not json');
  await p2;
  const p3 = c.after((f) => f.t === 'error' && f.inReplyTo === 'x1');
  c.sendRaw({ t: 'bogus', id: 'x1' });
  await p3;
  // the connection is still alive afterwards
  const ok = await c.cmd('interrupt', { sessionId: 'alpha' });
  assert.equal(ok.t, 'ack');
  await c.close();
});

test('presence is relayed ≤ 10 Hz and presence.left fires on close', async () => {
  const b = await connect({ device: 'desktop', name: 'laptop' });
  await b.next((f) => f.t === 'snapshot');
  const a = await connect({ device: 'quest', name: 'headset' });
  await a.next((f) => f.t === 'snapshot');
  const joined = await b.next((f) => f.t === 'presence' && f.clientId === a.hello.clientId, 2000, 'join presence');
  assert.equal(joined.device, 'quest'); assert.equal(joined.name, 'headset');
  const t0 = Date.now();
  let acks = 0;
  const promises = [];
  for (let i = 0; i < 30; i++) promises.push(a.cmd('presence', { head: { p: [0, 1.6, i / 100], q: [0, 0, 0, 1] }, gazeSessionId: 'alpha' }).then((r) => { if (r.t === 'ack') acks++; }));
  await Promise.all(promises);
  await sleep(150);
  const elapsed = Date.now() - t0;
  const relayed = b.frames.filter((f) => f.t === 'presence' && f.clientId === a.hello.clientId && f.head);
  assert.equal(acks, 30, 'every command is acknowledged');
  assert.ok(relayed.length >= 1, 'at least one presence relayed');
  assert.ok(relayed.length <= Math.ceil(elapsed / 100) + 1, `relayed ${relayed.length} in ${elapsed} ms (≤ 10 Hz)`);
  assert.equal(relayed[0].gazeSessionId, 'alpha');
  assert.ok(!a.frames.some((f) => f.t === 'presence' && f.clientId === a.hello.clientId), 'not echoed to the sender');
  // snapshot for a late joiner includes presence of others
  const c = await connect();
  const snap = await c.next((f) => f.t === 'snapshot');
  assert.ok(snap.presence.some((p) => p.clientId === a.hello.clientId && p.device === 'quest'));
  const left = b.after((f) => f.t === 'presence.left' && f.clientId === a.hello.clientId, 2000, 'presence.left');
  await a.close();
  await left;
  await b.close(); await c.close();
});

test('voice.text relays transcript; audio.start without a key reports voice.unavailable', async () => {
  const a = await connect(); const b = await connect();
  await a.next((f) => f.t === 'snapshot'); await b.next((f) => f.t === 'snapshot');
  const p = b.after((f) => f.t === 'transcript' && f.clientId === a.hello.clientId);
  const ack = await a.cmd('voice.text', { sessionId: 'alpha', text: 'yes go ahead', final: false });
  assert.equal(ack.t, 'ack');
  const tr = await p;
  assert.equal(tr.sessionId, 'alpha'); assert.equal(tr.text, 'yes go ahead'); assert.equal(tr.final, false);
  const unavailable = a.after((f) => f.t === 'voice.unavailable', 2000, 'voice.unavailable');
  const start = await a.cmd('audio.start', { sessionId: 'alpha', sampleRate: 16000 });
  assert.equal(start.t, 'ack'); assert.equal(start.result.engine, 'none');
  const vu = await unavailable;
  assert.match(vu.reason, /ASSEMBLYAI_API_KEY/);
  const chunk = await a.cmd('audio.chunk', { data: Buffer.alloc(3200).toString('base64') });
  assert.equal(chunk.t, 'ack');
  const stop = await a.cmd('audio.stop', {});
  assert.equal(stop.t, 'ack');
  const bad = await a.cmd('audio.start', { sessionId: 'alpha', sampleRate: 44100 });
  assert.equal(bad.code, 'bad_command');
  await a.close(); await b.close();
});

test('HTTP: / serves index or placeholder, /shared/protocol.js and three vendor files, traversal blocked', async () => {
  const base = `http://127.0.0.1:${api.port}`;
  const root = await fetch(`${base}/`);
  assert.ok(root.status === 200 || root.status === 404);
  assert.match(root.headers.get('content-type'), /text\/html/);
  assert.equal(root.headers.get('cache-control'), 'no-store');
  const proto = await fetch(`${base}/shared/protocol.js`);
  assert.equal(proto.status, 200); assert.match(proto.headers.get('content-type'), /javascript/);
  assert.match(await proto.text(), /export const EVENT_KINDS/);
  const three = await fetch(`${base}/vendor/three/build/three.module.js`);
  assert.equal(three.status, 200); assert.match(three.headers.get('content-type'), /javascript/);
  const jsm = await fetch(`${base}/vendor/three/examples/jsm/controls/OrbitControls.js`);
  assert.equal(jsm.status, 200);
  assert.equal((await fetch(`${base}/vendor/three/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/vendor/three/build/..%2F..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status, 404);
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true); assert.equal(health.source, 'fixture');
  const post = await fetch(`${base}/`, { method: 'POST' });
  assert.equal(post.status, 405);
});

test('validateCommand / validateEvent unit checks', () => {
  assert.equal(COMMAND_NAMES.length, 13);
  assert.equal(EVENT_KINDS.length, 12);
  assert.deepEqual(validateCommand({ t: 'command', id: 'c', name: 'send', sessionId: 's', text: 'hi', via: 'voice' }), { ok: true, error: null });
  assert.equal(validateCommand({ t: 'command', id: 'c', name: 'send', sessionId: 's' }).ok, false);
  assert.equal(validateCommand({ t: 'command', id: 'c', name: 'send', sessionId: 's', text: 'x', via: 'telepathy' }).ok, false);
  assert.equal(validateCommand({ t: 'command', id: 'c', name: 'presence', head: { p: [0, 0, 0], q: [0, 0, 0, 1] }, hands: [null, { p: [1, 2, 3] }], ray: null }).ok, true);
  assert.equal(validateCommand({ t: 'command', id: 'c', name: 'presence', head: { p: [0, 0] } }).ok, false);
  assert.equal(validateCommand({ t: 'command', id: 'c', name: 'fixture.control', action: 'cue', value: 'patch' }).ok, true);
  assert.equal(validateCommand({ t: 'command', id: 'c', name: 'fixture.control', action: 'cue', value: 'nope' }).ok, false);
  assert.equal(validateCommand({ t: 'command', id: 'c', name: 'fixture.control', action: 'speed', value: 0 }).ok, false);
  assert.equal(validateCommand({ t: 'command', id: '', name: 'new' }).ok, false);
  assert.equal(validateCommand({ t: 'event', id: 'c', name: 'new' }).ok, false);
  assert.equal(validateCommand(null).ok, false);
  assert.equal(validateEvent({ sessionId: 's', kind: 'message.add', message: { id: 'm', role: 'user' } }).ok, true);
  assert.equal(validateEvent({ sessionId: 's', kind: 'message.add', message: { id: 'm', role: 'ghost' } }).ok, false);
  assert.equal(validateEvent({ sessionId: 's', kind: 'session.status', status: 'napping' }).ok, false);
  assert.equal(validateEvent({ sessionId: 's', kind: 'nope' }).ok, false);
});
