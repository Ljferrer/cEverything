import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startRelay } from '../server/relay.mjs';
import { createBus } from './bus.js';
import { createNet, relayUrl } from './net.js';
import { latchLast } from './input.js';

// Every relay and net is closed in `after`, so a failed assertion never leaves
// a reconnect loop that keeps the test process alive.
const relays = [];
const nets = [];
after(async () => {
  for (const n of nets) n.close();
  for (const r of relays) await r.close();
});
const openNet = (bus, url) => {
  const net = createNet(bus, { url });
  nets.push(net);
  return net;
};

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
  // An empty commands dir: the real server/commands/ now holds fork (plan 2).
  const commandsDir = await mkdtemp(path.join(tmpdir(), 'obelisks-net-nocmd-'));
  const r = await startRelay({ port: 0, sources: ['synthetic'], commandsDir, log: () => {} });
  relays.push(r);
  const bus = createBus();
  const net = openNet(bus, `ws://127.0.0.1:${r.port}/relay?key=edit`);
  const mode = await once(bus, 'mode');
  assert.deepEqual(mode, { t: 'mode', mode: 'synthetic', canEdit: true });
  const session = await once(bus, 'session');
  assert.equal(session.harness, 'synthetic');
  net.send({ t: 'fork', sid: session.sid });
  const err = await once(bus, 'error');
  assert.equal(err.text, 'no command: fork');
});

test('a viewer net gets canEdit:false and the view-only error', async () => {
  const r = await startRelay({ port: 0, sources: ['synthetic'], log: () => {} });
  relays.push(r);
  const bus = createBus();
  const net = openNet(bus, `ws://127.0.0.1:${r.port}/relay`);
  net.send({ t: 'say', sid: 'syn-a', text: 'queued before open' });
  const mode = await once(bus, 'mode');
  assert.equal(mode.canEdit, false);
  const err = await once(bus, 'error');
  assert.equal(err.text, 'view-only link');
});

test('a latch set in the connect turn holds the per-connection mode frame for a feature that installs later', async () => {
  const r = await startRelay({ port: 0, sources: ['synthetic'], log: () => {} });
  relays.push(r);
  const bus = createBus();
  // Same order as main.js: connect, then laptop.js latches in the same turn, before any socket message.
  openNet(bus, `ws://127.0.0.1:${r.port}/relay?key=edit`);
  const latched = latchLast(bus, 'mode');
  await once(bus, 'mode');
  // The probe resolves after the frame; a listener added now would never see it.
  let lateSaw = null;
  bus.addEventListener('mode', (e) => (lateSaw = e.detail), { once: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(lateSaw, null);
  assert.deepEqual(latched.last, { t: 'mode', mode: 'synthetic', canEdit: true });
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
