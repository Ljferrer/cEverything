# MOLTEN strategy — cEverything ("Skyline")

Saturday, October 17, 2026 · xTribe, 231 S La Brea Ave, Inglewood · hacking 10:30–18:30 · submission 18:30 · expo 18:30–20:00 · awards 20:00.
Track: **Open**, answering *"How do you build together when one person has a headset and the other a laptop?"*

Sources: the organizers' agent brief (moltenhack.com/agents.md), the Hermes agent source, WebKit and Meta developer notes.
Supporting docs in this folder: `CONTEXT.md` (facts), `DESIGN.md` (the concept and the judges' grafts), `PROTOCOL.md` (wire contract), `RUNBOOK.md` (how to run it).

---

## 1. The pitch

**One sentence (say it exactly like this, every time):**
> Every AI-agent chat you have open stands as a column in your room: walk up to read it, look at it and speak to steer it, drag a message from one column to another to connect them, while your laptop teammate types, approves and arranges in the very same room.

Name candidates: **Skyline**, Harness Room, Columns, cEverything ("SEE everything"). Pick one before 11:00 and never change it.

What it is: a WebXR (three.js) room served by a Node WebSocket hub on the laptop. Each Hermes agent session is a column of message tiles rising into the sky; thinking is violet, the agent's words cyan, your words white, tool calls amber. Tool calls shoot packets to a browser pylon, a terminal pylon or a 3D file tree that shows the diff. Red beacons mark sessions waiting on you. The laptop loads the same page and sees the same state.

Why it fits the Open-track question: both devices load one URL and mirror one authoritative scene. The headset person does what only a body can do (glance across ten sessions, walk to zoom, look-and-speak, drag tiles between columns, pull a column apart to fork). The laptop person does what only a keyboard can do (type precise prompts and code, read a long diff flat, click Approve, arrange ten columns in a top-down view in ten seconds). Each sees the other: a wire cone for the headset, a camera pyramid and hover outline for the laptop.

---

## 2. Rubric map (5 criteria × 1–5, equal weight; ties → "It works in space")

| Criterion | How we earn it | Honest target |
|---|---|---|
| It works in space | Runs live in Quest 3S and on Vision Pro from one URL; fixture replay removes model and network variance; honesty label on the floor says FIXTURE REPLAY or LIVE | 4 (5 needs both headsets flawless) |
| Made with the body | Walking = zoom, head gaze = address, pinch = grab, voice = message; two people's bodies compose ("headset looks, laptop speaks") | 4–4.5 |
| A new way to create | Directing a fleet of coding agents by arranging a room; fork by pulling a column apart; pipe by dragging a tile | 4 |
| Worth making with again | Anyone with 5–10 agent chats open recognizes the pain in one sentence | 3.5–4 |
| It clicks fast | The sentence above; first 3 s of video show columns, a packet, a walk | 4.5 |

Not scored, so do not spend time on: business model, slides, video polish, number of tools.

---

## 3. The rule you must handle first: "All code is written during the event"

The organizers' brief says: *"All code is written during the event. Credit any template, library or reused work."* and the rubric's rule list repeats it. This repo contains a working wireframe written the night before. Three honest ways to handle it; pick one at check-in (ask Sissi or Iana, 9:00–9:30) and write the answer in the README:

1. **Credited starter (recommended, if the organizers say yes).** Declare `cEverything starter, commit <hash>, written pre-event by Lukas with an AI assistant` in the README "Credits" section and in the form's *sponsor tools / reused work* field. Then spend the day on what is not here: headset integration on real devices, voice, the demo beats, polish, and the recording. The git log timestamps show exactly what was done during the event.
2. **Spec, not code.** Treat tonight's build as the reference implementation and retype the project from the design docs during the event, module by module, copying no file verbatim. Expect ~3 h for the floor set (columns, LOD, select, voice, pipe, fork, place). The judges' panel estimated the "zero application code tonight" stance as the only one with no exposure.
3. **Hybrid.** Keep only the generic parts as the credited starter (server static hosting, WebSocket hub, fixture replayer, Hermes normalizer, tests), retype the three.js scene and the XR input during the event. This keeps the parts that make the project *this project* inside the event window.

Whatever you pick: never present pre-event work as event work, and credit three.js (MIT), ws, qrcode-terminal, Playwright, AssemblyAI, and the Hermes dashboard/API server by name.

---

## 4. Team and roles (2–4 people)

| Role | Owns | If only two people |
|---|---|---|
| A · Lukas · Director | server, Hermes adapter, protocol, narration, final calls | A = server + voice + video |
| B · XR engineer | web/input/xr.js, column interactions in-headset, LOD tuning at real scale | B = everything in web/ |
| C · Scene engineer | pylons, file tree, fx, fixtures, cues | fold into B; cut file-tree diff to a text card if late |
| D · Laptop side | HUD, desktop input, tunnel/QR, hardware booking, filming, uploads | fold into A |

Rule of the day: **anything not working in a headset by 15:00 is cut from the demo script, not fixed.**

---

## 5. Hour by hour (Pacific)

Assumes option 1 or 3 from §3. If you chose option 2 (retype), shift the "integrate" column to "build", keep the slot times, and drop pylons/file tree to the 15:00 cut list.

| Time | Who | Do | Done when |
|---|---|---|---|
| 9:00–9:30 | all | Check in, breakfast, **ask the organizers about the pre-event starter (§3)**, sign the hardware agreement in the portal, bring the laptop online: phone hotspot + venue Wi-Fi, tunnel up, QR on screen | Portal sign-in works; tunnel URL opens on a phone over cellular |
| 9:30–10:30 | all | Talks. D books: **Quest 3S 11:00–11:30**, **Vision Pro 11:30–12:00** (30-min morning slots are first come). B installs the Immersive Web Emulator in laptop Chrome | Two morning slots confirmed |
| 10:30–11:00 | all | Kickoff: `npm start` in fixture mode on the laptop; everyone opens the room on their laptop; agree the name; A writes the README credits paragraph; C starts cue tuning | Six columns grow on every laptop; name chosen |
| 11:00–11:30 | B+D | **QUEST SLOT 1.** Open the URL in Quest Browser, Enter AR. Checklist: page loads over tunnel (yes/no), import map OK, WebXR starts, columns at the right height, select on controller and on hands, reading-height recenter, `debug3d` shows input indices, capture button records 10 s **and passthrough is not black** | Checklist written down; a 10 s test clip exists |
| 11:30–12:00 | B+A | **VISION PRO SLOT 1.** Open the tunnel URL in Safari, Enter immersive-vr. Checklist: WSS connects (yes/no), transient-pointer `selectstart` arrives (which indices), getUserMedia survives immersion (yes/no), Web Speech present (yes/no), lean-LOD readable, summon works, Control Center screen recording works | Checklist written down by 12:00 |
| 12:00–12:30 | all | Fix the two checklists' failures. D: desktop HUD polish, approval card, cue keys 1–5, reset key R | Both checklists green except known-unfixable items |
| 12:30–13:00 | all | Lunch at desks. **12:55 sharp:** reserve **Quest 3S 14:00–16:00**, **Vision Pro 16:00–17:00** (after 13:00 a team holds one unit at a time, up to 2 h) | Reservations confirmed by an organizer |
| 13:00–14:00 | B: pipe/fork/move drag state machine in the emulator · A: AssemblyAI relay + mic worklet · C: packet/diff beats on cues · D: two-laptop sync test, top-down view | Two laptop tabs stay in sync for move, fork, pipe, approve |
| 14:00–15:00 | B wears, A voice, C fixes, D laptop | **QUEST RESERVED.** Integrate in-headset: gaze dwell, grab thresholds, LOD at real scale, voice end to end (look at a column, hold left pinch, speak, release, tile appears on headset and laptop) | Voice works 3 times in a row; pipe and fork by hand 3 times in a row |
| 15:00 | all | **FEATURE FREEZE.** Cut anything not working in-headset. Rehearse the 55 s script twice | Script fits in 55 s with no retries |
| 15:30–15:45 | B wears, D films | **RECORD TAKE 1** through the Quest (passthrough with the laptop and teammate in frame). If capture is black: D films the wearer with a phone with the laptop screen in frame | Sub-60 s .mp4 copied to the laptop |
| 15:45–16:00 | D desk, A docs | Return Quest, collect Vision Pro. README credits final; `git tag take1` | Tag pushed |
| 16:00–17:00 | B wears, D speaks | **VISION PRO RESERVED.** Pinch-select, summon, lean-LOD; voice via the device if it survived immersion, else **"headset looks, laptop speaks"** (D holds Space and talks to the column the wearer is gazing at). Record a 5–10 s Control Center clip | A clip exists; voice fallback verified end to end |
| 17:00–17:45 | B wears, D edits | Re-reserve Quest if free; **TAKE 2** with the Vision Pro clip cut in (one cut, no slides). Else TAKE 1 is final. **17:45 CODE FREEZE**, `git tag submission`, push | Video ≤ 60 s uploaded (YouTube unlisted / Drive "anyone with the link"), link tested in a private window on a phone |
| 17:45–18:20 | all (humans fill the form) | Team fills the form themselves (§10). Set up the expo table: laptop, tunnel, Quest reserved 18:30–20:30, phone hotspot, chargers | Form submitted with confirmation before 18:20 |
| 18:20–18:30 | all | Buffer. Three clean 90 s judge walkthroughs at the table | Battery > 60 %, reset key works |

---

## 6. Hardware plan

- Morning (before 13:00): 30-minute slots, everyone gets a turn; try both headsets early so the unknowns are written down by noon.
- From 13:00: a team commits to the hardware it keeps (reserve in the portal, up to 2 h, one reservation at a time) and returns the rest. Nothing leaves the desk without the volunteer marking it checked out. Return everything before 21:00. The borrower pays for loss or damage.
- Headset handover (expo): removing a Quest ends the immersive session. Runbook: wake → tap ENTER on the 2D page → hand over, under 15 s. The 2D page shows connection and mic status so you know it is live before handing it over.
- Height: the newest tile sits at 1.3 m for a standing user. Seated judge: press C on the laptop (recenter) or pinch-hold the floor for 1 s.

## 7. Network plan

WebXR needs a secure context. Localhost is fine on the laptop; the headsets need HTTPS.

1. **Preferred: a named tunnel with a stable, short URL and a real certificate**, set up tonight and tested from a phone: `cloudflared tunnel` with a named tunnel on your own domain, an ngrok static domain, or Tailscale Serve/Funnel. A random trycloudflare URL changes on every restart and must be retyped into two headsets; avoid it.
2. **Quest-only fallback: LAN + self-signed HTTPS** (`npm run start:tls`; Quest Browser lets you proceed past the warning). Safari on Vision Pro may refuse WSS to a self-signed host even after accepting the page; do not rely on it there.
3. **Venue Wi-Fi may isolate clients**: bring a phone hotspot as the team network. The server prints its LAN URL and a QR code on start; keep the QR on the laptop screen and print the URL on a card for the expo table.

## 8. Voice plan (speech is our second body input)

- Laptop Chrome: Web Speech API, hold Space to talk, target = selected column or the column the headset wearer is looking at.
- Quest Browser has **no** Web Speech API: mic → AudioWorklet (16 kHz PCM16) → our server → **AssemblyAI realtime** (sponsor; credits activate on Oct 17 via the signup link; put the key in `.env`, never in git). Request the mic on the 2D page before entering XR.
- Vision Pro: unverified whether the mic survives immersion; plan the same path, test at 11:30, and keep **"headset looks, laptop speaks"** as the first-class fallback (gaze + voice across two people is still two body inputs and a real collaboration moment).
- Every transcript shows as a pending gray tile with a 2 s countdown before it sends; any pinch or click cancels. Never show a canned phrase palette as "voice".

## 9. Risk register (top ten)

| Risk | Likelihood | Mitigation | Fallback |
|---|---|---|---|
| Headsets cannot reach the laptop (secure context, client isolation) | high | named tunnel tested tonight; hotspot; QR | Quest on LAN self-signed; Vision Pro appears only as a short clip |
| Vision Pro quirks: immersive-vr only, pinch at input indices 2/3, 1.5 m immersion boundary, mic in immersion | high | controllers 0..3, select-ray targeting, lean + summon instead of walking, no hand-tracking by default, 11:30 try slot | Vision Pro = 5–10 s pinch-select clip; Quest is the primary device |
| Quest capture records passthrough as black | medium | test a 10 s clip at 11:00 | phone films the wearer with the laptop in frame; or `?mode=vr` with the floor grid |
| No live Hermes at the venue (it pins Python 3.14; no API key) | high | fixture replay is the default and the demo; live adapter validated against saved exports; floor label says so | all-fixture demo, said out loud and on the floor |
| Frame-rate collapse from text textures | medium | one InstancedMesh for far tiles, pooled textures, 60 tiles per column + spire | 5 columns, 40 tiles each |
| Pinch/grab flaky or drops on the wrong column | medium | system select events, 0.5 m drop radius, right hand grabs / left hand talks | controllers on Quest; laptop performs pipe/fork while the headset gazes and speaks |
| Voice path fails (key, Wi-Fi, mic permission) | medium | mic before XR; relay built by 14:00; laptop Web Speech independent | "headset looks, laptop speaks"; keyboard |
| Reservation contention at 17:00 | medium | book at 12:55 sharp; TAKE 1 at 15:30 inside the guaranteed slot | TAKE 1 is the submission video |
| Scope creep (10 interactions, 3 pylons, voice, presence) | high | P0 columns+LOD+gaze+select+speak · P1 pylons+diff · P2 pipe+fork · P3 presence+top-down; 15:00 freeze | ship P0+P1; pipe/fork from the laptop while the headset watches |
| "Code written during the event" challenge | low–medium | §3 decided at check-in, credits in README and form, git timestamps | retype the scene from the spec (option 2) |

## 10. Submission (the team types this; the organizers ask that agents do not fill the form)

Facts to have ready: team name · project name · one or two sentences (use §1) · track **Open** (+ sponsor prize entered: AssemblyAI if the voice path shipped; do not enter ElevenLabs unless TTS shipped) · spatial output: **WebXR on Meta Quest 3S (passthrough) and Apple Vision Pro (immersive), same URL** · body inputs: **walking (position), head gaze, hand pinch, voice** · sponsor tools: AssemblyAI streaming STT (if used) · demo video link (anyone with the link; test in a private window) · GitHub repo (this one; README credits complete) · per member: name, email, GitHub, LinkedIn · consent statement (every member).

Honesty lines to say out loud and keep in the video: "This run is a recorded fixture replay; the live adapter reads Hermes's dashboard API." "Summaries are extractive, not model-generated." "Gaze is a head ray, not eye tracking."

## 11. Demo video (under 60 s, no slides, filmed through the Quest; optional Vision Pro clip)

0–3 s: columns stand around the real table; the nearest fires an amber packet to the browser pylon. "Every Hermes agent I have running is a column in my room."
3–8 s: walk 1.5 m to the middle column; bars become summaries, then text; look up, it rises overhead. "Walk up and it reads itself. Step back and it's a skyline."
8–15 s: the red pulsing column. Gaze, hold left pinch: "Yes, go ahead and run the tests." Release. White tile appears, ring turns green, packet to the terminal pylon.
15–25 s: pinch a cyan tile on column 2, drag, drop on column 4. "Send this answer into the other agent." Packet, new tile, column 4 starts working, file node flashes, the diff card opens.
25–33 s: pull column 4's title plate sideways: ghost column follows; release. "Fork it." Dashed line to the parent.
33–48 s: pan to the real laptop. Teammate types; the tile appears in-headset as they hit Enter. Teammate presses T and drags a column in the top-down view; it slides across the floor in the headset. "Same room, same state. They type and arrange on the laptop; I look, speak and pull things apart in the headset."
48–55 s (optional): Vision Pro Control Center clip: same room, pinch-select opens a detail plane; the laptop's hover outline is visible.
55–60 s: wide shot, floor label in frame. "This run is a recorded fixture replay. The live adapter reads Hermes's dashboard API. Everything you saw ran in the headset."

Capture: Quest capture button (test for black passthrough at 11:00); Vision Pro Control Center screen recording; phone as the second source. One cut maximum, no music, no slides.

## 12. Expo table runbook (90 s per judge)

1. Laptop shows the room in top-down view + the QR; Quest awake on the 2D page with ENTER ready. Say the one sentence.
2. Judge puts the Quest on (teammate taps ENTER first). They see the legend sprite at spawn and the floor label.
3. Teammate on the laptop: "Look at the red one and say yes." (If voice is down: "Look at it, I'll speak for you.")
4. Judge drags a tile between columns; teammate presses T and moves a column; both see it.
5. Judge takes the headset off → teammate presses **R** (reset to demo start) and taps ENTER before the next judge.
Keep the honesty line in every walkthrough. Keep the headset on charge between judges.

## 13. Sponsor alignment (claim only what ships)

- **AssemblyAI** (Navigate-track sponsor, credits for every participant): our Quest voice path streams mic audio through the server to AssemblyAI realtime. Enter "Best use" only if it runs in the headset at the expo.
- **ElevenLabs**: stretch only (speak the agent's final reply from the column position). Do not claim unless it ships.
- **Miro**: Open-track sponsor. If the team plans the floor layout on a Miro board, say so; it is not in the product.
- **Auki posemesh** (shared room coordinates across devices): a natural future step for co-located AR; not used; say so if asked.
- **Pupil Labs Neon**: our gaze is a head ray; never call it eye tracking.

## 14. Tonight's checklist (laptop)

- [ ] `npm install && npm test && npm run smoke` pass; `npm start` shows the room on the laptop.
- [ ] Named tunnel (cloudflared/ngrok/Tailscale) with a stable HTTPS URL; open it from your phone on cellular; keep the command in RUNBOOK.md.
- [ ] Phone hotspot tested with the laptop; chargers, USB-C cable, Bluetooth keyboard (typing URLs in headsets), a printed URL card.
- [ ] Immersive Web Emulator extension in Chrome; try pipe/fork/move with the emulated controllers.
- [ ] AssemblyAI account; key in `.env` (`ASSEMBLYAI_API_KEY=`), never committed.
- [ ] If you have a Hermes host: `hermes dashboard` on the laptop, set `API_SERVER_ENABLED=true`, `API_SERVER_KEY=…` in `~/.hermes/.env`, run `hermes gateway`; test `npm run start:hermes`. Record 2–3 real sessions with `GET /api/sessions/{id}/export` into `fixtures/raw/` and convert with `scripts/export-to-fixture.mjs` (scrub secrets).
- [ ] Portal: accepted-email sign-in works, hardware agreement signed, team registered (2–4 people, one person per team).
- [ ] Read §3 and decide which option you will ask the organizers about at 9:00.
- [ ] Sleep.
