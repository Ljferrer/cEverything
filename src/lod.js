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

// Forward view cone. The band uses an effective distance: the real distance
// times a scale from the horizontal angle between where the viewer faces and
// the obelisk. Inside the inner cone detail reaches twice as far, so turning
// to face an obelisk opens it up even from a step back; outside the outer cone
// it collapses sooner, and behind the viewer sooner still. Only the yaw counts,
// so looking up or down a tall stack never collapses it.
export const CONE_INNER_COS = Math.cos((30 * Math.PI) / 180);
export const CONE_OUTER_COS = Math.cos((60 * Math.PI) / 180);
export const CONE_IN_SCALE = 0.5;
export const CONE_OUT_SCALE = 2;
export const BEHIND_SCALE = 4;

/** Distance scale for an obelisk at horizontal angle `cosAngle` from the viewer's facing. */
export function coneScale(cosAngle) {
  if (!Number.isFinite(cosAngle)) return 1;
  if (cosAngle >= CONE_INNER_COS) return CONE_IN_SCALE;
  if (cosAngle >= CONE_OUTER_COS) {
    const t = (CONE_INNER_COS - cosAngle) / (CONE_INNER_COS - CONE_OUTER_COS);
    return CONE_IN_SCALE + t * (CONE_OUT_SCALE - CONE_IN_SCALE);
  }
  return cosAngle >= 0 ? CONE_OUT_SCALE : BEHIND_SCALE;
}

/** The mid-band text: the first 80 characters plus the obelisk's tool count. */
export function midSummary(text, toolCount) {
  return `${text.slice(0, SHORT)} · ${toolCount} tools`;
}
