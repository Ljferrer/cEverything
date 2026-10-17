# fixtures/ — recorded scenarios for `--source fixture`

Hand-authored Hermes sessions replayed by `server/sources/fixture.js` so the demo never depends on a live model, an
API key or venue Wi-Fi. Format: docs/PROTOCOL.md §3 — one event per line (`event` minus `t`/`seq`/`ts`, plus `dt` = ms
since the previous line **of the same file**), first line `session.upsert` with `dt: 0`, plus `layout.json` and
`pylons.json`. No real credentials, no personal data; the one key-shaped string in `raw/` is a deliberately fake
`sk-FAKE…` value so the normalizer's redaction test has something to redact.

## Replay

```
npm start                                   # fixtures/demo at speed 4, looping
node server/index.js --fixture fixtures/demo --speed 1 --no-loop
node fixtures/validate.mjs fixtures/demo    # JSON.parse every line, check §2/§3 shapes, demo expectations, raw/*.json
```

The replayer merges all `*.jsonl` of a scenario by absolute offset (sum of `dt`), sleeps `dt / speed`, and loops with
fresh id suffixes when every file is exhausted. The demo scenario plays ≈ 241 s at speed 1 (≈ 60 s at the default speed 4).
Laptop keys 1–5 fire the demo cues; R resets to the start state.

## Regenerating

The `.jsonl` files are **generated**, not hand-edited: `node fixtures/demo/_authoring/build.mjs` rewrites
`fixtures/demo/*.jsonl`, `layout.json`, `pylons.json` and `fixtures/raw/hermes-export-sample.json` deterministically
(seeded RNG for chunk sizes and small jitters). Edit the per-session scripts in `fixtures/demo/_authoring/` (one per
session, `lib.mjs` holds the builder, categories, glyphs and summary rules), re-run the build, then run the validator.
A `pace` option per session stretches the authored gaps without touching the small `tool.start` / `message.delta` jitter.

## The demo scenario (`fixtures/demo`)

| file | session | what it shows |
|---|---|---|
| `s_research.jsonl` | **research-webxr** · claude-sonnet-4-5 | A user asks how Vision Pro Safari delivers WebXR input. 12 web tool calls (`web_search`, `web_extract`, `browser_navigate` to webkit.org, developer.apple.com, github.com/mrdoob/three.js, developers.meta.com, immersive-web.github.io) fire amber packets at the **browser pylon**; the streamed final answer explains transient-pointer indices 0/1 vs **2/3** with hand tracking. Two follow-ups (carry-at-distance ray, mic survival) and a `memory` write. ≈ 241 s, 37 messages. |
| `s_fix.jsonl` | **fix-parser-tests** · gpt-5 | Classic coding loop: `npm test` fails (real `node --test` output), `read_file src/parser.js`, `patch` with a real unified diff fixing an off-by-one (`lines.length - 1`), tests pass, a new test file via `write_file`, an `onError` guard, a follow-up refactor. **Six `tool.complete` events carry `meta.diff`** (five patches with +/− lines, one new file) → file-tree flashes + diff cards. ≈ 237 s, 43 messages. |
| `s_deploy.jsonl` | **deploy-staging** · claude-opus-4-1 | Ten `terminal` commands (git status/log, `npm test`, Playwright smoke, `docker build`, `docker push`, `git fetch`) send green packets to the **terminal pylon**; origin/main has diverged, so the session parks at `waiting_on_you` with `attention {kind:"approval", text:"Run: git push origin main --force? (y/n)"}`. The file ends there (≈ 119 s); `approve` resumes it via the replayer's scripted continuation. 26 messages. |
| `s_think.jsonl` | **long-think** · hermes-4-405b | "Design the consistency model for the shared scene." Four thinking messages of 1.3–2.3k chars each, **streamed via `message.delta` in 20–60 char chunks at 30–80 ms**, then a streamed assistant answer (seq ordering, idempotent ids, deltas heal at `message.complete`, carried object is the only prediction); one `read_file`, one `memory`. Big violet tiles. ≈ 240 s, 12 messages / 274 events. |
| `s_orch.jsonl` + `s_orch_child.jsonl` | **orchestrator** · claude-sonnet-4-5 → **subagent · filetree.js** (`parentId: "s_orch"`) | The parent reads the spec, plans with `todo_list`, and calls `delegate_task` twice (lazy file tree, then the diff card). While each call is in flight the child column (placed next to its parent in `layout.json`) wakes up and does `read_file` / `patch` / `terminal node --check` work with real diffs on `web/scene/filetree.js`; the result flows back as the parent's `tool_result`, and the parent writes a standup summary. The child ends `done`. ≈ 166 s, 44 messages across both. |
| `s_readme.jsonl` | **write-readme** · gemini-2.5-pro | A finished session: **92 messages** (13 short user/assistant beats with `read_file`, `write_file`, `patch`, `search_files`, `terminal`, `memory`, `todo_list`), the first ~70 arriving fast so the column shoots up at scenario start — this is the session that exceeds 60 tiles and exercises the spire / "+N earlier" path. Ends with `session.status done` + `attention {kind:"done"}`. ≈ 126 s. |

