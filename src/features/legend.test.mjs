import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legendSections } from './legend.js';
import { ROLE_COLORS, STATE_COLORS } from '../colors.js';

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
