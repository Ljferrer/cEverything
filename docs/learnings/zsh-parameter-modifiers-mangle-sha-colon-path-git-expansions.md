---
name: zsh-parameter-modifiers-mangle-sha-colon-path-git-expansions
description: "In zsh, `$T:hooks/...`-style git <sha>:<path> arguments trigger parameter modifiers (`:h` dirname, `:s` substitute) — the command silently gets a mangled path or errors, and a grep floor piped from it reports 0 on EMPTY input: a vacuous pass. Always brace: `\"${T}:path\"`."
metadata:
  seededFrom: work-audit-refine/docs/seed@0.21.15
  node_type: memory
  type: feedback
  provenance: code-verified
  keywords:
    - zsh
    - parameter-modifier
    - git-show
    - sha-colon-path
    - vacuous
    - sweep
    - floor
    - backstop
    - bad-substitution
  originSessionId: 4eee3466-8bcc-44f9-a6c2-754d46624537
  modified: 2026-07-25T06:30:17.729Z
---

Running backstop sweeps at a landed tip (`git show $T:hooks/validate-auditor-git.sh`,
`git show $T:skills/...`), zsh interpreted `$T:h` as the **dirname modifier** and `$T:s` as the
**substitute modifier** — one produced `.ooks/<path>` (fatal), the other a `bad substitution`
error. Both failures were **silent at the floor**: the downstream `tr | grep -c` pipeline read
empty input and printed `0`, indistinguishable from the genuine absence the floor was checking.

**The incident (2026-07-24, campaign plan 2 Phase-1 checkpoint).** Three of five integrated-tip
sweep keys were first "measured" against empty files. Caught only because a separate region
extractor returned an impossible empty block, prompting re-verification of the file dumps
themselves (`wc -c` → 283 bytes vs the real 165,959).

**How to apply:**
- Always write `"${T}:path"` (braces) for `<rev>:<path>` git arguments in zsh — `$T:anything` is
  modifier territory (`:h`, `:s`, `:r`, `:t`, `:e` are all live).
- A floor/sweep result is evidence only if its producing command succeeded: check the dump's
  `rc` and byte size before trusting a `0` count. A grep floor over a failed redirect is the
  same vacuity class as a wrap-blind grep — it passes on exactly nothing.
- Same discipline as `reproduce-a-gate-blocker-before-patching-or-escalating`: verify the
  measurement before acting on it — including your own.
