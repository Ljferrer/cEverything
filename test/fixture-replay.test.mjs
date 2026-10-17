// node:test — the real fixtures/demo scenario through the real server at speed 50: sessions, layout/pylons honoured,
// diffs, waiting_on_you, loop re-emission with fresh ids, fork/approve, ring-buffer resume, reset, export round-trip.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.js';
import { createState, applyEvents, snapshot } from '../server/state.js';
import { loadScenario } from '../server/sources/fixture-load.js';
import { validateEvent } from '../server/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.join(ROOT, 'fixtures', 'demo');
const DEMO_SESSIONS = ['s_research', 's_fix', 's_deploy', 's_think', 's_orch', 's_orch_child', 's_readme'];
const layoutJson = JSON.parse(fs.readFileSync(path.join(DEMO, 'layout.json'), 'utf8'));
const pylonsJson = JSON.parse(fs.readFileSync(path.join(DEMO, 'pylons.json'), 'utf8'));

let api;
let cmdCounter = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 8000, label = 'condition') {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(10);
  }
}

/** Test client against `srv` (defaults to the shared demo server). */
async function connect({ srv = api, device = 'desktop', name = 'replay-test', lastSeq } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  const frames = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ t: 'join', device, name, ...(lastSeq !== undefined ? { lastSeq } : {}) }));
  const client = {
    ws, frames,
    events(kind, sessionId) { return frames.filter((f) => f.t === 'event' && (!kind || f.kind === kind) && (!sessionId || f.sessionId === sessionId)); },
    async cmd(cname, fields = {}, timeout = 5000) {
      const id = `fx_${++cmdCounter}`;
      ws.send(JSON.stringify({ t: 'command', id, name: cname, ...fields }));
      return waitFor(() => frames.find((f) => (f.t === 'ack' || f.t === 'error') && f.inReplyTo === id), timeout, `reply to ${cname}`);
    },
    close() { ws.close(); return new Promise((r) => ws.once('close', r)); },
  };
  client.hello = await waitFor(() => frames.find((f) => f.t === 'hello'), 3000, 'hello');
  return client;
}

/** Client-side mirror: snapshot frame → state, so replayed events can be applied with the shared reducers. */
function mirrorFromSnapshot(snap) {
  const m = createState();
  m.pylons = structuredClone(snap.pylons);
  m.lineage = structuredClone(snap.lineage || []);
  for (const s of snap.sessions) {
    m.sessions[s.id] = structuredClone(s);
    m.order.push(s.id);
    m.messages[s.id] = structuredClone(snap.messages[s.id] || []);
    m.layout[s.id] = structuredClone(snap.layout[s.id]);
  }
  return m;
}

before(async () => {
  api = await startServer({ port: 0, host: '127.0.0.1', fixture: 'fixtures/demo', speed: 50, loop: true, paused: false, quiet: true, log: () => {} });
});
after(async () => { await api.close(); });

