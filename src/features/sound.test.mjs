// sound.js pure parts under node, with no AudioContext and no DOM: the
// event-to-cue mapping, the ambient rate limiter, the pitch per pylon, and the
// net.send wrapper that must leave every sent frame unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMapper, createLimiter, isAmbient, pitchFor, PYLON_PITCH, wrapSend } from './sound.js';

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
