// voice.js under node with a real Bus and fakes for everything else: a
// resolve/load hook swaps troika-three-text for a three-free stub Text, and
// MediaRecorder, FileReader, the mic, the clock and setTimeout are faked, so
// neither three nor room.js loads. Covers the release paths of issues #22,
// #23 and #25, the 300 ms hold before bus.talking is set, and #24 and #26 to #29.
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
const buttons = [];
globalThis.location = { search: '' };
globalThis.document = {
  addEventListener: (type, fn) => type === 'click' && clicks.push(fn),
  createElement: () => {
    const el = new EventTarget();
    el.style = {};
    el.textContent = '';
    return el;
  },
  body: { appendChild: (el) => buttons.push(el) },
};

// A fake mic stream with one audio track; `end()` ends it like a device change.
function fakeStream() {
  const track = { readyState: 'live' };
  return { getAudioTracks: () => [track], getTracks: () => [track], end: () => (track.readyState = 'ended') };
}
const streams = [];
// Tests swap this to hold a getUserMedia request pending.
let getUserMedia = async () => fakeStream();
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: {
      getUserMedia: async (c) => {
        const s = await getUserMedia(c);
        streams.push(s);
        return s;
      },
    },
  },
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
  static all = [];
  constructor() {
    FakeRecognizer.all.push(this);
  }
  start() {}
  stop() {
    FakeRecognizer.stops++;
  }
}
globalThis.webkitSpeechRecognition = FakeRecognizer;

const { Bus } = await import('../bus.js');
const { decide } = await import('../gesture.js');
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
  const camera = { parent: {}, children: [], add: (c) => camera.children.push(c) };
  install({ scene: { add() {} }, camera, renderer, bus, net: { send: (f) => sent.push(f) } });
  // The first install grabs the module-level mic stream through a VRButton click.
  for (const fn of clicks.splice(0)) fn({ target: { closest: () => true } });
  await flush();
  bus.emit('mode', { canEdit: true });
  bus.selected = 's1';
  bus.addEventListener('talk', (e) => talks.push(e.detail));
  // The glyph's REC label is the first text added to the camera, the interim text the second.
  return { bus, sent, talks, renderer, label: camera.children[0], interim: camera.children[1] };
}

const press = (bus, controller) => bus.emit('selectstart', { sid: 's1', controller });
const release = (bus, controller) => bus.emit('selectend', { sid: 's1', controller });

// Like xr.js on a real release: the base `select` comes before `selectend`.
// Returns what plan 6's fork and pipe decide for that `select`.
function releaseOnBase(bus, controller) {
  const select = { kind: 'base', sid: 's1' };
  const cmd = decide(select, bus.selectedSlab, bus.talking ?? null, false);
  release(bus, controller);
  return cmd;
}
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

test('#22: a recorder that stops on its own before 300 ms keeps the hold until its selectend', async (t) => {
  const { bus, sent, talks } = await setup(t);
  const stopsBefore = FakeRecognizer.stops;
  press(bus, 0);
  const first = lastRecorder();
  advance(100);
  first.stop(); // a recorder error, with no selectend
  await flush();
  assert.ok(FakeRecognizer.stops > stopsBefore, 'the recognizer is stopped');
  assert.deepEqual(talks.at(-1), { phase: 'dropped', sid: 's1', ms: 0 });
  advance(300); // still held past 300 ms: not a plain select
  assert.equal(bus.talking, 's1');
  assert.equal(releaseOnBase(bus, 0), null, 'the release select does not fork or pipe');
  assert.equal(bus.talking, null);
  await flush();
  assert.equal(sent.length, 0);
  // The take is released: the next press arms a new recorder.
  press(bus, 0);
  assert.notEqual(lastRecorder(), first);
  assert.equal(lastRecorder().state, 'recording');
});

test('#22: a recorder that stops on its own after 300 ms keeps bus.talking until its selectend', async (t) => {
  const { bus, sent } = await setup(t);
  const stopsBefore = FakeRecognizer.stops;
  press(bus, 0);
  const first = lastRecorder();
  advance(400);
  assert.equal(bus.talking, 's1');
  first.stop();
  await flush();
  await flush();
  assert.ok(FakeRecognizer.stops > stopsBefore, 'the recognizer is stopped');
  assert.equal(bus.talking, 's1');
  release(bus, 1); // another controller does not end it
  assert.equal(bus.talking, 's1');
  assert.equal(releaseOnBase(bus, 0), null, 'the release select does not fork or pipe');
  assert.equal(bus.talking, null);
  await flush();
  assert.equal(sent.length, 0);
  press(bus, 0);
  assert.notEqual(lastRecorder(), first);
  assert.equal(lastRecorder().state, 'recording');
});

test('#22: a short press after a self-stop is still a plain select', async (t) => {
  const { bus } = await setup(t);
  press(bus, 0);
  lastRecorder().stop();
  await flush();
  advance(100);
  assert.deepEqual(releaseOnBase(bus, 0), decide({ kind: 'base', sid: 's1' }, null, null, false));
  advance(300);
  assert.equal(bus.talking ?? null, null);
});

test('a selectend between a self-stop and its stop event sends the take once', async (t) => {
  const { bus, sent } = await setup(t);
  press(bus, 0);
  advance(400);
  lastRecorder().stop(); // inactive now, `stop` event still queued
  release(bus, 0);
  await flush();
  await flush();
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(bus.talking, null);
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
  const { bus, sent, talks, renderer, label } = await setup(t);
  const stopsBefore = FakeRecognizer.stops;
  press(bus, 0);
  const first = lastRecorder();
  advance(400);
  assert.equal(bus.talking, 's1');
  assert.equal(label.visible, true);
  renderer.xr.dispatchEvent(new Event('sessionend')); // no selectend follows
  assert.equal(label.visible, false);
  await flush();
  await flush();
  assert.equal(bus.talking, null);
  assert.equal(first.state, 'inactive');
  assert.ok(FakeRecognizer.stops > stopsBefore, 'the recognizer is stopped');
  assert.equal(sent.length, 0);
  assert.deepEqual(
    talks.filter((x) => x.phase === 'dropped'),
    [{ phase: 'dropped', sid: 's1', ms: 0 }],
  );
  // Voice works again on re-entry.
  press(bus, 0);
  assert.notEqual(lastRecorder(), first);
  assert.equal(lastRecorder().state, 'recording');
});

