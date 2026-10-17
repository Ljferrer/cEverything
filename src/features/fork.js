// Pinch a base to fork that session (PIN-6). `decide` turns plan 1's `select`
// into the `{t:'fork', sid}` command; this feature gates it on the last `mode`
// frame's canEdit (false until one arrives, PIN-73) and a one-second
// per-obelisk throttle (PIN-71), sends it, clears the selected slab (PIN-78),
// and logs one line per decision (PIN-79). It also owns the `talking` and
// `acknowledge` suppression lines for every base select; a `pipe` result is
// pipe.js's. The forked obelisk arrives as a `session` with `parent` set and
// room.js places it.
import { decide } from '../gesture.js';

export const THROTTLE_MS = 1000;

export function install({ bus, net }) {
  let canEdit = false;
  /** @type {Map<string, number>} sid -> Date.now() at the last send */
  const lastSent = new Map();

  bus.addEventListener('mode', (e) => {
    canEdit = e.detail.canEdit === true;
  });

  bus.addEventListener('select', (e) => {
    const payload = e.detail;
    const cmd = decide(payload, bus.selectedSlab, bus.talking ?? null, bus.beacons?.has(payload.sid) ?? false);
    if (!cmd) {
      if (payload?.kind !== 'base') return;
      if (bus.talking === payload.sid) console.log(`fork: suppressed talking ${payload.sid}`);
      else if (bus.beacons?.has(payload.sid)) console.log(`fork: suppressed acknowledge ${payload.sid}`);
      return;
    }
    if (cmd.t !== 'fork') return;
    if (!canEdit) return console.log(`fork: suppressed view-only ${cmd.sid}`);
    const now = Date.now();
    const last = lastSent.get(cmd.sid);
    if (last !== undefined && now - last < THROTTLE_MS) return console.log(`fork: suppressed throttled ${cmd.sid}`);
    net.send(cmd);
    console.log(`fork: send ${JSON.stringify(cmd)}`);
    lastSent.set(cmd.sid, now);
    bus.selectedSlab = null;
  });
}