test('demo replay: 7 sessions, layout.json + pylons.json honoured, streaming, diffs, waiting_on_you', async () => {
  const c = await connect();
  const snap = await waitFor(() => c.frames.find((f) => f.t === 'snapshot'), 3000, 'snapshot');
  assert.deepEqual(snap.pylons, pylonsJson, 'pylons.json is the pylon layout');
  // one full pass of the story (241 s at speed 50 ≈ 5 s) → the replayer loops
  await waitFor(() => api.source.position.loopIndex >= 1, 12000, 'first loop to finish');
  const upserts = c.events('session.upsert');
  assert.ok(upserts.length >= 7, `≥ 7 session.upsert (got ${upserts.length})`);
  const ids = new Set(upserts.map((e) => e.sessionId));
  for (const id of DEMO_SESSIONS) assert.ok(ids.has(id), `session ${id} upserted`);
  const child = upserts.find((e) => e.sessionId === 's_orch_child');
  assert.equal(child.session.parentId, 's_orch', 'delegate child carries parentId');
  // every event frame is a valid protocol event with monotonic seq and wall-clock ts
  const events = c.events();
  let prev = 0;
  for (const e of events) {
    assert.ok(e.seq > prev, 'monotonic seq'); prev = e.seq;
    assert.equal(validateEvent(e).ok, true, `valid event ${e.kind}`);
  }
  // layout.json placements are emitted as layout.column right after each first upsert
  for (const [sid, p] of Object.entries(layoutJson)) {
    const up = upserts.find((e) => e.sessionId === sid);
    const lay = c.events('layout.column', sid)[0];
    assert.ok(lay, `layout.column for ${sid}`);
    assert.equal(lay.seq, up.seq + 1, `layout right after the first upsert of ${sid}`);
    assert.deepEqual(lay.placement, { sessionId: sid, x: p.x, z: p.z, rot: p.rot });
  }
  // tool.start / tool.complete pairs, ≥ 3 completes with unified diffs
  const starts = c.events('tool.start'); const completes = c.events('tool.complete');
  assert.ok(starts.length >= 30 && completes.length >= 30, `tool traffic (${starts.length}/${completes.length})`);
  const startIds = new Set(starts.map((e) => e.callId));
  for (const e of completes) assert.ok(startIds.has(e.callId), `tool.complete ${e.callId} has a tool.start`);
  for (const e of starts) assert.ok(['browser', 'files', 'terminal', 'self'].includes(e.target));
  const diffs = completes.filter((e) => typeof e.meta?.diff === 'string' && /^(---|\+\+\+|@@)/m.test(e.meta.diff));
  assert.ok(diffs.length >= 3, `≥ 3 tool.complete with meta.diff (got ${diffs.length})`);
  assert.ok(diffs.some((e) => /\n\+/.test(e.meta.diff) && /\n-/.test(e.meta.diff)), 'a diff with both + and − lines');
  // streaming: deltas only land on streaming messages that exist; complete carries the full text
  const adds = c.events('message.add');
  const byId = new Map(adds.map((e) => [e.message.id, e.message]));
  const deltas = c.events('message.delta');
  assert.ok(deltas.length >= 100, `message.delta traffic (${deltas.length})`);
  for (const d of deltas) {
    const m = byId.get(d.messageId);
    assert.ok(m, `delta targets a known tile ${d.messageId}`);
    assert.equal(m.streaming, true, 'delta targets a streaming tile');
    assert.ok(m.role === 'assistant' || m.role === 'thinking');
  }
  const completesMsg = c.events('message.complete');
  assert.ok(completesMsg.length >= 5 && completesMsg.every((e) => byId.has(e.messageId) && typeof e.text === 'string' && e.text.length > 0));
  // thinking tiles come before the assistant tile they belong to
  for (const e of adds) {
    if (e.message.role !== 'thinking' || !e.message.parentMessageId) continue;
    const parent = adds.find((x) => x.message.id === e.message.parentMessageId);
    if (parent) assert.ok(parent.seq > e.seq, `thinking ${e.message.id} before its assistant`);
  }
  // tiles appear "now", not at their authored 2026-10-17 09:xx timestamps
  const now = Date.now();
  for (const e of adds.slice(-50)) assert.ok(Math.abs(e.message.ts - now) < 60_000, 'message.ts rebased to wall-clock');
  assert.ok(adds.every((e) => typeof e.message.via === 'string'), 'every tile has a via');
  // deploy parks at an approval with a full Attention
  const waits = c.events('session.status').filter((e) => e.status === 'waiting_on_you');
  assert.ok(waits.length >= 1, '≥ 1 waiting_on_you');
  const w = waits.find((e) => e.sessionId === 's_deploy');
  assert.ok(w, 's_deploy waits for approval');
  assert.equal(w.attention.kind, 'approval');
  assert.match(w.attention.text, /git push origin main --force/);
  assert.equal(typeof w.attention.requestId, 'string');
  assert.ok(Math.abs(w.attention.since - now) < 60_000, 'attention.since rebased');
  // derived state after one pass: counts come from the reducer, not the fixture's zeros
  const d = await connect();
  const snap2 = await waitFor(() => d.frames.find((f) => f.t === 'snapshot'), 3000, 'snapshot 2');
  assert.ok(snap2.sessions.length >= 7);
  for (const s of snap2.sessions.filter((x) => DEMO_SESSIONS.includes(x.id))) {
    assert.ok(s.counts.messages > 0, `${s.id} has messages`);
    assert.ok(s.toolHistory.length > 0 && s.toolHistory.length <= 8, `${s.id} toolHistory`);
    assert.ok(snap2.messages[s.id].length === Math.min(400, s.counts.messages), `${s.id} message list matches counts`);
    assert.deepEqual(snap2.layout[s.id], { sessionId: s.id, ...layoutJson[s.id] }, `${s.id} layout in snapshot`);
  }
  const readme = snap2.sessions.find((s) => s.id === 's_readme');
  assert.ok(readme.counts.messages >= 80, 'write-readme exceeds 80 messages (spire path)');
  await c.close(); await d.close();
});

