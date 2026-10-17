# PROTOCOL.md — cEverything wire protocol, fixture format and repo layout (v1)

Binding contract between `server/` and `web/`. Builders follow it exactly; when something is missing, keep the wire
shapes below and add **optional** fields. DESIGN.md is the design authority; this file wins on wire shapes and numbers.

## 1. Repo layout (Node 22, plain ES modules, no bundler, no TypeScript)

```
package.json                deps: three@0.170.0, ws@8.18.0, qrcode-terminal@0.12.0; dev: playwright@1.56.1
server/
  index.js                  CLI: node server/index.js [--port 8787] [--host 0.0.0.0] [--tls] [--source fixture|hermes]
                            [--fixture fixtures/demo] [--speed 4] [--no-loop] [--public-url https://…]
                            prints the LAN + public URLs and a QR code (qrcode-terminal) at startup
  http.js                   static server: web/ at /, node_modules/three at /vendor/three/, correct MIME types, no caching in dev
  hub.js                    WebSocket hub at /ws: clients, hello/snapshot, join{lastSeq} resume from a 5000-event ring buffer,
                            command routing, presence throttle (≤10 Hz per client, drop under backpressure), broadcast
  state.js                  pure reducers over canonical state (sessions, messages ≤400/session, layout, pylons); snapshot()
  protocol.js               event/command kind lists + validate(frame) (also served to the browser as /shared/protocol.js via web/shared symlink or copy)
  sources/normalize.js      PURE: Hermes session row + message rows (export/REST shape) → normalized Sessions/Messages/events; tool categories; summary + glyph; secret redaction
  sources/fixture.js        replays fixtures/<scenario>/*.jsonl merged by time at --speed, loops; implements commands (send/pipe/fork/new/approve/interrupt) with scripted replies; demo cues; reset
  sources/hermes.js         live adapter: polls dashboard REST, diffs by row id, feeds normalize.js; optional /api/ws token streaming; writes via API server; graceful degradation
  stt/index.js              picks engine from env: ASSEMBLYAI_API_KEY → assemblyai.js, else null.js (emits voice.unavailable)
  stt/assemblyai.js         one upstream realtime WS per talking client (wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&format_turns=true), PCM16 passthrough, Turn → transcript frames
  stt/null.js
  tls.js                    --tls: load certs/server.{key,crt} or generate with openssl (SAN = LAN IP + localhost)
web/
  index.html                import map {"three": "/vendor/three/build/three.module.js", "three/addons/": "/vendor/three/examples/jsm/"};
                            2D landing: giant ENTER button (XR) / "Open on laptop" , connection + mic status badges, QR of this URL
  main.js                   boot: renderer (xr.enabled), scene, camera, device detection, modules wiring, animation loop, query flags
  net.js                    reconnecting WS client (0.5→8 s backoff), lastSeq resume, applies frames to store, event bus
  store.js                  client mirror of canonical state (pure data + indexes: tiles by id, sessions by id)
  shared/protocol.js        same file as server/protocol.js (copied by a tiny build-free trick: server serves server/protocol.js at /shared/protocol.js)
  text/canvas-text.js       word-wrap + measure, CanvasTexture factory, LRU cache (96), system fonts only, sRGB, mipmaps
  scene/room.js             floor grid, honesty floor label, legend sprite, lights, reading-height anchor, recenter
  scene/column.js           Column: base plate, status ring, glance panel, tile stack (fixed pitch), spire, scroll offset, summon state
  scene/tiles.js            tile pools: far = InstancedMesh bars (color only); mid/near = pooled textured planes; LOD assignment at 5 Hz with hysteresis
  scene/pylons.js           browser / terminal / files pylons, packet tween (Bezier), flashes, last-command screen, query sprite
  scene/filetree.js         path → tree of boxes (lazy), diff card on patch/write_file, touched-count badge
  scene/fx.js               tiny tween helper; pipe arc, fork ghost, lineage dashed lines, grow animation
  scene/presence.js         remote participants: head cone, hand spheres, gaze ray, laptop camera pyramid, hover outline
  scene/detail.js           pinned detail plane (full text / args / diff) opened by select
  input/xr.js               controllers 0..3 (created before session start), optional hands, session-level select events, rays as Lines,
                            head ray, tap-vs-drag state machine, grab/carry/drop (pipe, fork, move), summon, scroll, push-to-talk
  input/desktop.js          OrbitControls, hover/click/drag (floor plane), keys (see §6), top-down view, spectator follow
  input/voice.js            engines: browser Web Speech (if present) | server (getUserMedia → AudioWorklet pcm16 16 kHz → audio frames) | none; pending tile + countdown
  input/pcm-worklet.js      AudioWorkletProcessor: downsample to 16 kHz, PCM16, 100 ms frames, RMS
  ui/hud.js                 desktop DOM: session list (status dots, activity), focused transcript, compose box, approval card, fixture controls, mode badge, help
  ui/debug3d.js             in-room console canvas (last 8 log lines + input-source index/targetRayMode), toggled by ?debug=1 / key D
fixtures/
  demo/                     the default scenario: 6+ sessions (*.jsonl), layout.json, pylons.json, README.md (what each session shows)
  raw/                      1–2 Hermes export-shaped JSON files ({...session, messages:[rows]}) used by test/normalize.test.mjs
scripts/
  make-cert.sh              openssl self-signed cert with SAN (LAN IP)
  export-to-fixture.mjs     converts a Hermes /api/sessions/{id}/export JSON into fixtures/<scenario>/<id>.jsonl via normalize.js
test/
  protocol.test.mjs         node:test — hub handshake (hello, snapshot), join resume, fixture replay emits events, commands (send/pipe/fork/move) produce the right events, validate()
  normalize.test.mjs        node:test — Hermes rows → thinking/assistant/tool_call/tool_result split, categories, summaries, redaction
  smoke.mjs                 starts the server in fixture mode on a random port, opens / in headless Chromium (playwright), waits for ≥ 6 columns, asserts zero console errors, saves test-results/desktop.png and test-results/topdown.png
docs/
  CONTEXT.md DESIGN.md PROTOCOL.md MOLTEN_STRATEGY.md RUNBOOK.md
```

