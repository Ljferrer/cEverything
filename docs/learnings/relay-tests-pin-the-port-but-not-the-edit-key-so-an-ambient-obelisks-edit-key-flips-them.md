---
name: relay-tests-pin-the-port-but-not-the-edit-key-so-an-ambient-obelisks-edit-key-flips-them
description: "The relay test helper pins port 0 but not editKey, so an exported OBELISKS_EDIT_KEY would turn every ?key=edit client into a viewer."
metadata:
  node_type: memory
  type: project
  keywords:
    - OBELISKS_EDIT_KEY
    - ambient env
    - editKey
    - canEdit
    - relay test helper
    - startRelay
    - key=edit
    - OBELISKS_PORT
    - port 0
    - view-only link
  provenance: code-verified
  slug: relay-tests-pin-the-port-but-not-the-edit-key-so-an-ambient-obelisks-edit-key-flips-them
  phase: phase-2
  tags:
    - relay
    - tests
    - env
    - fixtures
  created: 2026-10-17
  originSessionId: 24fe07c2-1e38-4429-b5c7-e1be2b220156
  modified: 2026-10-17T21:32:08.442Z
---

Hazard for every plan 2 to 6 test that starts a relay and connects with `?key=edit`. This was reasoned from the code at the phase 2 tip. Nobody ran it with the variable set.

**The reads.** `startRelay` in `server/relay.mjs` defaults `editKey = process.env.OBELISKS_EDIT_KEY ?? 'edit'`. The `relay()` helper in `server/relay.test.mjs` passes `port: 0`, so an ambient `OBELISKS_PORT` cannot reach it. It passes no `editKey`.

**The consequence.** If the shell exports `OBELISKS_EDIT_KEY` (the operator may do this to run the relay behind the tunnel), then `?key=edit` no longer matches. Those clients get `canEdit:false` and their commands return `view-only link`. Every test that connects with `?key=edit` would fail, with an error that looks like a PIN-23 regression, not an env problem.

**A test name that overstates.** The test `a wrong key is a viewer; OBELISKS_EDIT_KEY override is honored` passes the `editKey` option. It never sets the env var. Nothing covers the `process.env.OBELISKS_EDIT_KEY` read itself.

**Rule.** A relay test that depends on `?key=edit` passes `editKey: 'edit'` explicitly, in the helper or the call. A new test of the env read sets and restores `process.env.OBELISKS_EDIT_KEY` itself.

The port has the same shape, solved the right way. The helper pins `port: 0`, and `resolvePort` has its own env test. A spawned CLI test sets `OBELISKS_PORT: '0'` and reads the port from the stderr line `listening on N, mode M`. That regex couples the test to the log text.

Locate-cue (verify still present before acting): the `editKey =` default in `startRelay` in `server/relay.mjs` and the `relay()` helper at the top of `server/relay.test.mjs`. Read at the phase 2 integrated tip (the landed merge's second parent).

Related: [[shell-test-suite-must-sanitize-ambient-env-var-convention-before-fixture-cases]], [[obelisks-molten-hackathon]].
