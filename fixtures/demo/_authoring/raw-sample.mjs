// Builds fixtures/raw/hermes-export-sample.json: a Hermes GET /api/sessions/{id}/export -shaped object
// ({...sessionRow, messages: [rows]}) for test/normalize.test.mjs. tool_calls is a JSON STRING, as the dashboard delivers it.
import { T0 } from './lib.mjs';

const SID = '20261017-091203-7f3a';
const t0 = T0 / 1000 - 1800; // unix seconds
let n = 0, t = t0;
const row = (role, content, extra = {}) => {
  t += extra.dt ?? 4.2; delete extra.dt;
  return {
    id: ++n, session_id: SID, role, content, tool_call_id: null, tool_calls: null, tool_name: null,
    timestamp: Math.round(t * 1000) / 1000, token_count: content ? Math.round(content.length / 4) : null, finish_reason: null,
    reasoning: null, reasoning_content: null, reasoning_details: null, display_kind: null, display_metadata: null,
    active: 1, compacted: 0, ...extra,
  };
};
const calls = (list) => JSON.stringify(list.map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })));

const PATCH_DIFF = `--- a/src/parser.js\n+++ b/src/parser.js\n@@ -9,7 +9,7 @@ export function createLineParser(onLine, { onError } = {}) {\n       const text = tail + String(chunk);\n       const lines = text.split('\\n');\n       tail = lines.pop();\n-      for (let i = 0; i < lines.length - 1; i++) {\n+      for (let i = 0; i < lines.length; i++) {\n         lineNo++;\n         const raw = lines[i].trim();\n         if (!raw) continue;`;

