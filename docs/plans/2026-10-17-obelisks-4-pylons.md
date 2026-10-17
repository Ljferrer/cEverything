# Obelisks plan 4 — Pylons and projectiles

Plan 4 of the Obelisks roadmap (docs/roadmaps/2026-10-17-obelisks.md). Depends on plan 1 (foundation) landing first; runs in parallel with plans 2, 3, 5, 6.

**Evidence consumed** — one row per linked artifact:
- `skills/war-strategy/SKILL.md` §2 of the installed `work-audit-refine` plugin (merged plan template, template law, Example A) · read
- `scratchpad/plans/plan1-final-for-agents.md` (plan 1: pins PIN-1 through PIN-24, the Task 1 wire protocol, the Task 2 `getObelisk`/`allObelisks`/`userData` seams, the Task 3 `bus` events) · read
- `scratchpad/plan/2026-10-17-hermes-vr-obelisks.md` (earlier single-plan draft; its Task 6 is this plan's seed, its D12 row is the pylon map) · read
- github.com/NousResearch/hermes-agent `tui_gateway/contracts/events.py` at `59ee4989` (`tool.start{name,args}`, `tool.complete{name,summary,inline_diff}`, Hermes tool names) · read via plan 1's evidence block
- this session's Claude Code transcript (tool names `Bash`, `Read`, `Edit`, `WebFetch`, `WebSearch`, `Workflow`, `Skill`, `mcp__*`) · read via plan 1's evidence block
- moltenhack.com `#tracks` (judging criteria) · read via plan 1's evidence block
- lane `bighelp-protocol` (`display.tool_progress` gate on tool frames) · read via plan 1's evidence block
- `troika-three-text` docs · unread — plan 1 pins it for all in-scene text and `src/obelisk.js` already shows the `Text` usage this plan copies

## Context — the gap / problem

Tool calls are the most frequent visible act in an agent session, and PIN-2 makes them the room's motion: a projectile flies from the calling slab to a fixed pylon and the pylon glows, so a viewer can tell which agents are browsing, editing files, or running shells without reading a slab (user; verified: plan 1 D2 at `plan1-final-for-agents.md`). Hermes emits `tool.start{name,args}` and `tool.complete{name,summary,inline_diff}`, and plan 2's source maps them to the protocol's `tool` frame (verified: `tui_gateway/contracts/events.py` at `59ee4989`, read via plan 1's evidence block). Claude Code transcripts carry `tool_use{id,name,input}` and `tool_result` blocks with names such as `Bash`, `Read`, `Edit`, `WebFetch`, `WebSearch`, `Workflow`, `Skill`, and `mcp__*`, and plan 3's source maps them to the same `tool` frame (verified: this session's transcript, read via plan 1's evidence block).

