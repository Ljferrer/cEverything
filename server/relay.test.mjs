import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { startRelay, parseArgs, resolvePort, VIEW_ONLY } from './relay.mjs';

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

test('the fixture carries one tool pair per pylon class, each start after its tool slab, a stray sid, and an Agent start', async () => {
  const lines = (await readFile(path.join(HERE, '..', 'fixtures', 'synthetic.jsonl'), 'utf8')).split('\n').filter(Boolean);
  const frames = lines.map((l) => JSON.parse(l));
  const tools = frames.filter((f) => f.t === 'tool');
  for (const name of ['web_search', 'write_file', 'terminal']) {
    const start = tools.find((f) => f.name === name && f.phase === 'start');
    const complete = tools.find((f) => f.name === name && f.phase === 'complete');
    assert.ok(start && complete && start.id === complete.id, `${name} start/complete pair`);
  }
  const write = tools.filter((f) => f.name === 'write_file');
  assert.equal(typeof write.find((f) => f.phase === 'start').args.path, 'string', 'write_file start carries args.path');
  assert.match(write.find((f) => f.phase === 'complete').diff, /^--- .*\n\+\+\+ .*\n@@ /, 'write_file complete carries a unified diff');
  const sids = new Set(frames.filter((f) => f.t === 'session').map((f) => f.sid));
  for (const start of tools.filter((f) => f.phase === 'start' && sids.has(f.sid))) {
    const slabAt = frames.findIndex((f) => f.t === 'slab' && f.role === 'tool' && f.sid === start.sid && f.id === start.id);
    assert.ok(slabAt >= 0 && slabAt < frames.indexOf(start), `${start.name} ${start.id}: a role-tool slab of the same id comes before the start`);
  }
  assert.equal(tools.filter((f) => !sids.has(f.sid)).length, 1, 'exactly one tool frame names an undeclared sid');
  assert.equal(tools.filter((f) => f.name === 'Agent' && f.phase === 'start').length, 1, 'one Agent start');
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
  // An empty commands dir: the real server/commands/ now holds fork (plan 2).
  const r = await relay({ commandsDir: await mkdtemp(path.join(tmpdir(), 'obelisks-nocmd-')) });
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
      `export async function handle(cmd, { emit, ownerOf, commands }) {\n` +
      `  emit({ t: 'slab', sid: cmd.sid, id: 'echo', role: 'user', text: cmd.text + (ownerOf(cmd.sid) ? ' [owned]' : ''), ts: 0 });\n` +
      `  return { t: 'state', sid: cmd.sid, status: 'say' in commands && 'fork' in commands ? 'working' : 'error' };\n` +
      `}\n`,
  );
  // A second module that delegates to `say` by property access on ctx.commands,
  // the exact form plan 5's voice uses: `ctx.commands.say.handle(...)`.
  await writeFile(
    path.join(dir, 'commands', 'fork.mjs'),
    `export const name = 'fork';\n` +
      `export async function handle(cmd, ctx) {\n` +
      `  return ctx.commands.say.handle({ t: 'say', sid: cmd.sid, text: 'forked' }, ctx);\n` +
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
  // relay.commands is the object ctx carries: a null-prototype plain object keyed
  // by `name`, so `commands.say` resolves and no Object.prototype key leaks in.
  assert.equal(Object.getPrototypeOf(r.commands), null);
  assert.deepEqual(Object.keys(r.commands), ['fork', 'say']);
  assert.equal(typeof r.commands.say.handle, 'function');
  assert.equal('toString' in r.commands, false);

  const c = connect(r, '?key=edit');
  const other = connect(r);
  await c.until((f) => f.some((x) => x.t === 'session' && x.sid === 'syn-a'));
  await other.until((f) => f.length >= 1);
  c.send({ t: 'say', sid: 'syn-a', text: 'hi' });
  const frames = await c.until((f) => f.some((x) => x.t === 'state' && x.sid === 'syn-a' && x.status === 'working'));
  assert.equal(frames.find((x) => x.id === 'echo').text, 'hi [owned]', 'emit broadcasts');
  // The resolved frame reaches only the issuing client.
  await other.until((f) => f.some((x) => x.id === 'echo'));
  assert.equal(other.frames.filter((x) => x.t === 'state' && x.status === 'working').length, 0);
  // One command delegates to another through ctx.commands.
  c.send({ t: 'fork', sid: 'syn-a' });
  const forked = await c.until((f) => f.filter((x) => x.t === 'state' && x.status === 'working').length >= 2);
  assert.ok(forked.some((x) => x.t === 'slab' && x.id === 'echo' && x.text === 'forked [owned]'), 'say ran on behalf of fork');
  c.ws.close();
  other.ws.close();
});

