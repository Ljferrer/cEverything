---
name: race-fix-test-arms-go-red-only-when-a-tick-lands-in-the-window-so-prove-them-with-an-injected-delay
description: "The ES8 order and unique-id arms fail only if a poll tick lands in a sub-millisecond window, so a red proof needs an injected delay."
metadata:
  node_type: memory
  type: project
  keywords:
    - probabilistic test
    - race window
    - injected delay
    - mutation proof
    - ES8
    - session before slab
    - unique slab id
    - pollMs
    - tripwire test
    - fixture size
  provenance: code-verified
  slug: race-fix-test-arms-go-red-only-when-a-tick-lands-in-the-window-so-prove-them-with-an-injected-delay
  phase: phase-1
  tags:
    - claude-source
    - tests
    - race
    - mutation-proof
  created: 2026-10-17
  originSessionId: 58cf8bf7-7773-43a0-b2c1-98d7dfb2866b
  modified: 2026-10-17T22:05:01.931Z
---

**The arms.** After the late-file wait, the ES8 case in `server/sources/claude.test.mjs` asserts three things for the late sids `sid2` and `a3`. The `session` frame precedes the first `slab`. The `session` frame precedes the first `state`. No slab id repeats across the run.

**Why they are weak.** The late fixtures hold one line each. The stat plus read window in `track()` is under 1 ms. The case runs `pollMs: 200`. A regression of the publish order would usually pass. The commit body records a mutation proof that needed a 300 ms injected delay in `track()` before the arms went red. Both facts come from the audit notes. This phase did not re-run the mutation.

**Why a bigger fixture does not help.** A worker measured about 70 ms for a 50,000-line transcript. No fixture size makes a tick land in the window on purpose. The code comment above the arms says so and says the race is closed by construction. The arms stay as a tripwire.

**How to read this.** The arms are not vacuous: they can fail. They are not a proof either. The proof is the code ordering in [[a-poller-and-a-discoverer-sharing-a-map-need-the-record-published-last-by-construction]]. Do not rate the arms as a defect for being probabilistic.

**Rule for the next race fix closed by construction.**
- Say in a comment that the test is probabilistic, as this one does.
- Prove the arms red by injecting a delay into the window, not by growing the fixture.
- Keep the arms as a guard. A deterministic test would need a hook into the window.

**A small rot risk.** The comment carries a dated timing figure ("about 70 ms ... measured 2026-10-17"). If `track()` changes, re-measure or drop the number. The simplicity seat flagged this as a nit.

Locate-cue (verify still present before acting): the comment "That window is under 1 ms for these late files" and the three assertions after `await sleep(500)` in the ES8 case in `server/sources/claude.test.mjs`. Read at the landed tip of `dev/obelisks-3` through the `_refinery` worktree, whose HEAD equals the landed SHA.

Related: [[non-discriminating-test-can-still-be-plan-faithful]], [[weak-test-assertion-passes-without-feature-being-exercised]].
