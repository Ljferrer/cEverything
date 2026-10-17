# DESIGN.md — cEverything "Skyline": the chosen concept and the grafts

Source: a three-designer, three-judge panel run before the event. Winner: the demo-first design (ranked first by two of three judges, highest fit to Lukas's wishes). Grafts come from the ship-safe and user-first designs. This file is the design authority for the wireframe; PROTOCOL.md is the wire authority.

## One sentence

Every AI-agent chat you have open stands as a column in your room: walk up to read it, look at it and speak to steer it, drag a message from one column to another to connect them — while your laptop teammate types, approves and arranges in the very same room.

## Project name candidates

- Skyline — every agent chat is a column in your room
- Harness Room
- Columns
- Pylons
- cEverything (SEE everything)
- Standing Agents

## How it answers the Open-track question (headset + laptop build together)

Both devices load the same page (https://<tunnel>/) and mirror one authoritative SceneState held by a Node WebSocket hub; nothing is device-specific except the input layer. The collaboration is real because each person does what only their device is good at, and every action is visible to the other in under 100 ms:

LAPTOP PERSON (operator) does what the headset cannot: types long precise prompts, file paths and code (keyboard); reads a 200-line diff flat in the right-hand panel; clicks Approve/Deny on Hermes `approval.request` (live mode) or resolves a fixture's stuck session; presses `T` for a top-down view and drags 10 column bases into a sensible floorplan in 10 seconds; controls fixture time (pause/speed) and switches the live adapter host. Their mouse hover is broadcast, so the headset sees a blue outline on the tile the laptop person is reading.

HEADSET PERSON (director) does what the laptop cannot: perceives 5–10 sessions at once peripherally — a beam to the browser pylon means "browsing", a green packet to the terminal pylon means "running a command", a red pulsing ring means "needs me", without reading anything; walks 1 m to turn a skyline of bars into readable text (body position = zoom); addresses a session by looking at it and speaking (gaze + voice = "talk to the one you're looking at", like a room of people); pipes by pinch-dragging a tile from column A onto column B; forks by grabbing a column's title plate and pulling it sideways until a ghost column detaches. Their head pose, hands and gaze ray are broadcast at 10 Hz, so the laptop person sees a wire cone + dotted gaze line and knows which session the headset person means when they say "this one" — and can type or speak for that target ("headset looks, laptop speaks" is a first-class mode, also the Vision Pro voice fallback).

SHARED STATE PROOF in the demo: the laptop types → a white tile grows on the column in the headset the same instant; the headset drags a column across the floor → it slides on the laptop's top-down view; the headset says "yes, go ahead" → the laptop HUD's approval card flips to approved. Everything is one JSON event stream (section event_protocol); there is no "headset build" and "laptop build".

## Scene design (numbers are the wireframe defaults; PROTOCOL.md §5 overrides where they differ)

COORDINATES: origin = headset user's start position; +y up; user faces −z. Quest uses `immersive-ar` (passthrough, real room visible — the real laptop and teammate are in shot); Vision Pro uses `immersive-vr` with a dark floor; laptop uses OrbitControls. Floor grid 4 × 4 m, 0.5 m cells, dim gray (#374151) lines, at y = 0. A text sprite at (0, 0.12, −1.0) reads "FIXTURE REPLAY" or "LIVE: hermes@<host>" — honesty label always in shot.

COLUMNS (one per session, up to 10): default placement on a front arc radius 1.8 m, angles −60°, −30°, 0°, +30°, +60° (chord spacing 0.93 m); sessions 6–10 on a second arc radius 2.6 m at 22.5° steps offset 11.25° (spacing 1.01 m). All movable by grabbing the base. Small-space mode `?r=1.2` shrinks radii by 1/3.
- Base plate: wireframe box 0.40 × 0.05 × 0.40 m at y = 0.025; status ring = circle Line radius 0.25 m, 32 segments, at y = 0.02: running = green #22C55E dashed, rotating 1 rev/2 s; idle = white 40% opacity static; needs_you = red #EF4444 scale-pulse 1.00↔1.15 at 1 Hz; ended = gray #6B7280; branched = gray + dashed line from base to child's base.
- Glance panel (y 0.30–1.20): title sprite 0.36 × 0.08 m at y = 1.15 (title + model short name, e.g. "fix-parser-tests · sonnet"), activity sprite 0.36 × 0.06 m at y = 1.05 ("browsing: developer.apple.com" from last_activity_description or last tool.start), tool-history row at y = 0.90: last 8 tool categories as 0.04 m cubes, 0.045 m pitch, colored by category (coding #22C55E, web #F59E0B, files #14B8A6, memory #EC4899, delegating #FB923C, images #D946EF, messaging #3B82F6, waiting #EF4444, tools #9CA3AF — bighelp's tool-name mapping reused). Counter sprite at y = 0.75: "142 msgs · 37 tools".
- Mic sphere: 0.06 m wire sphere at (0, 1.30, +0.25) in front of the title plate; appears only when the column is gazed; scales with mic RMS while push-to-talk is held.
- Message stack: newest tile at y = 1.30 (reading height); older tiles stack UPWARD, so the column grows into the sky and the live head stays readable. Tile = 0.36 m wide × h × 0.02 m deep, gap 0.03 m. On a new message, existing tiles translate up by (h + 0.03) over 300 ms ease-out-cubic (the "column grows" beat).
- LOD by Euclidean distance head→tile center: LOD2 (full) < 1.0 m; LOD1 (summary) 1.0–2.5 m; LOD0 (glyph) > 2.5 m. Standing at origin, the 1.8 m arc shows summaries; one step forward (0.9 m) = full text; one step back = glyph skyline. Three LODs inside 2 m of walking, which is the demo arc.
  - LOD0: 0.06 m bar, solid role color, no text. ALL tiles of ALL columns are one `InstancedMesh` (BoxGeometry 0.36 × 0.06 × 0.02, capacity 4000, `instanceColor`) = one draw call; per-tile height is applied via instance matrix scale.
  - LOD1: 0.12 m tall, 256 × 64 px canvas sprite, pooled (32 sprites): role glyph + first 48 chars (tool tiles: "⚙ web_search  "visionOS webxr…"").
  - LOD2: up to 0.50 m tall, 512 × 768 px canvas plane, pooled (6 planes): full text wrapped at 40 cols, max 600 chars then "… (+N chars)". Tool tiles show name + args pretty-printed; thinking tiles show the reasoning text.
  - Pool assignment every frame: sort tiles by distance, assign LOD2 planes to the nearest ≤ 6 within 1.0 m, LOD1 sprites to the next ≤ 32 within 2.5 m; textures redraw only when (msgId, lod) changes. Only the newest 60 tiles per column exist as tiles; beyond that a single thin "spire" Line rises to y = 30 m with a sprite "+140 earlier messages" at the top of the tiles.
- Colors by role: user #FFFFFF; assistant text #38BDF8 (cyan); thinking/reasoning #A78BFA (violet, 60% opacity, dashed outline); tool_call #F59E0B (amber) with a 0.04 m category-colored chip on the left edge; tool_result #B45309 (dim amber, outline only); system #6B7280; error #EF4444. Streaming tile pulses emissive 0.5 Hz. Gazed column: base plate brightens, title sprite scales 1.2× (200 ms dwell to avoid flicker). Laptop-hovered tile: 0.42 × (h + 0.02) blue #3B82F6 wire outline.

PYLONS (fixed landmarks shared by every session):
- Browser pylon at (−2.5, 0, −1.0): 0.3 × 0.3 m base, 2.2 m wireframe octagonal prism, wire sphere radius 0.25 m on top at y = 2.45. On any `web_search` / `web_extract` / `browser_*` tool.start: amber 0.05 m packet travels a quadratic Bezier (control = midpoint + 1.0 m up) from the tile to the sphere in 600 ms, sphere flashes amber 300 ms, a sprite under it shows query/url (40 chars) for 4 s; on tool.end a cyan packet returns in 600 ms.
- Terminal pylon at (+2.5, 0, −1.0): 0.3 × 0.3 m base, 1.6 m wire box, 0.5 × 0.3 m "screen" plane at y = 1.4 showing the last command (60 chars). Green packet on `terminal` / `execute_code`.
- File-tree pylon ("the codebase") at (0, 0, −3.2), facing the user: root cube at y = 0.4; one level per directory depth, 0.35 m vertical pitch, siblings 0.25 m apart, max 4 levels / 40 nodes, built lazily from paths seen in `read_file` / `write_file` / `patch` args across all sessions. Dirs = 0.06 m wire cubes; files = 0.05 m planes with a filename sprite; parent→child `Line`s. On `patch` / `write_file`: amber packet to the node, node flashes, the diff panel (0.8 × 0.5 m plane at x = +1.2 m from root, y = 1.2) renders the diff (max 24 lines; `+` lines #22C55E, `−` lines #EF4444, context gray) for 8 s or until the next edit; the node turns green with a touched-count badge.

FX: pipe = the grabbed tile copy follows the hand; on drop a cyan packet runs source tile → target base in 600 ms, then the new white tile grows at the target. Fork = ghost clone of the column's bars at 30% opacity follows the hand once pulled > 0.5 m; on release the new column lerps into place in 400 ms, dashed line to the parent, title "<parent> fork". Presence: headset = wire cone (r 0.08, h 0.15) at head pose + 0.03 m hand spheres + 2 m dotted gaze ray; laptop = small wire camera pyramid at its OrbitControls pose.

HIT TARGETS: invisible-material hitboxes (MeshBasicMaterial visible:false) — tile 0.40 × h × 0.10 m, title plate 0.40 × 0.10 × 0.10, base 0.44 × 0.10 × 0.44, mic sphere r 0.08, column gaze cylinder r 0.30 h 3.0 (head ray only). Budget: ≤ 10 columns, ≤ 600 instanced bars live, 38 text textures, 3 pylons, 40 tree nodes; target 72 fps on Quest 3S.

## Interactions

### Walk-to-read (proximity LOD)
- Body inputs: locomotion / body position, head pose
- Vision Pro: Physically walk toward a column in immersive-vr; at < 1.0 m bars become full-text tiles, 1.0–2.5 m one-line summaries, > 2.5 m glyph bars. Thresholds measured from the XR camera.
- Quest: Same, in passthrough AR so the real room stays visible; walking 0.9 m forward from the start spot crosses LOD1→LOD2.
- Laptop: Scroll-wheel dolly in OrbitControls does the same thing (distance from the desktop camera), so the laptop person can read any tile without a headset.

### Glance (who is doing what)
- Body inputs: head turn
- Vision Pro: Turn head; every column's ring color (running/idle/needs you/ended), tool-history cubes, activity line, and live packets to the browser/terminal/file-tree pylons tell you what each session is doing without reading.
- Quest: Identical; passthrough lets the real teammate and laptop share the view.
- Laptop: Left HUD session list mirrors status dots and activity text; same packets fly in the 3D view.

### Look-and-speak (gaze + voice to steer a session)
- Body inputs: head gaze, pinch / squeeze hold, voice
- Vision Pro: Head-ray (camera forward) highlights the gazed column (200 ms dwell) and shows its mic sphere. Pinch-and-hold the mic sphere (transient pointer selectstart/selectend at any controller index 0–3) to record via getUserMedia → server → AssemblyAI; release sends to that session. getUserMedia inside immersive Safari is unverified, so if the track dies the client flips to 'headset looks, laptop speaks': the gaze target is broadcast and the laptop teammate holds Space and talks; the text routes to the gazed column.
- Quest: Head-ray highlight; hold left-hand pinch (thumb-tip↔index-tip < 0.02 m via XRHand joints) or left controller squeeze to talk; mic permission requested on the 2D page BEFORE entering AR; audio → AudioWorklet → 16 kHz PCM16 → WS `audio.chunk` → AssemblyAI streaming; `voice.partial` shows a gray ghost tile on the column while speaking; release → `send {via:'voice'}`.
- Laptop: Click a column (or toggle 'follow headset gaze'), hold Space, speak; Chrome `webkitSpeechRecognition` (no server needed) → `voice.text`. Keyboard typing is the always-on fallback.

### Pinch-select a tile (inspect)
- Body inputs: gaze, pinch
- Vision Pro: Gaze at a tile and pinch (system transient pointer); a 0.6 × 0.45 m detail plane opens at reading height beside the column with the full text / tool args / diff, pinned until the next select.
- Quest: Hand pinch or controller trigger on the tile hitbox; same detail plane.
- Laptop: Click a tile; the right HUD panel shows full text, args and diff flat (the laptop is where long diffs get read).

### Pipe a message between sessions (drag tile → other column)
- Body inputs: pinch-hold, arm movement, gaze to target
- Vision Pro: Pinch-hold a tile; the transient pointer ray follows the hand while pinched, so the tile copy is carried at the original hit distance; release over another column's base (within 0.5 m horizontally) → `pipe`. A packet flies and a '[from <A title>]: …' user tile grows on B; in live mode this is POST /api/sessions/B/chat/stream.
- Quest: Same carry-at-distance drag with pinch or trigger; drop on the target base.
- Laptop: Mouse-drag a tile from one column to another in the 3D view, or select a tile and press P then click a target column in the session list.

### Fork a session (pull the title plate)
- Body inputs: pinch-hold, arm pull
- Vision Pro: Pinch-hold the title plate and pull sideways; past 0.5 m a 30%-opacity ghost column follows; release on free floor → `fork {x,z}`; new column with copied tiles appears, dashed line to the parent. Live mode: POST /api/sessions/{id}/fork (Hermes ends the parent as 'branched'; its ring turns gray — said out loud).
- Quest: Same with pinch or trigger.
- Laptop: Select a column, press F or click Fork; the fork lands 0.8 m to the right; or drag the title plate with the mouse.

### Arrange the room (move columns)
- Body inputs: pinch-hold, arm movement
- Vision Pro: Pinch-hold a base plate and drag; the column slides on the floor plane (y locked); `layout.move` broadcast so the laptop sees it slide.
- Quest: Same.
- Laptop: Press T for a top-down view and drag bases on the y = 0 plane — ten columns arranged in ten seconds; the headset sees them slide in real time.

### Approve / unblock a stuck session
- Body inputs: gaze, voice
- Vision Pro: A needs_you column pulses red; look at it and say 'yes, go ahead' (voice) — fixture treats any voice input to a needs_you session as approval; live mode sends the text as the user's reply (approval UI stays on the laptop).
- Quest: Same.
- Laptop: HUD approval card (live `approval.request` or fixture stuck state) with Approve / Deny buttons — the laptop is the authoritative approver in live mode; the headset sees the ring turn green.

### Type precise text or code into a session
- Body inputs: none (keyboard path)
- Vision Pro: Not offered in-headset (no keyboard); the wearer watches the tile grow on the column the instant the laptop sends.
- Quest: Same.
- Laptop: Bottom textarea, Enter sends to the selected column (`send {via:'keyboard'}`), Shift+Enter newline; monospace for code.

### Presence (see each other in the room)
- Body inputs: head pose, hand positions
- Vision Pro: Sees a blue outline on whichever tile the laptop person is hovering and a wire camera pyramid where their view is.
- Quest: Same.
- Laptop: Sees a wire cone at the headset wearer's head, two hand spheres and a 2 m dotted gaze ray, at 10 Hz — so 'this one' is unambiguous.

## Voice plan

PRINCIPLE: voice always has a target chosen by the body (gaze on headset, selection or followed gaze on laptop), and every path degrades to a working one.

LAPTOP (Chrome): `webkitSpeechRecognition` (interimResults=true, continuous=false, lang en-US); hold Space = push-to-talk; interim text is sent as `voice.partial` so the headset sees a gray ghost tile growing on the target column; final → `voice.text` → `send {via:'voice'}`. Target = selected column, or the headset wearer's gazed column when the "follow headset gaze" toggle is on. Needs no server key; works offline from the internet except for Google's recognizer (Chrome's Web Speech is cloud-backed, so venue Wi-Fi matters — keyboard is the floor).

QUEST (Quest Browser has no SpeechRecognition): request `getUserMedia({audio:{channelCount:1, echoCancellation:true}})` on the 2D page BEFORE "Enter AR" so the permission prompt never interrupts immersion; keep the stream alive, gate sending. `AudioContext` + `AudioWorklet` (`pcm-worklet.js`) downsamples to 16 kHz PCM16, posts 100 ms frames + RMS. Gesture: gaze a column, hold left-hand pinch (thumb-tip↔index-tip < 0.02 m, 150 ms debounce) or left controller squeeze → `audio.start {targetSessionId}` → chunks → release → `audio.stop`. Server proxies to AssemblyAI Streaming v3 (`wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&format_turns=true`); Turn events → `voice.partial`; end_of_turn / stop → `voice.final` → `send`. Mic sphere scales with RMS so the wearer sees it is hearing them. Latency budget ~1 s after release.

VISION PRO: Web Speech on visionOS Safari is unverified and getUserMedia inside an immersive session is unverified — plan the same getUserMedia-before-immersion path (hold = pinch on the mic sphere via transient-pointer selectstart/selectend), test it in the 16:00 slot, and if the track ends on session start, fall back to "HEADSET LOOKS, LAPTOP SPEAKS": the wearer's gaze target is in `presence.gaze`, the laptop teammate holds Space and speaks, and the text routes to the gazed column. This is still two body inputs (gaze + voice) across two people and demonstrates the collaboration honestly.

FALLBACK LADDER (all devices): AssemblyAI key missing or WS fails → server sends `voice.unavailable`, the headset's mic sphere turns gray with "voice via laptop"; laptop Web Speech still works; Web Speech fails → keyboard `send`. The video narration states which path was live. ElevenLabs TTS (speak the assistant's final reply from the column's position) is a 16:30 stretch only; it is not claimed unless it ships.

## Demo video script (under 60 s, no slides)

Single take, filmed THROUGH THE QUEST (passthrough AR, capture button), narrated live by the wearer; the laptop and teammate are physically in frame because passthrough shows the real room. Optional 7 s Vision Pro Control-Center clip appended; no slides, no music.

0–3 s [headset POV]: five wireframe columns stand around the real table; the nearest fires an amber packet to the browser pylon. Wearer: "Every Hermes agent I have running is a column in my room."
3–8 s: wearer walks 1.5 m toward the middle column — bars become one-line summaries, then full text tiles; tilts head up: the column rises overhead. "Walk up and it reads itself. Step back and it's a skyline."
8–15 s: turns to the column with the red pulsing ring. "This one needs me." Gaze highlights it; left-hand pinch-hold; says "Yes, go ahead and run the tests." Releases. A white tile appears at reading height, the column grows, the ring turns green, a green packet shoots to the terminal pylon.
15–25 s: pinches a cyan assistant tile on column 2, drags it across, drops on column 4: "Send this answer into the other agent." Packet flies; column 4 gets the tile and starts working; an amber packet hits the file tree, a file node flashes, the diff panel opens with green and red lines.
25–33 s: pinches column 4's title plate and pulls sideways; a ghost column follows; releases: "Fork it." New column appears with a dashed line to its parent.
33–48 s: pans to the real laptop in passthrough. Teammate types in the HUD; the wearer's view shows the white tile appear on column 1 as they hit Enter. Teammate presses T and drags column 3 across the top-down view; it slides across the floor in the headset. "Same room, same state. Kai types and arranges on the laptop; I look, speak and pull things apart in the headset."
48–55 s [optional cut: Vision Pro Control-Center recording]: same columns in immersive-vr; a pinch selects a tile and the detail plane opens; the laptop's hover outline is visible on another tile. (If no clip: stay in Quest and show the laptop screen's wire cone + gaze ray tracking the wearer's head.)
55–60 s [headset POV, wide]: all columns; the floor label "FIXTURE REPLAY" is in shot. "This run is a recorded fixture replay. The live adapter reads Hermes's dashboard API. Everything you saw was running in the headset."

What is filmed through the headset: everything except the optional Vision Pro clip (filmed through that headset). Nothing is filmed from the laptop screen alone; the laptop appears via passthrough.

## Sponsor alignment

Claim only what ships. AssemblyAI (sponsor, STT credits): the Quest voice path streams mic audio through our Node proxy to AssemblyAI Streaming v3 — a real, demonstrable use of speech as a body input; list it under sponsor tools if the path works in the 14:00 slot. ElevenLabs: optional 16:30 stretch (speak the assistant's final reply from the column's position; one month Creator covers it); do not enter "Best Use of ElevenLabs" unless it ships. Miro: not used in the product; mention only if the team genuinely planned the floor layout on a Miro board. Auki posemesh: not used (the laptop view is virtual, not co-located AR); say so if asked. Pupil Labs Neon: not used; our gaze is head-ray and is called "head gaze" everywhere, never "eye tracking". Prizes targeted: Open track and the grand prize (Quest 3S + ElevenLabs Pro); rubric tie-break "it works in space" favors our fixture-backed reliability.

## Rubric self-assessment

Works in space (4): the core loop (walk-LOD, look-and-speak, pipe, fork) runs live in the Quest headset, repeatably, because fixture mode removes network/model variance; a 5 needs both headsets flawless, and Vision Pro Safari is the unverified half. Made with the body (4.5): four inputs that compose naturally — walking is the zoom, head gaze is the address, pinch is the grab, voice is the message; 'look at it and talk to it' is how you address a person, which is the rubric's 'feel natural together'; held back from 5 only by voice-path risk. A new way to create (4): directing a fleet of coding agents by arranging a room, forking by pulling a column apart and piping by dragging tiles between columns has not been shown; it is not a 5 because the created artifact (software) is produced by the agents, one step removed from the hands. Worth making again (4): anyone with 5–10 agent chats open recognizes the pain in one sentence and will want to wear it again; it is a wireframe, so not yet a 5. Clicks fast (4.5): the sentence is repeatable and the first 3 seconds of video show columns, a packet and a walk; judges who have not used agent harnesses need the full 60 s. Target total ≈ 21/25; the honest fixture label protects the tie-break criterion rather than hurting it.

## Grafts adopted from the other designs (binding)

- Resume: server keeps a ring buffer of the last 5000 events; clients send `join {lastSeq}` and get a replay or a fresh snapshot; reconnect backoff 0.5→8 s; an in-room red 'reconnecting' badge. Headsets sleep when taken off at the expo; the room must not be empty when a judge puts one on.
- debug3d: an in-room 1024×256 canvas (toggle with `?debug=1` or the laptop key D) showing the last 8 console lines and the live XR input-source index + targetRayMode on every select event. It is the only practical way to debug transient-pointer indices on Vision Pro without a cable.
- Summon-to-me (per-viewer, local, never shared): pinch-hold a column's base for 0.6 s (or laptop key F on the selected column) glides the column to 0.9 m in front of the viewer at full LOD; release/again sends it back. Required because visionOS makes immersive content translucent after ~1 m of head movement and exits to passthrough beyond ~1.5 m: on Vision Pro the user leans and summons; walking is a Quest-only beat.
- Pull-to-scroll (local): pinch-hold the tile stack and move vertically to scroll older messages into reading height (tap vs drag: < 250 ms and < 3 cm travel = tap); laptop mouse wheel over a column; Home snaps back to newest.
- Never import XRControllerModelFactory or XRHandModelFactory('mesh'): both fetch GLTF profiles from a CDN at XR session start and stall entry on venue Wi-Fi. Draw rays as plain Lines; hands (if requested) as 'boxes' or spheres.
- Do not request `hand-tracking` on Vision Pro by default (keeps transient pointers at indices 0/1 and avoids an in-session permission prompt); `?hands=1` opts in. Still create controllers 0..3 and listen on all of them.
- Targeting truth on Vision Pro is the select event's ray at `selectstart` (eye gaze); the head-ray highlight is cosmetic only and must never gate an action.
- Gesture disambiguation: right hand/controller = select, grab, pipe, fork, move; left hand/controller = push-to-talk (left pinch or left squeeze). Voice recording also starts only when the left ray hits the mic sphere or nothing; 150 ms debounce.
- Pending voice tile: a dashed gray tile shows the transcript (partial text grows live) and sends after a 2 s countdown that any pinch/click cancels; a 2 s `voice.error` timeout clears a stuck mic.
- Fixed vertical tile pitch regardless of LOD (0.14 m: 0.12 m tile + 0.02 m gap) so columns never reflow as the viewer moves; LOD changes the texture content only; the full text lives in the pinned detail plane. LOD recomputed at 5 Hz with 0.15 m hysteresis.
- Expo hygiene: laptop key R = reset to demo start (re-seed fixture, drop judge-made forks/pipes, restore layout); `?judge=1` hides debug UI; demo cue keys 1–5 fire scripted beats (needs_you, web burst, patch, delegate, done) so every take hits the same moments.
- In-room legend sprite at spawn (white = you, cyan = agent, violet = thinking, amber = tool, red = needs you; 'look + pinch to pick up, hold left to talk') and the honesty label on the floor at the user's feet ('FIXTURE REPLAY' or 'LIVE: hermes@host') so it is in every shot.
- Height recenter: laptop key C and a 1 s pinch-hold on the floor re-anchor the reading height to the current head height minus 0.3 m (seated judges at a table).
- Headset handover: the 2D page has one giant Enter button with connection + mic status; removing a Quest ends the immersive session, so the runbook step is wake → tap Enter → hand over (< 15 s).
- Spectator view: laptop key V follows the headset wearer's head pose (renders what the judge sees) so bystanders at the table see the demo and the video has a second source if headset capture fails.
- Quest capture may record passthrough as black. Rehearse the phone-filmed fallback; support `?mode=vr` on Quest to record in immersive-vr with the floor grid visible.
- Fixtures are hand-authored and contain no real credentials; the live adapter redacts anything matching common secret patterns (sk-…, AKIA…, ghp_…) before broadcasting.
- Named tunnel or static domain (cloudflared named tunnel on Lukas's domain, ngrok static domain, or Tailscale Serve) configured and tested from a phone before the event; the server prints a QR code of its public URL; LAN self-signed HTTPS is the Quest-only fallback.
- Positional audio (stretch): a soft click at the column position on `waiting_on_you` and on tile arrival behind the wearer (Web Audio PositionalAudio), because glance only works for columns in view.

## Judges' fatal-flaw list (each one must be visibly addressed in code or runbook)

- DEMO-FIRST: on Quest hands, hold-to-talk is a left-hand joint-distance pinch, but every hand pinch also fires `selectstart` on controllers 0..3, so holding to talk starts a grab/pipe-drag on whatever the left ray is hitting. Bind grab/select to the right hand and talk to the left (or suppress select from the talking input source) or the look-and-speak beat breaks the take.
- DEMO-FIRST: no headset path to older messages. Only the newest 60 tiles exist, LOD distance is Euclidean including height, so anything above ~2.5 m is a permanent glyph and nothing can be scrolled; Lukas's 'get closer to a particular message' only works for the last few messages.
- DEMO-FIRST: Vision Pro is first touched at 16:00 with no morning try slot, on a device whose loaner count the organizers list as 'being confirmed'. Transient-pointer indices, the hand-tracking prompt inside immersion, getUserMedia survival, and WSS through the tunnel are all discovered 2.5 h before the deadline.
- DEMO-FIRST: on Vision Pro, column highlight and mic-sphere visibility come from the HEAD ray (camera forward) while the pinch target comes from EYE gaze; eyes on the 0.06 m sphere with the head drifted a few degrees makes the sphere vanish mid-gesture. Use the select event's hit as the targeting truth on VP, head ray only as fallback.
- DEMO-FIRST: a random trycloudflare URL typed into two headsets; a tunnel restart changes it mid-day and every reload at the expo table requires retyping.
- DEMO-FIRST: a single 60 s take with eight beats, live narration and live STT; one missed transcription or one dropped pinch restarts the take. The 'headset looks, laptop speaks' path must be rehearsed as the primary take, not as a fallback.
- DEMO-FIRST (and USER-FIRST): neither says it avoids XRControllerModelFactory / XRHandModelFactory('mesh'); both fetch GLTF input profiles from cdn.jsdelivr.net at XR session start and stall entry when venue Wi-Fi blocks the CDN.
- SHIP-SAFE: interaction model is cards and buttons (Pipe → pick plinth, Fork button, mic orb only under an open card). Rubric criterion 3's 1-anchor is 'a familiar 2D tool moved into headset'; voice is three steps, pipe is three pinches, and on video it reads as menu navigation rather than making with the body.
- SHIP-SAFE: the primary headset footage is a Vision Pro Control Center recording at 16:30 inside an immersive WebXR session (unverified behavior) on a device with an unconfirmed loaner count; the Quest backup clips from 14:45 predate pipe, fork and voice, so the final feature set may exist only in VP footage or not at all.
- SHIP-SAFE: terminal pylon at (0,0,-2.9) stands directly behind slot 0 at (0,0,-2.0); the front-center column occludes the terminal card from spawn.
- SHIP-SAFE and USER-FIRST: the 'generic' starter published tonight includes a canvas-text sprite helper, in-room debug console, HTTPS option and controller/hand setup for indices 0..3 — closer to project code than a template. If the organizers say no at check-in, 40 minutes are lost at 10:30. DEMO-FIRST's zero-app-code-tonight line is the only one with no exposure to 'all code is written during the event'.
- SHIP-SAFE and USER-FIRST: three stacked reservations (Quest 13-15, VP 15-17, expo headset 18-20 / VP 13:30-15:30, Quest 15:30-17:30, Quest 17:30-19:30) assume the portal allows booking ahead; the published policy is 'from 1 PM commit to the hardware you are keeping, up to 2 h, one at a time'. Everything headset-only must still work if only one reservation is granted.
- USER-FIRST: gesture collisions. Plinth pinch-hold = push-to-talk, plinth long-pinch = carry the tower, plinth long-pinch = toggle grounded layout. Tile pinch+move = carry for pipe, tile pinch+move = pull-to-scroll, tile pinch held still 0.8 s = fork menu. This will fail live with retries on both headsets and cannot be fixed by thresholds alone; it needs distinct hit targets or distinct hands.
- USER-FIRST: room geometry. Arc radius 4 m puts towers ~6 m from spawn and L0 only under 1.5 m, so full text is unreachable by walking at a table and the hero beat depends on teleport, which reads as a cut on video. ROOM_SCALE scales XZ positions only: at 0.6 the 18° slot chord is 0.75 m against 0.8 m plinths and 0.7 m tiles (overlap), at 0.4 it is 0.5 m.
- USER-FIRST: the Vision Pro is the primary afternoon development headset (13:30-15:30) while the video is filmed through the Quest, which is only in hand 15:30-16:30; Quest passthrough, hand and mic issues surface one hour before freeze.
- USER-FIRST: the video ends on a laptop capture of the README with on-screen text. 'No slides. A video with slides will not be judged.' A README page is text on screen; keep the honesty label in-room and drop the README shot.
- USER-FIRST: variable tile heights (0.05-0.70 m) with per-frame anchor reflow mean the whole stack reflows during the walk-up shot; even with 1.15x hysteresis, tiles jump during the hero beat. SHIP-SAFE's fixed 0.34 m pitch is the stable alternative.
- ALL THREE: every headset voice path (AssemblyAI) and the laptop path (Chrome Web Speech is cloud-backed) need internet; if venue Wi-Fi and the hotspot both fail, the only headset body inputs left are walk/gaze and pinch and the keyboard floor keeps the demo alive. Acknowledged by all; none has an offline STT, which is correct for 8 hours, but the narration must then say 'voice via laptop' out loud.
- Vision Pro walk-to-read (DEMO-FIRST and USER-FIRST): WebXR `immersive-vr` on visionOS is a fully immersive session, and verified system behaviour makes content translucent after roughly 1 m of head movement and exits the experience to passthrough when the head leaves a roughly 1.5 m zone. DEMO-FIRST's 0.9 m step to full text is borderline and its 'step back to the glyph skyline' exits the session; USER-FIRST's 2–4.5 m walk cannot happen at all. On Vision Pro the LOD must be driven by lean (under 0.8 m) and summon-to-me, or by thresholds compressed so all three LODs fit inside 1 m; walking stays a Quest-only beat.
- DEMO-FIRST video plan: the entire 60 s script is filmed through the Quest in passthrough with the teammate and laptop in frame, but Meta's built-in capture has historically rendered passthrough black and the browser cannot access passthrough pixels; whether current firmware captures it is unverified. If the 11:30 test is black, the collaboration proof has to be shot with a phone, and the script needs that cut planned now rather than discovered at 15:30.
- USER-FIRST gesture collisions: pinch-hold on a plinth is defined as push-to-talk, long-pinch on the plinth as carry-the-tower, and long-pinch on the plinth as toggle head-down/grounded; pinch-hold-and-move on a tile is defined as pull-to-scroll, as pipe-carry, and after 0.8 s as the fork menu. No disambiguation (movement threshold, dwell ordering) is specified, so the live demo will scroll when it means to pipe and start talking when it means to move a tower.
- USER-FIRST room geometry: 12 m grid, r = 4 m arc, spawn 6 m from the towers and L0 under 1.5 m assumes a space no hack table has; ROOM_SCALE shrinks positions but not LOD thresholds by default; the Vision Pro floor-pinch teleport fires on any stray pinch while the eyes rest on the floor, which is exactly what happens when a judge looks down at the plinth.
- Quest in `immersive-vr` with a stationary Guardian (SHIP-SAFE and USER-FIRST, DEMO-FIRST's Vision Pro mode): walking 1 m at a table triggers the boundary overlay and interrupts the session. Set a roomscale boundary at the booth before the judge demo, or use `immersive-ar` passthrough on Quest where no boundary is enforced.
- DEMO-FIRST drop targets and targeting on Vision Pro: pipe drops are tested against 0.05 m-high base plates at floor level 'within 0.5 m horizontally' using a hand-following ray from about 1.8 m, which is hard to aim; and pre-pinch 'gaze' is the head ray while the real Vision Pro target is eye gaze delivered only on selectstart via the transient pointer, so the mic sphere and highlight can appear on a column the wearer is not looking at. Use the column cylinder as the drop target and let the select ray decide the target.
- DEMO-FIRST does not explicitly omit the `hand-tracking` optional feature on Vision Pro; requesting it adds a permission prompt inside the immersive session and shifts the transient pointers to indices 2/3 (handled, but needlessly). SHIP-SAFE and USER-FIRST omit it on visionOS.
- SHIP-SAFE morning schedule: the 11:00 Quest and 11:30 Vision Pro try slots require 'select hit=tile' and 'tile selected by gaze+pinch' before columns exist (11:40), and P3 is both the headset tester and the owner of the XR input build in the same hour. The slots will test only the starter grid; rewrite the done_when or they will read as failures.
- Rule exposure on 'All code is written during the event' (SHIP-SAFE and USER-FIRST): both pre-write a self-authored starter the night before containing a canvas-text helper, an in-room debug console, a WS join/broadcast hub and controller 0..3 wiring. Credited templates are allowed, but a starter written 12 hours earlier by the same team is a gray area; SHIP-SAFE's plan to ask organizers at check-in with a 40-minute retype fallback is the right handling, DEMO-FIRST's zero-application-code-tonight is the cleanest. Nothing else breaks a rule: no slides in any script, the form is filled by humans in all three; USER-FIRST's closing shot of the README on the laptop screen is close to a text card and should be replaced by the in-room label.
- Quick-tunnel URLs (DEMO-FIRST and USER-FIRST): trycloudflare hostnames are long random strings that change on every cloudflared restart and must be retyped on two headset keyboards; a restart mid-afternoon costs several minutes per headset. SHIP-SAFE's named tunnel with a short stable URL plus a Bluetooth keyboard is the fix.
- SHIP-SAFE live write path uses blocking `POST /api/sessions/{id}/chat`, so in live mode a typed message shows no streaming tiles until the whole turn completes (30–120 s of nothing). Irrelevant while the demo is fixture-driven, fatal if live mode is attempted at the table without the `/chat/stream` stretch.
- DEMO-FIRST, Quest: left-hand joint-distance pinch for hold-to-talk fires the same system selectstart that drives grab/select, so every voice pinch also grabs whatever the left ray hits (and every left-hand grab starts recording). Must gate voice to 'ray hits nothing or hits the mic sphere' or use controller squeeze only.
- DEMO-FIRST, network: a cloudflared quick tunnel yields a random ~30-character trycloudflare URL that changes on every restart; a Wi-Fi drop means retyping it on two headset keyboards during a reserved slot. Not a crash, but a live time sink that the named-tunnel approach avoids.
- DEMO-FIRST, Quest AR: if Quest capture records passthrough as black (a known WebXR immersive-ar behavior on some builds), the 'real laptop and teammate in frame' shot that carries the collaboration story is lost; the fallback (phone filming the wearer) must be rehearsed, not improvised.
- DEMO-FIRST, LOD: tile heights differ per LOD (0.06/0.12/0.50 m) and there is no hysteresis or anchor logic, so the whole column reflows and tiles jump as the wearer crosses 1.0 m / 2.5 m; the 'walk up and it reads itself' beat becomes visibly jittery.
- DEMO-FIRST, latency claim: 'visible to the other in under 100 ms' through a cloudflared tunnel is 100-300 ms in practice; say 'instantly' in the video, not a number.
- SHIP-SAFE and USER-FIRST, rules: a self-published 'generic starter' written the night before (boilerplate, canvas-text helper, debug console, HTTPS, WS echo hub) is code written before the event. Crediting it mitigates but does not remove the risk of a judge reading 'All code is written during the event' strictly; both must ask at check-in and budget 40 minutes to retype if refused. DEMO-FIRST's zero-application-code stance is the only one with no exposure.
- SHIP-SAFE, body input: the canned 6-phrase palette is not a body input; if it is what works on the headset at video time it must be shown as a fallback, never as 'voice'.
- USER-FIRST, scale: the default 4 m arc with L0 at < 1.5 m and spawn 6 m from the columns cannot be walked at an expo table; the design only scales LOD thresholds with ROOM_SCALE in a fallback, so at ROOM_SCALE=0.6 a wearer still never reaches full text by walking. ROOM_SCALE must scale thresholds from the first commit and be set before the Quest slot.
- USER-FIRST, gesture collision: plinth pinch-hold is specified as push-to-talk, long-pinch plinth as 'carry the whole tower', and long-pinch plinth as 'toggle grounded layout'. Three actions on one gesture will misfire live; one must be moved to the detail card or the laptop.
- USER-FIRST, gesture ambiguity: long-pinch (0.8 s dwell) fork menu and pinch-carry pipe both start with pinch-hold on a tile; a hesitant pinch opens the menu, and on Vision Pro the transient pointer origin follows the hand so slight drift cancels the dwell. Needs a movement threshold and a visible dwell ring, or move fork to a tile-card button.
- USER-FIRST, schedule: 'Form submitted before 18:30' is the 6:30 PM deadline with zero buffer; one upload hiccup means no submission. Freeze at 16:30 is right, but the form must be submitted by 18:00.
- USER-FIRST, live claim: 'session.branch {count} = history[:count] is a verified Hermes behavior' is not in the verified facts (only the method name is); if false the fork-at-message degrades to whole-copy and the UI must say so.
- ALL THREE, Vision Pro: getUserMedia surviving entry into immersive-vr and Web Speech on visionOS Safari are unverified; every design has a fallback, but none schedules the VP voice test early enough except SHIP-SAFE and USER-FIRST (morning try slot). DEMO-FIRST tests VP voice at 16:00, one hour before code freeze.
- ALL THREE, AssemblyAI: DEMO-FIRST hardcodes 'streaming.assemblyai.com/v3/ws?format_turns=true'; if the sponsor's current endpoint or auth differs, the proxy fails until someone reads the docs at the desk. USER-FIRST correctly says confirm the endpoint at the sponsor desk first.

## Judges' 'missing from all' list

- Headset URL entry: a QR code on the laptop screen and a printed card. Neither Quest Browser nor visionOS Safari is pleasant to type into, and the expo hand-off (judge puts headset on, page is loaded) depends on it every time a headset reloads.
- A one-key full demo reset on the laptop that restores layout, removes judge-created forks and piped tiles, and seeks the fixture clock to the scripted start state; forks and pipes created by judges accumulate over 90 minutes at the table and the room becomes unreadable.
- Height calibration: the newest tile at 1.2-1.5 m assumes a standing user with `local-floor`; a seated judge at a table, or a reference space that lands at eye height, needs a y-offset / 'recenter' key on the laptop and a pinch-hold-floor recenter in the headset.
- An in-room legend (white = you, cyan/green = agent, violet = thinking, amber = tool; 'look + pinch to pick up, hold to talk') placed at the spawn; the expo judge wears the headset for 90 seconds with no onboarding and 'clicks fast' at the table depends on it as much as the video does.
- A defined take-start state for the video: seek the fixture to a timestamp where columns already have 20-40 messages of history and tool-call beats (web burst, patch, approval) fire on laptop keys at known offsets; DEMO-FIRST has cues and SHIP-SAFE has restart, but none defines the frame-zero state of the room.
- Two headsets plus a laptop share one virtual origin, but each headset's physical origin is wherever it entered XR; presence avatars between the Vision Pro and the Quest will be arbitrarily offset. Say so, or add a one-pinch 'recenter here' at a floor marker; Auki posemesh is the real fix and is correctly out of scope.
- Audio confirmation (a click) on successful send/drop/fork for all devices; only USER-FIRST has Quest controller haptics, nothing confirms a gesture for hands or on Vision Pro.
- Battery and thermal plan for ~90 minutes of Quest passthrough at the table: a charger at the station and a low-power flag (framebuffer scale 0.8, presence off, LOD2 planes down to 4).
- A zero-Vision-Pro contingency written down: the organizers list the VP loaner count as 'being confirmed'. DEMO-FIRST comes closest (VP is an optional clip) but none states what the submission form's 'spatial output' field says if the VP never arrives.
- AssemblyAI credit mechanics: the organizers say 'MOLTEN credit details are being confirmed'; the key may not exist until the sponsor desk opens, so the STT relay must boot with no key and show the labeled fallback from minute one rather than assuming a `.env` prepared tonight.
- The verified visionOS immersion limits (translucent after about 1 m, exit to passthrough beyond about 1.5 m from the starting head position) are absent from every design; the Vision Pro runbook must say 'sit or stand still, lean and summon, do not walk', and the Vision Pro LOD path must work within 1 m.
- Eye gaze versus head ray on Vision Pro: no design states that before the pinch the page cannot know where the eyes are, so any pre-pinch hover or 'gazed column' built from the camera forward vector will disagree with the eyes when head and gaze diverge. Make the select ray at selectstart authoritative for targeting and treat head-ray highlight as cosmetic.
- Expo hygiene: none of the three prunes judge-created forks and piped tiles between demos. With a 10-column cap and 90 minutes of judges each forking once, the room fills up and later judges see a mess. Add a laptop 'reset to demo start' that re-seeds the fixture, drops forks and restores the layout, and a `?judge=1` mode that hides debug UI.
- Headset handover: removing a Quest or Vision Pro ends the immersive session via the proximity sensor; SHIP-SAFE's WS resume keeps the data but nobody re-enters XR automatically. The 2D page needs a giant Enter button with connection and mic status, and the runbook a three-step handover (wake, tap Enter, hand over) timed under 15 s.
- Nobody tests AssemblyAI streaming from the venue network before the voice slot; the key may only be issued at the sponsor desk. Add a 10-second laptop-only probe (open the v3 WS, send one PCM frame, expect a Turn event) at 10:45 so the fallback decision is made in the morning, not at 14:30.
- AudioContext and mic policy: Safari requires the AudioContext to be created or resumed inside a user gesture and re-prompts for the microphone per page load; Quest Browser remembers per origin. Create the AudioContext and acquire the mic inside the Enter button handler on the 2D page, and keep the stream alive across the session start.
- Live narration through the Quest recorder (DEMO-FIRST's script, and any take with voice-over) requires the headset's 'record microphone audio' capture setting to be on; nobody lists it in the checklist.
- Session liveness: all three derive 'running' from the dashboard's `is_active`, which is a 300 s window, so a ring will glow green for minutes after the agent went quiet. Add a 'last tool.start or message.delta within 10 s' rule for the live-looking states and keep is_active only for idle-versus-ended.
- Credits: all three reuse bighelp's tool-name-to-category mapping; the README must credit promptclickrun/bighelp explicitly alongside three.js, ws, AssemblyAI and the starter, and the submission's reused-work field must name it.
- A legibility number nobody fixes: canvas text pixels per metre at 0.9 m on Vision Pro versus Quest 3S (SHIP-SAFE's 512 px over 0.6 m is about 0.85 px/mm, fine; DEMO-FIRST's 256 px LOD1 sprite over 0.36 m is about 0.7 px/mm, marginal). Confirm one tile at 0.9 m in the first headset slot and lock the font size before anyone builds more tiles.
- An in-room color legend sprite (white = you, cyan/green = agent, violet = thinking, amber = tool, red/amber = needs you) so a judge decodes the room without narration; cheap and directly lifts 'it clicks fast'.
- Handling the WebXR session itself ending when the Quest is removed or sleeps: the socket reconnect designs survive, but the immersive session does not, so every judge handoff needs a one-tap 'Re-enter VR' button on the 2D page and a teammate step in the runbook.
- A laptop 'follow the headset' spectator camera that renders the wearer's view on the laptop screen, so bystanders at the table see what the judge sees and so the video has a usable second source if headset capture fails (DEMO-FIRST's top-down and presence cone are not this).
- Scrubbing recorded Hermes sessions for secrets and personal data before they become fixtures; only USER-FIRST mentions a regex strip, and a terminal tool result with an API key in a 60 s public video is a real exposure.
- A minimum legible text size budget (e.g. cap height >= 1.5 degrees at the LOD distance) tied to canvas px and plane size; all three pick numbers but none states the legibility rule the 11:30 headset test should verify.
- A positional audio cue (Web Audio PositionalAudio) on needs_you and on tile arrival behind the wearer; the stated problem is attention across 5-10 chats, and glance only works for columns in view.
- A cold-judge rehearsal: one person who did not build it reads the one sentence, puts on the headset and completes look-read-speak-pipe with no coaching; SHIP-SAFE's runbook test and DEMO-FIRST's dry run are team-run, not cold.
- Explicit handling of Hermes tool_calls arriving as a JSON string versus a parsed list in the normalizer (only SHIP-SAFE calls it out); the dashboard export delivers a string.
- A concrete plan for the headset wearer on Vision Pro to know where the physical laptop and teammate are, since immersive-vr has no passthrough; even a floor marker placed by the laptop person would help the 'same room' story.

## Ship-safe design: cut list in priority order (if time runs out on event day)

Floor = columns, LOD, select, summon, voice (any engine), pipe, fork, place, presence head. Cuts in order: file-tree diff becomes a text card at the files pylon; presence hands dropped; Quest AR mode dropped (VR with floor grid); interrupt dropped; live Hermes adapter dropped (fixture only, said out loud).

## User-first design: LOD/glance details worth keeping

ROOM. Floor grid 12 m × 12 m, 0.5 m line spacing, dark background (#0b0f14), grid lines #1f2937. Origin at room center, floor y = 0. User spawn (0, 0, 2.0) facing −z. `ROOM_SCALE` env/query param (default 1.0; 0.6 for a small booth) scales every XZ coordinate so the room fits the physical space; beyond that, locomotion is teleport (pinch a floor spot) or Quest thumbstick.

SLOTS. 12 fixed slots on an arc of radius 4.0 m centered at the origin, 18° apart: slot k has θ = −99° + 18k, position (4 sin θ, 0, −4 cos θ), rotated to face the origin. Straight ahead from spawn is between slots 5 and 6, ~6 m away — exactly the glance distance. The fixture's 7 sessions occupy slots 2–8 (center of the arc); edge slots stay free for forks and new sessions. A 13th+ session goes to a second ring at r = 5.5 m. Each empty slot shows a 0.6 m floor square outline (dim) — pinching it is "new session" (stretch).

COLUMN (one per session, built in `column.js`):
- Plinth: box 0.8 × 0.15 × 0.8 m at y 0–0.15. Title sprite on the inward face, 0.7 m wide: session title (≤ 32 chars), model name small beneath, slot number large at the corner (judges and teammates refer to "tower 3").
- Glance ring: torus R = 0.5 m, tube 0.02 m at y = 0.2, colored by phase: idle #475569 (gray), thinking #a78bfa (violet, pulses scale 1.00→1.08 at 0.8 Hz), tool = the tool's category color, replying #4ade80 (green), waiting-on-you #f59e0b (amber, blink 1 Hz), done #94a3b8, failed #ef4444.
- Status card: billboarded sprite 0.6 × 0.15 m, 0.5 m in front of the column at y = 2.2: "{phase} · {current_tool or last_activity_description} · {elapsed mm:ss}". Legible from ≤ 4 m; hidden beyond 8 m (the ring and beacon carry the glance then).
- Needs-you beacon: 0.15 m amber octahedron 0.5 m in front of the column at y = 2.6, bobbing ±0.05 m at 1 Hz, with a 0.02 m amber line down to the plinth and a "waiting 03:10" sprite under it. Appears on `request.open` (clarify/approval), disappears on `request.close`. Above everything else in the room, so visible from anywhere.
- Tool glyph strip: last 8 tool calls as 0.08 m cubes along the plinth's front edge at y = 0.18, newest at right, colored by category. Reads as "this one is mostly orange = editing files; that one is cyan = researching".
- Tile stack (the column into the sky). Tile width 0.7 m. DEFAULT LAYOUT = HEAD-DOWN: the newest message ("head") is centered at eye level y = 1.5 m; older messages stack upward into the sky; the oldest is at the top. Rationale (user-first): the live frontier is what you glance at and talk to, and distance-LOD makes everything above it summarize naturally; total height still encodes conversation length. Toggle "grounded" (oldest at bottom, newest on top) via laptop key `g` or long-pinch on the plinth. When a message arrives the whole stack shifts up one pitch (300 ms ease) — a visible heartbeat across the room. Scroll history by pulling the column down (pinch-grab the stack and drag; release holds; double-pinch snaps back to head). Laptop: wheel over the column.

LOD RULES (`tiles.js`), d = distance from viewer head to tile center (includes vertical distance, so tiles high in the sky summarize automatically):
- L0 full, d < 1.5 m: canvas-text plane, height sized to content 0.30–0.70 m (1024 px canvas, ~48 chars/line, up to 14 lines; text truncated at 1200 chars with "… (+N chars)"). Shows role label, timestamp, full text; tool_call shows name + pretty args; patch/write_file shows the unified diff (first 20 lines, + green, − red).
- L1 summary, 1.5 ≤ d < 4 m: 0.7 × 0.22 m, role glyph + extractive summary ≤ 100 chars: user/assistant = first sentence; thinking = "thinking · 1,240 chars · 8 s"; web_search = `search "query"`; patch = `patch src/hub.js (+12 −3)`; terminal = `$ npm test → exit 0`.
- L2 glyph, 4 ≤ d < 10 m: 0.7 × 0.12 m solid bar in role/category color (instanced mesh); tool calls carry a 0.06 m category cube.
- L3 line, d ≥ 10 m: 0.7 × 0.04 m colored line, pitch 0.05 m — the column becomes a "barcode" of the conversation.
Hysteresis: promote at the threshold, demote at threshold × 1.15. Only tiles with d < 10 m hold a canvas (typically 30–60 live textures across the room; canvases are pooled). Reflow each frame from cumulative heights, pivoting around the anchor tile nearest eye level so the stack does not jump as you walk. Max 500 tiles per column; older ones collapse into one "+N older" tile at the very top. A 500-message session renders ~3 L0 + ~12 L1 + ~40 L2 + ~445 L3 ≈ 32 m tall. Summ