## 2. Transport

- One WebSocket endpoint `/ws`. JSON text frames, one envelope per frame. Binary frames are **not** used (audio travels as base64 inside JSON for simplicity).
- Connect sequence: client → `{t:"join", device, name, lastSeq?}`; server → `hello`, then either `snapshot` (new client or gap too large) or a replay of `event` frames with `seq > lastSeq`, then live frames.
- Every state change is a server `event` with a monotonic `seq`. Clients never mutate shared state locally except the object they are carrying (local prediction); they send a command and apply the resulting events like everyone else.
- Per-viewer local view state (summon, scroll offset, detail plane, LOD) is never sent.

### 2.1 Server → client frames

```jsonc
{ "t": "hello", "clientId": "c_ab12", "serverTime": 1760700000000, "source": "fixture"|"hermes",
  "sourceInfo": { "label": "FIXTURE REPLAY"|"LIVE: hermes@127.0.0.1", "speed": 4, "paused": false, "scenario": "demo" },
  "voice": { "engine": "assemblyai"|"none" }, "latestSeq": 1234 }

{ "t": "snapshot", "seq": 1234, "sessions": [Session...], "messages": { "<sessionId>": [Message...] },
  "layout": { "<sessionId>": Placement }, "pylons": [Pylon...], "presence": [Presence...] }

{ "t": "event", "seq": 1235, "ts": 1760700000123, "sessionId": "s1", "kind": "<kind>", ...fields }

{ "t": "presence", ...Presence }                    // relayed ≤ 10 Hz per client; not in the ring buffer
{ "t": "presence.left", "clientId": "c_ab12" }
{ "t": "transcript", "clientId": "c_ab12", "sessionId": "s1", "text": "yes go ahead", "final": false }   // live STT text, any engine
{ "t": "voice.unavailable", "reason": "no ASSEMBLYAI_API_KEY" }
{ "t": "source", "sourceInfo": {...} }              // fixture paused/speed/reset changed
{ "t": "ack", "inReplyTo": "cmd_17", "ok": true, "result"?: {...} }
{ "t": "error", "inReplyTo": "cmd_17", "code": "bad_command"|"unknown_session"|"source_unavailable"|"not_supported", "message": "..." }
```

### 2.2 Event kinds

