---
name: gitmodules-working-tree-read-vs-ref-snapshot
description: ".gitmodules read = working-tree not ref snapshot — FIXED phase 'Floor fixes' 2026-07-12"
metadata:
  seededFrom: work-audit-refine/docs/seed@0.21.15
  node_type: memory
  type: project
  keywords: [git config --blob, submodule guard, checked-out file, diff endpoint mismatch, declared paths misclassified, gitlink check, base vs branch, cat-file -e, ref snapshot fix, floor-script-correctness]
  slug: gitmodules-working-tree-read-vs-ref-snapshot
  tags:
    - submodule
    - gitmodules
    - shell-guard
    - increment-2
    - ref-snapshot
  created: 2026-06-30
  updated: 2026-07-12
---

# `.gitmodules` cross-check reads the working-tree file, not a ref snapshot — FIXED

**Original rule:** `assert-no-submodule-mutation.sh`
Step 3 resolved submodule paths via `git config -f "$gitmodules_file"` where `gitmodules_file` was the
checked-out working-tree `.gitmodules` — not `.gitmodules` as of `<base>` or `<branch>` in the diff.
Benign for the refuse-all default (the mode-160000 gitlink check fires first), but under the landed
`--declared` mode a task branch editing `.gitmodules` itself could misclassify which paths were
declared, because the read diverged from the diff endpoints.

**Status: fixed.** Step 3's working-tree read was replaced with a `git cat-file -e` existence
probe against `<branch>:.gitmodules` plus `git config --blob "<branch>:.gitmodules"` (absent →
clean skip; a read failure after a successful probe → exit 2); the working-tree fallback was removed
outright. One residual caveat: the premise that a malformed `.gitmodules` blob's `git config` parse
failure normalizes to exit 1 (making the exit-2 die branch "un-manufacturable" in a same-diff fixture)
is empirically unconfirmed — git config parse errors have historically exited >1, e.g. 128.

**Why this was durable before the fix, and why the pattern still matters:** working-tree reads
silently diverge from the diff endpoints a guard reasons about — any future path-discrimination
widening on a similar floor/gate script should default to a ref-snapshot read (`git config --blob
"<ref>:<path>"`) from the start, not working-tree, to avoid reintroducing this exact class of gap.
