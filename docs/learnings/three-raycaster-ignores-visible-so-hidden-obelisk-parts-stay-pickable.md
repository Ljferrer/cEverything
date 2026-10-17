---
name: three-raycaster-ignores-visible-so-hidden-obelisk-parts-stay-pickable
description: "Raycaster never checks visible, so hidden slabs and the hidden beacon can still be selected by a ray at the phase 1 tip."
metadata:
  node_type: memory
  type: project
  keywords:
    - Raycaster visible
    - invisible pick
    - hidden slab
    - beacon pick
    - intersectObjects
    - firstVisibleHit
    - MAX_VISIBLE
    - select ray
    - hidden beacon fork
    - bus.beacons acknowledge
  provenance: code-verified
  slug: three-raycaster-ignores-visible-so-hidden-obelisk-parts-stay-pickable
  phase: phase-1
  tags:
    - raycast
    - input
    - obelisk
    - xr
    - laptop
  created: 2026-10-17
  originSessionId: 24fe07c2-1e38-4429-b5c7-e1be2b220156
  modified: 2026-10-17T21:46:57.626Z
---

Live gotcha at the phase 1 tip. Audit proposed a fix and nobody applied it.

**The three.js fact.** `node_modules/three/src/core/Raycaster.js` has no `visible` check (a grep for `visible` returns nothing). `intersectObjects(targets, true)` returns hits on objects whose `visible` is false.

**What stays pickable.**
- Slabs past `MAX_VISIBLE` (40). `#layoutStack` in `src/obelisk.js` sets `slab.visible = false` on the Group only. Its text and bar children keep their own `visible` flags and `userData {sid, slabId}`. The layout writes `position.y` only for visible slabs. A hidden slab keeps its last laid-out y, so it can sit inside the live stack.
- The beacon. It is hidden by default and carries `userData {sid, kind:'base'}`. A ray above the stack selects the obelisk with nothing drawn there.

**Where the hit is taken.** `cast()` in `src/features/xr.js` and the pointerup handler in `src/features/laptop.js` both take `intersectObjects(targets, true)[0]`. Neither filters on visibility. `hitToEvent` in `src/input.js` then maps the hit to a `select`, and `applySelection` sets `bus.selected` and `bus.selectedSlab`.

**Why tests miss it.** The synthetic room repeats ids and never reaches 40 slabs. The beacon is plan 6's seam, so no pick test turns it on.

**Fix proposed, not applied.** Either remove hidden slabs from the `stack` group and re-add them in the window, and add or remove the beacon in `setBeacon`. Or export `firstVisibleHit(hits)` from `src/input.js`. It would return the first hit whose object and every ancestor have `visible !== false`. A filter on `hit.object.visible` alone is not enough, because the hidden Group's children stay visible. A grep for `firstVisibleHit` at the tip finds nothing.

**Plan 6 phase 1 built on it and did not fix it (recurrence, read from code, not reproduced in a browser).** `src/features/state.js` calls `setBeacon(true)` for a `waiting` status and adds the sid to `bus.beacons`. `src/features/fork.js` turns any base select into a fork unless `bus.beacons` has that sid. The beacon is hidden until a `waiting` status raises it, and a ray still hits it while hidden (`userData.kind` is `'base'`). So a stray ray through the hidden beacon of a non-waiting obelisk selects it, and `fork.js` then sends `{t:'fork', sid}` from an editing client. The beacon is a small cone (`ConeGeometry(0.08, 0.3, 6)`), so the risk is narrow. When the beacon is raised, the same hit is the intended acknowledge: it lowers the beacon and suppresses the fork. `src/input.js`, `src/features/xr.js` and `src/features/laptop.js` still contain no `visible` check at the plan 6 tip.

**Rule.** Plans 4 and 6 add pick targets and a beacon. Filter hits by every ancestor's `visible`, or take the target out of the scene graph.

Locate-cue (verify still present before acting): `slab.visible = i >= firstVisible` and `setBeacon` in `src/obelisk.js`, `[0]` at the two cast sites. Read at the phase 1 integrated tip (the landed merge's second parent).

Related: [[troika-slab-stack-needs-measured-heights-and-a-relayout-on-every-height-change]].
