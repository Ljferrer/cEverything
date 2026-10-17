---
name: node-test-a-relay-command-with-an-in-process-http-server-and-a-fake-ctx
description: "Test a relay command that calls out over HTTP with a port-0 node:http server and a hand-built ctx, no relay needed."
metadata:
  node_type: memory
  type: project
  keywords:
    - fake transcribe server
    - node:http port 0
    - ctxFor fake
    - relay command test
    - OBELISKS_TRANSCRIBE_URL
    - test-name-pattern
    - ES1 ES2 ES3
    - nothing happened assertion
    - voice.test.mjs
  provenance: code-verified
  slug: node-test-a-relay-command-with-an-in-process-http-server-and-a-fake-ctx
  phase: phase-1
  tags:
    - tests
    - node
    - fixture
    - relay
    - commands
    - plan-5
  created: 2026-10-17
  originSessionId: c9d28c43-3279-46de-a04e-0b6f5b953eb4
  modified: 2026-10-17T22:06:14.027Z
---

Fixture recipe from `server/commands/voice.test.mjs`. Plans 2 and 3 can copy it for commands that call an outside HTTP route.

**The recipe.**
- Start a `node:http` server on port 0 in `before`. Put its port into the env var the command reads (`OBELISKS_TRANSCRIBE_URL`). Set the token env var in the same hook.
- The server records `{method, path, headers, body}` for each request. A per-test answer queue feeds it. An empty queue answers 500, so an unplanned request fails loudly.
- Build the ctx by hand: `{relay, sources, commands, emit, ownerOf}`. That matches `ctxFor` in `server/relay.mjs`. `emit` pushes into a `frames` array.
- Give the fake `say` command a body that calls `ctx.emit` with a slab. Then `slabs()` holding exactly that one slab proves `voice.mjs` emits no slab of its own.
- For early-exit cases, assert that `requests`, `calls` and `rpc` are all `[]`. That proves the owner check and the `say` check run before any network call and before any `sendCommand`.
- Export the URL resolver with an `env` parameter (`transcribeUrl(env = process.env)`). The fallback branch is then testable with plain objects and no `process.env` writes.

**Naming couples to End-state checks.** Test names start with `ES1`, `ES2` or `ES3`. The End-state checks run `node --test --test-name-pattern='^ES1\b'`. Any extra test whose name starts with `ES1` runs under that check too and can fail it. The gate log for End state 1 shows `# pass 2` because the URL-fallback test shares the prefix.

**Env writes are never restored.** The test sets `process.env` once and leaves it. That is safe only because `node --test` runs each file in its own process. Do not import this file's setup into another test file.

**Import order.** `voice.mjs` reads both env vars at call time, so import order does not matter for it. The test still imports after the env writes. A command that reads env at import time needs that order.

Locate-cue (verify still present before acting): `createServer`, `ctxFor`, `say` and the `ES1` to `ES3` test names in `server/commands/voice.test.mjs`, `transcribeUrl` in `server/commands/voice.mjs`. Read in the `_refinery` integration worktree, whose HEAD equalled landed tip 291eb2d on dev/obelisks-5.

Related: [[node-test-a-feature-with-a-fake-bus-and-an-injected-getobelisk-so-room-js-never-loads]], [[relay-tests-pin-the-port-but-not-the-edit-key-so-an-ambient-obelisks-edit-key-flips-them]], [[a-relay-command-that-emits-and-returns-an-error-frame-sends-the-issuer-two-copies]].
