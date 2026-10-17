// fixtures/demo/_authoring/lib.mjs — builder used by build.mjs to author fixtures/demo/*.jsonl.
// Pure data helpers, no dependencies. Wire shapes follow docs/PROTOCOL.md §2.2–§2.3 and §3.

export const T0 = Date.UTC(2026, 9, 17, 9, 12, 0); // scenario epoch; the server may rebase ts on replay

// Deterministic LCG so re-running the generator yields byte-identical fixtures.
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
export const pick = (r, lo, hi) => Math.round(lo + (hi - lo) * r());

// Category rules (PROTOCOL §2.3, bighelp mapping).
export function categoryOf(name) {
  if (/^(terminal|execute_code|process_manage)$/.test(name)) return 'coding';
  if (/^(read_file|write_file|patch|search_files)$/.test(name)) return 'files';
  if (/^(web_search|web_extract|browser_)/.test(name)) return 'web';
  if (/^(memory|session_search|skill_)/.test(name)) return 'memory';
  if (name === 'delegate_task') return 'delegating';
  if (/^(image_|vision_|video_)/.test(name)) return 'images';
  if (/^(send_message|text_to_speech)$/.test(name)) return 'messaging';
  if (name === 'clarify') return 'waiting';
  return 'tools';
}
export function targetOf(category) {
  return { coding: 'terminal', files: 'files', web: 'browser' }[category] || 'self';
}
// Glyph set (PROTOCOL §2.3): U A ✎ 🔍 ✎ >_ 📁 🧠 ⇄ ⚑ (+ ⚙ for the generic "tools" bucket).
export function glyphOf(role, name = '') {
  if (role === 'user') return 'U';
  if (role === 'assistant') return 'A';
  if (role === 'thinking') return '✎';
  if (role === 'system') return 'S';
  const c = categoryOf(name);
  if (c === 'web') return '🔍';
  if (c === 'coding') return '>_';
  if (c === 'files') return /^(write_file|patch)$/.test(name) ? '✎' : '📁';
  if (c === 'memory') return '🧠';
  if (c === 'delegating') return '⇄';
  if (c === 'waiting') return '⚑';
  if (c === 'images') return '🖼';
  if (c === 'messaging') return '✉';
  return '⚙';
}

export function clip(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}
export function firstSentence(text, max = 100) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = flat.match(/^.*?[.!?](?=\s|$)/);
  return clip(m ? m[0] : flat, max);
}
export function host(url) {
  try { const u = new URL(url); return u.host + (u.pathname.length > 1 ? clip(u.pathname, 28) : ''); } catch { return clip(url, 40); }
}
export function diffStats(diff) {
  let add = 0, del = 0;
  for (const l of String(diff || '').split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) add++; else if (l.startsWith('-')) del++;
  }
  return { add, del };
}
// Build a unified diff from hunks of ['  ctx', '- old', '+ new'] lines (leading char = kind).
export function diff(path, hunks, { oldPath } = {}) {
  const out = [`--- ${oldPath === null ? '/dev/null' : 'a/' + (oldPath || path)}`, `+++ b/${path}`];
  for (const h of hunks) {
    let o = 0, n = 0;
    const body = h.lines.map((l) => {
      const k = l[0], body = l.slice(1);
      if (k === ' ') { o++; n++; return ' ' + body; }
      if (k === '-') { o++; return '-' + body; }
      if (k === '+') { n++; return '+' + body; }
      throw new Error(`bad diff line kind ${JSON.stringify(l)}`);
    });
    const oldRange = o === 0 ? `${h.old},0` : o === 1 ? `${h.old}` : `${h.old},${o}`;
    const newRange = n === 1 ? `${h.new}` : `${h.new},${n}`;
    out.push(`@@ -${oldRange} +${newRange} @@${h.ctx ? ' ' + h.ctx : ''}`, ...body);
  }
  return out.join('\n');
}
// The patch tool's old_string / new_string implied by a hunk (context + removed / context + added).
export function hunkStrings(hunk) {
  const strip = (kinds) => hunk.lines.filter((l) => kinds.includes(l[0])).map((l) => l.slice(1)).join('\n');
  return { old_string: strip(' -'), new_string: strip(' +') };
}
// Hermes `patch` tool in mode "patch" takes a V4A-style patch body.
export function v4a(path, hunks) {
  const body = hunks.map((h) => [`@@${h.ctx ? ' ' + h.ctx : ''}`, ...h.lines].join('\n')).join('\n');
  return `*** Begin Patch\n*** Update File: ${path}\n${body}\n*** End Patch`;
}
export function patchedSummary(d, verb = 'patched') {
  const path = d.match(/^\+\+\+ b\/(.*)$/m)?.[1] ?? '';
  const { add, del } = diffStats(d);
  return `→ ${verb} ${path} (+${add}${del ? ` −${del}` : ''})`;
}
export function newFileDiff(path, content) {
  const lines = content.replace(/\n$/, '').split('\n');
  return diff(path, [{ old: 0, new: 1, lines: lines.map((l) => '+' + l) }], { oldPath: null });
}
export function numbered(content, offset = 1) {
  return content.replace(/\n$/, '').split('\n').map((l, i) => `${i + offset}: ${l}`).join('\n');
}

