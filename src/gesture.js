// Pure gesture rules for plan 6 (PIN-70, PIN-74). No imports: node tests and
// the features share these two functions.

/**
 * Map a base `select` to the protocol command it means, or null.
 * `select` is plan 1's event detail `{sid, kind, slabId}`; `selectedSlab` is
 * `bus.selectedSlab` (`{sid, slabId}` or null); `talkingSid` is `bus.talking`
 * (plan 5's hold-to-talk, PIN-76); `beaconRaised` says the sid's beacon is up,
 * so this select only acknowledges it (PIN-77).
 * @returns {{t:'fork', sid} | {t:'pipe', from, to, slab} | null}
 */
export function decide(select, selectedSlab, talkingSid, beaconRaised) {
  if (!select || select.kind !== 'base') return null;
  if (talkingSid === select.sid || beaconRaised) return null;
  if (selectedSlab == null || selectedSlab.sid === select.sid) return { t: 'fork', sid: select.sid };
  return { t: 'pipe', from: selectedSlab.sid, to: select.sid, slab: selectedSlab.slabId };
}

/**
 * The sticky beacon rule: `'raise'` on entering `waiting`, `'keep'` while it
 * stays `waiting`, `'none'` for every other status. A status change never
 * lowers the beacon; a select does (PIN-18, PIN-74).
 */
export function beaconNext(prevStatus, status) {
  if (status !== 'waiting') return 'none';
  return prevStatus === 'waiting' ? 'keep' : 'raise';
}
