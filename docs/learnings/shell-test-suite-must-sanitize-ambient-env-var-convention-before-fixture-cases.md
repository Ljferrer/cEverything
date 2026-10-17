---
name: shell-test-suite-must-sanitize-ambient-env-var-convention-before-fixture-cases
description: "Shell tests of an env-var-triggered code path must unset that var before pre-existing fixture cases — an ambient developer/CI export silently activates it"
metadata: 
  seededFrom: work-audit-refine/docs/seed@0.21.15
  node_type: memory
  type: project
  slug: shell-test-suite-must-sanitize-ambient-env-var-convention-before-fixture-cases
  keywords: 
    - ambient env var
    - CLAUDE_MEMORY_REPO
    - test hermeticity
    - env var convention
    - shell test sanitation
    - fail-toward-completeness
    - fixture leakage
    - unset before cases
    - test isolation
  tags: 
    - shell
    - testing
    - hermeticity
    - pattern
  created: 2026-07-15
---

**Pattern:** A script that reads an env var as an *implicit* config channel — no CLI flag, "if set, behavior
changes" — creates a hazard for its own test suite: any other doc/playbook in the same repo that
teaches an operator to `export` that same var (here, a memory-migration playbook's preamble) means
a developer's ambient shell, or a CI job that sources such a playbook, silently arms the new code
path inside test cases that were never designed to exercise it — and those cases read as false
failures (or worse, false passes) with no code change.

**Fix:** the test file must `unset <VAR>` immediately after any environment guard (e.g. right
after confirming the script-under-test exists) and *before* the first fixture case runs — never
rely on the ambient shell being clean. Load-bearing detail: if any pre-existing cases build
fixtures that assert success/failure *contingent on the var being absent or empty*, name that
dependency explicitly in the test file (a comment), since deleting the `unset` line is otherwise
invisible in CI (which never carries the ambient export) and only reproduces in a developer shell
that followed the export-teaching playbook.

**When to apply:** any shell test suite in this repo whose script-under-test reads an env var by
convention rather than an explicit flag, where a *different* skill's doc teaches operators to
export that same var name for a legitimate real-pass workflow.
