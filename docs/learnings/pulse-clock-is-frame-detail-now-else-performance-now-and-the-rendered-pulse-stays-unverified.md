---
name: pulse-clock-is-frame-detail-now-else-performance-now-and-the-rendered-pulse-stays-unverified
description: "state.js drives the pulse from frame detail.now else performance.now, so tests prove the color numerically and the rendered pulse stays unverified."
metadata:
  node_type: memory
  type: project
  keywords:
    - pulse clock
    - frame detail now
    - performance.now
    - Date.now D17
    - rendered end state
    - HARD observable
    - unverified end state
    - numeric twin
    - mock clock
    - waiting beacon
  provenance: code-verified
  slug: pulse-clock-is-frame-detail-now-else-performance-now-and-the-rendered-pulse-stays-unverified
  phase: phase-1
  tags:
    - state
    - pulse
    - tests
    - end-state
    - plan-6
  created: 2026-10-17
  originSessionId: cba70f17-7953-4f69-a6f5-f7886bd940d0
  modified: 2026-10-17T21:46:51.441Z
---

Plan-versus-code note, plus a rule for writing visual end states.

**The deviation.** Plan decision D17 says a feature takes `now` from `Date.now()`. `src/features/state.js` reads `e.detail?.now ?? performance.now()` in its `frame` listener. `src/features/fork.js` does use `Date.now()` for its throttle. The audit judged the pulse inside the declared mechanism latitude. It is not an issue and not ADR-worthy.

**Why.** `src/main.js` emits `frame` with `{ dt, camera, renderer }` and no `now`. So the live path always uses `performance.now()`. The `detail.now` branch is a test hook. ES10 in `src/gesture.test.mjs` emits `frame` with `now` at 250, 500 and 1000 and checks the base color. Both clocks count milliseconds, so the 1000 ms cosine period holds.

**Check on integration.** A sibling plan 1 phase 2 `main.js` adds `ctx.onFrame(cb)` with `cb(dt, now)`. It leaves the bus `frame` detail unchanged. That was not read at the landed tip. If `main.js` ever adds `now` to the bus detail, confirm it is in milliseconds. A seconds value would slow the pulse a thousandfold.

**The unverified end state.** ES11 says that in `?mode=laptop` a working obelisk visibly pulses and a waiting obelisk shows a raised beacon until clicked. It is HARD and needs a render. The read-only gate seat could not render the page. It attested `unverified`, and it did not hold the phase. The code path supports the claim. ES10 is the only automated proof, and it checks the color value, not the picture.

**Rule for plan authors.**
- Pair every visual end state with a numeric twin driven by an injected clock or an injected hook.
- Expect the visual one to stay `unverified` until a human or a headless render looks.
- Do not word a visual end state so that its failure would block a phase.

Locate-cue (verify still present before acting): `e.detail?.now ?? performance.now()` and `PULSE_MS` in `src/features/state.js`, the `bus.emit('frame', ...)` call in `src/main.js`, ES10 in `src/gesture.test.mjs`. Read in the phase integration worktree at tip a5a3741, the second parent of the landed merge 9a82d13 with a matching tree.

Related: [[main-js-onframe-isolates-each-callback-but-has-no-unsubscribe]], [[end-state-grep-miss-checks-stamp-exit-code-1-on-a-met-condition]].
