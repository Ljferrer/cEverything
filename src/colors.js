// Role and state colors for the wireframe look (PIN-8). Values are 24-bit RGB
// integers, ready for `new THREE.Color(n)` or `material.color.setHex(n)`.

export const ROLE_COLORS = Object.freeze({
  user: 0x4fc3f7, // sky blue
  assistant: 0xe8e8e8, // near white
  thinking: 0xb388ff, // violet
  tool: 0xffb74d, // amber
});

export const STATE_COLORS = Object.freeze({
  idle: 0x546e7a, // slate
  working: 0x4caf50, // green
  streaming: 0x26c6da, // cyan
  waiting: 0xffd54f, // yellow
  error: 0xef5350, // red
});

const FALLBACK = 0x9e9e9e;

/** Color for a slab role: `user`, `assistant`, `thinking`, or `tool`. */
export function colorFor(role) {
  return ROLE_COLORS[role] ?? FALLBACK;
}

/** Color for a session status: `idle`, `working`, `streaming`, `waiting`, or `error`. */
export function stateColor(status) {
  return STATE_COLORS[status] ?? FALLBACK;
}
