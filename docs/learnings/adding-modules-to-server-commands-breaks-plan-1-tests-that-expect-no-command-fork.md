---
name: adding-modules-to-server-commands-breaks-plan-1-tests-that-expect-no-command-fork
description: "The relay loads every .mjs in server/commands, so landing fork.mjs broke plan 1 tests that assert no command: fork."
metadata:
  node_type: memory
  type: project
  keywords:
    - no command fork
    - commandsDir
    - loadModules
    - PLAN-DEFECT
    - PIN-22
    - file-disjoint
    - empty commandsDir mkdtemp
    - auto-load directory
    - relay.test.mjs
    - net.test.mjs
  provenance: code-verified
  slug: adding-modules-to-server-commands-breaks-plan-1-tests-that-expect-no-command-fork
  phase: phase-1
  tags:
    - plan-mismatch
    - tests
    - relay
    - commands
    - plan-2
    - deviation
  created: 2026-10-17
  originSessionId: 71aad606-dbd3-4b73-86ee-8ca7e90bf4bb
  modified: 2026-10-17T23:01:23.897Z
---

Plan-to-code mismatch. It held plan 2 phase 1 attempt 1 with an escalation on t2.

**The mismatch.** Plan 2 may not edit plan 1's files (PIN-22). Two plan 1 tests assert that the relay answers `no command: fork`. They are in `server/relay.test.mjs` and `src/net.test.mjs`, and both used the default `commandsDir`, which held no modules. `loadModules` in `server/relay.mjs` imports every `.mjs` in a directory except `.test.mjs`. Once `fork.mjs`, `say.mjs` and `pipe.mjs` landed, the relay had a real `fork`. Those assertions could no longer pass.

**The ruling.** The campaign lead ruled on 2026-10-17 at about 15:30 PDT. Each named test passes an empty `mkdtemp` directory as `commandsDir`. Both `no command: fork` assertions stay as they were. `src/net.test.mjs` gained only the three imports `mkdtemp` needs. No expected text changed to `read-only harness`. The audit seats accepted the edit as exactly what the ruling allows.

**Rule.** A file-disjoint footprint does not stop a behavioral dependency on a directory listing. Before a plan adds files to a directory the host auto-loads, grep the existing tests for assertions about its emptiness or a missing entry. Pin such a test to a temp directory the test owns. Later plans add more command modules to the same directory, so a new test that expects a missing command needs the same pin.

**Not a defect in the new files.** `say.mjs` also hosts the shared `title` and `READ_ONLY` helpers that `fork.mjs` and `pipe.mjs` import. Its header says every `server/commands/*.mjs` is loaded as a command, and the plan allows only eight files.

Locate-cue (verify still present before acting): the `mkdtemp` `commandsDir` at the `no command: fork` cases in `server/relay.test.mjs` and `src/net.test.mjs`; `loadModules` in `server/relay.mjs`. Grounding: read in the run's `_refinery` integration worktree (`<session-worktree>`), HEAD 4d680c9, the second parent of landed merge b5ba1bd on dev/obelisks-2.

Related: [[relay-tests-pin-the-port-but-not-the-edit-key-so-an-ambient-obelisks-edit-key-flips-them]], [[obelisks-molten-hackathon]].