const STATS_RE = /^(patch|write_file)$/;
export function toolSummary(name, args = {}, meta = {}) {
  const c = categoryOf(name);
  if (c === 'coding') return clip(`$ ${args.command ?? ''}`, 100);
  if (name === 'web_search') return clip(`web_search "${args.query ?? ''}"`, 100);
  if (name === 'web_extract') {
    const urls = args.urls || [];
    return clip(`web_extract ${host(urls[0] || '')}${urls.length > 1 ? ` +${urls.length - 1}` : ''}`, 100);
  }
  if (c === 'web') return clip(`${name} ${host(args.url || '')}`, 100);
  if (STATS_RE.test(name)) {
    const { add, del } = diffStats(meta.diff);
    const st = meta.diff ? (del ? ` (+${add} −${del})` : ` (+${add})`) : '';
    return clip(`${name} ${args.path ?? ''}${st}`, 100);
  }
  if (name === 'search_files') return clip(`search_files /${args.pattern ?? ''}/ ${args.path ?? '.'}`, 100);
  if (c === 'files') return clip(`${name} ${args.path ?? ''}`, 100);
  if (name === 'delegate_task') {
    const goal = args.tasks?.[0]?.goal ?? args.goal ?? '';
    return clip(`delegate_task "${clip(goal, 70)}"`, 100);
  }
  if (name === 'memory') return clip(`memory ${args.action ?? ''} "${clip(args.content ?? '', 60)}"`, 100);
  if (name === 'todo_list') {
    const t = args.todos || []; const ip = t.filter((x) => x.status === 'in_progress').length;
    return clip(`todo_list ${t.length} items${ip ? ` (${ip} in progress)` : ''}`, 100);
  }
  if (name === 'clarify') return clip(`clarify "${args.questions?.[0]?.question ?? ''}"`, 100);
  return clip(`${name} ${JSON.stringify(args)}`, 100);
}

// Split text into 20–60 char chunks at word boundaries (message.delta streaming).
export function chunks(text, r, lo = 20, hi = 60) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let L = Math.min(pick(r, lo, hi), text.length - i);
    if (i + L < text.length) {
      const sp = text.lastIndexOf(' ', i + L - 1);
      if (sp > i + L / 2) L = sp - i + 1;
    }
    out.push(text.slice(i, i + L));
    i += L;
  }
  return out;
}

const EMPTY_COUNTS = () => ({
  messages: 0, toolCalls: 0,
  byCategory: { web: 0, files: 0, coding: 0, memory: 0, delegating: 0, images: 0, messaging: 0, waiting: 0, tools: 0 },
});

