import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legendSections } from './legend.js';
import { ROLE_COLORS, STATE_COLORS, MONOLITH_RED, CODEX_TEAL } from '../colors.js';

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

test('the legend lists every role and state color from colors.js, with the same hex', () => {
  const [roles, states] = legendSections();
  assert.deepEqual(roles.rows.map((r) => [r.label, r.swatch]), Object.entries(ROLE_COLORS).map(([k, v]) => [k, hex(v)]));
  assert.deepEqual(states.rows.map((r) => [r.label, r.swatch]), Object.entries(STATE_COLORS).map(([k, v]) => [k, hex(v)]));
});

test('the legend explains shapes and controls', () => {
  const titles = legendSections().map((s) => s.title);
  assert.ok(titles.includes('Shapes') && titles.includes('Controls'));
  const text = legendSections().flatMap((s) => s.rows.map((r) => r.label)).join(' ');
  for (const word of ['fork', 'pipe', 'pylon', 'subagents', 'mute']) assert.ok(text.includes(word), word);
});

test('the legend tells the harnesses apart by their edge colors from colors.js', () => {
  const harness = legendSections().find((s) => s.title === 'Monolith edges (harness)');
  assert.deepEqual(harness.rows.map((r) => r.swatch), [hex(MONOLITH_RED), hex(CODEX_TEAL)]);
  assert.match(harness.rows[0].label, /Claude Code/);
  assert.match(harness.rows[1].label, /Codex/);
});
