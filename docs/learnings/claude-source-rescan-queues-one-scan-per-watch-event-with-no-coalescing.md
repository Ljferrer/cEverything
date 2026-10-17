---
name: claude-source-rescan-queues-one-scan-per-watch-event-with-no-coalescing
description: "The claude source chains one full scan per debounced watch event, so a scan slower than 50 ms builds a backlog."
metadata:
  node_type: memory
  type: project
  keywords:
    - rescan chain
    - watch debounce
    - fs.watch recursive
    - unbounded promise chain
    - scan backlog
    - coalesce rescans
    - readdir stat cost
    - claude source
  provenance: code-verified
  slug: claude-source-rescan-queues-one-scan-per-watch-event-with-no-coalescing
  phase: phase-1
  tags:
    - claude-source
    - performance
    - watcher
    - known-gap
  created: 2026-10-17
  originSessionId: 58cf8bf7-7773-43a0-b2c1-98d7dfb2866b
  modified: 2026-10-17T22:05:17.442Z
---

**The shape.** In `start()` of `server/sources/claude.mjs`, `rescan()` does `chain = chain.then(scan)`. Every call appends a scan. The recursive `fs.watch` fires on every transcript append. A 50 ms debounce lets at most 20 calls per second through. A queued scan gains nothing from a second queued copy.

**The risk.** A scan lists every project directory, stats every transcript, and walks the subagent tree of each tracked chat. If one scan takes longer than 50 ms while any session writes, scans arrive faster than they run. The backlog grows for as long as Claude Code keeps writing, and the CPU stays busy rescanning.

**What is not known.** Nobody measured a scan on a real tree. The plan's context puts the default root at about 240 directory reads and 336 stats. The audit capped the finding at Minor for that reason. Treat the growth as reasoned from the code, not observed.

**State at land.** Two seats marked it absorb. The fix round fixed the poll race only, so the chain is still uncoalesced at the landed tip.

**Fix shape.** Coalesce. Keep `scanning` and `again` flags. A call while a scan runs sets `again = true` and returns. The running scan loops `do { again = false; await scan(); } while (again && !stopped)` inside a try/catch that logs, and clears `scanning` in `finally`.

**When to care.** At the live demo, on a laptop with a large `projects` tree and several sessions writing. If the room feels slow or the node process holds a core, look here first.

Locate-cue (verify still present before acting): `const rescan = () => { chain = chain.then(scan)...` and the 50 ms `watchDebounce` in `start()` in `server/sources/claude.mjs`. Read at the landed tip of `dev/obelisks-3` through the `_refinery` worktree, whose HEAD equals the landed SHA.

Related: [[a-poller-and-a-discoverer-sharing-a-map-need-the-record-published-last-by-construction]].
