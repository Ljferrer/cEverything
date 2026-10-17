// Obelisk state (PIN-18): every `state` (and `session`) status goes through
// plan 1's `setState`; `waiting` raises the beacon and it stays up until that
// obelisk is selected (PIN-74, the sticky rule in gesture.js); `working` and
// `streaming` pulse the base between the state color and the idle color once
// per second on `frame`; any other status holds its steady color (PIN-75).
// `bus.beacons` is the set of raised sids, which fork.js and pipe.js read on
// the same `select` before the microtask here lowers it (PIN-77). `getObelisk`
// comes from `ctx.getObelisk` (a test's fake) or room.js on first use (PIN-80).
import { beaconNext } from '../gesture.js';
import { stateColor } from '../colors.js';

const PULSE_MS = 1000;
const PULSING = new Set(['working', 'streaming']);

const baseOf = (obelisk) => obelisk?.children?.find((c) => c.userData?.kind === 'base') ?? null;

/** Linear blend of two 24-bit RGB ints, t in [0, 1]. */
function mixHex(a, b, t) {
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const ca = (a >> shift) & 0xff;
    const cb = (b >> shift) & 0xff;
    out += Math.round(ca + (cb - ca) * t) << shift;
  }
  return out;
}

export function install(ctx) {
  const { bus } = ctx;
  bus.beacons ??= new Set();
  /** @type {Map<string, string>} sid -> last status */
  const last = new Map();
  /** @type {Map<string, {obelisk: object, status: string}>} sid -> obelisks that pulse */
  const pulsing = new Map();
  let getObelisk = ctx.getObelisk ?? null;
  let room = null;
  const withObelisk = (sid, fn) => {
    if (getObelisk) return fn(getObelisk(sid));
    room ??= import('./room.js');
    return room.then((m) => fn((getObelisk = m.getObelisk)(sid)));
  };

  const apply = ({ sid, status }) =>
    withObelisk(sid, (obelisk) => {
      if (!obelisk) return;
      obelisk.setState(status);
      if (beaconNext(last.get(sid), status) === 'raise') {
        obelisk.setBeacon(true);
        bus.beacons.add(sid);
      }
      last.set(sid, status);
      if (PULSING.has(status)) {
        pulsing.set(sid, { obelisk, status });
      } else {
        pulsing.delete(sid);
        baseOf(obelisk)?.material.color.setHex(stateColor(status));
      }
    });

  bus.addEventListener('state', (e) => apply(e.detail));
  bus.addEventListener('session', (e) => apply(e.detail));

  // A cosine pulse: the state color at 0 and 1000 ms, the idle color at 500 ms.
  bus.addEventListener('frame', (e) => {
    if (!pulsing.size) return;
    const now = e.detail?.now ?? performance.now();
    const t = (1 - Math.cos(((now % PULSE_MS) / PULSE_MS) * Math.PI * 2)) / 2;
    const idle = stateColor('idle');
    for (const { obelisk, status } of pulsing.values()) {
      baseOf(obelisk)?.material.color.setHex(mixHex(stateColor(status), idle, t));
    }
  });

  // Lower after the dispatch, so fork.js and pipe.js see the raised beacon on this select.
  bus.addEventListener('select', (e) => {
    const { sid } = e.detail;
    queueMicrotask(() => {
      if (bus.beacons.delete(sid)) withObelisk(sid, (obelisk) => obelisk?.setBeacon(false));
    });
  });
}
