---
name: end-state-grep-miss-checks-stamp-exit-code-1-on-a-met-condition
description: An end-state check shaped grep ; test $? -eq 1 && echo X is met but its captured log ends exit_code 1.
metadata:
  node_type: memory
  type: project
  keywords:
    - end-state check
    - grep no match
    - exit_code 1
    - test $? -eq 1
    - CLIENT_CLEAN
    - endstate log
    - per-statement exit
    - aggregate max
  provenance: code-verified
  slug: end-state-grep-miss-checks-stamp-exit-code-1-on-a-met-condition
  phase: phase-1
  tags:
    - war
    - end-state
    - plan-authoring
    - gate-audit
  created: 2026-10-17
  originSessionId: 24fe07c2-1e38-4429-b5c7-e1be2b220156
  modified: 2026-10-17T21:11:32.171Z
---

Plan-authoring gotcha. It caused no failure in phase 1, but several gate-audit seats had to explain it.

**The check shape.** End state 10 of the foundation plan reads `grep -rniE '...' src/ shared/ index.html ; test $? -eq 1 && echo CLIENT_CLEAN`. A grep that finds nothing exits 1, and that is the pass.

**What the evidence showed.** The gate-audit driver split the check at the `;` and logged each statement. The log `<session-worktree>/.war/endstate-1-10.log` reads `cmd[0] exit: 1`, `CLIENT_CLEAN`, `cmd[1] exit: 0`, then `exit_code: 1`. The final stamp is the maximum of the per-statement exit codes. So the condition is met and the stamp reads red.

**Who can be fooled.** A reader or tool that checks only `exit_code` will mark the row failed. Judge the row from the `cmd[n] exit:` lines and the marker word (`CLIENT_CLEAN`).

**Other plans with the same shape.** The Hermes, Claude Code, voice, and gestures plans each carry a `... ; test $? -eq 1 && echo X` check: plan 2 end state 7, plan 3 end state 9, plan 5 end state 4, plan 6 end state 11 (a `git diff | grep -v` footprint check). Expect the same stamp on those rows.

**Fix at authoring time.** Write the check as one statement with a truthful exit status, for example `! grep -rniE '...' src/ shared/ index.html && echo CLIENT_CLEAN`. Or tell the Lead to read the per-statement lines.

Locate-cue (verify still present before acting): the `test $? -eq 1` checks in `docs/plans/2026-10-17-obelisks-{1,2,3,5,6}-*.md`. The `.war/` log is ephemeral and lives in the session worktree. Read at the phase 1 integrated tip (the landed merge's second parent). If those plan lines no longer match, the fix has landed.

Related: [[obelisks-molten-hackathon]].
