---
name: workflow-args-global-arrives-json-stringified
description: "Workflow args global arrives as a JSON string"
metadata:
  seededFrom: work-audit-refine/docs/seed@0.21.15
  node_type: memory
  type: project
  slug: workflow-args-global-arrives-json-stringified
  keywords:
    - Workflow
    - args
    - JSON-stringified
    - parse shim
    - workflow-template
    - scaffold
    - ad-hoc script
    - harness
  created: 2026-07-12
---

# The Workflow tool's `args` global arrives JSON-stringified

Probe-confirmed 2026-07-12 (two minimal Workflow runs, one inline `script`, one `scriptPath`,
both with object `args`): the harness injects the `args` global as the **JSON-encoded string**,
not the object — `typeof args === 'string'` in both launch modes, despite the tool doc promising
the value "verbatim" and warning against stringified input. Failure signature when a script
trusts the doc: `undefined is not an object (evaluating 'args.<key>.<method>')` at first property
access. Known upstream: anthropics/claude-code#72248 (open; observed on Claude Code 2.1.207).

**Why:** any ad-hoc Workflow script that reads `args.foo` directly dies at launch (in
milliseconds, before any agent spawns). WAR's production scripts are already immune via the
canonical shim.

**How to apply:** open every ad-hoc Workflow script with the same shim `workflow-template.js`
uses (the `const A = typeof args === 'string' ? JSON.parse(args) : (args || {})` line near its
top; red-team's `workflow-scaffold.js` has the `?? {}` variant) — or skip `args` entirely and
bake constants into the script.
