---
name: projectile-launches-from-the-base-when-a-sources-tool-slab-id-differs-from-its-tool-frame-id
description: "If a source's tool slab id differs from its tool frame id, the sphere silently launches from the obelisk base."
metadata:
  node_type: memory
  type: project
  keywords:
    - tool slab id
    - tool frame id
    - slabId match
    - base fallback
    - projectile launch point
    - PIN-55
    - A2 assumption
    - Hermes tool slab
    - silent degradation
    - tool_use id
    - hermes tool_id
    - tool.start slab id
  provenance: code-verified
  slug: projectile-launches-from-the-base-when-a-sources-tool-slab-id-differs-from-its-tool-frame-id
  phase: phase-1
  tags:
    - pylons
    - seam
    - hermes
    - claude-code
    - plan-4
  created: 2026-10-17
  originSessionId: 7b6542dc-508a-47a9-9f77-990bb5b6cd58
  modified: 2026-10-17T23:01:54.372Z
---

Cross-plan seam. Plan 4 assumed a source gives its tool slab the same id as its `tool` frame. A source that breaks this loses no frame and raises no error.

**The code.** In `src/features/pylons.js`, a `tool` start finds the launch mesh with `obelisk.slabs?.find((s) => s.slabId === frame.id)`. If the slab is missing or hidden it takes `baseOf(obelisk)` instead. So a mismatched id looks the same as a missing slab: the sphere leaves the base, the pylon still glows, and the console stays quiet.

**The assumption.** The plan 4 assumptions table (row A2 in `docs/plans/2026-10-17-obelisks-4-pylons.md`) says it is verified for plan 3 (the Claude Code `tool_use` id) and for the synthetic fixture. It calls it assumed for plan 2 (Hermes), whose tool slab id the plan leaves unstated. The plan accepts the base fallback there and still counts the demo as complete. In `fixtures/synthetic.jsonl` the `a5` slab and its tool frames share the id `a5`.

**Why it matters.** End state 6 was checked only against `--source synthetic`, so no gate checked the Hermes id. A reviewer who sees every Hermes projectile leave the base should compare the source's slab `id` with its tool frame `id` first.

**Update, plan 2 phase 1 (Hermes checked).** The `tool.start` case in `server/sources/hermes.mjs` takes one id: `p.tool_id`, else `<sid>:tool:<seq>`. It opens the `tool` role slab with that id and emits the `tool` frame with the same id. So A2 holds for Hermes when the gateway sends `tool_id`. `tool.complete` reuses `p.tool_id`, else the sid's one open tool id. Two overlapping tools that both lack a `tool_id` can mismatch, and the later complete then loses its cached start args. ES1 in `server/sources/hermes.test.mjs` asserts the tool frame's `id` equals the fake `tool_id` and does not assert the slab id. A live host that omits `tool_id` is unchecked.

Locate-cue (verify still present before acting): the `slabs?.find` and `baseOf` lines in `src/features/pylons.js`; row A2 in `docs/plans/2026-10-17-obelisks-4-pylons.md`; the `tool.start` and `tool.complete` cases in `server/sources/hermes.mjs` (read in the run's `_refinery` integration worktree, HEAD 4d680c9, the second parent of landed merge b5ba1bd on dev/obelisks-2). Grounding: the cwd HEAD was the pre-land base, so this was read in the run's integration worktree at tip 857b5ee, the second parent of landed merge e6ef0f2. The Hermes and Claude Code source files are not on this tip, so the live ids are unchecked.

Related: [[slabmesh-returns-the-slab-group-and-still-returns-hidden-slabs-with-a-stale-position]], [[obelisk-appenddelta-falls-back-to-the-newest-slab-of-the-role-for-an-unknown-id]], [[tool-complete-frames-carry-null-args-so-pylons-js-caches-start-args-by-call-id]].
