---
name: voice-js-landed-without-its-audit-fixes-because-both-fix-commits-were-reverted
description: "voice.js landed as the first-round candidate, so every absorb-tagged audit finding is still live at the plan 5 tip."
metadata:
  node_type: memory
  type: project
  keywords:
    - voice.js
    - hold-to-talk
    - bus.talking stuck
    - reverted fix commit
    - absorb finding still live
    - sessionend
    - recorder self-stop
    - dead mic stream
    - typeof optional chaining
    - audit log vs landed code
  provenance: code-verified
  slug: voice-js-landed-without-its-audit-fixes-because-both-fix-commits-were-reverted
  phase: phase-1
  tags:
    - voice
    - plan-5
    - audit
    - landing
    - bus-talking
  created: 2026-10-17
  originSessionId: c9d28c43-3279-46de-a04e-0b6f5b953eb4
  modified: 2026-10-17T22:05:47.324Z
---

Read the audit log with care here. It lists fixes that did not land.

**The evidence.** The reflog of task branch `war/2026-10-17-obelisks-5-voice/p1-t1` reads: `feat(voice)` 6bdf9b9, `fix(voice)` d1721e4, a revert of d1721e4, `fix(voice)` b59752e, a revert of b59752e. The pin-transfer record says the engine forward-reverted b59752e as 0825aa2 before the rebase. The landed `src/features/voice.js` at tip 291eb2d has none of the fix constructs. The inputs do not say why the fix commits were reverted.

**Open defects at the tip.** Each one was read in the landed file.
- **Sub-frame tap (Major).** The `selectstart` listener has no check that the press is still held. See [[xr-js-defers-bus-selectstart-one-frame-but-emits-select-and-selectend-at-once]].
- **Self-stop leaks the flag.** A recorder `stop` with no `selectend` (recorder error, ended mic track) runs `finish()` with `heldMs` 0. `finish()` drops the take but never clears `holdTimer`. The timer sets `bus.talking = sid` 300 ms later, and the later `selectend` returns on `!rec`. The flag stays set until another hold ends.
- **Session end mid-hold.** `src/features/voice.js` has no `sessionend` handler and does not destructure `renderer`. `rec` stays set, so every later `selectstart` returns on the `rec` guard. Voice stays dead until a page reload, and `bus.talking` stays on the sid.
- **Any controller releases.** The `selectend` listener takes no argument and ignores `e.detail.controller`. The other hand's press and release cuts the take short.
- **Dead mic stream.** `requestStream` returns true when `stream` is non-null, and arming only tests `!stream`. An ended track is treated as live. In `?mic=button` mode a second click cannot recover it.
- **Send and flag disagree near 300 ms.** `finish()` sends on wall-clock `heldMs >= 300`, and `bus.talking` comes from a separate 300 ms timer. A release just after 300 ms but before the timer task can send the take while `bus.talking` was never set, so plan 6's fork reads null and the same press both forks and talks.
- **Smaller.** `stopRecognizer` leaves `onresult` attached, so interim text can reappear after the glyph hides. A second `Enable mic` click while `getUserMedia` is pending shows `Mic failed`.

**Generic JS trap in `pickMime`.** `typeof MediaRecorder?.isTypeSupported` still throws a ReferenceError when the global `MediaRecorder` is undeclared. `typeof` only protects a bare identifier, not a member expression. Use `globalThis.MediaRecorder?.isTypeSupported`. The call sits outside the `try` in the `selectstart` listener, so the throw would send no `talk` error. Quest Browser has `MediaRecorder`, so this is a robustness gap only.

**Why it matters for the Quest slot.** End states 5 to 7 are judged on the device. A stuck glyph, a recording that will not start, or a dead fork after one voice use points at the defects above. The relay half also answers `say unavailable` until plan 2's `say.mjs` exists. At this tip `server/commands` holds only `voice.mjs` and its test.

**Not a plan deviation.** The slice pins `install({scene, camera, renderer, bus, net})`. The landed `install` destructures `{ scene, camera, bus, net }`. Behavior is identical because `main.js` passes one ctx object.

Locate-cue (verify still present before acting): `finish`, `requestStream`, `pickMime`, `stopRecognizer`, the `selectstart` and `selectend` listeners in `src/features/voice.js`. A grep of `src/` for `sessionend` returns nothing. Read in the `_refinery` integration worktree, whose HEAD equalled landed tip 291eb2d on dev/obelisks-5. If a follow-up commit touched `src/features/voice.js`, re-read before trusting any bullet.

Related: [[decide-compares-bus-talking-to-the-sid-string-and-nothing-sets-bus-talking-yet]], [[a-relay-command-that-emits-and-returns-an-error-frame-sends-the-issuer-two-copies]].
