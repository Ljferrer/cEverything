// The page-wide event bus (PIN-22 seam). Every server frame from `net` is
// re-emitted here under its `t` name; features emit `select`, `selectstart`,
// `selectend`, `miss`, and `frame`. Listeners read the payload from `e.detail`.

export class Bus extends EventTarget {
  /** sid of the last selected obelisk, or null. */
  selected = null;
  /** {sid, slabId} of the last selected slab, or null. */
  selectedSlab = null;

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export function createBus() {
  return new Bus();
}
