import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install } from './music.js';

// Exercise the installed feature across DOM gestures, storage and async audio
// loading, without requiring a speaker or browser in the Node test suite.
function setup(t, saved = {}) {
  class Element extends EventTarget {
    style = {};
    attributes = {};
    children = [];
    value = '';
    setAttribute(key, value) { this.attributes[key] = value; }
    appendChild(child) { this.children.push(child); }
    contains(child) { return child === this || this.children.includes(child); }
    querySelector(tag) {
      return this.children.find(child => child.tag === tag)
        ?? this.children[this.children.push(Object.assign(new Element(), { tag })) - 1];
    }
  }
  const document = Object.assign(new EventTarget(), {
    body: new Element(),
    createElement: () => new Element(),
  });
  const storage = new Map(Object.entries(saved));
  const contexts = [];
  const requests = [];
  let fetchResult = async () => ({ ok: true, headers: new Headers({ 'content-type': 'audio/mpeg' }), arrayBuffer: async () => new ArrayBuffer(8) });
  class AudioContext {
    state = 'suspended';
    currentTime = 0;
    destination = {};
    sources = [];
    resumes = 0;
    constructor() { contexts.push(this); }
    createGain() {
      this.gainNode = { gain: { value: 0, setTargetAtTime(value) { this.value = value; } }, connect() {} };
      return this.gainNode;
    }
    async resume() { this.resumes++; this.state = 'running'; }
    async decodeAudioData() { return { duration: 32 }; }
    createBufferSource() {
      const source = { starts: 0, connect() {}, start() { this.starts++; } };
      this.sources.push(source);
      return source;
    }
  }
  for (const [key, value] of Object.entries({ document, AudioContext,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch: async url => { requests.push(url); return fetchResult(); },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  install();
  const controls = document.body.children[0];
  return {
    document, controls, button: controls.querySelector('button'), slider: controls.querySelector('input'),
    contexts, storage, requests,
    fetchWith: fn => { fetchResult = fn; },
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const emit = (target, type) => target.dispatchEvent(new Event(type));

test('music waits for a gesture and rapid gestures share one looping source', async t => {
  const s = setup(t);
  assert.equal(s.contexts.length, 0);
  assert.equal(s.requests.length, 0);
  assert.equal(s.slider.value, '15');
  emit(s.document, 'pointerdown');
  emit(s.document, 'click');
  emit(s.document, 'keydown');
  await settle();
  assert.deepEqual(s.requests, ['/music/halo-menu-chant.mp3']);
  const ac = s.contexts[0];
  assert.equal(ac.sources.length, 1);
  assert.equal(ac.sources[0].starts, 1);
  assert.equal(ac.sources[0].loop, true);
  assert.equal(ac.gainNode.gain.value, 0.15);
  ac.state = 'suspended';
  emit(s.document, 'click');
  await settle();
  assert.equal(ac.state, 'running');
  assert.equal(ac.sources.length, 1, 'resuming a suspended context must not duplicate the loop');
});

test('saved music mute prevents startup and controls leave SFX preferences alone', async t => {
  const s = setup(t, { 'obelisks.music.volume': '0.4', 'obelisks.music.muted': '1', 'obelisks.muted': '1' });
  emit(s.document, 'click');
  assert.equal(s.contexts.length, 0);
  assert.equal(s.slider.value, '40');
  assert.equal(s.button.attributes['aria-label'], 'Unmute background music');
  emit(s.button, 'click');
  await settle();
  const ac = s.contexts[0];
  assert.equal(ac.gainNode.gain.value, 0.4);
  s.slider.value = '27';
  emit(s.slider, 'input');
  emit(s.button, 'click');
  assert.equal(ac.gainNode.gain.value, 0);
  assert.equal(s.storage.get('obelisks.music.volume'), '0.27');
  assert.equal(s.storage.get('obelisks.music.muted'), '1');
  assert.equal(s.storage.get('obelisks.muted'), '1');
  emit(s.button, 'click');
  await settle();
  assert.equal(ac.gainNode.gain.value, 0.27, 'unmute restores the selected volume');
  assert.equal(ac.sources.length, 1);
});

test('muting while audio loads keeps the completed loop silent', async t => {
  const s = setup(t);
  let finish;
  s.fetchWith(() => new Promise(resolve => { finish = resolve; }));
  emit(s.document, 'click');
  await settle();
  emit(s.button, 'click');
  finish({ ok: true, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(8) });
  await settle();
  assert.equal(s.contexts[0].sources.length, 1);
  assert.equal(s.contexts[0].gainNode.gain.value, 0);
  assert.equal(s.button.attributes['aria-pressed'], 'true');
});

test('HTML fallback fails visibly and only an explicit retry reloads the music', async t => {
  const s = setup(t);
  s.fetchWith(async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/html' }) }));
  emit(s.document, 'click');
  await settle();
  assert.equal(s.button.textContent, 'Retry');
  assert.equal(s.contexts[0].sources.length, 0);
  emit(s.document, 'click');
  await settle();
  assert.equal(s.requests.length, 1);
  s.fetchWith(async () => ({ ok: true, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(8) }));
  emit(s.button, 'click');
  await settle();
  assert.equal(s.contexts[0].sources.length, 1);
  assert.equal(s.button.textContent, 'Mute');
});

test('zero volume persists without downloading until raised', async t => {
  const s = setup(t, { 'obelisks.music.volume': '0' });
  emit(s.document, 'click');
  assert.equal(s.contexts.length, 0);
  s.slider.value = '10';
  emit(s.slider, 'input');
  await settle();
  assert.equal(s.contexts[0].gainNode.gain.value, 0.1);
});

test('invalid saved volume falls back to the quiet default', t => {
  const s = setup(t, { 'obelisks.music.volume': 'NaN' });
  assert.equal(s.slider.value, '15');
});
