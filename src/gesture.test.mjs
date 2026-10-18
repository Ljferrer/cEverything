// Plan 6 under node: the pure decision functions, then the three features on a
// fake bus (PIN-80). One test per Commander's Intent End state 1 through 10.
// Nothing here loads room.js, obelisk.js, or troika.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { decide, beaconNext } from './gesture.js';
import { isClientCommand } from '../shared/protocol.mjs';
import { stateColor } from './colors.js';
import { install as installFork } from './features/fork.js';
import { install as installPipe } from './features/pipe.js';
import { install as installState } from './features/state.js';

function fakeBus() {
  const bus = Object.assign(new EventTarget(), { selected: null, selectedSlab: null, talking: null });
  bus.emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  return bus;
}
const frame = (bus, name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
const mode = (bus, canEdit) => frame(bus, 'mode', { t: 'mode', canEdit });
const select = (bus, sid, kind = 'base', slabId = null) => frame(bus, 'select', { sid, kind, slabId });

function fakeObelisk(states, beacons) {
  return {
    children: [{ userData: { kind: 'base' }, material: { color: new THREE.Color() } }],
    setState(s) {
      states.push(s);
    },
    setBeacon(on) {
      beacons.push(on);
    },
    slabs: [],
  };
}
const hexOf = (status) => new THREE.Color(stateColor(status)).getHex();

test('ES1 decide with no selected slab forks the selected base', () => {
  for (const slab of [null, undefined]) {
    const result = decide({ kind: 'base', sid: 'a' }, slab);
    assert.deepStrictEqual(result, { t: 'fork', sid: 'a' });
    assert.equal(isClientCommand(result), true);
  }
});

test('ES2 decide with a slab of the same obelisk forks it', () => {
  const result = decide({ kind: 'base', sid: 'a' }, { sid: 'a', slabId: 's1' });
  assert.deepStrictEqual(result, { t: 'fork', sid: 'a' });
  assert.equal(isClientCommand(result), true);
});

test('ES3 decide with a slab of another obelisk pipes it', () => {
  const result = decide({ kind: 'base', sid: 'b' }, { sid: 'a', slabId: 's1' });
  assert.deepStrictEqual(result, { t: 'pipe', from: 'a', to: 'b', slab: 's1' });
  assert.equal(isClientCommand(result), true);
});

test('ES4 decide returns null for a slab select, no select, talking, and a raised beacon', () => {
  const anything = { sid: 'z', slabId: 's9' };
  assert.equal(decide({ kind: 'slab', sid: 'a', slabId: 's2' }, anything), null);
  assert.equal(decide(undefined, anything), null);
  assert.equal(decide({ kind: 'base', sid: 'a' }, null, 'a'), null);
  assert.equal(decide({ kind: 'base', sid: 'a' }, null, undefined, true), null);
});

test('ES5 fork.js sends a fork for a base select and clears the selected slab', (t) => {
  t.mock.method(console, 'log', () => {});
  const bus = fakeBus();
  const sent = [];
  const net = { send: (c) => sent.push(c) };
  installFork({ bus, net });
  mode(bus, true);
  bus.selectedSlab = { sid: 'a', slabId: 's1' };
  select(bus, 'a');
  assert.deepStrictEqual(sent, [{ t: 'fork', sid: 'a' }]);
  assert.equal(bus.selectedSlab, null);
});

test('ES6 pipe.js sends a pipe for a base select on another obelisk and a miss clears the slab', (t) => {
  t.mock.method(console, 'log', () => {});
  const bus = fakeBus();
  const sent = [];
  const net = { send: (c) => sent.push(c) };
  installPipe({ bus, net });
  mode(bus, true);
  bus.selectedSlab = { sid: 'a', slabId: 's1' };
  select(bus, 'b');
  assert.deepStrictEqual(sent, [{ t: 'pipe', from: 'a', to: 'b', slab: 's1' }]);
  assert.equal(bus.selectedSlab, null);
  bus.selectedSlab = { sid: 'a', slabId: 's1' };
  frame(bus, 'miss', {});
  assert.equal(bus.selectedSlab, null);
  assert.equal(sent.length, 1);
});

test('ES7 fork.js throttles one fork per second per obelisk', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  mock.timers.enable({ apis: ['Date'] });
  try {
    const bus = fakeBus();
    const sent = [];
    const net = { send: (c) => sent.push(c) };
    installFork({ bus, net });
    mode(bus, true);
    select(bus, 'a');
    mock.timers.tick(200);
    select(bus, 'a');
    assert.deepStrictEqual(sent, [{ t: 'fork', sid: 'a' }]);
    select(bus, 'b');
    assert.deepStrictEqual(sent, [
      { t: 'fork', sid: 'a' },
      { t: 'fork', sid: 'b' },
    ]);
    mock.timers.tick(900);
    select(bus, 'a');
    assert.deepStrictEqual(sent, [
      { t: 'fork', sid: 'a' },
      { t: 'fork', sid: 'b' },
      { t: 'fork', sid: 'a' },
    ]);
    const lines = log.mock.calls.map((c) => c.arguments.join(' '));
    assert.ok(lines.includes('fork: suppressed throttled a'), lines.join('\n'));
    assert.equal(lines.filter((l) => l.startsWith('fork: send ')).length, 3);
  } finally {
    mock.timers.reset();
  }
});

