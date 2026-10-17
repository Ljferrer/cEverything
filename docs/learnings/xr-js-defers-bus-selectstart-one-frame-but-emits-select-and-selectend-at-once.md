---
name: xr-js-defers-bus-selectstart-one-frame-but-emits-select-and-selectend-at-once
description: "xr.js emits bus selectstart one frame late but select and selectend at once, so a sub-frame tap can deliver the release first."
metadata:
  node_type: memory
  type: project
  keywords:
    - selectstart
    - selectend
    - nextFrame
    - deferred emit
    - release before press
    - sub-frame tap
    - hold-to-talk
    - event ordering
    - transient pointer
    - controller listener
  provenance: code-verified
  slug: xr-js-defers-bus-selectstart-one-frame-but-emits-select-and-selectend-at-once
  phase: phase-1
  tags:
    - xr
    - bus
    - voice
    - ordering
    - plan-1
    - plan-5
    - plan-6
  created: 2026-10-17
  originSessionId: c9d28c43-3279-46de-a04e-0b6f5b953eb4
  modified: 2026-10-17T22:05:33.739Z
---

Ordering gotcha for any feature that arms on bus `selectstart` and releases on bus `selectend`.

**The code.** In `src/features/xr.js` the controller `selectstart` handler wraps its bus emit in `nextFrame(...)`. That is a once-listener on the bus `frame` event. The `select` and `selectend` handlers emit at once. The deferral exists because a Vision Pro transient pointer has no pose until its first frame.

**The consequence.** If a controller fires `selectstart` and `selectend` before the next animation frame, the bus gets `selectend` first. A release handler that checks state set by `selectstart` finds nothing and returns. The late `selectstart` then arms the feature with no release to come.

**Live instance.** `src/features/voice.js` at the plan 5 phase 1 tip has this hole. Its `selectend` listener returns on `!rec`. Its `selectstart` listener arms on `sid === bus.selected` and never checks that the press is still held. `applySelection` has already set `bus.selected` from the immediate `select`, so the arm check passes even on the first tap of a new obelisk. The recorder then runs, the `● REC` glyph stays up, `bus.talking` becomes the sid 300 ms later, and the next `selectend` from that controller ships everything said since the tap.

**How often it happens is unproven.** One audit seat reasoned that Quest Browser fires input events before the rAF callback of the same frame, so the order cannot occur there. A later seat reasoned that WebXR queues input events as tasks, so a tap shorter than one frame (about 14 ms at 72 Hz) is plausible. Nobody reproduced it on a device.

**Fix shape (written in the audit, not landed).**
- Track the raw press per controller with `selectstart` and `selectend` listeners on `renderer.xr.getController(i)`.
- Return from the bus `selectstart` listener when that controller is no longer pressed.
- `src/main.js` installs features in sorted filename order, so `voice.js` installs before `xr.js` and its controller listeners run first.
- Reset the press state on the XR `sessionend`.

**Timing offset.** `startedAt` in `voice.js` is taken at the deferred bus event. A 300 ms hold filter therefore needs about 314 ms of physical hold. Any plan 6 gesture timer that starts on bus `selectstart` carries the same offset.

Locate-cue (verify still present before acting): `nextFrame` and the three controller handlers in `src/features/xr.js`, the `selectstart` and `selectend` listeners in `src/features/voice.js`, the sorted `import.meta.glob` loop in `src/main.js`. Read in the `_refinery` integration worktree, whose HEAD equalled landed tip 291eb2d on dev/obelisks-5.

Related: [[voice-js-landed-without-its-audit-fixes-because-both-fix-commits-were-reverted]], [[decide-compares-bus-talking-to-the-sid-string-and-nothing-sets-bus-talking-yet]].
