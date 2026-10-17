---
name: say-slab-ids-built-from-date-now-alone-collide-and-addslab-replaces-the-earlier-slab
description: "Two say calls inside one millisecond share an id under the plan literal, and the client replaces the first slab."
metadata:
  node_type: memory
  type: project
  keywords:
    - slab id collision
    - Date.now
    - user- id
    - addSlab replace
    - same millisecond
    - PIN-6
    - slabSeq
    - id suffix counter
    - deviation
    - burst caller
  provenance: code-verified
  slug: say-slab-ids-built-from-date-now-alone-collide-and-addslab-replaces-the-earlier-slab
  phase: phase-1
  tags:
    - commands
    - say
    - deviation
    - protocol
    - plan-2
  created: 2026-10-17
  originSessionId: 71aad606-dbd3-4b73-86ee-8ca7e90bf4bb
  modified: 2026-10-17T23:01:30.776Z
---

Conscious deviation from the plan literal. Put it in the plan 2 PR's list of deviations.

**The literal.** PIN-6 pins the user slab id as `'user-' + Date.now()`. `server/commands/say.mjs` mints `'user-' + now + '-' + slabSeq`. The counter is module level and never resets while the module is loaded.

**Why the literal fails.** `addSlab` in `src/obelisk.js` finds a slab by id with `#find`. If the id repeats, it replaces the text of the existing slab. Two ids from one millisecond overwrite each other on the client. The relay does not help. `remember()` in `server/relay.mjs` pushes every slab frame into its cache with no id check. A late client's backfill replays both frames, and the second replaces the first again.

**Who can hit it.** A human typist cannot. `pipe` delegates to `say`, so a `say` followed at once by a `pipe` to the same target can. So can a scripted burst or a voice path that submits twice in a tick.

**Why the deviation is safe.** End state 4 pins no id form, and the `user-` prefix still holds. The slab shape needs only a string `id`, so `isServerEvent` still passes. Hermes echo dedup keys on `session_id` and text, not on the slab id. The audit seats called it intent-consistent.

**Test.** `server/commands/pipe.test.mjs` has an ES4 case that freezes `Date` with `mock.timers` at one value, calls `say` twice, and asserts two distinct ids. That case fails against the plan literal.

**Rule.** Any module that mints a slab id from a clock needs a counter or an owner-supplied id. Same-id means replace on the client.

Locate-cue (verify still present before acting): `slabSeq` and the id expression in `server/commands/say.mjs`; `addSlab` and `#find` in `src/obelisk.js`; `remember` in `server/relay.mjs`; the `mock.timers` ES4 case in `server/commands/pipe.test.mjs`. Grounding: read in the run's `_refinery` integration worktree (`<session-worktree>`), HEAD 4d680c9, the second parent of landed merge b5ba1bd on dev/obelisks-2.

Related: [[obelisk-appenddelta-falls-back-to-the-newest-slab-of-the-role-for-an-unknown-id]], [[pipe-js-clears-the-selected-slab-after-a-send-so-fork-js-must-install-first]].
