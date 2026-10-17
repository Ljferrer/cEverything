// node:test — Hermes rows → thinking/assistant/tool_call/tool_result split, categories, summaries, diffs, redaction,
// status derivation, state reducers and the export-to-fixture converter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeMessages, normalizeSession, normalizeExport, deriveStatus, redact, redactDeep, composeUnifiedDiff,
  describeToolCall, describeToolResult, parseToolCalls, firstSentence, toMs, clip,
} from '../server/sources/normalize.js';
import { CATEGORY_OF_TOOL, TARGET_OF_CATEGORY, GLYPH_OF, CATEGORIES } from '../server/protocol.js';
import { createState, applyEvent, snapshot, MAX_MESSAGES_PER_SESSION, defaultPlacement } from '../server/state.js';
import { exportToFixtureLines } from '../scripts/export-to-fixture.mjs';

const T0 = 1760700000; // unix seconds
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A realistic Hermes export-shaped transcript: tool_calls as JSON strings, reasoning on assistant rows. */
function sampleRows() {
  return [
    { id: 101, session_id: 'fix', role: 'user', content: 'Fix the parser tests. They fail on nested arrays and I need it green before the demo.', timestamp: T0 + 0 },
    { id: 102, session_id: 'fix', role: 'assistant', content: '', reasoning: 'Nested arrays fail; I should read src/parser.js before touching anything, then run the single failing test.',
      tool_calls: JSON.stringify([{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/parser.js' }) } }]), timestamp: T0 + 1.5 },
    { id: 103, session_id: 'fix', role: 'tool', tool_call_id: 'call_a', tool_name: 'read_file', content: 'export function parse(node) {\n  const depth = 0;\n  return walk(node);\n}', timestamp: T0 + 2.2 },
    { id: 104, session_id: 'fix', role: 'assistant', content: 'The scalar path swallows arrays. Patching the array branch and running the tests.',
      tool_calls: JSON.stringify([
        { id: 'call_b', type: 'function', function: { name: 'patch', arguments: JSON.stringify({ path: 'src/parser.js', old_string: '  const depth = 0;\n  return walk(node);', new_string: '  const depth = 0;\n  if (Array.isArray(node)) return node.map(walk);\n  return walk(node);' }) } },
        { id: 'call_c', type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: 'npm test -- test/parser.test.mjs' }) } },
      ]), timestamp: T0 + 4 },
    { id: 105, session_id: 'fix', role: 'tool', tool_call_id: 'call_b', tool_name: 'patch', content: '{"success": true, "path": "src/parser.js"}', timestamp: T0 + 4.6 },
    { id: 106, session_id: 'fix', role: 'tool', tool_call_id: 'call_c', tool_name: 'terminal', content: '{"output": "ℹ tests 12\\nℹ pass 12\\nℹ fail 0", "exit_code": 0}', timestamp: T0 + 7.1 },
    { id: 107, session_id: 'fix', role: 'assistant', content: 'All 12 parser tests pass. The array branch now maps through walk(). Token for the deploy bot is sk-live-abcdefghijklmnopqrstuvwxyz0123456789 if you need it.', timestamp: T0 + 8 },
  ];
}

test('split: thinking before assistant, one tool_call per entry, results matched by tool_call_id', () => {
  const { messages, events } = normalizeMessages('fix', sampleRows());
  assert.deepEqual(messages.map((m) => `${m.role}:${m.id}`), [
    'user:101', 'thinking:102:r', 'tool_call:102:call_a', 'tool_result:103',
    'assistant:104', 'tool_call:104:call_b', 'tool_call:104:call_c', 'tool_result:105', 'tool_result:106', 'assistant:107',
  ]);
  const thinking = messages[1];
  assert.equal(thinking.parentMessageId, '102');
  assert.match(thinking.summary, /^thinking · \d+ chars$/);
  assert.equal(thinking.glyph, '✎');
  // no assistant tile for row 102 (empty content + tool_calls)
  assert.ok(!messages.some((m) => m.id === '102'));
  // assistant tile for row 104 (content + tool_calls)
  assert.equal(messages[4].summary, 'The scalar path swallows arrays.');
  const result = messages[3];
  assert.equal(result.parentMessageId, '102:call_a');
  assert.equal(result.tool.callId, 'call_a');
  assert.equal(result.tool.ok, true);
  assert.equal(result.tool.durationMs, 700);
  assert.equal(result.tool.meta.path, 'src/parser.js');
  // events: message.add for every message; tool.start right after each tool_call; tool.complete after each result
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['message.add', 'message.add', 'message.add', 'tool.start', 'message.add', 'tool.complete',
    'message.add', 'message.add', 'tool.start', 'message.add', 'tool.start', 'message.add', 'tool.complete', 'message.add', 'tool.complete', 'message.add']);
  const start = events[3];
  assert.equal(start.messageId, '102:call_a'); assert.equal(start.callId, 'call_a'); assert.equal(start.category, 'files'); assert.equal(start.target, 'files');
  assert.deepEqual(start.args, { path: 'src/parser.js' });
  const complete = events[5];
  assert.equal(complete.messageId, '102:call_a'); assert.equal(complete.callId, 'call_a'); assert.equal(complete.ok, true); assert.equal(complete.durationMs, 700);
  assert.equal(complete.resultMessageId, '103');
  // every message carries sessionId, ts (ms), text, summary ≤ 100, glyph
  for (const m of messages) {
    assert.equal(m.sessionId, 'fix');
    assert.ok(m.ts > 1e12, 'ms timestamps');
    assert.equal(typeof m.text, 'string');
    assert.ok(m.summary.length <= 100);
    assert.ok(m.glyph.length >= 1 && m.glyph.length <= 2);
  }
});