| kind | fields besides `sessionId` | meaning / client reaction |
|---|---|---|
| `session.upsert` | `session: Session` | new or changed session metadata → create/update column, glance panel |
| `session.remove` | — | archived/deleted → fade column out |
| `session.status` | `status: SessionStatus, activity?: string, attention?: Attention | null` | state machine change → ring/beacon; `attention` set ⇔ status `waiting_on_you` |
| `message.add` | `message: Message` | append a tile (newest at reading height; stack shifts up one pitch with a 300 ms ease). `message.streaming === true` means text will grow |
| `message.delta` | `messageId, text` | append text to a streaming `assistant` or `thinking` message |
| `message.complete` | `messageId, text?` | finalize (replace text if given); clears streaming pulse |
| `tool.start` | `messageId, callId, name, category, args, preview, target: PylonKind` | fires the packet tile → pylon; sets session `currentTool` |
| `tool.complete` | `messageId, callId, name, ok, durationMs, preview, meta?: ToolMeta` | packet back; file-tree flash + diff card when `meta.diff` |
| `layout.column` | `placement: Placement, by?: clientId` | column slides to the new floor position (400 ms) |
| `fork` | `fromSessionId, newSessionId, atMessageId?` | draw dashed lineage line parent→child; fork ghost animation |
| `pipe` | `fromSessionId, fromMessageId, toSessionId, newMessageId` | cyan arc source tile → target base, then the new user tile grows |
| `pylons` | `pylons: Pylon[]` | pylon placement changed (rare) |

### 2.3 Value types

```ts
type SessionStatus = "idle" | "thinking" | "responding" | "tool" | "waiting_on_you" | "done" | "error"
type Role = "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "system"
type Category = "web" | "files" | "coding" | "memory" | "delegating" | "images" | "messaging" | "waiting" | "tools"
type PylonKind = "browser" | "files" | "terminal" | "self"        // "self" = no pylon; flash on the column's own base
type Device = "visionpro" | "quest" | "desktop" | "phone" | "unknown"

interface Session {
  id: string; title: string; status: SessionStatus; model?: string; cwd?: string; gitBranch?: string;
  parentId?: string | null; endReason?: string | null;
  startedAt: number; lastActivityAt: number; activity: string;          // activity: "browsing: developer.apple.com", "editing src/hub.js", "waiting for approval 02:10"
  counts: { messages: number; toolCalls: number; byCategory: Record<Category, number> };
  toolHistory: Category[];                                             // last 8 tool categories, oldest first
  currentTool?: { callId: string; name: string; category: Category; since: number } | null;
  summary: string;                                                     // ≤ 80 chars for the far glance (first user message, trimmed)
  attention?: Attention | null;
}
interface Attention { kind: "approval" | "clarify" | "done" | "error"; text: string; requestId?: string; since: number }

interface Message {
  id: string; sessionId: string; role: Role; ts: number;
  text: string;                       // full content (assistant text, user text, thinking text, tool result text)
  summary: string;                    // ≤ 100 chars: first sentence; tool_call → `web_search "visionOS webxr"`, `patch src/hub.js (+12 −3)`, `$ npm test`
  glyph: string;                      // 1–2 chars: U A ✎(thinking) 🔍 ✎ >_ 📁 🧠 ⇄ ⚑
  streaming?: boolean;
  tool?: { callId: string; name: string; category: Category; target: PylonKind; args?: object; preview?: string;
           ok?: boolean; durationMs?: number; meta?: ToolMeta };
  parentMessageId?: string;           // tool_result → its tool_call message; thinking → the assistant message it belongs to
  via?: "voice" | "keyboard" | "pipe" | "agent" | "replay";
  from?: { sessionId: string; messageId: string };                      // set on piped user messages
  tokens?: number;
}
interface ToolMeta { path?: string; diff?: string /* unified */; url?: string; query?: string; command?: string; exitCode?: number }

interface Placement { sessionId: string; x: number; z: number; rot: number }   // meters on the floor; rot = yaw radians (0 faces +z toward the origin side)
interface Pylon { kind: PylonKind; x: number; z: number; label: string }
interface Presence { clientId: string; device: Device; name: string; head?: { p: [number,number,number]; q: [number,number,number,number] };
                     hands?: [{ p: [number,number,number] } | null, { p: [number,number,number] } | null];
                     gazeSessionId?: string | null; hover?: { sessionId: string; messageId?: string } | null; ray?: { o: [number,number,number]; d: [number,number,number] } | null }
```