test('a handle that resolves nothing sends nothing back; a rejecting handle answers with an error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'obelisks-cmd-'));
  await mkdir(path.join(dir, 'commands'));
  await writeFile(path.join(dir, 'commands', 'say.mjs'), `export const name = 'say';\nexport async function handle() {}\n`);
  await writeFile(
    path.join(dir, 'commands', 'fork.mjs'),
    `export const name = 'fork';\nexport async function handle() { throw new Error('nope'); }\n`,
  );
  const r = await relay({ commandsDir: path.join(dir, 'commands') });
  const c = connect(r, '?key=edit');
  await c.until((f) => f.length >= 1);
  c.send({ t: 'say', sid: 'syn-a', text: 'quiet' });
  c.send({ t: 'fork', sid: 'syn-a' });
  const frames = await c.until((f) => f.some((x) => x.t === 'error'));
  assert.deepEqual(frames.find((x) => x.t === 'error'), { t: 'error', text: 'fork failed: nope' });
  assert.equal(frames.filter((x) => x.t === 'error').length, 1);
  c.ws.close();
});

async function stubSources() {
  const dir = await mkdtemp(path.join(tmpdir(), 'obelisks-src-'));
  await mkdir(path.join(dir, 'sources'));
  const stub = `export async function start({ emit }) { emit({ t: 'session', sid: 'S', harness: 'hermes', kind: 'chat', title: 't', status: 'idle', parent: null, phase: null }); }\n`;
  await writeFile(path.join(dir, 'sources', 'replay.mjs'), stub);
  await writeFile(path.join(dir, 'sources', 'hermes.mjs'), stub);
  return path.join(dir, 'sources');
}

test('a started source named replay yields mode replay, even beside a live source', async () => {
  const sourcesDir = await stubSources();
  const alone = await relay({ sources: 'replay', sourcesDir });
  assert.equal(alone.mode, 'replay');
  const c = connect(alone);
  const [first] = await c.until((f) => f.length >= 1);
  assert.deepEqual(first, { t: 'mode', mode: 'replay', canEdit: false });
  c.ws.close();
  const mixed = await relay({ sources: 'hermes,replay', sourcesDir });
  assert.equal(mixed.mode, 'replay');
  const live = await relay({ sources: 'hermes', sourcesDir });
  assert.equal(live.mode, 'live');
});

