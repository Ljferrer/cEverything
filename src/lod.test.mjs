import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lod, midSummary, NEAR, FAR, HYSTERESIS, SHORT } from './lod.js';

const LONG = 200; // a text at or past the short-text cutoff keeps the plain distance bands

test('lod constants match D13: near < 1.5 m, far > 5 m, hysteresis 0.1, short text under 80', () => {
  assert.equal(NEAR, 1.5);
  assert.equal(FAR, 5);
  assert.equal(HYSTERESIS, 0.1);
  assert.equal(SHORT, 80);
});

test('lod bands by distance for a long text', () => {
  assert.equal(lod(0, LONG), 'near');
  assert.equal(lod(1.49, LONG), 'near');
  assert.equal(lod(1.51, LONG), 'mid');
  assert.equal(lod(3, LONG), 'mid');
  assert.equal(lod(4.99, LONG), 'mid');
  assert.equal(lod(5.01, LONG), 'far');
  assert.equal(lod(40, LONG), 'far');
});

test('short-text rule: a text under 80 characters shows full text (near) in the mid band only', () => {
  assert.equal(lod(3, 0), 'near');
  assert.equal(lod(3, 40), 'near');
  assert.equal(lod(3, 79), 'near');
  assert.equal(lod(3, 80), 'mid');
  assert.equal(lod(1, 40), 'near');
  assert.equal(lod(6, 40), 'far');
});

test('hysteresis 0.1 keeps the previous band across the edge', () => {
  // near -> mid edge at 1.5
  assert.equal(lod(1.55, LONG), 'mid');
  assert.equal(lod(1.55, LONG, 'near'), 'near');
  assert.equal(lod(1.65, LONG, 'near'), 'mid');
  assert.equal(lod(1.45, LONG, 'mid'), 'mid');
  assert.equal(lod(1.35, LONG, 'mid'), 'near');
  // mid -> far edge at 5
  assert.equal(lod(5.05, LONG, 'mid'), 'mid');
  assert.equal(lod(5.15, LONG, 'mid'), 'far');
  assert.equal(lod(4.95, LONG, 'far'), 'far');
  assert.equal(lod(4.85, LONG, 'far'), 'mid');
  // an unknown previous band means no bias
  assert.equal(lod(1.55, LONG, null), 'mid');
  assert.equal(lod(1.55, LONG, 'bogus'), 'mid');
});

test('midSummary is the first 80 characters plus the tool count', () => {
  const text = 'a'.repeat(100);
  assert.equal(midSummary(text, 2), 'a'.repeat(80) + ' · 2 tools');
  assert.equal(midSummary('short', 0), 'short · 0 tools');
});
