// Pure select-input helpers shared by xr.js (controller rays) and laptop.js
// (mouse and touch clicks). No three.js import: `hitToEvent` reads only
// `hit.object` and its `parent` chain, so Node tests run it on plain objects.

/**
 * Map a three.js raycast hit to a bus event. Walks up from the hit mesh until
 * it finds obelisk userData: `{sid, kind:'base'}` on a base, `{sid, slabId}`
 * on a slab (Task 2's contract). No hit, or no obelisk userData, is a miss.
 * @returns {{type:'select', sid, kind:'base'|'slab', slabId, object} | {type:'miss'}}
 */
export function hitToEvent(hit) {
  if (!hit?.object) return { type: 'miss' };
  for (let o = hit.object; o; o = o.parent) {
    const d = o.userData;
    if (!d || d.sid == null) continue;
    if (d.kind === 'base') return { type: 'select', sid: d.sid, kind: 'base', slabId: null, object: hit.object };
    if (d.slabId != null) return { type: 'select', sid: d.sid, kind: 'slab', slabId: d.slabId, object: hit.object };
  }
  return { type: 'miss' };
}

/**
 * Publish a mapped event on the bus. A select sets `bus.selected` to the sid
 * and, for a slab, `bus.selectedSlab` to `{sid, slabId}`; a base select keeps
 * the previous slab so plan 6's pipe gesture can read both. A miss emits
 * `miss` and leaves the selection alone.
 */
export function applySelection(bus, ev) {
  if (ev.type !== 'select') {
    bus.emit('miss', {});
    return ev;
  }
  const { type, ...detail } = ev;
  bus.selected = detail.sid;
  if (detail.kind === 'slab') bus.selectedSlab = { sid: detail.sid, slabId: detail.slabId };
  bus.emit('select', detail);
  return ev;
}

/**
 * Hold the last `type` payload emitted on `bus`, so a feature that subscribes
 * after an await can apply a frame that arrived while it waited. The relay
 * sends `mode` once per connection, and `net` connects before any feature
 * installs, so laptop.js latches it across its async install probe.
 * `last` is null until the first frame; `stop()` detaches the latch.
 */
export function latchLast(bus, type) {
  const latch = { last: null, stop: () => bus.removeEventListener(type, keep) };
  const keep = (e) => (latch.last = e.detail);
  bus.addEventListener(type, keep);
  return latch;
}

/** The Object3D to raycast for one entry of `allObelisks()`: the obelisk itself or the subtree it carries. */
export function rootOf(obelisk) {
  if (!obelisk) return null;
  if (obelisk.isObject3D) return obelisk;
  return obelisk.group ?? obelisk.root ?? null;
}

/**
 * The laptop.js install gate (PIN-7). True on `?mode=laptop`, when `navigator.xr`
 * is absent, or when `isSessionSupported('immersive-vr')` resolves false or
 * rejects. The last arm is the phone view: Chrome exposes `navigator.xr`
 * without immersive-vr, so the orbit camera with touch installs there.
 */
export async function shouldInstallLaptop(loc = location, nav = navigator) {
  if (new URLSearchParams(loc.search).get('mode') === 'laptop') return true;
  if (!nav.xr) return true;
  try {
    return !(await nav.xr.isSessionSupported('immersive-vr'));
  } catch {
    return true;
  }
}

/**
 * The view link a QR code carries, never the edit key: `?share=<url>` when
 * set, else the public tunnel the dev server was started with
 * (VITE_SHARE_URL, e.g. in .env.local), else the bare origin.
 */
export function viewLink(loc = location, env = import.meta.env) {
  return new URLSearchParams(loc.search).get('share') ?? (env?.VITE_SHARE_URL || loc.origin);
}
