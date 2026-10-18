// The Codex source over fixtures/codex: a hand-written rollout tree in the
// shapes real Codex rollouts use (session_meta, response_item, event_msg).
// Integration cases copy it into a mkdtemp directory and run real discovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as codex from './codex.mjs';
import { isServerEvent } from '../../shared/protocol.mjs';

const { start, mapLine, statusOf, metaOf, titleOf, slabText } = codex;
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'codex');
const DAY = path.join('sessions', '2026', '10', '17');
const CHAT = '019a0000-0000-7000-8000-000000000001';
const AGENT = '019a0000-0000-7000-8000-000000000002';
const GUARD = '019a0000-0000-7000-8000-000000000003';
const quiet = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A copy of the fixture tree; returns the temp dir and its `sessions` root. */
function copyFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obelisks-codex-'));
  fs.cpSync(FIXTURE, tmp, { recursive: true });
  return { tmp, root: path.join(tmp, 'sessions') };
}

const chatFile = (tmp) => path.join(tmp, DAY, `rollout-2026-10-17T20-00-00-${CHAT}.jsonl`);
const line = (type, payload, timestamp = '2026-10-17T21:00:00.000Z') => JSON.stringify({ timestamp, type, payload }) + '\n';
const meta = (id, extra = {}) => line('session_meta', { id, cwd: '/tmp/other', source: 'cli', ...extra });
const userMsg = (id, text) => line('response_item', { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] });

async function run(opts) {
  const frames = [];
  const handle = await start({ emit: (f) => frames.push(f), log: quiet, ...opts });
  return { frames, handle };
}

async function until(frames, pred, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (pred(frames)) return;
  assert.fail(`timed out; got ${JSON.stringify(frames.map((f) => f.t + ':' + (f.id ?? f.sid)))}`);
}

test('C1 the fixture tree gives one chat titled from the index and one spawned agent; the guardian is skipped', async (t) => {
  const { root } = copyFixture();
  const { frames, handle } = await run({ root });
  t.after(() => handle.stop());
  const sessions = frames.filter((f) => f.t === 'session');
  assert.deepEqual(
    sessions.map(({ sid, harness, kind, title, parent }) => ({ sid, harness, kind, title, parent })),
    [
      { sid: CHAT, harness: 'codex', kind: 'chat', title: 'Fix the notes typo', parent: undefined },
      { sid: AGENT, harness: 'codex', kind: 'agent', title: 'Noether /root/linter', parent: CHAT },
    ],
  );
  assert.ok(!frames.some((f) => f.sid === GUARD));
  assert.ok(frames.every(isServerEvent));
  assert.equal(titleOf(CHAT), 'Fix the notes typo');
});

test('C2 seeded slabs: injected context and encrypted reasoning drop; tool slabs share the tool frame id', async (t) => {
  const { root } = copyFixture();
  const { frames, handle } = await run({ root });
  t.after(() => handle.stop());
  const chat = frames.filter((f) => f.sid === CHAT && f.t !== 'session');
  assert.deepEqual(
    chat.filter((f) => f.t === 'slab').map((f) => [f.id, f.role, f.text]),
    [
      ['msg_u1', 'user', 'Count the lines in notes.txt and fix the typo'],
      ['rs_1', 'thinking', '**Counting lines**'],
      ['msg_a1', 'assistant', 'I will count the lines first.'],
      ['call_wc', 'tool', 'exec_command wc -l notes.txt'],
      ['call_patch', 'tool', 'apply_patch *** Begin Patch'],
      ['call_js', 'tool', 'mcp__browser_repl__js await page.goto("https://example.com")'],
      ['call_exec', 'tool', 'exec git status --short'],
      ['msg_a2', 'assistant', 'notes.txt has 3 lines; I fixed "teh".'],
    ],
  );
  const tools = chat.filter((f) => f.t === 'tool');
  assert.deepEqual(
    tools.map((f) => [f.id, f.name, f.phase]),
    [
      ['call_wc', 'exec_command', 'start'],
      ['call_wc', 'exec_command', 'complete'],
      ['call_patch', 'apply_patch', 'start'],
      ['call_patch', 'apply_patch', 'complete'],
      ['call_js', 'mcp__browser_repl__js', 'start'],
      ['call_js', 'mcp__browser_repl__js', 'complete'],
      ['call_exec', 'exec', 'start'],
      ['call_exec', 'exec', 'complete'],
    ],
  );
  assert.deepEqual(tools[0].args, { cmd: 'wc -l notes.txt\necho done', workdir: '/tmp/demo' });
  assert.equal(tools[1].summary, 'Wall time: 0.01 seconds\nOutput:\n3 notes.txt');
  assert.match(tools[3].diff, /@@\n-teh\n\+the/);
  assert.equal(tools[5].summary, 'Example Domain');
  assert.equal(slabText(CHAT, 'call_wc'), 'exec_command wc -l notes.txt');
  const agent = frames.filter((f) => f.sid === AGENT && f.t === 'slab');
  assert.deepEqual(agent.map((f) => f.text), ['Lint notes.txt', 'shell grep -c teh notes.txt']);
});

