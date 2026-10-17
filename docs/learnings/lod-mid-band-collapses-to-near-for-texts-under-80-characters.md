---
name: lod-mid-band-collapses-to-near-for-texts-under-80-characters
description: "lod() never returns mid for a text under 80 characters, so a consumer that branches on the band name never sees mid for it."
metadata:
  node_type: memory
  type: project
  keywords:
    - lod
    - mid band
    - near band
    - short text
    - 80 characters
    - band name
    - midSummary
    - LOD hysteresis
    - D13
  provenance: code-verified
  slug: lod-mid-band-collapses-to-near-for-texts-under-80-characters
  phase: phase-1
  tags:
    - lod
    - plan-code-mismatch
    - obelisk
    - seam
  created: 2026-10-17
  originSessionId: 24fe07c2-1e38-4429-b5c7-e1be2b220156
  modified: 2026-10-17T21:11:10.571Z
---

Plan and code read differently here. The behavior fits the plan's intent.

**The plan.** End state 3 says `lod(distance, textLength)` returns `mid` between 1.5 m and 5 m, "with full text at `mid` for texts under 80 characters". A reader can take that to mean the band stays `mid` and the viewer sees full text.

**The code.** `lod` in `src/lod.js` ends with `band === 'mid' && textLength < SHORT ? 'near' : band`. So `lod(3, 40)` returns `near`. `src/lod.test.mjs` asserts `lod(3, 0)`, `lod(3, 40)`, and `lod(3, 79)` return `near`, and `lod(3, 80)` returns `mid`. The viewer still sees full text at mid distance, which is what D13 wants. The header comment of `lod.js` documents the collapse.

**The trap.** A consumer in plans 2 to 6 that branches on the band name never gets `mid` for a short slab. Code that means "the slab shows a summary" should test the text, not the band name. In `src/obelisk.js`, `addSlab` re-applies only slabs whose `band` is `mid` when a tool slab arrives. That is correct because a short slab has no summary to refresh.

**Edge.** `distance < farEdge ? 'mid' : 'far'` puts exactly 5.0 m in `far`. D13 writes mid as 1.5 to 5 m. No test pins the 5.0 point and no consumer depends on it. If a later plan pins the edge as inclusive, change `<` to `<=` and add a `lod(5, LONG)` assertion.

**Rule.** Treat `near` as "full text" and `mid` as "summary". Do not read either as a pure distance bucket.

Locate-cue (verify still present before acting): `lod` and `SHORT` in `src/lod.js`, the short-text test in `src/lod.test.mjs`. Read at the phase 1 integrated tip (the landed merge's second parent).

Related: [[troika-slab-stack-needs-measured-heights-and-a-relayout-on-every-height-change]].
