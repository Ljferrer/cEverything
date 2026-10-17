---
name: pylons-js-static-imports-room-js-and-troika-so-only-code-trace-covers-its-wiring
description: "pylons.js static-imports room.js and troika, so no node test covers its wiring and the render end states rest on code trace."
metadata:
  node_type: memory
  type: project
  keywords:
    - pylons.js
    - onTool wiring
    - no node test
    - static import room.js
    - troika
    - code trace
    - HARD end state
    - met vs unverified
    - 9b frame time
    - ctx.getObelisk
    - PIN-56
  provenance: code-verified
  slug: pylons-js-static-imports-room-js-and-troika-so-only-code-trace-covers-its-wiring
  phase: phase-1
  tags:
    - pylons
    - tests
    - end-state
    - plan-4
    - seam
  created: 2026-10-17
  originSessionId: 7b6542dc-508a-47a9-9f77-990bb5b6cd58
  modified: 2026-10-17T22:11:40.943Z
---

Test-gap note for plan 4, plus a warning about how a gate seat words `met`.

**The split.** PIN-56 keeps `src/pylon-map.js` and `src/projectile.js` free of `three`. Their tests are `src/pylon-map.test.mjs` (ES1, ES2, ES4, ES7b, ES8b) and `src/projectile.test.mjs` (ES3, ES9a). Those cover the name table, the drop rule, `diffCounts`, the curve and the pool.

**The gap.** All glue lives in `src/features/pylons.js`: the slab lookup, the hidden-slab base fallback, the start-args cache, the filesystem label and the glow lerp. That file imports `three`, `troika-three-text` and `getObelisk` from `src/features/room.js` statically. `install({ scene, bus })` takes no injected `getObelisk`. No test file names `pylons.js`. A node test needs the troika stub or a refactor to `ctx.getObelisk`.

**What the gate attested.** The gate seat marked HARD end states 5, 6, 7a and 8a as `met` from a code trace. Its own evidence line says the laptop render was not observed. End state 9b (frame time on Quest 3S, backstop row 1) stayed `unverified` as a SOFT note. The plan 6 gate seat attested a comparable render end state as `unverified`. So `met` on a HARD render end state can mean "the code path reads right", not "a render was seen".

**Rule.**
- Do not read `met` on a render end state as render-verified.
- To test the glue, inject `ctx.getObelisk` and omit `scene`, or stub troika. See the two related lessons.
- Pair each visual end state with a numeric twin, as the pulse-clock lesson says.

Locate-cue (verify still present before acting): the `import { getObelisk } from './room.js'` line and `install({ scene, bus })` in `src/features/pylons.js`, and the absence of any `pylons` reference in `src/*.test.mjs`. Grounding: the cwd HEAD was the pre-land base, so this was read in the run's integration worktree at tip 857b5ee. That commit is the second parent of landed merge e6ef0f2, and the base is its ancestor, so the trees match by construction.

Related: [[node-test-a-feature-with-a-fake-bus-and-an-injected-getobelisk-so-room-js-never-loads]], [[node-test-can-load-three-but-not-troika-stub-it-with-module-registerhooks]], [[pulse-clock-is-frame-detail-now-else-performance-now-and-the-rendered-pulse-stays-unverified]].