test('tool_calls as JSON string or list; arguments as string or object', () => {
  const asList = [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: { query: 'visionOS webxr' } } }];
  const asString = JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'visionOS webxr' }) } }]);
  const a = parseToolCalls(asList); const b = parseToolCalls(asString);
  assert.deepEqual(a, [{ id: 'c1', name: 'web_search', args: { query: 'visionOS webxr' } }]);
  assert.deepEqual(a, b);
  assert.deepEqual(parseToolCalls(null), []); assert.deepEqual(parseToolCalls(''), []); assert.deepEqual(parseToolCalls('not json'), []);
  // single object, legacy shape without function wrapper, non-JSON arguments string
  assert.deepEqual(parseToolCalls({ id: 'x', name: 'terminal', arguments: 'ls -la' }), [{ id: 'x', name: 'terminal', args: { input: 'ls -la' } }]);
  // missing id gets a stable fallback
  assert.equal(parseToolCalls([{ function: { name: 'memory', arguments: '{}' } }])[0].id, 'call_0');
  const rows = [{ id: 1, role: 'assistant', content: '', tool_calls: asList, timestamp: T0 }, { id: 2, role: 'assistant', content: '', tool_calls: asString, timestamp: T0 + 1 }];
  const { messages } = normalizeMessages('s', rows);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].summary, 'web_search "visionOS webxr"');
  assert.equal(messages[0].summary, messages[1].summary);
  assert.equal(messages[0].tool.target, 'browser');
});

test('categories and pylon targets (bighelp mapping)', () => {
  const expect = {
    terminal: ['coding', 'terminal'], execute_code: ['coding', 'terminal'], process_manage: ['coding', 'terminal'],
    read_file: ['files', 'files'], write_file: ['files', 'files'], patch: ['files', 'files'], search_files: ['files', 'files'],
    web_search: ['web', 'browser'], web_extract: ['web', 'browser'], browser_navigate: ['web', 'browser'], browser_click: ['web', 'browser'],
    memory: ['memory', 'self'], session_search: ['memory', 'self'], skill_view: ['memory', 'self'],
    delegate_task: ['delegating', 'self'], image_generate: ['images', 'self'], vision_analyze: ['images', 'self'], video_frames: ['images', 'self'],
    send_message: ['messaging', 'self'], text_to_speech: ['messaging', 'self'], clarify: ['waiting', 'self'], todo: ['memory', 'self'],
    something_new: ['tools', 'self'], '': ['tools', 'self'],
  };
  for (const [name, [cat, target]] of Object.entries(expect)) {
    assert.equal(CATEGORY_OF_TOOL(name), cat, name);
    assert.equal(TARGET_OF_CATEGORY(cat), target, name);
    assert.ok(CATEGORIES.includes(cat));
  }
  assert.equal(GLYPH_OF('tool_call', 'coding'), '>_');
  assert.equal(GLYPH_OF('tool_call', 'web'), '🔍');
  assert.equal(GLYPH_OF('user'), 'U'); assert.equal(GLYPH_OF('assistant'), 'A');
});

