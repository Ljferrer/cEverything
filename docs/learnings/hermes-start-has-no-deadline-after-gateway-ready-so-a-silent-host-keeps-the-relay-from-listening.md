---
name: hermes-start-has-no-deadline-after-gateway-ready-so-a-silent-host-keeps-the-relay-from-listening
description: "A Hermes host that sends gateway.ready and then answers nothing keeps start pending, so the relay never listens and never falls back."
metadata:
  node_type: memory
  type: project
  keywords:
    - hermes start hang
    - gateway.ready
    - request timeout
    - session.active_list
    - client.capabilities
    - HERMES_CONNECT_TIMEOUT_MS
    - PIN-31
    - relay never listens
    - synthetic fallback
    - startSource serial
  provenance: code-verified
  slug: hermes-start-has-no-deadline-after-gateway-ready-so-a-silent-host-keeps-the-relay-from-listening
  phase: phase-1
  tags:
    - hermes
    - relay
    - seam
    - startup
    - plan-2
  created: 2026-10-17
  originSessionId: 71aad606-dbd3-4b73-86ee-8ca7e90bf4bb
  modified: 2026-10-17T23:01:00.617Z
---

Live gap at the plan 2 phase 1 tip. The audit asked the question and nobody answered it before land.

**The gap.** `server/sources/hermes.mjs` bounds only the connect and the `gateway.ready` event. The bound is `HERMES_CONNECT_TIMEOUT_MS`, default 3000 ms. The `request()` helper sets no timeout. `start` then awaits `client.capabilities` and `session.active_list` through `request()`. A host that greets and then goes silent leaves `start` pending forever.

**Why the whole room stalls.** `startRelay` in `server/relay.mjs` awaits each wanted source in a loop, one at a time. It builds the `WebSocketServer` only after the loop ends. So a pending `start` means the relay never listens. The synthetic fallback runs only after a source rejects or when none starts, so it never fires either.

**Same helper, second exposure.** `sendCommand` in `hermes.mjs` also uses `request()`. A `say` or `fork` sent to a stalled host awaits forever. `route()` in the relay awaits `mod.handle`, so the issuer gets no error frame. `say` has already emitted its user slab by then.

**The open question.** Audit round one offered a fork. Bound the first handshake with a deadline, or keep PIN-31 literal and leave it unbounded. A deadline can reject a slow but healthy host, because attach is serial (resume and history per sid). No answer reached the landed code. Treat a hung host at the live pre-flight as this gap before you suspect the network.

**Fix shape (suggestion).** Give `request()` a per-call timer that rejects and clears its `pending` entry. Apply it to the handshake calls first.

Locate-cue (verify still present before acting): `request` and `handshake` in `server/sources/hermes.mjs`, and the `for (const name of wantedList) await startSource(name)` loop before `new WebSocketServer` in `server/relay.mjs`. Grounding: read in the run's `_refinery` integration worktree (`<session-worktree>`), HEAD 4d680c9, the second parent of landed merge b5ba1bd on dev/obelisks-2. The other parent was not read.

Related: [[relay-close-calls-a-module-level-stop-and-ignores-the-handle-a-source-start-returns]], [[obelisks-molten-hackathon]].
