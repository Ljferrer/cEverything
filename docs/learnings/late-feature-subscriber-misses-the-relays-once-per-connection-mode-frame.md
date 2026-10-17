---
name: late-feature-subscriber-misses-the-relays-once-per-connection-mode-frame
description: "A feature that awaits before it subscribes to the bus misses the relay's single mode frame, so latch it first."
metadata:
  node_type: memory
  type: project
  keywords:
    - mode frame
    - latchLast
    - late subscriber
    - install await
    - bus event missed
    - canEdit say box
    - backfill
    - relay connection
  provenance: code-verified
  slug: late-feature-subscriber-misses-the-relays-once-per-connection-mode-frame
  phase: phase-1
  tags:
    - relay
    - bus
    - features
    - race
    - laptop
  created: 2026-10-17
  originSessionId: 24fe07c2-1e38-4429-b5c7-e1be2b220156
  modified: 2026-10-17T21:10:30.568Z
---

Gotcha for any feature file under `src/features/` in plans 2 to 6.

**The setup.** The relay sends one `mode` frame per connection, then replays its cache of `session`, `slab`, and `state` frames. Both happen in the `wss.on('connection')` handler in `server/relay.mjs` (`sendTo(client, modeFrame(client)); backfill(client)`). `src/main.js` calls `createNet(bus)` before it installs any feature. So a frame can reach the bus before a feature has subscribed.

**The case.** `src/features/laptop.js` awaits `shouldInstallLaptop()` before it would register a `mode` listener. On a phone or desktop Chrome that await is a browser `isSessionSupported` round trip. If the frame wins, the DOM mode label stays blank. An editor never sees the say box until a reconnect. The audit reasoned this race from code order. Nobody reproduced it in a browser.

**The fix.** `latchLast(bus, type)` in `src/input.js` holds the last payload of one event type. `laptop.js` latches `mode` before the await. It applies the held payload once after the UI exists, then calls `stop()`. `src/net.test.mjs` proves the latch holds a frame when `createNet` and `latchLast` run in the same synchronous turn.

**The limit.** The latch keeps only the last payload per type. It cannot rebuild the multi-frame `slab` backfill. A feature that needs backfilled `session` or `slab` frames must subscribe synchronously in `install`, before its first await.

**Rule.** In `install`, subscribe before the first await, or latch the event you need.

**Test order.** The test opens the net first, then latches, in one synchronous turn. That matches `main.js`. A first draft of the test comment had the order reversed. The audit caught it.

Locate-cue (verify still present before acting): `latchLast` in `src/input.js`, its use in `src/features/laptop.js`, `backfill(client)` in `server/relay.mjs`. Read at the phase 1 integrated tip (the landed merge's second parent).

Related: [[obelisks-molten-hackathon]].