test('summaries: first sentence ≤ 100 chars; tool summaries per protocol', () => {
  assert.equal(firstSentence('Hello there. Second sentence.'), 'Hello there.');
  assert.equal(firstSentence('No punctuation at all'), 'No punctuation at all');
  assert.equal(firstSentence('Version 1.2.3 is out! Next.'), 'Version 1.2.3 is out!');
  const long = firstSentence('x'.repeat(150));
  assert.equal(long.length, 100); assert.ok(long.endsWith('…'));
  assert.equal(describeToolCall('web_search', { query: 'visionOS webxr' }).summary, 'web_search "visionOS webxr"');
  assert.equal(describeToolCall('terminal', { command: 'npm test' }).summary, '$ npm test');
  assert.equal(describeToolCall('patch', { path: 'src/hub.js', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' }).summary, 'patch src/hub.js (+2 −1)');
  assert.equal(describeToolCall('write_file', { path: 'README.md', content: 'line1\nline2\nline3' }).summary, 'write_file README.md (+3)');
  assert.equal(describeToolCall('read_file', { path: 'a/b.js' }).summary, 'read_file a/b.js');
  assert.equal(describeToolCall('web_extract', { url: 'https://developer.apple.com/visionos/webxr/' }).summary, 'web_extract developer.apple.com/visionos/webxr/');
  assert.equal(describeToolCall('web_extract', { url: 'https://developer.apple.com/visionos/webxr/' }).meta.url, 'https://developer.apple.com/visionos/webxr/');
  assert.equal(describeToolCall('delegate_task', { task: 'Audit xr.js for index assumptions' }).summary, 'delegate "Audit xr.js for index assumptions"');
  assert.equal(describeToolCall('clarify', { question: 'Deploy to prod too?' }).summary, 'clarify "Deploy to prod too?"');
  assert.equal(describeToolCall('execute_code', { code: 'print(1)\nprint(2)' }).meta.command, 'print(1)');
  assert.equal(describeToolCall('mystery_tool', { foo: 'bar' }).summary, 'mystery_tool bar');
  assert.equal(describeToolCall('mystery_tool', {}).summary, 'mystery_tool');
  // results
  assert.deepEqual(describeToolResult('terminal', '{"output":"ok","exit_code":0}'), { ok: true, exitCode: 0, summary: 'terminal → exit 0' });
  const failed = describeToolResult('terminal', '{"output":"boom","exit_code":2}');
  assert.equal(failed.ok, false); assert.equal(failed.exitCode, 2); assert.equal(failed.summary, 'terminal → exit 2');
  assert.equal(describeToolResult('patch', 'Error: old_string not found').ok, false);
  assert.equal(describeToolResult('read_file', 'const x = 1;').ok, true);
  assert.equal(describeToolResult('terminal', 'command exited with exit code 1').exitCode, 1);
});

test('diff composition from old_string/new_string and write_file content', () => {
  const { diff, added, removed } = composeUnifiedDiff('src/hub.js', 'const a = 1;\nconst b = 2;\nconst c = 3;', 'const a = 1;\nconst b = 22;\nconst c = 3;\nconst d = 4;');
  assert.equal(added, 2); assert.equal(removed, 1);
  assert.deepEqual(diff.split('\n'), ['--- a/src/hub.js', '+++ b/src/hub.js', '@@ -1,3 +1,4 @@', ' const a = 1;', '-const b = 2;', '+const b = 22;', ' const c = 3;', '+const d = 4;']);
  // identical texts → empty hunk; long inputs still terminate (prefix/suffix fallback)
  assert.deepEqual(composeUnifiedDiff('f', 'same\n', 'same\n'), { diff: '--- a/f\n+++ b/f\n@@ -1,0 +1,0 @@', added: 0, removed: 0 });
  const big = Array.from({ length: 1200 }, (_, i) => `line ${i}`).join('\n');
  const bigDiff = composeUnifiedDiff('big', big, big.replace('line 600', 'LINE 600').replace('line 7', 'line seven'));
  assert.equal(bigDiff.added, 2); assert.equal(bigDiff.removed, 2);
  const w = describeToolCall('write_file', { path: 'notes.md', content: '# Title\n\nbody\n' });
  assert.deepEqual(w.meta.diff.split('\n'), ['--- a/notes.md', '+++ b/notes.md', '@@ -1,0 +1,3 @@', '+# Title', '+', '+body']);
  // explicit diff argument is passed through
  const p = describeToolCall('patch', { path: 'x', diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b' });
  assert.equal(p.meta.diff.split('\n').length, 5); assert.equal(p.summary, 'patch x (+1 −1)');
  // normalized tool_call carries the diff in tool.meta and tool.complete repeats it
  const { messages, events } = normalizeMessages('fix', sampleRows());
  const patchCall = messages.find((m) => m.id === '104:call_b');
  assert.ok(patchCall.tool.meta.diff.includes('+  if (Array.isArray(node)) return node.map(walk);'));
  assert.equal(patchCall.summary, 'patch src/parser.js (+1 −0)');
  const complete = events.find((e) => e.kind === 'tool.complete' && e.callId === 'call_b');
  assert.equal(complete.meta.diff, patchCall.tool.meta.diff);
  const term = events.find((e) => e.kind === 'tool.complete' && e.callId === 'call_c');
  assert.equal(term.meta.exitCode, 0); assert.equal(term.meta.command, 'npm test -- test/parser.test.mjs');
  assert.equal(term.durationMs, 3100);
});

test('redaction of secrets in text, args and results', () => {
  assert.equal(redact('key sk-live-abcdefghijklmnopqrstuvwxyz0123456789 end'), 'key sk-[REDACTED] end');
  assert.equal(redact('aws AKIAIOSFODNN7EXAMPLE x'), 'aws AKIA[REDACTED] x');
  assert.equal(redact('gh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 y'), 'gh ghp_[REDACTED] y');
  assert.equal(redact('slack xoxb-123456789012-abcdefghij'), 'slack xox*-[REDACTED]');
  assert.equal(redact('xoxp-1-2-3-abcdef0123456789'), 'xox*-[REDACTED]');
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
  assert.equal(redact(`before ${pem} after`), 'before -----BEGIN PRIVATE KEY----- [REDACTED] -----END PRIVATE KEY----- after');
  assert.equal(redact('-----BEGIN OPENSSH PRIVATE KEY-----\nabc'), '-----BEGIN PRIVATE KEY----- [REDACTED] -----END PRIVATE KEY-----');
  assert.equal(redact('api_key="0123456789abcdef0123456789"'), 'api_key="[REDACTED]"');
  assert.equal(redact('plain sentence with sk- prefix short sk-abc'), 'plain sentence with sk- prefix short sk-abc', 'short tokens are left alone');
  assert.equal(redact(''), ''); assert.equal(redact(null), null); assert.equal(redact(42), 42);
  assert.deepEqual(redactDeep({ a: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123', b: ['AKIAIOSFODNN7EXAMPLE'], c: 1 }), { a: 'ghp_[REDACTED]', b: ['AKIA[REDACTED]'], c: 1 });
  const { messages } = normalizeMessages('fix', sampleRows());
  const last = messages.at(-1);
  assert.ok(!last.text.includes('sk-live-'), 'assistant text redacted');
  assert.ok(last.text.includes('sk-[REDACTED]'));
  const rows = [
    { id: 1, role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'terminal', arguments: { command: 'export GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 && gh auth status' } } }], timestamp: T0 },
    { id: 2, role: 'tool', tool_call_id: 'c', tool_name: 'terminal', content: 'Logged in with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123', timestamp: T0 + 1 },
  ];
  const r = normalizeMessages('s', rows);
  assert.ok(!JSON.stringify(r).includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'), 'no raw token anywhere in messages or events');
  assert.ok(r.messages[0].tool.args.command.includes('ghp_[REDACTED]'));
  assert.ok(r.messages[0].summary.includes('ghp_[REDACTED]'));
});

test('status derivation and normalizeSession fields', () => {
  const now = (T0 + 20) * 1000;
  const { messages } = normalizeMessages('fix', sampleRows());
  const base = { id: 'fix', title: 'fix-parser-tests', model: 'claude-sonnet-4.5', cwd: '/w/parser', git_branch: 'fix/arrays', started_at: T0, last_activity_at: T0 + 8, message_count: 7, tool_call_count: 3, last_activity_description: 'ran npm test' };
  assert.equal(deriveStatus({ ...base, ended_at: T0 + 9 }, messages, now), 'done');
  assert.equal(deriveStatus({ ...base, ended_at: T0 + 9, end_reason: 'error: model timeout' }, messages, now), 'error');
  assert.equal(deriveStatus({ ...base, is_active: true, open_requests: [{ id: 'r1', type: 'approval', text: 'Run deploy?' }] }, messages, now), 'waiting_on_you');
  assert.equal(deriveStatus({ ...base, is_active: false }, messages, now), 'idle');
  assert.equal(deriveStatus({ ...base, is_active: true }, messages, now), 'idle', 'assistant finished > 10 s ago');
  assert.equal(deriveStatus({ ...base, is_active: true }, messages, (T0 + 9) * 1000), 'responding', 'assistant row within the live window');
  assert.equal(deriveStatus({ ...base, is_active: true }, messages.slice(0, 7), now), 'tool', 'newest is a tool_call without result');
  assert.equal(deriveStatus({ ...base, is_active: true }, messages.slice(0, 1), now), 'thinking', 'newest is the user');
  const clarify = normalizeMessages('s', [{ id: 1, role: 'assistant', content: '', tool_calls: [{ id: 'q', function: { name: 'clarify', arguments: { question: 'Prod too?' } } }], timestamp: T0 }]).messages;
  assert.equal(deriveStatus({ id: 's', is_active: true }, clarify, now), 'waiting_on_you');
  const s = normalizeSession({ ...base, is_active: true, parent_session_id: 'root' }, { messages, now: (T0 + 9) * 1000 });
  assert.equal(s.id, 'fix'); assert.equal(s.title, 'fix-parser-tests'); assert.equal(s.model, 'claude-sonnet-4.5');
  assert.equal(s.cwd, '/w/parser'); assert.equal(s.gitBranch, 'fix/arrays'); assert.equal(s.parentId, 'root');
  assert.equal(s.startedAt, T0 * 1000); assert.equal(s.lastActivityAt, (T0 + 8) * 1000);
  assert.equal(s.status, 'responding');
  assert.equal(s.counts.messages, 7); assert.equal(s.counts.toolCalls, 3);
  assert.equal(s.counts.byCategory.files, 2); assert.equal(s.counts.byCategory.coding, 1);
  assert.deepEqual(s.toolHistory, ['files', 'files', 'coding']);
  assert.equal(s.summary, 'Fix the parser tests. They fail on nested arrays and I need it green before the…');
  assert.ok(s.summary.length <= 80);
  assert.equal(s.activity, 'ran npm test');
  const w = normalizeSession({ ...base, is_active: true, open_requests: [{ id: 'r1', type: 'approval', text: 'Run deploy?', created_at: T0 + 8 }] }, { messages, now });
  assert.equal(w.status, 'waiting_on_you');
  assert.deepEqual(w.attention, { kind: 'approval', text: 'Run deploy?', requestId: 'r1', since: (T0 + 8) * 1000 });
  const d = normalizeSession({ ...base, ended_at: T0 + 9, end_reason: 'completed' }, { messages, now });
  assert.equal(d.status, 'done'); assert.equal(d.attention.kind, 'done'); assert.equal(d.endReason, 'completed');
  const t = normalizeSession({ ...base, is_active: true }, { messages: messages.slice(0, 7), now });
  assert.equal(t.status, 'tool'); assert.equal(t.currentTool.name, 'terminal'); assert.equal(t.activity, 'running: npm test -- test/parser.test.mjs');
  // timestamps: seconds, ms and ISO are all accepted
  assert.equal(toMs(T0), T0 * 1000); assert.equal(toMs(T0 * 1000), T0 * 1000); assert.equal(toMs('2025-10-17T12:00:00.000Z'), Date.parse('2025-10-17T12:00:00.000Z'));
  assert.equal(clip('  a   b  ', 10), 'a b');
});

test('normalizeExport and export-to-fixture lines', () => {
  const exp = { id: 'fix', title: 'fix-parser-tests', model: 'claude-sonnet-4.5', started_at: T0, ended_at: T0 + 9, end_reason: 'completed', messages: sampleRows() };
  const n = normalizeExport(exp);
  assert.equal(n.session.id, 'fix'); assert.equal(n.session.status, 'done'); assert.equal(n.messages.length, 10);
  const { sessionId, lines } = exportToFixtureLines(exp, { maxDt: 1000 });
  assert.equal(sessionId, 'fix');
  assert.deepEqual({ dt: lines[0].dt, kind: lines[0].kind, id: lines[0].session.id }, { dt: 0, kind: 'session.upsert', id: 'fix' });
  assert.equal(lines[0].session.status, 'idle', 'fixture starts idle and the story drives status');
  assert.ok(lines.every((l) => typeof l.dt === 'number' && l.dt >= 0 && l.dt <= 1000));
  assert.ok(lines.every((l) => l.sessionId === 'fix' && typeof l.kind === 'string'));
  const kinds = lines.map((l) => l.kind);
  assert.ok(kinds.includes('message.add') && kinds.includes('tool.start') && kinds.includes('tool.complete') && kinds.includes('session.status'));
  assert.equal(lines.at(-1).status, 'done');
  const userLine = lines.find((l) => l.kind === 'message.add' && l.message.role === 'user');
  const thinkingStatus = lines[lines.indexOf(userLine) + 1];
  assert.equal(thinkingStatus.kind, 'session.status'); assert.equal(thinkingStatus.status, 'thinking');
  // the reading tool call: dt from row timestamps (1.5 s between row 101 and 102)
  const think = lines.find((l) => l.kind === 'message.add' && l.message.role === 'thinking');
  assert.equal(think.dt, 1000, 'compressed to maxDt');
  assert.ok(lines.every((l) => JSON.stringify(l).length < 20000));
  assert.ok(!JSON.stringify(lines).includes('sk-live-'));
});

test('state reducers: counts, toolHistory ≤ 8, 400-message cap, snapshot shape, default placement', () => {
  const state = createState();
  const now = Date.now();
  applyEvent(state, { kind: 'session.upsert', sessionId: 's1', ts: now, session: { id: 's1', title: 'one', status: 'idle', startedAt: now, lastActivityAt: now, activity: '', counts: { messages: 0, toolCalls: 0, byCategory: {} }, toolHistory: [], summary: '' } });
  assert.deepEqual(state.layout.s1, defaultPlacement('s1', 0));
  assert.ok(Math.abs(Math.hypot(state.layout.s1.x, state.layout.s1.z) - 1.8) < 2e-3, 'first arc r = 1.8');
  for (let i = 0; i < 450; i++) {
    const role = i % 4 === 1 ? 'tool_call' : i % 4 === 2 ? 'tool_result' : i % 2 ? 'assistant' : 'user';
    const message = { id: `m${i}`, sessionId: 's1', role, ts: now + i, text: `message ${i}`, summary: `message ${i}`, glyph: 'U' };
    if (role === 'tool_call') message.tool = { callId: `c${i}`, name: i % 8 === 1 ? 'web_search' : 'terminal', category: i % 8 === 1 ? 'web' : 'coding', target: i % 8 === 1 ? 'browser' : 'terminal' };
    applyEvent(state, { kind: 'message.add', sessionId: 's1', ts: now + i, message });
  }
  assert.equal(state.messages.s1.length, MAX_MESSAGES_PER_SESSION);
  assert.equal(state.messages.s1[0].id, 'm50', 'oldest dropped');
  const s = state.sessions.s1;
  assert.equal(s.counts.messages, 450);
  assert.equal(s.counts.toolCalls, 113);
  assert.equal(s.counts.byCategory.web + s.counts.byCategory.coding, 113);
  assert.equal(s.toolHistory.length, 8);
  assert.equal(s.summary, 'message 0');
  // tool.start / complete maintain currentTool + activity; status via session.status
  applyEvent(state, { kind: 'tool.start', sessionId: 's1', ts: now + 500, messageId: 'm449', callId: 'c449', name: 'terminal', category: 'coding', args: { command: 'npm test' }, preview: 'npm test', target: 'terminal' });
  assert.equal(s.currentTool.callId, 'c449'); assert.equal(s.activity, 'running: npm test');
  applyEvent(state, { kind: 'session.status', sessionId: 's1', ts: now + 501, status: 'tool' });
  applyEvent(state, { kind: 'tool.complete', sessionId: 's1', ts: now + 600, messageId: 'm449', callId: 'c449', name: 'terminal', ok: true, durationMs: 100, meta: { command: 'npm test', exitCode: 0 } });
  assert.equal(s.currentTool, null); assert.equal(s.activity, 'ran npm test → exit 0');
  applyEvent(state, { kind: 'session.status', sessionId: 's1', ts: now + 601, status: 'waiting_on_you', attention: { kind: 'approval', text: 'go?', requestId: 'r', since: now } });
  assert.equal(s.status, 'waiting_on_you'); assert.equal(s.attention.requestId, 'r');
  applyEvent(state, { kind: 'session.status', sessionId: 's1', ts: now + 602, status: 'idle' });
  assert.equal(s.attention, null);
  // streaming
  applyEvent(state, { kind: 'message.add', sessionId: 's1', ts: now + 700, message: { id: 'live', sessionId: 's1', role: 'assistant', ts: now + 700, text: '', summary: '', glyph: 'A', streaming: true } });
  applyEvent(state, { kind: 'message.delta', sessionId: 's1', ts: now + 701, messageId: 'live', text: 'Hello ' });
  applyEvent(state, { kind: 'message.delta', sessionId: 's1', ts: now + 702, messageId: 'live', text: 'world.' });
  assert.equal(state.messages.s1.at(-1).text, 'Hello world.');
  applyEvent(state, { kind: 'message.complete', sessionId: 's1', ts: now + 703, messageId: 'live', text: 'Hello world!' });
  assert.equal(state.messages.s1.at(-1).text, 'Hello world!'); assert.equal(state.messages.s1.at(-1).streaming, false);
  // upsert keeps derived counts once we track messages; layout + pylons + remove
  applyEvent(state, { kind: 'session.upsert', sessionId: 's1', ts: now + 800, session: { id: 's1', title: 'renamed', counts: { messages: 0, toolCalls: 0, byCategory: {} } } });
  assert.equal(s.title, 'renamed'); assert.equal(s.counts.messages, 451);
  applyEvent(state, { kind: 'layout.column', sessionId: 's1', ts: now, placement: { sessionId: 's1', x: 1, z: -2, rot: 0.5 } });
  assert.deepEqual(state.layout.s1, { sessionId: 's1', x: 1, z: -2, rot: 0.5 });
  applyEvent(state, { kind: 'pylons', sessionId: '*', ts: now, pylons: [{ kind: 'browser', x: -3, z: -1, label: 'web' }] });
  assert.equal(state.pylons.length, 1);
  applyEvent(state, { kind: 'unknown.kind', sessionId: 's1', ts: now });
  const snap = snapshot(state);
  assert.deepEqual(Object.keys(snap).sort(), ['layout', 'lineage', 'messages', 'pylons', 'sessions']);
  assert.equal(snap.sessions[0].id, 's1'); assert.equal(snap.messages.s1.length, 400);
  snap.sessions[0].title = 'mutated';
  assert.equal(state.sessions.s1.title, 'renamed', 'snapshot is a copy');
  applyEvent(state, { kind: 'session.remove', sessionId: 's1', ts: now });
  assert.deepEqual(state.order, []); assert.equal(state.messages.s1, undefined); assert.equal(state.layout.s1, undefined);
  // default arc: 5 front at r 1.8, next at r 2.6
  assert.ok(Math.abs(Math.hypot(defaultPlacement('x', 4).x, defaultPlacement('x', 4).z) - 1.8) < 2e-3);
  assert.ok(Math.abs(Math.hypot(defaultPlacement('x', 5).x, defaultPlacement('x', 5).z) - 2.6) < 2e-3);
  assert.ok(defaultPlacement('x', 2).x === 0 && defaultPlacement('x', 2).z === -1.8, 'third session straight ahead');
});

test('assistant rows: empty/null/whitespace content + tool_calls → no assistant tile, calls still split', () => {
  const tc = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const rows = [
    { id: 1, role: 'assistant', content: '', tool_calls: JSON.stringify([tc('a', 'read_file', { path: 'x.js' })]), timestamp: T0 },
    { id: 2, role: 'assistant', content: null, tool_calls: JSON.stringify([tc('b', 'terminal', { command: 'ls' }), tc('c', 'web_search', { query: 'q' })]), timestamp: T0 + 1 },
    { id: 3, role: 'assistant', content: '   \n', tool_calls: [tc('d', 'patch', { path: 'y.js', old_string: 'a', new_string: 'b' })], timestamp: T0 + 2 },
    { id: 4, role: 'assistant', content: 'Text and a call.', tool_calls: JSON.stringify([tc('e', 'memory', { action: 'add', content: 'note' })]), timestamp: T0 + 3 },
    { id: 5, role: 'assistant', content: '', tool_calls: null, timestamp: T0 + 4 },
  ];
  const { messages, events } = normalizeMessages('s', rows);
  assert.deepEqual(messages.map((m) => `${m.role}:${m.id}`), [
    'tool_call:1:a', 'tool_call:2:b', 'tool_call:2:c', 'tool_call:3:d', 'assistant:4', 'tool_call:4:e', 'assistant:5',
  ]);
  assert.equal(events.filter((e) => e.kind === 'tool.start').length, 5);
  assert.equal(messages.find((m) => m.id === '5').text, '', 'an empty assistant row without calls keeps a (blank) tile');
  assert.equal(messages[0].tool.target, 'files'); assert.equal(messages[1].tool.target, 'terminal'); assert.equal(messages[2].tool.target, 'browser');
  assert.match(messages[3].tool.meta.diff, /^--- a\/y\.js/);
});

test('reasoning vs reasoning_content vs reasoning_details', () => {
  const run = (row) => normalizeMessages('s', [{ id: 9, role: 'assistant', content: 'ok', timestamp: T0, ...row }]).messages;
  assert.equal(run({ reasoning: 'from reasoning', reasoning_content: 'from content' })[0].text, 'from reasoning', 'reasoning wins when both are set');
  assert.equal(run({ reasoning: '', reasoning_content: 'from content' })[0].text, 'from content', 'empty reasoning falls through to reasoning_content');
  assert.equal(run({ reasoning: null, reasoning_content: 'from content' })[0].text, 'from content');
  assert.equal(run({ reasoning: null, reasoning_content: null, reasoning_details: JSON.stringify([{ type: 'reasoning.text', text: 'from details' }]) })[0].text, 'from details');
  const none = run({ reasoning: '   ', reasoning_content: '' });
  assert.equal(none.length, 1); assert.equal(none[0].role, 'assistant', 'whitespace-only reasoning → no thinking tile');
  const both = run({ reasoning_content: 'deep thought' });
  assert.deepEqual(both.map((m) => `${m.role}:${m.id}`), ['thinking:9:r', 'assistant:9']);
  assert.equal(both[0].parentMessageId, '9');
  assert.ok(both[0].ts <= both[1].ts);
});

test('role:"tool" rows arriving before their assistant row do not crash and are linked when the call lands', () => {
  const rows = [
    { id: 21, role: 'tool', tool_call_id: 'call_x', tool_name: 'terminal', content: '{"output":"ok","exit_code":0}', timestamp: T0 + 5 },
    { id: 22, role: 'tool', tool_call_id: 'call_never', tool_name: 'read_file', content: 'orphan forever', timestamp: T0 + 6 },
    { id: 20, role: 'assistant', content: '', tool_calls: JSON.stringify([{ id: 'call_x', type: 'function', function: { name: 'terminal', arguments: '{"command":"npm test"}' } }]), timestamp: T0 + 4 },
  ];
  const { messages, events, pendingCalls, orphanResults } = normalizeMessages('s', rows);
  assert.deepEqual(messages.map((m) => `${m.role}:${m.id}`), ['tool_result:21', 'tool_result:22', 'tool_call:20:call_x']);
  const res = messages[0];
  assert.equal(res.parentMessageId, '20:call_x', 'linked once the call arrived');
  assert.equal(res.tool.callId, 'call_x'); assert.equal(res.tool.ok, true); assert.equal(res.tool.meta.exitCode, 0); assert.equal(res.tool.meta.command, 'npm test');
  assert.equal(res.tool.durationMs, 1000);
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['message.add', 'message.add', 'message.add', 'tool.start', 'tool.complete']);
  const complete = events[4];
  assert.equal(complete.messageId, '20:call_x'); assert.equal(complete.callId, 'call_x'); assert.equal(complete.resultMessageId, '21'); assert.equal(complete.durationMs, 1000);
  assert.equal(pendingCalls.size, 0, 'no dangling call');
  assert.deepEqual([...orphanResults.keys()], ['call_never'], 'the never-matched result stays an orphan');
  assert.equal(messages[1].parentMessageId, undefined);
  // the hermes adapter feeds pages one at a time: the orphan map carries across pages
  const page1 = normalizeMessages('s', rows.slice(1, 2));
  const page2 = normalizeMessages('s', [{ id: 19, role: 'assistant', content: '', tool_calls: [{ id: 'call_never', function: { name: 'read_file', arguments: { path: 'a.js' } } }], timestamp: T0 + 1 }],
    { knownCalls: page1.pendingCalls, orphanResults: page1.orphanResults });
  assert.deepEqual(page2.events.map((e) => e.kind), ['message.add', 'tool.start', 'tool.complete']);
  assert.equal(page2.events[2].resultMessageId, '22');
  assert.equal(page1.messages[0].parentMessageId, '19:call_never', 'earlier page result object is linked in place');
  // tool row with neither tool_call_id nor tool_name
  const bare = normalizeMessages('s', [{ id: 30, role: 'tool', content: 'something', timestamp: T0 }]);
  assert.equal(bare.messages[0].tool.callId, '30:orphan'); assert.equal(bare.messages[0].tool.name, 'tool');
});

test('tool results that carry a unified diff (Hermes patch/write_file) win over the composed diff; §3g summaries', () => {
  const realDiff = '--- a/src/parser.js\n+++ b/src/parser.js\n@@ -9,7 +9,7 @@\n context\n-      for (let i = 0; i < lines.length - 1; i++) {\n+      for (let i = 0; i < lines.length; i++) {\n context';
  const rows = [
    { id: 1, role: 'assistant', content: '', tool_calls: JSON.stringify([{ id: 'p1', type: 'function', function: { name: 'patch', arguments: JSON.stringify({ path: 'src/parser.js', old_string: 'lines.length - 1', new_string: 'lines.length' }) } }]), timestamp: T0 },
    { id: 2, role: 'tool', tool_call_id: 'p1', tool_name: 'patch', content: JSON.stringify({ success: true, diff: realDiff }), timestamp: T0 + 1 },
  ];
  const { messages, events } = normalizeMessages('s', rows);
  const complete = events.find((e) => e.kind === 'tool.complete');
  assert.equal(complete.meta.diff, realDiff);
  assert.equal(messages[1].tool.meta.diff, realDiff);
  assert.equal(messages[1].summary, 'patch ✓ (+1 −1)');
  assert.equal(describeToolResult('patch', '{"success":true,"inline_diff":"@@ -1 +1 @@\\n-a\\n+b"}').diff, '@@ -1 +1 @@\n-a\n+b');
  assert.equal(describeToolResult('patch', '{"success":true,"diff":"not a diff"}').diff, undefined);
  assert.equal(describeToolCall('todo_list', { todos: [{ content: 'wire the pylons', status: 'pending' }, { content: 'ship it' }] }).summary, 'todo_list (2) wire the pylons');
  assert.equal(describeToolCall('delegate_task', { tasks: [{ goal: 'audit xr.js' }, { goal: 'audit desktop.js' }] }).summary, 'delegate ×2 "audit xr.js"');
  assert.equal(describeToolCall('delegate_task', { goal: 'one goal' }).summary, 'delegate "one goal"');
  assert.equal(describeToolCall('web_extract', { urls: ['https://webkit.org/blog/x/'] }).meta.url, 'https://webkit.org/blog/x/');
  assert.equal(CATEGORY_OF_TOOL('skills_list'), 'memory'); assert.equal(CATEGORY_OF_TOOL('skill_manage'), 'memory');
  assert.equal(CATEGORY_OF_TOOL('browser_vision'), 'web'); assert.equal(CATEGORY_OF_TOOL('cronjob_manage'), 'tools');
});

test('fixtures/raw/hermes-export-sample.json normalizes cleanly', () => {
  const exp = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'raw', 'hermes-export-sample.json'), 'utf8'));
  const { session, messages, events } = normalizeExport(exp);
  assert.equal(session.id, exp.id); assert.equal(session.title, 'fix-parser-tests');
  assert.equal(messages.filter((m) => m.role === 'tool_call').length, 7);
  assert.equal(messages.filter((m) => m.role === 'tool_result').length, 7);
  assert.equal(events.filter((e) => e.kind === 'tool.start').length, 7);
  assert.equal(events.filter((e) => e.kind === 'tool.complete').length, 7);
  for (const m of messages.filter((x) => x.role === 'tool_result')) assert.ok(m.parentMessageId, `result ${m.id} linked`);
  const text = JSON.stringify({ session, messages, events });
  assert.ok(!text.includes('sk-FAKE'), 'fake key redacted'); assert.ok(text.includes('sk-[REDACTED]'));
  const thinking = messages.filter((m) => m.role === 'thinking');
  assert.equal(thinking.length, 2, "two reasoning-bearing assistant rows in the sample");
  for (const t of thinking) {
    const i = messages.findIndex((m) => m.id === t.id);
    const parentIdx = messages.findIndex((m) => m.id === t.parentMessageId);
    const callIdx = messages.findIndex((m) => m.id.startsWith(`${t.parentMessageId}:`) && m.role === 'tool_call');
    assert.ok(parentIdx === -1 || parentIdx > i, 'thinking before its assistant text');
    assert.ok(callIdx === -1 || callIdx > i, 'thinking before the row\'s tool calls');
  }
  const patch = events.find((e) => e.kind === 'tool.complete' && e.name === 'patch');
  assert.match(patch.meta.diff, /^--- a\/src\/parser\.js/m, 'real diff from the result row');
  assert.ok(messages.every((m) => m.summary.length <= 100 && m.glyph.length >= 1 && m.glyph.length <= 2));
  assert.equal(session.status, 'idle', 'not active, not ended');
});
