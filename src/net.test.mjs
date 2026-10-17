import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../server/relay.mjs';
import { createBus } from './bus.js';
import { createNet, relayUrl } from './net.js';

const relays = [];
after(async () => {
  for (const r of relays) await r.close();
});

const once = (bus, type, ms = 15000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${type} event`)), ms);
    bus.addEventListener(type, (e) => (clearTimeout(t), resolve(e.detail)), { once: true });
  });

test('relayUrl forwards the page key and picks wss on https', () => {
  assert.equal(relayUrl({ protocol: 'https:', host: 'demo.trycloudflare.com', search: '?key=edit&mode=laptop' }), 'wss://demo.trycloudflare.com/relay?key=edit');
  assert.equal(relayUrl({ protocol: 'http:', host: 'localhost:5173', search: '' }), 'ws://localhost:5173/relay');
});

test('net re-emits server events on the bus under their t and sends commands', async () => {
  const r = await startRelay({ port: 0, sources: ['synthetic'], log: () => {} });
  relays.push(r);
  const bus = createBus();
  const net = createNet(bus, { url: `ws://127.0.0.1:${r.port}/relay?key=edit` });
  const mode = await once(bus, 'mode');
  assert.deepEqual(mode, { t: 'mode', mode: 'synthetic', canEdit: true });
  const session = await once(bus, 'session');
  assert.equal(session.harness, 'synthetic');
  net.send({ t: 'fork', sid: session.sid });
  const err = await once(bus, 'error');
  assert.equal(err.text, 'no command: fork');
  net.close();
});

test('a viewer net gets canEdit:false and the view-only error', async () => {
  const r = await startRelay({ port: 0, sources: ['synthetic'], log: () => {} });
  relays.push(r);
  const bus = createBus();
  const net = createNet(bus, { url: `ws://127.0.0.1:${r.port}/relay` });
  net.send({ t: 'say', sid: 'syn-a', text: 'queued before open' });
  const mode = await once(bus, 'mode');
  assert.equal(mode.canEdit, false);
  const err = await once(bus, 'error');
  assert.equal(err.text, 'view-only link');
  net.close();
});

test('bus carries selected and selectedSlab', () => {
  const bus = createBus();
  assert.equal(bus.selected, null);
  assert.equal(bus.selectedSlab, null);
  let got;
  bus.addEventListener('select', (e) => (got = e.detail));
  bus.emit('select', { sid: 'a', kind: 'base' });
  assert.deepEqual(got, { sid: 'a', kind: 'base' });
});
