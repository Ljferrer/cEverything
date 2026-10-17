# Red-team report — Obelisks plan 1 (foundation)

**Verdict:** ADJUDICATED
**Rounds:** 1

Plan: `docs/plans/2026-10-17-obelisks-1-foundation.md` · artifactKind `impl-plan` · run `wf_33119469-0d3` (2026-10-17, `--afk`, red-team seat opus/high) · state at run time: Task 1 merged on `integration/2026-10-17-obelisks-1-foundation/phase-1` at 254f0dc, Tasks 2 and 3 built on their task branches (ff84be4, 8bcc97c).

## Attack surface

8 probes, 8 on target, 0 off target, 0 dropped: 6 spine lenses (claims-vs-reality, executable-proof, coverage-vs-source, consistency-placeholders, dependency-feasibility, intent-vs-plan) plus 2 bespoke (`check-literal-transport`, executed against a throwaway clone with the three branches merged; `seam-contract-vs-plans-2-6`, analyzed). Lead-run checks: backstop legitimacy (3 rows, each with reason, runner, timing: pass), judge-tag grading (End states 6, 7 justified; End state 11 commandable with a QR decoder dependency, left judged), four drift-guard probes (vacuous: no mirrors, default flips, split guards or doc rewrites).

## Executed proof

2 executed probes. Escape guard: 2 moved refs (`master`, `claude/hermes-vr-spatial-5b5bf8`), both authored by the campaign-lead session inside the window (plan edits pushed to master), provenance-cleared as foreign, no probe residue.

## Findings (root causes; 42 blocker rows and 15 needsDecision rows collapse to these)

1. Vite host check: a tunnel hostname gets HTTP 403 without `server.allowedHosts` (Critical, executed). Built code already sets `allowedHosts: true`; the slice did not say so.
2. `npm init` writes `"type": "commonjs"`, which breaks the ESM `src/*.js` under `node --test` (Major, executed). Built code has `"type": "module"`; the slice did not say so.
3. End state 1 expects `# fail 0`, but Node 24's spec reporter prints `ℹ fail 0` (Major, executed).
4. Mode rule: `--source synthetic` named explicitly read as `live` under the slice's wording (Major). Built `modeFor` returns `synthetic` when every started source is synthetic; the slice now says so.
5. Loader: missing `server/commands/` and `*.test.mjs` files under the loaded dirs (Major). Built loader tolerates ENOENT and skips test files; the slice now says so.
6. Port 8787 hard-coded (Major). Built relay has `--port` and `startRelay({port, …})`; the slice now says so.
7. `ctx.commands` "map" read as a JS `Map` by the first worker (Major, recorded in commit 254f0dc). Slice now says null-prototype plain object.
8. D19 named `handle(cmd)` as the optional source export while Task 1 and plan 2 use `sendCommand` (Major, three lenses). D19 rewritten to the `sendCommand`/`titleOf`/`slabText` surface, `stop()` optional, `start` settle semantics stated.
9. In-scene mode label lived in `laptop.js`, invisible in the headset (Major, three lenses). Built Task 3 put it in `xr.js`; plan now matches.
10. `laptop.js` gated on `!navigator.xr` misses phones whose Chrome exposes `navigator.xr` without VR (Major). Task 3 slice now adds the `isSessionSupported('immersive-vr')` arm.
11. Late-join backfill: the relay replayed slabs but not `session`/`state` frames to a new client, so a QR hop-in saw orphan slabs (Major). New Task 4 adds the per-sid session/state cache and ordered replay.
12. `lod` "pure with hysteresis" contradiction (Major/Minor). Built `lod(distance, textLength, prev = null)` matches the resolution; D13 and Task 2 now say so.
13. Purpose "both headsets before 2 PM" unmeetable; End states 6 and 7 judged on real devices no auditor can reach (Major). Purpose restated; End states 6 and 7 re-anchored on the visionOS Simulator, the Immersive Web Emulator and a phone viewport, with the devices as backstop rows 1 to 3.
14. End state 12 check covered only three protocol exports (Major/Minor). Check extended to input, colors, lod imports and greps for room, obelisk, bus and relay seams.
15. End state 10 grep case-sensitive and `src/` only (Minor). Widened to case-insensitive over `src/ shared/ index.html`.
16. Task 1 `Done when` lacked the install prefix (Major). Added.
17. Non-goals listed "subagent child obelisks" against D12/D20/D21 (Major). Reworded to the D20 glob assumption.
18. `bus.selected` type unstated (Minor). Now the sid string.
19. Command-module export form unstated (Major). Now named exports.
20. Plans 2 to 6 findings (plan 5 test ctx, plan 3 `titleOf` signature, plan 6 fork vs hold-to-talk, plan 2 `sendCommand` wording, fixture ordering for plan 4): routed to the campaign lead, who applied the plan 4/5/6 fixes on master.

## Resolutions applied

Plan patched in place (29 edits, commit on `dev/obelisks-1`): items 1 to 19 above. Task 4 added to wave 2. No pin removed; D16 (Vite 8), D13 (`prev` argument) and D19 (writable surface) are adjudicated value changes, rows below.

## Residual risk

- Adjudicated, not re-verified: no probe re-ran after the patch; the relaunch's Done-when floors and End-state checks are the re-verification.
- End state 11 stays judged (a QR decoder dependency was not worth adding today).
- Task 3 `deps: [1]` imports `allObelisks` from Task 2's `room.js`; both are built and merge in wave 2, so the integration tip resolves it.
- Phase 1 time windows in Pivotal constraints are stale (relaunch at ~1:45 PM).
- iwer is the browser extension, not a package; D4 reworded.

## Adjudications

| adjudicated | supersedes | provenance |
|---|---|---|
| D16 stack: Vite 8 with `"type": "module"` | plan literal "Vite 7" | AI-declared (2026-10-17, --afk) |
| D13: `lod(distance, textLength, prev = null)`, 0.1 m hysteresis only with `prev` | "a pure function with hysteresis 0.1" | AI-declared (2026-10-17, --afk) |
| D19: writable source = `sendCommand(method, params)` + `titleOf` + `slabText`; optional `stop()` | "optionally `handle(cmd)`" | AI-declared (2026-10-17, --afk) |
| End state 1 check: `npm test -- --test-reporter=tap \| grep '^# fail 0'` | `npm test` prints `# fail 0` | AI-declared (2026-10-17, --afk) |
| End states 6/7: emulator and phone-viewport observables at audit_sha; devices as backstops | real-headset / share-link observables at audit_sha | AI-declared (2026-10-17, --afk) |
| Purpose: emulators and laptop before the slots, devices at their slots | "both headsets and on the laptop before 2 PM" | AI-declared (2026-10-17, --afk) |
| Task 4 (relay late-join backfill) added to wave 2 | three-task phase | AI-declared (2026-10-17, --afk) |
