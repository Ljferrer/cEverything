---
name: main-js-onframe-isolates-each-callback-but-has-no-unsubscribe
description: "ctx.onFrame callbacks run in try/catch inside the render loop, so a throw never skips the render, but nothing can unregister one."
metadata:
  node_type: memory
  type: project
  keywords:
    - onFrame
    - setAnimationLoop
    - frame callback
    - throwing callback
    - render loop freeze
    - try/catch
    - per-frame seam
    - frameCallbacks
    - unsubscribe
  provenance: code-verified
  slug: main-js-onframe-isolates-each-callback-but-has-no-unsubscribe
  phase: phase-2
  tags:
    - main
    - render-loop
    - features
    - seam
    - xr
  created: 2026-10-17
  originSessionId: 24fe07c2-1e38-4429-b5c7-e1be2b220156
  modified: 2026-10-17T21:31:54.917Z
---

Seam contract for any feature file under `src/features/` in plans 2 to 6.

**The seam.** `install(ctx)` receives `ctx.onFrame(cb)`. `src/main.js` runs each `cb(dt, now)` inside `renderer.setAnimationLoop`, after `bus.emit('frame', ...)` and before `renderer.render(scene, camera)`. It runs in immersive sessions too. A bare Object3D `onBeforeRender` does not fire there.

**The pattern.** A loop over a plain array of callbacks has no isolation. One throw skips every later callback and the render, on every frame, and the room freezes. The `bus` does not have this flaw, because `EventTarget` dispatch keeps going after a throwing listener. So the array loop was the weaker seam of the two.

**What happened.** The phase 2 audit found the unguarded loop at the first task commit. A fix round wrapped each call before land. The audit finding was resolved in a fix round before land, so this is recorded as a pattern, not a live instance.

**The contract now.**
- A throwing callback is logged with `console.error('[onFrame]', err)`. The other callbacks and the render still run.
- A callback that always throws logs on every frame, which is 72 or more lines per second in a headset. Fix the callback. Do not rely on the log.
- `onFrame` returns nothing and the array only grows. A feature that tears down must make its own callback a no-op.

**Rule.** Any new per-frame or per-event registry that loops over callbacks isolates each entry, so one feature cannot starve the others. Plans 2 to 6 run in parallel and cannot edit `src/main.js`.

Locate-cue (verify still present before acting): the `try { cb(dt, now); } catch (err) { console.error('[onFrame]', err); }` loop in `src/main.js`. Read at the phase 2 integrated tip (the landed merge's second parent).

Related: [[late-feature-subscriber-misses-the-relays-once-per-connection-mode-frame]], [[obelisks-molten-hackathon]].
