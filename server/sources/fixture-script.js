// Scripted content for the fixture replayer: replies to `send`, approve continuations, demo cues.
// Pure builders — they return event lists with relative gaps; fixture.js schedules and emits them.

import { CATEGORY_OF_TOOL, TARGET_OF_CATEGORY, GLYPH_OF } from '../protocol.js';
import { describeToolCall, describeToolResult, firstSentence, clip, redact } from './normalize.js';

let counter = 0;
const RUN = Date.now().toString(36).slice(-4);
/** Fresh ids: `${prefix}_${run}${n}` — unique across resets within one process. */
export function nextId(prefix = 'm') { counter += 1; return `${prefix}_${RUN}${counter.toString(36)}`; }

/** Deterministic-ish gap in [min,max] ms. */
export function gap(min, max) { return Math.round(min + Math.random() * (max - min)); }

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

export function userMessage(sessionId, text, { via = 'keyboard', from, ts = Date.now() } = {}) {
  const safe = redact(text); // the summary feeds the far planes + HUD list, so it must come from the redacted text too
  const m = { id: nextId('u'), sessionId, role: 'user', ts, text: safe, summary: firstSentence(safe), glyph: GLYPH_OF('user'), via };
  if (from) m.from = from;
  return m;
}

export function assistantMessage(sessionId, text, { streaming = false, ts = Date.now(), parentId } = {}) {
  const m = { id: nextId('a'), sessionId, role: 'assistant', ts, text: streaming ? '' : text, summary: firstSentence(text), glyph: GLYPH_OF('assistant') };
  if (streaming) m.streaming = true;
  if (parentId) m.parentMessageId = parentId;
  return m;
}

export function thinkingMessage(sessionId, text, assistantId, ts = Date.now()) {
  return { id: `${assistantId}:r`, sessionId, role: 'thinking', ts, text, glyph: GLYPH_OF('thinking'), parentMessageId: assistantId,
    summary: clip(`thinking · ${text.length.toLocaleString('en-US')} chars`, 100) };
}

/** Build a tool_call message + tool.start event. */
export function toolCallPair(sessionId, name, args, ts = Date.now()) {
  const callId = nextId('call');
  const category = CATEGORY_OF_TOOL(name);
  const target = TARGET_OF_CATEGORY(category);
  const { meta, preview, summary } = describeToolCall(name, args);
  const id = nextId('tc');
  const tool = { callId, name, category, target, args, preview };
  if (Object.keys(meta).length) tool.meta = meta;
  const message = { id, sessionId, role: 'tool_call', ts, text: summary, summary, glyph: GLYPH_OF('tool_call', category), tool };
  const start = { sessionId, kind: 'tool.start', messageId: id, callId, name, category, args, preview, target };
  return { message, start, callId, category, meta: tool.meta || {} };
}

/** Build a tool_result message + tool.complete event for a call made with toolCallPair. `opts.ok` overrides the derived verdict. */
export function toolResultPair(sessionId, call, content, durationMs, ts = Date.now(), opts = {}) {
  const name = call.message.tool.name;
  const derived = describeToolResult(name, content);
  const { exitCode } = derived;
  const ok = typeof opts.ok === 'boolean' ? opts.ok : derived.ok;
  const summary = ok === derived.ok ? derived.summary : clip(ok ? `${name} ✓ ${content.split('\n')[0]}` : `${name} ✗ ${content.split('\n')[0]}`, 100);
  const meta = { ...(call.meta || {}) };
  if (exitCode !== undefined) meta.exitCode = exitCode;
  const tool = { callId: call.callId, name, category: call.category, target: call.message.tool.target, ok, durationMs };
  if (Object.keys(meta).length) tool.meta = meta;
  const id = nextId('tr');
  const message = { id, sessionId, role: 'tool_result', ts, text: content, summary, glyph: GLYPH_OF('tool_result'), tool, parentMessageId: call.message.id };
  const complete = { sessionId, kind: 'tool.complete', messageId: call.message.id, callId: call.callId, name, ok, durationMs,
    preview: clip(content.split('\n').find((l) => l.trim()) || '', 60), meta: tool.meta, resultMessageId: id };
  return { message, complete };
}

// ---------------------------------------------------------------------------
// Canned banks (realistic Hermes-style content; used when a session has no history to draw from)
// ---------------------------------------------------------------------------

