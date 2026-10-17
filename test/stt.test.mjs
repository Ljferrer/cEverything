// node:test — the AssemblyAI v3 engine against a mock streaming server: v3 ends a Turn at every pause while the mic is
// still held, so the engine must accumulate turns and deliver ONE final with everything said, after audio.stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { createAssemblyAIEngine, buildUrl } from '../server/stt/assemblyai.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 5000, label = 'condition') {
  const start = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`); await sleep(10); }
}

function mockV3() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const seen = { connections: [], bytes: 0, terminated: false };
  wss.on('connection', (ws, req) => {
    seen.connections.push({ auth: req.headers.authorization, url: req.url });
    const send = (o) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };
    send({ type: 'Begin', id: 'sess_1', expires_at: 0 });
    let burst = false;
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        seen.bytes += data.length;
        if (seen.bytes >= 3200 && !burst) {
          burst = true;
          // first sentence: partial → raw end_of_turn → formatted end_of_turn; then the second sentence starts
          send({ type: 'Turn', transcript: 'yes', end_of_turn: false, turn_is_formatted: false });
          send({ type: 'Turn', transcript: 'yes', end_of_turn: true, turn_is_formatted: false });
          send({ type: 'Turn', transcript: 'Yes.', end_of_turn: true, turn_is_formatted: true });
          send({ type: 'Turn', transcript: 'go ahead and', end_of_turn: false, turn_is_formatted: false });
        }
        return;
      }
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'Terminate') {
        seen.terminated = true;
        send({ type: 'Turn', transcript: 'go ahead and deploy', end_of_turn: true, turn_is_formatted: false });
        send({ type: 'Turn', transcript: 'Go ahead and deploy.', end_of_turn: true, turn_is_formatted: true });
        send({ type: 'Termination', audio_duration_seconds: 1.2, session_duration_seconds: 2 });
        ws.close(1000, 'done');
      }
    });
  });
  return new Promise((resolve) => wss.once('listening', () => resolve({ wss, url: `ws://127.0.0.1:${wss.address().port}/v3/ws`, seen })));
}

test('assemblyai engine joins every end_of_turn segment into one final transcript after stop', async () => {
  const { wss, url, seen } = await mockV3();
  try {
    const engine = createAssemblyAIEngine({ apiKey: 'test-key', url, log: () => {} });
    assert.match(engine.url, /sample_rate=16000/); assert.match(engine.url, /format_turns=true/);
    const got = []; let done = false; let error = null;
    const utt = engine.createUtterance({
      clientId: 'c1', sessionId: 's1',
      onTranscript: (text, final) => got.push([final ? 'final' : 'partial', text]),
      onError: (err) => { error = err; }, onDone: () => { done = true; },
    });
    for (let i = 0; i < 4; i++) utt.push(Buffer.alloc(1600, 0)); // 4 × 100 ms frames, buffered until the socket opens
    await waitFor(() => got.length >= 4, 4000, 'four partials');
    assert.deepEqual(got.map(([, t]) => t), ['yes', 'yes', 'Yes.', 'Yes. go ahead and'], 'partials carry finished turns + the current one');
    assert.ok(got.every(([k]) => k === 'partial'), 'no final while the mic is still held');
    utt.stop();
    await waitFor(() => done, 5000, 'utterance done');
    assert.equal(error, null);
    assert.ok(seen.terminated, 'Terminate sent on stop');
    const finals = got.filter(([k]) => k === 'final');
    assert.deepEqual(finals, [['final', 'Yes. Go ahead and deploy.']], 'exactly one final with both sentences');
    assert.equal(got.at(-1)[0], 'final', 'the final is the last frame');
    assert.equal(seen.connections[0].auth, 'test-key');
    assert.match(seen.connections[0].url, /sample_rate=16000/);
  } finally { wss.close(); }
});

test('assemblyai engine fails closed on an unreachable endpoint and buildUrl keeps the required params', async () => {
  assert.equal(new URL(buildUrl('wss://example.test/v3/ws', { sampleRate: 16000 })).searchParams.get('format_turns'), 'true');
  const engine = createAssemblyAIEngine({ apiKey: 'k', url: 'ws://127.0.0.1:1/v3/ws', log: () => {} });
  let error = null; let done = false; const got = [];
  const utt = engine.createUtterance({ onTranscript: (t, f) => got.push([f, t]), onError: (e) => { error = e; }, onDone: () => { done = true; } });
  utt.push(Buffer.alloc(1600));
  await waitFor(() => done, 5000, 'done');
  assert.ok(error, 'error reported');
  assert.deepEqual(got, [], 'nothing transcribed');
});
