# Obelisks plan 6 — Fork and pipe gestures, obelisk state beacons

Plan 6 of the Obelisks roadmap (docs/roadmaps/2026-10-17-obelisks.md). Depends on plan 1 (foundation) landing first; runs in parallel with plans 2, 3, 4, 5.

**Evidence consumed** — one row per linked artifact:
- `work-audit-refine/0.21.15/skills/war-strategy/SKILL.md` §2 (merged plan template, template law, Example A) · read
- `scratchpad/plans/plan1-final-for-agents.md` — plan 1: PIN-1 through PIN-24, Task 1's wire protocol, Task 2's `getObelisk` / `allObelisks` / `setState` / `setBeacon` / slab `userData`, Task 3's `bus` events and `bus.selected` / `bus.selectedSlab`, the `mode` event's `canEdit` · read
- `scratchpad/plan/2026-10-17-hermes-vr-obelisks.md` — the earlier single-plan draft: D6, D18, Task 8's slice, End states 9 and 15 · read
- github.com/NousResearch/hermes-agent `tui_gateway/contracts/sessions.py` at `59ee4989` (`session.branch` forks and the source keeps running) · read via plan 1's evidence block
- prior art lane (Claude Code Agent View, Hermes `derive_pet_state`) · read via plan 1's evidence block
- WebKit blog 15162 (visionOS `transient-pointer` exists only during a pinch, so `select` is the one reliable gesture event) · read via plan 1's evidence block
- the worktree at `9b912f5` (README and WAR config only; every seam below is a plan 1 commitment, not yet code) · read

## Context — the gap / problem

