---
name: maplines-nameless-orphan-tool-complete-is-dropped-by-the-emit-path-not-by-mapline
description: "mapLine returns a tool complete frame with no name for an orphan tool_result, and only send() drops it through isServerEvent."
metadata:
  node_type: memory
  type: project
  keywords:
    - orphan tool_result
    - tool_use pending map
    - nameless tool frame
    - isServerEvent
    - SERVER_SHAPES tool name
    - mapLine output vs emitted frames
    - dropped invalid frame
    - claude source
    - adjudicated delta
  provenance: code-verified
  slug: maplines-nameless-orphan-tool-complete-is-dropped-by-the-emit-path-not-by-mapline
  phase: phase-1
  tags:
    - claude-source
    - protocol
    - plan-mismatch
    - adjudicated
  created: 2026-10-17
  originSessionId: 58cf8bf7-7773-43a0-b2c1-98d7dfb2866b
  modified: 2026-10-17T22:05:53.962Z
---

**The mismatch.** The plan's `mapLine` shape lets a `tool_result` with no matching `tool_use` yield `tool {phase:'complete'}` with no `name`. Plan 1's `SERVER_SHAPES.tool` in `shared/protocol.mjs` requires `name` as a string. So that frame is not a valid server event.

**The ruling.** The phase adjudicated this as a delta. `mapLine` keeps the plan's nameless shape. `start` emits only frames that pass `isServerEvent`, and it logs and drops the rest. The ES7 case asserts the nameless output of `mapLine` for an orphan result. The audit seats confirmed the ruling and filed no follow-up.

**The consequence for readers.** `mapLine` output is not the emitted stream. A caller that reads `mapLine` directly, such as a unit test or a later plan's helper, sees frames the relay would reject. Filter through `isServerEvent` first, or call through `start`.

**When it happens.** The per-file `pending` map is filled from a parse of the whole file, not only the seeded tail. So the usual cause is a result whose `tool_use` lives in another file or was cut away. It is rare on a clean transcript. The orphan result produces no frame, and the source logs `dropped invalid frame`.

**Rule.** When a plan's pure mapper and the shared protocol disagree on a required field, keep the mapper faithful and let the emit path enforce the protocol. Record the delta where both sides are visible.

Locate-cue (verify still present before acting): the `pending.get(toolId)` read in `mapLine` and the `isServerEvent` check in `send()` in `server/sources/claude.mjs`, `SERVER_SHAPES.tool` in `shared/protocol.mjs`, and the `orphan` assertion in `server/sources/claude.test.mjs`. Read at the landed tip of `dev/obelisks-3` through the `_refinery` worktree, whose HEAD equals the landed SHA.

Related: [[obelisks-molten-hackathon]].
