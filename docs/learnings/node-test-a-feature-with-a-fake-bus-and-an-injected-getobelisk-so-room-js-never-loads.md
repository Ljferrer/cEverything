---
name: node-test-a-feature-with-a-fake-bus-and-an-injected-getobelisk-so-room-js-never-loads
description: "Features take ctx.getObelisk and lazy-import room.js, so a node test drives them with a fake bus and never loads troika."
metadata:
  node_type: memory
  type: project
  keywords:
    - fake bus
    - recording net
    - ctx.getObelisk
    - lazy import room.js
    - mock.timers Date
    - node:test feature fixture
    - gesture.test.mjs
    - queueMicrotask await
    - troika avoid
  provenance: code-verified
  slug: node-test-a-feature-with-a-fake-bus-and-an-injected-getobelisk-so-room-js-never-loads
  phase: phase-1
  tags:
    - tests
    - node
    - fixture
    - features
    - plan-6
  created: 2026-10-17
  originSessionId: cba70f17-7953-4f69-a6f5-f7886bd940d0
  modified: 2026-10-17T21:46:44.284Z
---

Fixture recipe for a file under `src/features/` that reacts to the bus and reaches obelisks. It is the cheaper sibling of the troika stub.

**Why injection works.** `src/features/room.js` imports `troika-three-text`, which needs a DOM. A feature that imports `room.js` statically cannot load under `node --test`. `pipe.js` and `state.js` avoid that. They read `ctx.getObelisk`, and if it is absent they run `room ??= import('./room.js')` on first use. `main.js` supplies no `getObelisk`, so production takes the lazy path. A test passes a fake.

**The recipe, from `src/gesture.test.mjs`.**
- Fake bus: an `EventTarget` with `selected`, `selectedSlab`, `talking: null` and an `emit(type, detail)` that dispatches a `CustomEvent`.
- Recording net: `{ send: (c) => sent.push(c) }`, then `deepStrictEqual` on `sent`.
- Fake obelisk: `children: [{ userData: {kind:'base'}, material: {color: new THREE.Color()} }]`, plus recording `setState`, `setBeacon` and `slabs: []`. Pass `getObelisk: (sid) => fakes[sid]` in the install ctx.
- Omit `scene` from the ctx. `pipe.js` then skips the line drawing, so the `setTimeout` removal never runs.
- A `Date.now()` throttle: `mock.timers.enable({ apis: ['Date'] })`, `mock.timers.tick(ms)`, and `mock.timers.reset()` in a `finally`.
- Log lines are part of the contract: `t.mock.method(console, 'log', () => {})`, then assert on the joined call arguments.
- A `queueMicrotask` effect: one `await Promise.resolve()` is enough to let it run.

**The gap.** The lazy `import('./room.js')` branch in `pipe.js` and `state.js` never runs under node. Every test either injects `getObelisk` or omits `scene`. A typo in that branch would pass the gate.

**When to use the stub instead.** If the file under test imports troika itself, such as `src/obelisk.js`, inject nothing and stub troika with `registerHooks`.

Locate-cue (verify still present before acting): `ctx.getObelisk` and `import('./room.js')` in `src/features/pipe.js` and `src/features/state.js`, `fakeBus` and `fakeObelisk` in `src/gesture.test.mjs`. Read in the phase integration worktree at tip a5a3741, the second parent of the landed merge 9a82d13 with a matching tree.

Related: [[node-test-can-load-three-but-not-troika-stub-it-with-module-registerhooks]], [[pipe-js-clears-the-selected-slab-after-a-send-so-fork-js-must-install-first]].
