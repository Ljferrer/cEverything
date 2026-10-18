// The Codex source: a read-only tail of the OpenAI Codex rollout tree under
// `~/.codex/sessions` that maps each JSONL line to plan 1's frames, modeled on
// claude.mjs.
//
// Layout: `<root>/YYYY/MM/DD/rollout-<ts>-<threadId>[_<segment>].jsonl`. Every
// file opens with a `session_meta` line whose payload names the thread (`id`)
// and, for a spawned subagent, `source.subagent.thread_spawn.parent_thread_id`.
// A thread with history pages has one file per segment; only the newest is
// tracked. Guardian reviews (any other `source.subagent`) are skipped. Thread
// names come from `<root>/../session_index.jsonl` when it exists.
//
// Lines are `{timestamp, type, payload}`. `response_item` payloads carry the
// conversation: `message` (user/assistant/developer), `reasoning` (summary
// text, often encrypted only), `function_call` / `custom_tool_call` /
// `local_shell_call` and their `*_output`. `event_msg` payloads `task_started`,
// `task_complete`, and `turn_aborted` drive status. Old rollouts that wrote
// bare response items (no `payload` wrapper) map the same way.
//
// A file at most SEED_BYTES long is parsed whole; a longer one (Codex threads
// reach hundreds of MB) is read as a HEAD_BYTES head for the title and a
// SEED_BYTES tail for the seed. Read-only: no `sendCommand`, no writes.
import fs from 'node:fs';
import { readdir, readFile, stat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isServerEvent } from '../../shared/protocol.mjs';
import { capStrings, compact, argOf, numberOpt, deriveTitle } from './claude.mjs';

export const SEED_LINES = 40;
export const SEED_BYTES = 2 * 1024 * 1024;
export const HEAD_BYTES = 512 * 1024;
export const SLAB_CACHE = 200;
export const TEXT_CAP = 2000;
export const HEAD_CAP = 80;
export const SUMMARY_CAP = 120;
export const DEFAULTS = Object.freeze({ sinceMinutes: 30, max: 6, maxAgents: 8, pollMs: 1000, rescanMs: 5000, workingMs: 5000 });

const ROLLOUT = /^rollout-.+\.jsonl$/;
const ITEM_TYPES = new Set(['message', 'reasoning', 'function_call', 'custom_tool_call', 'local_shell_call', 'function_call_output', 'custom_tool_call_output']);
/** Context Codex injects as a user message: AGENTS.md, environment, heartbeats, aborts. */
const INJECTED = /^\s*(# AGENTS\.md instructions|<(environment_context|user_instructions|heartbeat|turn_aborted|INSTRUCTIONS)\b)/;

/** sid → {title, slabs: Map<id, text>} for `titleOf` and `slabText`, kept across starts. */
const records = new Map();
/** Every running start() handle, so the relay's module-level `stop()` reaches them. */
const handles = new Set();

export function titleOf(sid) {
  return records.get(sid)?.title;
}

export function slabText(sid, id) {
  return records.get(sid)?.slabs.get(id);
}

/** relay.close() calls a module-level stop and ignores start()'s handle. */
export function stop() {
  for (const h of [...handles]) h.stop();
}

function record(sid, title) {
  const r = records.get(sid) ?? { title, slabs: new Map() };
  r.title = title;
  records.set(sid, r);
  return r;
}

function rememberSlab(sid, frame) {
  const r = records.get(sid) ?? record(sid, sid);
  r.slabs.set(frame.id, frame.text);
  while (r.slabs.size > SLAB_CACHE) r.slabs.delete(r.slabs.keys().next().value);
}

// ---- pure helpers ----------------------------------------------------------

const cut = (s, n) => (s.length > n ? s.slice(0, n) : s);
const firstLine = (s) => s.split('\n').find((l) => l.trim()) ?? '';

/** The response item a line carries: the `payload` of a `response_item`, or a bare old-format item. */
function itemOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'response_item') return obj.payload && typeof obj.payload === 'object' ? obj.payload : null;
  return ITEM_TYPES.has(obj.type) && !('payload' in obj) ? obj : null;
}

/** The text a user typed: `user.text` items when Codex tags them, else every item that is not injected context. */
function userText(item) {
  const kinds = item.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const parts = (Array.isArray(item.content) ? item.content : []).filter((c, i) => {
    if (!c || typeof c.text !== 'string') return false;
    return Array.isArray(kinds) ? kinds[i] === 'user.text' : !INJECTED.test(c.text);
  });
  return parts.length ? parts.map((c) => c.text).join('\n') : undefined;
}

