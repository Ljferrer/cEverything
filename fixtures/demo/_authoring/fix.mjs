// fix-parser-tests (s_fix): read_file / terminal / patch loop fixing an off-by-one. Real unified diffs in meta.diff.
import { SessionWriter, T0, diff, newFileDiff, v4a, hermes, patchedSummary } from './lib.mjs';

const PARSER_V1 = `// src/parser.js — incremental JSONL reader for fixture streams and WS text frames.
// Feed arbitrary chunks; complete lines are parsed and handed to onLine, the
// trailing partial line is held until the next chunk or flush().
export function createLineParser(onLine, { onError } = {}) {
  let tail = '';
  let lineNo = 0;
  return {
    push(chunk) {
      const text = tail + String(chunk);
      const lines = text.split('\\n');
      tail = lines.pop();
      for (let i = 0; i < lines.length - 1; i++) {
        lineNo++;
        const raw = lines[i].trim();
        if (!raw) continue;
        onLine(JSON.parse(raw), lineNo);
      }
    },
    flush() {
      if (tail.trim()) onLine(JSON.parse(tail), ++lineNo);
      tail = '';
    },
  };
}
`;

const TEST_V1 = `import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineParser } from '../src/parser.js';

function collect() {
  const out = [];
  const p = createLineParser((obj) => out.push(obj));
  return { p, out };
}

test('parser: splits complete lines', () => {
  const { p, out } = collect();
  p.push('{"a":1}\\n{"a":2}\\n');
  assert.equal(out.length, 2);
});

test('parser: keeps a trailing partial line', () => {
  const { p, out } = collect();
  p.push('{"a":1}\\n{"a":');
  p.push('2}\\n');
  assert.deepEqual(out, [{ a: 1 }, { a: 2 }]);
});

test('parser: parses the last line of a JSONL chunk', () => {
  const { p, out } = collect();
  p.push('{"a":1}\\n{"a":2}\\n{"a":3}\\n');
  assert.equal(out.length, 3);
});

test('parser: flush() emits the held tail', () => {
  const { p, out } = collect();
  p.push('{"a":9}');
  p.flush();
  assert.equal(out.length, 1);
});
`;

const EDGE_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineParser } from '../src/parser.js';

const collect = () => {
  const out = [], errors = [];
  const p = createLineParser((obj, n) => out.push([n, obj]), { onError: (e, n) => errors.push(n) });
  return { p, out, errors };
};

test('parser: one object split across three chunks', () => {
  const { p, out } = collect();
  p.push('{"kind":"mess');
  p.push('age.add","dt":');
  p.push('40}\\n');
  assert.deepEqual(out, [[1, { kind: 'message.add', dt: 40 }]]);
});

test('parser: blank lines are skipped but still counted', () => {
  const { p, out } = collect();
  p.push('{"a":1}\\n\\n{"a":2}\\n');
  assert.deepEqual(out.map(([n]) => n), [1, 3]);
});

test('parser: a malformed line reports its number and does not stop the stream', () => {
  const { p, out, errors } = collect();
  p.push('{"a":1}\\n{oops}\\n{"a":3}\\n');
  assert.deepEqual(errors, [2]);
  assert.equal(out.length, 2);
});

test('parser: CRLF input parses like LF', () => {
  const { p, out } = collect();
  p.push('{"a":1}\\r\\n{"a":2}\\r\\n');
  assert.equal(out.length, 2);
});
`;

const FAIL_OUT = `
> ceverything@0.1.0 test
> node --test test/

