// Three-band level of detail for a slab (D13, PIN-13). Pure: no three.js.
//
//   near  (< 1.5 m)   full text
//   mid   (1.5–5 m)   first 80 characters plus ` · n tools`
//   far   (> 5 m)     a role-colored bar
//
// A text under 80 characters has no summary to show, so the mid band collapses
// to `near` (full text) for it. Passing the previous band applies a 0.1 m
// hysteresis: each edge moves 0.1 m away from the band the slab is in.

export const NEAR = 1.5;
export const FAR = 5;
export const HYSTERESIS = 0.1;
export const SHORT = 80;

/**
 * @param {number} distance   meters from the viewer to the slab
 * @param {number} textLength length of the slab's full text
 * @param {'near'|'mid'|'far'|null} [prev] the band the slab is in now
 * @returns {'near'|'mid'|'far'}
 */
export function lod(distance, textLength, prev = null) {
  const nearEdge = NEAR + (prev === 'near' ? HYSTERESIS : prev === 'mid' ? -HYSTERESIS : 0);
  const farEdge = FAR + (prev === 'far' ? -HYSTERESIS : prev === 'mid' ? HYSTERESIS : 0);
  const band = distance < nearEdge ? 'near' : distance < farEdge ? 'mid' : 'far';
  return band === 'mid' && textLength < SHORT ? 'near' : band;
}

/** The mid-band text: the first 80 characters plus the obelisk's tool count. */
export function midSummary(text, toolCount) {
  return `${text.slice(0, SHORT)} · ${toolCount} tools`;
}
