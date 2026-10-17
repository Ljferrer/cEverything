// laptop.js say box wiring under node with a fake bus and fake DOM nodes: a
// resolve/load hook swaps troika-three-text (pulled in through room.js) for a
// stub, so no renderer and no DOM load. Covers the relay error line and the
// say box target title.
import { registerHooks } from 'node:module';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const STUB_URL = new URL('./troika-stub.virtual.mjs', import.meta.url).href;
const STUB_SOURCE = `
import { Object3D } from 'three';
export class Text extends Object3D {
  text = '';
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

const { showErrors, showTarget, ERROR_MS } = await import('./laptop.js');

function fakeBus() {
  const bus = Object.assign(new EventTarget(), { selected: null, selectedSlab: null, talking: null });
  bus.emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  return bus;
}

test('an error frame shows its text for 4 s, and a second error restarts the timer', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    assert.equal(ERROR_MS, 4000);
    const bus = fakeBus();
    const node = { textContent: '', hidden: true };
    showErrors(bus, node);

    bus.emit('error', { t: 'error', text: 'no command: say' });
    assert.equal(node.textContent, 'no command: say');
    assert.equal(node.hidden, false);
    mock.timers.tick(ERROR_MS - 1);
    assert.equal(node.hidden, false);
    mock.timers.tick(1);
    assert.equal(node.hidden, true);

    bus.emit('error', { t: 'error', text: 'read-only harness' });
    mock.timers.tick(3000);
    bus.emit('error', { t: 'error', text: 'bad json' });
    assert.equal(node.textContent, 'bad json');
    mock.timers.tick(3000); // 6 s after the first of the two, 3 s after the second
    assert.equal(node.hidden, false);
    mock.timers.tick(1000);
    assert.equal(node.hidden, true);
  } finally {
    mock.timers.reset();
  }
});

test('the say box target shows the obelisk title, else the sid', () => {
  const bus = fakeBus();
  const node = { textContent: 'select an obelisk' };
  const obelisks = {
    a: { session: { sid: 'a', title: 'fix the voice hold' } },
    b: { session: { sid: 'b', title: '' } },
  };
  showTarget(bus, node, (sid) => obelisks[sid] ?? null);

  bus.emit('select', { sid: 'a', kind: 'base', slabId: null });
  assert.equal(node.textContent, 'to fix the voice hold');
  bus.emit('select', { sid: 'b', kind: 'base', slabId: null });
  assert.equal(node.textContent, 'to b');
  bus.emit('select', { sid: '19f10a9b-gone', kind: 'base', slabId: null });
  assert.equal(node.textContent, 'to 19f10a9b-gone');
});

test('the say box target follows a retitle of the selected obelisk only', () => {
  const bus = fakeBus();
  const node = { textContent: 'select an obelisk' };
  showTarget(bus, node, (sid) => ({ session: { sid, title: 'old title' } }));

  bus.emit('session', { t: 'session', sid: 'a', title: 'before any select' });
  assert.equal(node.textContent, 'select an obelisk');
  bus.emit('select', { sid: 'a', kind: 'base', slabId: null });
  assert.equal(node.textContent, 'to old title');
  bus.emit('session', { t: 'session', sid: 'b', title: 'another chat' });
  assert.equal(node.textContent, 'to old title');
  bus.emit('session', { t: 'session', sid: 'a', title: 'new title' });
  assert.equal(node.textContent, 'to new title');
  bus.emit('session', { t: 'session', sid: 'a', title: '' });
  assert.equal(node.textContent, 'to a');
});
