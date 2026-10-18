// Plan 3 Task 1: every case is named `ES<n> …` after the End state it proves,
// so `--test-name-pattern='^ES<n>\b'` runs that case alone. Integration cases
// copy fixtures/claude into a mkdtemp directory and run the real discovery.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as claude from './claude.mjs';
import { isServerEvent } from '../../shared/protocol.mjs';

const { start, mapLine, deriveTitle, statusOf, titleOf, slabText } = claude;
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'claude');
const quiet = () => {};

/** Reject after `ms` so a broken tail fails instead of hanging. */
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A frame sink: records every frame and resolves `until(pred)` once it holds. */
function sink() {
  const frames = [];
  const waiters = [];
  const emit = (f) => {
    frames.push(f);
    for (const w of [...waiters]) if (w.pred(frames)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(frames);
    }
  };
  const until = (pred, ms, label) =>
    withTimeout(
      new Promise((resolve) => {
        if (pred(frames)) return resolve(frames);
        waiters.push({ pred, resolve });
      }),
      ms,
      `${label}; got ${JSON.stringify(frames.map((f) => f.t + (f.sid ? ':' + f.sid : '')))}`,
    );
  return { frames, emit, until };
}

function copyFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obelisks-claude-'));
  fs.cpSync(FIXTURE, tmp, { recursive: true });
  return tmp;
}

const userLine = (uuid, text, sid = 'main') =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: text },
    uuid,
    timestamp: '2026-10-17T20:10:00.000Z',
    userType: 'external',
    cwd: '/tmp/demo',
    sessionId: sid,
    version: '2.1.0',
    gitBranch: 'main',
  }) + '\n';

const MAIN = (tmp) => path.join(tmp, 'demo-project', 'main.jsonl');
const noUndefined = (f) => Object.values(f).every((v) => v !== undefined);

// ES1–ES3 share one run over the fixture copy.
const shared = { tmp: null, handle: null, frames: null };
before(async () => {
  shared.tmp = copyFixture();
  const s = sink();
  shared.handle = await start({ emit: s.emit, root: shared.tmp, log: quiet });
  await s.until(
    (f) => f.filter((x) => x.t === 'session' && x.kind === 'agent').length >= 3 && f.filter((x) => x.t === 'slab').length >= 12,
    5000,
    'three agent sessions and twelve slabs',
  );
  // One more poll tick: a re-read would emit a 13th slab, which ES2 must catch.
  await sleep(1200);
  shared.frames = s.frames;
});
after(() => shared.handle?.stop());

test('ES1 one chat session and three agent sessions with parent and phase', () => {
  const sessions = shared.frames.filter((f) => f.t === 'session');
  const chats = sessions.filter((f) => f.kind === 'chat');
  const agents = sessions.filter((f) => f.kind === 'agent');
  assert.equal(chats.length, 1);
  assert.equal(chats[0].harness, 'claude');
  assert.equal(chats[0].sid, 'main');
  assert.equal(agents.length, 3);
  for (const a of agents) {
    assert.equal(a.harness, 'claude');
    assert.equal(a.parent, 'main');
  }
  const bySid = Object.fromEntries(agents.map((a) => [a.sid, a]));
  assert.equal(bySid.a1.phase, 'Research');
  assert.equal(bySid.a2.phase, 'Research');
  assert.ok(bySid.t1);
  assert.ok(!('phase' in bySid.t1));
  assert.ok(!('parent' in chats[0]));
  assert.ok(!('phase' in chats[0]));
});