test('loop restart re-emits the story with fresh ids while columns keep growing', async () => {
  const c = await connect();
  await waitFor(() => api.source.position.loopIndex >= 1 && c.events('session.upsert', 's_fix').length >= 1, 12000, 'loop 1 upsert');
  const before = structuredClone(api.state.sessions.s_fix.counts);
  const addsLoop1 = await waitFor(() => { const a = c.events('message.add', 's_fix').filter((e) => /~1$/.test(e.message.id)); return a.length >= 3 ? a : null; }, 12000, 'loop-1 tiles');
  const base = addsLoop1[0].message.id.replace(/~1$/, '');
  assert.ok(api.state.messages.s_fix.some((m) => m.id === base), 'the loop-0 tile with the base id still exists');
  assert.ok(api.state.messages.s_fix.some((m) => m.id === `${base}~1`), 'the loop-1 tile has the suffixed id');
  const linked = addsLoop1.find((e) => e.message.parentMessageId);
  if (linked) assert.match(linked.message.parentMessageId, /~1$/, 'parent links are suffixed together');
  const tc = await waitFor(() => c.events('tool.start', 's_fix').find((e) => /~1$/.test(e.callId)), 12000, 'loop-1 tool.start');
  assert.match(tc.messageId, /~1$/);
  const up = c.events('session.upsert', 's_fix').at(-1);
  assert.equal(up.session.id, 's_fix', 'session ids are stable across loops');
  await waitFor(() => api.state.sessions.s_fix.counts.messages > before.messages, 5000, 'counts keep growing');
  const src = c.frames.find((f) => f.t === 'hello');
  assert.equal(src.sourceInfo.scenario, 'demo');
  await c.close();
});

test('fork command on a demo column → session.upsert + layout.column + clones + fork event', async () => {
  const c = await connect();
  await waitFor(() => (api.state.messages.s_orch || []).length >= 6, 8000, 's_orch history');
  await c.cmd('fixture.control', { action: 'pause' });
  try {
  const at = api.state.messages.s_orch[5].id;
  const parentPlace = api.state.layout.s_orch;
  const ack = await c.cmd('fork', { sessionId: 's_orch', atMessageId: at, title: 'orchestrator · what-if' });
  assert.equal(ack.t, 'ack');
  const newId = ack.result.newSessionId;
  const up = await waitFor(() => c.events('session.upsert', newId)[0], 3000, 'fork upsert');
  assert.equal(up.session.parentId, 's_orch'); assert.equal(up.session.title, 'orchestrator · what-if');
  const lay = await waitFor(() => c.events('layout.column', newId)[0], 3000, 'fork layout');
  assert.ok(Math.abs(lay.placement.x - (parentPlace.x + 0.8)) < 2e-3 && Math.abs(lay.placement.z - parentPlace.z) < 2e-3, `lands 0.8 m right (${JSON.stringify(lay.placement)} vs parent ${JSON.stringify(parentPlace)})`);
  const forks = await waitFor(() => { const f = c.events('fork'); return f.length ? f : null; }, 3000, 'fork event');
  assert.ok(forks.length >= 1, '≥ 1 fork after a fork command');
  assert.equal(forks[0].fromSessionId, 's_orch'); assert.equal(forks[0].newSessionId, newId); assert.equal(forks[0].atMessageId, at);
  const clones = c.events('message.add', newId);
  assert.equal(clones.length, 6);
  assert.deepEqual(clones.map((e) => e.message.id.replace(/:f\d+$/, '')), api.state.messages.s_orch.slice(0, 6).map((m) => m.id));
  assert.ok(api.state.lineage.some((l) => l.newSessionId === newId));
  } finally { await c.cmd('fixture.control', { action: 'play' }); }
  await c.close();
});

