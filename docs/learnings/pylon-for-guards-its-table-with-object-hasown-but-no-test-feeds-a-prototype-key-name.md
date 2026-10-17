---
name: pylon-for-guards-its-table-with-object-hasown-but-no-test-feeds-a-prototype-key-name
description: "pylonFor guards its table lookup with Object.hasOwn, and no test feeds it constructor or toString."
metadata:
  node_type: memory
  type: project
  keywords:
    - Object.hasOwn
    - prototype key
    - constructor
    - toString
    - __proto__
    - frozen table lookup
    - wire-supplied name
    - pylonFor
    - colorFor
    - test gap
    - own property
  provenance: code-verified
  slug: pylon-for-guards-its-table-with-object-hasown-but-no-test-feeds-a-prototype-key-name
  phase: phase-1
  tags:
    - pylons
    - pattern
    - tests
    - plan-4
  created: 2026-10-17
  originSessionId: 7b6542dc-508a-47a9-9f77-990bb5b6cd58
  modified: 2026-10-17T22:12:00.693Z
---

Pattern note and a small test gap. Tool names come off the wire, so any string can reach a table lookup.

**The pattern.** `pylonFor` in `src/pylon-map.js` checks `Object.hasOwn(TABLE, name)` before it reads `TABLE[name]`. `TABLE` is a frozen object literal, so it inherits from `Object.prototype`. Without the guard, `TABLE['constructor']` or `TABLE['toString']` is truthy and `pylonFor` would return a function instead of a pylon name. It also checks `typeof name !== 'string'` first.

**The gap.** `src/pylon-map.test.mjs` ES1 lists the real tool names, the `browser_` and `mcp__` rules, `bash`, an unknown name and the spawning names. It has no `constructor`, `toString` or `__proto__` name, so no test pins the guard. A refactor to a bare `TABLE[name]` would pass the suite.

**A sibling without the guard.** `colorFor` and `stateColor` in `src/colors.js` read `ROLE_COLORS[role] ?? FALLBACK` on frozen literals. A prototype-key string returns an inherited function, not `FALLBACK`. Role and status values are less open than tool names, so this was not judged a defect here. Check it if a new source can send free-form roles.

**Rule.** For a lookup keyed by an external string, use `Object.hasOwn`, a `Map` or a null-prototype object. Add one prototype-key name to the table test so the guard stays pinned.

Locate-cue (verify still present before acting): `Object.hasOwn(TABLE, name)` in `src/pylon-map.js`; `ROLE_COLORS[role] ?? FALLBACK` in `src/colors.js`; the ES1 case in `src/pylon-map.test.mjs`. Grounding: the cwd HEAD was the pre-land base, so this was read in the run's integration worktree at tip 857b5ee, the second parent of landed merge e6ef0f2.

Related: [[json-parse-catch-misses-valid-scalar]], [[weak-test-assertion-passes-without-feature-being-exercised]].
