// The Claude Code source (plan 3, PIN-20): a read-only tail of the transcript
// tree under `~/.claude/projects` that maps each JSONL line to plan 1's frames.
//
// Layout (PIN-41): `<root>/<slug>/<sid>.jsonl` is a chat transcript;
// `<root>/<slug>/<sid>/subagents/**/agent-<agentId>.jsonl` beside
// `agent-<agentId>.meta.json` is an agent transcript whose parent is `<sid>`.
// One `fs.watch(root, {recursive: true})` plus a `rescanMs` timer rediscover
// files; a `pollMs` tick stats every tracked file and reads only the appended
// bytes (PIN-40). On first track a file is parsed from byte 0 and the frames of
// its last SEED_LINES message lines are emitted after its `session` frame.
//
// Read-only (PIN-6): this module exports neither `sendCommand` nor `handle` and
// never writes under the root. `titleOf(sid)` and `slabText(sid, id)` are plan
// 1's optional source exports, served from a per-session record.
import fs from 'node:fs';
import { readdir, readFile, stat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isServerEvent } from '../../shared/protocol.mjs';

export const SEED_LINES = 40;
export const SLAB_CACHE = 200;
export const TEXT_CAP = 2000;
export const TITLE_CAP = 60;
export const HEAD_CAP = 80;
export const SUMMARY_CAP = 120;
export const DEFAULTS = Object.freeze({ sinceMinutes: 30, max: 6, maxAgents: 8, pollMs: 1000, rescanMs: 5000, workingMs: 5000 });

/** sid → {title, slabs: Map<id, text>} for `titleOf` and `slabText`, kept across starts. */
const records = new Map();

export function titleOf(sid) {
  return records.get(sid)?.title;
}

export function slabText(sid, id) {
  return records.get(sid)?.slabs.get(id);
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

/** Cut every string inside `v` (deeply) to TEXT_CAP characters. */
export function capStrings(v) {
  if (typeof v === 'string') return cut(v, TEXT_CAP);
  if (Array.isArray(v)) return v.map(capStrings);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x)]));
  return v;
}

/** Drop every key whose value is `undefined` so no frame carries one (PIN-43). */
export function compact(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** The text of a `tool_result` block's content: a string, or its text blocks joined. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    return texts.length ? texts.join('\n') : undefined;
  }
  return undefined;
}

/** `<name> <argument head>`: the first `command` line for Bash, `file_path` for Read/Edit/Write, else the JSON head. */
function toolSlabText(name, input) {
  let head;
  if (name === 'Bash' && typeof input?.command === 'string') head = input.command.split('\n')[0];
  else if (['Read', 'Edit', 'Write'].includes(name) && typeof input?.file_path === 'string') head = input.file_path;
  else if (input !== undefined) head = cut(JSON.stringify(input) ?? '', HEAD_CAP);
  return head ? `${name} ${head}` : String(name);
}