test('ES2 twelve seeded slabs, paired tool frames, every frame valid', () => {
  const frames = shared.frames;
  const slabs = frames.filter((f) => f.t === 'slab');
  assert.equal(slabs.length, 12);
  const count = (sid) => slabs.filter((s) => s.sid === sid).length;
  assert.equal(count('main'), 4);
  assert.equal(count('a1'), 4);
  assert.equal(count('a2'), 2);
  assert.equal(count('t1'), 2);
  assert.ok(slabs.some((s) => s.role === 'thinking'));
  const tools = frames.filter((f) => f.t === 'tool');
  const bashStart = tools.find((f) => f.phase === 'start' && f.name === 'Bash');
  const bashDone = tools.find((f) => f.phase === 'complete' && f.name === 'Bash');
  assert.ok(bashStart && bashDone);
  assert.equal(bashStart.id, bashDone.id);
  assert.equal(bashStart.sid, 'main');
  assert.ok(!('diff' in bashDone));
  assert.equal(bashDone.summary, 'placeholder.txt\nplaceholder');
  const editDone = tools.find((f) => f.phase === 'complete' && f.name === 'Edit');
  assert.ok(editDone);
  assert.equal(editDone.sid, 'a1');
  for (const f of frames) {
    assert.ok(isServerEvent(f), `invalid frame ${JSON.stringify(f)}`);
    assert.ok(noUndefined(f), `undefined value in ${JSON.stringify(f)}`);
  }
  for (const s of slabs.filter((x) => x.id.startsWith('a1-') || x.id === 'toolu_demo_edit')) assert.equal(s.sid, 'a1');
  // The seed emits the session before its slabs.
  const firstMainSlab = frames.findIndex((f) => f.t === 'slab' && f.sid === 'main');
  const mainSession = frames.findIndex((f) => f.t === 'session' && f.sid === 'main');
  assert.ok(mainSession < firstMainSlab);
});

test('ES3 the a1 Edit result carries the hunk lines as diff', () => {
  const editDone = shared.frames.find((f) => f.t === 'tool' && f.phase === 'complete' && f.name === 'Edit');
  assert.equal(editDone.diff, '-old placeholder\n+new placeholder');
});

test('ES4 appended lines arrive once, split writes and bad lines survive', async (t) => {
  const tmp = copyFixture();
  const s = sink();
  const h = await start({ emit: s.emit, root: tmp, log: quiet });
  t.after(() => h.stop());
  await s.until((f) => f.filter((x) => x.t === 'slab' && x.sid === 'main').length >= 4, 5000, 'seed');
  const seenIds = new Set(s.frames.filter((f) => f.t === 'slab').map((f) => f.id));
  const mark = s.frames.length;
  const since = () => s.frames.slice(mark).filter((f) => f.t === 'slab');

  fs.appendFileSync(MAIN(tmp), userLine('main-u9', 'Appended placeholder'));
  await s.until((f) => f.slice(mark).some((x) => x.t === 'slab' && x.id === 'main-u9'), 2000, 'appended slab');
  assert.equal(since().length, 1);
  assert.equal(since()[0].text, 'Appended placeholder');
  for (const f of since()) assert.ok(!seenIds.has(f.id), `repeated id ${f.id}`);

  const line2 = userLine('main-u10', 'Split placeholder');
  const cut = line2.indexOf('"uuid"') + 3;
  fs.appendFileSync(MAIN(tmp), line2.slice(0, cut));
  await sleep(300);
  fs.appendFileSync(MAIN(tmp), line2.slice(cut));
  await s.until((f) => f.slice(mark).some((x) => x.t === 'slab' && x.id === 'main-u10'), 2000, 'split slab');
  assert.equal(since().length, 2);

  fs.appendFileSync(MAIN(tmp), 'not json\n' + userLine('main-u11', 'After bad line placeholder'));
  await s.until((f) => f.slice(mark).some((x) => x.t === 'slab' && x.id === 'main-u11'), 2000, 'slab after bad line');
  await sleep(1200);
  assert.equal(since().length, 3);
  assert.deepEqual(since().map((f) => f.id), ['main-u9', 'main-u10', 'main-u11']);
});

test('ES5 deriveTitle precedence, titleOf, slabText, and the custom-title line fallback', async (t) => {
  assert.equal(deriveTitle({ firstUserText: '<command-name>/x</command-name> ' + 'a'.repeat(70) }), 'a'.repeat(60));
  assert.equal(deriveTitle({ customTitle: 'T', firstUserText: 'b' }), 'T');
  assert.equal(deriveTitle({ customTitleLine: 'L', firstUserText: 'b' }), 'L');

  const tmp = copyFixture();
  const s = sink();
  const h = await start({ emit: s.emit, root: tmp, log: quiet });
  t.after(() => h.stop());
  await s.until((f) => f.filter((x) => x.t === 'session').length >= 4, 5000, 'four sessions');
  assert.equal(titleOf('main'), 'Demo session');
  assert.equal(s.frames.find((f) => f.t === 'session' && f.sid === 'main').title, 'Demo session');
  assert.equal(slabText('main', 'main-u1'), 'Hello placeholder');
  assert.equal(slabText('main', 'nope'), undefined);
  assert.equal(titleOf('nope'), undefined);
  assert.equal(titleOf('a1'), 'research:fixtures');
  assert.equal(s.frames.find((f) => f.t === 'session' && f.sid === 'a1').title, 'research:fixtures');
  h.stop();

  fs.rmSync(path.join(tmp, 'demo-project', 'main', 'custom-title.json'));
  const s2 = sink();
  const h2 = await start({ emit: s2.emit, root: tmp, log: quiet });
  t.after(() => h2.stop());
  await s2.until((f) => f.some((x) => x.t === 'session' && x.sid === 'main'), 5000, 'chat session');
  assert.equal(s2.frames.find((f) => f.t === 'session' && f.sid === 'main').title, 'Line placeholder');
  assert.equal(titleOf('main'), 'Line placeholder');
});

