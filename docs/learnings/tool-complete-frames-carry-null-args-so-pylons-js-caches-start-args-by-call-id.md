---
name: tool-complete-frames-carry-null-args-so-pylons-js-caches-start-args-by-call-id
description: "A tool complete frame has args null, so the filesystem label needs the start args cached by call id."
metadata:
  node_type: memory
  type: project
  keywords:
    - tool complete args null
    - start args cache
    - call id
    - filesystem pylon label
    - STARTS_KEPT
    - diffCounts
    - write_file
    - synthetic fixture
    - path +n/-m
    - remember
  provenance: code-verified
  slug: tool-complete-frames-carry-null-args-so-pylons-js-caches-start-args-by-call-id
  phase: phase-1
  tags:
    - pylons
    - protocol
    - fixture
    - plan-4
  created: 2026-10-17
  originSessionId: 7b6542dc-508a-47a9-9f77-990bb5b6cd58
  modified: 2026-10-17T22:11:47.422Z
---

Protocol fact for any consumer that needs the tool arguments at `complete` time.

**The fact.** In `fixtures/synthetic.jsonl` every `tool` frame with `phase:"complete"` has `"args":null`. The `a5` `write_file` start carries `args.path` (`server/relay.mjs`). Its complete carries only `summary`, which already reads `server/relay.mjs +2/-1`, and the unified `diff`. The path exists only on the start frame.

**What pylons.js does.** `src/features/pylons.js` calls `remember(frame.id, frame.args)` on every start. The `starts` Map keeps at most `STARTS_KEPT` (256) entries. It skips a null id or empty args, re-inserts a repeat id so the order refreshes, and evicts the oldest entry past the cap. On a filesystem `complete` it reads `frame.args ?? starts.get(frame.id) ?? {}`, takes `args.path ?? args.file_path ?? ''`, and sets the detail label to the path, a newline, then `+n/-m` from `diffCounts(frame.diff)`. It then deletes the entry.

**Limits.**
- A start with no complete stays in the Map until eviction.
- If a complete arrives under a different `id` than its start, the path is empty and the label shows only the counts.
- Only the synthetic fixture was read. The live Hermes and Claude Code sources sit on other plan branches and were not checked at this tip.
- The label recomputes counts from the diff. It does not parse `summary`, so a live source may word `summary` differently without a break.

Locate-cue (verify still present before acting): `remember`, `STARTS_KEPT` and the `frame.args ?? starts.get(frame.id)` read in `src/features/pylons.js`; lines for `a5` in `fixtures/synthetic.jsonl`. Grounding: read in the run's integration worktree at tip 857b5ee, the second parent of landed merge e6ef0f2. The cwd HEAD was the pre-land base.

Related: [[maplines-nameless-orphan-tool-complete-is-dropped-by-the-emit-path-not-by-mapline]], [[projectile-launches-from-the-base-when-a-sources-tool-slab-id-differs-from-its-tool-frame-id]].