/** Chat title precedence (PIN-42): the sidecar title, else the latest `custom-title` line, else the first user text stripped of tags. */
export function deriveTitle({ customTitle, customTitleLine, firstUserText } = {}) {
  if (typeof customTitle === 'string' && customTitle.trim()) return customTitle.trim();
  if (typeof customTitleLine === 'string' && customTitleLine.trim()) return customTitleLine.trim();
  if (typeof firstUserText !== 'string') return '';
  const text = firstUserText
    .replace(/<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cut(text, TITLE_CAP);
}

/** Status heuristic (PIN-44): growth or an open tool call means working; an assistant turn ending in text means waiting. */
export function statusOf({ lastMessageType, lastAssistantBlock, pendingOpen, lastGrowthAt, now, workingMs }) {
  if (now - lastGrowthAt < workingMs) return 'working';
  if (lastAssistantBlock === 'tool_use' && pendingOpen) return 'working';
  if (lastMessageType === 'assistant' && lastAssistantBlock === 'text') return 'waiting';
  return 'idle';
}

/** True for a `user` or `assistant` line that carries a `message` (bookkeeping ignored). */
function isMessageLine(obj) {
  return !!obj && (obj.type === 'user' || obj.type === 'assistant') && obj.message != null && typeof obj.message === 'object';
}

/** The first user text of a line, for the title: string content or its first text block. */
function userText(obj) {
  const c = obj.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.find((b) => b && b.type === 'text' && typeof b.text === 'string')?.text;
  return undefined;
}

/**
 * Map one parsed transcript line to frames stamped with `sid` (PIN-43, PIN-45).
 * `pending` is the per-file Map<tool_use id, name>: a `tool_use` sets it, its
 * `tool_result` reads and deletes it.
 */
export function mapLine(obj, pending, sid) {
  if (!isMessageLine(obj) || obj.isMeta === true) return [];
  const { message } = obj;
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const ts = Number.isFinite(Date.parse(obj.timestamp)) ? Date.parse(obj.timestamp) : Date.now();
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : [];
  const frames = [];
  blocks.forEach((block, i) => {
    if (!block || typeof block !== 'object') return;
    const id = i === 0 ? String(obj.uuid) : `${obj.uuid}:${i}`;
    if (block.type === 'text') {
      if (typeof block.text === 'string') frames.push({ t: 'slab', sid, id, role, text: cut(block.text, TEXT_CAP), ts });
    } else if (block.type === 'thinking') {
      if (typeof block.thinking === 'string') frames.push({ t: 'slab', sid, id, role: 'thinking', text: cut(block.thinking, TEXT_CAP), ts });
    } else if (block.type === 'tool_use') {
      const name = String(block.name);
      const toolId = String(block.id);
      frames.push({ t: 'slab', sid, id: toolId, role: 'tool', text: cut(toolSlabText(name, block.input), TEXT_CAP), ts });
      frames.push(compact({ t: 'tool', sid, id: toolId, name, phase: 'start', args: block.input === undefined ? undefined : capStrings(block.input) }));
      pending.set(toolId, name);
    } else if (block.type === 'tool_result') {
      const toolId = String(block.tool_use_id);
      const name = pending.get(toolId);
      const text = resultText(block.content);
      let diff;
      if ((name === 'Edit' || name === 'Write') && Array.isArray(obj.toolUseResult?.structuredPatch)) {
        diff = obj.toolUseResult.structuredPatch.flatMap((h) => (Array.isArray(h?.lines) ? h.lines : [])).join('\n');
      }
      frames.push(compact({ t: 'tool', sid, id: toolId, name, phase: 'complete', summary: text === undefined ? undefined : cut(text, SUMMARY_CAP), diff }));
      pending.delete(toolId);
    }
    // `image` and unknown blocks drop.
  });
  return frames;
}

// ---- configuration ---------------------------------------------------------

/** `--name value` or `--name=value` from argv, else undefined. */
export function argOf(name, argv = process.argv) {
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) return argv[i + 1];
    if (argv[i].startsWith(flag + '=')) return argv[i].slice(flag.length + 1);
  }
  return undefined;
}