✔ protocol: validate() accepts every event kind (3.1ms)
✔ protocol: validate() rejects unknown kinds (0.6ms)
✔ hub: hello then snapshot on join (41.8ms)
✔ hub: join with lastSeq replays from the ring buffer (22.4ms)
✔ parser: splits complete lines (1.2ms)
✔ parser: keeps a trailing partial line (0.4ms)
✖ parser: parses the last line of a JSONL chunk (2.8ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  2 !== 3

      at TestContext.<anonymous> (file:///workspace/cEverything/test/parser.test.mjs:28:10)
      at Test.runInAsyncScope (node:async_hooks:211:14)
      at Test.run (node:internal/test_runner/test:1047:25) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 2,
    expected: 3,
    operator: 'strictEqual'
  }

✔ parser: flush() emits the held tail (0.3ms)
✔ normalize: splits reasoning into a thinking message (1.9ms)
ℹ tests 9
ℹ suites 0
ℹ pass 8
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 96.2
`;

const passOut = (n, ms) => `
> ceverything@0.1.0 test
> node --test test/

ℹ tests ${n}
ℹ suites 0
ℹ pass ${n}
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms ${ms}
`;

export function build() {
  const w = new SessionWriter({
    id: 's_fix', title: 'fix-parser-tests', status: 'idle', model: 'openai/gpt-5', gitBranch: 'fix/parser-off-by-one',
    activity: 'idle', summary: 'npm test is red since the streaming change: parses the last line of a JSONL chunk fails',
    startedAt: T0 - 40_000,
  }, { seed: 23, pace: 2.3 });

  w.user(1800, '`npm test` is red since the streaming change: test/parser.test.mjs › "parses the last line of a JSONL chunk" fails. Find the bug, fix it, and add a regression test. Don\'t touch the hub.');
  w.status(400, 'thinking', 'thinking');
  let row = w.nextId();
  w.thinking(3900, 'Reproduce first. Run the suite and read the failing assertion before touching any code; the test name already hints at a boundary bug in the line loop.', { forId: row });
  w.status(300, 'tool', 'running: npm test');
  let c = w.toolCall(500, 'todo_list', { todos: [
    { id: '1', content: 'Reproduce the failing parser test', status: 'in_progress' },
    { id: '2', content: 'Fix src/parser.js', status: 'pending' },
    { id: '3', content: 'Regression test + full suite green', status: 'pending' },
  ] }, { rowId: row });
  w.toolResult(300, c, { text: '[ ] 1. Reproduce the failing parser test  (in progress)\n[ ] 2. Fix src/parser.js\n[ ] 3. Regression test + full suite green', summary: '→ 3 todos tracked' });
  c = w.toolCall(900, 'terminal', { command: 'npm test 2>&1 | tail -40', timeout: 120 });
  let r = hermes.terminal(FAIL_OUT, 1);
  w.toolResult(2700, c, { text: r.text, ok: false, summary: '✗ exit 1 · 8 pass, 1 fail: parses the last line of a JSONL chunk', meta: { command: c.args.command, exitCode: 1 } });

  row = w.nextId();
  w.status(900, 'thinking', 'thinking');
  w.thinking(4600, 'Two objects parsed out of three complete lines, while the trailing-partial test passes. So the tail handling is right and the loop over the complete lines stops one early. Read the parser.', { forId: row });
  w.status(300, 'tool', 'reading src/parser.js');
  c = w.toolCall(600, 'read_file', { path: 'src/parser.js' }, { rowId: row });
  r = hermes.readFile(PARSER_V1);
  w.toolResult(700, c, { text: r.text, summary: '→ 24 lines', meta: { path: 'src/parser.js' } });

  row = w.nextId();
  w.status(1100, 'thinking', 'thinking');
  w.thinking(7800, 'Line 12: `i < lines.length - 1`. After `lines.pop()` the array holds only complete lines, so the `- 1` skips the last complete line of every chunk. It was correct before the pop was added (the last element was the partial line then) and nobody updated the bound. Classic off-by-one. Separate issue: JSON.parse throws on a malformed line and kills the whole stream, which would stop the fixture replayer mid-file; the test file even reserves an onError option that is never used. Fix the bound first, run the suite, then the guard.', { forId: row });
  w.status(400, 'tool', 'editing src/parser.js');
  const D1 = diff('src/parser.js', [{ old: 9, new: 9, ctx: 'export function createLineParser(onLine, { onError } = {}) {', lines: [
    "       const text = tail + String(chunk);",
    "       const lines = text.split('\\n');",
    '       tail = lines.pop();',
    '-      for (let i = 0; i < lines.length - 1; i++) {',
    '+      for (let i = 0; i < lines.length; i++) {',
    '         lineNo++;',
    '         const raw = lines[i].trim();',
    '         if (!raw) continue;',
  ] }]);
  c = w.toolCall(900, 'patch', { path: 'src/parser.js', old_string: '      for (let i = 0; i < lines.length - 1; i++) {', new_string: '      for (let i = 0; i < lines.length; i++) {' }, { rowId: row, meta: { path: 'src/parser.js', diff: D1 } });
  w.toolResult(600, c, { text: hermes.patch(D1).text, summary: patchedSummary(D1) });
  w.status(500, 'tool', 'running: npm test');
  c = w.toolCall(1200, 'terminal', { command: 'npm test 2>&1 | tail -12', timeout: 120 });
  w.toolResult(2500, c, { text: hermes.terminal(passOut(9, 91.4)).text, summary: '→ exit 0 · 9 tests pass', meta: { command: c.args.command, exitCode: 0 } });
  w.status(800, 'responding', 'responding');
  w.assistant(900, 'Fixed: the loop bound `lines.length - 1` dropped the last complete line of every chunk (left over from before `lines.pop()` took the partial line out). All 9 tests pass. Now the regression test and the malformed-line guard.');
  w.status(400, 'tool', 'reading test/parser.test.mjs');
  c = w.toolCall(2200, 'read_file', { path: 'test/parser.test.mjs' });
  w.toolResult(600, c, { text: hermes.readFile(TEST_V1).text, summary: '→ 35 lines · 4 tests', meta: { path: 'test/parser.test.mjs' } });

  row = w.nextId();
  w.status(1200, 'thinking', 'thinking');
  w.thinking(5100, 'The new file should cover the shapes the fixture replayer actually sees: an object split across three chunks, blank lines (still counted so line numbers stay stable), a malformed line that must be reported with its number without stopping the stream, and CRLF input. The last two need parser changes: a try/catch around JSON.parse that calls onError(err, lineNo) and rethrows when no handler was given, and a trim of the trailing \\r.', { forId: row });
  w.status(300, 'tool', 'editing test/parser.edge.test.mjs');
  const D2 = newFileDiff('test/parser.edge.test.mjs', EDGE_TEST);
  c = w.toolCall(700, 'write_file', { path: 'test/parser.edge.test.mjs', content: EDGE_TEST }, { rowId: row, meta: { path: 'test/parser.edge.test.mjs', diff: D2 } });
  w.toolResult(500, c, { text: hermes.writeFile('test/parser.edge.test.mjs', EDGE_TEST).text, summary: patchedSummary(D2, 'wrote') });
  w.status(400, 'tool', 'editing src/parser.js');
  const D3 = diff('src/parser.js', [{ old: 12, new: 12, ctx: 'export function createLineParser(onLine, { onError } = {}) {', lines: [
    '       for (let i = 0; i < lines.length; i++) {',
    '         lineNo++;',
    "-        const raw = lines[i].trim();",
    '-        if (!raw) continue;',
    '-        onLine(JSON.parse(raw), lineNo);',
    "+        const raw = lines[i].replace(/\\r$/, '').trim();",
    '+        if (!raw) continue;',
    '+        let obj;',
    '+        try { obj = JSON.parse(raw); } catch (err) {',
    '+          if (!onError) throw err;',
    '+          onError(err, lineNo);',
    '+          continue;',
    '+        }',
    '+        onLine(obj, lineNo);',
    '       }',
    '     },',
  ] }]);
  c = w.toolCall(1400, 'patch', {
    path: 'src/parser.js',
    old_string: "        const raw = lines[i].trim();\n        if (!raw) continue;\n        onLine(JSON.parse(raw), lineNo);",
    new_string: "        const raw = lines[i].replace(/\\r$/, '').trim();\n        if (!raw) continue;\n        let obj;\n        try { obj = JSON.parse(raw); } catch (err) {\n          if (!onError) throw err;\n          onError(err, lineNo);\n          continue;\n        }\n        onLine(obj, lineNo);",
  }, { meta: { path: 'src/parser.js', diff: D3 } });
  w.toolResult(700, c, { text: hermes.patch(D3).text, summary: patchedSummary(D3) });
  w.status(500, 'tool', 'running: npm test');
  c = w.toolCall(1000, 'terminal', { command: 'npm test 2>&1 | tail -12', timeout: 120 });
  w.toolResult(2600, c, { text: hermes.terminal(passOut(13, 118.7)).text, summary: '→ exit 0 · 13 tests pass', meta: { command: c.args.command, exitCode: 0 } });

  w.status(900, 'tool', 'searching server/');
  c = w.toolCall(1300, 'search_files', { pattern: 'createLineParser', path: 'server', output_mode: 'content' });
  w.toolResult(800, c, { text: 'server/sources/fixture.js\n  3: import { createLineParser } from \'../../src/parser.js\';\n  41:   const parser = createLineParser((ev, n) => queue.push({ ev, n, file }));\n\n2 matches in 1 file', summary: '→ 2 matches · server/sources/fixture.js (hub untouched)' });

  row = w.nextId();
  w.status(1000, 'thinking', 'thinking');
  w.thinking(4200, 'Only the fixture replayer uses the parser; the hub never does, so the constraint holds. The replayer should opt into onError so a bad fixture line is logged with file and line and skipped rather than aborting the replay. One small patch there, then re-run.', { forId: row });
  w.status(300, 'tool', 'editing server/sources/fixture.js');
  const D4 = diff('server/sources/fixture.js', [{ old: 39, new: 39, ctx: 'async function loadFile(file, queue) {', lines: [
    "   const text = await readFile(file, 'utf8');",
    '   let n = 0;',
    '-  const parser = createLineParser((ev, n) => queue.push({ ev, n, file }));',
    '+  const parser = createLineParser((ev, n) => queue.push({ ev, n, file }), {',
    '+    onError: (err, line) => console.warn(`[fixture] ${file}:${line} skipped: ${err.message}`),',
    '+  });',
    '   parser.push(text);',
    '   parser.flush();',
  ] }]);
  c = w.toolCall(900, 'patch', {
    path: 'server/sources/fixture.js',
    old_string: '  const parser = createLineParser((ev, n) => queue.push({ ev, n, file }));',
    new_string: '  const parser = createLineParser((ev, n) => queue.push({ ev, n, file }), {\n    onError: (err, line) => console.warn(`[fixture] ${file}:${line} skipped: ${err.message}`),\n  });',
  }, { rowId: row, meta: { path: 'server/sources/fixture.js', diff: D4 } });
  w.toolResult(600, c, { text: hermes.patch(D4).text, summary: patchedSummary(D4) });
  w.status(500, 'tool', 'running: npm test');
  c = w.toolCall(900, 'terminal', { command: 'npm test 2>&1 | tail -12', timeout: 120 });
  w.toolResult(2400, c, { text: hermes.terminal(passOut(13, 121.0)).text, summary: '→ exit 0 · 13 tests pass', meta: { command: c.args.command, exitCode: 0 } });
  w.status(700, 'responding', 'responding');
  w.assistant(1100, 'Guard in place: a malformed line now calls `onError(err, lineNo)` and the stream continues; without a handler it rethrows as before. CRLF is tolerated. The fixture replayer logs and skips bad lines instead of aborting. 13 tests green.');
  w.status(600, 'idle', 'idle');

  // follow-up from the user
  w.user(16_000, 'Nice. Also make flush() go through the same guard — a bad last line without a newline would still throw. Then show me the diff stat.');
  w.status(500, 'thinking', 'thinking');
  row = w.nextId();
  w.thinking(4300, 'Right: flush() still calls JSON.parse directly. Factor the guarded parse into a small helper used by both push() and flush(), keep the line counting identical, add one test, run, then git diff --stat.', { forId: row });
  w.status(300, 'tool', 'editing src/parser.js');
  const H5 = [
    { old: 4, new: 4, lines: [
      ' export function createLineParser(onLine, { onError } = {}) {',
      "   let tail = '';",
      '   let lineNo = 0;',
      '+  const emit = (raw, n) => {',
      '+    let obj;',
      '+    try { obj = JSON.parse(raw); } catch (err) {',
      '+      if (!onError) throw err;',
      '+      return onError(err, n);',
      '+    }',
      '+    onLine(obj, n);',
      '+  };',
      '   return {',
    ] },
    { old: 14, new: 22, lines: [
      "         const raw = lines[i].replace(/\\r$/, '').trim();",
      '         if (!raw) continue;',
      '-        let obj;',
      '-        try { obj = JSON.parse(raw); } catch (err) {',
      '-          if (!onError) throw err;',
      '-          onError(err, lineNo);',
      '-          continue;',
      '-        }',
      '-        onLine(obj, lineNo);',
      '+        emit(raw, lineNo);',
      '       }',
      '     },',
      '     flush() {',
      "-      if (tail.trim()) onLine(JSON.parse(tail), ++lineNo);",
      "+      const raw = tail.replace(/\\r$/, '').trim();",
      '+      if (raw) emit(raw, ++lineNo);',
      "       tail = '';",
      '     },',
    ] },
  ];
  const D5 = diff('src/parser.js', H5);
  c = w.toolCall(800, 'patch', { path: 'src/parser.js', mode: 'patch', patch: v4a('src/parser.js', H5) }, { rowId: row, meta: { path: 'src/parser.js', diff: D5 } });
  w.toolResult(700, c, { text: hermes.patch(D5).text, summary: patchedSummary(D5) });
  w.status(400, 'tool', 'editing test/parser.edge.test.mjs');
  const D6 = diff('test/parser.edge.test.mjs', [{ old: 38, new: 38, lines: [
    "   p.push('{\"a\":1}\\r\\n{\"a\":2}\\r\\n');",
    '   assert.equal(out.length, 2);',
    ' });',
    '+',
    "+test('parser: flush() routes a malformed tail through onError', () => {",
    '+  const { p, out, errors } = collect();',
    "+  p.push('{\"a\":1}\\n{nope');",
    '+  p.flush();',
    '+  assert.deepEqual(errors, [2]);',
    '+  assert.equal(out.length, 1);',
    '+});',
  ] }]);
  c = w.toolCall(900, 'patch', { path: 'test/parser.edge.test.mjs', old_string: "  p.push('{\"a\":1}\\r\\n{\"a\":2}\\r\\n');\n  assert.equal(out.length, 2);\n});", new_string: "  p.push('{\"a\":1}\\r\\n{\"a\":2}\\r\\n');\n  assert.equal(out.length, 2);\n});\n\ntest('parser: flush() routes a malformed tail through onError', () => {\n  const { p, out, errors } = collect();\n  p.push('{\"a\":1}\\n{nope');\n  p.flush();\n  assert.deepEqual(errors, [2]);\n  assert.equal(out.length, 1);\n});" }, { meta: { path: 'test/parser.edge.test.mjs', diff: D6 } });
  w.toolResult(600, c, { text: hermes.patch(D6).text, summary: patchedSummary(D6) });
  w.status(500, 'tool', 'running: npm test');
  c = w.toolCall(1000, 'terminal', { command: 'npm test 2>&1 | tail -12', timeout: 120 });
  w.toolResult(2500, c, { text: hermes.terminal(passOut(14, 124.3)).text, summary: '→ exit 0 · 14 tests pass', meta: { command: c.args.command, exitCode: 0 } });
  c = w.toolCall(1500, 'terminal', { command: 'git diff --stat' });
  w.toolResult(700, c, { text: hermes.terminal(' server/sources/fixture.js    |  4 +++-\n src/parser.js                | 33 +++++++++++++++++++++------------\n test/parser.edge.test.mjs    | 49 +++++++++++++++++++++++++++++++++++\n 3 files changed, 73 insertions(+), 13 deletions(-)\n').text, summary: '→ 3 files changed, 73 insertions(+), 13 deletions(-)', meta: { command: 'git diff --stat', exitCode: 0 } });
  w.status(800, 'responding', 'responding');
  w.assistant(1200, `Done.

**Root cause** — \`src/parser.js\` looped \`i < lines.length - 1\` after \`lines.pop()\` had already removed the partial line, so the last complete line of every chunk was dropped. The regression only showed when a chunk ended exactly on a newline, which is what the streaming change started producing.

**Changes**
- \`src/parser.js\`: correct bound; guarded \`emit()\` shared by \`push()\` and \`flush()\` (\`onError(err, lineNo)\`, rethrow without a handler); CRLF tolerated.
- \`test/parser.edge.test.mjs\`: 5 new tests (split chunks, blank lines, malformed line, CRLF, malformed tail).
- \`server/sources/fixture.js\`: opts into \`onError\` so a bad fixture line is logged and skipped.

**Tests**: 14 passing. The hub is untouched.`, { id: row, stream: { lo: 30, hi: 60, dtLo: 30, dtHi: 70 } });
  w.status(700, 'idle', 'idle');
  return [w];
}