test('ES6 statusOf branches and state frames on change only', async (t) => {
  const base = { lastMessageType: 'assistant', lastAssistantBlock: 'text', pendingOpen: false, lastGrowthAt: 0, now: 100000, workingMs: 5000 };
  assert.equal(statusOf({ ...base, lastGrowthAt: 99000 }), 'working');
  assert.equal(statusOf({ ...base, lastAssistantBlock: 'tool_use', pendingOpen: true }), 'working');
  assert.equal(statusOf(base), 'waiting');
  assert.equal(statusOf({ ...base, lastMessageType: 'user' }), 'idle');
  assert.equal(statusOf({ ...base, lastAssistantBlock: 'tool_use', pendingOpen: false }), 'idle');

  const tmp = copyFixture();
  const s = sink();
  const h = await start({ emit: s.emit, root: tmp, workingMs: 300, log: quiet });
  t.after(() => h.stop());
  await s.until((f) => f.some((x) => x.t === 'session' && x.sid === 'main'), 5000, 'chat session');
  assert.equal(s.frames.find((f) => f.t === 'session' && f.sid === 'main').status, 'working');
  await s.until((f) => f.some((x) => x.t === 'state' && x.sid === 'main' && x.status === 'waiting'), 3000, 'state waiting');
  const states = () => s.frames.filter((f) => f.t === 'state' && f.sid === 'main');
  assert.equal(states().length, 1);
  await sleep(1100);
  assert.equal(states().length, 1, 'no repeated waiting state');
  fs.appendFileSync(MAIN(tmp), userLine('main-u9', 'Appended placeholder'));
  await s.until((f) => f.filter((x) => x.t === 'state' && x.sid === 'main').length >= 2, 3000, 'state working');
  assert.equal(states()[1].status, 'working');
});

