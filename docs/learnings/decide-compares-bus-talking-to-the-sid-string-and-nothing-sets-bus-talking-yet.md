---
name: decide-compares-bus-talking-to-the-sid-string-and-nothing-sets-bus-talking-yet
description: "decide() suppresses a base select only when bus.talking strictly equals that sid string, and no code sets bus.talking at the plan 6 tip."
metadata:
  node_type: memory
  type: project
  keywords:
    - bus.talking
    - hold-to-talk
    - plan 5 contract
    - talking suppression
    - bus.beacons
    - undeclared bus field
    - fork suppressed talking
    - acknowledge suppression
    - strict equality sid
  provenance: code-verified
  slug: decide-compares-bus-talking-to-the-sid-string-and-nothing-sets-bus-talking-yet
  phase: phase-1
  tags:
    - bus
    - voice
    - gestures
    - seam
    - plan-5
    - plan-6
  created: 2026-10-17
  originSessionId: cba70f17-7953-4f69-a6f5-f7886bd940d0
  modified: 2026-10-17T21:46:35.029Z
---

Cross-plan seam contract. Plan 5 (hold-to-talk) is the writer, and plan 6 only reads it.

**The reader.** `decide(select, selectedSlab, talkingSid, beaconRaised)` in `src/gesture.js` returns null when `talkingSid === select.sid` or `beaconRaised`. `src/features/fork.js` and `src/features/pipe.js` pass `bus.talking ?? null`.

**No writer yet.** At the plan 6 phase 1 tip, a grep of non-test files under `src/` finds `talking` only in `gesture.js`, `fork.js` and `pipe.js`. Nothing assigns `bus.talking`. The `Bus` class in `src/bus.js` declares `selected` and `selectedSlab` only. Tests pass because the fake bus in `src/gesture.test.mjs` declares `talking: null`.

**What plan 5 must do.**
- Set `bus.talking` to the exact sid string that a `select` event carries for that obelisk. Strict equality means an object, a boolean or a different casing never suppresses.
- Reset it to `null` on release. A stale value silently disables fork and pipe on that sid. The only trace is one `fork: suppressed talking <sid>` log line from `fork.js`.

**The second ad-hoc field.** `bus.beacons` is a `Set` of raised sids. `src/features/state.js` creates it with `bus.beacons ??= new Set()`. `fork.js` and `pipe.js` read it as `bus.beacons?.has(sid) ?? false`. If `state.js` is absent, the acknowledge rule never fires, and a select on a raised beacon forks.

**Re-check before relying on this.** Plan 5 may have landed a writer since. Grep `talking` under `src/` first. If a writer exists, confirm it writes the sid string.

Locate-cue (verify still present before acting): `decide` in `src/gesture.js`, `bus.talking ?? null` in `src/features/fork.js`, `class Bus` in `src/bus.js`. Read in the phase integration worktree at tip a5a3741, the second parent of the landed merge 9a82d13 with a matching tree.

Related: [[pipe-js-clears-the-selected-slab-after-a-send-so-fork-js-must-install-first]], [[three-raycaster-ignores-visible-so-hidden-obelisk-parts-stay-pickable]], [[obelisks-molten-hackathon]].
