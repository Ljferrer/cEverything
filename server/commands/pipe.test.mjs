// Task 2 tests: say, fork, pipe through a fake plan 1 ctx. Cases are named
// for the End states they prove (ES4, ES5, ES6, ES10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as say from './say.mjs';
import * as fork from './fork.mjs';
import * as pipe from './pipe.mjs';
import { isServerEvent } from '../../shared/protocol.mjs';

/** A writable owner that records every sendCommand call as [method, params]. */
function owner(titleOf) {
  const calls = [];
  const o = {
    calls,
    async sendCommand(method, params) {
      calls.push([method, params]);
      return {};
    },
  };
  if (titleOf) o.titleOf = titleOf;
  return o;
}

function makeCtx() {
  const emitted = [];
  const owners = {
    a: owner(() => 'Alpha'),
    s1: owner(() => 'S1'),
    s2: owner(() => 'S2'),
    d: owner(() => {
      throw new Error('no title');
    }),
    c: {},
  };
  const relay = {
    slabs: new Map([['s1', [{ t: 'slab', sid: 's1', id: 'm1', role: 'assistant', text: 'hello', ts: 1 }]]]),
  };
  const ctx = {
    relay,
    sources: new Map(),
    commands: { say },
    emit: (f) => emitted.push(f),
    ownerOf: (sid) => owners[sid] ?? null,
  };
  return { ctx, emitted, owners };
}

function allCalls(owners) {
  return Object.values(owners).flatMap((o) => o.calls ?? []);
}

test('ES4 say emits a user slab, submits the prompt, resolves undefined', async () => {
  const { ctx, emitted, owners } = makeCtx();
  assert.equal(say.name, 'say');
  const result = await say.handle({ t: 'say', sid: 'a', text: 'hi' }, ctx);
  assert.equal(result, undefined);
  assert.equal(emitted.length, 1);
  const slab = emitted[0];
  assert.ok(isServerEvent(slab));
  assert.equal(slab.t, 'slab');
  assert.equal(slab.sid, 'a');
  assert.equal(slab.role, 'user');
  assert.equal(slab.text, 'hi');
  assert.ok(slab.id.startsWith('user-'));
  assert.equal(typeof slab.ts, 'number');
  assert.deepEqual(owners.a.calls, [['prompt.submit', { session_id: 'a', text: 'hi' }]]);
});

test('ES5 fork branches with the owner title, emits nothing, resolves undefined', async () => {
  const { ctx, emitted, owners } = makeCtx();
  assert.equal(fork.name, 'fork');
  const result = await fork.handle({ t: 'fork', sid: 'a' }, ctx);
  assert.equal(result, undefined);
  assert.deepEqual(emitted, []);
  assert.deepEqual(owners.a.calls, [['session.branch', { session_id: 'a', name: 'Alpha fork' }]]);
});

test('ES6 read-only target, missing slab, and a throwing titleOf', async () => {
  const { ctx, emitted, owners } = makeCtx();
  assert.equal(pipe.name, 'pipe');

  const ro = await pipe.handle({ t: 'pipe', from: 's1', to: 'c', slab: 'm1' }, ctx);
  assert.deepEqual(ro, { t: 'error', text: 'read-only harness' });
  assert.deepEqual(emitted, []);
  assert.deepEqual(allCalls(owners), []);

  const missing = await pipe.handle({ t: 'pipe', from: 's1', to: 's2', slab: 'nope' }, ctx);
  assert.deepEqual(missing, { t: 'error', text: 'slab not found' });
  assert.deepEqual(emitted, []);
  assert.deepEqual(allCalls(owners), []);

  const sayRo = await say.handle({ t: 'say', sid: 'c', text: 'x' }, ctx);
  assert.deepEqual(sayRo, { t: 'error', text: 'read-only harness' });
  const forkRo = await fork.handle({ t: 'fork', sid: 'c' }, ctx);
  assert.deepEqual(forkRo, { t: 'error', text: 'read-only harness' });
  assert.deepEqual(emitted, []);
  assert.deepEqual(allCalls(owners), []);

  const result = await fork.handle({ t: 'fork', sid: 'd' }, ctx);
  assert.equal(result, undefined);
  assert.deepEqual(owners.d.calls, [['session.branch', { session_id: 'd', name: 'd fork' }]]);
  assert.deepEqual(emitted, []);
});

test('ES6 an empty titleOf result falls back to the sid', async () => {
  const { ctx, owners } = makeCtx();
  owners.d = owner(() => '');
  await fork.handle({ t: 'fork', sid: 'd' }, ctx);
  assert.deepEqual(owners.d.calls, [['session.branch', { session_id: 'd', name: 'd fork' }]]);
});

test('ES10 pipe says the quoted slab on the target through ctx.commands.say', async () => {
  const { ctx, emitted, owners } = makeCtx();
  const result = await pipe.handle({ t: 'pipe', from: 's1', to: 's2', slab: 'm1' }, ctx);
  assert.equal(result, undefined);
  assert.equal(emitted.length, 1);
  const slab = emitted[0];
  assert.ok(isServerEvent(slab));
  assert.equal(slab.t, 'slab');
  assert.equal(slab.sid, 's2');
  assert.equal(slab.role, 'user');
  assert.equal(slab.text, 'From S1: hello');
  assert.deepEqual(owners.s2.calls, [['prompt.submit', { session_id: 's2', text: 'From S1: hello' }]]);
  assert.deepEqual(owners.s1.calls, []);
});

test('ES10 pipe prefers the owner slabText over the relay cache', async () => {
  const { ctx, emitted, owners } = makeCtx();
  owners.s1.slabText = (sid, id) => (sid === 's1' && id === 'm1' ? 'from memory' : '');
  await pipe.handle({ t: 'pipe', from: 's1', to: 's2', slab: 'm1' }, ctx);
  assert.equal(emitted[0].text, 'From S1: from memory');
  const missing = await pipe.handle({ t: 'pipe', from: 's1', to: 's2', slab: 'nope' }, ctx);
  assert.deepEqual(missing, { t: 'error', text: 'slab not found' });
});
