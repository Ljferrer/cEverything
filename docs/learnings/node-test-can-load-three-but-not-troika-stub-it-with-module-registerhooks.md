---
name: node-test-can-load-three-but-not-troika-stub-it-with-module-registerhooks
description: "Node tests load three but not troika-three-text, so stub troika with module.registerHooks and mind the Node 22.15 floor."
metadata:
  node_type: memory
  type: project
  keywords:
    - node:test
    - registerHooks
    - troika stub
    - troika-three-text DOM
    - obelisk.test.mjs
    - engines node 22
    - three.js glue test
    - module hooks
  provenance: code-verified
  slug: node-test-can-load-three-but-not-troika-stub-it-with-module-registerhooks
  phase: phase-1
  tags:
    - tests
    - node
    - troika
    - fixture
    - engines
  created: 2026-10-17
  originSessionId: 24fe07c2-1e38-4429-b5c7-e1be2b220156
  modified: 2026-10-17T21:11:17.083Z
---

Fixture technique, plus one open version mismatch.

**The technique.** `troika-three-text` needs a DOM, so a plain `node --test` run cannot import it. `three` itself loads fine under node. `src/obelisk.test.mjs` registers `resolve` and `load` hooks with `registerHooks` from `node:module`. They swap `troika-three-text` for a virtual module that exports a stub `Text`. The stub extends `Object3D`, keeps `textRenderInfo = null`, and queues each `sync(cb)` call in `Text.pending`. A test calls `flushSyncs()` to give each text a fake `blockBounds` and run its callback. This lets node cover `src/obelisk.js` glue that the pure-module tests cannot reach. The test uses a `Text.pending.length` check to prove that a band change queued no sync.

**The oracle.** `measure(text)` in the test assumes about 30 characters per line and 0.048 m per line. It shares no code with `src/stack.js`. It is an estimate, not a troika measurement.

**The mismatch.** `registerHooks` is newer than the engines floor. `package.json` declares `"node": ">=22"`. The audit says the API came in Node 23.5 and was backported to 22.15, so Node 22.0 to 22.14 would fail at import. The audit made that version claim, and it was not re-checked here. The gate ran Node 24.17, so the gate is unaffected. If the floor should be exact, raise `engines` to `>=22.15`.

**Rule.** To test a three.js file that imports troika, stub troika with `registerHooks` before the dynamic `import` of the file under test. Do not `import` it statically.

Locate-cue (verify still present before acting): `registerHooks` use in `src/obelisk.test.mjs`, `engines` in `package.json`. Read at the phase 1 integrated tip (the landed merge's second parent).

Related: [[troika-slab-stack-needs-measured-heights-and-a-relayout-on-every-height-change]].