test('a source-emitted mode frame updates the mode and is re-sent composed, never raw', async () => {
  const r = await relay();
  const c = connect(r, '?key=edit');
  await c.until((f) => f.length >= 1);
  assert.equal(r.broadcast({ t: 'mode', mode: 'replay' }, 'synthetic'), true);
  const frames = await c.until((f) => f.some((x) => x.t === 'mode' && x.mode === 'replay'));
  assert.deepEqual(frames.at(-1), { t: 'mode', mode: 'replay', canEdit: true });
  assert.ok(frames.every((x) => x.t !== 'mode' || typeof x.canEdit === 'boolean'), 'every mode frame carries canEdit');
  assert.equal(r.mode, 'replay');
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

test('parseArgs reads --source, --record, --port and ignores flags it does not own', () => {
  assert.deepEqual(parseArgs(['--source', 'a,b', '--record', 'x.jsonl', '--port', '0']), {
    sources: 'a,b',
    record: 'x.jsonl',
    port: 0,
  });
  assert.deepEqual(parseArgs(['--source=synthetic']), { sources: 'synthetic' });
  // --replay, --seed and --fast belong to sources, which read process.argv themselves.
  assert.deepEqual(parseArgs(['--source', 'synthetic', '--replay', '/dev/null', '--seed', '1', '--fast']), {
    sources: 'synthetic',
  });
  assert.deepEqual(parseArgs([]), {});
});

test('the CLI still starts with flags it does not own', async () => {
  const child = spawn(
    process.execPath,
    [path.join(HERE, 'relay.mjs'), '--source', 'synthetic', '--replay', '/dev/null', '--seed', '1', '--fast', '--port', '0'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let err = '';
  const listening = new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => {
      err += d;
      const m = err.match(/listening on (\d+), mode (\w+)/);
      if (m) resolve({ port: Number(m[1]), mode: m[2] });
    });
    child.on('exit', (code) => reject(new Error(`relay exited ${code}: ${err}`)));
  });
  try {
    const { port, mode } = await listening;
    assert.equal(mode, 'synthetic');
    assert.ok(port > 0);
  } finally {
    child.kill();
  }
});

test('a late client gets session, then slabs in order, then state, per sid (PIN-24 backfill)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'obelisks-late-'));
  await mkdir(path.join(dir, 'sources'));
  await writeFile(
    path.join(dir, 'sources', 'hermes.mjs'),
    `export async function start({ emit }) {\n` +
      `  emit({ t: 'session', sid: 'L', harness: 'hermes', kind: 'chat', title: 'late', status: 'idle', parent: null, phase: null });\n` +
      `  emit({ t: 'slab', sid: 'L', id: 'a', role: 'user', text: 'first', ts: 1 });\n` +
      `  emit({ t: 'slab', sid: 'L', id: 'b', role: 'assistant', text: 'second', ts: 2 });\n` +
      `  emit({ t: 'state', sid: 'L', status: 'working' });\n` +
      `  emit({ t: 'state', sid: 'L', status: 'waiting' });\n` +
      `}\n`,
  );
  const r = await relay({ sources: 'hermes', sourcesDir: path.join(dir, 'sources') });
  assert.deepEqual(r.states.get('L'), { t: 'state', sid: 'L', status: 'waiting' }, 'the last state frame is cached per sid');
  assert.equal(r.sessions.get('L').sid, 'L');
  const late = connect(r);
  const frames = await late.until((f) => f.some((x) => x.t === 'state' && x.sid === 'L'));
  assert.equal(frames[0].t, 'mode', 'the composed mode frame comes first');
  const forL = frames.filter((x) => x.sid === 'L');
  assert.deepEqual(
    forL.map((x) => x.t),
    ['session', 'slab', 'slab', 'state'],
    'session before any slab, slabs in arrival order, state last',
  );
  assert.deepEqual(forL.slice(1, 3).map((x) => x.id), ['a', 'b']);
  assert.equal(forL.at(-1).status, 'waiting', 'only the last state is replayed');
  late.ws.close();
});

test('a stub x.test.mjs and an export-less helper.mjs beside the sources are skipped; the relay still starts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'obelisks-stray-'));
  await mkdir(path.join(dir, 'sources'));
  const synthetic = pathToFileURL(path.join(HERE, 'sources', 'synthetic.mjs')).href;
  await writeFile(path.join(dir, 'sources', 'synthetic.mjs'), `export * from ${JSON.stringify(synthetic)};\n`);
  // Importing the test stub would throw: the loader must never touch it.
  await writeFile(path.join(dir, 'sources', 'x.test.mjs'), `throw new Error('x.test.mjs was imported');\n`);
  await writeFile(path.join(dir, 'sources', 'helper.mjs'), `// no exports\n`);
  const logged = [];
  const r = await relay({ sources: 'helper', sourcesDir: path.join(dir, 'sources'), log: (...a) => logged.push(a.join(' ')) });
  assert.deepEqual([...r.sources.keys()], ['synthetic']);
  assert.ok(logged.some((l) => l.includes('helper') && l.includes('no start')), `helper logged at load time: ${logged}`);
  assert.ok(logged.some((l) => l.includes('no source module: helper')));
  assert.ok(logged.every((l) => !l.includes('x.test')), 'the test stub is never mentioned');
});

test('a command module without both name and handle is skipped and never registers a phantom command', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'obelisks-phantom-'));
  await mkdir(path.join(dir, 'commands'));
  await writeFile(path.join(dir, 'commands', 'say.mjs'), `export const name = 'say';\nexport async function handle() { return { t: 'state', sid: 'syn-a', status: 'working' }; }\n`);
  await writeFile(path.join(dir, 'commands', 'fork.mjs'), `export async function handle() {}\n`); // no name
  await writeFile(path.join(dir, 'commands', 'pipe.mjs'), `export const name = 'pipe';\n`); // no handle
  await writeFile(path.join(dir, 'commands', 'util.mjs'), `export const clamp = (n) => n;\n`); // neither
  const logged = [];
  const r = await relay({ commandsDir: path.join(dir, 'commands'), log: (...a) => logged.push(a.join(' ')) });
  assert.deepEqual(Object.keys(r.commands), ['say']);
  for (const f of ['fork', 'pipe', 'util']) assert.ok(logged.some((l) => l.includes(f) && l.includes('skipped')), `${f} logged: ${logged}`);
  const c = connect(r, '?key=edit');
  await c.until((f) => f.length >= 1);
  c.send({ t: 'fork', sid: 'syn-a' });
  await c.until((f) => f.some((x) => x.t === 'error' && x.text === 'no command: fork'));
  c.ws.close();
});

