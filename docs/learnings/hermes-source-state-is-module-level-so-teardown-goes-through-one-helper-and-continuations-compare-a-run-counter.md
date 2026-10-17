---
name: hermes-source-state-is-module-level-so-teardown-goes-through-one-helper-and-continuations-compare-a-run-counter
description: "hermes.mjs keeps one module-level socket, so a retry that outlives stop and start must compare a run counter."
metadata:
  node_type: memory
  type: project
  keywords:
    - run counter
    - gen
    - dropSocket
    - scheduleRetry
    - stale continuation
    - module-level state
    - socket leak
    - resumed set
    - errorState
    - stop then start
    - retry race
  provenance: code-verified
  slug: hermes-source-state-is-module-level-so-teardown-goes-through-one-helper-and-continuations-compare-a-run-counter
  phase: phase-1
  tags:
    - hermes
    - sources
    - pattern
    - async
    - retry
    - plan-2
  created: 2026-10-17
  originSessionId: 71aad606-dbd3-4b73-86ee-8ca7e90bf4bb
  modified: 2026-10-17T23:01:38.276Z
---

Pattern for any source that keeps module-level state and a background retry timer.

**The shape that landed.** `start()` calls `stop()`, then `reset()` bumps `gen`. `dropSocket(reason)` in `server/sources/hermes.mjs` is the one teardown path. It rejects pending requests, clears `resumed`, nulls `ws`, removes the socket's listeners and terminates it. `onClose` and the `scheduleRetry` catch both call it. `scheduleRetry` captures `run = gen` first and bails after each await when `run !== gen`. `errorState(sid)` writes `status:'error'` into `sessions` as well as emitting it, so a later same-status upsert still emits the recovery state.

**Why it has this shape.** Round one of the audit found several defects with one root. Teardown was split across `onClose` and the retry catch. The results were a leaked socket, a stale close listener that nulled a newer `ws`, and a `resumed` set that survived a drop so the next socket skipped `session.resume`. A separate defect: the error state was emitted but never stored, so a same-status update stayed silent. Audit finding resolved in a fix round before land, recorded as pattern, not live instance.

**The rule.** Capture the run counter before the first await of any continuation that can outlive `stop()` plus `start()`. Compare it after each await. Route every teardown through one helper. Store every status the source emits.

**One residual gap (live).** `listAndAttach` compares only `run !== gen`. A bare `stop()` bumps no `gen`, so a retry's attach loop keeps running. Each remaining sid then emits an error state through the stopped run's emit. This is harmless today, because the relay calls `stop()` only from `close()` after its clients are gone. A guard of `if (run !== gen || stopped) return;` closes it.

**Test caveat.** The `m9` slab-count check in the failed-handshake retry test of `server/sources/hermes.test.mjs` cannot fail. The event goes out only on the newest socket, so a leaked older socket never sees it. The `readyState` check beside it carries the proof.

Locate-cue (verify still present before acting): `gen`, `reset`, `dropSocket`, `errorState`, `scheduleRetry`, `listAndAttach` in `server/sources/hermes.mjs`; the `m9` check in `server/sources/hermes.test.mjs`. Grounding: read in the run's `_refinery` integration worktree (`<session-worktree>`), HEAD 4d680c9, the second parent of landed merge b5ba1bd on dev/obelisks-2.

Related: [[relay-close-calls-a-module-level-stop-and-ignores-the-handle-a-source-start-returns]], [[a-poller-and-a-discoverer-sharing-a-map-need-the-record-published-last-by-construction]].
