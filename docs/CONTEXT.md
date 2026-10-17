# CONTEXT: cEverything — "AI Harness in VR" for the MOLTEN hackathon

This file is the single briefing for every agent working on this project. Read all of it.

## 0. The ask (verbatim intent from the user, Lukas)

- Going to the MOLTEN hackathon (one day, Sat Oct 17 2026, Inglewood CA). Submitting to the **Open** track,
  answering the open question: **"How do you build together when one person has a headset and the other a laptop?"**
- Wants something similar to `promptclickrun/bighelp` (an iPhone client for Hermes agents that shows what each
  agent is doing: avatars with live status, chat, tool activity, approvals, voice) — but **for the Hermes agent in VR**.
- Hardware available at the venue: **one Apple Vision Pro** and **one Meta Quest 3S** (bookable 30-min slots before 1 PM,
  up to 2 h after 1 PM; must be reserved in the portal). The user's laptop is the other device.
- Feature wishes (functional wireframes first; visual polish later):
  1. See the **full chain of the LLM harness as a column extending into the sky** (each message a tile stacked upward).
  2. **Distance-based level of detail**: close = full-fidelity message; farther = summary; farther still = more summarized / glyph.
  3. **Visualize tool calls**: a web search shoots an animation out to a "browser pylon"; a code edit shows the diff in a
     3D file-structure (tree) object.
  4. **Thinking blocks** rendered in a different color from user messages (and from assistant text and tool calls).
  5. **Speak to give input** (voice as a body input).
  6. Solve "5–10 chats open at once, tabs are insufficient": **each chat gets a location in the room**; at a glance see what
     tool calls it made and what it is working on; **pipe a message from one chat into another**; **fork a session** into a new one easily.
  7. "I just want to be able to SEE what is going on in VR." Functional wireframes only.

## 1. Hackathon facts (from the organizers' agent brief at https://moltenhack.com/agents.md)

- Hacking runs **10:30 AM – 6:30 PM** Pacific. Submissions due **6:30 PM**. Demo expo 6:30–8:00 PM at tables; judges visit each table. Awards 8:00 PM.
- Teams of 2–4. ~90 students/recent grads. Organizers: Sissi Wang, Iana Lin (UC Berkeley).
- **Rules that matter**: every submission ships a spatial output (Vision Pro, Quest, Spectacles, WebXR, or phone AR);
  at least one body input beyond keyboard and mouse (two or more earn bonus points); **no slides in the demo video**;
  **"All code is written during the event. Credit any template, library or reused work."**; consent statement per member.
- Organizers tell agents: "Do not fill in the submission form for the team" and "Do not hand a team a ready-made answer".
- Submission form fields: team name; project name; what it does + problem (1–2 sentences); track + sponsor prizes entered;
  spatial output and body inputs; sponsor tools used; demo video link (anyone with link; show it working; under a minute is
  plenty; film through the device or film the person); GitHub repo; per member: name, email, GitHub, LinkedIn.
