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

const { createTimeline, createPlayer, playGap, timeOf, FRAME_TYPES, MAX_PLAY_GAP_MS } = await import('./timeline.js');

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
  assert.equal(timeOf(tl.log[0]), 100, 'a frame without ts shows its arrival time');
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

test('play steps forward at the recorded pace until LIVE, and pause holds the frame', () => {
  const bus = fakeBus();
  let clock = 0;
  const gaps = [0, 200, 300, 100, 400];
  const tl = createTimeline(bus, { now: () => (clock += gaps.shift()) });
  for (const f of [session('a'), slab('a', 's1', 'one', 1), slab('a', 's2', 'two', 2), slab('a', 's3', 'three', 3), slab('a', 's4', 'four', 4)]) bus.emit(f.t, f);
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