function assistantText(item) {
  const parts = (Array.isArray(item.content) ? item.content : []).filter((c) => c && typeof c.text === 'string');
  return parts.length ? parts.map((c) => c.text).join('\n') : undefined;
}

/** Reasoning summary text, plus any plain reasoning content; encrypted-only reasoning has none. */
function reasoningText(item) {
  const parts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]
    .filter((c) => c && typeof c.text === 'string' && c.text.trim())
    .map((c) => c.text);
  return parts.length ? parts.join('\n\n') : undefined;
}

/** A tool output as text: a string (or old `{output}` JSON), `{content}`, or a list of text items. */
function outputText(output) {
  if (typeof output === 'string') {
    try {
      const o = JSON.parse(output);
      if (o && typeof o.output === 'string') return o.output;
    } catch {}
    return output;
  }
  if (Array.isArray(output)) {
    const texts = output.filter((c) => c && typeof c.text === 'string').map((c) => c.text);
    return texts.length ? texts.join('\n') : undefined;
  }
  if (output && typeof output === 'object') return outputText(output.content ?? output.output);
  return undefined;
}

/** `<name> <argument head>`: a shell command line, the first code line, or the JSON head. */
function toolSlabText(name, args) {
  let head;
  // Codex Desktop's `exec` tool wraps a call in JS: `text(await tools.exec_command({cmd:"…"}))`.
  const wrapped = typeof args?.input === 'string' && /tools\.(\w+)\(\{\s*cmd:\s*("(?:[^"\\]|\\.)*")/.exec(args.input);
  if (wrapped) {
    try {
      return `${name} ${cut(firstLine(JSON.parse(wrapped[2])), HEAD_CAP)}`;
    } catch {}
  }
  if (typeof args === 'string') head = firstLine(args);
  else if (typeof args?.cmd === 'string') head = firstLine(args.cmd);
  else if (Array.isArray(args?.command)) head = (args.command[1] === '-lc' ? args.command.slice(2) : args.command).join(' ');
  else if (typeof args?.command === 'string') head = firstLine(args.command);
  else if (typeof args?.code === 'string') head = firstLine(args.code);
  else if (typeof args?.input === 'string') head = firstLine(args.input);
  else if (args !== undefined) head = JSON.stringify(args) ?? '';
  return head ? `${name} ${cut(head, HEAD_CAP)}` : String(name);
}

/** Function-call arguments: parsed JSON, else the raw string. */
function parseArgs(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The tool name the room sees: an MCP namespace joins its tool as `mcp__server__tool`. */
function toolName(item) {
  const name = String(item.name ?? (item.type === 'local_shell_call' ? 'local_shell' : 'tool'));
  return typeof item.namespace === 'string' && item.namespace.startsWith('mcp__') ? `${item.namespace}__${name}` : name;
}

/**
 * Map one parsed rollout line to frames stamped with `sid`. `pending` is the
 * per-file Map<call_id, {name, diff}>: a call sets it, its output reads and
 * deletes it. `fallbackId` names a message or reasoning item that has no `id`
 * (old rollouts); the tracker passes the line's byte offset.
 */
export function mapLine(obj, pending, sid, fallbackId = `${sid}:${obj?.timestamp}`) {
  const item = itemOf(obj);
  if (!item) return [];
  const parsed = Date.parse(obj.timestamp);
  const ts = Number.isFinite(parsed) ? parsed : Date.now();
  const id = typeof item.id === 'string' && item.id ? item.id : String(fallbackId);
  switch (item.type) {
    case 'message': {
      const text = item.role === 'user' ? userText(item) : item.role === 'assistant' ? assistantText(item) : undefined;
      return text === undefined ? [] : [{ t: 'slab', sid, id, role: item.role, text: cut(text, TEXT_CAP), ts }];
    }
    case 'reasoning': {
      const text = reasoningText(item);
      return text === undefined ? [] : [{ t: 'slab', sid, id, role: 'thinking', text: cut(text, TEXT_CAP), ts }];
    }
    case 'function_call':
    case 'custom_tool_call':
    case 'local_shell_call': {
      const callId = String(item.call_id ?? item.id);
      const name = toolName(item);
      const args = item.type === 'function_call' ? parseArgs(item.arguments) : item.type === 'custom_tool_call' ? { input: item.input } : item.action;
      const diff = name === 'apply_patch' && typeof item.input === 'string' ? item.input : undefined;
      pending.set(callId, { name, diff });
      return [
        { t: 'slab', sid, id: callId, role: 'tool', text: cut(toolSlabText(name, args), TEXT_CAP), ts },
        compact({ t: 'tool', sid, id: callId, name, phase: 'start', args: args === undefined ? undefined : capStrings(args) }),
      ];
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = String(item.call_id);
      const call = pending.get(callId);
      pending.delete(callId);
      const text = outputText(item.output);
      return [compact({ t: 'tool', sid, id: callId, name: call?.name, phase: 'complete', summary: text === undefined ? undefined : cut(text, SUMMARY_CAP), diff: call?.diff })];
    }
    default:
      return [];
  }
}

/** Status: growth or an open turn means working; a finished turn (or a final assistant message) means waiting. */
export function statusOf({ turn, lastItem, lastGrowthAt, now, workingMs }) {
  if (now - lastGrowthAt < workingMs) return 'working';
  if (turn === 'open') return 'working';
  if (turn === 'done') return 'waiting';
  if (turn === undefined && lastItem === 'assistant') return 'waiting';
  return 'idle';
}

/** What a `session_meta` payload says about its file: thread id, chat or agent, parent, title hints; null to skip. */
export function metaOf(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string') return null;
  const sub = payload.source && typeof payload.source === 'object' ? payload.source.subagent : undefined;
  const cwdName = typeof payload.cwd === 'string' ? path.basename(payload.cwd) : undefined;
  if (sub === undefined) return { sid: payload.id, kind: 'chat', cwdName };
  const spawn = sub?.thread_spawn;
  const parent = spawn?.parent_thread_id ?? payload.parent_thread_id;
  if (!spawn || typeof parent !== 'string') return null; // guardian reviews and other helpers
  const label = [spawn.agent_nickname ?? payload.agent_nickname, spawn.agent_path ?? payload.agent_path].filter((s) => typeof s === 'string').join(' ');
  return { sid: payload.id, kind: 'agent', parent, label: label || undefined, cwdName };
}

// ---- the source ------------------------------------------------------------

export async function start({
  emit,
  root: rootArg,
  sinceMinutes,
  max,
  maxAgents,
  pollMs = DEFAULTS.pollMs,
  rescanMs = DEFAULTS.rescanMs,
  workingMs = DEFAULTS.workingMs,
  seedBytes = SEED_BYTES,
  applyWindow = false,
  log = (...a) => console.error('[codex]', ...a),
} = {}) {
  if (typeof emit !== 'function') throw new Error('codex source needs emit');
  const explicit = rootArg ?? process.env.OBELISKS_CODEX_ROOT ?? argOf('codex-root');
  const root = path.resolve(explicit ?? path.join(os.homedir(), '.codex', 'sessions'));
  const indexPath = path.join(root, '..', 'session_index.jsonl');
  const window = explicit === undefined || applyWindow === true;
  const sinceMs = numberOpt(sinceMinutes, 'OBELISKS_CODEX_SINCE', 'codex-since', DEFAULTS.sinceMinutes) * 60000;
  const cap = numberOpt(max, 'OBELISKS_CODEX_MAX', 'codex-max', DEFAULTS.max);
  const agentCap = numberOpt(maxAgents, 'OBELISKS_CODEX_MAX_AGENTS', 'codex-max-agents', DEFAULTS.maxAgents);

  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error(`codex root is not a directory: ${root}`);

  /** path → tracked file record; a record joins only after its `session` and seed are sent. */
  const files = new Map();
  /** sid → path of its tracked file, so a newer history segment replaces the older one. */
  const bySid = new Map();
  /** path → meta from its first line (null: skip); a file's first line never changes. */
  const metas = new Map();
  /** thread id → thread name from session_index.jsonl. */
  let names = new Map();
  let stopped = false;

  function send(frame) {
    if (stopped) return;
    if (!isServerEvent(frame)) {
      log('dropped invalid frame', JSON.stringify(frame).slice(0, 200));
      return;
    }
    if (frame.t === 'slab') rememberSlab(frame.sid, frame);
    emit(frame);
  }

  // -- discovery --
  async function listDir(dir) {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  /** Every rollout file under `dir`, at any depth, with its mtime. */
  async function rollouts(dir) {
    const out = [];
    for (const e of await listDir(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await rollouts(p)));
      else if (e.isFile() && ROLLOUT.test(e.name)) {
        const st = await stat(p).catch(() => null);
        if (st) out.push({ p, mtime: st.mtimeMs, size: st.size });
      }
    }
    return out;
  }

  /** Bytes [from, from+len) of a file. */
  async function readRange(p, from, len) {
    const fh = await open(p, 'r');
    try {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, from);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  /** The meta of a file's first line, read in growing chunks (a `session_meta` can be large). */
  async function metaFor(p) {
    if (metas.has(p)) return metas.get(p);
    let meta = null;
    try {
      for (let len = 64 * 1024; len <= 8 * 1024 * 1024; len *= 4) {
        const buf = await readRange(p, 0, len);
        const nl = buf.indexOf(10);
        if (nl < 0 && buf.length === len) continue;
        const obj = JSON.parse(buf.subarray(0, nl < 0 ? buf.length : nl).toString('utf8'));
        if (obj?.type === 'session_meta') meta = metaOf(obj.payload);
        break;
      }
    } catch {
      // unreadable or not JSON yet: retry on the next scan
      return null;
    }
    metas.set(p, meta);
    return meta;
  }

  async function readNames() {
    const next = new Map();
    let text;
    try {
      text = await readFile(indexPath, 'utf8');
    } catch {
      return next;
    }
    for (const line of text.split('\n')) {
      try {
        const o = JSON.parse(line);
        if (typeof o?.id === 'string' && typeof o.thread_name === 'string' && o.thread_name.trim()) next.set(o.id, o.thread_name.trim());
      } catch {}
    }
    return next;
  }

  async function scan() {
    if (stopped) return;
    const now = Date.now();
    names = await readNames();
    /** sid → newest file of that thread. */
    const threads = new Map();
    for (const c of await rollouts(root)) {
      if (window && !files.has(c.p) && now - c.mtime > sinceMs) continue;
      const meta = await metaFor(c.p);
      if (!meta) continue;
      const prev = threads.get(meta.sid);
      if (!prev || c.mtime > prev.mtime) threads.set(meta.sid, { ...c, meta });
    }
    const all = [...threads.values()].sort((a, b) => b.mtime - a.mtime);
    const tracked = (c) => bySid.has(c.meta.sid);
    const chats = all.filter((c) => c.meta.kind === 'chat');
    const shown = chats.slice(0, Math.max(0, cap)).concat(chats.slice(Math.max(0, cap)).filter(tracked));
    for (const c of shown) {
      await follow(c);
      const agents = all.filter((a) => a.meta.kind === 'agent' && a.meta.parent === c.meta.sid);
      const kept = agents.slice(0, Math.max(0, agentCap)).concat(agents.slice(Math.max(0, agentCap)).filter(tracked));
      for (const a of kept) await follow(a);
    }
    // A thread name can arrive after the first turn: re-announce a renamed chat.
    for (const f of files.values()) {
      const name = names.get(f.sid);
      if (f.kind === 'chat' && name && name !== f.title) {
        f.title = name;
        record(f.sid, name);
        send(sessionFrame(f));
      }
    }
  }

  /** Track `c` unless its thread already follows this file; a newer segment replaces the old one. */
  async function follow(c) {
    const current = bySid.get(c.meta.sid);
    if (current === c.p) return;
    if (current !== undefined) {
      if (files.get(current) && files.get(current).mtime >= c.mtime) return;
      files.delete(current);
    }
    await track(c);
  }

  // -- tracking and reading --

  /** Split a chunk into complete lines with their byte offsets, buffering the trailing partial line. */
  function feed(f, chunk) {
    f.buf = f.buf.length ? Buffer.concat([f.buf, chunk]) : chunk;
    const lines = [];
    let from = 0;
    for (let nl = f.buf.indexOf(10); nl >= 0; nl = f.buf.indexOf(10, from)) {
      lines.push({ at: f.bufStart + from, text: f.buf.subarray(from, nl).toString('utf8') });
      from = nl + 1;
    }
    f.buf = f.buf.subarray(from);
    f.bufStart += from;
    return lines;
  }

  /** Feed one complete line through the file's parser state; returns its frames, or null for a non-conversation line. */
  function handleLine(f, { at, text }) {
    if (!text.trim()) return null;
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      log(`skipped a line that is not JSON in ${f.path}`);
      return null;
    }
    if (obj?.type === 'event_msg') {
      const kind = obj.payload?.type;
      if (kind === 'task_started') f.turn = 'open';
      else if (kind === 'task_complete') f.turn = 'done';
      else if (kind === 'turn_aborted') f.turn = 'aborted';
      return null;
    }
    const item = itemOf(obj);
    if (!item) return null;
    f.lastItem = item.type === 'message' ? item.role : item.type;
    if (f.firstUserText === undefined && item.type === 'message' && item.role === 'user') {
      const t = userText(item);
      if (t !== undefined && deriveTitle({ firstUserText: t })) f.firstUserText = t;
    }
    return mapLine(obj, f.pending, f.sid, `${f.sid}:${at}`);
  }

  function currentStatus(f, now = Date.now()) {
    return statusOf({ turn: f.turn, lastItem: f.lastItem, lastGrowthAt: f.lastGrowthAt, now, workingMs });
  }

  function sessionFrame(f) {
    return compact({ t: 'session', sid: f.sid, harness: 'codex', kind: f.kind, title: f.title, status: f.status, parent: f.parent });
  }

  async function track({ p, mtime, size, meta }) {
    const f = {
      path: p,
      sid: meta.sid,
      kind: meta.kind,
      parent: meta.parent,
      mtime,
      offset: 0,
      buf: Buffer.alloc(0),
      bufStart: 0,
      pending: new Map(),
      turn: undefined,
      lastItem: undefined,
      lastGrowthAt: mtime,
      firstUserText: undefined,
      title: undefined,
      status: undefined,
    };
    // `f` stays out of `files` until its seed is sent (see claude.mjs track).
    const perLine = [];
    try {
      if (size > seedBytes) {
        // The head gives the title; the tail (minus its first, partial line) gives the seed and status.
        const head = { ...f, buf: Buffer.alloc(0), bufStart: 0, pending: new Map() };
        for (const line of feed(head, await readRange(p, 0, Math.min(HEAD_BYTES, size)))) {
          handleLine(head, line);
          if (head.firstUserText !== undefined) break;
        }
        f.firstUserText = head.firstUserText;
        const from = size - seedBytes;
        const tail = await readRange(p, from, seedBytes);
        const nl = tail.indexOf(10);
        f.bufStart = from + nl + 1;
        for (const line of feed(f, tail.subarray(nl + 1))) {
          const frames = handleLine(f, line);
          if (frames) perLine.push(frames);
        }
      } else {
        for (const line of feed(f, await readRange(p, 0, size))) {
          const frames = handleLine(f, line);
          if (frames) perLine.push(frames);
        }
      }
    } catch (err) {
      log(`cannot read ${p}: ${err.message}`);
      return;
    }
    f.offset = f.bufStart + f.buf.length;
    const seed = perLine.slice(-SEED_LINES).flat();
    f.title =
      (f.kind === 'agent' ? meta.label : names.get(f.sid) || deriveTitle({ firstUserText: f.firstUserText })) || meta.cwdName || f.sid;
    f.status = currentStatus(f);
    record(f.sid, f.title);
    if (stopped) return;
    send(sessionFrame(f));
    for (const frame of seed) send(frame);
    files.set(p, f);
    bySid.set(f.sid, p);
  }

  /** Read the bytes appended since the last offset; a shrink restarts from 0. */
  async function readTail(f) {
    try {
      const st = await stat(f.path);
      if (st.size < f.offset) {
        f.offset = 0;
        f.buf = Buffer.alloc(0);
        f.bufStart = 0;
      }
      if (st.size > f.offset) {
        const chunk = await readRange(f.path, f.offset, st.size - f.offset);
        f.offset += chunk.length;
        f.mtime = st.mtimeMs;
        f.lastGrowthAt = Date.now();
        for (const line of feed(f, chunk)) for (const frame of handleLine(f, line) ?? []) send(frame);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') log(`read failed for ${f.path}: ${err.message}`);
    }
  }

  let ticking = false;
  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      for (const f of [...files.values()]) {
        await readTail(f);
        if (stopped) return;
        const status = currentStatus(f);
        if (status !== f.status) {
          f.status = status;
          send({ t: 'state', sid: f.sid, status });
        }
      }
    } finally {
      ticking = false;
    }
  }

  let chain = Promise.resolve();
  const rescan = () => {
    chain = chain.then(scan).catch((err) => log(`rescan failed: ${err.message}`));
    return chain;
  };
  let watchDebounce = null;
  let watcher = null;
  try {
    watcher = fs.watch(root, { recursive: true }, () => {
      if (stopped || watchDebounce) return;
      watchDebounce = setTimeout(() => {
        watchDebounce = null;
        rescan();
      }, 50);
    });
    watcher.on('error', (err) => log(`watch error: ${err.message}`));
  } catch (err) {
    log(`fs.watch unavailable, polling only: ${err.message}`);
  }

  await rescan();
  const pollTimer = setInterval(() => void tick(), pollMs);
  const rescanTimer = setInterval(() => void rescan(), rescanMs);
  log(`tracking ${files.size} file(s) under ${root}${window ? ` (last ${sinceMs / 60000} min)` : ''}`);

  const handle = {
    stop() {
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(rescanTimer);
      clearTimeout(watchDebounce);
      watchDebounce = null;
      watcher?.close();
      handles.delete(handle);
    },
  };
  handles.add(handle);
  return handle;
}