test('C3 statusOf: growth or an open turn is working, a finished turn is waiting, an abort is idle', async (t) => {
  const base = { lastGrowthAt: 0, now: 100000, workingMs: 5000 };
  assert.equal(statusOf({ ...base, lastGrowthAt: 99000, turn: 'done' }), 'working');
  assert.equal(statusOf({ ...base, turn: 'open' }), 'working');
  assert.equal(statusOf({ ...base, turn: 'done' }), 'waiting');
  assert.equal(statusOf({ ...base, turn: 'aborted', lastItem: 'assistant' }), 'idle');
  assert.equal(statusOf({ ...base, lastItem: 'assistant' }), 'waiting');
  assert.equal(statusOf({ ...base, lastItem: 'function_call' }), 'idle');

  const { tmp, root } = copyFixture();
  const { frames, handle } = await run({ root, pollMs: 20, workingMs: 0 });
  t.after(() => handle.stop());
  assert.equal(frames.find((f) => f.sid === CHAT).status, 'waiting');
  assert.equal(frames.find((f) => f.sid === AGENT).status, 'working'); // task_started with no task_complete
  fs.appendFileSync(chatFile(tmp), line('event_msg', { type: 'task_started', turn_id: 't9' }));
  await until(frames, (fs) => fs.some((f) => f.t === 'state' && f.sid === CHAT && f.status === 'working'));
});

test('C4 appended lines arrive once, a split write joins, and a bad line is skipped', async (t) => {
  const { tmp, root } = copyFixture();
  const { frames, handle } = await run({ root, pollMs: 20 });
  t.after(() => handle.stop());
  const before = frames.length;
  const next = userMsg('msg_u2', 'and the other file');
  fs.appendFileSync(chatFile(tmp), 'not json\n' + next.slice(0, 30));
  await sleep(80);
  fs.appendFileSync(chatFile(tmp), next.slice(30));
  await until(frames, (fs) => fs.some((f) => f.id === 'msg_u2'));
  await sleep(80);
  const added = frames.slice(before).filter((f) => f.t === 'slab');
  assert.deepEqual(added.map((f) => [f.id, f.text]), [['msg_u2', 'and the other file']]);
});

test('C5 caps: max keeps the newest chats, maxAgents caps agents per chat, applyWindow drops stale files', async (t) => {
  const { tmp, root } = copyFixture();
  const other = '019a0000-0000-7000-8000-0000000000aa';
  fs.writeFileSync(path.join(tmp, DAY, `rollout-2026-10-17T21-00-00-${other}.jsonl`), meta(other) + userMsg('m', 'newer chat'));
  const now = Date.now() / 1000;
  for (const f of fs.readdirSync(path.join(tmp, DAY))) fs.utimesSync(path.join(tmp, DAY, f), now - 60, now - 60);
  fs.utimesSync(chatFile(tmp), now - 120, now - 120); // the fixture chat is the older of the two

  const one = await run({ root, max: 1 });
  one.handle.stop();
  assert.deepEqual(one.frames.filter((f) => f.t === 'session').map((f) => f.sid), [other]);

  const noAgents = await run({ root, maxAgents: 0 });
  noAgents.handle.stop();
  assert.deepEqual(noAgents.frames.filter((f) => f.t === 'session').map((f) => f.sid).sort(), [CHAT, other].sort());

  const windowed = await run({ root, applyWindow: true, sinceMinutes: 1.5 });
  windowed.handle.stop();
  // The stale chat drops, and its agent goes with it: agents follow a shown chat.
  assert.deepEqual(windowed.frames.filter((f) => f.t === 'session').map((f) => f.sid), [other]);
});

