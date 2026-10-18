import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const STUB_URL = new URL('./troika-stub.virtual.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'troika-three-text') return { url: STUB_URL, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === STUB_URL) return { format: 'module', source: "import { Object3D } from 'three'; export class Text extends Object3D { text=''; sync(){} dispose(){} }", shortCircuit: true };
    return next(url, context);
  },
});
const THREE = await import('three');
const { pipedFrom, findSource, install, MAX_TRACES } = await import('./pipe-trace.js');

test('pipedFrom reads the source title of a piped message, else null', () => {
  assert.equal(pipedFrom('From Plan 2 (Hermes): hello: world'), 'Plan 2 (Hermes)');
  assert.equal(pipedFrom('hello'), null);
  assert.equal(pipedFrom(undefined), null);
});

test('findSource never picks the target and prefers the newest match', () => {
  const o = (sid, title) => ({ sid, session: { title } });
  const list = [o('a', 'A'), o('t', 'A'), o('b', 'A')];
  assert.equal(findSource('A', 't', list).sid, 'b');
  assert.equal(findSource('Z', 't', list), null);
});

test('a piped user slab draws one arc from source to target, a repeat id draws none, and old arcs are capped', () => {
  const scene = new THREE.Scene();
  const bus = new EventTarget();
  const mk = (sid, title, x) => Object.assign(new THREE.Object3D(), { sid, session: { title } }).translateX(x);
  const src = mk('s', 'Source chat', -3);
  const dst = mk('t', 'Target chat', 3);
  install({ scene, bus, getObelisks: () => [src, dst], findObelisk: (sid) => (sid === 't' ? dst : sid === 's' ? src : null) });
  const group = scene.getObjectByName('pipe-traces');
  const send = (id, text, role = 'user') => bus.dispatchEvent(new CustomEvent('slab', { detail: { t: 'slab', sid: 't', id, role, text } }));
  send('p1', 'From Source chat: look at this');
  assert.equal(group.children.filter((c) => c.isLine).length, 1);
  send('p1', 'From Source chat: look at this');
  send('n1', 'a plain message');
  send('a1', 'From Source chat: x', 'assistant');
  assert.equal(group.children.filter((c) => c.isLine).length, 1);
  for (let i = 0; i < MAX_TRACES + 5; i++) send(`q${i}`, 'From Source chat: more');
  assert.equal(group.children.filter((c) => c.isLine).length, MAX_TRACES);
});
