# RUNBOOK.md — running cEverything on the day

Everything below was exercised in the integration pass on this repo (Node 22, headless Chromium). Headset steps are
marked **[device]** where they could not be executed here; see the last section before promising anything on stage.

## 0. Sixty-second checklist

```bash
npm install                          # once (three@0.170, ws, qrcode-terminal, playwright)
npm test                             # 44 node tests, ~18 s
npm run e2e                          # smoke (screenshots) + two laptop clients in sync + XR-layer shape test, ~4 min
npm start                            # fixture replay at 4×, http://localhost:8787 — the room runs with no network at all
```

Open http://localhost:8787/ in Chrome, click **Open on laptop**, press `?` for the key map. Seven columns, the
pylons, the file tree and the floor label `FIXTURE REPLAY` are in view within two seconds.

## 1. Laptop (operator)

```bash
node server/index.js [--port 8787] [--host 0.0.0.0] [--tls] [--source fixture|hermes]
                     [--fixture fixtures/demo] [--speed 4] [--no-loop] [--paused] [--public-url https://…] [--no-qr] [--quiet]
```

- The banner prints every URL (localhost + each LAN interface) and a QR code of the first non-localhost URL
  (or of `--public-url` when given). `/health` answers JSON with the source label, speed, loop index and client count.
- A `.env` in the repo root is read at startup and never overrides real environment variables:
  `ASSEMBLYAI_API_KEY`, `HERMES_DASHBOARD`, `HERMES_API`, `HERMES_API_KEY`, `HERMES_PROFILE`, `HERMES_WS=0`,
  `ASSEMBLYAI_STREAMING_URL`.
- Page flags: `?name=Lukas` (shown on your avatar) · `?scale=0.66` (small booth: scales x/z and the LOD thresholds) ·
  `?judge=1` (hides stats, fixture controls and "needs you" toasts) · `?debug=1` (in-room console) · `?mode=vr|ar` ·
  `?hands=1` · `?device=quest|visionpro` (force detection) · `?voice=webspeech|server|none`.
- Two laptops, or a laptop and a headset, simply open the same URL. Presence (camera pyramid / head cone, hover
  outline, gaze) is relayed at 10 Hz; every command becomes one event stream everyone applies. `test/two-clients.mjs`
  proves it: move, fork, pipe, approve and reset issued on page A appear in page B's store and scene.

### Key map (laptop)

| key | action |
|---|---|
| click column / tile | focus the session · select the tile (full text, args, diff in the right panel) |
| drag tile → other column | **pipe** the message (`[from <title>]: …` grows on the target) |
| select tile, `P`, click column | pipe without dragging |
| drag base plate | **move** the column (everyone sees it slide) · `T` top-down view makes arranging ten columns a 10-second job |
| `F` / drag title plate > 0.5 m | **fork** the focused session (lands 0.8 m to the right, dashed lineage line) |
| `S` / double-click | summon the column in front of you (0.9 m on Quest/laptop, 0.65 m on Vision Pro, less with `?scale<1`: always inside the full-text band; local only); again sends it back |
| wheel over a column · `PageUp`/`PageDown` · `Home` | scroll older messages into reading height (local) · back to newest |
| `Enter` / `Shift+Enter` | send the compose box to the focused session · newline |
| hold `Space` | push-to-talk (Chrome Web Speech) into the focused session; a dashed pending tile shows the transcript, sends after 2 s, any click cancels |
| Approve / Deny buttons | resolve a red `waiting_on_you` column (fixture: scripted continue; live: "yes"/"no" chat) |
| `1` `2` `3` `4` `5` | demo cues: **needs_you** · **web burst** · **patch** (diff card) · **delegate** (child column) · **done** — on the focused column, else a random suitable one |
| `R` / reset button | **demo reset**: drops judge-made forks, piped tiles and moved columns, restores layout.json, replays from the top |
| `C` | recenter reading height to camera height − 0.3 (seated judges) |
| `V` | spectator: follow the headset wearer's head (what the judge sees, on the laptop screen) |
| `D` | in-room debug console (last 8 console lines + XR input-source info) |
| `H` · `?` · `Esc` | hide side panels · help · close detail / leave pipe mode |
| pause / play / speed / reset (top bar) | fixture clock; the same controls exist as `fixture.control` commands |

### Take-start state

`R` then wait: at 4× the write-readme spire appears within ~8 s, the first web burst hits the browser pylon within 15 s,
deploy-staging parks red (approval) at ~30 s, the orchestrator delegates at ~13 s and its child wakes next to it. The
story is 241 s long at 1× and loops (ids get a `~N` suffix, columns keep growing); a cued `needs_you` column stays
parked across loop boundaries until someone approves or denies it.

## 2. Quest 3S over the LAN (self-signed HTTPS)

WebXR needs a secure context, and Quest Browser accepts a self-signed certificate after a warning.

