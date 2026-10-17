// voice.js under node with a real Bus and fakes for everything else: a
// resolve/load hook swaps troika-three-text for a three-free stub Text, and
// MediaRecorder, FileReader, the mic, the clock and setTimeout are faked, so
// neither three nor room.js loads. Covers the release paths of issues #22,
// #23 and #25 and the 300 ms hold before bus.talking is set.
import { registerHooks } from 'node:module';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const STUB_URL = new URL('./troika-stub.virtual.mjs', import.meta.url).href;
const STUB_SOURCE = `
export class Text {
  text = '';
  visible = true;
  position = { set() {} };
  sync() {}
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

// Browser globals voice.js touches.
const clicks = [];
globalThis.location = { search: '' };
globalThis.document = { addEventListener: (type, fn) => type === 'click' && clicks.push(fn) };
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => ({ fake: 'stream' }) } },
  configurable: true,
});

let clock = 0;
Object.defineProperty(performance, 'now', { value: () => clock, configurable: true });

class FakeRecorder extends EventTarget {
  static all = [];
  state = 'inactive';
  mimeType = 'audio/webm';
  constructor() {
    super();
    FakeRecorder.all.push(this);
  }
  start() {
    this.state = 'recording';
  }
  // Like the real recorder: the final chunk and `stop` arrive in a later task.
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    setImmediate(() => {
      const data = new Event('dataavailable');
      data.data = new Blob(['audio']);
      this.dispatchEvent(data);
      this.dispatchEvent(new Event('stop'));
    });
  }
}
globalThis.MediaRecorder = FakeRecorder;

globalThis.FileReader = class {
  readAsDataURL() {
    setImmediate(() => {
      this.result = 'data:audio/webm;base64,YXVkaW8=';
      this.onload();
    });
  }
};

class FakeRecognizer {
  static stops = 0;
  start() {}
  stop() {
    FakeRecognizer.stops++;
  }
}
globalThis.webkitSpeechRecognition = FakeRecognizer;

const { Bus } = await import('../bus.js');
const { install } = await import('./voice.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

// Fake setTimeout and the performance clock move together.
function advance(ms) {
  clock += ms;
  mock.timers.tick(ms);
}

// A fresh install on its own bus, with edit mode on and obelisk s1 selected.
async function setup(t) {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const bus = new Bus();
  const sent = [];
  const talks = [];
  const renderer = { xr: new EventTarget() };
  const camera = { parent: {}, add() {} };
  install({ scene: { add() {} }, camera, renderer, bus, net: { send: (f) => sent.push(f) } });
  // The first install grabs the module-level mic stream through a VRButton click.
  for (const fn of clicks.splice(0)) fn({ target: { closest: () => true } });
  await flush();
  bus.emit('mode', { canEdit: true });
  bus.selected = 's1';
  bus.addEventListener('talk', (e) => talks.push(e.detail));
  return { bus, sent, talks, renderer };
}

const press = (bus, controller) => bus.emit('selectstart', { sid: 's1', controller });
const release = (bus, controller) => bus.emit('selectend', { sid: 's1', controller });
const lastRecorder = () => FakeRecorder.all.at(-1);

test('a full hold sets bus.talking at 300 ms and sends one voice frame on release', async (t) => {
  const { bus, sent, talks } = await setup(t);
  press(bus, 0);
  advance(299);
  assert.equal(bus.talking ?? null, null);
  advance(1);
  assert.equal(bus.talking, 's1');
  advance(200);
  release(bus, 0);
  assert.equal(bus.talking, null);
  await flush();
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, 'voice');
  assert.equal(sent[0].sid, 's1');
  assert.deepEqual(talks.at(-1), { phase: 'sent', sid: 's1', ms: 500 });
});

test('#22: a recorder that stops on its own before 300 ms never sets bus.talking', async (t) => {
  const { bus, sent } = await setup(t);
  const stopsBefore = FakeRecognizer.stops;
  press(bus, 0);
  const first = lastRecorder();
  advance(100);
  first.stop(); // a recorder error or an ended mic track, with no selectend
  await flush();
  advance(300); // the pending hold timer must not fire
  assert.equal(bus.talking ?? null, null);
  assert.ok(FakeRecognizer.stops > stopsBefore, 'the recognizer is stopped');
  assert.equal(sent.length, 0);
  // The take is released: the next press arms a new recorder.
  press(bus, 0);
  assert.notEqual(lastRecorder(), first);
  assert.equal(lastRecorder().state, 'recording');
});

test('#22: a recorder that stops on its own after 300 ms clears bus.talking', async (t) => {
  const { bus } = await setup(t);
  const stopsBefore = FakeRecognizer.stops;
  press(bus, 0);
  const first = lastRecorder();
  advance(400);
  assert.equal(bus.talking, 's1');
  first.stop();
  await flush();
  await flush();
  assert.equal(bus.talking, null);
  assert.ok(FakeRecognizer.stops > stopsBefore, 'the recognizer is stopped');
  press(bus, 0);
  assert.notEqual(lastRecorder(), first);
});

test('#23: selectend from another controller does not end the take', async (t) => {
  const { bus, sent } = await setup(t);
  press(bus, 0);
  const rec = lastRecorder();
  advance(400);
  press(bus, 1); // the other hand presses and releases
  release(bus, 1);
  await flush();
  assert.equal(rec.state, 'recording');
  assert.equal(bus.talking, 's1');
  assert.equal(sent.length, 0);
  release(bus, 0); // the hand that started the take ends it
  await flush();
  await flush();
  assert.equal(bus.talking, null);
  assert.equal(sent.length, 1);
});

test('#25: XR sessionend releases an open take and clears bus.talking', async (t) => {
  const { bus, sent, renderer } = await setup(t);
  const stopsBefore = FakeRecognizer.stops;
  press(bus, 0);
  const first = lastRecorder();
  advance(400);
  assert.equal(bus.talking, 's1');
  renderer.xr.dispatchEvent(new Event('sessionend')); // no selectend follows
  await flush();
  await flush();
  assert.equal(bus.talking, null);
  assert.equal(first.state, 'inactive');
  assert.ok(FakeRecognizer.stops > stopsBefore, 'the recognizer is stopped');
  assert.equal(sent.length, 0);
  // Voice works again on re-entry.
  press(bus, 0);
  assert.notEqual(lastRecorder(), first);
  assert.equal(lastRecorder().state, 'recording');
});

test('#25: sessionend before 300 ms leaves bus.talking unset', async (t) => {
  const { bus, renderer } = await setup(t);
  press(bus, 0);
  advance(100);
  renderer.xr.dispatchEvent(new Event('sessionend'));
  await flush();
  advance(300);
  assert.equal(bus.talking ?? null, null);
});
