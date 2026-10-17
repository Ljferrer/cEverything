---
name: the-relay-start-argument-sendcommand-takes-a-client-command-but-a-sources-exported-sendcommand-takes-method-and-params
description: "Two functions share the name sendCommand: the relay's start argument routes client commands, a source's export sends a JSON-RPC method."
metadata:
  node_type: memory
  type: project
  keywords:
    - sendCommand
    - start argument
    - route null client
    - ownerOf
    - prompt.submit
    - session.branch
    - client command vs rpc
    - source seam
    - hand-off
    - name collision
  provenance: code-verified
  slug: the-relay-start-argument-sendcommand-takes-a-client-command-but-a-sources-exported-sendcommand-takes-method-and-params
  phase: phase-1
  tags:
    - relay
    - sources
    - commands
    - seam
    - plan-2
    - naming
  created: 2026-10-17
  originSessionId: 71aad606-dbd3-4b73-86ee-8ca7e90bf4bb
  modified: 2026-10-17T23:01:08.113Z
---

Seam trap for any new source or command module.

**Function one: the start argument.** `startSource` in `server/relay.mjs` calls `mod.start({ emit, sendCommand: (cmd) => route(cmd, null) })`. It takes a client command such as `{t:'say', sid, text}`. It runs the command modules as an editor would. With no client, `route` drops any returned frame.

**Function two: the source export.** A writable source exports `sendCommand(method, params)`, for example `('prompt.submit', {session_id, text})`. Command modules reach it as `ctx.ownerOf(sid).sendCommand`. A source without the export is read-only, and `say` and `fork` then answer `read-only harness`.

**What plan 2 did.** The plan slice said `start` hands its sender to the relay-supplied `sendCommand`. `server/sources/hermes.mjs` ignores the start argument and its JSDoc says so. The Lead ruled this implementer's choice (approval gate, 2026-10-17 14:20 PDT). The ruling is right on the code. A `{method, params}` pair matches no `t`-keyed shape in `isClientCommand`, so routing it through the start argument would hit `route`'s `bad command` branch. With no client that reply goes nowhere, so the call would be a silent no-op.

**Use the start argument only to inject a client command.** A source that wants the relay to run `say` or `fork` as if an editor sent it can call it. Anything that must reach Hermes goes through the source's own export.

**Also.** `ownerOf(sid)` resolves from the source name recorded when its `session` frame was broadcast. An unknown sid has no owner, and `say` and `fork` then also answer `read-only harness`.

Locate-cue (verify still present before acting): `startSource`, `route`, `ownerOf` and the header comment in `server/relay.mjs`; the exported `sendCommand` and the `start` JSDoc in `server/sources/hermes.mjs`; `CLIENT_SHAPES` and `isClientCommand` in `shared/protocol.mjs`. Grounding: read in the run's `_refinery` integration worktree (`<session-worktree>`), HEAD 4d680c9, the second parent of landed merge b5ba1bd on dev/obelisks-2.

Related: [[a-relay-command-that-emits-and-returns-an-error-frame-sends-the-issuer-two-copies]], [[relay-close-calls-a-module-level-stop-and-ignores-the-handle-a-source-start-returns]].
