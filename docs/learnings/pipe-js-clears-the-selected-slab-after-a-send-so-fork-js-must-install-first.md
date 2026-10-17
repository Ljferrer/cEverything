---
name: pipe-js-clears-the-selected-slab-after-a-send-so-fork-js-must-install-first
description: "pipe.js clears bus.selectedSlab after a send, so fork.js must install first or one pinch sends two commands."
metadata:
  node_type: memory
  type: project
  keywords:
    - install order
    - filename order
    - import.meta.glob sort
    - select listener order
    - double send
    - fork and pipe
    - bus.selectedSlab
    - queueMicrotask
    - shared bus field
  provenance: code-verified
  slug: pipe-js-clears-the-selected-slab-after-a-send-so-fork-js-must-install-first
  phase: phase-1
  tags:
    - features
    - bus
    - ordering
    - gestures
    - plan-6
  created: 2026-10-17
  originSessionId: cba70f17-7953-4f69-a6f5-f7886bd940d0
  modified: 2026-10-17T21:46:27.813Z
---

Ordering gotcha for any two features that listen to the same bus event and share one mutable bus field.

**The setup.** `src/main.js` installs features in `Object.keys(features).sort()` order, which is filename order. `src/features/fork.js` and `src/features/pipe.js` both listen to `select`. Both call `decide(payload, bus.selectedSlab, ...)` from `src/gesture.js`.

**The hazard.** `pipe.js` sets `bus.selectedSlab = null` after it sends a pipe. If `pipe.js` ran first, `fork.js` would then call `decide` with a null slab. `decide` returns `{t:'fork', sid: <target>}` for a null slab. One pinch on a base with a slab selected would send a pipe and a fork.

**Safe today.** `fork.js` sorts before `pipe.js`. The audit found nothing recording that dependence. A fix round added a three-line header comment to `pipe.js` that does.

**What is not proven.** The audit reasoned the double send from code order. `src/gesture.test.mjs` installs `fork.js` then `pipe.js` in ES8 and never the reverse. No test shows the double send.

**The contrast.** `state.js` lowers the beacon with `queueMicrotask` in its own `select` listener. `fork.js` and `pipe.js` read `bus.beacons` on the same dispatch, before the microtask runs. That form does not depend on install order.

**Rule.**
- When two features read then mutate one bus field on one event, defer the mutation with `queueMicrotask`.
- If you cannot defer it, write the filename-order dependence into the header of the later file.
- A rename such as `a-pipe.js` breaks the filename-order form with no test failure.

Locate-cue (verify still present before acting): the `fork.js must install before pipe.js` header lines and `bus.selectedSlab = null` in `src/features/pipe.js`, the `.sort()` loop in `src/main.js`, `queueMicrotask` in `src/features/state.js`. Read in the phase integration worktree at the plan 6 phase 1 tip a5a3741. It is the second parent of the landed merge 9a82d13 and its tree matches the landed tree. The reading cwd was on another branch and had no `fork.js`.

Related: [[late-feature-subscriber-misses-the-relays-once-per-connection-mode-frame]], [[main-js-onframe-isolates-each-callback-but-has-no-unsubscribe]].