test('ring-buffer resume: disconnect, rejoin with lastSeq, replayed events rebuild the exact server state', async () => {
  const a = await connect();
  const snap = await waitFor(() => a.frames.find((f) => f.t === 'snapshot'), 3000, 'snapshot');
  const mirror = mirrorFromSnapshot(snap);
  await waitFor(() => a.events().length >= 40, 8000, 'some live events');
  await a.close();
  const seen = a.events();
  applyEvents(mirror, seen);
  const lastSeq = seen.at(-1).seq;
  await waitFor(() => api.hub.latestSeq > lastSeq + 20, 8000, 'the story moved on while disconnected');
  // freeze the world, then resume
  const ctl = await connect();
  await ctl.cmd('fixture.control', { action: 'pause' });
  try {
  const target = api.hub.latestSeq;
  const b = await connect({ lastSeq });
  await waitFor(() => b.frames.some((f) => f.t === 'event' && f.seq === target), 5000, 'replay caught up');
  assert.ok(!b.frames.some((f) => f.t === 'snapshot'), 'resume replays events instead of a snapshot');
  const replayed = b.events();
  assert.equal(replayed[0].seq, lastSeq + 1, 'replay starts right after lastSeq');
  for (let i = 1; i < replayed.length; i++) assert.equal(replayed[i].seq, replayed[i - 1].seq + 1, 'no gaps');
  applyEvents(mirror, replayed);
  const theirs = snapshot(api.state);
  const ours = snapshot(mirror);
  assert.deepEqual(ours.sessions, theirs.sessions, 'sessions identical after resume');
  assert.deepEqual(ours.messages, theirs.messages, 'messages identical after resume');
  assert.deepEqual(ours.layout, theirs.layout, 'layout identical after resume');
  assert.deepEqual(ours.lineage, theirs.lineage);
  // a lastSeq that fell out of the ring → snapshot
  const c = await connect({ lastSeq: -1 });
  const s3 = await waitFor(() => c.frames.find((f) => f.t === 'snapshot' || f.t === 'event'), 3000);
  assert.equal(s3.t, 'snapshot');
  await b.close(); await c.close();
  } finally { await ctl.cmd('fixture.control', { action: 'play' }); }
  await ctl.close();
});

