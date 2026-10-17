---
name: a-relay-command-that-emits-and-returns-an-error-frame-sends-the-issuer-two-copies
description: "voice.mjs calls ctx.emit and returns the same error frame, so the issuer gets it twice and every other client once."
metadata:
  node_type: memory
  type: project
  keywords:
    - ctx.emit
    - broadcast
    - error frame
    - duplicate error
    - command return value
    - route
    - sendCommand
    - voice.mjs
    - error window
    - fetch timeout
  provenance: code-verified
  slug: a-relay-command-that-emits-and-returns-an-error-frame-sends-the-issuer-two-copies
  phase: phase-1
  tags:
    - relay
    - commands
    - voice
    - plan-5
    - error-handling
  created: 2026-10-17
  originSessionId: c9d28c43-3279-46de-a04e-0b6f5b953eb4
  modified: 2026-10-17T22:05:57.783Z
---

Design note for every relay command module under `server/commands/`.

**Two delivery paths.** In `server/relay.mjs` the command ctx `emit` is `broadcast`. That sends one validated frame to every client, including view-only clients and other headsets, and records it. `route` sends the frame a command returns to the issuing client only. When `client` is null, as in a source's `sendCommand`, `route` drops the returned frame, so `emit` is the only path.

**What `voice.mjs` does.** Its `fail(text)` helper calls `ctx.emit(frame)` and returns the same frame. The plan slice requires both. The issuing client therefore gets the error twice. Every other client gets it once. The test file asserts both paths: `out` for the return, `errors()` for the emit.

**Effects found by reading the listeners.**
- `src/net.js` re-emits every server frame on the bus under its `t` name. Any bus `error` listener on the issuer runs twice.
- The error window in `src/features/voice.js` removes its listener after the first error, so the duplicate is invisible there.
- The window is time based, not tied to a request. A headset inside its 10 s window after its own send shows any broadcast error text, including a voice failure from another client, and reports `talk {phase:'error'}`.
- The `fetch` to the transcribe route has no `AbortSignal`. The audit states that undici's default headers timeout is 300 s (not checked here). A stalled route would then deliver its error long after the 10 s window closes, and the wearer sees nothing.

**Rule for new commands.** Return the frame for an issuer-only error. Call `ctx.emit` only when every client should see it. Do both only on purpose, and expect the duplicate.

Locate-cue (verify still present before acting): `fail` in `server/commands/voice.mjs`, `broadcast`, `ctxFor` and `route` in `server/relay.mjs`, the `bus.emit(frame.t, frame)` line in `src/net.js`, `ERROR_WINDOW_MS` and `openErrorWindow` in `src/features/voice.js`. Read in the `_refinery` integration worktree, whose HEAD equalled landed tip 291eb2d on dev/obelisks-5.

Related: [[voice-js-landed-without-its-audit-fixes-because-both-fix-commits-were-reverted]], [[node-test-a-relay-command-with-an-in-process-http-server-and-a-fake-ctx]].