export class SessionWriter {
  constructor(session, { seed = 1, pace = 1 } = {}) {
    this.id = session.id;
    this.lines = [];
    this.t = 0;           // ms since the file's first line
    this.n = 0;           // row counter for ids
    this.pace = pace;     // multiplies authored dts (not the internal tool.start / delta jitter)
    this.r = rng(seed);
    this.started = session.startedAt ?? T0;
    this.calls = new Map();
    this.callsPerRow = new Map();
    const full = {
      id: session.id, title: session.title, status: session.status ?? 'idle', model: session.model,
      cwd: session.cwd ?? '/workspace/cEverything', gitBranch: session.gitBranch ?? 'main',
      parentId: session.parentId ?? null, endReason: session.endReason ?? null,
      startedAt: this.started, lastActivityAt: this.started, activity: session.activity ?? 'idle',
      counts: EMPTY_COUNTS(), toolHistory: [], currentTool: null,
      summary: clip(session.summary ?? '', 80), attention: session.attention ?? null,
    };
    this.first = full;
    this.push(0, { kind: 'session.upsert', session: full });
  }
  // Re-emit session metadata (e.g. status done + endReason at the end). Counts stay zero: the server recomputes.
  upsert(dt, overrides = {}) {
    const S = { ...this.first, ...overrides, lastActivityAt: this.started + this.t + dt * this.pace };
    S.summary = clip(S.summary, 80);
    if (S.attention && !S.attention.since) S.attention = { ...S.attention, since: S.lastActivityAt };
    return this.push(dt, { kind: 'session.upsert', session: S });
  }
  // ---- clock helpers -------------------------------------------------------
  ts() { return this.started + this.t; }
  until(absT) { return Math.max(0, (absT - this.t) / this.pace); } // authored dt that lands the next line at absT
  jitter(lo, hi) { return pick(this.r, lo, hi); }
  push(dt, ev, { raw = false } = {}) {
    dt = Math.max(0, Math.round(raw ? dt : dt * this.pace));
    this.t += dt;
    if (ev.message) ev.message.ts = this.ts();                         // stamp at the line's own offset
    if (ev.kind === 'session.status' && ev.attention) ev.attention.since = this.ts();
    const line = { dt, sessionId: this.id, ...ev };
    this.lines.push(line);
    return line;
  }
  nextId() { return `${this.id}:m${++this.n}`; }
  // ---- events --------------------------------------------------------------
  status(dt, status, activity, attention = null) {
    const ev = { kind: 'session.status', status, activity };
    if (status === 'waiting_on_you') ev.attention = { since: 0, ...attention };   // since is stamped in push()
    else if (attention) ev.attention = { since: 0, ...attention };
    else ev.attention = null;
    return this.push(dt, ev);
  }
  message(role, id, text, extra = {}) {
    const m = { id, sessionId: this.id, role, ts: this.ts(), text, summary: extra.summary ?? firstSentence(text),
      glyph: extra.glyph ?? glyphOf(role, extra.tool?.name) };
    delete extra.summary; delete extra.glyph;
    return Object.assign(m, extra);
  }
  user(dt, text, { via = 'keyboard', from, id } = {}) {
    const m = this.message('user', id ?? this.nextId(), text, { via, ...(from ? { from } : {}) });
    this.push(dt, { kind: 'message.add', message: m });
    return m;
  }
  // thinking belongs to the assistant row `forId` (id `<forId>:r`) and precedes it.
  thinking(dt, text, { forId, stream = false } = {}) {
    const id = `${forId}:r`;
    const m = this.message('thinking', id, stream ? '' : text, { parentMessageId: forId, summary: firstSentence(text) });
    m.tokens = Math.round(text.length / 4);
    return stream ? this.stream(dt, m, text, stream) : (this.push(dt, { kind: 'message.add', message: m }), m);
  }
  assistant(dt, text, { id, stream = false } = {}) {
    const m = this.message('assistant', id ?? this.nextId(), stream ? '' : text, { summary: firstSentence(text) });
    m.tokens = Math.round(text.length / 4);
    return stream ? this.stream(dt, m, text, stream) : (this.push(dt, { kind: 'message.add', message: m }), m);
  }
  stream(dt, m, text, opts) {
    const o = opts === true ? {} : opts;
    m.streaming = true;
    this.push(dt, { kind: 'message.add', message: { ...m } }); // copy: the line must keep streaming:true, text ''
    for (const c of chunks(text, this.r, o.lo ?? 20, o.hi ?? 60)) {
      this.push(this.jitter(o.dtLo ?? 30, o.dtHi ?? 80), { kind: 'message.delta', messageId: m.id, text: c }, { raw: true });
    }
    this.push(this.jitter(40, 120), { kind: 'message.complete', messageId: m.id, text }, { raw: true });
    m.text = text; m.streaming = false;
    return m;
  }
  // A tool call: tool_call Message (id `<rowId>:c<n>`) then tool.start (small dt).
  toolCall(dt, name, args, { rowId, callN, preview, meta = {} } = {}) {
    const row = rowId ?? this.nextId();
    const n = callN ?? (this.callsPerRow.get(row) || 0) + 1; // several calls on one row → c1, c2, …
    this.callsPerRow.set(row, n);
    const callId = `${row}:c${n}`;
    const category = categoryOf(name), target = targetOf(category);
    const summary = toolSummary(name, args, meta);
    const text = `${name} ${JSON.stringify(args, null, 2)}`;
    const prev = preview ?? defaultPreview(name, args);
    const m = this.message('tool_call', callId, text, { summary, tool: { callId, name, category, target, args, preview: prev } });
    this.push(dt, { kind: 'message.add', message: m });
    this.push(this.jitter(30, 90), { kind: 'tool.start', messageId: callId, callId, name, category, args, preview: prev, target }, { raw: true });
    const call = { msgId: callId, callId, name, category, target, args, startedT: this.t, meta };
    this.calls.set(callId, call);
    return call;
  }
  // The tool_result Message (own row id, parentMessageId → call) then tool.complete (small dt).
  toolResult(dt, call, { text, ok = true, preview, summary, meta } = {}) {
    const id = this.nextId();
    const m2 = { ...(call.meta || {}), ...(meta || {}) };
    const prev = preview ?? clip(text, 80);
    const sum = summary ?? (ok ? `→ ${clip(text.split('\n')[0], 94)}` : `✗ ${clip(text.split('\n')[0], 94)}`);
    const durationMs = this.t + Math.round(dt * this.pace) - call.startedT; // fixture time since tool.start
    const m = this.message('tool_result', id, text, {
      summary: clip(sum, 100), glyph: glyphOf('tool_call', call.name), parentMessageId: call.msgId,
      tool: { callId: call.callId, name: call.name, category: call.category, target: call.target, ok, durationMs, preview: prev, ...(Object.keys(m2).length ? { meta: m2 } : {}) },
    });
    this.push(dt, { kind: 'message.add', message: m });
    const ev = { kind: 'tool.complete', messageId: call.msgId, callId: call.callId, name: call.name, ok, durationMs, preview: prev, resultMessageId: id };
    if (Object.keys(m2).length) ev.meta = m2;
    this.push(this.jitter(20, 60), ev, { raw: true });
    return m;
  }
  toJSONL() { return this.lines.map((l) => JSON.stringify(l)).join('\n') + '\n'; }
}

