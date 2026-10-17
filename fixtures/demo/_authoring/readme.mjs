// write-readme (s_readme): a finished session (status done) with 90+ messages so the spire / "+N earlier" path is
// exercised. Mostly short user/assistant exchanges plus read_file / write_file / patch calls; ends with attention done.
import { SessionWriter, T0, diff, newFileDiff, hunkStrings, patchedSummary, hermes } from './lib.mjs';

const DRAFT = `# cEverything — every AI-agent chat you have open stands as a column in your room

Walk up to a column to read it, look at it and speak to steer it, drag a message from one column to another to connect them — while your laptop teammate types, approves and arranges in the very same room.

## What the judge sees

- One wireframe column per Hermes session, up to ten, on an arc around you.
- Bars from afar, one-line summaries at two metres, full text when you step in.
- Packets fly to three landmarks: the browser pylon, the terminal pylon, the codebase tree.
- A red pulsing ring means a session needs you.

## Run it

    npm install
    npm start                      # fixture replay on http://localhost:8787
    npm run start:tls              # self-signed HTTPS for headsets on the LAN
    HERMES_DASHBOARD=http://127.0.0.1:9119 npm run start:hermes   # live

Flags: --port, --host, --tls, --source fixture|hermes, --fixture fixtures/demo, --speed 4, --no-loop, --public-url.

## Two devices, one room

The laptop person types, reads diffs flat, approves and arranges the floor plan. The headset person glances, walks, looks-and-speaks, pipes and forks. Both mirror one scene held by the Node hub.

## Controls

| action | headset | laptop |
|---|---|---|
| inspect tile | gaze + pinch | click |
| pipe | pinch-hold tile, drop on column | drag tile onto column |
| fork | pull the title plate sideways | F |
| move column | pinch-hold base, drag | drag base, T for top-down |
| talk | hold left pinch / squeeze | hold Space |

## Honesty label

The floor says FIXTURE REPLAY or LIVE: hermes@host. It is in every shot.

## Credits

three.js, ws, qrcode-terminal, AssemblyAI streaming, promptclickrun/bighelp (tool categories).
`;

function patchReadme(w, row, oldStr, hunk) { // oldStr documents the anchor; args come from the hunk
  const d = diff('README.md', [hunk]);
  const c = w.toolCall(600, 'patch', { path: 'README.md', ...hunkStrings(hunk) }, { rowId: row, meta: { path: 'README.md', diff: d } });
  w.toolResult(500, c, { text: hermes.patch(d).text, summary: patchedSummary(d) });
  return d;
}

