// The Obelisks relay: the only thing headsets talk to (PIN-9). It loads every
// server/sources/*.mjs and server/commands/*.mjs, starts the named sources,
// re-broadcasts their frames to every client, caches the last 200 slabs per
// session beside the last `session` and `state` frame, replays that cache per
// sid (session, slabs, state) to a late client (PIN-24), and routes editor
// commands to command modules (PIN-19, PIN-22, PIN-23).
//
// A source module exports `start({emit, sendCommand})` and may export `stop()`.
// A writable source also exports `sendCommand(method, params)`, `titleOf(sid)`,
// and `slabText(sid, id)`; a source without `sendCommand` is read-only. A
// command module exports `name` (matches the command's `t`) and
// `handle(cmd, ctx)`; the relay awaits `handle` and sends its resolved frame
// (if any) back to the issuing client. `ctx` is `{relay, sources, commands,
// emit, ownerOf(sid)}`, where `commands` is a null-prototype plain object
// keyed by `name` (`ctx.commands.say`), so one command can delegate to another
// by property access: plan 5's voice awaits `ctx.commands.say.handle(...)`.
// `relay.commands` is that same object.
//
// Every outbound `{t:'mode', mode, canEdit}` frame is composed here: `mode` is
// `synthetic` when only the fallback runs, `replay` when a started source is
// named `replay`, else `live`. A source-emitted `{t:'mode', mode}` only updates
// that state and is never broadcast raw.
//
// CLI: node server/relay.mjs [--source a,b] [--record <file>] [--port 8787]
// Flags the relay does not own (`--replay`, `--seed`, `--fast`) are ignored
// here; sources read them from process.argv themselves.
import { WebSocketServer } from 'ws';
import { readdir, appendFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs as parseCliArgs } from 'node:util';
import path from 'node:path';
import { isServerEvent, isClientCommand, MODES } from '../shared/protocol.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SOURCES = ['hermes', 'claude'];
export const SLAB_CACHE = 200;
export const VIEW_ONLY = 'view-only link';

/** Import every *.mjs in `dir` (sorted by filename) as `Map<basename, module>`. A missing dir is empty. */
export async function loadModules(dir) {
  const mods = new Map();
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return mods;
    throw err;
  }
  for (const f of names.filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs')).sort()) {
    mods.set(f.slice(0, -4), await import(pathToFileURL(path.join(dir, f)).href));
  }
  return mods;
}

/** Compose the mode from the started source names: replay wins, synthetic only when nothing else runs. */
export function modeFor(started) {
  if (started.includes('replay')) return 'replay';
  if (started.every((n) => n === 'synthetic')) return 'synthetic';
  return 'live';
}

