// node:test — reducer details added by the fix pass: authoritative counts (live mode) and hidden-flag reset on re-add.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, applyEvent, snapshot } from '../server/state.js';

const ev = (seq, fields) => ({ t: 'event', seq, ts: 1760700000000 + seq, ...fields });
const tile = (id, role, extra = {}) => ({ id, sessionId: 's', role, ts: 1, text: `${role} ${id}`, summary: `${role} ${id}`, glyph: 'A', ...extra });

test('countsAuthoritative sessions keep the source counts; derived sessions still count tiles', () => {
  const st = createState();
  const base = { id: 's', title: 's', status: 'idle', startedAt: 1, lastActivityAt: 1, activity: '', summary: '', toolHistory: [], currentTool: null, attention: null };
  applyEvent(st, ev(1, { sessionId: 's', kind: 'session.upsert', session: { ...base, counts: { messages: 3, toolCalls: 1, byCategory: { web: 1 } }, toolHistory: ['web'], countsAuthoritative: true } }));
  applyEvent(st, ev(2, { sessionId: 's', kind: 'message.add', message: tile('1', 'user') }));
  applyEvent(st, ev(3, { sessionId: 's', kind: 'message.add', message: tile('2:c1', 'tool_call', { tool: { callId: 'c1', name: 'web_extract', category: 'web', target: 'browser' } }) }));
  assert.equal(st.sessions.s.countsAuthoritative, true);
  assert.deepEqual([st.sessions.s.counts.messages, st.sessions.s.counts.toolCalls, st.sessions.s.counts.byCategory.web], [3, 1, 1], 'tiles do not double count');
  assert.deepEqual(st.sessions.s.toolHistory, ['web', 'web'], 'toolHistory still gets immediate pushes (replaced by the next upsert)');
  // later authoritative upserts replace counts even though the session has messages
  applyEvent(st, ev(4, { sessionId: 's', kind: 'session.upsert', session: { ...base, counts: { messages: 5, toolCalls: 2, byCategory: { web: 2 } }, toolHistory: ['web', 'files'], countsAuthoritative: true } }));
  assert.deepEqual([st.sessions.s.counts.messages, st.sessions.s.counts.toolCalls], [5, 2]);
  assert.deepEqual(st.sessions.s.toolHistory, ['web', 'files']);
  assert.equal(snapshot(st).sessions[0].countsAuthoritative, true, 'the flag reaches snapshots (clients mirror it)');
  // a fixture-style session (no flag) derives everything from tiles, and a non-authoritative upsert never resets them
  applyEvent(st, ev(5, { sessionId: 'f', kind: 'session.upsert', session: { ...base, id: 'f', title: 'f', counts: { messages: 0, toolCalls: 0, byCategory: {} } } }));
  applyEvent(st, ev(6, { sessionId: 'f', kind: 'message.add', message: { ...tile('f1', 'user'), sessionId: 'f' } }));
  applyEvent(st, ev(7, { sessionId: 'f', kind: 'message.add', message: { ...tile('f2:c', 'tool_call', { tool: { callId: 'c', name: 'patch', category: 'files', target: 'files' } }), sessionId: 'f' } }));
  applyEvent(st, ev(8, { sessionId: 'f', kind: 'session.upsert', session: { ...base, id: 'f', title: 'f2', counts: { messages: 0, toolCalls: 0, byCategory: {} } } }));
  assert.deepEqual([st.sessions.f.counts.messages, st.sessions.f.counts.toolCalls, st.sessions.f.counts.byCategory.files], [2, 1, 1]);
  assert.equal(st.sessions.f.title, 'f2');
  assert.ok(!st.sessions.f.countsAuthoritative);
});

test('a hidden message that is re-added under the same id becomes visible again', () => {
  const st = createState();
  applyEvent(st, ev(1, { sessionId: 's', kind: 'message.add', message: tile('live', 'assistant', { streaming: true }) }));
  applyEvent(st, ev(2, { sessionId: 's', kind: 'message.complete', messageId: 'live', text: '', hidden: true }));
  assert.equal(st.messages.s[0].hidden, true);
  applyEvent(st, ev(3, { sessionId: 's', kind: 'message.add', message: tile('live', 'assistant', { streaming: true, text: 'turn two' }) }));
  assert.equal(st.messages.s.length, 1, 'still one row (idempotent upsert)');
  assert.equal(st.messages.s[0].hidden, false, 'hidden cleared by the re-add');
  assert.equal(st.messages.s[0].text, 'turn two');
  applyEvent(st, ev(4, { sessionId: 's', kind: 'message.add', message: tile('live', 'assistant', { hidden: true }) }));
  assert.equal(st.messages.s[0].hidden, true, 'an explicit hidden:true on the re-add is honoured');
});