test('ES7 mapLine skips bookkeeping, system, and meta lines and maps every block type', () => {
  const skipped = [
    'system', 'attachment', 'queue-operation', 'custom-title', 'agent-name', 'file-history-snapshot',
    'file-history-delta', 'last-prompt', 'atis-latch', 'bridge-session', 'summary',
  ];
  for (const type of skipped) {
    assert.deepEqual(mapLine({ type, message: { role: 'user', content: 'placeholder' } }, new Map(), 's'), [], type);
  }
  assert.deepEqual(mapLine({ type: 'user', isMeta: true, message: { role: 'user', content: '<command-name>/x</command-name>' } }, new Map(), 's'), []);
  assert.deepEqual(mapLine({ type: 'user' }, new Map(), 's'), []);

  const ts = '2026-10-17T20:00:00.000Z';
  const pending = new Map();
  assert.deepEqual(mapLine({ type: 'user', uuid: 'u1', timestamp: ts, message: { role: 'user', content: 'hi' } }, pending, 's'), [
    { t: 'slab', sid: 's', id: 'u1', role: 'user', text: 'hi', ts: Date.parse(ts) },
  ]);
  const multi = mapLine(
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: ts,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'image', source: {} },
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls /tmp/demo\necho x' } },
        ],
      },
    },
    pending,
    's',
  );
  assert.deepEqual(multi, [
    { t: 'slab', sid: 's', id: 'a1', role: 'thinking', text: 'hmm', ts: Date.parse(ts) },
    { t: 'slab', sid: 's', id: 'a1:2', role: 'assistant', text: 'ok', ts: Date.parse(ts) },
    { t: 'slab', sid: 's', id: 'tu1', role: 'tool', text: 'Bash ls /tmp/demo', ts: Date.parse(ts) },
    { t: 'tool', sid: 's', id: 'tu1', name: 'Bash', phase: 'start', args: { command: 'ls /tmp/demo\necho x' } },
  ]);
  assert.equal(pending.get('tu1'), 'Bash');
  for (const f of multi) assert.ok(isServerEvent(f) && noUndefined(f), JSON.stringify(f));

  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }];
  const orphan = mapLine(
    {
      type: 'user',
      uuid: 'u2',
      timestamp: ts,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'done' }] },
      toolUseResult: { structuredPatch: patch },
    },
    new Map(),
    's',
  );
  assert.deepEqual(orphan, [{ t: 'tool', sid: 's', id: 'unknown', phase: 'complete', summary: 'done' }]);

  const p2 = new Map([['tw', 'Write']]);
  const done = mapLine(
    {
      type: 'user',
      uuid: 'u3',
      timestamp: ts,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tw', content: [{ type: 'text', text: 'x'.repeat(200) }] }] },
      toolUseResult: { filePath: '/tmp/demo/f', structuredPatch: patch },
    },
    p2,
    's',
  );
  assert.deepEqual(done, [{ t: 'tool', sid: 's', id: 'tw', name: 'Write', phase: 'complete', summary: 'x'.repeat(120), diff: '-a\n+b' }]);
  assert.equal(p2.has('tw'), false);

  const long = mapLine(
    {
      type: 'assistant',
      uuid: 'a2',
      timestamp: ts,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tr', name: 'Read', input: { file_path: '/tmp/demo/f', note: 'y'.repeat(3000) } }] },
    },
    new Map(),
    's',
  );
  assert.equal(long[0].text, 'Read /tmp/demo/f');
  assert.equal(long[1].args.note.length, 2000);
  const other = mapLine(
    { type: 'assistant', uuid: 'a3', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tx', name: 'WebFetch', input: { url: 'placeholder' } }] } },
    new Map(),
    's',
  );
  assert.equal(other[0].text, 'WebFetch {"url":"placeholder"}');
});

test('ES8 a transcript and an agent file created after start join on the next rescan', async (t) => {
  const tmp = copyFixture();
  const s = sink();
  const h = await start({ emit: s.emit, root: tmp, pollMs: 200, rescanMs: 500, log: quiet });
  t.after(() => h.stop());
  await s.until((f) => f.filter((x) => x.t === 'session').length >= 4, 5000, 'four sessions');
  fs.writeFileSync(path.join(tmp, 'demo-project', 'sid2.jsonl'), userLine('sid2-u1', 'Second chat placeholder', 'sid2'));
  const wf = path.join(tmp, 'demo-project', 'main', 'subagents', 'workflows', 'wf_x');
  fs.mkdirSync(wf, { recursive: true });
  fs.writeFileSync(path.join(wf, 'agent-a3.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', description: 'late:fixtures', workflowPhase: 'Audit', spawnDepth: 1 }));
  fs.writeFileSync(
    path.join(wf, 'agent-a3.jsonl'),
    JSON.stringify({ isSidechain: true, agentId: 'a3', type: 'user', uuid: 'a3-u1', timestamp: '2026-10-17T20:10:00.000Z', message: { role: 'user', content: 'Late agent placeholder' }, cwd: '/tmp/demo', sessionId: 'main' }) + '\n',
  );
  await s.until(
    (f) => f.some((x) => x.t === 'session' && x.sid === 'sid2') && f.some((x) => x.t === 'session' && x.sid === 'a3'),
    3000,
    'both late sessions',
  );
  const sid2 = s.frames.find((x) => x.t === 'session' && x.sid === 'sid2');
  assert.equal(sid2.kind, 'chat');
  assert.equal(sid2.title, 'Second chat placeholder');
  const a3 = s.frames.find((x) => x.t === 'session' && x.sid === 'a3');
  assert.equal(a3.kind, 'agent');
  assert.equal(a3.parent, 'main');
  assert.equal(a3.phase, 'Audit');
  assert.equal(a3.title, 'late:fixtures');
  await s.until((f) => f.some((x) => x.t === 'slab' && x.sid === 'a3'), 2000, 'late agent slab');
  await s.until((f) => f.some((x) => x.t === 'slab' && x.sid === 'sid2'), 2000, 'late chat slab');
  // Two more poll ticks: a tick that saw a half-seeded late file would have
  // sent its frames before the `session` and the seed would repeat them.
  // These arms go red only when a tick lands inside track()'s read window.
  // That window is under 1 ms for these late files and about 70 ms for a
  // 50,000-line transcript (measured 2026-10-17), so no fixture size makes
  // the proof deterministic against a pollMs tick; claude.mjs closes the race
  // by construction (files.set after the seed), and the arms stay as a guard.
  await sleep(500);
  for (const sid of ['sid2', 'a3']) {
    const idx = (pred) => s.frames.findIndex((x) => x.sid === sid && pred(x));
    const session = idx((x) => x.t === 'session');
    const firstSlab = idx((x) => x.t === 'slab');
    const firstState = idx((x) => x.t === 'state');
    assert.ok(session < firstSlab, `${sid}: session at ${session} must precede its first slab at ${firstSlab}`);
    assert.ok(firstState === -1 || session < firstState, `${sid}: session at ${session} must precede its first state at ${firstState}`);
  }
  const ids = s.frames.filter((x) => x.t === 'slab').map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, `repeated slab id in ${JSON.stringify(ids)}`);
});