test('#25: sessionend before 300 ms leaves bus.talking unset', async (t) => {
  const { bus, renderer } = await setup(t);
  press(bus, 0);
  const first = lastRecorder();
  assert.equal(first.state, 'recording');
  advance(100);
  renderer.xr.dispatchEvent(new Event('sessionend'));
  assert.equal(first.state, 'inactive');
  await flush();
  advance(300);
  assert.equal(bus.talking ?? null, null);
});

test('#25: sessionend after a self-stop drops the take once', async (t) => {
  const { bus, talks, renderer } = await setup(t);
  press(bus, 0);
  advance(400);
  lastRecorder().stop();
  await flush();
  renderer.xr.dispatchEvent(new Event('sessionend'));
  await flush();
  assert.equal(bus.talking, null);
  assert.equal(talks.filter((x) => x.phase === 'dropped').length, 1);
  press(bus, 0);
  assert.equal(lastRecorder().state, 'recording');
});

test('#25: a late stop from a dropped take leaves the next take alone', async (t) => {
  const { bus, sent, talks, renderer } = await setup(t);
  press(bus, 0);
  advance(400);
  renderer.xr.dispatchEvent(new Event('sessionend'));
  press(bus, 0); // re-entry before the old recorder's `stop` event
  const second = lastRecorder();
  await flush();
  await flush();
  assert.equal(second.state, 'recording');
  assert.equal(talks.filter((x) => x.phase === 'dropped').length, 1);
  advance(400);
  assert.equal(bus.talking, 's1');
  release(bus, 0);
  await flush();
  await flush();
  assert.equal(sent.length, 1);
});

test('#24: a late recognizer result after release does not re-show the interim text', async (t) => {
  const { bus, interim } = await setup(t);
  press(bus, 0);
  const recognizer = FakeRecognizer.all.at(-1);
  advance(400);
  recognizer.onresult?.({ results: [[{ transcript: 'hello' }]] });
  assert.equal(interim.visible, true);
  release(bus, 0);
  await flush();
  await flush();
  assert.equal(interim.visible, false);
  // A final result that lands after stop() and after the glyph hid.
  recognizer.onresult?.({ results: [[{ transcript: 'hello there' }]] });
  assert.equal(interim.visible, false);
});

test('#26: an ended mic track is not armed, and the next VRButton click gets a new stream', async (t) => {
  const { bus, talks } = await setup(t);
  const old = streams.at(-1);
  old.end();
  const recordersBefore = FakeRecorder.all.length;
  press(bus, 0);
  assert.equal(FakeRecorder.all.length, recordersBefore, 'no recorder on a dead stream');
  assert.deepEqual(talks.at(-1), { phase: 'error', sid: 's1' });
  // A fresh install's VRButton click re-requests the mic.
  mock.timers.reset();
  const { bus: bus2 } = await setup(t);
  assert.notEqual(streams.at(-1), old, 'a new stream was requested');
  press(bus2, 0);
  assert.equal(lastRecorder().state, 'recording');
  advance(400);
  release(bus2, 0);
  await flush();
  await flush();
});

test('#27: a missing MediaRecorder global reports a talk error instead of throwing', async (t) => {
  const { bus, talks } = await setup(t);
  delete globalThis.MediaRecorder;
  t.after(() => (globalThis.MediaRecorder = FakeRecorder));
  assert.doesNotThrow(() => press(bus, 0));
  assert.deepEqual(talks.at(-1), { phase: 'error', sid: 's1' });
});

test('#28: a release past 300 ms before the hold timer runs is a plain select and sends nothing', async (t) => {
  const { bus, sent, talks } = await setup(t);
  press(bus, 0);
  clock += 301; // the wall clock passed 300 ms, the timer task has not run yet
  const cmd = releaseOnBase(bus, 0);
  assert.deepEqual(cmd, { t: 'fork', sid: 's1' }, 'fork reads bus.talking unset');
  await flush();
  await flush();
  assert.equal(sent.length, 0, 'the same press does not also talk');
  assert.equal(talks.at(-1).phase, 'dropped');
  advance(300);
  assert.equal(bus.talking ?? null, null);
});

test('#29: a second Enable mic click while the request is pending does not read Mic failed', async (t) => {
  // A fresh module instance, so no mic stream is held yet.
  const fresh = await import('./voice.js?mic-button');
  location.search = '?mic=button';
  t.after(() => (location.search = ''));
  let grant;
  getUserMedia = () => new Promise((resolve) => (grant = () => resolve(fakeStream())));
  t.after(() => (getUserMedia = async () => fakeStream()));
  fresh.install({
    scene: { add() {} },
    camera: { parent: {}, add() {} },
    renderer: { xr: new EventTarget() },
    bus: new Bus(),
    net: { send() {} },
  });
  const button = buttons.at(-1);
  assert.equal(button.textContent, 'Enable mic');
  button.dispatchEvent(new Event('click'));
  button.dispatchEvent(new Event('click'));
  await flush();
  assert.notEqual(button.textContent, 'Mic failed');
  grant();
  await flush();
  assert.equal(button.textContent, 'Mic on');
});
