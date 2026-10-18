// timeline.js under node with a fake bus: the frame log, the frames re-emitted
// for a scrub to k, the room.js gate while scrubbed, and LIVE catching up. The
// gate tests drive the real room.js through the troika stub hook that
// room.test.mjs uses, so a scrub really rebuilds obelisks.
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const STUB_URL = new URL('./troika-stub.virtual.mjs', import.meta.url).href;
const STUB_SOURCE = `
import { Object3D } from 'three';
export class Text extends Object3D {
  text = '';
  sync() {}
  dispose() {}
}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'troika-three-text') return { url: STUB_URL, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === STUB_URL) return { format: 'module', source: STUB_SOURCE, shortCircuit: true };
    return next(url, context);
  },
});

const { createTimeline, createPlayer, playGap, timeOf, toolStartFor, FRAME_TYPES, MAX_PLAY_GAP_MS, SPEEDS, DEFAULT_SPEED } = await import('./timeline.js');

function fakeBus() {
  const bus = Object.assign(new EventTarget(), { selected: null, selectedSlab: null });
  bus.emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  return bus;
}

/** Every event of FRAME_TYPES the bus dispatches, as {type, detail}. */
function spy(bus) {
  const seen = [];
  for (const type of FRAME_TYPES) bus.addEventListener(type, (e) => seen.push({ type, detail: e.detail }));
  return seen;
}

const session = (sid, status = 'working') => ({ t: 'session', sid, harness: 'synthetic', kind: 'chat', title: sid, status, parent: null, phase: null });
const slab = (sid, id, text, ts) => ({ t: 'slab', sid, id, role: 'assistant', text, ts });
const tool = (sid, id) => ({ t: 'tool', sid, id, name: 'Bash', phase: 'start', args: { command: 'ls' } });

test('the log keeps every server frame in arrival order with its arrival time, and skips replayed frames', () => {
  const bus = fakeBus();
  let clock = 100;
  const tl = createTimeline(bus, { now: () => clock++ });
  bus.emit('session', session('a'));
  bus.emit('slab', slab('a', 's1', 'hi', 5000));
  bus.emit('delta', { t: 'delta', sid: 'a', id: 's1', role: 'assistant', text: '!' });
  bus.emit('state', { t: 'state', sid: 'a', status: 'idle' });
  bus.emit('tool', tool('a', 't1'));
  bus.emit('mode', { t: 'mode', mode: 'synthetic', canEdit: true });
  bus.emit('slab', { ...slab('a', 's2', 'x', 1), replayed: true });
  assert.deepEqual(tl.log.map((e) => e.type), ['session', 'slab', 'delta', 'state', 'tool']);
  assert.deepEqual(tl.log.map((e) => e.at), [100, 101, 102, 103, 104]);
  assert.equal(timeOf(tl.log[1]), 5000, 'a frame with ts shows its own time');
  assert.ok(timeOf(tl.log[0]) < 5000 && timeOf(tl.log[0]) > 4999, 'a session sits just before its first slab');
  assert.equal(timeOf(tl.log[4]), 5000, 'a tool frame with no ts takes the time of the frame before it in its chat');
  assert.equal(tl.live, true);
  assert.equal(tl.index, 4);
  tl.stop();
  bus.emit('session', session('b'));
  assert.equal(tl.log.length, 5, 'stop() stops recording');
});

test('a scrub to k resets the room once, then re-emits frames 0..k in order, each marked replayed', () => {
  const bus = fakeBus();
  const order = [];
  const tl = createTimeline(bus, { reset: () => order.push('reset') });
  const frames = [session('a'), slab('a', 's1', 'one', 1), slab('a', 's2', 'two', 2), tool('a', 't1')];
  for (const f of frames) bus.emit(f.t, f);
  const seen = spy(bus);
  bus.addEventListener('slab', () => order.push('slab'));
  tl.scrubTo(2);
  assert.equal(order[0], 'reset');
  assert.deepEqual(seen.map((s) => s.detail.id ?? s.detail.sid), ['a', 's1', 's2']);
  assert.ok(seen.every((s) => s.detail.replayed === true));
  assert.deepEqual(seen.map((s) => ({ ...s.detail, replayed: undefined })), frames.slice(0, 3).map((f) => ({ ...f, replayed: undefined })));
  assert.equal(frames[1].replayed, undefined, 'the logged frame itself is never mutated');
  assert.equal(tl.log.length, 4, 're-emitted frames are not recorded again');
  assert.equal(bus.scrubbed, true);
  assert.equal(tl.live, false);
  assert.equal(tl.index, 2);
});

test('a scrub to the newest frame is LIVE, and LIVE while live re-emits nothing', () => {
  const bus = fakeBus();
  let resets = 0;
  const tl = createTimeline(bus, { reset: () => resets++ });
  bus.emit('session', session('a'));
  bus.emit('slab', slab('a', 's1', 'one', 1));
  tl.goLive();
  assert.equal(resets, 0);
  tl.scrubTo(0);
  tl.scrubTo(99);
  assert.equal(tl.live, true);
  assert.equal(bus.scrubbed, false);
  assert.equal(resets, 2, 'one rebuild for the scrub, one for the catch-up');
});

async function roomOnBus() {
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
  });
  const room = await import(`./room.js?timeline=${Math.random()}`);
  const bus = fakeBus();
  const scene = new THREE.Scene();
  room.install({ scene, bus });
  const tl = createTimeline(bus, { reset: room.reset });
  const roomGroup = scene.getObjectByName('room');
  const texts = (sid) => room.getObelisk(sid)?.slabs.map((s) => s.full) ?? null;
  return { room, bus, tl, roomGroup, texts };
}

test('while scrubbed, live frames record but leave the room as it stood at k', async () => {
  const { room, bus, tl, roomGroup, texts } = await roomOnBus();
  bus.emit('session', session('a'));
  bus.emit('slab', slab('a', 's1', 'one', 1));
  bus.emit('session', session('b'));
  bus.emit('slab', slab('a', 's2', 'two', 2));
  const posA = room.getObelisk('a').position.clone();

  tl.scrubTo(1);
  assert.deepEqual(texts('a'), ['one']);
  assert.equal(room.getObelisk('b'), null, 'b had not arrived at frame 1');
  assert.ok(room.getObelisk('a').position.equals(posA), 'the rebuilt obelisk stands in its stored slot');
  assert.equal(roomGroup.children.filter((c) => c.sid).length, 1, 'reset removed the old obelisks from the scene');

  bus.emit('session', session('c'));
  bus.emit('slab', slab('a', 's3', 'three', 3));
  bus.emit('state', { t: 'state', sid: 'a', status: 'error' });
  assert.equal(room.getObelisk('c'), null, 'a live session is gated');
  assert.deepEqual(texts('a'), ['one'], 'a live slab is gated');
  assert.equal(tl.log.length, 7, 'live frames keep recording while scrubbed');
});

test('LIVE re-renders everything up to the newest frame, and live frames apply again', async () => {
  const { room, bus, tl, texts } = await roomOnBus();
  bus.emit('session', session('a'));
  bus.emit('slab', slab('a', 's1', 'one', 1));
  tl.scrubTo(0);
  bus.emit('session', session('b'));
  bus.emit('slab', slab('a', 's2', 'two', 2));
  assert.deepEqual(texts('a'), []);

  tl.goLive();
  assert.equal(bus.scrubbed, false);
  assert.deepEqual(texts('a'), ['one', 'two']);
  assert.ok(room.getObelisk('b'));
  bus.emit('slab', slab('b', 's3', 'live', 3));
  assert.deepEqual(texts('b'), ['live']);
});

test('pylons.js fires no projectile for a replayed start and ignores live tools while scrubbed', async () => {
  const { install } = await import('./pylons.js');
  const bus = fakeBus();
  const scene = new THREE.Scene();
  install({ scene, bus, getObelisk: (sid) => (sid === 'a' ? new THREE.Object3D() : null) });
  const flying = () => {
    let n = 0;
    scene.getObjectByName('pylons').traverse((o) => (n += o.isMesh && o.visible && o.geometry?.type === 'SphereGeometry' ? 1 : 0));
    return n;
  };
  bus.emit('tool', { ...tool('a', 't1'), replayed: true });
  assert.equal(flying(), 0, 'a replayed start fires nothing');
  bus.scrubbed = true;
  bus.emit('tool', tool('a', 't2'));
  assert.equal(flying(), 0, 'a live start while scrubbed fires nothing');
  bus.scrubbed = false;
  bus.emit('tool', tool('a', 't3'));
  assert.equal(flying(), 1, 'a live start fires once the timeline is live');
  let traced = 0;
  scene.getObjectByName('pylons').traverse((o) => (traced += o.isLine && !o.isLineSegments && o.visible ? 1 : 0));
  assert.equal(traced, 1, 'the fired start leaves a tracer from the tool call to its pylon');
  bus.scrubbed = true;
  bus.emit('tool', { ...tool('a', 't4'), replayed: true, playback: true });
  assert.equal(flying(), 2, 'a start stepped through on Play fires like live');
});

/** A manual clock for createPlayer: `run()` fires the pending timer and returns its delay. */
function fakeTimers() {
  let next = null;
  return {
    setTimer: (fn, ms) => ((next = { fn, ms }), next),
    clearTimer: (t) => next === t && (next = null),
    get pending() {
      return next;
    },
    run() {
      const t = next;
      next = null;
      t.fn();
      return t.ms;
    },
  };
}

test('advance shows the next frame by emitting only that frame, with no rebuild, and goes live at the newest', () => {
  const bus = fakeBus();
  let resets = 0;
  const tl = createTimeline(bus, { reset: () => resets++ });
  const frames = [session('a'), slab('a', 's1', 'one', 1), slab('a', 's2', 'two', 2), slab('a', 's3', 'three', 3)];
  for (const f of frames) bus.emit(f.t, f);
  tl.scrubTo(1);
  const seen = spy(bus);
  tl.advance();
  assert.equal(resets, 1, 'advance never resets the room');
  assert.deepEqual(seen.map((s) => s.detail.id), ['s2']);
  assert.ok(seen[0].detail.replayed);
  assert.ok(seen[0].detail.playback, 'a Play step is marked playback, so it animates and sounds');
  assert.equal(tl.index, 2);
  tl.advance();
  assert.equal(tl.live, true, 'the step to the newest frame is LIVE');
  assert.equal(bus.scrubbed, false);
});

test('playGap is the arrival gap to the next frame, capped at MAX_PLAY_GAP_MS', () => {
  const log = [{ at: 100 }, { at: 350 }, { at: 9000 }, { at: 8000 }];
  assert.equal(playGap(log, 0), 250);
  assert.equal(playGap(log, 1), MAX_PLAY_GAP_MS);
  assert.equal(playGap(log, 2), 0, 'a clock step backwards waits 0 ms');
  assert.equal(playGap(log, 3), 0, 'no next frame waits 0 ms');
});

test('playGap paces backfilled history by when frames happened, not when they arrived', () => {
  const log = [{ at: 5, frame: { ts: 1000 } }, { at: 5, frame: { ts: 1400 } }, { at: 5, key: 1400, frame: {} }, { at: 90, frame: { ts: 1 } }];
  assert.equal(playGap(log, 0), 400, 'frames that arrived together keep their recorded gap');
  assert.equal(playGap(log, 1), 0, 'a frame keyed to the frame before it plays at once');
  assert.equal(playGap(log, 2), 0, 'time never runs backward');
});

test('history sent chat by chat replays interleaved by wall time, so simultaneous chats play together', () => {
  const bus = fakeBus();
  let clock = 1_000_000; // the backfill lands now, long after the history it carries
  const tl = createTimeline(bus, { now: () => clock++ });
  // The relay sends chat a's whole history, then chat b's: the two ran at the same time.
  for (const f of [session('a'), slab('a', 'a1', 'a one', 100), slab('a', 'a2', 'a two', 300), slab('a', 'a3', 'a three', 500),
    { t: 'state', sid: 'a', status: 'idle' },
    session('b'), slab('b', 'b1', 'b one', 200), slab('b', 'b2', 'b two', 400)]) bus.emit(f.t, f);
  assert.deepEqual(
    tl.log.map((e) => (e.type === 'slab' ? e.frame.id : `${e.type}:${e.frame.sid}`)),
    ['session:a', 'a1', 'session:b', 'b1', 'a2', 'b2', 'a3', 'state:a'],
    'each session just before its first slab, every slab by its time, the state after its chat\'s last slab',
  );
  tl.scrubTo(0);
  const seen = spy(bus);
  for (let i = 0; i < 6; i++) tl.advance();
  assert.deepEqual(seen.map((x) => x.detail.id ?? x.detail.sid), ['a1', 'b', 'b1', 'a2', 'b2', 'a3'], 'Play steps through both chats in turn');
});

test('toolStartFor reads a tool slab as a tool start, and nothing else', () => {
  const ts = { t: 'slab', sid: 'a', id: 'tu1', role: 'tool', text: 'Bash ls /tmp', ts: 1 };
  assert.deepEqual(toolStartFor(ts), { t: 'tool', sid: 'a', id: 'tu1', name: 'Bash', phase: 'start' });
  assert.equal(toolStartFor({ ...ts, text: 'mcp__x__y\n{"a":1}' }).name, 'mcp__x__y');
  assert.equal(toolStartFor({ ...ts, role: 'assistant' }), null);
  assert.equal(toolStartFor({ ...ts, text: '' }), null);
  assert.equal(toolStartFor(tool('a', 'tu1')), null);
});

test('a Play step onto a backfilled tool slab emits its tool start after the slab; a logged start is never doubled', () => {
  const bus = fakeBus();
  const tl = createTimeline(bus);
  const toolSlab = (id) => ({ t: 'slab', sid: 'a', id, role: 'tool', text: 'Read {"file_path":"x"}', ts: 2 });
  for (const f of [session('a'), slab('a', 's1', 'one', 1), toolSlab('tu1'), toolSlab('tu2'), tool('a', 'tu2'), slab('a', 's2', 'two', 3)]) bus.emit(f.t, f);
  tl.scrubTo(1);
  const seen = spy(bus);
  tl.advance();
  assert.deepEqual(seen.map((s) => [s.type, s.detail.id]), [['slab', 'tu1'], ['tool', 'tu1']]);
  assert.deepEqual(seen[1].detail, { t: 'tool', sid: 'a', id: 'tu1', name: 'Read', phase: 'start', replayed: true, playback: true });
  seen.length = 0;
  tl.advance();
  tl.advance();
  assert.deepEqual(seen.map((s) => [s.type, s.detail.id]), [['slab', 'tu2'], ['tool', 'tu2']], 'tu2 has its own logged start, so only that one plays');
  seen.length = 0;
  tl.scrubTo(2);
  assert.equal(seen.filter((s) => s.type === 'tool').length, 0, 'a rebuild emits no tool starts');
});

test('a chat replays before its subagents even when the relay kept only its newer slabs', () => {
  const bus = fakeBus();
  let clock = 1_000_000;
  const tl = createTimeline(bus, { now: () => clock++ });
  const kid = { ...session('k'), kind: 'agent', parent: 'p' };
  const grandkid = { ...session('g'), kind: 'agent', parent: 'k' };
  // The parent's oldest slabs were trimmed: its first kept slab is newer than all of its subagents' work.
  for (const f of [session('p'), slab('p', 'p9', 'late', 900), kid, slab('k', 'k1', 'early', 100), grandkid, slab('g', 'g1', 'earlier', 50)]) bus.emit(f.t, f);
  const order = tl.log.map((e) => (e.type === 'session' ? `session:${e.frame.sid}` : e.frame.id));
  assert.deepEqual(order, ['session:p', 'session:k', 'session:g', 'g1', 'k1', 'p9']);
});

test('a session replays from when it started, not from its first kept slab', () => {
  const bus = fakeBus();
  const tl = createTimeline(bus, { now: () => 1_000_000 });
  // The relay kept only the late lines of a long subagent that started first.
  for (const f of [session('p'), { ...session('long'), kind: 'agent', parent: 'p', started: 100 }, slab('long', 'l9', 'late', 900),
    { ...session('short'), kind: 'agent', parent: 'p', started: 300 }, slab('short', 's1', 'early', 350)]) bus.emit(f.t, f);
  assert.deepEqual(tl.log.map((e) => (e.type === 'session' ? `session:${e.frame.sid}` : e.frame.id)), ['session:p', 'session:long', 'session:short', 's1', 'l9']);
});

test('play steps forward at the recorded pace until LIVE, and pause holds the frame', () => {
  const bus = fakeBus();
  const tl = createTimeline(bus);
  for (const [id, ts] of [['s0', 0], ['s1', 200], ['s2', 500], ['s3', 600], ['s4', 1000]]) bus.emit('slab', slab('a', id, id, ts));
  const timers = fakeTimers();
  let ticks = 0;
  const player = createPlayer(tl, { ...timers, onTick: () => ticks++ });

  player.play();
  assert.equal(player.playing, false, 'play does nothing while live');
  assert.equal(timers.pending, null);

  tl.scrubTo(0);
  player.play();
  assert.equal(player.playing, true);
  assert.equal(timers.run(), 200, 'the first wait is the gap from frame 0 to frame 1');
  assert.equal(tl.index, 1);
  assert.equal(timers.run(), 300);
  assert.equal(tl.index, 2);

  player.pause();
  assert.equal(player.playing, false);
  assert.equal(timers.pending, null, 'pause clears the timer');
  assert.equal(tl.index, 2, 'pause holds the frame');

  player.play();
  timers.run();
  assert.equal(tl.index, 3);
  timers.run();
  assert.equal(tl.live, true, 'playback reaches the newest frame and goes live');
  assert.equal(player.playing, false, 'playback stops at LIVE');
  assert.equal(timers.pending, null);
  assert.equal(ticks, 4);
});

test('play waits playGap divided by the speed, and a speed change applies from the next wait', () => {
  const bus = fakeBus();
  const tl = createTimeline(bus);
  for (const [id, ts] of [['s0', 0], ['s1', 400], ['s2', 800], ['s3', 1200], ['s4', 1600]]) bus.emit('slab', slab('a', id, id, ts));
  const timers = fakeTimers();
  let rate = 4;
  const player = createPlayer(tl, { ...timers, speed: () => rate });
  tl.scrubTo(0);
  player.play();
  rate = 0.5; // the wait already scheduled keeps its 4x delay
  assert.equal(timers.run(), 100, '400 ms at 4x waits 100 ms');
  assert.equal(timers.run(), 800, 'the next wait takes the new speed');
  assert.equal(SPEEDS[DEFAULT_SPEED], 1, 'the slider starts at real time');
});