export const CANNED = {
  web: [
    { name: 'web_search', args: { query: 'visionOS Safari WebXR transient-pointer selectstart index' }, result: '1. WebKit blog — "WebXR on visionOS: transient-pointer input" (webkit.org)\n2. three.js forum — "Vision Pro transient pointer controllers 2 and 3"\n3. MDN — XRInputSource.targetRayMode' },
    { name: 'web_extract', args: { url: 'https://webkit.org/blog/15162/webxr-on-visionos/' }, result: 'Safari on visionOS exposes WebXR immersive-vr sessions. Input is delivered as transient-pointer input sources that exist only for the duration of a pinch…' },
    { name: 'web_search', args: { query: 'Quest Browser SpeechRecognition not supported getUserMedia' }, result: '1. Meta developer forums — "Web Speech API in Quest Browser" (no SpeechRecognition exposed)\n2. StackOverflow — getUserMedia works in Oculus Browser' },
    { name: 'web_extract', args: { url: 'https://developer.mozilla.org/en-US/docs/Web/API/XRSession/selectstart_event' }, result: 'The selectstart event of the XRSession interface is sent to the session when one of its input sources begins its primary action…' },
  ],
  patch: [
    { name: 'patch', args: { path: 'server/hub.js', old_string: 'const canReplay = lastSeq !== null && lastSeq <= seq;', new_string: 'const oldest = ring.length ? ring[0].seq : seq + 1;\nconst canReplay = lastSeq !== null && lastSeq <= seq && lastSeq + 1 >= oldest;' }, result: 'Patched server/hub.js (1 hunk, +2 −1)' },
    { name: 'patch', args: { path: 'src/parser.js', old_string: '  return walk(node);', new_string: '  if (Array.isArray(node)) return node.map(walk);\n  return walk(node);' }, result: 'Patched src/parser.js (1 hunk, +1 −0)' },
    { name: 'patch', args: { path: 'web/scene/tiles.js', old_string: 'const HYSTERESIS = 0;', new_string: 'const HYSTERESIS = 0.15; // metres, PROTOCOL.md §5' }, result: 'Patched web/scene/tiles.js (1 hunk, +1 −1)' },
  ],
  coding: [
    { name: 'terminal', args: { command: 'npm test' }, result: '{"output":"▶ protocol\\n  ✔ hello → snapshot (41ms)\\n  ✔ join resume (12ms)\\nℹ tests 14\\nℹ pass 14\\nℹ fail 0","exit_code":0}' },
    { name: 'terminal', args: { command: 'node --test test/normalize.test.mjs' }, result: '{"output":"ℹ tests 9\\nℹ pass 9\\nℹ fail 0","exit_code":0}' },
    { name: 'terminal', args: { command: 'git status --short' }, result: '{"output":" M server/hub.js\\n M web/scene/tiles.js","exit_code":0}' },
  ],
  files: [
    { name: 'read_file', args: { path: 'server/hub.js' }, result: 'import { WebSocketServer } from "ws";\nexport function createHub(opts) {\n  // …\n}' },
    { name: 'search_files', args: { pattern: 'lastSeq', path: 'server' }, result: 'server/hub.js:112: const lastSeq = Number.isFinite(frame.lastSeq) ? …\nweb/net.js:40: lastSeq = ev.seq;' },
  ],
  memory: [
    { name: 'memory', args: { action: 'search', query: 'webxr input quirks' }, result: '2 memories: "Vision Pro transient pointers land on indices 2/3 with hand tracking", "Quest Browser lacks SpeechRecognition"' },
  ],
  delegate: [
    { name: 'delegate_task', args: { task: 'Audit web/input/xr.js for controller indices 0..3 and report every place that assumes index 0.' }, result: 'Subagent finished: 3 call sites assume index 0 (xr.js:41, xr.js:88, desktop.js:12). Patched xr.js to iterate 0..3.' },
  ],
  approvals: [
    'npm run deploy:staging',
    'git push origin main --force-with-lease',
    'rm -rf node_modules && npm ci',
    'kubectl rollout restart deployment/api -n staging',
  ],
};

export function pickCanned(bank) { const list = CANNED[bank] || CANNED.coding; return list[Math.floor(Math.random() * list.length)]; }

