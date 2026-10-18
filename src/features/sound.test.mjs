// sound.js pure parts under node, with no AudioContext and no DOM: the
// event-to-cue mapping, the ambient rate limiter, the pitch per pylon, and the
// net.send wrapper that must leave every sent frame unchanged, and the
// override file names and loader (with a fake fetch and decode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMapper, createLimiter, isAmbient, pitchFor, PYLON_PITCH, wrapSend,
  fileFor, loadSfx, SFX_CUES, SFX_EXTS,
} from './sound.js';

test('select maps to select for a base and slab for a slab; miss maps to miss', () => {
  const map = createMapper();
  assert.equal(map('select', { sid: 'a', kind: 'base', slabId: null }), 'select');
  assert.equal(map('select', { sid: 'a', kind: 'slab', slabId: 's1' }), 'slab');
  assert.equal(map('miss', {}), 'miss');
});

test('a session spawns once per sid, so a reconnect resend stays silent', () => {
  const map = createMapper();
  assert.equal(map('session', { sid: 'a', status: 'idle' }), 'spawn');
  assert.equal(map('session', { sid: 'a', status: 'idle' }), null);
  assert.equal(map('session', { sid: 'b', status: 'working' }), 'spawn');
});

test('waiting chimes only on a change to waiting, from state or session frames', () => {
  const map = createMapper();
  map('session', { sid: 'a', status: 'working' });
  assert.equal(map('state', { sid: 'a', status: 'waiting' }), 'waiting');
  assert.equal(map('state', { sid: 'a', status: 'waiting' }), null);
  assert.equal(map('state', { sid: 'a', status: 'working' }), null);
  assert.equal(map('session', { sid: 'a', status: 'waiting' }), 'waiting');
  assert.equal(map('state', { sid: 'z', status: 'waiting' }), 'waiting', 'a state for an unseen sid still chimes');
});

test('tool start and complete carry the pylon of the tool name', () => {
  const map = createMapper();
  assert.equal(map('tool', { name: 'Bash', phase: 'start' }), 'tool:shell');
  assert.equal(map('tool', { name: 'WebFetch', phase: 'start' }), 'tool:browser');
  assert.equal(map('tool', { name: 'read_file', phase: 'start' }), 'tool:filesystem');
  assert.equal(map('tool', { name: 'todo', phase: 'start' }), 'tool:other');
  assert.equal(map('tool', { name: 'Edit', phase: 'complete' }), 'done:filesystem');
  assert.equal(map('tool', { name: 'Edit', phase: 'bogus' }), null);
});

test('outgoing fork, pipe and say have cues; voice is left to talk sent', () => {
  const map = createMapper();
  assert.equal(map('command', { t: 'fork', sid: 'a' }), 'fork');
  assert.equal(map('command', { t: 'pipe', from: 'a', to: 'b', slab: 's' }), 'pipe');
  assert.equal(map('command', { t: 'say', sid: 'a', text: 'hi' }), 'say');
  assert.equal(map('command', { t: 'voice', sid: 'a', mime: 'audio/webm', data_url: 'data:' }), null);
});

test('talk phases and relay errors map to their cues', () => {
  const map = createMapper();
  assert.equal(map('talk', { phase: 'start', sid: 'a' }), 'talkStart');
  assert.equal(map('talk', { phase: 'sent', sid: 'a', ms: 900 }), 'talkSent');
  assert.equal(map('talk', { phase: 'dropped', sid: 'a', ms: 0 }), 'dropped');
  assert.equal(map('talk', { phase: 'error', sid: 'a' }), 'error');
  assert.equal(map('talk', { phase: 'other' }), null);
  assert.equal(map('error', { text: 'boom' }), 'error');
  assert.equal(map('slab', { sid: 'a' }), null, 'events with no cue map to null');
});

test('each pylon has its own pitch', () => {
  assert.equal(pitchFor('Bash'), PYLON_PITCH.shell);
  assert.equal(pitchFor('WebSearch'), PYLON_PITCH.browser);
  assert.equal(pitchFor('Write'), PYLON_PITCH.filesystem);
  assert.equal(pitchFor('anything_else'), PYLON_PITCH.other);
  assert.equal(new Set(Object.values(PYLON_PITCH)).size, 4);
});

test('only relay-driven cues are ambient; user actions bypass the limiter', () => {
  for (const cue of ['spawn', 'waiting', 'tool:shell', 'done:browser']) assert.equal(isAmbient(cue), true, cue);
  for (const cue of ['select', 'slab', 'miss', 'fork', 'pipe', 'say', 'talkStart', 'talkSent', 'dropped', 'error']) {
    assert.equal(isAmbient(cue), false, cue);
  }
});

test('a burst of 50 tool frames at one instant plays only the burst size', () => {
  const limiter = createLimiter({ rate: 3, burst: 3 });
  let played = 0;
  for (let i = 0; i < 50; i++) if (limiter.take(1000)) played++;
  assert.equal(played, 3);
});