test('C6 a long rollout seeds from its tail and still titles from its head', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obelisks-codex-big-'));
  const sid = '019a0000-0000-7000-8000-0000000000bb';
  const pad = line('event_msg', { type: 'token_count', info: { note: 'x'.repeat(200) } });
  let body = meta(sid) + userMsg('first', 'Start the long task') + pad.repeat(400);
  for (let i = 0; i < 50; i++) body += userMsg(`late${i}`, `late message ${i}`);
  fs.writeFileSync(path.join(tmp, `rollout-2026-10-17T21-00-00-${sid}.jsonl`), body);
  const { frames, handle } = await run({ root: tmp, seedBytes: 8 * 1024 });
  t.after(() => handle.stop());
  assert.equal(frames[0].title, 'Start the long task');
  const slabs = frames.filter((f) => f.t === 'slab');
  assert.ok(slabs.length > 0 && slabs.length < 50, `seeded ${slabs.length}`);
  assert.equal(slabs.at(-1).id, 'late49');
  assert.ok(!slabs.some((f) => f.id === 'first'));
});

test('C7 two history segments of one thread track only the newer file', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obelisks-codex-seg-'));
  const sid = '019a0000-0000-7000-8000-0000000000cc';
  const older = path.join(tmp, `rollout-2026-10-16T10-00-00-${sid}.jsonl`);
  const newer = path.join(tmp, `rollout-2026-10-17T10-00-00-${sid}_019a0000-0000-7000-8000-0000000000dd.jsonl`);
  fs.writeFileSync(older, meta(sid) + userMsg('old', 'old segment'));
  fs.writeFileSync(newer, meta(sid) + userMsg('new', 'new segment'));
  const now = Date.now() / 1000;
  fs.utimesSync(older, now - 600, now - 600);
  const { frames, handle } = await run({ root: tmp });
  t.after(() => handle.stop());
  assert.equal(frames.filter((f) => f.t === 'session').length, 1);
  assert.deepEqual(frames.filter((f) => f.t === 'slab').map((f) => f.id), ['new']);
});

test('C8 mapLine reads old bare items, string outputs, local shell calls, and untagged user text', () => {
  const pending = new Map();
  const ts = '2026-10-17T21:00:00.000Z';
  assert.deepEqual(mapLine({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }], timestamp: ts }, pending, 's', 'L1'), []);
  assert.deepEqual(mapLine({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }], timestamp: ts }, pending, 's', 'L2'), [
    { t: 'slab', sid: 's', id: 'L2', role: 'user', text: 'hello', ts: Date.parse(ts) },
  ]);
  const call = mapLine({ type: 'local_shell_call', call_id: 'c1', action: { type: 'exec', command: ['ls', '-la'] }, timestamp: ts }, pending, 's');
  assert.equal(call[0].text, 'local_shell ls -la');
  assert.equal(call[1].name, 'local_shell');
  const out = mapLine({ type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'total 0', metadata: { exit_code: 0 } }), timestamp: ts }, pending, 's');
  assert.deepEqual(out, [{ t: 'tool', sid: 's', id: 'c1', name: 'local_shell', phase: 'complete', summary: 'total 0' }]);
  assert.deepEqual(mapLine({ type: 'event_msg', payload: { type: 'agent_message', message: 'dup' } }, pending, 's'), []);
  assert.deepEqual(mapLine({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } }, pending, 's'), []);
  for (const frames of [call, out]) assert.ok(frames.every(isServerEvent));
});

test('C9 metaOf: a chat, a spawned agent with its parent, and a skipped guardian', () => {
  assert.deepEqual(metaOf({ id: 'a', source: 'exec', cwd: '/x/repo' }), { sid: 'a', kind: 'chat', cwdName: 'repo' });
  assert.equal(metaOf({ id: 'b', source: { subagent: { thread_spawn: { parent_thread_id: 'a', agent_nickname: 'N' } } } }).parent, 'a');
  assert.equal(metaOf({ id: 'c', source: { subagent: { other: 'guardian' } }, parent_thread_id: 'a' }), null);
  assert.equal(metaOf({ source: 'cli' }), null);
});

test('C10 read-only module with a module-level stop the relay can call; a bad root rejects', async () => {
  assert.equal(typeof codex.start, 'function');
  assert.equal(codex.sendCommand, undefined);
  const { tmp, root } = copyFixture();
  const { frames, handle } = await run({ root, pollMs: 20 });
  codex.stop();
  const n = frames.length;
  fs.appendFileSync(chatFile(tmp), userMsg('after', 'after stop'));
  await sleep(100);
  assert.equal(frames.length, n);
  handle.stop();
  await assert.rejects(start({ emit: () => {}, root: path.join(root, 'missing'), log: quiet }), /not a directory/);
});