export function numberOpt(given, env, flag, fallback) {
  const raw = given ?? process.env[env] ?? argOf(flag);
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) ? n : fallback;
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
  applyWindow = false,
  log = (...a) => console.error('[claude]', ...a),
} = {}) {
  if (typeof emit !== 'function') throw new Error('claude source needs emit');
  const explicit = rootArg ?? process.env.OBELISKS_CLAUDE_ROOT ?? argOf('claude-root');
  const root = path.resolve(explicit ?? path.join(os.homedir(), '.claude', 'projects'));
  const window = explicit === undefined || applyWindow === true;
  const sinceMs = numberOpt(sinceMinutes, 'OBELISKS_CLAUDE_SINCE', 'claude-since', DEFAULTS.sinceMinutes) * 60000;
  const cap = numberOpt(max, 'OBELISKS_CLAUDE_MAX', 'claude-max', DEFAULTS.max);
  const agentCap = numberOpt(maxAgents, 'OBELISKS_CLAUDE_MAX_AGENTS', 'claude-max-agents', DEFAULTS.maxAgents);

  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error(`claude root is not a directory: ${root}`);

  const startedAt = Date.now();
  /** path → tracked file record; a record joins only after its `session` and seed are sent, so a tick never reads a half-seeded file. */
  const files = new Map();
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

  // -- discovery (PIN-41) --
  async function listDir(dir) {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  async function statMtime(p) {
    try {
      const st = await stat(p);
      return st.isFile() ? st.mtimeMs : null;
    } catch {
      return null;
    }
  }

  /** Every `agent-*.jsonl` under `dir`, at any depth. */
  async function agentFiles(dir) {
    const out = [];
    for (const e of await listDir(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await agentFiles(p)));
      else if (e.isFile() && /^agent-.+\.jsonl$/.test(e.name)) out.push(p);
    }
    return out;
  }

  async function scan() {
    if (stopped) return;
    const now = Date.now();
    const candidates = [];
    for (const slug of await listDir(root)) {
      if (!slug.isDirectory()) continue;
      const dir = path.join(root, slug.name);
      for (const e of await listDir(dir)) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const p = path.join(dir, e.name);
        const mtime = await statMtime(p);
        if (mtime === null) continue;
        if (window && !files.has(p) && now - mtime > sinceMs) continue;
        candidates.push({ p, mtime, dir, sid: e.name.slice(0, -6) });
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const chats = candidates.slice(0, Math.max(0, cap)).concat(candidates.slice(Math.max(0, cap)).filter((c) => files.has(c.p)));
    for (const c of chats) {
      if (!files.has(c.p)) await track(c.p, { sid: c.sid, kind: 'chat', sidecar: path.join(c.dir, c.sid, 'custom-title.json') });
      const agents = [];
      for (const p of await agentFiles(path.join(c.dir, c.sid, 'subagents'))) {
        const st = await stat(p).catch(() => null);
        if (st?.isFile()) agents.push({ p, mtime: st.mtimeMs, born: st.birthtimeMs || st.mtimeMs });
      }
      // The cap keeps the most recently active agents; they are announced oldest
      // first, so a client seats them in the order they started (its fan grows from the base).
      agents.sort((a, b) => b.mtime - a.mtime);
      const kept = agents.slice(0, Math.max(0, agentCap)).sort((a, b) => a.born - b.born || a.p.localeCompare(b.p));
      for (const a of kept) {
        if (files.has(a.p)) continue;
        const agentId = path.basename(a.p).slice('agent-'.length, -'.jsonl'.length);
        await track(a.p, { sid: agentId, kind: 'agent', parent: c.sid, meta: a.p.slice(0, -'.jsonl'.length) + '.meta.json' });
      }
    }
  }

  // -- tracking and reading (PIN-40, PIN-42) --
  async function readJson(p) {
    try {
      return JSON.parse(await readFile(p, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Feed one complete line through the file's parser state; returns its frames. */
  function handleLine(f, line) {
    if (!line.trim()) return [];
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      log(`skipped a line that is not JSON in ${f.path}`);
      return [];
    }
    if (obj && obj.type === 'custom-title' && typeof obj.customTitle === 'string') f.customTitleLine = obj.customTitle;
    if (!isMessageLine(obj)) return [];
    f.messageLines++;
    f.lastMessageType = obj.type;
    if (obj.type === 'assistant') {
      const c = obj.message.content;
      const last = Array.isArray(c) ? c[c.length - 1] : typeof c === 'string' ? { type: 'text' } : null;
      f.lastAssistantBlock = last?.type;
      f.lastToolUseId = last?.type === 'tool_use' ? String(last.id) : undefined;
    }
    if (obj.type === 'user' && obj.isMeta !== true && f.firstUserText === undefined) {
      const t = userText(obj);
      if (t !== undefined && deriveTitle({ firstUserText: t })) f.firstUserText = t;
    }
    const sid = (obj.isSidechain ? obj.agentId : obj.sessionId) ?? f.sid;
    return mapLine(obj, f.pending, sid);
  }

  /** Split a chunk into complete lines, buffering the trailing partial line. */
  function feed(f, chunk) {
    f.buf += f.decoder.write(chunk);
    const parts = f.buf.split('\n');
    f.buf = parts.pop();
    return parts;
  }

  function currentStatus(f, now = Date.now()) {
    return statusOf({
      lastMessageType: f.lastMessageType,
      lastAssistantBlock: f.lastAssistantBlock,
      pendingOpen: f.lastToolUseId !== undefined && f.pending.has(f.lastToolUseId),
      lastGrowthAt: f.lastGrowthAt,
      now,
      workingMs,
    });
  }

  /** The first `timestamp` among the first lines of a transcript, as ms, or null. */
  function firstTimestamp(data) {
    const head = data.subarray(0, 64 * 1024).toString('utf8').split('\n').slice(0, 50);
    for (const line of head) {
      try {
        const t = Date.parse(JSON.parse(line).timestamp);
        if (Number.isFinite(t)) return t;
      } catch {}
    }
    return null;
  }

  async function track(p, { sid, kind, parent, sidecar, meta }) {
    const f = {
      path: p,
      sid,
      kind,
      offset: 0,
      buf: '',
      decoder: new StringDecoder('utf8'),
      pending: new Map(),
      messageLines: 0,
      lastMessageType: undefined,
      lastAssistantBlock: undefined,
      lastToolUseId: undefined,
      lastGrowthAt: 0,
      firstUserText: undefined,
      customTitleLine: undefined,
      status: undefined,
    };
    // `f` stays local until the seed is sent: the poll tick iterates `files`,
    // and a record it could see with offset 0 would be tailed from byte 0 and
    // its frames sent (and later re-sent by the seed) before the `session`.
    let st;
    let data;
    try {
      st = await stat(p);
      data = await readFile(p);
    } catch (err) {
      log(`cannot read ${p}: ${err.message}`);
      return;
    }
    f.offset = data.length;
    f.lastGrowthAt = st.mtimeMs;
    // Parse every line (titles, tool pairing, and status need all of them) but
    // keep only the frames of the last SEED_LINES message lines.
    const perLine = [];
    for (const line of feed(f, data)) {
      const before = f.messageLines;
      const frames = handleLine(f, line);
      if (f.messageLines > before) perLine.push(frames);
    }
    const seed = perLine.slice(-SEED_LINES).flat();
    // When the session started: its first timestamped line, else the file's birth. The client
    // replays a session from here, though only the last SEED_LINES lines are sent.
    const started = firstTimestamp(data) ?? (st.birthtimeMs || st.mtimeMs);

    let title;
    let session;
    if (kind === 'agent') {
      const m = (await readJson(meta)) ?? {};
      title = typeof m.description === 'string' ? m.description : typeof m.agentType === 'string' ? m.agentType : sid;
      session = compact({ t: 'session', sid, harness: 'claude', kind, title, status: currentStatus(f), parent, phase: typeof m.workflowPhase === 'string' ? m.workflowPhase : undefined, started });
    } else {
      const sc = await readJson(sidecar);
      title = deriveTitle({ customTitle: sc?.customTitle, customTitleLine: f.customTitleLine, firstUserText: f.firstUserText }) || sid;
      session = { t: 'session', sid, harness: 'claude', kind, title, status: currentStatus(f), started };
    }
    f.status = session.status;
    record(sid, title);
    if (stopped) return;
    send(session);
    for (const frame of seed) send(frame);
    files.set(p, f);
  }

  /** Read the bytes appended since the last offset; a shrink restarts from 0. */
  async function readTail(f) {
    try {
      const st = await stat(f.path);
      if (st.size < f.offset) {
        f.offset = 0;
        f.buf = '';
        f.decoder = new StringDecoder('utf8');
      }
      if (st.size > f.offset) {
        const fh = await open(f.path, 'r');
        try {
          const len = st.size - f.offset;
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, f.offset);
          f.offset += bytesRead;
          f.lastGrowthAt = Date.now();
          for (const line of feed(f, buf.subarray(0, bytesRead))) for (const frame of handleLine(f, line)) send(frame);
        } finally {
          await fh.close();
        }
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

  // Rescans serialize on one chain; watch events coalesce through a short delay.
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
  log(`tracking ${files.size} file(s) under ${root}${window ? ` (last ${sinceMs / 60000} min)` : ''}, since ${new Date(startedAt).toISOString()}`);

  return {
    stop() {
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(rescanTimer);
      clearTimeout(watchDebounce);
      watchDebounce = null;
      watcher?.close();
    },
  };
}
