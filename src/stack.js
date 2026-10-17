// Stack layout for an obelisk's slabs (PIN-1, PIN-13). Pure: no three.js.
//
// Slabs stack bottom to top by their measured heights, each separated by
// SLAB_GAP, so a six-line slab never draws under the slab above it. A slab in
// the `far` band is a bar of BAR_HEIGHT; any other band shows troika text whose
// height is the blockBounds span (maxY - minY) once its async sync completes,
// and FALLBACK_SLAB_HEIGHT before the first sync.

export const SLAB_GAP = 0.02;
export const BAR_HEIGHT = 0.05;
export const FALLBACK_SLAB_HEIGHT = 0.12;

/**
 * Height of one slab in meters.
 * @param {{band:string|null, textRenderInfo?:{blockBounds?:number[]}|null}} slab
 */
export function slabHeight({ band, textRenderInfo }) {
  if (band === 'far') return BAR_HEIGHT;
  const bounds = textRenderInfo?.blockBounds;
  return bounds ? bounds[3] - bounds[1] : FALLBACK_SLAB_HEIGHT;
}

/**
 * Bottom y of each slab, and the top of the whole stack.
 * @param {number[]} heights bottom to top
 * @returns {{offsets:number[], height:number}}
 */
export function stackLayout(heights, gap = SLAB_GAP) {
  const offsets = [];
  let y = 0;
  for (const h of heights) {
    offsets.push(y);
    y += h + gap;
  }
  return { offsets, height: heights.length ? y - gap : 0 };
}