`layout.json`: the five main sessions on the 1.8 m front arc (−60°, −30°, 0°, +30°, +60°: long-think, research, fix, deploy,
orchestrator), the child at r 2.6 next to its parent, write-readme on the second arc at 11.25°. `rot = −θ` so every column
faces the origin. `pylons.json`: browser (−2.5, −1.0), terminal (+2.5, −1.0), files (0, −3.2) as in PROTOCOL.md §5.

### Conventions used in the files

- ids: rows `s_fix:m12`; thinking `<rowId>:r` (emitted before its assistant text); tool calls `<rowId>:c1`, `c2` …;
  `tool.start`/`tool.complete.messageId` = the tool_call message id; `tool_result.parentMessageId` → the tool_call.
  `tool.complete` additionally carries the optional `resultMessageId` (the tool_result message id).
- Every `tool_call` is followed by `tool.start` (30–90 ms); every call gets a `tool_result` message then `tool.complete`
  (20–60 ms) with `durationMs` = fixture time between them. `meta` keys are limited to ToolMeta (`path diff url query command exitCode`).
- Categories/targets per PROTOCOL §2.3 (terminal → coding/terminal; read_file/write_file/patch/search_files → files/files;
  web_* / browser_* → web/browser; memory → memory/self; delegate_task → delegating/self; todo_list → tools/self).
- Glyphs: `U` user, `A` assistant, `✎` thinking, `🔍` web, `📁` read/search, `✎` patch/write, `>_` terminal, `🧠` memory,
  `⇄` delegate, `⚑` clarify, `⚙` other tools; a tool_result reuses its call's glyph.
- Summaries ≤ 100 chars: first sentence for text; `web_search "query"`, `patch src/parser.js (+9 −3)`, `$ npm test`,
  `read_file path`, `delegate_task "goal…"` for calls; `→ …` / `✗ …` one-liners for results.
- `session.status` only when the state changes (thinking → tool → responding → idle); `activity` strings like
  `browsing: webkit.org`, `editing src/parser.js`, `running: npm test`, `waiting for approval`.
- Counts in `session.upsert` are zero on purpose: `server/state.js` recomputes them. The child's `session.upsert`
  (dt 0) exists from scenario start as an idle column until the parent delegates at ≈ 51 s (second delegation ≈ 122 s).
- Streamed messages: `message.add {streaming:true, text:""}` → `message.delta` chunks → `message.complete {text}` with
  the full text so lost chunks heal. The `summary` on the `message.add` is already the final one.

## `raw/hermes-export-sample.json`

One Hermes `GET /api/sessions/{id}/export`-shaped object (`{...sessionRow, messages:[rows]}`) with 20 rows for
`test/normalize.test.mjs`: a system row, assistant rows with `reasoning`/`reasoning_content`, an assistant row whose
`tool_calls` **JSON string** holds two calls (`patch` + `web_search`) with empty content (→ no assistant tile), matching
`role:"tool"` rows keyed by `tool_call_id`/`tool_name` (terminal, read_file, patch, web_search, memory), and a terminal
output containing a fake `sk-…` token for the redaction test. Row columns follow the SQLite `messages` table
(`id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason, reasoning,
reasoning_content, reasoning_details, display_kind, display_metadata, active, compacted`).

## Adding a scenario

Create `fixtures/<name>/` with `*.jsonl` (one per session, file stem = session id), `layout.json`, `pylons.json`, then
`node fixtures/validate.mjs fixtures/<name>` and `node server/index.js --fixture fixtures/<name>`. Real Hermes sessions
convert with `scripts/export-to-fixture.mjs` (via `server/sources/normalize.js`); scrub secrets first.