Fork and pipe are the two creation acts of the demo: pinch an obelisk base with nothing foreign selected and a sibling obelisk rises; select a slab in obelisk A, then pinch obelisk B's base, and B receives `From <A title>: <slab text>` (user). The relay half already exists in plans 1 and 2: the protocol fixes `{t:'fork', sid}` and `{t:'pipe', from, to, slab}`, plan 2's `fork.mjs` calls `session.branch` (the source session keeps running) and its `pipe.mjs` reads the slab text from `relay.slabs.get(sid)`, and a read-only target answers `{t:'error', text:'read-only harness'}` (verified: plan 1 `plan1-final-for-agents.md` Task 1 slice at `9b912f5`; `tui_gateway/contracts/sessions.py` at `59ee4989` via plan 1's evidence block). Nothing on the client yet turns a pinch into either command (verified: worktree at `9b912f5` holds no `src/` files).

Plan 1's `xr.js` and `laptop.js` both emit the `bus` event `select {sid, kind:'base'|'slab', slabId, object}` and set `bus.selected` and `bus.selectedSlab {sid, slabId}`; `net.send(cmd)` writes to the relay, and every server event, including `mode {canEdit}` and `state {sid, status}`, is re-emitted on `bus` under its `t` name (verified: plan 1 `plan1-final-for-agents.md` Task 1 and Task 3 slices at `9b912f5`). Plan 1's `obelisk.js` exposes `setState(status)` and `setBeacon(on)` for this plan, `room.js` exports `getObelisk(sid)` and `allObelisks()`, and `colors.js` exports `stateColor(status)` for the five statuses (verified: plan 1 Task 2 slice and End state 4 at `9b912f5`).

An obelisk that is waiting for a human must be findable across the room: waiting is yellow with a raised beacon that stays until the user selects that obelisk, working and streaming pulse, idle is dim, error is red (verified: plan 1 D18 / PIN-18 at `9b912f5`; prior art Claude Code Agent View and Hermes `derive_pet_state` via plan 1's evidence block). A client on the bare share link receives `canEdit:false` and the relay refuses its commands; the page must also ignore gestures that send commands so a viewer's pinch is inert (verified: plan 1 D23 / PIN-23 at `9b912f5`). The client never branches on harness name, so a fork aimed at a Claude Code obelisk is sent and refused by the relay, not filtered on the client (verified: plan 1 D19 / PIN-19 at `9b912f5`).

## Pivotal constraints

- File fence: this plan adds `src/gesture.js`, `src/gesture.test.mjs`, `src/features/fork.js`, `src/features/pipe.js`, `src/features/state.js` and edits nothing plan 1 or plans 2 through 5 own; features are picked up by `main.js`'s `import.meta.glob` with no loader edit (verified: plan 1 D17 and D22 at `9b912f5`).
- No command leaves a view-only client: both gesture features consult the last `mode` event before `net.send` (verified: plan 1 D23 at `9b912f5`).
- Headset behavior cannot run under `node --test`; the decision logic is a pure module with no `three` or DOM import so its four cases are tested, and everything in-scene is judged at audit_sha or at the 5:30 PM Quest slot (user: no headset time spent building; verified: plan 1 D4 at `9b912f5`).
- Build window is 3 PM to 5:15 PM with one worker per task, so each task fits 90 minutes (user).
- No DOM inside the immersive session: the pipe line and the beacon are scene meshes (verified: plan 1 pivotal constraints at `9b912f5`).

## Resolved design tree

| # | Decision | Resolution | Source | Landing class |
|---|----------|------------|--------|---------------|
| D6 | Creation acts (client half) | pinch a base with `bus.selectedSlab` empty or on the same obelisk → send `{t:'fork', sid}`; pinch a base while `bus.selectedSlab` is on another obelisk → send `{t:'pipe', from, to, slab}`; the new obelisk arrives as a normal `session` event with `parent` and plan 1's `room.js` places it | (user) | PIN-6→slice (T1) |
| D18 | Obelisk state | `state` events drive `setState(status)`; `waiting` raises the beacon and it stays until that obelisk is selected; working and streaming pulse; error is red; idle is dim | (user; prior art via plan 1's evidence block) | PIN-18→slice (T2) |
| D23 | Edit vs view links | gestures that would send a command do nothing while the last `mode` event has `canEdit:false` | (user) | PIN-23→guardrail |
| D22 | Seam ownership | plan 6 touches only its five files; plan 1's loader, bus, obelisk, room, and colors are consumed, never edited | (user) | PIN-22→guardrail ‡ |
| D19 | Harness contract | the client never branches on harness name; fork and pipe are sent for any obelisk and the relay refuses read-only targets | (user) | PIN-19→guardrail ‡ |
| D17 | Feature wiring | `src/features/*.js` are glob-loaded and get `install({scene, camera, renderer, bus, net})`; this plan's three features rely on it | [assumed: plan 1 lands the loader as written — if wrong: plan 6's features are imported by name in a follow-up to plan 1] | PIN-17→context |
| D70 | Gesture decision | `src/gesture.js` exports the pure `decide(select, selectedSlab)`: `{kind:'fork', sid}` when `select.kind === 'base'` and `selectedSlab` is empty or `selectedSlab.sid === select.sid`; `{kind:'pipe', from: selectedSlab.sid, to: select.sid, slab: selectedSlab.slabId}` when `select.kind === 'base'` and `selectedSlab.sid !== select.sid`; `null` for any other hit or a missing `select`; no imports | [assumed: the `select` payload is the plain object plan 1 documents (the `detail` of a `CustomEvent`) — if wrong: the feature's one accessor changes, `decide` does not] | PIN-70→slice (T1) |
| D71 | Fork throttle | `fork.js` sends at most one `fork` per second per obelisk (a `Map` of `sid` → last send time); later pinches inside the window are dropped silently | [assumed: a double pinch is common on the transient pointer — if wrong: the window shrinks to zero] | PIN-71→slice (T1) |
| D72 | Pipe feedback | `pipe.js` draws a line from the selected slab's world position to the target base, removes it after one second, and sets `bus.selectedSlab = null` after sending; the line color is `colorFor('user')` | [assumed: the slab `object` from the last slab `select` is still in the scene — if wrong: the line starts at the source obelisk's base] | PIN-72→slice (T1) |
| D73 | Client-side canEdit gate | both gesture features keep the last `mode` event; `canEdit` is treated as `false` until the first `mode` arrives; when false, no `net.send`, no line, no selection change | [assumed: the relay's `mode` on connect precedes the first pinch — if wrong: the first pinch is dropped and the second works] | PIN-73→slice (T1) |
| D74 | Beacon policy | `state.js` calls `setState(status)` on every `state` event and raises the beacon on a transition into `waiting` (last status per `sid` was not `waiting`); any `select` on that `sid` calls `setBeacon(false)`; later `working` or `idle` events do not lower it; a repeated `waiting` without an intervening other status does not re-raise it | (user: sticky until selected) [assumed: the Hermes source may re-emit the same status on each re-list — if wrong: the transition rule is a no-op] | PIN-74→slice (T2) |
| D75 | Pulse and colors | working and streaming oscillate the base between `stateColor(status)` and `stateColor('idle')` at about 1 Hz on a time-based tick that never edits `main.js`'s animation loop; error and idle are steady `stateColor('error')` and `stateColor('idle')`; no color literal lives in plan 6 | [assumed: `setState(status)` applies the static color and the base mesh is reachable by `userData.kind === 'base'` — if wrong: the pulse alternates `setState(status)` and `setState('idle')` at 1 Hz] | PIN-75→slice (T2) |

## Assumptions ledger

| ID | Assumption | Basis | Blast radius if wrong | Check |
|----|-----------|-------|----------------------|-------|
| A1 | The `select` payload is `{sid, kind, slabId, object}` and `bus.selectedSlab` is `{sid, slabId}` or empty, as plan 1 Task 3 states | plan 1 Task 3 slice at `9b912f5` | one accessor in `fork.js` and `pipe.js` changes; `decide` and its tests stand | End states 1 through 4 (pure); End states 5 and 6 at audit_sha |
| A2 | `setState(status)` colors the base from `stateColor` and the base mesh carries `userData.kind === 'base'` | plan 1 Task 2 slice at `9b912f5` | the pulse falls back to alternating `setState` calls | backstop row 2 |
| A3 | `mode {canEdit}` arrives before the first gesture | plan 1 Task 1 slice: the relay sends `mode` on connect | the first pinch on a fresh client is dropped | End state 8 at audit_sha |
| A4 | The `object` carried by a slab `select` stays in the scene long enough to read its world position when the base pinch follows | plan 1 Task 2: cap 40 visible slabs, oldest removed | the pipe line starts at the source obelisk's base instead | End state 6 at audit_sha |
| A5 | Plan 2's `fork.mjs` and `pipe.mjs` land before the 5:30 PM slot | roadmap: plans 2 through 6 run in parallel from 3 PM | the client sends the commands and the relay logs no handler; the gesture half is still judged by the sent frame | backstop row 1 |

## Non-goals / deferred

In-scene toasts for relay `error` events (console only) · filtering fork or pipe by harness on the client (the relay refuses read-only targets) · undo or multi-slab pipe · drag or two-hand gestures · hand-tracking consent · beacon sound · a laptop-only gesture UI (laptop clicks already flow through plan 1's `select` event, so fork and pipe work with a mouse for free) · voice (plan 5) · pylons and projectiles (plan 4).

## New domain terms · Recommended ADRs

Beacon (the raised marker plan 1's `setBeacon(true)` shows on a waiting obelisk), pipe line (the one-second line from a slab to the base it was piped into), gesture decision (the pure `decide` output: fork, pipe, or null). ADRs: none.

## Commander's Intent

- **Purpose:** a pinch creates: pinch a base to fork that session, select a slab and pinch another base to pipe it there; and any session waiting for a human is visible across the room until someone picks it.
- **Method:** one pure decision function over plan 1's `select` event; two thin features that send the protocol commands and draw the feedback; one feature that maps `state` events onto plan 1's `setState` and `setBeacon` with a sticky-waiting rule and a pulse; nothing edits a plan 1 file; a view-only client sends nothing.
- **Mechanism latitude:** the pulse's tick source (an interval, a sentinel mesh's `onBeforeRender`, or `obelisk.js`'s own update if it already pulses) and the material property it modulates, the pipe line's geometry and its removal timer, the fork throttle's data structure, how `pipe.js` remembers the selected slab's `object`, and whether `session` events seed the initial status are implementer's choice; substituting any of these mechanisms while the End states and binding guardrails hold is not a plan deviation and warrants no issue.
- **Binding guardrails:** no `fork` or `pipe` leaves a client whose last `mode` has `canEdit:false` (PIN-23) · no file owned by plan 1 or plans 2 through 5 is edited; the five plan 6 files are the whole footprint (PIN-22) · the client never branches on harness name (PIN-19) · the command shapes are exactly `{t:'fork', sid}` and `{t:'pipe', from, to, slab}` from `shared/protocol.mjs` · every color comes from plan 1's `stateColor` or `colorFor` · wireframe look only.
- **End state:**
  1. `decide({kind:'base', sid:'a'}, null)` returns `{kind:'fork', sid:'a'}` · check: `npm install --no-audit --no-fund >/dev/null && node --test 'src/*.test.mjs'`.
  2. `decide({kind:'base', sid:'a'}, {sid:'a', slabId:'s1'})` returns `{kind:'fork', sid:'a'}` · check: `npm install --no-audit --no-fund >/dev/null && node --test 'src/*.test.mjs'`.
  3. `decide({kind:'base', sid:'b'}, {sid:'a', slabId:'s1'})` returns `{kind:'pipe', from:'a', to:'b', slab:'s1'}` · check: `npm install --no-audit --no-fund >/dev/null && node --test 'src/*.test.mjs'`.
  4. `decide({kind:'slab', sid:'a', slabId:'s2'}, anything)` and `decide(undefined, anything)` return `null` · check: `npm install --no-audit --no-fund >/dev/null && node --test 'src/*.test.mjs'`.
  5. Pinch an obelisk base in the headset with nothing foreign selected: the relay log shows one `fork` for that `sid` and a sibling obelisk rises beside it within three seconds · HARD at audit_sha (observable + judge seat).
  6. Select a slab in obelisk A, pinch obelisk B's base: a line runs from the slab to B's base for about one second, the relay log shows `pipe` with `from` A and `to` B, `bus.selectedSlab` is empty afterwards, and a user slab starting `From <A title>:` appears in B · HARD at audit_sha (observable + judge seat).
  7. Two pinches on the same base inside one second produce one `fork` line in the relay log · HARD at audit_sha (observable + judge seat).
  8. On the bare share link (`canEdit:false`), pinching or clicking a base sends nothing: the relay log shows neither `fork` nor `view-only link` for that client · HARD at audit_sha (observable + judge seat).
  9. A `state` event with `waiting` raises the obelisk's beacon and colors its base `stateColor('waiting')`; the beacon stays through later `working` and `idle` events and lowers the moment that obelisk is selected · HARD at audit_sha (observable + judge seat).
  10. `working` and `streaming` visibly pulse the base, `error` turns it `stateColor('error')`, `idle` dims it · HARD at audit_sha (observable + judge seat).
  11. The plan 6 commits touch only the five plan 6 files (and `docs/`) · check: `git diff --name-only master...HEAD | grep -vE '^(src/(gesture\.js|gesture\.test\.mjs|features/(fork|pipe|state)\.js)|docs/)' ; test $? -eq 1 && echo FOOTPRINT_OK`.

## Build order (for /war)

Phase 1 only: Task 1 and Task 2 in one wave (file-disjoint, no deps). No release phase.

## Phase 1 — Gestures and state (3 PM to 5:15 PM)

### Task 1: Fork and pipe gestures
- Files: `src/gesture.js`, `src/gesture.test.mjs`, `src/features/fork.js`, `src/features/pipe.js`
- Plan slice: `gesture.js` exports the pure `decide(select, selectedSlab)` with no imports: `{kind:'fork', sid: select.sid}` when `select.kind === 'base'` and `selectedSlab` is null, undefined, or has `sid === select.sid`; `{kind:'pipe', from: selectedSlab.sid, to: select.sid, slab: selectedSlab.slabId}` when `select.kind === 'base'` and `selectedSlab.sid !== select.sid`; `null` when `select` is missing or `select.kind !== 'base'` (PIN-70). `gesture.test.mjs` covers those four cases with Node's built-in runner. `fork.js` exports `install({bus, net})`: it records the last `mode` event (`canEdit` false until one arrives), listens for `select`, calls `decide(payload, bus.selectedSlab)`, and on `{kind:'fork'}` sends `net.send({t:'fork', sid})` unless `canEdit` is false or that `sid` was sent inside the last second (a `Map` of `sid` → timestamp) (PIN-6, PIN-71, PIN-73); the new obelisk arrives through plan 1's `session` event with `parent` set and `room.js` places it. `pipe.js` exports `install({scene, bus, net})`: it keeps the same `mode` gate, caches the `object` of the last `select` with `kind:'slab'`, and on `{kind:'pipe'}` sends `net.send({t:'pipe', from, to, slab})`, draws a `THREE.Line` colored `colorFor('user')` from the cached slab's world position (fallback: the source obelisk from `getObelisk(from)`) to the world position of `getObelisk(to)`'s base, removes and disposes it after one second, and sets `bus.selectedSlab = null`; when `canEdit` is false it does nothing (PIN-6, PIN-72, PIN-73). Imports: `./room.js` (`getObelisk`), `../colors.js` (`colorFor`), `../gesture.js`, `three`.
- Done when: `node --test 'src/*.test.mjs'`
- requiresTest: true
- requiresPackaging: false
- deps: []
- target repo: superproject

### Task 2: Obelisk state beacons
- Files: `src/features/state.js`
- Plan slice: `state.js` exports `install({bus})` and imports `getObelisk` from `./room.js` and `stateColor` from `../colors.js`. On every `state {sid, status}` (and, as latitude, on `session {sid, status}` for the initial value) it looks up `getObelisk(sid)`, returns if absent, calls `obelisk.setState(status)`, and applies the beacon rule: when `status === 'waiting'` and the last recorded status for that `sid` was not `waiting`, call `obelisk.setBeacon(true)`; record the status; never lower the beacon on a status change (PIN-18, PIN-74). On `select {sid}` call `getObelisk(sid)?.setBeacon(false)` (PIN-74). For `working` and `streaming` it runs a time-based pulse at about 1 Hz between `stateColor(status)` and `stateColor('idle')` on the base mesh (found by `userData.kind === 'base'` among the obelisk's children), stopping the pulse and restoring the steady color on any other status; `error` and `idle` are steady `stateColor('error')` and `stateColor('idle')`; the tick is an interval or a sentinel `onBeforeRender`, never an edit to `main.js` (PIN-75). If `setState` already pulses, `state.js` leaves the pulse to it and keeps only the beacon rule.
- Done when: None — scene wiring over plan 1's tested `stateColor`, `setState`, and `setBeacon`; judged by End states 9 and 10 at audit_sha and backstop row 2
- requiresTest: false
- requiresPackaging: false
- deps: []
- target repo: superproject

## Deferred validations (backstops)

- Quest 3S: trigger or pinch on a base forks; slab-then-base pipes with the line visible; a double pinch sends one `fork` · why deferred: the gesture path needs a headset, and the Vision Pro slot at 2 PM precedes this plan; the visionOS Simulator (click as pinch) and laptop clicks are the only pre-slot checks · runner: operator at the 5:30 PM Quest slot, reading the relay log.
- Quest 3S: a `waiting` beacon is visible from 3 m and the pulse reads as motion with no frame drop · why deferred: cannot judge legibility or frame cost without the device · runner: operator at the 5:30 PM Quest slot.

## Notes / conscious deviations

- Task 2 has no test by the done-when law: it only wires plan 1's tested `stateColor`, `setState`, and `setBeacon` into the scene; End states 9 and 10 are judged at audit_sha.
- The beacon is sticky by the literal PIN-18 reading: it stays up through later `working` or `idle` events (the operator may have answered from the TUI) and lowers only on a `select` of that obelisk in VR or on the laptop.
- A short pinch on a base fires `select` (this plan's fork) and also `selectstart`/`selectend` (plan 5's hold-to-talk); plan 5 owns any minimum-duration guard for voice; this plan does not touch it.
- Vision Pro gestures are checked in the visionOS Simulator before 5:15 PM (plan 1 PIN-4) since the 2 PM Vision Pro slot precedes this plan's landing; the Quest slot at 5:30 PM is the only headset check.
- If plan 1's `room.js` already forwards `state` events to `setState`, the second call from `state.js` is idempotent; `state.js` owns the beacon and pulse policy either way.

## Open decisions

None.
