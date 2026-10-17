import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slabHeight, stackLayout, SLAB_GAP, BAR_HEIGHT, FALLBACK_SLAB_HEIGHT } from './stack.js';

// Heights from the audit finding: a2 (3 lines), a3 bar, a4 (6 lines), a5 (1 line).
const FIXTURE = [0.14, BAR_HEIGHT, 0.29, 0.048];

// Oracle that does not share the layout code: every slab's top must sit at or
// under the next slab's bottom.
function assertNoOverlap(heights, { offsets, height }) {
  assert.equal(offsets.length, heights.length);
  for (let i = 0; i + 1 < heights.length; i++) {
    assert.ok(offsets[i] + heights[i] <= offsets[i + 1] + 1e-9, `slab ${i} overlaps slab ${i + 1}`);
  }
  if (heights.length) assert.ok(Math.abs(offsets.at(-1) + heights.at(-1) - height) < 1e-9);
}

test('stackLayout: an empty stack has no offsets and zero height', () => {
  assert.deepEqual(stackLayout([]), { offsets: [], height: 0 });
});

test('stackLayout: one slab sits at the bottom and the stack is as tall as it', () => {
  assert.deepEqual(stackLayout([0.29]), { offsets: [0], height: 0.29 });
});

test('stackLayout: tall slabs never overlap the slab above (the fixture heights)', () => {
  const layout = stackLayout(FIXTURE);
  assertNoOverlap(FIXTURE, layout);
  assert.ok(layout.offsets[2] >= 0.14 + BAR_HEIGHT, 'a4 starts above a2 and a3');
  assert.ok(layout.offsets[3] >= layout.offsets[2] + 0.29, 'a5 starts above the six-line a4');
});

test('stackLayout: each offset is the sum of the heights below plus one gap per boundary', () => {
  const heights = [0.1, 0.2, 0.3];
  const { offsets, height } = stackLayout(heights, 0.01);
  assert.deepEqual(offsets.map((v) => +v.toFixed(6)), [0, 0.11, 0.32]);
  assert.ok(Math.abs(height - 0.62) < 1e-9);
  assertNoOverlap(heights, stackLayout(heights, 0));
});

test('stackLayout: the default gap is SLAB_GAP', () => {
  assert.deepEqual(stackLayout([1, 1]), stackLayout([1, 1], SLAB_GAP));
  assert.ok(SLAB_GAP > 0);
});

test('slabHeight: a far slab is the bar height even when text was measured', () => {
  assert.equal(slabHeight({ band: 'far', textRenderInfo: { blockBounds: [0, 0, 0.6, 0.29] } }), BAR_HEIGHT);
  assert.equal(slabHeight({ band: 'far', textRenderInfo: null }), BAR_HEIGHT);
});

test('slabHeight: near, mid, and unbanded slabs use the measured block span', () => {
  const info = { blockBounds: [-0.3, 0, 0.3, 0.29] }; // anchorY bottom: [0, totalHeight]
  for (const band of ['near', 'mid', null]) assert.ok(Math.abs(slabHeight({ band, textRenderInfo: info }) - 0.29) < 1e-9);
  // any anchor: the span is maxY - minY
  assert.ok(Math.abs(slabHeight({ band: 'near', textRenderInfo: { blockBounds: [0, -0.1, 0.6, 0.15] } }) - 0.25) < 1e-9);
});

test('slabHeight: before the first sync a text slab falls back to FALLBACK_SLAB_HEIGHT', () => {
  assert.equal(slabHeight({ band: 'near', textRenderInfo: null }), FALLBACK_SLAB_HEIGHT);
  assert.equal(slabHeight({ band: 'near', textRenderInfo: undefined }), FALLBACK_SLAB_HEIGHT);
  assert.equal(slabHeight({ band: null, textRenderInfo: {} }), FALLBACK_SLAB_HEIGHT);
});