test('ES9 an explicit root tracks a stale transcript; applyWindow waits for growth', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obelisks-claude-stale-'));
  fs.mkdirSync(path.join(root, 'proj'));
  const stale = path.join(root, 'proj', 'stale.jsonl');
  fs.writeFileSync(stale, userLine('stale-u1', 'Stale placeholder', 'stale'));
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(stale, old, old);

  const s1 = sink();
  const h1 = await start({ emit: s1.emit, root, log: quiet });
  t.after(() => h1.stop());
  await s1.until((f) => f.some((x) => x.t === 'session' && x.sid === 'stale'), 3000, 'stale tracked without window');
  h1.stop();

  const s2 = sink();
  const h2 = await start({ emit: s2.emit, root, applyWindow: true, log: quiet });
  t.after(() => h2.stop());
  await sleep(600);
  assert.ok(!s2.frames.some((x) => x.t === 'session' && x.sid === 'stale'), 'stale must not be tracked under the window');
  fs.appendFileSync(stale, userLine('stale-u2', 'Grown placeholder', 'stale'));
  await s2.until((f) => f.some((x) => x.t === 'session' && x.sid === 'stale'), 2000, 'stale tracked after growth');
});

test('read-only module: start exported, sendCommand and handle absent, bad root rejects', async () => {
  assert.equal(typeof claude.start, 'function');
  assert.ok(!('handle' in claude));
  assert.ok(!('sendCommand' in claude));
  await assert.rejects(() => start({ emit: quiet, root: path.join(os.tmpdir(), 'obelisks-no-such-root-' + Date.now()), log: quiet }));
});

test('a chat\'s subagents are announced in the order they started, not by latest activity', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obelisks-claude-born-'));
  const proj = path.join(tmp, 'proj');
  const subs = path.join(proj, 'chat', 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  fs.writeFileSync(path.join(proj, 'chat.jsonl'), userLine('c-u1', 'Parent chat', 'chat') + '\n');
  const agentLine = (id) => JSON.stringify({ isSidechain: true, agentId: id, type: 'user', uuid: `${id}-u1`, timestamp: '2026-10-17T20:00:00.000Z', message: { role: 'user', content: `${id} task` }, cwd: '/tmp/demo', sessionId: 'chat' }) + '\n';
  for (const id of ['first', 'second', 'third']) {
    fs.writeFileSync(path.join(subs, `agent-${id}.jsonl`), agentLine(id));
    await sleep(30); // distinct birth times
  }
  // The first-born agent is the most recently active one.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(subs, 'agent-first.jsonl'), later, later);
  const s = sink();
  const h = await start({ emit: s.emit, root: tmp, pollMs: 200, rescanMs: 500, log: quiet });
  t.after(() => h.stop());
  await s.until((f) => f.filter((x) => x.t === 'session' && x.kind === 'agent').length === 3, 5000, 'three agents');
  assert.deepEqual(s.frames.filter((x) => x.t === 'session' && x.kind === 'agent').map((x) => x.sid), ['first', 'second', 'third']);
  const first = s.frames.find((x) => x.t === 'session' && x.sid === 'first');
  assert.equal(first.started, Date.parse('2026-10-17T20:00:00.000Z'), 'a session carries when it started: its first timestamped line');
  assert.ok(isServerEvent(first));
});