function defaultPreview(name, args) {
  if (args.command) return clip(args.command, 80);
  if (args.query) return clip(args.query, 80);
  if (args.urls) return clip(args.urls[0], 80);
  if (args.url) return clip(args.url, 80);
  if (args.path) return clip(args.path, 80);
  if (args.tasks?.[0]?.goal) return clip(args.tasks[0].goal, 80);
  if (args.content) return clip(args.content, 80);
  if (args.questions?.[0]?.question) return clip(args.questions[0].question, 80);
  return clip(JSON.stringify(args), 80);
}

// Hermes-shaped result bodies (what the role:"tool" row would contain), rendered readable for tiles.
export const hermes = {
  terminal: (output, exit_code = 0) => ({ json: JSON.stringify({ output, exit_code, error: null }), text: output.replace(/\n$/, '') + `\n[exit ${exit_code}]` }),
  readFile: (content, offset = 1) => {
    const total = content.replace(/\n$/, '').split('\n').length;
    return { json: JSON.stringify({ content: numbered(content, offset), total_lines: total + offset - 1, truncated: false }), text: numbered(content, offset) };
  },
  patch: (d) => ({ json: JSON.stringify({ success: true, diff: d, files_modified: [d.match(/^\+\+\+ b\/(.*)$/m)?.[1]] }), text: d }),
  writeFile: (path, content) => ({ json: JSON.stringify({ bytes_written: Buffer.byteLength(content), verified: true, resolved_path: `/workspace/cEverything/${path}`, files_modified: [`/workspace/cEverything/${path}`] }), text: `wrote ${path} (${content.split('\n').length} lines, ${Buffer.byteLength(content)} bytes)` }),
};
