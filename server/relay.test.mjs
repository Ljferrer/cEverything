import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { startRelay, parseArgs, VIEW_ONLY } from './relay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const quiet = () => {};
const relays = [];
after(async () => {
  for (const r of relays) await r.close();
});

async function relay(opts = {}) {
  const r = await startRelay({ port: 0, sources: ['synthetic'], log: quiet, ...opts });
  relays.push(r);
  return r;
}

/** Connect and return a client that records every frame and can wait for one. */
function connect(r, query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}/relay${query}`);
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
  const open = new Promise((resolve) => ws.once('open', resolve));
  return { ws, frames, until, open, send: (o) => ws.send(JSON.stringify(o)) };
}

test('a keyed client gets mode canEdit:true and mode synthetic', async () => {
  const r = await relay();
  const c = connect(r, '?key=edit');
  const [first] = await c.until((f) => f.length >= 1);
  assert.deepEqual(first, { t: 'mode', mode: 'synthetic', canEdit: true });
  c.ws.close();
});

test('a bare client gets mode canEdit:false and its say is refused', async () => {
  const r = await relay();
  const c = connect(r);
  const [first] = await c.until((f) => f.length >= 1);
  assert.deepEqual(first, { t: 'mode', mode: 'synthetic', canEdit: false });
  c.send({ t: 'say', sid: 'syn-a', text: 'hello' });
  const frames = await c.until((f) => f.some((x) => x.t === 'error'));
  assert.deepEqual(frames.find((x) => x.t === 'error'), { t: 'error', text: VIEW_ONLY });
  c.ws.close();
});

test('a wrong key is a viewer; OBELISKS_EDIT_KEY override is honored', async () => {
  const r = await relay({ editKey: 'secret' });
  const bad = connect(r, '?key=edit');
  const good = connect(r, '?key=secret');
  const [b] = await bad.until((f) => f.length >= 1);
  const [g] = await good.until((f) => f.length >= 1);
  assert.equal(b.canEdit, false);
  assert.equal(g.canEdit, true);
  bad.ws.close();
  good.ws.close();
});

test('synthetic replay serves three sessions, a thinking slab, and a tool event', async () => {
  const r = await relay();
  const c = connect(r);
  const frames = await c.until(
    (f) =>
      new Set(f.filter((x) => x.t === 'session').map((x) => x.sid)).size >= 3 &&
      f.some((x) => x.t === 'slab' && x.role === 'thinking') &&
      f.some((x) => x.t === 'tool'),
  );
  assert.equal(frames[0].t, 'mode');
  assert.equal(frames[0].mode, 'synthetic');
  const sessions = frames.filter((x) => x.t === 'session');
  assert.ok(sessions.some((s) => s.parent && s.phase), 'one session has parent and phase');
  assert.ok(sessions.every((s) => s.harness === 'synthetic'));
  c.ws.close();
});

test('the fixture holds every role and is valid protocol', async () => {
  const { isServerEvent } = await import('../shared/protocol.mjs');
  const lines = (await readFile(path.join(HERE, '..', 'fixtures', 'synthetic.jsonl'), 'utf8')).split('\n').filter(Boolean);
  const frames = lines.map((l) => JSON.parse(l));
  for (const f of frames) assert.ok(isServerEvent(f), JSON.stringify(f));
  const roles = new Set(frames.filter((f) => f.t === 'slab').map((f) => f.role));
  assert.deepEqual([...roles].sort(), ['assistant', 'thinking', 'tool', 'user']);
  assert.equal(new Set(frames.filter((f) => f.t === 'session').map((f) => f.sid)).size, 3);
});

test('the slab cache keeps the last 200 per session and replays to a late client', async () => {
  const r = await relay();
  for (let i = 0; i < 250; i++) {
    r.broadcast({ t: 'slab', sid: 'cache', id: `m${i}`, role: 'user', text: String(i), ts: i });
  }
  assert.equal(r.slabs.get('cache').length, 200);
  assert.equal(r.slabs.get('cache')[0].id, 'm50');
  r.broadcast({ t: 'delta', sid: 'cache', id: 'm249', role: 'user', text: '!' });
  assert.equal(r.slabs.get('cache').at(-1).text, '249!');
  const late = connect(r);
  const frames = await late.until((f) => f.filter((x) => x.sid === 'cache').length >= 200);
  assert.equal(frames[0].t, 'mode');
  late.ws.close();
});

test('a delta appends to the cached copy, never to the object the source emitted', async () => {
  const r = await relay();
  // One slab object and one delta object, emitted twice, as a looping source does.
  const slab = { t: 'slab', sid: 'alias', id: 's1', role: 'assistant', text: 'base', ts: 1 };
  const delta = { t: 'delta', sid: 'alias', id: 's1', role: 'assistant', text: '+more' };
  for (let loop = 0; loop < 2; loop++) {
    r.broadcast(slab, 'loop');
    r.broadcast(delta, 'loop');
  }
  assert.equal(slab.text, 'base', 'the source object is untouched');
  const cached = r.slabs.get('alias');
  assert.equal(cached.length, 2);
  assert.ok(cached.every((s) => s !== slab), 'the cache never holds the source object itself');
  assert.deepEqual(cached.map((s) => s.text), ['base+more', 'base+more'], 'each cached copy holds the delta exactly once');
  // A delta for an id with no cached slab is a no-op on the cache.
  const stray = { t: 'delta', sid: 'alias', id: 'nope', role: 'assistant', text: 'x' };
  assert.equal(r.broadcast(stray), true);
  assert.deepEqual(cached.map((s) => s.text), ['base+more', 'base+more']);
});

test('an invalid frame is dropped, not broadcast', async () => {
  const r = await relay();
  const c = connect(r);
  await c.until((f) => f.length >= 1);
  assert.equal(r.broadcast({ t: 'slab', sid: 'x' }), false);
  assert.equal(r.broadcast({ t: 'bogus' }), false);
  assert.equal(c.frames.filter((f) => f.t === 'bogus').length, 0);
  c.ws.close();
});

test('setMode re-sends mode to every client with its own canEdit', async () => {
  const r = await relay();
  const v = connect(r);
  const e = connect(r, '?key=edit');
  await v.until((f) => f.length >= 1);
  await e.until((f) => f.length >= 1);
  r.setMode('live');
  const vf = await v.until((f) => f.some((x) => x.t === 'mode' && x.mode === 'live'));
  const ef = await e.until((f) => f.some((x) => x.t === 'mode' && x.mode === 'live'));
  assert.deepEqual(vf.find((x) => x.mode === 'live'), { t: 'mode', mode: 'live', canEdit: false });
  assert.deepEqual(ef.find((x) => x.mode === 'live'), { t: 'mode', mode: 'live', canEdit: true });
  v.ws.close();
  e.ws.close();
});

test('an editor command with no module gets an error; bad json and bad shapes too', async () => {
  const r = await relay();
  const c = connect(r, '?key=edit');
  await c.until((f) => f.length >= 1);
  c.send({ t: 'fork', sid: 'syn-a' });
  await c.until((f) => f.some((x) => x.t === 'error' && x.text === 'no command: fork'));
  c.send({ t: 'shout', sid: 'syn-a' });
  await c.until((f) => f.some((x) => x.t === 'error' && x.text === 'bad command'));
  c.ws.send('{nope');
  await c.until((f) => f.some((x) => x.t === 'error' && x.text === 'bad json'));
  c.ws.close();
});

test('a rejecting source is skipped, synthetic runs; an editor command reaches its module', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'obelisks-relay-'));
  await mkdir(path.join(dir, 'sources'));
  await mkdir(path.join(dir, 'commands'));
  const synthetic = pathToFileURL(path.join(HERE, 'sources', 'synthetic.mjs')).href;
  await writeFile(path.join(dir, 'sources', 'boom.mjs'), `export async function start() { throw new Error('no host'); }\n`);
  await writeFile(path.join(dir, 'sources', 'synthetic.mjs'), `export * from ${JSON.stringify(synthetic)};\n`);
  await writeFile(
    path.join(dir, 'commands', 'say.mjs'),
    `export const name = 'say';\n` +
      `export async function run(cmd, { emit, ownerOf }) {\n` +
      `  emit({ t: 'slab', sid: cmd.sid, id: 'echo', role: 'user', text: cmd.text + (ownerOf(cmd.sid) ? ' [owned]' : ''), ts: 0 });\n` +
      `}\n`,
  );
  const logged = [];
  const r = await relay({
    sources: 'boom,missing',
    sourcesDir: path.join(dir, 'sources'),
    commandsDir: path.join(dir, 'commands'),
    log: (...a) => logged.push(a.join(' ')),
  });
  assert.equal(r.mode, 'synthetic');
  assert.deepEqual([...r.sources.keys()], ['synthetic']);
  assert.ok(logged.some((l) => l.includes('boom') && l.includes('skipped')));
  assert.ok(logged.some((l) => l.includes('no source module: missing')));

  const c = connect(r, '?key=edit');
  await c.until((f) => f.some((x) => x.t === 'session' && x.sid === 'syn-a'));
  c.send({ t: 'say', sid: 'syn-a', text: 'hi' });
  const frames = await c.until((f) => f.some((x) => x.t === 'slab' && x.id === 'echo'));
  assert.equal(frames.find((x) => x.id === 'echo').text, 'hi [owned]');
  c.ws.close();
});

test('--record appends every broadcast frame as JSONL', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'obelisks-rec-'));
  const file = path.join(dir, 'rec.jsonl');
  const r = await relay({ record: file });
  r.broadcast({ t: 'state', sid: 'syn-a', status: 'error' });
  const c = connect(r);
  await c.until((f) => f.some((x) => x.t === 'tool'));
  await new Promise((res) => setTimeout(res, 50));
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((f) => f.t === 'state' && f.status === 'error'));
  assert.ok(lines.some((f) => f.t === 'tool'));
  c.ws.close();
});

test('parseArgs reads --source, --record, --port', () => {
  assert.deepEqual(parseArgs(['--source', 'a,b', '--record', 'x.jsonl', '--port', '0']), {
    sources: 'a,b',
    record: 'x.jsonl',
    port: 0,
  });
  assert.deepEqual(parseArgs(['--source=synthetic']), { sources: 'synthetic' });
});
