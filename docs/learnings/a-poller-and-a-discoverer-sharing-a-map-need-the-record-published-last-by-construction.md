---
name: a-poller-and-a-discoverer-sharing-a-map-need-the-record-published-last-by-construction
description: "Register a tailed-file record in the shared map only after its session frame and seed are sent, or the poll tick reads it half-seeded."
metadata:
  node_type: memory
  type: project
  keywords:
    - poll tick race
    - track seed
    - half-seeded record
    - files.set order
    - session before slab
    - duplicate slab ids
    - readTail byte 0
    - async registration
    - fs.watch rescan
    - claude source
  provenance: agent-unverified
  slug: a-poller-and-a-discoverer-sharing-a-map-need-the-record-published-last-by-construction
  phase: phase-1
  tags:
    - claude-source
    - race
    - polling
    - ordering
    - audit-resolved
  created: 2026-10-17
  originSessionId: 58cf8bf7-7773-43a0-b2c1-98d7dfb2866b
  modified: 2026-10-17T22:04:55.137Z
---

Audit finding resolved in a fix round before land. This note records the pattern, not a live instance.

**The pattern.** A source discovers files asynchronously and tails them on a separate interval. Two actors then share one map. `track()` awaits stat, readFile, and readJson before it can send the file's `session` frame and seed. The poll `tick()` walks the same map. If `track()` registers the record first, a tick can reach it while its offset is still 0.

**What the early record caused.** Three audit seats reached the same chain by reading the code. Nobody reproduced it without an injected delay.
- The tick reads the file from byte 0 and sends a frame for every line, before the `session` frame.
- The tick sees an undefined status and sends a `state` frame before the `session` frame.
- `track()` then feeds the same bytes again and re-sends the seed, so slab ids repeat. The relay's `remember()` pushes slabs with no dedupe, so the repeats stay in the late-joiner cache.
- If `readTail` adds `bytesRead` after `track()` sets the offset, the offset doubles. The next tick reads a shrink, resets to 0, and re-emits the whole file.

**What bounded the claim (the refute pass).** The first `await rescan()` finishes before the interval timers start. So the files found at start were never exposed. Only files tracked later were: new chats and every new workflow agent. The window is the stat plus read time of one file. A worker measured about 70 ms for a 50,000-line transcript against a 1000 ms default tick.

**The fix that landed.** `track()` builds the record locally. It calls `files.set` only after `send(session)` and the seed loop. Bytes appended during the read sit past the stored offset, so the next tick tails them with no loss and no repeat. Only `scan()` calls `track()`, and scans serialize on one promise chain, so the late `set` cannot track a file twice.

**A weaker fix the audit first reached for.** A per-file `reading` flag. The simplicity seat first called that flag redundant with the tick-level `ticking` guard, then withdrew the claim. A guard inside the tick cannot protect against a record the tick should never have seen. After the ordering fix the flag had no reader, and a later commit deleted it as dead code.

**Rule.** When a poller and a discoverer share a map, publish the record last, by construction. Do not add a flag to the record.

Locate-cue (verify still present before acting): the comment "`f` stays local until the seed is sent" and the closing `files.set(p, f)` in `track()` in `server/sources/claude.mjs`. Read at the landed tip of `dev/obelisks-3` through the `_refinery` worktree, whose HEAD equals the landed SHA. The test side of this fix is [[race-fix-test-arms-go-red-only-when-a-tick-lands-in-the-window-so-prove-them-with-an-injected-delay]].

Related: [[obelisks-molten-hackathon]].