export function build() {
  const w = new SessionWriter({
    id: 's_readme', title: 'write-readme', status: 'tool', model: 'google/gemini-2.5-pro', gitBranch: 'docs/readme',
    activity: 'editing README.md', summary: 'Write the README.md for cEverything: pitch, what the judge sees, run, controls, credits',
    startedAt: T0 - 1_900_000,
  }, { seed: 67, pace: 0.8 });
  // Phase 1 (history catch-up): the first ~70 messages arrive quickly so the column shoots up at scenario start.
  let fast = true;
  const dt = (lo, hi) => fast ? w.jitter(180, 520) : w.jitter(lo, hi);
  const think = (text) => { const row = w.nextId(); w.status(dt(300, 600), 'thinking', 'thinking'); w.thinking(dt(2500, 6000), text, { forId: row }); return row; };
  const say = (text, row) => { w.status(dt(300, 600), 'responding', 'responding'); w.assistant(dt(700, 1800), text, { id: row }); };
  const ask = (text) => { w.user(dt(5000, 12_000), text); };
  const read = (path, opts, text, summary, row) => {
    w.status(dt(200, 500), 'tool', `reading ${path}`);
    const c = w.toolCall(dt(400, 900), 'read_file', { path, ...opts }, row ? { rowId: row } : {});
    w.toolResult(dt(400, 900), c, { text, summary, meta: { path } });
  };

  // ---- beat 1: brief + reading + first draft --------------------------------
  ask('Write the README.md for cEverything. Sections: one-sentence pitch, what the judge sees, how to run (fixture and live), the two-device story, a controls table, the honesty label, credits. Read the docs first; keep it under 200 lines.');
  let row = think('Seven sections, under 200 lines, and the voice should match DESIGN.md. Read package.json for the scripts, the top of DESIGN.md for the one-sentence pitch, PROTOCOL.md §1 for the CLI flags and §6 for the controls table, and CONTEXT.md for the platform facts I must not overstate.');
  w.status(dt(200, 500), 'tool', 'planning');
  let c = w.toolCall(dt(400, 800), 'todo_list', { todos: [
    { id: '1', content: 'Read docs: package.json, DESIGN.md, PROTOCOL.md §1/§6, CONTEXT.md', status: 'in_progress' },
    { id: '2', content: 'Draft README.md (7 sections, < 200 lines)', status: 'pending' },
    { id: '3', content: 'Iterate on feedback; verify links and line count', status: 'pending' },
  ] }, { rowId: row });
  w.toolResult(dt(200, 400), c, { text: '[ ] 1. Read docs  (in progress)\n[ ] 2. Draft README.md (7 sections, < 200 lines)\n[ ] 3. Iterate on feedback; verify links and line count', summary: '→ 3 todos tracked' });
  read('package.json', {}, '1: {\n2:   "name": "ceverything",\n3:   "version": "0.1.0",\n4:   "description": "AI Harness in VR: every Hermes agent session is a column in your room. WebXR (three.js) + Node WebSocket hub; laptop and headsets share one scene.",\n5:   "type": "module",\n9:   "scripts": {\n10:     "start": "node server/index.js",\n11:     "start:tls": "node server/index.js --tls",\n12:     "start:hermes": "node server/index.js --source hermes",\n13:     "test": "node --test test/",\n14:     "smoke": "node test/smoke.mjs"\n15:   },', '→ scripts: start, start:tls, start:hermes, test, smoke');
  read('docs/DESIGN.md', { offset: 5, limit: 4 }, '5: ## One sentence\n6: \n7: Every AI-agent chat you have open stands as a column in your room: walk up to read it, look at it and speak to steer it, drag a message from one column to another to connect them — while your laptop teammate types, approves and arranges in the very same room.\n8: ', '→ the one-sentence pitch');
  read('docs/PROTOCOL.md', { offset: 9, limit: 6 }, '9: package.json                deps: three@0.170.0, ws@8.18.0, qrcode-terminal@0.12.0; dev: playwright@1.56.1\n10: server/\n11:   index.js                  CLI: node server/index.js [--port 8787] [--host 0.0.0.0] [--tls] [--source fixture|hermes]\n12:                             [--fixture fixtures/demo] [--speed 4] [--no-loop] [--public-url https://…]\n13:                             prints the LAN + public URLs and a QR code (qrcode-terminal) at startup\n14:   http.js                   static server: web/ at /, node_modules/three at /vendor/three/, correct MIME types, no caching in dev', '→ CLI flags and the QR code line');
  read('docs/PROTOCOL.md', { offset: 251, limit: 14 }, '251: ## 6. Input mapping\n252: \n253: | action | Vision Pro | Quest (hands / controllers) | Laptop |\n254: |---|---|---|---|\n255: | focus / inspect tile | gaze + pinch (select) → detail plane | pinch / trigger on tile | click |\n256: | pipe | pinch-hold tile, carry, release over another column (0.5 m radius) | same | drag tile onto column, or select + P + click |\n257: | fork | pinch-hold title plate, pull > 0.5 m sideways, release | same | F on selected column (lands 0.8 m right) |\n258: | move column | pinch-hold base, drag on floor | same | drag base; T = top-down view |\n259: | summon (local) | pinch-hold base 0.6 s without moving | same | S (or double-click column) |\n260: | scroll history (local) | pinch-hold stack, move vertically | same; thumbstick | mouse wheel over column; Home |\n261: | push-to-talk | left pinch while left ray hits mic sphere/nothing | left pinch / left squeeze | hold Space |\n262: | approve | look at the red column, say "yes, go ahead" (voice) or select the beacon → approve | same | Approve/Deny buttons |\n263: | recenter height | pinch-hold floor 1 s | same | C |\n264: | other keys | — | — | Enter send · Shift+Enter newline · 1–5 cues · R reset · D debug · V spectator · Esc close detail |', '→ §6 input mapping table');
  read('docs/CONTEXT.md', { offset: 54, limit: 6 }, '54: - **Apple Vision Pro (visionOS 2+) Safari**: WebXR is **on by default** (no feature flag since visionOS 2). Supports\n55:   `immersive-vr` only (**no `immersive-ar` / passthrough via WebXR**). Input: **transient-pointer** (gaze + pinch; a ray\n56:   appears only while pinching) and optional **hand-tracking** (permission prompt; hands are pose-only, no events).\n57: - **Meta Quest 3S Browser**: WebXR `immersive-vr` and `immersive-ar` (passthrough) both work; hand tracking + controllers.\n58:   **Web Speech API `SpeechRecognition` is NOT exposed in Quest Browser** (developer reports). `getUserMedia` mic capture\n59:   works → stream audio to a server for STT (AssemblyAI realtime) as the voice path on Quest.', '→ platform facts: VP immersive-vr only; Quest has no Web Speech');
  say('I have the pitch, the run flags, the controls table and the platform facts. Drafting all seven sections now.', row);
  row = w.nextId();
  w.status(dt(200, 500), 'tool', 'editing README.md');
  const D0 = newFileDiff('README.md', DRAFT);
  c = w.toolCall(dt(500, 1200), 'write_file', { path: 'README.md', content: DRAFT }, { rowId: row, meta: { path: 'README.md', diff: D0 } });
  w.toolResult(dt(400, 800), c, { text: hermes.writeFile('README.md', DRAFT).text, summary: patchedSummary(D0, 'wrote') });
  say('Draft written: 48 lines, seven sections, the controls table has five rows. Tell me what to change.', row);
  w.status(dt(300, 600), 'idle', 'idle');

  // ---- short feedback beats ------------------------------------------------
  ask('Good start. The "What the judge sees" bullets: make the first one say "wireframe column per Hermes session, standing on a 1.8 m arc".');
  row = think('A wording change in the first bullet; the arc radius comes from PROTOCOL.md §5 so it is accurate.');
  patchReadme(w, row, '- One wireframe column per Hermes session, up to ten, on an arc around you.', { old: 7, new: 7, lines: [
    ' ## What the judge sees', ' ',
    '-- One wireframe column per Hermes session, up to ten, on an arc around you.',
    '+- One wireframe column per Hermes session, up to ten, standing on a 1.8 m arc around you.',
    ' - Bars from afar, one-line summaries at two metres, full text when you step in.',
  ] });
  say('Changed. The arc radius matches PROTOCOL.md §5.', row);
  w.status(dt(300, 600), 'idle', 'idle');

  ask('Add the QR step to Run it: the server prints a QR code of the public URL; headsets scan it instead of typing.');
  row = think('Confirm what the server prints before documenting it: search for qrcode in server/index.js.');
  w.status(dt(200, 500), 'tool', 'searching server/');
  c = w.toolCall(dt(400, 900), 'search_files', { pattern: 'qrcode|public-url|publicUrl', path: 'server/index.js', output_mode: 'content' }, { rowId: row });
  w.toolResult(dt(400, 900), c, { text: "server/index.js\n  4: import qrcode from 'qrcode-terminal';\n  58:   const publicUrl = args['public-url'] || `https://${lanIp}:${port}`;\n  61:   console.log(`\\n  LAN     ${lanUrl}\\n  public  ${publicUrl}\\n`);\n  62:   qrcode.generate(publicUrl, { small: true });\n\n4 matches in 1 file", summary: '→ 4 matches · prints LAN + public URL, then a small QR' });
  patchReadme(w, row, "Flags: --port, --host, --tls, --source fixture|hermes, --fixture fixtures/demo, --speed 4, --no-loop, --public-url.", { old: 20, new: 20, lines: [
    ' Flags: --port, --host, --tls, --source fixture|hermes, --fixture fixtures/demo, --speed 4, --no-loop, --public-url.',
    ' ',
    '+At startup the server prints the LAN URL, the public URL (pass `--public-url https://…` for a tunnel) and a QR code of it.',
    '+Scan the QR with the headset instead of typing a 30-character hostname on a floating keyboard.',
    '+',
    ' ## Two devices, one room',
  ] });
  say('Added two lines under Run it. The QR is of the public URL when `--public-url` is given, otherwise of the LAN URL.', row);
  w.status(dt(300, 600), 'idle', 'idle');

  ask('The controls table is missing the laptop-only keys: S summon, C recenter, R reset, D debug, V spectator, Esc.');
  row = think('Add two rows: summon/recenter as body actions with a laptop key, and an "other keys" row for the laptop-only list.');
  patchReadme(w, row, '| talk | hold left pinch / squeeze | hold Space |', { old: 37, new: 37, lines: [
    ' | talk | hold left pinch / squeeze | hold Space |',
    '+| summon column to you | pinch-hold base 0.6 s | S |',
    '+| recenter reading height | pinch-hold floor 1 s | C |',
    '+| other | — | Enter send · Shift+Enter newline · 1–5 demo cues · R reset · D debug · V spectator · Esc |',
    ' ',
    ' ## Honesty label',
  ] });
  say('Three rows added; the table now mirrors PROTOCOL.md §6.', row);
  w.status(dt(300, 600), 'idle', 'idle');

  ask('Credits: be explicit. three.js, ws, qrcode-terminal, AssemblyAI (sponsor), and promptclickrun/bighelp for the tool-category mapping, with a sentence each.');
  row = think('One line per credit, naming what we reuse from each, bighelp explicitly for the tool-name→category mapping as the judges asked.');
  patchReadme(w, row, 'three.js, ws, qrcode-terminal, AssemblyAI streaming, promptclickrun/bighelp (tool categories).', { old: 48, new: 48, lines: [
    ' ## Credits',
    ' ',
    '-three.js, ws, qrcode-terminal, AssemblyAI streaming, promptclickrun/bighelp (tool categories).',
    '+- **three.js** (r170) — rendering and WebXR session handling.',
    '+- **ws** — the WebSocket hub.',
    '+- **qrcode-terminal** — the startup QR code.',
    '+- **AssemblyAI** — streaming speech-to-text for the Quest voice path (sponsor credits).',
    '+- **promptclickrun/bighelp** — we reuse its tool-name → activity-category mapping for the glance colours.',
    '+- **Hermes** by Nous Research — the agent whose sessions stand in the room.',
  ] });
  say('Credits are now six explicit lines, bighelp named for the category mapping.', row);
  w.status(dt(300, 600), 'idle', 'idle');

  ask('Honesty label: say explicitly that nothing in the room pretends to be live when it is a fixture, and that the label is at the user\'s feet.');
  row = think('Expand the section to two sentences with the position from DESIGN.md.');
  patchReadme(w, row, 'The floor says FIXTURE REPLAY or LIVE: hermes@host. It is in every shot.', { old: 44, new: 44, lines: [
    ' ## Honesty label',
    ' ',
    '-The floor says FIXTURE REPLAY or LIVE: hermes@host. It is in every shot.',
    '+A floor label at the user\'s feet reads **FIXTURE REPLAY** or **LIVE: hermes@host**, so it is in every shot and nothing in the room pretends to be live when it is a recording.',
    '+Fixture sessions are hand-authored and contain no real credentials; the live adapter redacts anything that looks like a secret before it is broadcast.',
  ] });
  say('Done; the section now states both the position and the no-pretending rule.', row);
  w.status(dt(300, 600), 'idle', 'idle');

  fast = false; // ---- phase 2: conversational pace -------------------------------
  ask('Live mode needs its own subsection: the env vars, what is polled, and the degradation to polling-only when the WS is unavailable.');
  row = think('The live adapter facts are in PROTOCOL.md §4: HERMES_DASHBOARD, HERMES_API, HERMES_API_KEY, 1 Hz polling, optional /api/ws, and "LIVE (polling only)" on failure. Quote the env names exactly.');
  read('docs/PROTOCOL.md', { offset: 206, limit: 10 }, '206: ## 4. Hermes live adapter (server/sources/hermes.js)\n207: \n208: Env: `HERMES_DASHBOARD=http://127.0.0.1:9119`, `HERMES_API=http://127.0.0.1:8642`, `HERMES_API_KEY`, `HERMES_PROFILE?`.\n209: Read: `GET /api/sessions?order=recent&limit=12` at 1 Hz → `session.upsert`/`session.status`; for each listed session\n210: `GET /api/sessions/{id}/messages?order=latest&limit=60` at 1 Hz (stagger), diff by row `id`, run `normalize.js`, emit\n211: `message.add` + `tool.start`/`tool.complete`. Optional `ws://…/api/ws` (loopback, no ticket): after `gateway.ready` send\n212: `client.capabilities {server_requests:false}`, then map `event` notifications `message.delta`/`reasoning.delta` → `message.delta`\n213: on `<sid>:live` / `<sid>:live:r` streaming messages, `tool.start`/`tool.complete` → the same kinds. On any failure the adapter\n214: logs once, keeps polling, and sets `sourceInfo.label = "LIVE (polling only)"`. Writes: `send` → `POST /api/sessions/{id}/chat`\n215: `{message}`; `fork` → `POST /api/sessions/{id}/fork`; `new` → `POST /api/sessions`. No API key → `error source_unavailable`', '→ §4 live adapter: env, 1 Hz polling, WS optional, polling-only fallback', row);
  patchReadme(w, row, '## Two devices, one room', { old: 24, new: 24, lines: [
    '+### Live mode',
    '+',
    '+    HERMES_DASHBOARD=http://127.0.0.1:9119 HERMES_API=http://127.0.0.1:8642 HERMES_API_KEY=… npm run start:hermes',
    '+',
    '+The adapter polls the dashboard REST API at 1 Hz (`/api/sessions`, then each session\'s latest 60 messages), diffs rows by id and normalizes them into the same events the fixture emits. Token streaming over `/api/ws` is optional: if it fails the floor label switches to **LIVE (polling only)** and everything keeps working a second late. Without an API key, sending into a session returns `source_unavailable` and the HUD says so — live mode never fakes a reply.',
    '+',
    ' ## Two devices, one room',
  ] });
  say('Live mode subsection added under Run it, with the exact env names and the polling-only fallback spelled out.', row);
  w.status(dt(400, 800), 'idle', 'idle');

  ask('Check that every relative link and path mentioned in the README actually exists in the repo.');
  row = think('Extract backticked paths and markdown links, stat each one. A tiny node one-liner is enough; no new dependency.');
  w.status(dt(200, 500), 'tool', 'running: node -e (link check)');
  c = w.toolCall(dt(500, 1000), 'terminal', { command: `node -e "const fs=require('fs');const t=fs.readFileSync('README.md','utf8');const refs=[...t.matchAll(/\\\\]\\\\((?!https?:)([^)]+)\\\\)|\\\\x60((?:docs|server|web|fixtures|test|scripts)\\\\/[^\\\\x60 ]+)\\\\x60/g)].map(m=>m[1]||m[2]);let bad=0;for(const r of new Set(refs)){const ok=fs.existsSync(r);if(!ok)bad++;console.log((ok?'ok  ':'MISSING ')+r)}console.log(refs.length+' refs, '+bad+' missing');process.exit(bad?1:0)"` }, { rowId: row });
  w.toolResult(dt(800, 1500), c, { text: hermes.terminal('ok  docs/PROTOCOL.md\nok  docs/DESIGN.md\nok  fixtures/demo\nok  server/index.js\nok  web/index.html\nok  test/smoke.mjs\n6 refs, 0 missing\n').text, summary: '→ 6 refs, 0 missing', meta: { command: 'node -e (link check)', exitCode: 0 } });
  say('All 6 referenced paths exist. No external links to check yet; the tunnel URL is deliberately not in the README.', row);
  w.status(dt(400, 800), 'idle', 'idle');

  ask('Add a short "What we claim / what we don\'t" box: head gaze not eye tracking, Vision Pro path unverified until tested, voice needs internet.');
  row = think('Three honest bullets, placed right after the honesty label where a judge would look for caveats.');
  patchReadme(w, row, 'Fixture sessions are hand-authored and contain no real credentials; the live adapter redacts anything that looks like a secret before it is broadcast.', { old: 56, new: 56, lines: [
    ' Fixture sessions are hand-authored and contain no real credentials; the live adapter redacts anything that looks like a secret before it is broadcast.',
    ' ',
    '+### What we claim / what we don\'t',
    '+',
    '+- "Gaze" means **head gaze** (camera forward) everywhere; we do not use eye tracking. On Vision Pro the pinch ray *is* eye-directed, and that is what targets.',
    '+- The Vision Pro path (transient pointers, mic inside immersion) is unverified until it is tested on the device; the Quest path is the one rehearsed.',
    '+- Every voice path needs internet (AssemblyAI or Chrome\'s recognizer). Without it the keyboard is the floor, and the narration says "voice via laptop".',
    '+',
    ' ## Credits',
  ] });
  say('Caveat box added after the honesty label.', row);
  w.status(dt(400, 800), 'idle', 'idle');

  ask('Line count?');
  row = think('wc -l.');
  w.status(dt(200, 400), 'tool', 'running: wc -l README.md');
  c = w.toolCall(dt(400, 800), 'terminal', { command: 'wc -l README.md' }, { rowId: row });
  w.toolResult(dt(300, 600), c, { text: hermes.terminal('78 README.md\n').text, summary: '→ 78 lines', meta: { command: 'wc -l README.md', exitCode: 0 } });
  say('78 lines, well under 200.', row);
  w.status(dt(400, 800), 'idle', 'idle');

  ask('Headset handover steps from the runbook: wake, tap Enter, hand over, under 15 s. Put it under Run it.');
  row = think('Pull the exact wording from RUNBOOK.md so the README and the runbook do not drift.');
  read('docs/RUNBOOK.md', { offset: 1, limit: 12 }, '1: # RUNBOOK — expo table\n2: \n3: ## Headset handover (< 15 s)\n4: 1. Wake the headset (press the side button); the 2D page is still loaded.\n5: 2. Tap the giant ENTER button; the connection and mic badges must be green.\n6: 3. Hand it over. If the badge is red, press R on the laptop and try again.\n7: \n8: ## Reset between judges\n9: Press R on the laptop: re-seeds the fixture, removes judge-made forks and piped tiles, restores the layout.\n10: \n11: ## Vision Pro\n12: Sit or stand still; lean and summon; do not walk (immersion goes translucent after ~1 m).', '→ handover: wake, tap ENTER, hand over; R resets', row);
  patchReadme(w, row, 'Scan the QR with the headset instead of typing a 30-character hostname on a floating keyboard.', { old: 23, new: 23, lines: [
    ' Scan the QR with the headset instead of typing a 30-character hostname on a floating keyboard.',
    ' ',
    '+**Headset handover (< 15 s)**: wake the headset, tap the giant ENTER button (connection + mic badges green), hand it over. Between judges press **R** on the laptop: it re-seeds the fixture, drops judge-made forks and piped tiles, and restores the layout.',
    '+',
    ' ### Live mode',
  ] });
  say('Handover paragraph added under Run it, wording taken from docs/RUNBOOK.md.', row);
  w.status(dt(400, 800), 'idle', 'idle');

  ask('Shorten the two-device story to five bullets, one per thing each device does that the other cannot.');
  row = think('Laptop: types code, reads diffs flat, approves, arranges top-down. Headset: glances at ten at once, walks to read, looks-and-speaks, pipes and forks by hand. That is more than five; merge into five contrasts.');
  patchReadme(w, row, 'The laptop person types, reads diffs flat, approves and arranges the floor plan.', { old: 33, new: 33, lines: [
    ' ## Two devices, one room',
    ' ',
    '-The laptop person types, reads diffs flat, approves and arranges the floor plan. The headset person glances, walks, looks-and-speaks, pipes and forks. Both mirror one scene held by the Node hub.',
    '+- **Type vs. speak**: the laptop types long prompts and code; the headset looks at a column and talks to it.',
    '+- **Read flat vs. walk up**: a 200-line diff is read on the laptop; a summary becomes full text when the headset steps in.',
    '+- **Approve vs. notice**: the laptop clicks Approve/Deny; the headset sees the red ring across the room first.',
    '+- **Arrange vs. pull apart**: the laptop drags ten bases in a top-down view; the headset forks by pulling a title plate sideways.',
    '+- **One scene**: both mirror the same JSON event stream from the Node hub; there is no headset build and no laptop build.',
  ] });
  say('Five contrasts, one line each.', row);
  w.status(dt(400, 800), 'idle', 'idle');

  // ---- final pass ----------------------------------------------------------
  ask('Final read-through: fix typos and inconsistent capitalisation, run the line count again, then we are done.');
  row = think('Read the whole file once, fix "metres"/"meters" consistency (the docs use metres), capitalise Hermes, then wc.');
  read('README.md', {}, '1: # cEverything — every AI-agent chat you have open stands as a column in your room\n2: \n3: Walk up to a column to read it, look at it and speak to steer it, drag a message from one column to another to connect them — while your laptop teammate types, approves and arranges in the very same room.\n…\n11: - Bars from afar, one-line summaries at two metres, full text when you step in.\n…\n(88 lines)', '→ 88 lines read; two inconsistencies spotted', row);
  patchReadme(w, row, '- Packets fly to three landmarks: the browser pylon, the terminal pylon, the codebase tree.', { old: 12, new: 12, lines: [
    ' - Bars from afar, one-line summaries at two metres, full text when you step in.',
    '-- Packets fly to three landmarks: the browser pylon, the terminal pylon, the codebase tree.',
    '-- A red pulsing ring means a session needs you.',
    '+- Packets fly to three landmarks: the browser pylon, the terminal pylon and the codebase tree.',
    '+- A red pulsing ring and a beacon overhead mean a session needs you.',
  ] });
  w.status(dt(200, 400), 'tool', 'running: wc -l README.md');
  c = w.toolCall(dt(400, 800), 'terminal', { command: 'wc -l README.md' });
  w.toolResult(dt(300, 600), c, { text: hermes.terminal('88 README.md\n').text, summary: '→ 88 lines', meta: { command: 'wc -l README.md', exitCode: 0 } });
  w.status(dt(300, 600), 'tool', 'saving to memory');
  c = w.toolCall(dt(500, 900), 'memory', { action: 'add', target: 'memory', content: 'cEverything README conventions: metres not meters; Hermes capitalised; honesty label section is followed by the claim/don\'t-claim box; credits name promptclickrun/bighelp explicitly.' });
  w.toolResult(dt(300, 600), c, { text: 'Added to memory (entry 16 of 40).', summary: '→ memory updated' });
  w.status(dt(300, 600), 'tool', 'planning');
  c = w.toolCall(dt(400, 800), 'todo_list', { todos: [
    { id: '1', content: 'Read docs: package.json, DESIGN.md, PROTOCOL.md §1/§6, CONTEXT.md', status: 'completed' },
    { id: '2', content: 'Draft README.md (7 sections, < 200 lines)', status: 'completed' },
    { id: '3', content: 'Iterate on feedback; verify links and line count', status: 'completed' },
  ] });
  w.toolResult(dt(200, 400), c, { text: '[x] 1. Read docs\n[x] 2. Draft README.md (7 sections, < 200 lines)\n[x] 3. Iterate on feedback; verify links and line count', summary: '→ all 3 todos completed' });
  say('README.md is done: 88 lines, nine sections (pitch, what the judge sees, run it with live mode and handover, two devices, controls, honesty label, claims, credits), 6 referenced paths verified. Ready for review.', row);
  w.status(dt(500, 900), 'done', 'done', { kind: 'done', text: 'README.md written (88 lines)' });
  w.upsert(0, { status: 'done', endReason: 'completed', activity: 'done', attention: { kind: 'done', text: 'README.md written (88 lines)' } });
  return [w];
}
