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

// The SEELE-monolith look: a matte black body with red edges and red glyphs.
export const MONOLITH_BLACK = 0x050505;
export const MONOLITH_RED = 0xff2a1a;

// The Codex look: deep teal stone with bright teal edges, so a Codex chat reads
// as another harness at a glance against the red hall.
export const CODEX_STONE = 0x062220;
export const CODEX_TEAL = 0x2ee6c9;

const FALLBACK = 0x9e9e9e;

/** Color for a slab role: `user`, `assistant`, `thinking`, or `tool`. */
export function colorFor(role) {
  return ROLE_COLORS[role] ?? FALLBACK;
}

/** Color for a session status: `idle`, `working`, `streaming`, `waiting`, or `error`. */
export function stateColor(status) {
  return STATE_COLORS[status] ?? FALLBACK;
}
