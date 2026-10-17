---
name: relay-close-calls-a-module-level-stop-and-ignores-the-handle-a-source-start-returns
description: "relay.close() stops a source only through a module-level stop export, so the claude source's returned stop handle is never called."
metadata:
  promoted: dev/obelisks-3@phase-1
  node_type: memory
  type: project
  keywords:
    - relay.close
    - mod.stop
    - startSource
    - source stop handle
    - leaked fs.watch
    - setInterval keeps event loop open
    - test hang
    - DEFAULT_SOURCES
    - PIN-47
    - module-level stop
  provenance: code-verified
  slug: relay-close-calls-a-module-level-stop-and-ignores-the-handle-a-source-start-returns
  phase: phase-1
  tags:
    - relay
    - sources
    - seam
    - plan-mismatch
    - teardown
  created: 2026-10-17
  originSessionId: 58cf8bf7-7773-43a0-b2c1-98d7dfb2866b
  modified: 2026-10-17T23:02:10.579Z
---

**The seam mismatch.** Plan 1's `startRelay` in `server/relay.mjs` awaits `mod.start(...)` and throws the result away. Its `close()` calls `await mod.stop?.()` on the module. The header comment says a source "may export stop()". `server/sources/synthetic.mjs` does export `stop`.

**What the claude source does.** The plan for it (PIN-47) asked `start()` to return `{stop()}`. `server/sources/claude.mjs` does that. It exports no module-level `stop`. So `relay.close()` leaves the `fs.watch` watcher, the poll interval, and the rescan interval running.

**Why nothing fails yet.** The CLI exits the process, so the demo is unaffected. The `relay()` helper in `server/relay.test.mjs` defaults to `sources: ['synthetic']`. Tests that name `hermes` use a temp `sourcesDir` of fake modules.

**Where it will bite.** `DEFAULT_SOURCES` is `['hermes', 'claude']`. A later relay test on the default sources starts the claude source over the real transcript root. After `close()` the live timers keep the event loop open, and the test process hangs.

**Fix shape.** Plan 3 could not edit plan 1 files (PIN-22), so the repair belongs inside the source. Keep a module-level `Set` of started handles. Add each handle in `start()` and remove it in its `stop()`. Add `export function stop() { for (const h of [...handles]) h.stop(); }`. Two audit seats suggested this. It was not applied before land.

**Contrast, plan 2 phase 1.** `server/sources/hermes.mjs` does both. `start()` resolves to `{stop}` and the module also exports `stop()`, so `relay.close()` reaches it. `server/sources/replay.mjs` exports a module-level `stop()` and its `start()` returns nothing. The relay calls only the module-level `stop`, so that export is the one a new source must have. Grounding: read in the run's `_refinery` integration worktree (`<session-worktree>`), HEAD 4d680c9, the second parent of landed merge b5ba1bd on dev/obelisks-2.

**Rule.** When a plan names a source seam as "returns a handle", check how the host calls it. Here the host calls the module, not the handle. The handle shape is a plan-text assumption, not what the relay does.

Locate-cue (verify still present before acting): `mod.start` and `mod.stop?.()` in `startSource` and `close()` in `server/relay.mjs`. The export list of `server/sources/claude.mjs` has `start` and no `stop`. Read at the landed tip of `dev/obelisks-3` through the `_refinery` worktree, whose HEAD equals the landed SHA. If the claude source exports `stop`, this is fixed.

Related: [[obelisks-molten-hackathon]].
