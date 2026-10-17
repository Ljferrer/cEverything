// replay.mjs: a recording the test writes, played in `--fast` mode directly and
// at recorded pace through a spawned relay. Each case is named for the plan 2
// End state it proves.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { isServerEvent } from '../../shared/protocol.mjs';
import * as replay from './replay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const children = [];
after(() => {
  replay.stop?.();
  for (const c of children) c.kill();
});

const session = (sid, title) => ({ t: 'session', sid, harness: 'hermes', kind: 'chat', title, status: 'working' });
const slab = (sid, id, role, text, ts) => ({ t: 'slab', sid, id, role, text, ts });

/** Three sessions; the `session` and `tool` frames as `{ts, frame}` lines whose gaps sum to 3.5 s. */
function fixtureLines() {
  const t0 = 1760720400000;
  return [
    { ts: t0, frame: session('r1', 'Replay one') },
    { t: 'mode', mode: 'live', canEdit: false },
    slab('r1', 'a1', 'user', 'first question', t0 + 100),
    { ts: t0 + 1500, frame: session('r2', 'Replay two') },
    slab('r2', 'b1', 'assistant', 'an answer', t0 + 1600),
    { ts: t0 + 2500, frame: { t: 'tool', sid: 'r2', id: 'b2', name: 'read_file', phase: 'start', args: { path: 'x' } } },
    { t: 'state', sid: 'r2', status: 'streaming' },
    { ts: t0 + 3500, frame: session('r3', 'Replay three') },
    { t: 'delta', sid: 'r2', id: 'b1', role: 'assistant', text: ' continued' },
  ];
}

async function writeFixture(lines) {
  const dir = await mkdtemp(path.join(tmpdir(), 'obelisks-replay-'));
  const file = path.join(dir, 'recording.jsonl');
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const frameOf = (l) => ('frame' in l && l.ts !== undefined ? l.frame : l);

test('ES3 --fast replays the recording once: mode signal first, then every recorded frame in order', async () => {
  const lines = fixtureLines();
  const file = await writeFixture(lines);
  const frames = [];
  const t0 = Date.now();
  await replay.start({ emit: (f) => frames.push(f), argv: ['--replay', file, '--fast'], env: {} });
  await new Promise((resolve, reject) => {
    const tick = () => {
      if (frames.length >= lines.length) return resolve();
      if (Date.now() - t0 > 1000) return reject(new Error(`only ${frames.length} frames within one second`));
      setTimeout(tick, 5);
    };
    tick();
  });
  assert.ok(Date.now() - t0 < 1000, 'completed within one second');
  assert.deepEqual(frames[0], { t: 'mode', mode: 'replay' });
  const expected = lines.map(frameOf).filter((f) => f.t !== 'mode');
  assert.equal(frames.length, lines.length, 'the dropped mode:live line is replaced by the leading signal');
  assert.deepEqual(frames.slice(1), expected);
  assert.equal(frames.filter((f) => f.t === 'session').length, 3);
  assert.equal(frames.filter((f) => f.t === 'tool').length, 1);
  assert.equal(frames.filter((f) => f.t === 'slab').length, 2);
  assert.ok(!frames.some((f) => f.t === 'mode' && f.mode === 'live'));
  for (const f of frames.slice(1)) assert.ok(isServerEvent(f), `invalid frame ${JSON.stringify(f)}`);
  assert.ok(!('sendCommand' in replay));
  assert.equal(typeof replay.titleOf, 'function');
  assert.equal(typeof replay.slabText, 'function');
  assert.equal(replay.titleOf('r2'), 'Replay two');
  assert.equal(replay.slabText('r2', 'b1'), 'an answer continued');
  assert.equal(replay.titleOf('nope'), '');
  assert.equal(replay.slabText('r2', 'nope'), '');
});

test('start rejects on a missing recording so the relay falls back', async () => {
  await assert.rejects(replay.start({ emit: () => {}, argv: ['--replay', '/nonexistent/recording.jsonl', '--fast'], env: {} }));
});

/** Connect to the relay and record every frame; `until` waits for a predicate over them. */
function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const frames = [];
  const waiters = [];
  ws.on('message', (data) => {
    frames.push(JSON.parse(String(data)));
    for (const w of [...waiters]) if (w.pred(frames)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(frames);
    }
  });
  const until = (pred, ms = 15000) =>
    new Promise((resolve, reject) => {
      if (pred(frames)) return resolve(frames);
      const t = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(frames.map((f) => f.t))}`)), ms);
      waiters.push({ pred, resolve: (v) => (clearTimeout(t), resolve(v)) });
    });
  return { ws, frames, until };
}

test('ES11 the relay with --source replay labels a late bare client replay and backfills the sessions seen so far', async () => {
  const t0 = 1760720400000;
  const lines = [
    { ts: t0, frame: session('r1', 'Replay one') },
    { ts: t0 + 1000, frame: slab('r1', 'a1', 'user', 'first question', t0) },
    { ts: t0 + 2000, frame: session('r2', 'Replay two') },
    { ts: t0 + 3000, frame: session('r3', 'Replay three') },
    { ts: t0 + 3200, frame: { t: 'state', sid: 'r3', status: 'idle' } },
  ];
  const file = await writeFixture(lines);
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));

  const child = spawn(
    process.execPath,
    ['server/relay.mjs', '--source', 'replay', '--replay', file, '--port', String(port)],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  children.push(child);
  let err = '';
  await new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => {
      err += d;
      if (/listening on \d+, mode replay/.test(err)) resolve();
    });
    child.on('exit', (code) => reject(new Error(`relay exited ${code}: ${err}`)));
  });

  const probe = connect(port);
  await probe.until((f) => f.some((x) => x.t === 'session'));
  const seen = probe.frames.filter((f) => f.t === 'session').map((f) => f.sid);
  assert.ok(seen.length >= 1);

  const bare = connect(port);
  const frames = await bare.until((f) => f.filter((x) => x.t === 'session').length >= seen.length);
  assert.deepEqual(frames[0], { t: 'mode', mode: 'replay', canEdit: false });
  const sessions = frames.filter((f) => f.t === 'session');
  assert.deepEqual(sessions.slice(0, seen.length).map((f) => f.sid), seen, 'the sessions the probe had seen, in order');
  for (const f of frames.slice(1)) assert.ok(isServerEvent(f), `invalid frame ${JSON.stringify(f)}`);
  for (const f of sessions) assert.ok(isServerEvent(f));
  probe.ws.close();
  bare.ws.close();
});
