---
name: case-glob-star-crosses-slash-prefix-needs-root-plus-nested
description: "case fnmatch: * crosses /, **/ misses root; need the token pair"
metadata:
  seededFrom: work-audit-refine/docs/seed@0.21.15
  node_type: memory
  slug: case-glob-star-crosses-slash-prefix-needs-root-plus-nested
  type: project
  keywords: [case glob, fnmatch, FNM_PATHNAME, globstar, slash crossing, prefix convention, pytest test_ pattern, substring over-match, pattern dialect, root-level miss]
  tags:
    - test-floor
    - bash
    - glob
    - pattern-dialect
  files:
    - skills/war/assets/assert-test-in-diff.sh
  created: 2026-07-07
---

# The floor's pattern dialect is case-glob: `*` crosses `/`, `**/` misses root, prefix conventions need a root+nested pair

## The durable rule

`assert-test-in-diff.sh` matches `--pattern` tokens with bash `case` — fnmatch **without**
`FNM_PATHNAME`. Three consequences, all empirically verified (2026-07-07):

1. **`*` crosses `/`.** `*.test.ts` already means `**/*.test.ts` — suffix-shaped conventions
   (`*.test.ts`, `*_test.go`, `*Test.java`) are depth-agnostic as a single token.
2. **`**/` is NOT globstar — it demands ≥1 slash.** `**/*.test.ts` fails to match root-level
   `foo.test.ts`. Never write `**/` tokens here.
3. **Prefix-shaped conventions need a token pair.** pytest's `test_*.py` matches *only* root-level
   files; `*/test_*.py` matches *only* nested ones — the correct set is
   `test_*.py */test_*.py` (plus `*_test.py`). Never "fix" it with `*test_*.py`: substring
   over-match (`latest_results.py` contains `test_` → false floor pass).

One-liner harness that proves any token set (mirrors the script's matcher exactly):

```sh
m() { local f="$1" hit=no; set -f; for pat in $2; do case "$f" in $pat) hit=yes; break;; esac; done; set +f; echo "$f vs $2 -> $hit"; }
m pkg/tests/test_a.py 'test_*.py */test_*.py *_test.py'   # yes
m foo.test.ts '**/*.test.ts'                              # no  (root-level miss)
m latest_results.py '*test_*.py'                          # yes (the over-match trap)
```

The per-language suggestion table in
`docs/specs/2026-07-07-test-floor-pattern-threading-design.md` §4 is the single encoded home of
this dialect; extend the table, don't hand-author patterns at interview time.
