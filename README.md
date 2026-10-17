# cEverything — AI Harness in VR

Every Hermes agent session you have open stands as a **column in your room**: walk up to read it, look at it and speak to steer it, drag a message from one column to another to connect them, pull a column apart to fork it. Your laptop teammate loads the **same URL** and types, approves and arranges in the very same room.

Built for the MOLTEN spatial hackathon (LA Tech Week, Oct 17 2026), Open track: *"How do you build together when one person has a headset and the other a laptop?"*

Functional wireframes: boxes, lines and text. The visual pass comes after the first iteration.

## What you see

- **Columns**: one per agent session; newest message at reading height, older messages stacking upward into the sky. White = you, cyan = the agent, violet = thinking, amber = tool calls. A red beacon means the session is waiting on you.
- **Level of detail by distance**: far away a column is a colored barcode; closer, one-line summaries; up close, the text. Pinch a tile for the full message.
- **Tool calls fly**: web searches shoot a packet to the browser pylon, commands to the terminal pylon, file edits to a 3D file tree that shows the diff.
- **Glance**: each column's base shows its status ring, current activity, last eight tool categories and counts, so ten sessions read at a glance.
- **Shared room**: laptop and headsets mirror one authoritative state over a WebSocket. Pipe, fork, move and approve from either device; see each other's head, hands, gaze and hover.
- **Voice**: hold to talk at the column you are looking at (laptop: Web Speech; Quest: mic → server → AssemblyAI; Vision Pro: tested on the day, with "headset looks, laptop speaks" as the fallback).

## Run it

```bash
npm install
npm start                       # fixture replay (default): http://localhost:8787 — the room runs with zero external services
npm run start:tls               # same over self-signed HTTPS for a Quest on the same LAN (accept the browser warning)
npm run start:hermes            # live: reads a local `hermes dashboard` (127.0.0.1:9119); writes via the Hermes API server (127.0.0.1:8642, needs HERMES_API_KEY)
npm test && npm run smoke       # node tests + headless Chromium smoke test (desktop view)
```

Headsets need HTTPS. Use a tunnel with a real certificate (cloudflared named tunnel, ngrok static domain, Tailscale Serve) and open the printed URL / QR code in Quest Browser or visionOS Safari, then tap ENTER. See `docs/RUNBOOK.md`.

Flags: `--port 8787 --host 0.0.0.0 --tls --source fixture|hermes --fixture fixtures/demo --speed 4 --public-url https://…`.
Env: `ASSEMBLYAI_API_KEY`, `HERMES_DASHBOARD`, `HERMES_API`, `HERMES_API_KEY`.
Query flags on the page: `?mode=vr|ar`, `?hands=1`, `?scale=0.66`, `?debug=1`, `?judge=1`, `?name=Lukas`.

Laptop keys: Enter send · Space hold to talk · F fork · P pipe · S summon · T top-down · C recenter height · V spectator (follow the headset) · R reset demo · D debug console · 1–5 demo cues · Esc close detail.

## Repo map

| Path | What |
|---|---|
| `server/` | Node 22 static host + WebSocket hub, canonical state, fixture replayer, Hermes live adapter, speech-to-text relay |
| `web/` | three.js 0.170 WebXR client (plain ES modules via import map; no bundler) |
| `fixtures/demo/` | six recorded-style Hermes sessions that drive the demo without a live agent |
| `docs/` | `MOLTEN_STRATEGY.md` (the plan), `DESIGN.md`, `PROTOCOL.md`, `CONTEXT.md`, `RUNBOOK.md` |
| `test/` | node:test suites and the Playwright smoke test |

## Honesty

The default run is a **recorded fixture replay** and the room says so on the floor. The live adapter reads Hermes's dashboard REST API and writes through its API server; it was validated against saved session exports, not a live model, before the event. Summaries on the tiles are extractive (first sentence / tool name + argument), not model-generated. "Gaze" is a head ray, not eye tracking.

## Credits

- Pre-event starter: this repository at commit `<fill in at check-in>` was prepared the night before the event by Lukas Ferrer with an AI coding assistant (Claude). It is declared as reused work per the MOLTEN rules; everything built on event day is in the git log after 10:30 PT on Oct 17.
- [three.js](https://threejs.org) (MIT), [ws](https://github.com/websockets/ws) (MIT), [qrcode-terminal](https://github.com/gtanner/qrcode-terminal) (Apache-2.0), [Playwright](https://playwright.dev) (Apache-2.0).
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research, MIT) dashboard and API server; [bighelp](https://github.com/promptclickrun/bighelp) for the tool-category mapping idea.
- Speech-to-text: [AssemblyAI](https://www.assemblyai.com) streaming (MOLTEN sponsor credits).

MIT License.
