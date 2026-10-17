---
name: slabmesh-returns-the-slab-group-and-still-returns-hidden-slabs-with-a-stale-position
description: "Obelisk.slabMesh(id) returns the slab Group, not a Mesh, and it returns a hidden slab whose position is stale."
metadata:
  node_type: memory
  type: project
  keywords:
    - slabMesh
    - slab Group
    - getWorldPosition
    - stale position
    - MAX_VISIBLE
    - MAX_KEPT
    - pylon launch point
    - hidden slab
    - plan faithfulness
    - THREE.Mesh
  provenance: code-verified
  slug: slabmesh-returns-the-slab-group-and-still-returns-hidden-slabs-with-a-stale-position
  phase: phase-2
  tags:
    - obelisk
    - seam
    - pylons
    - plan-mismatch
  created: 2026-10-17
  originSessionId: 24fe07c2-1e38-4429-b5c7-e1be2b220156
  modified: 2026-10-17T21:32:01.658Z
---

Seam note for plan 4 (pylon launch points) and plan 2.

**Plan versus code.** The phase 2 plan slice says `slabMesh(slabId)` returns "the slab's mesh or null". The code returns `#find(slabId)`. That is a `THREE.Group`, not a `THREE.Mesh`. The audit logged it as a Nit with disposition note. The JSDoc states the Group return, and no fix is needed. Plan 4 reads only `getWorldPosition` from it, and a Group supports that.

**What the Group carries.** It has `userData {sid, slabId}` and the extra fields `slabId`, `role`, `full`, `band`, `text` (a troika `Text`), and `bar` (the real `Mesh`). It has no `geometry` or `material`. Do not call `.material` on it. Use `.bar` or `.text` for that.

**Two caveats the tests do not cover.**
- A slab older than the last `MAX_VISIBLE` (40) is still returned. Its `visible` is `false`. `#layoutStack` writes `position.y` only for visible slabs, so the value is the last laid-out one, not the current one.
- A slab older than the newest `MAX_KEPT` (200) is disposed, and `slabMesh` returns `null` for it.

The only test, `slabMesh returns the slab object for an id, null for an unknown one` in `src/obelisk.test.mjs`, checks identity with the stack child and a missing id. It checks neither caveat.

**Rule.** A consumer that anchors to a slab checks `m && m.visible`. Otherwise it falls back to the base (`userData.kind === 'base'`) or the beacon height. A pylon beam from a stale y would point at empty space.

Locate-cue (verify still present before acting): `slabMesh` and `#layoutStack` (`if (slab.visible) slab.position.y = ...`) in `src/obelisk.js`. Read at the phase 2 integrated tip (the landed merge's second parent).

Related: [[three-raycaster-ignores-visible-so-hidden-obelisk-parts-stay-pickable]], [[troika-slab-stack-needs-measured-heights-and-a-relayout-on-every-height-change]], [[obelisk-appenddelta-falls-back-to-the-newest-slab-of-the-role-for-an-unknown-id]].