test('approve on the parked deploy session runs the command named in the attention text', async () => {
  const c = await connect();
  // make sure deploy is parked in this loop (reset happens later; here we just wait for the beat)
  await waitFor(() => api.state.sessions.s_deploy?.status === 'waiting_on_you', 12000, 'deploy parked');
  await c.cmd('fixture.control', { action: 'pause' });
  try {
  const attention = api.state.sessions.s_deploy.attention;
  const t0 = api.hub.latestSeq;
  const ack = await c.cmd('approve', { sessionId: 's_deploy', requestId: attention.requestId, allow: true });
  assert.equal(ack.t, 'ack'); assert.equal(ack.result.resolved, true); assert.equal(ack.result.requestId, attention.requestId);
  const start = await waitFor(() => c.events('tool.start', 's_deploy').find((e) => e.seq > t0), 4000, 'approved tool.start');
  assert.equal(start.name, 'terminal');
  assert.equal(start.args.command, 'git push origin main --force');
  assert.equal(start.target, 'terminal');
  const done = await waitFor(() => c.events('tool.complete', 's_deploy').find((e) => e.callId === start.callId), 5000, 'tool.complete');
  assert.equal(done.ok, true); assert.equal(done.meta.command, 'git push origin main --force');
  await waitFor(() => c.events('session.status', 's_deploy').some((e) => e.seq > done.seq && e.status === 'idle'), 4000, 'idle');
  assert.equal(api.state.sessions.s_deploy.attention, null);
  // voice into a waiting column counts as approval too
  const cue = await c.cmd('fixture.control', { action: 'cue', value: 'needs_you', sessionId: 's_fix' });
  assert.equal(cue.t, 'ack');
  await waitFor(() => api.state.sessions.s_fix.status === 'waiting_on_you', 3000, 'cue parked s_fix');
  const t1 = api.hub.latestSeq;
  const voice = await c.cmd('send', { sessionId: 's_fix', text: 'yes go ahead', via: 'voice' });
  assert.equal(voice.t, 'ack');
  const vs = await waitFor(() => c.events('tool.start', 's_fix').find((e) => e.seq > t1), 4000, 'voice-approved tool.start');
  assert.equal(vs.name, 'terminal');
  assert.match(api.state.sessions.s_fix.attention?.text || '', /^$/, 'attention cleared by the approval');
  await waitFor(() => api.state.sessions.s_fix.status === 'idle', 6000, 's_fix idle again');
  } finally { await c.cmd('fixture.control', { action: 'play' }); }
  await c.close();
});

test('reset returns to the initial snapshot and the story replays from the top without id suffixes', async () => {
  const c = await connect();
  await waitFor(() => Object.keys(api.state.sessions).length >= 8, 5000, 'forks/children present');
  await c.cmd('fixture.control', { action: 'pause' });
  const before = Object.keys(api.state.sessions);
  const t0 = api.hub.latestSeq;
  const ack = await c.cmd('fixture.control', { action: 'reset' });
  assert.equal(ack.t, 'ack'); assert.equal(ack.result.loopIndex, 0); assert.equal(ack.result.position, 0);
  const removes = c.events('session.remove').filter((e) => e.seq > t0);
  assert.deepEqual(removes.map((e) => e.sessionId).sort(), before.sort(), 'every session removed, forks and children included');
  // a fresh client now sees exactly the initial room
  const fresh = await connect();
  const snap = await waitFor(() => fresh.frames.find((f) => f.t === 'snapshot'), 3000, 'snapshot after reset');
  assert.deepEqual({ sessions: snap.sessions, messages: snap.messages, layout: snap.layout, lineage: snap.lineage, pylons: snap.pylons },
    { sessions: [], messages: {}, layout: {}, lineage: [], pylons: pylonsJson }, 'initial snapshot');
  assert.deepEqual(api.state.lineage, []);
  const src = await waitFor(() => c.frames.find((f) => f.t === 'source' && f.sourceInfo.loopIndex === 0 && f.sourceInfo.position === 0), 2000, 'source frame');
  assert.equal(src.sourceInfo.scenario, 'demo');
  // play → the same seven columns come back at their layout.json places, ids without a loop suffix
  const t1 = api.hub.latestSeq;
  await c.cmd('fixture.control', { action: 'play' });
  // the seven dt-0 upserts land in the first tick; the first message.add lines follow on later ticks
  await waitFor(() => DEMO_SESSIONS.every((id) => fresh.events('session.upsert', id).length >= 1) && fresh.events('message.add').some((e) => e.seq > t1), 6000, 'seven upserts + a first message after reset');
  for (const id of DEMO_SESSIONS) assert.deepEqual(api.state.layout[id], { sessionId: id, ...layoutJson[id] }, `${id} layout restored`);
  const adds = fresh.events('message.add').filter((e) => e.seq > t1);
  assert.ok(adds.length > 0 && adds.every((e) => !/~\d+$/.test(e.message.id)), 'loop 0 ids after reset');
  assert.equal(Object.keys(api.state.sessions).length, 7);
  await c.close(); await fresh.close();
});