export async function startRelay({
  port = 8787,
  sources: wanted = DEFAULT_SOURCES,
  record = null,
  editKey = process.env.OBELISKS_EDIT_KEY ?? 'edit',
  sourcesDir = path.join(HERE, 'sources'),
  commandsDir = path.join(HERE, 'commands'),
  log = (...a) => console.error('[relay]', ...a),
} = {}) {
  const sourceMods = await loadModules(sourcesDir);
  const commandMods = await loadModules(commandsDir);
  const commands = Object.create(null);
  for (const [file, mod] of commandMods) commands[mod.name ?? file] = mod;

  const relay = {
    port,
    mode: 'synthetic',
    clients: new Set(),
    /** sid → last `session` frame, kept so a late client sees every obelisk. */
    sessions: new Map(),
    /** sid → last SLAB_CACHE `slab` frames, in arrival order. Each entry is the relay's own copy: a `delta` appends to it, never to the source's object. */
    slabs: new Map(),
    /** sid → last `state` frame, replayed after the slabs so a late client sees the current status. */
    states: new Map(),
    /** sid → name of the source that announced the session. */
    owners: new Map(),
    /** name → started source module. */
    sources: new Map(),
    commands,
    broadcast,
    setMode,
    ownerOf: (sid) => relay.sources.get(relay.owners.get(sid)) ?? null,
    close,
  };

  function modeFrame(client) {
    return { t: 'mode', mode: relay.mode, canEdit: client.canEdit };
  }

  function sendTo(client, frame) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(frame));
  }

  function remember(frame, owner) {
    if (frame.t === 'session') {
      relay.sessions.set(frame.sid, frame);
      if (owner) relay.owners.set(frame.sid, owner);
    } else if (frame.t === 'state') {
      relay.states.set(frame.sid, frame);
      const s = relay.sessions.get(frame.sid);
      if (s) relay.sessions.set(frame.sid, { ...s, status: frame.status });
    } else if (frame.t === 'slab') {
      const list = relay.slabs.get(frame.sid) ?? [];
      list.push({ ...frame });
      if (list.length > SLAB_CACHE) list.splice(0, list.length - SLAB_CACHE);
      relay.slabs.set(frame.sid, list);
    } else if (frame.t === 'delta') {
      const open = relay.slabs.get(frame.sid)?.findLast((s) => s.id === frame.id);
      if (open) open.text += frame.text;
    }
  }

  /** Send one validated server frame to every client; `owner` names the emitting source. */
  function broadcast(frame, owner = null) {
    // A `mode` frame is never broadcast raw: it updates the state and every
    // client gets the relay's own composed frame with its canEdit.
    if (frame?.t === 'mode' && MODES.includes(frame.mode)) {
      setMode(frame.mode);
      return true;
    }
    if (!isServerEvent(frame)) {
      log('dropped invalid frame from', owner ?? 'relay', JSON.stringify(frame).slice(0, 200));
      return false;
    }
    remember(frame, owner);
    if (record) appendFile(record, JSON.stringify(frame) + '\n').catch((e) => log('record failed:', e.message));
    for (const c of relay.clients) sendTo(c, frame);
    return true;
  }

  /** Replay the cache to a late client, per sid: `session`, its slabs in order, then its last `state` (PIN-24). Sids with no `session` frame follow. */
  function backfill(client) {
    const sids = new Set([...relay.sessions.keys(), ...relay.slabs.keys(), ...relay.states.keys()]);
    for (const sid of sids) {
      const session = relay.sessions.get(sid);
      if (session) sendTo(client, session);
      for (const s of relay.slabs.get(sid) ?? []) sendTo(client, s);
      const state = relay.states.get(sid);
      if (state) sendTo(client, state);
    }
  }

  /** Change live/replay/synthetic and tell every client (each with its own canEdit). */
  function setMode(mode) {
    relay.mode = mode;
    for (const c of relay.clients) sendTo(c, modeFrame(c));
  }

  const ctxFor = () => ({ relay, sources: relay.sources, commands, emit: (f) => broadcast(f), ownerOf: relay.ownerOf });

  /** Route one client command as an editor would; sources use this through `sendCommand` (no client, so no reply). */
  async function route(cmd, client) {
    const reply = (text) => client && sendTo(client, { t: 'error', text });
    if (!isClientCommand(cmd)) return reply('bad command');
    if (client && !client.canEdit) return reply(VIEW_ONLY);
    const mod = commands[cmd.t];
    if (!mod?.handle) return reply(`no command: ${cmd.t}`);
    let result;
    try {
      result = await mod.handle(cmd, ctxFor());
    } catch (err) {
      log(`command ${cmd.t} failed:`, err.message);
      return reply(`${cmd.t} failed: ${err.message}`);
    }
    if (result == null || !client) return;
    if (isServerEvent(result)) sendTo(client, result);
    else {
      log(`command ${cmd.t} resolved an invalid frame:`, JSON.stringify(result).slice(0, 200));
      reply(`${cmd.t} resolved an invalid frame`);
    }
  }

  // Start sources: every named one that resolves; synthetic when none does.
  const wantedList = Array.isArray(wanted) ? wanted : String(wanted).split(',').map((s) => s.trim()).filter(Boolean);
  async function startSource(name) {
    const mod = sourceMods.get(name);
    if (!mod?.start) {
      log(`no source module: ${name}`);
      return false;
    }
    try {
      await mod.start({ emit: (f) => broadcast(f, name), sendCommand: (cmd) => route(cmd, null) });
      relay.sources.set(name, mod);
      log(`source started: ${name}`);
      return true;
    } catch (err) {
      log(`source ${name} failed to start, skipped:`, err.message);
      return false;
    }
  }
  for (const name of wantedList) await startSource(name);
  if (relay.sources.size === 0 && !(await startSource('synthetic'))) {
    throw new Error('no source started, including synthetic');
  }
  relay.mode = modeFor([...relay.sources.keys()]);

  const wss = new WebSocketServer({ port });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  relay.port = wss.address().port;
  relay.wss = wss;

  wss.on('connection', (ws, req) => {
    const key = new URL(req.url ?? '/', 'ws://relay').searchParams.get('key');
    const client = { ws, canEdit: key === editKey };
    relay.clients.add(client);
    sendTo(client, modeFrame(client));
    backfill(client);
    ws.on('message', (data) => {
      let cmd;
      try {
        cmd = JSON.parse(String(data));
      } catch {
        return sendTo(client, { t: 'error', text: 'bad json' });
      }
      route(cmd, client);
    });
    ws.on('close', () => relay.clients.delete(client));
    ws.on('error', () => relay.clients.delete(client));
  });

  async function close() {
    for (const [name, mod] of relay.sources) {
      try {
        await mod.stop?.();
      } catch (err) {
        log(`source ${name} failed to stop:`, err.message);
      }
    }
    for (const c of relay.clients) c.ws.terminate();
    relay.clients.clear();
    await new Promise((resolve) => wss.close(resolve));
  }

  log(`listening on ${relay.port}, mode ${relay.mode}, sources ${[...relay.sources.keys()].join(',')}`);
  return relay;
}

/** The relay's own flags; anything else (and every positional) is left for sources. */
export function parseArgs(argv) {
  const { values } = parseCliArgs({
    args: argv,
    options: { source: { type: 'string' }, record: { type: 'string' }, port: { type: 'string' } },
    strict: false,
    allowPositionals: true,
  });
  const opts = {};
  if (typeof values.source === 'string') opts.sources = values.source;
  if (typeof values.record === 'string') opts.record = values.record;
  if (typeof values.port === 'string') opts.port = Number(values.port);
  return opts;
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  startRelay(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error('[relay] fatal:', err.message);
    process.exit(1);
  });
}
