import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, STATUSES } from '../shared/protocol.mjs';
import { colorFor, stateColor } from './colors.js';

const isRgbInt = (c) => Number.isInteger(c) && c >= 0 && c <= 0xffffff;

test('colorFor returns four distinct colors for the four roles', () => {
  assert.equal(ROLES.length, 4);
  const colors = ROLES.map(colorFor);
  for (const c of colors) assert.ok(isRgbInt(c), `not an rgb int: ${c}`);
  assert.equal(new Set(colors).size, 4);
});

test('colorFor falls back to a color for an unknown role', () => {
  assert.ok(isRgbInt(colorFor('nobody')));
  assert.ok(isRgbInt(colorFor(undefined)));
});

test('stateColor covers the five statuses with distinct colors', () => {
  assert.equal(STATUSES.length, 5);
  const colors = STATUSES.map(stateColor);
  for (const c of colors) assert.ok(isRgbInt(c), `not an rgb int: ${c}`);
  assert.equal(new Set(colors).size, 5);
  assert.ok(isRgbInt(stateColor('bogus')));
});