test('ES8 a view-only client sends neither fork nor pipe and keeps its selection', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const bus = fakeBus();
  const sent = [];
  const net = { send: (c) => sent.push(c) };
  installFork({ bus, net });
  installPipe({ bus, net });
  select(bus, 'a');
  assert.deepStrictEqual(sent, []);
  mode(bus, false);
  select(bus, 'a');
  bus.selectedSlab = { sid: 'a', slabId: 's1' };
  select(bus, 'b');
  assert.deepStrictEqual(sent, []);
  assert.deepStrictEqual(bus.selectedSlab, { sid: 'a', slabId: 's1' });
  const lines = log.mock.calls.map((c) => c.arguments.join(' '));
  assert.ok(lines.includes('fork: suppressed view-only a'), lines.join('\n'));
  assert.ok(lines.includes('pipe: suppressed view-only b'), lines.join('\n'));
  mode(bus, true);
  bus.selectedSlab = null;
  select(bus, 'a');
  assert.deepStrictEqual(sent, [{ t: 'fork', sid: 'a' }]);
});

test('ES9 beaconNext is sticky on waiting and state.js lowers the beacon on select', async () => {
  assert.equal(beaconNext('idle', 'waiting'), 'raise');
  assert.equal(beaconNext(undefined, 'waiting'), 'raise');
  assert.equal(beaconNext('waiting', 'waiting'), 'keep');
  assert.equal(beaconNext('waiting', 'working'), 'none');
  assert.equal(beaconNext('working', 'idle'), 'none');

  const bus = fakeBus();
  const states = [];
  const beacons = [];
  const fakes = { a: fakeObelisk(states, beacons) };
  installState({ bus, getObelisk: (sid) => fakes[sid] });
  for (const status of ['waiting', 'working', 'idle']) bus.emit('state', { t: 'state', sid: 'a', status });
  assert.deepStrictEqual(states, ['waiting', 'working', 'idle']);
  assert.deepStrictEqual(beacons, [true]);
  assert.equal(bus.beacons.has('a'), true);
  bus.emit('select', { sid: 'a', kind: 'base', slabId: null });
  assert.equal(bus.beacons.has('a'), true); // fork.js and pipe.js read it before the microtask
  await Promise.resolve();
  assert.deepStrictEqual(beacons, [true, false]);
  assert.equal(bus.beacons.has('a'), false);
});

test('ES10 state.js sets the steady state color and stops the pulse on a steady status', () => {
  const bus = fakeBus();
  const states = [];
  const beacons = [];
  const fakes = { a: fakeObelisk(states, beacons) };
  const color = fakes.a.children[0].material.color;
  installState({ bus, getObelisk: (sid) => fakes[sid] });
  const tick = (now) => bus.emit('frame', { dt: 0.016, now });

  bus.emit('state', { t: 'state', sid: 'a', status: 'error' });
  assert.deepStrictEqual(states, ['error']);
  assert.equal(color.getHex(), hexOf('error'));
  bus.emit('state', { t: 'state', sid: 'a', status: 'waiting' });
  assert.equal(color.getHex(), hexOf('waiting'));
  bus.emit('state', { t: 'state', sid: 'a', status: 'idle' });
  assert.equal(color.getHex(), hexOf('idle'));

  bus.emit('state', { t: 'state', sid: 'a', status: 'working' });
  tick(250);
  const mid = color.getHex();
  assert.notEqual(mid, hexOf('working'));
  assert.notEqual(mid, hexOf('idle'));
  bus.emit('state', { t: 'state', sid: 'a', status: 'error' });
  tick(500);
  assert.equal(color.getHex(), hexOf('error'));
  tick(1000);
  assert.equal(color.getHex(), hexOf('error'));
});

test('ES11 state.js ignores live state and session frames while scrubbed and applies replayed ones', () => {
  const bus = fakeBus();
  const states = [];
  const beacons = [];
  const fakes = { a: fakeObelisk(states, beacons) };
  const color = fakes.a.children[0].material.color;
  installState({ bus, getObelisk: (sid) => fakes[sid] });

  bus.emit('state', { t: 'state', sid: 'a', status: 'idle' });
  bus.scrubbed = true;
  bus.emit('state', { t: 'state', sid: 'a', status: 'waiting' });
  bus.emit('session', { t: 'session', sid: 'a', status: 'error' });
  assert.deepStrictEqual(states, ['idle']);
  assert.deepStrictEqual(beacons, []);
  assert.equal(bus.beacons.has('a'), false);
  assert.equal(color.getHex(), hexOf('idle'));

  bus.emit('state', { t: 'state', sid: 'a', status: 'error', replayed: true });
  bus.emit('session', { t: 'session', sid: 'a', status: 'waiting', replayed: true });
  assert.deepStrictEqual(states, ['idle', 'error', 'waiting']);
  assert.deepStrictEqual(beacons, [true]);

  bus.scrubbed = false;
  bus.emit('state', { t: 'state', sid: 'a', status: 'idle' });
  assert.deepStrictEqual(states, ['idle', 'error', 'waiting', 'idle']);
});
