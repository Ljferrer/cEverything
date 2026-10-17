---
name: fail-closed-gate-silently-redirects-existing-failure-tests
description: "New gate flips loose failure tests into gate tests"
metadata: 
  seededFrom: work-audit-refine/docs/seed@0.21.15
  node_type: memory
  type: project
  keywords: [coverage masking, early exit, precondition guard, generic assertion, lost test coverage, suite stays green]
  slug: fail-closed-gate-silently-redirects-existing-failure-tests
  date: 2026-06-26
  tags: 
    - testing
    - gates
    - coverage
    - teardown
---

# Fail-closed gate silently redirects existing failure-path tests

**Rule:** adding an early-exit gate to a function silently converts any existing test that (a) calls it without satisfying the gate's precondition and (b) asserts only a generic outcome (non-zero, path-present) into a gate test — the suite stays green while the originally-targeted path loses coverage. Coverage-masking, not a behavioral defect.

Instance fixed: the fail-closed `--owned-file` gate in `provision-worktrees.sh` `teardown-phase` tripped failure-path tests T3c/T3d in `provision-worktrees.test.sh`; both got `--owned-file` plus mechanism-specific assertions (shipped).

**Why:** there is no visible signal when a code path loses its test to a new gate.
**How to apply:** when adding a gate, audit every existing test that calls the function in a gate-failing configuration; add the prerequisite or split out an explicit gate test, and prefer mechanism-specific tokens (exit code + unique stderr substring) over "non-zero".