test('resolvePort: --port wins, else OBELISKS_PORT, else 8787', () => {
  assert.equal(resolvePort(9000, { OBELISKS_PORT: '1' }), 9000);
  assert.equal(resolvePort(0, { OBELISKS_PORT: '1' }), 0);
  assert.equal(resolvePort(undefined, { OBELISKS_PORT: '4321' }), 4321);
  assert.equal(resolvePort(undefined, { OBELISKS_PORT: '0' }), 0);
  assert.equal(resolvePort(undefined, {}), 8787);
  assert.equal(resolvePort(undefined, { OBELISKS_PORT: '' }), 8787);
});

test('OBELISKS_PORT=0 with no --port yields a free port from the CLI', async () => {
  const child = spawn(process.execPath, [path.join(HERE, 'relay.mjs'), '--source', 'synthetic'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, OBELISKS_PORT: '0' },
  });
  let err = '';
  const listening = new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => {
      err += d;
      const m = err.match(/listening on (\d+), mode (\w+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error(`relay exited ${code}: ${err}`)));
  });
  try {
    const port = await listening;
    assert.ok(port > 0 && port !== 8787, `free port, got ${port}`);
  } finally {
    child.kill();
  }
});

test('an editor picks the chats every viewer sees: left-out chats and their subagents stop streaming, and the pick persists', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'obelisks-include-'));
  await mkdir(path.join(dir, 'sources'));
  await writeFile(
    path.join(dir, 'sources', 'hermes.mjs'),
    `let emit;\nexport async function start(ctx) {\n  emit = ctx.emit;\n` +
      `  emit({ t: 'session', sid: 'A', harness: 'hermes', kind: 'chat', title: 'keep', status: 'idle', parent: null, phase: null });\n` +
      `  emit({ t: 'session', sid: 'A1', harness: 'hermes', kind: 'agent', title: 'kid', status: 'idle', parent: 'A', phase: null });\n` +
      `  emit({ t: 'session', sid: 'B', harness: 'hermes', kind: 'chat', title: 'drop', status: 'idle', parent: null, phase: null });\n` +
      `  emit({ t: 'slab', sid: 'B', id: 'b', role: 'user', text: 'hidden', ts: 1 });\n` +
      `  globalThis.__later = () => { emit({ t: 'slab', sid: 'B', id: 'b2', role: 'user', text: 'still hidden', ts: 2 }); emit({ t: 'slab', sid: 'A1', id: 'k', role: 'assistant', text: 'shown', ts: 3 }); };\n}\n`,
  );
  const includeFile = path.join(dir, 'include.json');
  const r = await relay({ sources: 'hermes', sourcesDir: path.join(dir, 'sources'), includeFile });
  const viewer = connect(r);
  const first = await viewer.until((f) => f.some((x) => x.t === 'chats'));
  const list = first.find((x) => x.t === 'chats');
  assert.deepEqual(list.chats.map((c) => [c.sid, c.agents]), [['A', 1], ['B', 0]], 'every main chat, with its subagent count');
  assert.equal(list.include, null, 'every chat shows by default');

  viewer.send({ t: 'include', sids: ['A'] });
  await viewer.until((f) => f.some((x) => x.t === 'error'));
  assert.equal(r.include, null, 'a viewer cannot change the pick');

  const editor = connect(r, '?key=edit');
  await editor.open;
  editor.send({ t: 'include', sids: ['A'] });
  await viewer.until((f) => f.some((x) => x.t === 'chats' && x.include?.[0] === 'A'));
  globalThis.__later();
  await viewer.until((f) => f.some((x) => x.id === 'k'));
  assert.ok(!viewer.frames.some((x) => x.id === 'b2'), 'a left-out chat stops streaming');

  const late = connect(r);
  const frames = await late.until((f) => f.some((x) => x.id === 'k'));
  assert.deepEqual([...new Set(frames.filter((x) => x.sid).map((x) => x.sid))], ['A', 'A1'], 'a late client gets only the picked chat and its subagent');
  assert.deepEqual(JSON.parse(await readFile(includeFile, 'utf8')), ['A'], 'the pick is saved');

  const again = await relay({ sources: 'synthetic', includeFile });
  assert.deepEqual([...again.include], ['A'], 'a restarted relay keeps the pick');
  for (const c of [viewer, editor, late]) c.ws.close();
});
