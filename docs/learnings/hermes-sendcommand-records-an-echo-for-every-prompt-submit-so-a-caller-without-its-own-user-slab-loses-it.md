---
name: hermes-sendcommand-records-an-echo-for-every-prompt-submit-so-a-caller-without-its-own-user-slab-loses-it
description: "hermes.mjs swallows the first matching user message.complete after any prompt.submit, so the caller must emit its own user slab."
metadata:
  node_type: memory
  type: project
  keywords:
    - echo suppression
    - prompt.submit
    - user slab
    - seed prompt
    - "--seed"
    - ECHO_WINDOW_MS
    - message.complete user
    - duplicate user slab
    - echoed
    - sendCommand
  provenance: code-verified
  slug: hermes-sendcommand-records-an-echo-for-every-prompt-submit-so-a-caller-without-its-own-user-slab-loses-it
  phase: phase-1
  tags:
    - hermes
    - sources
    - seed
    - echo
    - plan-2
  created: 2026-10-17
  originSessionId: 71aad606-dbd3-4b73-86ee-8ca7e90bf4bb
  modified: 2026-10-17T23:01:14.768Z
---

Design rule for every caller of the Hermes `sendCommand`.

**The mechanism.** `sendCommand` in `server/sources/hermes.mjs` pushes `{session_id, text, ts}` onto `echoes` for every `prompt.submit`. A user-role `message.complete` calls `echoed(sid, text)`. The first match inside `ECHO_WINDOW_MS` (3000 ms) is consumed and no slab is emitted.

**Why it exists.** `say` emits its own user slab before it submits. Without the suppression the gateway echo would show the prompt twice.

**The rule.** The record is made for any `prompt.submit`, not only one from `say`. So every caller must emit its own user slab. `say` does, and `pipe` goes through `say`. The `--seed` path does not. `seed()` calls `sendCommand('prompt.submit', ...)` and emits nothing. The echo, the usual source of that slab, is swallowed.

**What is left for a seeded prompt.** Its user slab appears only if the `session.history` fetch for the new sid already holds the prompt. `sendCommand` starts `attach` for the new sid without awaiting it, and `seed()` moves on to `prompt.submit`. Which of the two lands first is a race I did not trace. The audit flagged it for the pre-flight and the plan literal allows it.

**Check at the live pre-flight.** Run the relay with `--seed 2`. Look for the seed prompts as user slabs on the two new obelisks. If they are missing, make `seed()` emit its own user slab, or skip the echo record for it.

Locate-cue (verify still present before acting): `sendCommand`, `echoed`, `ECHO_WINDOW_MS` and `seed` in `server/sources/hermes.mjs`. Grounding: read in the run's `_refinery` integration worktree (`<session-worktree>`), HEAD 4d680c9, the second parent of landed merge b5ba1bd on dev/obelisks-2.

Related: [[the-relay-start-argument-sendcommand-takes-a-client-command-but-a-sources-exported-sendcommand-takes-method-and-params]], [[obelisk-appenddelta-falls-back-to-the-newest-slab-of-the-role-for-an-unknown-id]].
