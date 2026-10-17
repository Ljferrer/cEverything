// Tests for the relay's `voice` command (plan 5 Task 2). A fake transcribe
// server stands in for Hermes's STT route; a fake `say` command stands in for
// plan 2's. Each test case is named for the End state it proves.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

/** Every request the fake transcribe server received: `{method, path, headers, body}`. */
let requests = [];
/** Per-test answers, consumed in order: `{status, body}`. */
let queue = [];
/** Frames `ctx.emit` received. */
let frames = [];
/** Frames the fake `say` was handed. */
let calls = [];
/** `[method, params]` pairs the fake owner's `sendCommand` received. */
let rpc = [];

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    requests.push({
      method: req.method,
      path: new URL(req.url, 'http://x').pathname,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : null,
    });
    const next = queue.shift() ?? { status: 500, body: '' };
    res.writeHead(next.status, { 'content-type': 'application/json' });
    res.end(next.body ?? '');
  });
});

let voice;
before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.OBELISKS_TRANSCRIBE_URL = `http://127.0.0.1:${server.address().port}/api/audio/transcribe`;
  process.env.HERMES_DASHBOARD_SESSION_TOKEN = 'devtoken';
  voice = await import('./voice.mjs');
});
after(() => server.close());
beforeEach(() => {
  requests = [];
  queue = [];
  frames = [];
  calls = [];
  rpc = [];
});

const writable = { sendCommand(method, params) { rpc.push([method, params]); } };
const say = {
  name: 'say',
  handle(cmd, ctx) {
    calls.push(cmd);
    ctx.emit({ t: 'slab', sid: cmd.sid, id: 'u1', role: 'user', text: cmd.text });
    return undefined;
  },
};
const ctxFor = (owner, commands = { say }) => ({
  relay: {},
  sources: {},
  commands,
  emit(frame) { frames.push(frame); },
  ownerOf: () => owner,
});
const cmd = { t: 'voice', sid: 's1', mime: 'audio/mp4', data_url: 'data:audio/mp4;base64,AAAA' };
const slabs = () => frames.filter((f) => f.t === 'slab');
const errors = () => frames.filter((f) => f.t === 'error');

test('ES1 transcribes and delegates to say', async () => {
  queue.push({ status: 200, body: '{"text":"hello"}' });
  await voice.handle(cmd, ctxFor(writable));
  assert.equal(requests.length, 1);
  const r = requests[0];
  assert.equal(r.method, 'POST');
  assert.equal(r.path, '/api/audio/transcribe');
  assert.equal(r.headers['x-hermes-session-token'], 'devtoken');
  assert.deepEqual(r.body, { data_url: 'data:audio/mp4;base64,AAAA', mime_type: 'audio/mp4' });
  assert.deepEqual(slabs(), [{ t: 'slab', sid: 's1', id: 'u1', role: 'user', text: 'hello' }]);
  assert.deepEqual(calls, [{ t: 'say', sid: 's1', text: 'hello' }]);
  assert.deepEqual(rpc, []);
});

test('ES2 read-only owner', async () => {
  const out = await voice.handle(cmd, ctxFor({}));
  assert.deepEqual(out, { t: 'error', text: 'read-only harness' });
  assert.deepEqual(errors(), [{ t: 'error', text: 'read-only harness' }]);
  assert.deepEqual(requests, []);
  assert.deepEqual(calls, []);
});

test('ES2 owner with handle but no sendCommand', async () => {
  await voice.handle(cmd, ctxFor({ handle() {} }));
  assert.deepEqual(errors(), [{ t: 'error', text: 'read-only harness' }]);
  assert.deepEqual(requests, []);
  assert.deepEqual(calls, []);
});

test('ES2 say unavailable', async () => {
  const out = await voice.handle(cmd, ctxFor(writable, {}));
  assert.deepEqual(out, { t: 'error', text: 'say unavailable' });
  assert.deepEqual(errors(), [{ t: 'error', text: 'say unavailable' }]);
  assert.deepEqual(requests, []);
  assert.deepEqual(rpc, []);
});

test('ES3 transcribe failure', async () => {
  queue.push({ status: 500, body: '' });
  await voice.handle(cmd, ctxFor(writable));
  assert.equal(requests.length, 1);
  assert.equal(errors().length, 1);
  assert.ok(errors()[0].text.startsWith('transcribe failed'), errors()[0].text);
  assert.deepEqual(slabs(), []);
  assert.deepEqual(calls, []);
});

test('ES3 no speech', async () => {
  queue.push({ status: 200, body: '{"text":"   "}' });
  await voice.handle(cmd, ctxFor(writable));
  assert.deepEqual(errors(), [{ t: 'error', text: 'no speech' }]);
  assert.deepEqual(slabs(), []);
  assert.deepEqual(calls, []);
});

test('ES1 transcribe URL falls back to HERMES_WS_URL over http', () => {
  assert.equal(voice.transcribeUrl({}), 'http://127.0.0.1:9119/api/audio/transcribe');
  assert.equal(
    voice.transcribeUrl({ HERMES_WS_URL: 'wss://h.example:9119/api/ws?x=1' }),
    'https://h.example:9119/api/audio/transcribe',
  );
  assert.equal(voice.transcribeUrl({ OBELISKS_TRANSCRIBE_URL: 'http://t/x' }), 'http://t/x');
});
