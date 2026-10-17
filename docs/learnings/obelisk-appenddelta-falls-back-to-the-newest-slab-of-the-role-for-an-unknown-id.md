---
name: obelisk-appenddelta-falls-back-to-the-newest-slab-of-the-role-for-an-unknown-id
description: A delta for an unseen id lands on the previous closed slab of the same role instead of opening a new slab.
metadata:
  node_type: memory
  type: project
  keywords:
    - appendDelta
    - delta before slab
    - newest of role
    - slab merge
    - streaming delta
    - mid-stream attach
    - reasoning delta
    - Hermes delta
  provenance: code-verified
  slug: obelisk-appenddelta-falls-back-to-the-newest-slab-of-the-role-for-an-unknown-id
  phase: phase-1
  tags:
    - obelisk
    - protocol
    - delta
    - hermes
  created: 2026-10-17
  originSessionId: 24fe07c2-1e38-4429-b5c7-e1be2b220156
  modified: 2026-10-17T21:10:51.332Z
---

Live gotcha at the phase 1 tip. Two audit seats rated it Minor with disposition absorb. The landed code still has it.

**The code.** `appendDelta` in `src/obelisk.js` looks up the slab by `id`. If none matches, a loop takes the newest slab with the same `role`. Only when no slab of that role exists does it call `addSlab`.

**The effect.** The `delta` frame always carries `sid`, `id`, `role`, and `text` (`shared/protocol.mjs`). If a delta arrives before its `slab`, its text appends to the previous closed message of that role. The later `slab` event then makes a separate slab. The old slab keeps the stray text. Every further delta with the same unseen id repeats the miss. Two messages merge, which breaks "one slab per message".

**Who is exposed.** The Hermes source (plan 2) streams reasoning and message deltas. A viewer that attaches mid-stream can see a delta for an id it never saw as a slab. The relay's `remember` in `server/relay.mjs` only appends a delta to an open cached slab with that id, so backfill never creates an orphan. A live stream can. The Claude Code source (plan 3) sends no deltas.

**Why tests miss it.** The synthetic fixture always sends a delta with a matching id.

**Fix.** Delete the newest-of-role loop. Keep `let slab = this.#find(id); if (!slab) return this.addSlab({ id, role, text });`. Update the JSDoc to "append to the slab with that id, else open a new slab".

**Rule.** A delta belongs to the slab with its own id. Never guess a target by role.

Locate-cue (verify still present before acting): `appendDelta` in `src/obelisk.js`. Read at the phase 1 integrated tip (the landed merge's second parent). If a later plan already removed the loop, this note is stale.

Related: [[obelisks-molten-hackathon]].