/** Pick a tool_call+result pair from a session's own history (prefers calls with results). */
export function pickFromHistory(history, filterCategory) {
  const calls = (history || []).filter((m) => m.role === 'tool_call' && m.tool && (!filterCategory || m.tool.category === filterCategory));
  if (!calls.length) return null;
  const results = new Map();
  for (const m of history) if (m.role === 'tool_result' && m.parentMessageId) results.set(m.parentMessageId, m);
  const withResult = calls.filter((c) => results.has(c.id));
  const pool = withResult.length ? withResult : calls;
  const call = pool[Math.floor(Math.random() * pool.length)];
  const res = results.get(call.id);
  return { name: call.tool.name, args: call.tool.args || {}, result: res ? res.text : `${call.tool.name} ok` };
}

// ---------------------------------------------------------------------------
// Reply text
// ---------------------------------------------------------------------------

const OPENERS = ['On it.', 'Got it.', 'Sure.', 'Okay —', 'Right.', 'Looking into that now.'];
const PLANS = {
  web: (q) => `I'll search for the latest on ${q} and pull the relevant page.`,
  files: (q) => `I'll open the file involved and check how ${q} is handled.`,
  coding: (q) => `I'll run it and read the output before changing anything for ${q}.`,
  memory: (q) => `Let me recall what we already know about ${q}.`,
  delegating: (q) => `This is a side quest — I'll hand ${q} to a subagent and keep going here.`,
  images: (q) => `I'll generate the image for ${q}.`,
  messaging: (q) => `I'll send that note about ${q}.`,
  waiting: (q) => `Before I continue with ${q} I need one answer from you.`,
  tools: (q) => `I'll take care of ${q}.`,
};

export function topicOf(text) {
  const flat = String(text || '').replace(/^\[from [^\]]+\]:\s*/i, '').replace(/\s+/g, ' ').trim();
  const clause = flat.split(/[.!?;]/)[0] || flat;
  const words = clause.split(' ').filter(Boolean);
  const t = words.slice(0, 9).join(' ');
  return t ? t.replace(/^(please|can you|could you|now|also|hey|ok|okay)\s+/i, '').replace(/[,:]$/, '') : 'that';
}

export function replyText(userText, category) {
  const topic = topicOf(userText) || 'that';
  const opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];
  const plan = (PLANS[category] || PLANS.tools)(topic.length > 60 ? `${topic.slice(0, 57)}…` : topic);
  return `${opener} ${plan}`;
}

export function thinkingText(userText, category, sessionTitle) {
  const topic = topicOf(userText) || 'the request';
  return `The user wants: ${clip(userText.replace(/^\[from [^\]]+\]:\s*/i, ''), 160)}\n\nThis is the "${sessionTitle}" session, so the context is already loaded. ` +
    `Plan: (1) ${category === 'web' ? 'look it up' : category === 'coding' ? 'run the command and read the output' : category === 'files' ? 'read the file before editing' : 'do the smallest safe step'}, ` +
    `(2) report back in one or two sentences. Keep ${topic} in scope; do not touch unrelated files.`;
}

/**
 * The shell command named in an approval's attention text, or null.
 * Accepts `backticks`, "Run: <cmd>? (y/n)", "Run <cmd>?" and "execute <cmd>".
 */
export function commandFromAttention(text) {
  const t = String(text || '');
  const tick = t.match(/`([^`]+)`/);
  if (tick && tick[1].trim()) return tick[1].trim();
  const run = t.match(/\b(?:run|execute|exec)\b\s*:?\s*(.+?)\s*(?:\?|\(y\/n\)|$)/i);
  if (run) {
    const cmd = run[1].replace(/\s*\(y\/n\)\s*$/i, '').replace(/[?.!]+$/, '').trim();
    if (cmd) return cmd;
  }
  return null;
}

/** Split text into 3–5 streaming chunks at word boundaries. */
export function chunksOf(text, n = 4) {
  const words = String(text).split(' ');
  const per = Math.max(1, Math.ceil(words.length / n));
  const out = [];
  for (let i = 0; i < words.length; i += per) out.push((i ? ' ' : '') + words.slice(i, i + per).join(' '));
  return out;
}

export default { nextId, gap, userMessage, assistantMessage, thinkingMessage, toolCallPair, toolResultPair, CANNED, pickCanned, pickFromHistory, replyText, thinkingText, chunksOf, topicOf, commandFromAttention };