The wire frame is `{t:'tool', sid, id, name, phase:'start'|'complete', args, summary, diff}` and `src/net.js` re-emits every server frame on `bus` under its `t` name (verified: plan 1 Task 1 plan slice at `plan1-final-for-agents.md`). `src/features/room.js` exports `getObelisk(sid)` and `allObelisks()`; each slab mesh carries `userData {sid, slabId}` and each base `userData {sid, kind:'base'}` (verified: plan 1 Task 2 plan slice at `plan1-final-for-agents.md`). The client never branches on harness name, so the pylon map keys on tool names alone and holds both harnesses' names in one table (verified: plan 1 D19 at `plan1-final-for-agents.md`). Tool frames reach the wire only when the Hermes host runs with `display.tool_progress: true` (verified: lane `bighelp-protocol`, read via plan 1's evidence block; gate name medium confidence). Judges score "It works in space" and "It clicks fast", and a projectile crossing the room is the quickest visible proof that the feed is live (verified: moltenhack.com `#tracks`, read via plan 1's evidence block).

## Pivotal constraints

- Phase window from 3 PM to 5:15 PM, one worker, one task of at most 90 minutes; the Quest 3S slot from 5:30 PM to 6:30 PM is the only headset check this plan gets (user; verified: plan 1 pivotal constraints at `plan1-final-for-agents.md`).
- No DOM inside an immersive session on either headset: pylon labels are troika text (verified: plan 1 pivotal constraints at `plan1-final-for-agents.md`).
- Plan 1's files are frozen (PIN-22) and the other plans' files are off limits; this plan adds only `src/features/pylons.js`, `src/pylon-map.js`, `src/pylon-map.test.mjs`, `src/projectile.js`, `src/projectile.test.mjs` (user).
- The client never branches on harness name (PIN-19): the map keys on tool names only (verified: plan 1 D19 at `plan1-final-for-agents.md`).
- Wireframe look only, no visual design pass (PIN-8) (user).
- Pure logic is tested with `node --test`; scene wiring is judged at audit_sha in laptop mode against the synthetic feed, and in the headset at the Quest slot (verified: war-strategy SKILL.md template law).

## Resolved design tree

| # | Decision | Resolution | Source | Landing class |
|---|----------|------------|--------|---------------|
| D2 | What tools look like | fixed **pylons** on the room edge (browser, filesystem, shell, other); a tool call fires a **projectile** from its slab to the pylon, and the pylon glows; no avatars | (user) | PIN-2→guardrail ‡ |
| D8 | Floor vs latitude | wireframe look is floor; everything not pinned is implementer's choice | (user) | PIN-8→guardrail ‡ |
| D12 | Pylon map | Hermes: `web_search`, `web_extract`, `browser_*` → browser; `write_file`, `patch`, `read_file`, `search_files` → filesystem; `terminal`, `execute_code` → shell. Claude Code: `WebSearch`, `WebFetch`, `mcp__*Browser*` → browser; `Read`, `Edit`, `Write`, `Grep`, `Glob`, `NotebookEdit` → filesystem; `Bash` → shell. Prefix match for `browser_` and `mcp__`; anything else → other; spawning tools (`Agent`, `Workflow`, `Task`, `delegate_task`) → other | (verified tool names at `59ee4989`, read via plan 1's evidence block) [assumed grouping — if wrong: one row moves] | PIN-12→slice (T1) |
| D17 | Feature wiring | `src/main.js` glob-loads `src/features/*.js` and calls `install({scene, camera, renderer, bus, net})`; `pylons.js` is picked up by adding the file | (verified: plan 1 D17) | PIN-17→context |
| D19 | Harness contract | the client never branches on harness name; the pylon map is one table over tool names | (verified: plan 1 D19) | PIN-19→guardrail ‡ |
| D22 | Seam ownership | plan 1's files are never edited; this plan adds only new files under `src/` and `src/features/` | (user) | PIN-22→guardrail ‡ |
| D50 | Spawning tools | `pylonFor` returns `other` for `Agent`, `Workflow`, `Task`, `delegate_task`; `isSpawning(name)` names the same set, and `pylons.js` fires no projectile for a spawning tool, so a spawn shows only as the child obelisk plan 3 raises (PIN-12's "child obelisks, not projectiles") | (user; verified: plan 1 D12) | PIN-50→slice (T1) |
| D51 | Pylon placement | four wireframe boxes about 3 m tall with a troika name label on top, at radius 5 m from the room origin: browser north (negative z), filesystem east (positive x), shell south (positive z), other west (negative x) | (user) [assumed compass order — if wrong: swap two constants] | PIN-51→slice (T1) |
| D52 | Projectile | a small sphere along a quadratic Bezier from the slab's world position to the pylon over 0.6 s; the control point is the midpoint lifted by a fixed height; time-based from the clock, not per-call increments; pooled, max 32 live, the oldest live projectile is recycled when the pool is full; `curvePoint(t, from, to)` is a pure export | (user) [assumed lift and pool size — if wrong: retune two constants] | PIN-52→slice (T1) |
| D53 | Glow | a `start` frame lights the mapped pylon for 2 s; a new `start` on the same pylon restarts the timer; the glow decays back to the wireframe base look | (user) | PIN-53→slice (T1) |
| D54 | Filesystem detail | on a `complete` frame whose name maps to filesystem, the filesystem pylon's second label shows the path (`args.path`, falling back to `args.file_path`, taken from the matching `start` frame by `id` when the `complete` frame carries no `args`) and `+n/-m` from `diffCounts(diff)`, a pure export that counts `+`/`-` lines and ignores `+++`/`---` headers | (user) [assumed Claude Code uses `file_path` — if wrong: one fallback key] | PIN-54→slice (T1) |
| D55 | Source position | `getObelisk(sid)` gates every frame: no obelisk → the frame is dropped silently; the launch point is the mesh with `userData.slabId === id` under that obelisk, else the mesh with `userData.kind === 'base'` for that `sid`, read with `getWorldPosition` | (user) [assumed: `getObelisk(sid)` returns or exposes a traversable `Object3D` — if wrong: traverse `scene` for the same `userData`] | PIN-55→slice (T1) |
| D56 | Pure/scene split | `src/pylon-map.js` and `curvePoint` import nothing from `three`; `src/features/pylons.js` is the only file that touches the scene; tests run with `node --test` on the exact test files | (user) | PIN-56→guardrail |

## Assumptions ledger

| ID | Assumption | Basis | Blast radius if wrong | Check |
|----|-----------|-------|----------------------|-------|
| A1 | `fixtures/synthetic.jsonl` tool lines carry `phase:'start'` and names in the PIN-12 table | plan 1 Task 1 says the fixture has tool lines; names unspecified | every synthetic projectile flies to `other` and the filesystem label stays empty; live Hermes names still map | judge seat in laptop mode with `--source synthetic`; End states 5 through 7 |
| A2 | Sources emit a `slab` with role `tool` whose `id` equals the `tool` frame's `id` | plan 1's protocol gives both frames an `id` on the same `sid` | every projectile launches from the obelisk base instead of the slab (PIN-55 fallback); still demo-complete | judge seat in laptop mode |
| A3 | `bus` delivers each frame as a `CustomEvent` whose `detail` is the frame | plan 1 says `net.js` re-emits every server event on `bus` under its `t` name; `bus` is an `EventTarget` | one accessor line in `pylons.js` (`e.detail ?? e`) | End state 6 at audit_sha |
| A4 | No documented per-frame hook reaches features; a helper `Object3D` with `frustumCulled = false` whose `onBeforeRender` drives the tween and glow runs inside every render, including XR, and may be called once per eye | three.js calls `onBeforeRender` on every rendered object; `window.requestAnimationFrame` does not fire inside an immersive session | projectiles freeze in the headset; the tween is time-based so a double call per frame is harmless | laptop mode shows motion; backstop row 1 at the Quest slot |
| A5 | `three` loads under Node so `src/projectile.js` can import it at module top level while `node --test` imports `curvePoint` | plan 1's `src/lod.js`, `src/colors.js`, `src/input.js` are tested with `node --test` beside the same dependency | move the pool behind a factory that receives `THREE` and keep the module's top level import-free | Task 1's Done when command |

## Non-goals / deferred

A 3D file tree with diffs (the filesystem pylon shows the path and `+n/-m` only) · more than four pylons or a per-tool pylon · projectile trails, sounds, or haptics · selecting or grabbing a pylon · tool-result slabs (slabs are plan 1's) · child obelisks for spawning tools (plan 3 via `session` with `parent`) · reacting to `delta` or `slab` frames · any edit to `src/obelisk.js`, `src/features/room.js`, or the protocol.

## New domain terms · Recommended ADRs

Glow (the pylon's 2 s lit state after a tool start), spawning tool (a tool name that creates an agent and fires no projectile). Pylon and projectile are defined in plan 1. ADRs: none.

## Commander's Intent

- **Purpose:** every tool call in the room is visible as motion: a projectile from the calling slab to the tool's pylon and a glow on arrival, so a viewer tells at a glance which agents are browsing, editing files, or running shells.
- **Method:** one pure name-to-pylon table shared by both harnesses; four fixed wireframe pylons at the compass points; a pooled projectile along a quadratic curve on each `tool` start; a 2 s glow; the filesystem pylon's path and `+n/-m` on `complete`; frames for unknown sessions and for spawning tools are dropped.
- **Mechanism latitude:** the sphere geometry and size, the curve's lift height, the clock source for the tween, the pool's recycling policy, how the glow is rendered (emissive on a `MeshStandardMaterial`, or a color and opacity pulse on the wireframe material), the pylon box dimensions and troika label parameters, whether the slab lookup traverses the obelisk or the whole scene, how the per-frame tick is obtained (the `onBeforeRender` helper, a chained `scene.onBeforeRender`, or a documented hook if plan 1 exposes one), the projectile color source (`colorFor('tool')` from `src/colors.js` or a constant), and the `+n/-m` label format are implementer's choice; substituting any of these mechanisms while the End states and binding guardrails hold is not a plan deviation and warrants no issue.
- **Binding guardrails:** fixed pylons on the room edge, a projectile from slab to pylon, a glow on the pylon, no avatars (PIN-2) · wireframe look only (PIN-8) · the client never branches on harness name; the map keys on tool names only (PIN-19) · no edit to any plan 1 file or any other plan's file; this plan adds only its five files (PIN-22) · `src/pylon-map.js` and `curvePoint` import nothing from `three`, `pylons.js` is the only file touching the scene, and the pure tests run under `node --test` (PIN-56).
- **End state:**
  1. `pylonFor(name)` returns the PIN-12 pylon for every listed Hermes and Claude Code name, `browser` for any name starting with `browser_` and for any `mcp__` name containing `Browser`, and `other` for every other name including `Agent`, `Workflow`, `Task`, `delegate_task` and an unknown name · check: `npm install --no-audit --no-fund >/dev/null && node --test src/pylon-map.test.mjs`.
  2. `isSpawning(name)` is true for exactly `Agent`, `Workflow`, `Task`, `delegate_task` and false for `Bash` and `web_search` · check: `npm install --no-audit --no-fund >/dev/null && node --test src/pylon-map.test.mjs`.
  3. `curvePoint(0, from, to)` equals `from`, `curvePoint(1, from, to)` equals `to`, and `curvePoint(0.5, from, to)` has the midpoint's x and z with y above the midpoint's y · check: `npm install --no-audit --no-fund >/dev/null && node --test src/projectile.test.mjs`.
  4. `diffCounts(diff)` returns the count of added and removed lines for a unified diff, ignores `+++` and `---` header lines, and returns zeros for an empty, missing, or non-string diff · check: `npm install --no-audit --no-fund >/dev/null && node --test src/pylon-map.test.mjs`.
  5. Four wireframe pylons labeled `browser`, `filesystem`, `shell`, `other` stand at the compass points at radius 5 m in laptop mode and in the headset · HARD at audit_sha (observable + judge seat).
  6. A `tool` frame with `phase:'start'` for a session that has an obelisk sends a sphere from that slab (or the obelisk base) to the mapped pylon, arriving within about 0.6 s, and the pylon glows for about 2 s · HARD at audit_sha (observable + judge seat).
  7. After a `complete` frame for a filesystem tool, the filesystem pylon shows the path and `+n/-m` · HARD at audit_sha (observable + judge seat).
  8. A `tool` frame for a `sid` with no obelisk, and a `start` frame for a spawning tool name, produce no projectile and no console error · HARD at audit_sha (observable + judge seat).
  9. A burst of more than 32 starts keeps at most 32 projectiles live and the frame time stays under one frame at 72 Hz on Quest 3S · backstop: row 1.

## Build order (for /war)

Phase 1 only: Task 1 in wave 1, one worker, about 80 minutes; starts after plan 1 lands on master; no release phase.

## Phase 1 — Pylons and projectiles (3 PM to 5:15 PM)

### Task 1: Pylon map, projectile pool, pylons feature
- Files: `src/pylon-map.js`, `src/pylon-map.test.mjs`, `src/projectile.js`, `src/projectile.test.mjs`, `src/features/pylons.js`
- Plan slice: `src/pylon-map.js` exports `pylonFor(name)` → `'browser'|'filesystem'|'shell'|'other'` over one table of Hermes names (`web_search`, `web_extract` → browser; `write_file`, `patch`, `read_file`, `search_files` → filesystem; `terminal`, `execute_code` → shell) and Claude Code names (`WebSearch`, `WebFetch` → browser; `Read`, `Edit`, `Write`, `Grep`, `Glob`, `NotebookEdit` → filesystem; `Bash` → shell), with prefix rules `browser_` → browser and `mcp__` plus a `Browser` substring → browser, everything else → `other` (PIN-12); it also exports `isSpawning(name)` for `Agent`, `Workflow`, `Task`, `delegate_task` (PIN-50) and the pure `diffCounts(diff)` → `{added, removed}` that counts lines starting with `+` or `-` and skips `+++`/`---` headers, returning zeros for a missing or non-string diff (PIN-54); the module imports nothing from `three`. `src/projectile.js` exports the pure `curvePoint(t, from, to)` (quadratic Bezier whose control point is the midpoint lifted by a fixed height; returns `{x, y, z}`) above any `three` import, plus a pool factory that owns up to 32 small sphere meshes added to the scene, `fire(from, to)` recycling the oldest live sphere when all are busy, and `update(now)` advancing each live sphere along `curvePoint` by elapsed time toward a 0.6 s flight and hiding it on arrival (PIN-52). `src/features/pylons.js` exports `install({scene, bus})`: it builds four wireframe boxes with a troika `Text` name label at the compass points at radius 5 m (browser negative z, filesystem positive x, shell positive z, other negative x) and a second, initially empty, troika label on the filesystem pylon (PIN-51); it listens on `bus` for `tool`: when `isSpawning(name)` or `getObelisk(sid)` from `src/features/room.js` is falsy the frame is dropped; on `phase:'start'` it remembers `args` by `id`, finds the launch mesh (`userData.slabId === id` under the obelisk, else the obelisk's `userData.kind === 'base'` mesh), reads its world position, fires a projectile to the pylon from `pylonFor(name)`, and lights that pylon for 2 s, restarting the timer on a repeat (PIN-53, PIN-55); on `phase:'complete'` for a filesystem name it sets the filesystem detail label to the path (`args.path ?? args.file_path` from the frame or the remembered start) and `+n/-m` from `diffCounts(diff)`, then forgets the `id` (PIN-54); a per-frame tick (default: a `frustumCulled = false` helper object's `onBeforeRender`) calls the pool's `update` and decays glows by wall-clock time. Tests: `src/pylon-map.test.mjs` asserts every listed name, both prefix rules, an `mcp__` name without `Browser` → `other`, an unknown name → `other`, the spawning set for `pylonFor` and `isSpawning`, and `diffCounts` on a three-line diff with headers, an empty string, and `undefined`; `src/projectile.test.mjs` asserts `curvePoint` at t = 0, 0.5, and 1.
- Done when: `node --test src/pylon-map.test.mjs src/projectile.test.mjs`
- requiresTest: true
- requiresPackaging: false
- deps: []
- target repo: superproject

## Deferred validations (backstops)

- Quest 3S: six obelisks plus a burst of 32 projectiles with two pylons glowing keep the frame time under one frame at 72 Hz · why deferred: cannot measure without the device · runner: operator at the 5:30 PM Quest slot via `chrome://inspect` frame timing.
- Quest 3S: pylon name labels at 5 m and the filesystem detail label are legible from the room center, and projectiles are visible against the floor grid · why deferred: text legibility and contrast need the device · runner: operator at the 5:30 PM Quest slot.
- Live Hermes `tool.start` frames arrive through plan 2's source and fire projectiles with the right pylon · why deferred: needs the configured host and plan 2 landed · runner: operator at the 5:30 PM Quest slot watching the relay log and the room while a seeded session runs `web_search`, `write_file`, and `terminal`.

## Notes / conscious deviations

- Adds `src/projectile.test.mjs`, which the roadmap's ownership list for plan 4 does not name. It is a new file under `src/` that no other plan owns (allowed by PIN-22), so `curvePoint`'s test sits beside its module instead of inside `pylon-map.test.mjs`.
- `diffCounts(diff)` and `isSpawning(name)` live in `src/pylon-map.js` rather than new modules so every pure helper stays in one tested file.
- PIN-12's clause "spawning tools show as child obelisks, not projectiles" is realized half here (no projectile, PIN-50) and half in plan 3 (the `session` frame with `parent`); `Task` joins the spawning set because Claude Code names its subagent tool that way.
- Cut order if the phase runs late: the filesystem detail label (PIN-54) first, then the glow timer restart, then the pool recycling (drop frames instead); pylons, the map, and the projectile stay.
- Judge seat without a headset: `npm run relay -- --source synthetic` plus the page in `?mode=laptop` shows End states 5 through 8 on the laptop; the Quest slot repeats them in the headset.

## Open decisions

None.