Thinking is its **own Message** (`role: "thinking"`, id `<assistantRowId>:r`) emitted **before** the assistant text message it
produced. Each entry of an assistant row's `tool_calls` is its own `tool_call` Message (id `<rowId>:<callId>`), followed by
`tool.start`; its `role:"tool"` result row becomes a `tool_result` Message (id = the tool row id) plus `tool.complete`.
An assistant row with empty content and tool_calls produces no assistant text tile.

Category rules (bighelp mapping): terminal/execute_code/process_manage → `coding` (target terminal); read_file/write_file/patch/
search_files → `files` (target files); web_search/web_extract/browser_* → `web` (target browser); memory/session_search/skill_* →
`memory` (self); delegate_task → `delegating` (self; the child session, when it appears with `parentId`, is placed next to the
parent); image_*/vision_*/video_* → `images` (self); send_message/text_to_speech → `messaging` (self); clarify → `waiting`
(self + attention); else `tools` (self).

Status derivation (live adapter): ended_at set → `done` (or `error` if end_reason mentions error/fail); an open approval/clarify
→ `waiting_on_you`; is_active and the newest row is a tool_call without result → `tool`; newest row is assistant streaming →
`responding`; newest row is user (agent hasn't answered yet) → `thinking`; otherwise `idle`.

### 2.4 Client → server commands

```jsonc
{ "t": "command", "id": "cmd_17", "name": "<name>", ...fields }
```

| name | fields | effect |
|---|---|---|
| `send` | `sessionId, text, via: "voice"|"keyboard", from?` | user message into a session → `message.add` (user) then the source answers (fixture: scripted reply; hermes: API server chat) |
| `pipe` | `fromSessionId, fromMessageId, toSessionId` | server composes `[from <title>]: <text>` and performs a `send` with `via:"pipe"` + emits `pipe` |
| `fork` | `sessionId, atMessageId?, x?, z?, title?` | fork (fixture: clone messages up to atMessageId; hermes: POST /api/sessions/{id}/fork, parent ends as "branched") → `session.upsert` + `layout.column` + `fork` |
| `new` | `title?, x?, z?` | create an empty session |
| `layout.move` | `sessionId, x, z, rot` | → `layout.column` to everyone |
| `approve` | `sessionId, requestId?, allow: boolean` | resolves `waiting_on_you` (fixture: scripted continue; hermes: answers the approval if a stream is open, else sends "yes"/"no") |
| `interrupt` | `sessionId` | stop the running turn (fixture: status idle; hermes: not supported over REST → `error not_supported`) |
| `presence` | `head?, hands?, gazeSessionId?, hover?, ray?` | ≤ 10 Hz; rebroadcast as `presence` |
| `audio.start` | `sessionId, sampleRate: 16000` | begin a push-to-talk utterance targeted at a session |
| `audio.chunk` | `data: base64 PCM16 LE mono` | 100 ms frames |
| `audio.stop` | — | end utterance; the engine's final transcript is broadcast as `transcript{final:true}`; the **client** then decides to `send` after its countdown |
| `voice.text` | `sessionId, text, final` | desktop Web Speech result relayed so others see the live transcript (`transcript`) |
| `fixture.control` | `action: "pause"|"play"|"speed"|"reset"|"cue", value?` | fixture only; `cue` values: `needs_you`, `web_burst`, `patch`, `delegate`, `done` (with optional `sessionId`) |

Every command gets an `ack` or `error` with `inReplyTo`.

## 3. Fixture format

`fixtures/<scenario>/<sessionId>.jsonl`: one JSON object per line, in time order, exactly an `event` minus `t`/`seq`/`ts`, plus
`dt` = milliseconds since the previous line **of the same file** (the replayer sleeps `dt / speed`). First line must be
`{"dt":0,"sessionId":"…","kind":"session.upsert","session":{…}}`. `fixtures/<scenario>/layout.json` =
`{ "<sessionId>": {"x":…,"z":…,"rot":…} }`; `pylons.json` = `[{"kind":"browser","x":-2.5,"z":-1.0,"label":"web"}, …]`.
The replayer merges files by absolute offset, loops when all are exhausted (re-emitting fresh ids with a suffix so columns keep
growing), honours pause/speed/reset, and reacts to `send` with a scripted reply (thinking → assistant → one tool call + result
drawn from that session's own history), to `approve` by resuming a `waiting_on_you` session, to `fork` by cloning, and to cues.

The default scenario `fixtures/demo` has at least six sessions with distinct personalities and realistic Hermes text (no lorem ipsum):
`research-webxr` (web_search/web_extract bursts), `fix-parser-tests` (read_file/patch/terminal with real unified diffs),
`deploy-staging` (parked at an approval → waiting_on_you), `long-think` (large violet thinking blocks), `orchestrator`
(delegate_task spawning a child session with parentId), `write-readme` (finished, status done). One session should exceed 80
messages so the spire / "+N earlier" path is exercised.

## 4. Hermes live adapter (server/sources/hermes.js)

Env: `HERMES_DASHBOARD=http://127.0.0.1:9119`, `HERMES_API=http://127.0.0.1:8642`, `HERMES_API_KEY`, `HERMES_PROFILE?`.
Read: `GET /api/sessions?order=recent&limit=12` at 1 Hz → `session.upsert`/`session.status`; for each listed session
`GET /api/sessions/{id}/messages?order=latest&limit=60` at 1 Hz (stagger), diff by row `id`, run `normalize.js`, emit
`message.add` + `tool.start`/`tool.complete`. Optional `ws://…/api/ws` (loopback, no ticket): after `gateway.ready` send
`client.capabilities {server_requests:false}`, then map `event` notifications `message.delta`/`reasoning.delta` → `message.delta`
on `<sid>:live` / `<sid>:live:r` streaming messages, `tool.start`/`tool.complete` → the same kinds. On any failure the adapter
logs once, keeps polling, and sets `sourceInfo.label = "LIVE (polling only)"`. Writes: `send` → `POST /api/sessions/{id}/chat`
`{message}`; `fork` → `POST /api/sessions/{id}/fork`; `new` → `POST /api/sessions`. No API key → `error source_unavailable`
and the HUD says so; **never fake a reply in live mode**. Redact secrets (`sk-[A-Za-z0-9]{10,}`, `AKIA[0-9A-Z]{16}`,
`ghp_[A-Za-z0-9]{20,}`, `xox[baprs]-…`, `-----BEGIN … PRIVATE KEY-----`) in any text before it leaves the server.

## 5. Rendering rules (web/)

- Units: meters; +y up; origin = the headset's `local-floor` origin; the user starts at (0,0,0) facing −z. Reading height 1.3 m
  (recenter: key C / floor pinch-hold sets reading height = head height − 0.3).
- Layout defaults when `layout.json` is absent: sessions 1–5 on a front arc r = 1.8 m at −60°,−30°,0°,30°,60° (angle measured
  from −z toward +x); 6–10 on r = 2.6 m at 22.5° steps offset 11.25°. `?scale=0.66` scales x/z for small booths. Columns face the origin.
- Column: base plate 0.40×0.05×0.40 wire box; status ring r 0.25 (idle white 40 %; thinking violet pulse; responding cyan rotate;
  tool amber rotate; waiting_on_you red scale-pulse 1 Hz; done green steady; error red steady). Glance panel: title sprite
  (title · model) at y 1.15, activity sprite at y 1.05, tool-history row of eight 0.04 m cubes at y 0.90, counts at y 0.75.
  Beacon for `waiting_on_you`: red octahedron at y 2.6 bobbing, visible from anywhere.
- Tile stack: fixed pitch 0.14 m (tile 0.36 w × 0.12 h × 0.02 d). Newest tile at reading height; older tiles stack upward
  (the column into the sky). On `message.add`, existing tiles translate up one pitch over 300 ms (ease-out-cubic). Only the newest
  60 tiles exist as objects; a thin spire line rises to y 30 with a "+N earlier" sprite; pull-to-scroll shifts the 60-tile window.
- LOD per tile by Euclidean head→tile distance, recomputed at 5 Hz with 0.15 m hysteresis; thresholds per device:
  quest/desktop: full < 1.2 m, summary 1.2–3.0 m, glyph > 3.0 m; visionpro: full < 0.9, summary 0.9–2.0, glyph > 2.0.
  glyph = InstancedMesh bar (color only, one draw call for all columns, capacity 4000); summary = pooled 512×128 canvas plane
  (role glyph + summary); full = pooled 512×192 canvas plane (3 wrapped lines ≈ 130 chars + "…"). Pools: 48 summary, 12 full.
  Textures redraw only when (messageId, lod) changes. Select opens the detail plane with the complete text.
- Colors: user #FFFFFF, assistant #38BDF8, thinking #A78BFA at 60 % opacity with dashed outline, tool_call #F59E0B with a
  category chip on the left edge, tool_result #B45309 outline, system #6B7280, error #EF4444. Category chips: coding #22C55E,
  web #F59E0B, files #14B8A6, memory #EC4899, delegating #FB923C, images #D946EF, messaging #3B82F6, waiting #EF4444, tools #9CA3AF.
  Streaming tile pulses emissive at 0.5 Hz. Laptop hover = blue #3B82F6 wire outline. Gazed column (head ray, 200 ms dwell) = base brightens.
- Pylons (defaults): browser (−2.5, 0, −1.0) octagonal prism 2.2 m with a wire sphere on top; terminal (+2.5, 0, −1.0) wire box
  1.6 m with a "screen" plane showing the last command; files (0, 0, −3.2) tree of boxes built lazily from paths seen in file tools
  (max 4 levels / 40 nodes) with a diff card (0.8×0.5 plane; `+` green, `−` red, max 24 lines, 8 s). Packet: 0.05 m cube along a
  quadratic Bezier (control = midpoint + 1 m up), 600 ms out on `tool.start`, 600 ms back on `tool.complete`.
- Presence: headset = wire cone at head + 0.03 m hand spheres + 2 m dotted gaze ray; laptop = wire camera pyramid; laptop hover
  outline on the tile. Lineage: dashed line base→base for forks; pipe arc animation from `pipe` events.
- Honesty label on the floor at (0, 0.01, −0.8) reading `sourceInfo.label`; legend sprite at (−0.9, 1.0, −1.2).
- Performance budget: ≤ 10 columns, ≤ 600 live tiles, ≤ 60 textured planes, 3 pylons, 40 tree nodes; MeshBasicMaterial only,
  no shadows, `renderer.xr.setFramebufferScaleFactor(0.9)`; target 72 fps on Quest 3S.

## 6. Input mapping

| action | Vision Pro | Quest (hands / controllers) | Laptop |
|---|---|---|---|
| focus / inspect tile | gaze + pinch (select) → detail plane | pinch / trigger on tile | click |
| pipe | pinch-hold tile, carry, release over another column (0.5 m radius) | same | drag tile onto column, or select + P + click |
| fork | pinch-hold title plate, pull > 0.5 m sideways, release | same | F on selected column (lands 0.8 m right) |
| move column | pinch-hold base, drag on floor | same | drag base; T = top-down view |
| summon (local) | pinch-hold base 0.6 s without moving | same | S (or double-click column) |
| scroll history (local) | pinch-hold stack, move vertically | same; thumbstick | mouse wheel over column; Home |
| push-to-talk | left pinch while left ray hits mic sphere/nothing | left pinch / left squeeze | hold Space |
| approve | look at the red column, say "yes, go ahead" (voice) or select the beacon → approve | same | Approve/Deny buttons |
| recenter height | pinch-hold floor 1 s | same | C |
| other keys | — | — | Enter send · Shift+Enter newline · 1–5 cues · R reset · D debug · V spectator · Esc close detail |

XR input rules: create controllers 0..3 before the session starts and listen on all of them; also listen on the XRSession
(`selectstart/select/selectend/squeezestart/squeezeend`) and resolve the ray from `inputSource.targetRaySpace` via
`frame.getPose`; the select ray at `selectstart` is the targeting truth (Vision Pro eye gaze); tap vs drag = < 250 ms and < 3 cm.
Do not request `hand-tracking` on Vision Pro unless `?hands=1`; on Quest request it as optional. Never import
XRControllerModelFactory or XRHandModelFactory('mesh'). Draw rays as `Line`s, hands as spheres. Request the mic
(`getUserMedia`) and probe Web Speech on the 2D page **before** entering XR; keep the stream alive.