test('export-to-fixture round-trips fixtures/raw/hermes-export-sample.json through the replayer', async () => {
  const raw = path.join(ROOT, 'fixtures', 'raw', 'hermes-export-sample.json');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceverything-export-'));
  try {
    const out = path.join(dir, 'sample.jsonl');
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(ROOT, 'scripts', 'export-to-fixture.mjs'), raw, '--out', out, '--max-dt', '2000'], { cwd: ROOT });
    assert.match(stdout, /wrote .*sample\.jsonl — \d+ lines, 20 rows/);
    const exp = JSON.parse(fs.readFileSync(raw, 'utf8'));
    const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].dt, 0); assert.equal(lines[0].kind, 'session.upsert'); assert.equal(lines[0].session.id, exp.id);
    assert.ok(lines.every((l) => l.sessionId === exp.id && validateEvent(l).ok), 'every line is a valid event for the export session');
    assert.ok(!JSON.stringify(lines).includes('sk-FAKE'), 'the fake key is redacted on the way out');
    const scenario = await loadScenario(dir);
    assert.deepEqual(scenario.warnings, []);
    assert.equal(scenario.files.length, 1); assert.equal(scenario.files[0].sessionId, exp.id);
    // replay it with the real server, no loop, fast
    const srv = await startServer({ port: 0, host: '127.0.0.1', fixture: dir, speed: 64, loop: false, quiet: true, log: () => {} });
    try {
      const c = await connect({ srv });
      await waitFor(() => srv.source.info().ended, 10000, 'short story to end');
      // `ended` flips in the same tick that emits the last lines; the frames are still in flight to the client
      await waitFor(() => c.frames.some((f) => f.t === 'event' && f.seq === srv.hub.latestSeq), 3000, 'last event delivered');
      const adds = c.events('message.add', exp.id);
      const starts = c.events('tool.start', exp.id); const completes = c.events('tool.complete', exp.id);
      assert.equal(starts.length, 7, 'seven tool calls in the sample');
      assert.equal(completes.length, 7, 'every call completes');
      assert.deepEqual(completes.map((e) => e.callId).sort(), starts.map((e) => e.callId).sort());
      const roles = adds.map((e) => e.message.role);
      assert.equal(roles.filter((r) => r === 'tool_call').length, 7);
      assert.equal(roles.filter((r) => r === 'tool_result').length, 7);
      assert.ok(roles.includes('thinking') && roles.includes('assistant') && roles.includes('user'));
      // the assistant row with empty content + tool_calls produced no assistant tile (only its call tiles)
      const emptyRow = exp.messages.find((r) => r.role === 'assistant' && !String(r.content || '').trim() && r.tool_calls);
      assert.ok(emptyRow, 'sample has an empty-content assistant row with tool_calls');
      assert.ok(!adds.some((e) => e.message.id === String(emptyRow.id)), 'no assistant tile for it');
      const patch = completes.find((e) => e.name === 'patch');
      assert.match(patch.meta.diff, /^--- a\/src\/parser\.js/m);
      assert.match(patch.meta.diff, /\n-.*lines\.length - 1/, 'real diff from the Hermes patch result');
      const state = srv.state.sessions[exp.id];
      assert.equal(state.counts.toolCalls, 7);
      assert.equal(state.status, 'idle', 'export was not ended → story ends idle');
      assert.equal(adds.length, srv.state.messages[exp.id].length);
      await c.close();
    } finally { await srv.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