```bash
npm run start:tls            # = node server/index.js --tls
```

1. First run prints the exact `openssl req …` command it used and writes `certs/server.{key,crt}` with
   `subjectAltName = DNS:localhost, IP:127.0.0.1, IP:<every LAN IPv4 at that moment>`. If the laptop changes network,
   `rm -rf certs` and restart so the SAN matches (`scripts/make-cert.sh [extra-ip]` does the same by hand).
   Verified here: `curl -k https://127.0.0.1:8796/` → `HTTP 200 text/html`, `openssl x509 -ext subjectAltName` shows the
   LAN IP.
2. Quest and laptop on the same Wi-Fi / hotspot (venue Wi-Fi often isolates clients: the phone hotspot is the fallback).
3. Quest Browser → the `https://<LAN-IP>:8787/` URL from the banner (scan the QR with the Quest camera or type it) →
   "Your connection is not private" → **Advanced → Proceed**.
4. Tap **ENTER XR** on the 2D page. It asks for the microphone first (keep it; the stream stays alive into the
   session), then requests `immersive-ar` (passthrough, no Guardian boundary) with `hand-tracking` optional. If the
   permission prompt took long enough that the browser lost the tap's activation, the button says
   **ENTER XR (tap again)**: the second tap enters immediately (the mic stream is already live).
5. Hands or controllers: right pinch/trigger selects, grabs, pipes, forks and moves; **left** pinch or squeeze is always
   push-to-talk — on the mic sphere or nothing it talks to the gazed/focused column, on any part of a column it talks to
   that column (the left hand never grabs or approves). Look at a column 200 ms to gaze-highlight it. A base pinch-hold
   becomes a column move only once the ray's floor point travelled > 15 cm (hand drift keeps it a summon hold); taps
   count up to 600 ms, the beacon approve only as a quick pinch (< 250 ms).
6. Handover (judge takes the headset off → the immersive session ends): wake → the page shows **RE-ENTER XR** →
   tap → hand over. Under 15 s; the WebSocket resumed from `lastSeq` meanwhile, nothing is lost.
7. `?mode=vr` records with the floor grid if Quest capture renders passthrough as black (rehearse the phone-filmed
   fallback anyway).

## 3. Vision Pro (visionOS Safari) through a tunnel

Safari does not accept the self-signed certificate; use a tunnel with a real certificate (WebSockets pass through).

```bash
npm start                                                   # plain HTTP on the laptop
cloudflared tunnel --url http://localhost:8787               # prints https://<random>.trycloudflare.com
node server/index.js --public-url https://<random>.trycloudflare.com   # restart so the banner + QR carry the public URL
```

