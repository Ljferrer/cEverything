---
name: live-relay-record-end-state-check-can-pass-while-the-relay-dies-on-a-busy-port
description: A live --record end-state check with no --port passes through an EADDRINUSE crash because recording happens before listen.
metadata:
  node_type: memory
  type: project
  keywords:
    - EADDRINUSE
    - port 8787
    - relay --record
    - live end-state check
    - LIVE_CLAUDE_OK
    - kill no such process
    - listen order
    - startRelay
    - end-state authoring
    - source started before listen
  provenance: code-verified
  slug: live-relay-record-end-state-check-can-pass-while-the-relay-dies-on-a-busy-port
  phase: phase-1
  tags:
    - relay
    - end-state
    - plan-authoring
    - gate-audit
    - ports
  created: 2026-10-17
  originSessionId: 58cf8bf7-7773-43a0-b2c1-98d7dfb2866b
  modified: 2026-10-17T22:05:38.364Z
---

**The check shape.** End state 12 of the Claude Code plan starts `node server/relay.mjs --source claude --record <file>` in the background. It sleeps 15 s, kills the pid, then reads the record file for a claude `chat` session and one `slab`. It passes no `--port`, so the relay binds the default port 8787.

**What the gate run showed.** Something already held that port. The evidence does not name the holder. The relay logged `tracking N file(s)` and `source started: claude`, then died with a fatal EADDRINUSE. The record file still held the frames, so the script printed `LIVE_CLAUDE_OK`. The one red statement was the `kill` of an already-exited pid ("No such process"), so the stamp read red. The gate auditor ruled the row met and called the red statement environmental.

**Why it passes.** In `startRelay` in `server/relay.mjs`, sources start first, and `broadcast` appends each frame to the record file. The `WebSocketServer` is created after that, and the listen error comes later. A busy port therefore kills the relay after the source and record path ran.

**What the row does not prove.** It does not show that the relay can listen or that a client can connect. It proves the source emits frames from a live transcript into the record file.

**Rule for authors.** Pass `--port` with a free port, or `--port 0`, so the check cannot collide with the operator's running relay. Guard the kill with `|| true` or kill by name. Judge the row from the marker word and the `source started` line, as in [[end-state-grep-miss-checks-stamp-exit-code-1-on-a-met-condition]].

**Not observable here.** The row also says nothing was typed into the live session. The artifact cannot show that.

Locate-cue (verify still present before acting): `for (const name of wantedList) await startSource(name)` before `new WebSocketServer({ port })`, and the `if (record) appendFile(...)` line in `broadcast`, all in `server/relay.mjs`. The `parseArgs` function there accepts `--port`. Read at the landed tip of `dev/obelisks-3` through the `_refinery` worktree, whose HEAD equals the landed SHA. The `.war/endstate-1-12.log` evidence is ephemeral and lives in the session worktree.

Related: [[obelisks-molten-hackathon]].
