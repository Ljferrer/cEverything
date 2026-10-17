---
name: die-process-exit-inside-try-skips-finally-cleanup
description: "RESOLVED (memory-tooling-hardening/1.3, #1079, landed 2026-07-26): die() now throws a tagged Error and main() alone calls process.exit after every finally has unwound. Was: a die()/process.exit() helper called from inside a try block terminates the process without unwinding the stack, so the enclosing try/finally cleanup never runs — scratch dirs leaked on every error path"
metadata: 
  seededFrom: work-audit-refine/docs/seed@0.21.15
  node_type: memory
  type: project
  keywords: 
    - process.exit
    - finally not called
    - try finally skipped
    - die helper
    - scratch dir leak
    - mkdtempSync
    - fail-fast CLI
    - cleanup skipped
    - os.tmpdir leak
    - error path hygiene
    - RESOLVED
    - tagged Error throw
    - single exit point
  provenance: code-verified
  promoted: dev/2026-07-24-memory-tooling-hardening@phase-1
  slug: die-process-exit-inside-try-skips-finally-cleanup
  phase: "lessons-learned-seed/phase-1 task 1.1 (landed dev/2026-07-22-lessons-learned-seed); RESOLVED memory-tooling-hardening/phase-1 task 1.3 (landed dev/2026-07-24-memory-tooling-hardening, 2026-07-26)"
  tags: 
    - node
    - cli-tooling
    - process-exit
    - cleanup
    - temp-files
  created: 2026-07-22
  updated: 2026-07-26
  originSessionId: 8a3e4cd6-492f-43ba-b10c-46e460a457b9
  modified: 2026-07-27T03:52:08.384Z
---

**Local recurrence copy** of the repo-root lesson at
`docs/learnings/die-process-exit-inside-try-skips-finally-cleanup.md` (same slug) — the repo copy is
not directly editable by a servitor (D1), so this file carries the original content plus the
`## RESOLVED` section below; a future Gate-2 promotion of this file overwrites the same-slug repo
file.

# `process.exit()` inside a `try` body never runs the enclosing `finally`

**The durable pattern:** `process.exit()` terminates without unwinding the stack, so any
`try { ... } finally { cleanup }` enclosing it is dead code on that path — a shared "fail fast"
helper that exits, reachable inside the try directly or transitively, silently defeats every
scratch-dir `finally` cleanup even though the try/finally *looks* leak-proof (and is, for every
in-band throw/return path). Before trusting a try/finally region, check whether anything reachable
inside the try can call `process.exit()`.

**Fixed in:** memory-tooling-hardening/1.3, #1079, landed 2026-07-26 — `die()` in
`skills/lessons-learned/assets/seed-pack.mjs` now throws `Object.assign(new Error(msg),
{ exitCode: code })`; `main()`'s catch is the sole `process.exit` site (untagged errors rethrow
unchanged), reached only after every `finally` in the call chain has unwound; a new TMPDIR-scoped
subprocess test asserts zero `seed-pack-*` scratch entries survive a `verify` failure.

**Recorded residuals (deliberately left open):**
- Because the `finally` blocks now actually run during a die-triggered unwind, a `finally` body
  that itself throws (e.g. `fs.rmSync` hitting EACCES/EBUSY on the self-created temp dir)
  REPLACES the tagged error — `main()` rethrows it untagged and the process exits 1 with a raw
  stack instead of the contract code. Low likelihood; wrapping every cleanup in a bare try/catch
  was scoped out. Know this before copying the throw-based `die()` pattern elsewhere.
- `main()`'s single try/catch is silently coupled to every verb staying fully synchronous — a
  future `async` verb whose tagged throw happens inside a Promise becomes an unhandled rejection
  that skips the catch (stack trace + exit 1, not the contract code). No async verb exists today;
  note it before adding one.
