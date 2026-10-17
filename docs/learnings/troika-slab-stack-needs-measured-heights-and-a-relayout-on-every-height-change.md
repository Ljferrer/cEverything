---
name: troika-slab-stack-needs-measured-heights-and-a-relayout-on-every-height-change
description: "Stack troika text by measured blockBounds height and re-run the layout on every height change, including a band change with no new sync."
metadata:
  node_type: memory
  type: project
  keywords:
    - troika-three-text
    - textRenderInfo
    - blockBounds
    - slab overlap
    - stack layout
    - LOD band change
    - text.sync callback
    - far to mid relayout
  provenance: code-verified
  slug: troika-slab-stack-needs-measured-heights-and-a-relayout-on-every-height-change
  phase: phase-1
  tags:
    - obelisk
    - layout
    - troika
    - lod
    - tests
  created: 2026-10-17
  originSessionId: 24fe07c2-1e38-4429-b5c7-e1be2b220156
  modified: 2026-10-17T21:10:38.289Z
---

Pattern for any feature that stacks troika text.

**Original defect.** The first obelisk used a fixed 0.12 m slab pitch. Troika text with `anchorY: 'bottom'` grows upward, so any message over about two lines drew over the slab above it. Two fix rounds resolved this before land. Audit finding resolved in a fix round before land, recorded as pattern, not live instance.

**What the tip does.** `src/stack.js` is pure (no three.js). `slabHeight` returns `BAR_HEIGHT` in the far band. Otherwise it returns the `blockBounds` span (`bounds[3] - bounds[1]`) from `textRenderInfo`, or `FALLBACK_SLAB_HEIGHT` before the first sync. `stackLayout(heights, gap)` sums heights and gaps bottom to top. `Obelisk#layoutStack` in `src/obelisk.js` applies the offsets and rides the beacon above the top.

**When the layout must re-run.** A slab's height changes in three cases:
1. Troika `sync` completes. Pass a layout callback to `text.sync(...)`.
2. A slab enters the far band. The bar is shorter than the text.
3. A slab leaves the far band while its text is unchanged.

Case 3 has no sync, so no callback fires. Round 2 of the audit found the layout stayed at bar pitch after a mid to far to mid trip. Both seats rated it Major. The fix is the `else { this.#layoutStack(); }` branch in `#apply`. Short texts that go far to near hit the same branch.

**Tests.** `src/obelisk.test.mjs` asserts no overlap with an oracle that does not share code with `stack.js`. See [[node-test-can-load-three-but-not-troika-stub-it-with-module-registerhooks]].

**Caveat.** The oracle assumes about 30 characters per line and 0.048 m per line at fontSize 0.04. These are estimates. No run measured real troika metrics in a browser or headset.

**Remaining edge.** `addSlab` re-applies only `mid` slabs when a tool slab arrives. A far slab keeps its old summary. On return to mid its new summary lays out only after its sync lands, so it can overlap briefly. A later round rated this a Nit.

**Rule.** Call `layout` from every `text.sync` callback and from every visibility or band toggle that changes height.

Locate-cue (verify still present before acting): `src/stack.js`, `#apply` and `#layoutStack` in `src/obelisk.js`, `src/obelisk.test.mjs`. Read at the phase 1 integrated tip (the landed merge's second parent).

Related: [[three-raycaster-ignores-visible-so-hidden-obelisk-parts-stay-pickable]], [[obelisks-molten-hackathon]].
