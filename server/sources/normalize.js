// PURE: Hermes session rows + message rows (dashboard REST / export shape) → normalized Sessions,
// Messages and events (PROTOCOL.md §2.3, §4). No I/O, no Node imports; safe to import anywhere.

import { CATEGORY_OF_TOOL, TARGET_OF_CATEGORY, GLYPH_OF } from '../protocol.js';
import { SUMMARY_MAX, SESSION_SUMMARY_MAX, clip, firstSentence, toMs, parseJSONish, hostOf, firstLine } from './text.js';
import { describeToolCall, describeToolResult, activityForTool, diffFromResult } from './tooldesc.js';
import { composeUnifiedDiff, diffStats, diffLines } from './diff.js';

export { SUMMARY_MAX, SESSION_SUMMARY_MAX, clip, firstSentence, toMs, parseJSONish, hostOf, firstLine } from './text.js';
export { describeToolCall, describeToolResult, activityForTool, diffFromResult } from './tooldesc.js';
export { composeUnifiedDiff, diffStats, diffLines } from './diff.js';
export const LIVE_WINDOW_MS = 10_000;

// ---------------------------------------------------------------------------
// Redaction (§4): secrets never leave the server.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{10,}/g, 'sk-[REDACTED]'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA[REDACTED]'],
  [/ghp_[A-Za-z0-9]{20,}/g, 'ghp_[REDACTED]'],
  [/gh[ousr]_[A-Za-z0-9]{20,}/g, 'gh*_[REDACTED]'],
  [/xox[baprs]-[A-Za-z0-9-]{8,}/g, 'xox*-[REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '-----BEGIN PRIVATE KEY----- [REDACTED] -----END PRIVATE KEY-----'],
  [/(?<=\b(?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[A-Za-z0-9_\-.]{16,}/gi, '[REDACTED]'],
];

/** Replace secret-looking substrings. Non-strings are returned unchanged. */
export function redact(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Deep-redact strings inside an args object (returns a new object). */
export function redactDeep(value, depth = 0) {
  if (depth > 6) return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
    return out;
  }
  return value;
}

/** tool_calls arrives as an OpenAI-style list (live agent) OR a JSON string (export). */
export function parseToolCalls(raw) {
  const parsed = parseJSONish(raw, null);
  if (!parsed) return [];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  list.forEach((tc, i) => {
    if (!tc || typeof tc !== 'object') return;
    const fn = tc.function && typeof tc.function === 'object' ? tc.function : tc;
    const name = String(fn.name || tc.name || 'tool');
    let args = fn.arguments ?? tc.arguments ?? tc.args ?? {};
    if (typeof args === 'string') {
      const p = parseJSONish(args, null);
      args = p && typeof p === 'object' ? p : { input: args };
    }
    if (!args || typeof args !== 'object') args = {};
    out.push({ id: String(tc.id || tc.tool_call_id || `call_${i}`), name, args });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Session normalization
// ---------------------------------------------------------------------------

function emptyCounts() {
  return {
    messages: 0, toolCalls: 0,
    byCategory: { web: 0, files: 0, coding: 0, memory: 0, delegating: 0, images: 0, messaging: 0, waiting: 0, tools: 0 },
  };
}

/** Hermes session row → Session. opts.messages (normalized) + opts.now feed status derivation. */
export function normalizeSession(row, opts = {}) {
  const r = row || {};
  const id = String(r.id ?? r.session_id ?? '');
  const now = opts.now ?? Date.now();
  const startedAt = toMs(r.started_at ?? r.created_at, now);
  const lastActivityAt = toMs(r.last_activity_at ?? r.updated_at ?? r.ended_at, startedAt);
  const firstUser = (opts.messages || []).find((m) => m.role === 'user');
  const title = clip(r.title || firstUser?.summary || id || 'session', 60) || id;
  const status = opts.status || deriveStatus(r, opts.messages || [], now);
  const counts = emptyCounts();
  counts.messages = Number(r.message_count) || (opts.messages ? opts.messages.length : 0);
  counts.toolCalls = Number(r.tool_call_count) || 0;
  const session = {
    id,
    title,
    status,
    model: r.model ? String(r.model) : undefined,
    cwd: r.cwd ? String(r.cwd) : undefined,
    gitBranch: r.git_branch ? String(r.git_branch) : undefined,
    parentId: r.parent_session_id ? String(r.parent_session_id) : null,
    endReason: r.end_reason ? String(r.end_reason) : null,
    startedAt,
    lastActivityAt,
    activity: redact(clip(r.last_activity_description || '', 80)),
    counts,
    toolHistory: [],
    currentTool: null,
    summary: redact(clip(firstUser?.text || r.title || '', SESSION_SUMMARY_MAX)),
    attention: null,
    source: r.source ? String(r.source) : undefined,
  };
  if (status === 'waiting_on_you') {
    const open = openRequest(r, opts.messages || []);
    session.attention = { kind: open.kind, text: open.text, requestId: open.requestId, since: open.since ?? lastActivityAt };
  } else if (status === 'done') {
    session.attention = { kind: 'done', text: session.endReason || 'finished', since: toMs(r.ended_at, lastActivityAt) };
  } else if (status === 'error') {
    session.attention = { kind: 'error', text: session.endReason || 'error', since: toMs(r.ended_at, lastActivityAt) };
  }
  // derive toolHistory/currentTool from normalized messages when given
  if (opts.messages) {
    const calls = opts.messages.filter((m) => m.role === 'tool_call');
    session.toolHistory = calls.slice(-8).map((m) => m.tool.category);
    if (!counts.toolCalls) counts.toolCalls = calls.length;
    for (const m of calls) counts.byCategory[m.tool.category] = (counts.byCategory[m.tool.category] || 0) + 1;
    const last = opts.messages[opts.messages.length - 1];
    if (status === 'tool' && last && last.role === 'tool_call') {
      session.currentTool = { callId: last.tool.callId, name: last.tool.name, category: last.tool.category, since: last.ts };
      session.activity = activityForTool(last.tool.name, last.tool.meta || {}, last.tool.args || {});
    }
  }
  return session;
}

function openRequest(row, messages) {
  const reqs = row.open_requests || row.pending_requests;
  if (Array.isArray(reqs) && reqs.length) {
    const q = reqs[0];
    const kind = /clarif|question/i.test(q.type || q.kind || '') ? 'clarify' : 'approval';
    return { kind, text: clip(q.text || q.prompt || q.question || q.description || 'needs your input', 120), requestId: q.id ? String(q.id) : undefined, since: toMs(q.created_at, undefined) };
  }
  const last = [...messages].reverse().find((m) => m.role === 'tool_call' && m.tool.category === 'waiting');
  if (last) return { kind: 'clarify', text: clip(last.tool.preview || last.summary, 120), requestId: last.tool.callId, since: last.ts };
  return { kind: 'approval', text: 'waiting for your approval', requestId: undefined };
}

/** Status derivation (§2.3). messages = normalized Messages, oldest first. */
export function deriveStatus(row, messages = [], now = Date.now()) {
  const r = row || {};
  if (r.ended_at) return /error|fail|crash|exception/i.test(String(r.end_reason || '')) ? 'error' : 'done';
  const reqs = r.open_requests || r.pending_requests;
  if (Array.isArray(reqs) && reqs.length) return 'waiting_on_you';
  const last = messages[messages.length - 1];
  if (last && last.role === 'tool_call' && last.tool && last.tool.category === 'waiting') return 'waiting_on_you';
  const active = r.is_active === true || r.is_active === 1;
  if (!active) return 'idle';
  if (!last) return 'idle';
  if (last.role === 'tool_call') return 'tool';
  if (last.role === 'assistant' && (last.streaming || (now - last.ts) < LIVE_WINDOW_MS)) return 'responding';
  if (last.role === 'user') return 'thinking';
  return 'idle';
}

// ---------------------------------------------------------------------------
// Message normalization
// ---------------------------------------------------------------------------

function mkMessage(base) {
  const m = { ...base };
  if (m.text === undefined) m.text = '';
  if (!m.summary) m.summary = firstSentence(m.text, SUMMARY_MAX);
  if (!m.glyph) m.glyph = GLYPH_OF(m.role, m.tool?.category);
  return m;
}

/**
 * normalizeMessages(sessionId, rows, opts) → { messages, events }
 * rows: Hermes message rows in time order. opts.knownCalls: Map(callId → {messageId,name,ts,args}) to resolve
 * tool results whose call was in an earlier page (mutated with new calls); opts.via for user rows.
 */
export function normalizeMessages(sessionId, rows, opts = {}) {
  const sid = String(sessionId);
  const messages = [];
  const events = [];
  const calls = opts.knownCalls instanceof Map ? opts.knownCalls : new Map();
  // role:"tool" rows that arrived before their assistant row (page boundaries, out-of-order pages): callId → result
  const orphans = opts.orphanResults instanceof Map ? opts.orphanResults : new Map();
  const add = (m) => { messages.push(m); events.push({ sessionId: sid, kind: 'message.add', message: m }); };
  let lastTs = opts.startTs ?? 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    if (row.active === 0 || row.active === false) continue; // compacted-away rows
    const rowId = String(row.id ?? row.message_uid ?? `${sid}-${messages.length}`);
    const ts = toMs(row.timestamp ?? row.created_at, lastTs || Date.now());
    lastTs = ts;
    const role = String(row.role || '').toLowerCase();
    const content = contentText(row.content);
    const tokens = Number.isFinite(Number(row.token_count)) && row.token_count !== null ? Number(row.token_count) : undefined;

    if (role === 'user') {
      if (!content.trim() && !row.display_kind) continue;
      add(mkMessage({ id: rowId, sessionId: sid, role: 'user', ts, text: redact(content), via: opts.via, tokens }));
      continue;
    }
    if (role === 'system') {
      if (!content.trim()) continue;
      add(mkMessage({ id: rowId, sessionId: sid, role: 'system', ts, text: redact(content), tokens }));
      continue;
    }
    if (role === 'assistant') {
      const reasoning = reasoningText(row);
      if (reasoning) {
        add(mkMessage({ id: `${rowId}:r`, sessionId: sid, role: 'thinking', ts, text: redact(reasoning), parentMessageId: rowId,
          summary: clip(`thinking · ${reasoning.length.toLocaleString('en-US')} chars`, SUMMARY_MAX) }));
      }
      const toolCalls = parseToolCalls(row.tool_calls);
      if (content.trim() || toolCalls.length === 0) {
        add(mkMessage({ id: rowId, sessionId: sid, role: 'assistant', ts, text: redact(content), tokens,
          streaming: row.finish_reason === 'streaming' ? true : undefined }));
      }
      for (const tc of toolCalls) {
        const category = CATEGORY_OF_TOOL(tc.name);
        const target = TARGET_OF_CATEGORY(category);
        const args = redactDeep(tc.args);
        const { meta, preview, summary } = describeToolCall(tc.name, args);
        const mid = `${rowId}:${tc.id}`;
        const tool = { callId: tc.id, name: tc.name, category, target, args, preview: redact(preview) };
        if (Object.keys(meta).length) tool.meta = redactDeep(meta);
        add(mkMessage({ id: mid, sessionId: sid, role: 'tool_call', ts, text: redact(summary), summary: redact(summary), tool }));
        events.push({ sessionId: sid, kind: 'tool.start', messageId: mid, callId: tc.id, name: tc.name, category, args, preview: tool.preview, target });
        const orphan = orphans.get(tc.id);
        if (orphan) {
          // its result row was seen first: link it now and complete the call right away
          orphans.delete(tc.id);
          const res = orphan.message;
          res.parentMessageId = mid;
          res.tool.meta = { ...(tool.meta || {}), ...(res.tool.meta || {}) };
          res.tool.durationMs = Math.max(0, orphan.ts - ts);
          events.push({ sessionId: sid, kind: 'tool.complete', messageId: mid, callId: tc.id, name: tc.name, ok: res.tool.ok, durationMs: res.tool.durationMs,
            preview: clip(firstLine(res.text), 60), meta: Object.keys(res.tool.meta).length ? res.tool.meta : undefined, resultMessageId: res.id });
        } else {
          calls.set(tc.id, { messageId: mid, name: tc.name, ts, args, meta: tool.meta || {} });
        }
      }
      continue;
    }
    if (role === 'tool') {
      const callId = row.tool_call_id ? String(row.tool_call_id) : null;
      const known = callId ? calls.get(callId) : undefined;
      const name = String(row.tool_name || known?.name || 'tool');
      const category = CATEGORY_OF_TOOL(name);
      const target = TARGET_OF_CATEGORY(category);
      const { ok, exitCode, summary, diff } = describeToolResult(name, content);
      const durationMs = known ? Math.max(0, ts - known.ts) : undefined;
      const meta = { ...(known?.meta || {}) };
      if (exitCode !== undefined) meta.exitCode = exitCode;
      if (diff) meta.diff = diff; // §3g: Hermes' patch/write_file results carry the real unified diff — prefer it
      const tool = { callId: callId || `${rowId}:orphan`, name, category, target, ok, durationMs };
      if (Object.keys(meta).length) tool.meta = redactDeep(meta);
      const text = redact(content);
      const result = mkMessage({ id: rowId, sessionId: sid, role: 'tool_result', ts, text, summary: redact(summary), tool,
        parentMessageId: known?.messageId, tokens });
      add(result);
      if (known) {
        events.push({ sessionId: sid, kind: 'tool.complete', messageId: known.messageId, callId, name, ok, durationMs,
          preview: clip(firstLine(text), 60), meta: tool.meta, resultMessageId: rowId });
        calls.delete(callId);
      } else if (callId) {
        orphans.set(callId, { message: result, ts }); // the assistant row may still be coming
      }
      continue;
    }
    // unknown role → system-ish tile so nothing silently vanishes
    if (content.trim()) add(mkMessage({ id: rowId, sessionId: sid, role: 'system', ts, text: redact(content) }));
  }
  return { messages, events, pendingCalls: calls, orphanResults: orphans };
}

function contentText(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') {
    if (content.startsWith('\u0000json:')) {
      const parsed = parseJSONish(content.slice(6), null);
      return parsed ? contentText(parsed) : content.slice(6);
    }
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') return part.text || part.content || (part.type === 'image_url' ? '[image]' : '');
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') return content.text || content.content || JSON.stringify(content);
  return String(content);
}

function reasoningText(row) {
  // §3b: reasoning lives in `reasoning` / `reasoning_content` (never in content); either may be "" or null
  for (const r of [row.reasoning, row.reasoning_content]) if (typeof r === 'string' && r.trim()) return r;
  const details = parseJSONish(row.reasoning_details, null);
  if (Array.isArray(details)) {
    const t = details.map((d) => (typeof d === 'string' ? d : d?.text || d?.summary || '')).filter(Boolean).join('\n');
    if (t.trim()) return t;
  }
  return '';
}

/** Convenience: full Hermes export ({...session, messages:[rows]}) → { session, messages, events }. */
export function normalizeExport(exp, opts = {}) {
  const rows = Array.isArray(exp?.messages) ? exp.messages : [];
  const sid = String(exp?.id ?? exp?.session_id ?? opts.sessionId ?? 'session');
  const { messages, events } = normalizeMessages(sid, rows, opts);
  const session = normalizeSession({ ...exp, id: sid }, { messages, now: opts.now });
  return { session, messages, events };
}

export default {
  redact, redactDeep, clip, firstSentence, toMs, parseToolCalls, composeUnifiedDiff, diffStats,
  describeToolCall, describeToolResult, normalizeSession, deriveStatus, activityForTool, normalizeMessages, normalizeExport,
};