A named tunnel / ngrok static domain / Tailscale Serve gives a short stable URL (quick-tunnel URLs change on every
restart and are painful to retype on a headset keyboard). Then in Safari: open the URL → the big button reads
**ALLOW MIC** (Safari re-prompts for the microphone on every page load and keeps a tap's activation for only ~1 s, so
the first tap is spent on the mic + AudioContext alone) → answer the prompt → the button becomes **ENTER XR** → tap →
`immersive-vr` (Vision Pro has no WebXR passthrough). Rules that are already in the code: no `hand-tracking` unless
`?hands=1` (keeps transient pointers at indices 0/1); the select ray at `selectstart` is the targeting truth, head
gaze is cosmetic; sit or stand still, lean and **summon** (pinch-hold a base 0.6 s; the column glides to 0.65 m on
Vision Pro, inside the full-text band) instead of walking — visionOS fades immersive content after ~1 m of head
movement and exits beyond ~1.5 m. The detail plane (gaze + pinch a tile) opens 0.85 m from the head, to the right of
the line of sight, so its text is readable from the seat. Voice on Vision Pro is unverified: if the mic
sphere turns gray or `mic:` on the landing page is not `ok`, run the beat as **headset looks, laptop speaks** (the
wearer's gazed column is broadcast; the laptop teammate holds `Space` and talks; the text lands on that column).

## 4. Switching to live Hermes

```bash
# on the machine running Hermes
hermes dashboard                                  # REST on http://127.0.0.1:9119 (loopback, no auth)
API_SERVER_ENABLED=true API_SERVER_KEY=<key> hermes gateway   # writes on http://127.0.0.1:8642
# in this repo
cat > .env <<EOF
HERMES_DASHBOARD=http://127.0.0.1:9119
HERMES_API=http://127.0.0.1:8642
HERMES_API_KEY=<key>
EOF
npm run start:hermes                              # = node server/index.js --source hermes
```

- The floor label and the HUD badge read `LIVE: hermes@127.0.0.1`, `LIVE (polling only)` when the optional `/api/ws`
  token stream is unavailable, or `LIVE (hermes unreachable @…)` while the dashboard is down (the adapter keeps
  retrying every 5 s and the room stays up). Reads: sessions at 1 Hz, messages per session at 1 Hz, normalised by
  `server/sources/normalize.js` (thinking before assistant, one tile per tool call, secrets redacted).
- Writes go through the API server: send → `POST /api/sessions/{id}/chat`, fork → `/fork`, new → `POST /api/sessions`,
  approve → a "yes"/"no" chat message. Without `HERMES_API_KEY` every write answers `source_unavailable` and the HUD
  says so; nothing is ever faked in live mode. `interrupt` is `not_supported` over REST. Fixture controls (pause,
  cues, reset) answer `not_supported`.
- Say out loud which mode is running; the honesty label is in every shot for that reason.

## 5. Voice paths

| device | path | how to confirm in the morning |
|---|---|---|
| laptop Chrome | Web Speech (`webkitSpeechRecognition`), no key needed, cloud-backed | hold `Space`, watch the dashed pending tile |
| Quest | mic → AudioWorklet 16 kHz PCM16 → `audio.*` frames → server → AssemblyAI Streaming v3 | `node scripts/stt-probe.mjs` with `ASSEMBLYAI_API_KEY` in `.env` (10 s; exit 0 = claim it) |
| Vision Pro | same as Quest if `getUserMedia` survives immersion **[device]**, else "headset looks, laptop speaks" | landing badge `mic: ok`, mic sphere white not gray |
| no key / no network | server answers `voice.unavailable`; headsets show "voice via laptop"; keyboard always works | the badge says so |

## 6. Demo reset and expo hygiene

- `R` (or the top-bar **reset**) removes every session including forks and cue children, replays `fixtures/demo`
  from the top with unsuffixed ids and restores `layout.json` placements and `pylons.json`; both headsets and the
  laptop see the same removal + rebuild (asserted in `test/two-clients.mjs`).
- `?judge=1` on the headsets hides debug UI; `?name=` labels avatars; `?scale=0.66` for a booth narrower than 4 m.
- Keep a charger at the station (90 min of Quest passthrough); `renderer.xr` runs at framebuffer scale 0.9.

## 7. Proven here vs. untested on device

Verified in this container (headless Chromium, SwiftShader; see `npm run e2e`): columns, LOD planes, pylons, file
tree + diff card, presence avatars and hover outlines across two clients, move/fork/pipe/approve/reset propagation,
reconnect with `lastSeq` replay, zero console errors, no request to any host but the server, import map + vendored
three.js (`XRButton.js`, `OrbitControls.js`) loaded with 200, TLS with a SAN certificate, the gesture state machine
driven by synthetic rays, voice pending tile + countdown + `send {via:'voice'}`, Hermes adapter against a mock
dashboard/API, AssemblyAI engine failing closed against a dead endpoint.

**Untested on a real headset (needs the first device slot):**

- Entering `immersive-ar` / `immersive-vr` through `requestSession` and through Quest Browser's offer prompt; the
  AR background swap; `local-floor` origin height.
- XRSession-level `select*`/`squeeze*` events and `frame.getPose` rays — Vision Pro transient pointers at indices 0/1
  (2/3 with `?hands=1`), controller-vs-session de-duplication timing, controller ray visibility.
- Hand-tracking joint spheres and the system pinch firing `select` on Quest; gamepad haptics.
- Gesture thresholds (tap ≤ 600 ms, beacon approve < 250 ms, hand travel 3 cm, carry 9 cm, base/floor hold judged by
  ≤ 15 cm of floor-point travel, summon 0.6 s, recenter 1 s, fork pull 0.5 m, pipe drop 0.5 m) and the mic sphere's
  reach; head-gaze dwell with real head motion; the summon distance feel (0.9 m Quest, 0.65 m Vision Pro) and the
  detail plane's legibility at 0.85 m from the head.
- The two-tap entry on visionOS Safari (**ALLOW MIC** → **ENTER XR**) and the one-tap bounded probe on Quest Browser;
  `getUserMedia` surviving immersion (visionOS Safari and Quest Browser), the AudioWorklet resampler on a real mic,
  AssemblyAI with a real key (the probe script exists; the turn-accumulation logic is mock-tested only), Web Speech on visionOS.
- Presence head/hands/ray sent from a headset; the RE-ENTER flow after the headset sleeps; 72 fps on Quest 3S with
  7–10 columns; legibility of the 512 px tiles at 0.9 m; Quest capture of passthrough.
- Hermes `/api/ws` token streaming against a live gateway (polling is the verified path).

Debugging without a cable: `?debug=1` (or `D` on the laptop) shows the in-room console; every select prints
`#index targetRayMode handedness [profiles] via session+frame|controller`. Expect `transient-pointer` at `#0/#1` on
Vision Pro; if a select is seen only `via controller`, the session-level listener did not fire.
