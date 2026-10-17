---
name: claude-source-caps-bound-discovery-only-because-the-protocol-has-no-remove-frame
description: "The claude source's chat cap, agent cap, and recency window gate new discovery only, so the room can pass six chats."
metadata:
  node_type: memory
  type: project
  keywords:
    - max chats cap
    - maxAgents
    - recency window
    - sinceMinutes
    - claude-max
    - room size
    - End state 13
    - remove obelisk frame
    - already tracked stays tracked
    - demo laptop
  provenance: code-verified
  slug: claude-source-caps-bound-discovery-only-because-the-protocol-has-no-remove-frame
  phase: phase-1
  tags:
    - claude-source
    - protocol
    - demo
    - design-decision
  created: 2026-10-17
  originSessionId: 58cf8bf7-7773-43a0-b2c1-98d7dfb2866b
  modified: 2026-10-17T22:05:53.826Z
---

**The behavior.** `scan()` in `server/sources/claude.mjs` keeps the newest `cap` chats by mtime (default 6). It then adds every chat that is already tracked, even past the cap. Agents work the same way: the newest `agentCap` (default 8) per chat are tracked, and none is dropped later. The recency window (default 30 min) skips only files that are not yet tracked. A tracked file stays tracked after it goes quiet.

**Why.** Plan 1's protocol has no frame that removes an obelisk. The server events are `mode`, `session`, `slab`, `delta`, `tool`, `state`, and `error`. The relay's `remember()` only sets, so its session cache never evicts. If the source stopped tracking a chat, the client would still show that obelisk, frozen. Untracking would stop the updates and remove nothing.

**What End state 13 means.** The row says the defaults keep the live room to at most 6 chat obelisks. That holds at start. It does not hold over a long demo: each new chat that enters the window joins the room and none leaves. The row is a backstop the operator checks by hand, with `--claude-max 3` as the test knob. Two audit seats called this consistent with the intent and left it as a note.

**Rule.** Do not read these caps as a ceiling on room size. If the room must shrink, plan 1 needs a remove or hide frame first. That is a protocol change, not a source change.

**Chat versus agent.** A resumed multi-hour chat only joins when it grows, because the window gates new files and growth moves its mtime inside the window.

Locate-cue (verify still present before acting): the `chats = candidates.slice(0, cap).concat(...filter((c) => files.has(c.p)))` line and the `agents.slice(0, agentCap)` loop in `scan()` in `server/sources/claude.mjs`, and `SERVER_EVENTS` in `shared/protocol.mjs`. Read at the landed tip of `dev/obelisks-3` through the `_refinery` worktree, whose HEAD equals the landed SHA.

Related: [[obelisks-molten-hackathon]].
