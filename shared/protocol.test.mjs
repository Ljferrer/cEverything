import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS, isServerEvent, isClientCommand } from './protocol.mjs';

const serverFrames = [
  { t: 'mode', mode: 'synthetic', canEdit: false },
  { t: 'session', sid: 's1', harness: 'hermes', kind: 'chat', title: 'Plan', status: 'idle', parent: null, phase: null },
  { t: 'session', sid: 's2', harness: 'claude', kind: 'agent', title: 'Agent', status: 'working', parent: 's1', phase: 'research' },
  { t: 'session', sid: 's3', harness: 'codex', kind: 'chat', title: 'Codex', status: 'waiting' },
  { t: 'slab', sid: 's1', id: 'm1', role: 'user', text: 'hi', ts: 1 },
  { t: 'slab', sid: 's1', id: 'm2', role: 'thinking', text: 'hmm', ts: 2 },
  { t: 'delta', sid: 's1', id: 'm3', role: 'assistant', text: 'par' },
  { t: 'tool', sid: 's1', id: 't1', name: 'terminal', phase: 'start', args: { cmd: 'ls' }, summary: null, diff: null },
  { t: 'tool', sid: 's1', id: 't1', name: 'terminal', phase: 'complete', args: null, summary: '3 files', diff: '+1/-0' },
  { t: 'state', sid: 's1', status: 'waiting' },
  { t: 'error', text: 'view-only link' },
];

const clientFrames = [
  { t: 'say', sid: 's1', text: 'go' },
  { t: 'fork', sid: 's1' },
  { t: 'pipe', from: 's1', to: 's2', slab: 'm1' },
  { t: 'voice', sid: 's1', mime: 'audio/webm', data_url: 'data:audio/webm;base64,AAAA' },
];

test('EVENTS lists both directions', () => {
  assert.deepEqual([...EVENTS.server], ['mode', 'session', 'slab', 'delta', 'tool', 'state', 'error']);
  assert.deepEqual([...EVENTS.client], ['say', 'fork', 'pipe', 'voice']);
});

test('isServerEvent accepts every server shape', () => {
  for (const f of serverFrames) assert.equal(isServerEvent(f), true, JSON.stringify(f));
});

test('isServerEvent rejects client commands, a wrong t, and non-objects', () => {
  for (const f of clientFrames) assert.equal(isServerEvent(f), false, JSON.stringify(f));
  assert.equal(isServerEvent({ t: 'nope', text: 'x' }), false);
  assert.equal(isServerEvent({ t: 'toString', text: 'x' }), false);
  assert.equal(isServerEvent({ text: 'x' }), false);
  assert.equal(isServerEvent(null), false);
  assert.equal(isServerEvent('mode'), false);
  assert.equal(isServerEvent([]), false);
});

test('isServerEvent rejects a bad enum or a missing required field', () => {
  assert.equal(isServerEvent({ t: 'mode', mode: 'demo', canEdit: true }), false);
  assert.equal(isServerEvent({ t: 'mode', mode: 'live' }), false);
  assert.equal(isServerEvent({ t: 'slab', sid: 's', id: 'm', role: 'system', text: '', ts: 1 }), false);
  assert.equal(isServerEvent({ t: 'slab', sid: 's', id: 'm', role: 'user', text: '' }), false);
  assert.equal(isServerEvent({ t: 'state', sid: 's', status: 'done' }), false);
  assert.equal(isServerEvent({ t: 'tool', sid: 's', id: 't', name: 'x', phase: 'end' }), false);
  assert.equal(isServerEvent({ t: 'session', sid: 's', harness: 'gpt', kind: 'chat', title: '', status: 'idle' }), false);
  assert.equal(isServerEvent({ t: 'session', sid: 's', harness: 'hermes', kind: 'chat', title: '', status: 'idle', parent: 7 }), false);
});

test('isClientCommand accepts every client shape', () => {
  for (const f of clientFrames) assert.equal(isClientCommand(f), true, JSON.stringify(f));
});

test('isClientCommand rejects server events, a wrong t, and a missing field', () => {
  for (const f of serverFrames) assert.equal(isClientCommand(f), false, JSON.stringify(f));
  assert.equal(isClientCommand({ t: 'shout', sid: 's1', text: 'x' }), false);
  assert.equal(isClientCommand({ t: 'say', sid: 's1' }), false);
  assert.equal(isClientCommand({ t: 'pipe', from: 's1', to: 's2' }), false);
  assert.equal(isClientCommand({ t: 'voice', sid: 's1', mime: 'audio/webm' }), false);
  assert.equal(isClientCommand(undefined), false);
});

test('optional keys may be absent entirely, not only null; a non-string parent is rejected', () => {
  assert.equal(isServerEvent({ t: 'session', sid: 's', harness: 'hermes', kind: 'chat', title: 'Plan', status: 'idle' }), true);
  assert.equal(isServerEvent({ t: 'tool', sid: 's', id: 't', name: 'terminal', phase: 'start' }), true);
  assert.equal(isServerEvent({ t: 'session', sid: 's', harness: 'hermes', kind: 'chat', title: 'Plan', status: 'idle', parent: 7 }), false);
});