- **Judging rubric** (5 criteria × 1–5, equal weight; ties → "It works in space"):
  1. It works in space (1 mockup/flat recording … 3 core interaction works with retries … 5 works live, repeatably, in headset)
  2. Made with the body (1 decorative … 3 one body input does real work … 5 two+ body inputs that feel natural together)
  3. A new way to create (1 familiar 2D tool moved into headset … 3 fresh twist … 5 a way of making we have not seen)
  4. Worth making with again (1 no reason to return … 3 we see who it's for … 5 hand it over, we want another go)
  5. It clicks fast (1 couldn't explain it back … 3 get it after full demo … 5 clear in one sentence, shown in seconds)
  Not scored: business model, slides, video production value, team size, number of tools.
- Open track prompts: "How do you build together when one person has a headset and the other a laptop? Most teams will not
  all own headsets. Mixed collaboration, where everyone sees and edits the same space from different devices, is rough
  everywhere." Start from: WebXR with three.js, Miro, Reality Composer.
- Sponsor tools relevant to us: **AssemblyAI** (speech-to-text for voice input; credits ~$50/participant), **ElevenLabs**
  (TTS, one month Creator; a sponsor prize exists), **Miro** (Open track; plan on a shared board), **Auki posemesh** (shared
  room coordinates across devices via QR portals), **Pupil Labs Neon** eye trackers (2 units; gaze as input), DataFeel haptics.
  Prizes: grand prize Meta Quest 3S + ElevenLabs Pro; Best Use of ElevenLabs; Best Roboflow; Best DataFeel.
- Hardware desk: morning = try anything (30-min slots); from 1 PM commit + reserve (up to 2 h, one at a time); return by 9 PM.
- "WebXR or phone AR is the safe floor when no headset is free." Judges score in the track entered.

## 2. Platform facts (verified from WebKit/Meta sources and three.js r170 package contents)

- **Apple Vision Pro (visionOS 2+) Safari**: WebXR is **on by default** (no feature flag since visionOS 2). Supports
  `immersive-vr` only (**no `immersive-ar` / passthrough via WebXR**). Input: **transient-pointer** (gaze + pinch; a ray
  appears only while pinching) and optional **hand-tracking** (permission prompt; hands are pose-only, no events). With
  hand tracking on, hands occupy input source indices 0 and 1 and transient pointers appear at **indices 2 and 3** — so code
  must listen for `selectstart/select/selectend` on the XRSession (or on controllers 0..3), not just controller 0/1.
  Video textures can break inside an XR session on visionOS. Web Speech API availability on visionOS Safari is unverified.
- **Meta Quest 3S Browser**: WebXR `immersive-vr` and `immersive-ar` (passthrough) both work; hand tracking + controllers.
  **Web Speech API `SpeechRecognition` is NOT exposed in Quest Browser** (developer reports). `getUserMedia` mic capture
  works → stream audio to a server for STT (AssemblyAI realtime) as the voice path on Quest.
- **WebXR requires a secure context**: `localhost` is fine on the laptop; a headset reaching the laptop over LAN needs
  **HTTPS** (self-signed cert is accepted on Quest with a warning; Safari is stricter) or a tunnel with a real cert
  (cloudflared quick tunnel `cloudflared tunnel --url http://localhost:PORT` → trycloudflare.com URL; ngrok; Tailscale Serve).
- **three.js 0.170.0** (verified on npm/unpkg): `three/addons/webxr/XRButton.js`, `VRButton.js`, `ARButton.js`,
  `XRHandModelFactory.js`, `XRControllerModelFactory.js`, `OculusHandPointerModel.js`, `Text2D.js`.
  `renderer.xr.enabled = true`; `renderer.xr.getController(i)`; `renderer.xr.getHand(i)`; `renderer.setAnimationLoop`.
- Laptop participant: ordinary browser (Chrome) with OrbitControls, mouse/keyboard, and Chrome's Web Speech API
  (`webkitSpeechRecognition`) works there.
- Tooling in this container: Node 22.22, npm 10.9, Playwright 1.56 with Chromium at /opt/pw-browsers (headless testing of
  the desktop view only; WebXR cannot be tested here), openssl, Python 3.13 (Hermes itself cannot be installed here: it
  pins Python 3.14 deps).

## 3. Hermes agent integration facts (verified in NousResearch/hermes-agent source, clone at /home/user/nousresearch/hermes-agent)

Hermes = Nous Research's open-source self-improving agent (Python; MIT). Sessions persist in SQLite `~/.hermes/state.db`
(`get_hermes_home()`; profiles under `~/.hermes/profiles/<name>/state.db`). Three programmatic surfaces:

### 3a. Dashboard REST (`hermes dashboard`, default http://127.0.0.1:9119, loopback = no auth; `--host 0.0.0.0` requires a password/OAuth provider)
- `GET /api/sessions?limit=&offset=&order=recent|created&archived=exclude|include|only&source=&full=0|1`
  → `{sessions:[...], total, limit, offset, storage}`. Session rows include: `id, source, title, model, cwd, git_branch,
  parent_session_id, started_at, ended_at, end_reason, message_count, tool_call_count, input_tokens, output_tokens,
  reasoning_tokens, last_activity_at, last_activity_description, is_active (bool), archived, pinned, profile`.
- `GET /api/sessions/{id}` → session detail. `GET /api/sessions/{id}/messages?limit=&offset=&order=oldest|latest&include_compacted=`
  → `{session_id, profile, messages:[...], pagination}`. Default page is the latest 500.
- `GET /api/sessions/{id}/export` → streamed JSON `{...session, "messages":[...]}` with every row.
- `GET /api/sessions/{id}/timeline`, `/messages/around`, `/latest-descendant`, `PATCH /api/sessions/{id}` (title/flags), `GET /api/sessions/search`.
- `GET /api/status`, `/api/health`, `/api/system/stats`, `/api/profiles`, `/api/analytics/usage`.
- WebSockets: `/api/ws` (TUI-gateway JSON-RPC over WS; needs a single-use ticket when gated), `/api/events?channel=…`
  (notification-only fan-out of the gateway's emits; dashboard sidebar uses it), `/api/pty` (spawns `hermes --tui`).

### 3b. Message row shape (SQLite `messages` table; same keys in REST/export JSON)
`id, session_id, role ("user"|"assistant"|"tool"|"system"), content, tool_call_id, tool_calls (JSON string: OpenAI-style
[{id, type:"function", function:{name, arguments}}]), tool_name, timestamp (unix float), token_count, finish_reason,
reasoning, reasoning_content, reasoning_details (JSON), display_kind, display_metadata (JSON), active, compacted,
message_uid, tool_call_uid`. Reasoning lives in `reasoning` / `reasoning_content` on assistant rows (never in `content`).
Tool results are `role:"tool"` rows with `tool_call_id` + `tool_name` matching the previous assistant row's `tool_calls`.
Common Hermes tool names: `terminal`, `read_file`, `write_file`, `patch`, `web_search`, `web_extract`, `browser_*`,
`delegate_task`, `memory`, `todo`, `skill_*`, `image_generate`, `send_message`.
Session columns also include `cwd`, `git_branch`, `git_repo_root`, `tool_names` (names used), `last_activity_description`.

### 3c. TUI gateway JSON-RPC (stdio, or WS at the dashboard's `/api/ws`)
Methods: `session.create, session.list, session.active_list, session.activate, session.resume, session.history,
session.branch (fork), session.title, session.status, session.usage, session.interrupt, session.steer, prompt.submit
{session_id, text}, prompt.background, command.dispatch {command:"/model …"}, client.capabilities, gateway.capabilities, ping`.
Events streamed (notifications): `gateway.ready, session.info, message.start, message.delta {text}, message.interim,
message.complete {text}, reasoning.delta {text}, thinking.delta, tool.start {name,args…}, tool.generating {name},
tool.complete, subagent.start/thinking/text/tool/complete, notification.show, request.cancel, sessions.changed`.
Server→client requests (approvals etc.): `approval, clarify, sudo, secret …` — answer with a JSON-RPC response; call
`client.capabilities {server_requests:true}` after `gateway.ready` or such requests are auto-failed.
Resume/activate results carry `inflight` (the running turn) and `open_requests`.

### 3d. OpenAI-compatible API server (`API_SERVER_ENABLED=true`, `API_SERVER_KEY=…` in ~/.hermes/.env; `hermes gateway`; http://127.0.0.1:8642; `Authorization: Bearer <key>`)
- `GET /api/sessions` (list), `POST /api/sessions` (create), `GET /api/sessions/{id}`, `GET /api/sessions/{id}/messages`,
  **`POST /api/sessions/{id}/fork` {id?, title?} → 201 {session}** (copies all messages; marks parent as "branched"),
  **`POST /api/sessions/{id}/chat` {message}** (one turn; returns reply) and **`POST /api/sessions/{id}/chat/stream`** (SSE:
  `run.started, message.started, assistant.delta {delta}, tool.progress {tool_name:"_thinking", delta}, tool.started
  {tool_name, preview, args}, tool.completed, tool.failed, assistant.commentary, approval.request, assistant.completed,
  run.completed|run.failed|run.cancelled, error, done`; `: keepalive` comments every 10 s).
- `POST /v1/chat/completions` (stream: `hermes.tool.progress` events; `delta.reasoning_content`), `POST /v1/responses`
  (reasoning items + function_call items), `POST /v1/runs` + `GET /v1/runs/{id}/events` (SSE lifecycle), `/v1/runs/{id}/steer`, `/stop`.
- Header `X-Hermes-Session-Id` / `X-Hermes-Session-Key` for conversation continuity on `/v1/*`.

### 3e. Practical integration plan for the hackathon
- **Read path (all sessions, any client)**: poll dashboard REST `GET /api/sessions?order=recent` (1–2 Hz) + per-session
  `GET /api/sessions/{id}/messages?order=latest&limit=…` deltas; optionally subscribe `/api/ws` events for token-level
  streaming. This sees everything regardless of which Hermes client created the session.
- **Write path**: API server `POST /api/sessions/{id}/chat` (send a message into a session), `POST /api/sessions/{id}/fork`
  (fork), or TUI-gateway `prompt.submit` / `session.branch` over `/api/ws`.
- **Offline path (must exist)**: a fixture replayer that streams recorded sessions with the same normalized event protocol,
  so the demo never depends on a live model/API key/venue Wi-Fi.

## 4. bighelp facts (reference app; clone at /home/user/promptclickrun/bighelp)
iPhone/watch/Mac/visionOS app for Hermes: chat, avatars that act out agent state (idle, listening, thinking, replying,
waiting on you, has update), tool activity shown as the running tool (`AgentActivityKind`: thinking, coding, browsing,
image-making…), approvals, voice (turn-based and live over WebRTC via its Hermes plugin), Live Activities. On Vision Pro the
agent can stand in the room as a 3D character in a volume. Design principle: "the avatar is the live status indicator;
states must come from real data." Connects straight to a Hermes host over LAN/Tailscale/HTTPS.

## 5. Constraints for anything we build
- Node 22 + plain ES modules, **no bundler** (serve `node_modules/three` as static files via an import map); deps: `three@0.170.0`, `ws@8`.
- Must run with **zero external services**: fixture mode by default; live Hermes adapter optional via env/flags.
- Both the laptop browser (OrbitControls) and the headsets (WebXR) load the **same page** and share **one scene state** via the
  server's WebSocket hub (this is the "headset + laptop build together" answer).
- Functional wireframes: boxes, lines, text sprites, simple animations. No art pass.
- Everything must be honest in the demo: anything mocked is said out loud (rubric: "It works in space").

### 3f. Exact `/api/ws` event envelope (verified in tui_gateway/server.py `_event_frame`)
Every notification is `{"jsonrpc":"2.0","method":"event","params":{"type":"<event name>","session_id":"<sid>","payload":{...},"seq":N}}`.
Requests are ordinary JSON-RPC `{"jsonrpc":"2.0","id":"w1","method":"session.list","params":{}}` → `{"jsonrpc":"2.0","id":"w1","result":{...}}`.
Server→client requests carry a string `id` plus `method` (e.g. `approval`) and expect a response with the same id.
Replay: `session.events.since {session_id, seq}` returns missed frames; `gateway.ready` carries `replay_epoch`.
On a loopback-bound dashboard (`127.0.0.1:9119`) the WS auth mode is "loopback" (no ticket needed); when bound to a LAN
address the dashboard requires a configured password/OAuth provider and the client must mint a single-use ticket first
(`buildWsAuthParam` in web/src/lib/api.ts). Simplest at the venue: run our Node server on the same laptop as Hermes and
let it talk to 127.0.0.1:9119 (REST + /api/ws) and 127.0.0.1:8642 (API server) — headsets only ever talk to our server.

### 3g. Gateway event payload contracts (tui_gateway/contracts/events.py) and tool argument names
- `tool.start` payload: `{tool_id, name, context?, args?: {...}, args_text?, preview?, labels?}`
- `tool.complete` payload: `{tool_id, name, args?, duration_s?, result?, summary?, result_text?, inline_diff? (unified diff for patch/write_file), todos?, revision?}`
- `message.delta` `{text: string|null}` (null = segment boundary); `message.complete` `{text, usage?, status?, reasoning?}`; `reasoning.delta` `{text}`.
- Built-in tool names: terminal, read_file, write_file, patch, search_files, web_search, web_extract, browser_navigate,
  browser_click, browser_type, browser_snapshot, browser_vision, browser_scroll, delegate_task, execute_code, memory,
  todo_list, skill_view, skills_list, skill_manage, session_search, image_generate, vision_analyze, text_to_speech,
  clarify, process_manage, cronjob_manage, desktop_preview.
- Argument names: `terminal {command, background?, timeout?, workdir?}`; `read_file {path, offset?, limit?}`;
  `write_file {path, content}`; `patch {path, old_string, new_string, replace_all?}` (result is a unified diff);
  `search_files {query/pattern, path, target}`; `web_search {query, limit?}`; `web_extract {urls}`;
  `browser_navigate {url}`; `delegate_task {goal} | {tasks:[{goal,...}]}`; `memory {action, content}`; `todo_list {todos}`.
- Mapping to spatial visualization (for the wireframe): web_search/web_extract/browser_* → "browser pylon";
  read_file/write_file/patch/search_files → "file tree" (diffs shown on the file node); terminal/execute_code/process_manage →
  "terminal slab"; delegate_task → spawn a child column next to the parent; memory/skill_* → "memory vault";
  clarify/approval → "waiting on you" beacon above the column; image_generate/vision → "media easel".
