---
name: failed-cd-in-a-compound-command-runs-the-rest-in-the-main-checkout
description: "A failed `git worktree add` followed by `cd \'$P\'` does NOT stop a compound shell command"
metadata: 
  seededFrom: work-audit-refine/docs/seed@0.21.15
  node_type: memory
  type: feedback
  provenance: user-confirmed
  keywords: 
    - worktree guard
    - failed cd
    - set -e does not stop
    - main checkout on master
    - Gate-2 publication worktree
    - staged in the wrong repo
    - show-toplevel assertion
  originSessionId: 4095ea62-efc7-4ed1-8045-8de0cd2f76bb
  modified: 2026-08-03T17:07:59.829Z
---

# A failed `cd` does not stop the command — assert the worktree, not just the exit code

**Observed (2026-08-03, campaign `2026-08-02-nonvacuity-doctrine-and-doc-truth`, plan 4 Gate-2).**
A Gate-2 promotion script began with `git worktree add "$P" <branch>` and then `cd "$P"`. The
`worktree add` failed — *"branch is already used by worktree at …"*, because an earlier worktree in
the same session still held that branch — so `$P` was never created and the `cd` failed too. **Every
remaining step ran in the shell's current directory: the main checkout, parked on `master`.** Five
learnings files were copied into `docs/learnings/` there and `git add`-ed.

`set -e` did **not** save it: a failing `cd` inside a compound/`eval`-style command does not abort
the rest.

**Three tells in the output, any one of which is enough:**

- `HEAD=eb651a5` — the main checkout's `master`, not the expected feature tip.
- `M .claude/war/config.json` in `git status` — the operator's deliberately-uncommitted edit that
  exists *only* in the main checkout and must never be staged.
- The four release slots read `0.15.0` instead of the landed `0.15.1` — a value that only makes
  sense on a pre-release base.

Nothing was committed. `git reset HEAD docs/learnings/` plus removing the copied files restored the
main checkout exactly (only the pre-existing unstaged `config.json` edit remained).

**How to apply.** Before any `git add`/`commit` in a script that changed directories, assert *where
you are*, not merely that the previous command returned zero:

```
cd "$P" || { echo "FATAL: cd failed"; exit 1; }
[ "$(git rev-parse --show-toplevel)" = "$P" ] || { echo "FATAL: wrong worktree"; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || { echo "FATAL: wrong branch"; exit 1; }
```

**Why the failure was likely in the first place:** a branch can be checked out in only one worktree.
A Lead that already made a worktree for the branch earlier in the session (here, to commit the
red-team hardening) will hit this on the next `worktree add`. Prefer reusing the existing worktree
after `git fetch` + `git reset --hard origin/<branch>` over adding a second one.

Related: `edits-land-in-main-not-session-worktree` (the abs-path variant of the same blast radius),
`gate2-commit-from-stale-verify-worktree-can-revert-a-release-bump` (why Gate-2 in particular is
the dangerous moment to be in the wrong tree).