export function buildRawSample() {
  const messages = [
    row('system', 'You are Hermes, a coding agent working in /workspace/cEverything. Prefer small verified changes.', { dt: 0 }),
    row('user', 'npm test is red: "parser: parses the last line of a JSONL chunk" fails since the streaming change. Find the bug and fix it, then check whether node:test has a flag to run a single file so I can iterate faster.'),
    row('assistant', 'I will reproduce the failure first, then read the parser.', {
      reasoning: 'The failing test name points at the loop over complete lines. Reproduce with npm test, then read src/parser.js around the split/pop. The node:test question is separate; a quick web search will settle the exact flag.',
      reasoning_content: 'The failing test name points at the loop over complete lines. Reproduce with npm test, then read src/parser.js around the split/pop. The node:test question is separate; a quick web search will settle the exact flag.',
      finish_reason: 'tool_calls', tool_calls: calls([['call_01HX7Q2M', 'terminal', { command: 'npm test 2>&1 | tail -20' }]]), dt: 6.8,
    }),
    row('tool', JSON.stringify({ output: '✖ parser: parses the last line of a JSONL chunk (2.8ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n  2 !== 3\n\nℹ tests 9\nℹ pass 8\nℹ fail 1\n', exit_code: 1, error: null }), { tool_call_id: 'call_01HX7Q2M', tool_name: 'terminal', dt: 2.9 }),
    row('assistant', '', { finish_reason: 'tool_calls', tool_calls: calls([['call_01HX7Q3A', 'read_file', { path: 'src/parser.js' }]]), dt: 1.4 }),
    row('tool', JSON.stringify({ content: "9:       const text = tail + String(chunk);\n10:       const lines = text.split('\\n');\n11:       tail = lines.pop();\n12:       for (let i = 0; i < lines.length - 1; i++) {\n13:         lineNo++;\n14:         const raw = lines[i].trim();\n15:         if (!raw) continue;\n16:         onLine(JSON.parse(raw), lineNo);\n17:       }", total_lines: 24, truncated: false }), { tool_call_id: 'call_01HX7Q3A', tool_name: 'read_file', dt: 0.6 }),
    // One assistant row carrying TWO tool calls (patch + web_search) and reasoning, empty content → no assistant tile.
    row('assistant', '', {
      reasoning: 'Line 12 keeps a `- 1` from before `lines.pop()` took the partial line out, so the last complete line of every chunk is skipped. Patch the bound. In parallel, look up the node:test single-file invocation for the user.',
      reasoning_content: 'Line 12 keeps a `- 1` from before `lines.pop()` took the partial line out, so the last complete line of every chunk is skipped. Patch the bound. In parallel, look up the node:test single-file invocation for the user.',
      finish_reason: 'tool_calls', dt: 7.1,
      tool_calls: calls([
        ['call_01HX7Q4P', 'patch', { path: 'src/parser.js', old_string: '      for (let i = 0; i < lines.length - 1; i++) {', new_string: '      for (let i = 0; i < lines.length; i++) {' }],
        ['call_01HX7Q4W', 'web_search', { query: 'node:test run a single test file --test flag node 22', limit: 3 }],
      ]),
    }),
    row('tool', JSON.stringify({ success: true, diff: PATCH_DIFF, files_modified: ['src/parser.js'] }), { tool_call_id: 'call_01HX7Q4P', tool_name: 'patch', dt: 0.7 }),
    row('tool', JSON.stringify({ success: true, data: { web: [
      { title: 'Test runner | Node.js v22 Documentation', url: 'https://nodejs.org/docs/latest-v22.x/api/test.html', description: 'node --test accepts file paths and glob patterns; node --test test/parser.test.mjs runs one file.', position: 1 },
      { title: 'Running a single test file with node --test', url: 'https://nodejs.org/en/learn/test-runner/using-test-runner', description: 'Pass the file path directly, or use --test-name-pattern to filter by test name.', position: 2 },
    ] }, parameters: { query: 'node:test run a single test file --test flag node 22', limit: 3 }, error: null, results_count: 2 }), { tool_call_id: 'call_01HX7Q4W', tool_name: 'web_search', dt: 1.9 }),
    row('assistant', 'Patched the loop bound. Running the suite again, and the single-file answer is `node --test test/parser.test.mjs` (or `--test-name-pattern` to filter by name).', { finish_reason: 'tool_calls', tool_calls: calls([['call_01HX7Q5K', 'terminal', { command: 'npm test 2>&1 | tail -10' }]]), dt: 3.3 }),
    row('tool', JSON.stringify({ output: 'ℹ tests 9\nℹ suites 0\nℹ pass 9\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 91.4\n', exit_code: 0, error: null }), { tool_call_id: 'call_01HX7Q5K', tool_name: 'terminal', dt: 2.6 }),
    row('assistant', 'Fixed. `src/parser.js` looped `i < lines.length - 1` after `lines.pop()` had already removed the partial line, so the last complete line of every chunk was dropped. The bound is now `i < lines.length`; 9/9 tests pass. For fast iteration run `node --test test/parser.test.mjs`.', { finish_reason: 'stop', dt: 2.1 }),
    row('user', 'Great. Print the env the test runner sees so I can check nothing leaks into CI logs.', { dt: 25.0 }),
    row('assistant', '', { finish_reason: 'tool_calls', tool_calls: calls([['call_01HX7Q6D', 'terminal', { command: 'env | grep -E "^(NODE|HERMES|OPENAI)_" | sort' }]]), dt: 2.4 }),
    // Deliberately FAKE key-shaped value so normalize.test.mjs can assert redaction; it is not a real credential.
    row('tool', JSON.stringify({ output: 'HERMES_DASHBOARD=http://127.0.0.1:9119\nNODE_ENV=test\nNODE_OPTIONS=--enable-source-maps\nOPENAI_API_KEY=sk-FAKEFAKEFAKEFAKEFAKEFAKE00\n', exit_code: 0, error: null }), { tool_call_id: 'call_01HX7Q6D', tool_name: 'terminal', dt: 0.8 }),
    row('assistant', 'Three NODE_/HERMES_ variables and one OPENAI_API_KEY are visible to the runner. The key must not reach CI logs; I recommend moving it to the secret store and reading it only in server/stt. Nothing else sensitive is set.', { finish_reason: 'stop', dt: 3.9 }),
    row('user', 'Do that later. Save a note about the parser fix for future sessions.', { dt: 14.0 }),
    row('assistant', '', { finish_reason: 'tool_calls', tool_calls: calls([['call_01HX7Q7R', 'memory', { action: 'add', target: 'memory', content: 'src/parser.js: after lines.pop() the loop bound is lines.length (not -1); the off-by-one dropped the last complete line of each chunk.' }]]), dt: 1.7 }),
    row('tool', 'Added to memory (entry 14 of 40).', { tool_call_id: 'call_01HX7Q7R', tool_name: 'memory', dt: 0.3 }),
    row('assistant', 'Saved. Anything else on the parser?', { finish_reason: 'stop', dt: 1.2 }),
  ];
  const toolCalls = messages.filter((m) => m.tool_calls).reduce((a, m) => a + JSON.parse(m.tool_calls).length, 0);
  return {
    id: SID, source: 'cli', title: 'fix-parser-tests', model: 'openai/gpt-5', cwd: '/workspace/cEverything',
    git_branch: 'fix/parser-off-by-one', git_repo_root: '/workspace/cEverything', parent_session_id: null,
    started_at: t0, ended_at: null, end_reason: null,
    message_count: messages.length, tool_call_count: toolCalls,
    input_tokens: 18422, output_tokens: 2210, reasoning_tokens: 388, cache_read_tokens: 12040, cache_write_tokens: 0,
    last_activity_at: messages[messages.length - 1].timestamp, last_activity_description: 'memory: add',
    tool_names: 'terminal,read_file,patch,web_search,memory', archived: false, pinned: false, profile: 'default',
    messages,
  };
}
