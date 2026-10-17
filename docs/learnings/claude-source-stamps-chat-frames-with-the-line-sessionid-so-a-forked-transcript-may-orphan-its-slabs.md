---
name: claude-source-stamps-chat-frames-with-the-line-sessionid-so-a-forked-transcript-may-orphan-its-slabs
description: "Hypothesis: the claude source takes a chat slab's sid from the line's sessionId, so copied history could target a sid with no session frame."
metadata:
  node_type: memory
  type: project
  keywords:
    - sessionId mismatch
    - resumed session
    - forked transcript
    - orphan slab
    - handleLine sid
    - obj.sessionId
    - rememberSlab title
    - titleOf contract
    - copied history
    - claude source
  provenance: agent-unverified
  slug: claude-source-stamps-chat-frames-with-the-line-sessionid-so-a-forked-transcript-may-orphan-its-slabs
  phase: phase-1
  tags:
    - claude-source
    - hypothesis
    - real-data
    - resume
    - fork
  created: 2026-10-17
  originSessionId: 58cf8bf7-7773-43a0-b2c1-98d7dfb2866b
  modified: 2026-10-17T22:05:46.536Z
---

**This is a hypothesis note.** The code path is confirmed at the landed tip. Whether real transcripts ever trigger it is untested. Neither the fixtures nor the live run in End state 12 showed it.

**The code.** `handleLine` in `server/sources/claude.mjs` sets `sid = (obj.isSidechain ? obj.agentId : obj.sessionId) ?? f.sid`. It stamps every frame from that line with it. The plan wrote this rule literally and assumes the line's `sessionId` equals the file's basename, which is the tracked chat's `sid`. The plan's decision D42 also asked for a cross-check against the line's `sessionId`. The slice text dropped the cross-check, so the code has none.

**The hypothesis.** A resumed or forked Claude Code session may copy earlier history into a new file with the old `sessionId`. If so, those slabs carry a `sid` that has no `session` frame. The client would hold slabs for an obelisk that never appears. Plan 1's relay does keep such sids: its `backfill` replays "sids with no `session` frame" after the rest.

**A second effect on `titleOf`.** `rememberSlab` calls `records.get(sid) ?? record(sid, sid)`. For a `sid` that no `session` frame announced, it creates a record titled with the sid. Plan 1's `titleOf` seam then returns the raw sid where PIN-42 says `undefined`. One audit seat asked for a fix and none landed.

**How to settle it.** Check one real forked or resumed transcript for a `sessionId` that differs from the file name. If it differs, stamp frames with the tracked file's `sid` and keep the line value only as a cross-check. If it never differs, close this note.

**Rule.** A source that trusts an id inside a line over the id of the file that holds it can split one session across two sids. Pick one owner for the id.

Locate-cue (verify still present before acting): the `const sid = (obj.isSidechain ? obj.agentId : obj.sessionId) ?? f.sid` line in `handleLine` and `rememberSlab` in `server/sources/claude.mjs`. Read at the landed tip of `dev/obelisks-3` through the `_refinery` worktree, whose HEAD equals the landed SHA. The real-data claim stays unverified until a real transcript is read.

Related: [[obelisk-appenddelta-falls-back-to-the-newest-slab-of-the-role-for-an-unknown-id]], [[obelisks-molten-hackathon]].