test('a steady 20 frames per second for 10 s plays about 3 per second', () => {
  const limiter = createLimiter({ rate: 3, burst: 3 });
  let played = 0;
  for (let ms = 0; ms < 10_000; ms += 50) if (limiter.take(ms)) played++;
  assert.ok(played >= 30 && played <= 33, `played ${played}`);
});

test('the limiter refills after a quiet gap', () => {
  const limiter = createLimiter({ rate: 3, burst: 3 });
  for (let i = 0; i < 3; i++) limiter.take(0);
  assert.equal(limiter.take(0), false);
  assert.equal(limiter.take(5000), true);
});

test('wrapSend sends the same frame first, then reports it, and survives a throwing reporter', () => {
  const sent = [];
  const order = [];
  const net = {
    send(cmd) {
      sent.push(cmd);
      order.push('send');
      return 'ok';
    },
  };
  const seen = [];
  wrapSend(net, (cmd) => {
    order.push('report');
    seen.push(cmd);
    if (cmd.t === 'pipe') throw new Error('synth failed');
  });
  const fork = { t: 'fork', sid: 'a' };
  assert.equal(net.send(fork), 'ok');
  assert.strictEqual(sent[0], fork);
  assert.strictEqual(seen[0], fork);
  assert.deepEqual(order, ['send', 'report']);
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a);
  try {
    assert.doesNotThrow(() => net.send({ t: 'pipe', from: 'a', to: 'b', slab: 's' }));
  } finally {
    console.error = orig;
  }
  assert.equal(sent.length, 2);
  assert.equal(errors.length, 1);
});

test('every cue the mapper can produce has an override file name in SFX_CUES', () => {
  const cues = ['select', 'slab', 'miss', 'spawn', 'waiting', 'fork', 'pipe', 'say', 'talkStart', 'talkSent', 'dropped', 'error'];
  for (const p of Object.keys(PYLON_PITCH)) cues.push(`tool:${p}`, `done:${p}`);
  for (const cue of cues) assert.ok(SFX_CUES.includes(fileFor(cue)), `${cue} -> ${fileFor(cue)}`);
  assert.equal(fileFor('tool:shell'), 'tool-shell');
  assert.equal(fileFor('done:browser'), 'tool-complete');
  assert.equal(fileFor('talkStart'), 'voice-start');
  assert.equal(fileFor('dropped'), 'voice-dropped');
  assert.deepEqual([...SFX_EXTS], ['ogg', 'mp3']);
});

/** A fake fetch over a table of url -> {status, type, body}; anything else is a 404. */
function fakeFetch(table, calls = []) {
  return async (url) => {
    calls.push(url);
    const r = table[url] ?? { status: 404, type: 'text/plain', body: 'missing' };
    return { ok: r.status === 200, headers: { get: () => r.type }, arrayBuffer: async () => r.body };
  };
}
const decode = async (buf) => {
  if (buf === 'corrupt') throw new Error('decode failed');
  return { decoded: buf };
};

test('loadSfx prefers the ogg and never fetches the mp3 when the ogg decodes', async () => {
  const calls = [];
  const fetchImpl = fakeFetch({
    '/sfx/select.ogg': { status: 200, type: 'audio/ogg', body: 'ogg' },
    '/sfx/select.mp3': { status: 200, type: 'audio/mpeg', body: 'mp3' },
  }, calls);
  assert.deepEqual(await loadSfx('select', { fetchImpl, decode }), { decoded: 'ogg' });
  assert.deepEqual(calls, ['/sfx/select.ogg']);
});

test('loadSfx falls back to the mp3 when the ogg is missing or fails to decode', async () => {
  const mp3 = { status: 200, type: 'audio/mpeg', body: 'mp3' };
  let fetchImpl = fakeFetch({ '/sfx/miss.mp3': mp3 });
  assert.deepEqual(await loadSfx('miss', { fetchImpl, decode }), { decoded: 'mp3' });
  fetchImpl = fakeFetch({ '/sfx/miss.ogg': { status: 200, type: 'audio/ogg', body: 'corrupt' }, '/sfx/miss.mp3': mp3 });
  assert.deepEqual(await loadSfx('miss', { fetchImpl, decode }), { decoded: 'mp3' });
});

test('loadSfx returns null for the synth on 404s, the Vite HTML fallback, or a network error', async () => {
  assert.equal(await loadSfx('fork', { fetchImpl: fakeFetch({}), decode }), null);
  const html = { status: 200, type: 'text/html; charset=utf-8', body: '<!doctype html>' };
  const fetchImpl = fakeFetch({ '/sfx/fork.ogg': html, '/sfx/fork.mp3': html });
  assert.equal(await loadSfx('fork', { fetchImpl, decode }), null);
  const throwing = async () => {
    throw new TypeError('network');
  };
  assert.equal(await loadSfx('fork', { fetchImpl: throwing, decode }), null);
});
