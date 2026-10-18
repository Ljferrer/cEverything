import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, CONTROLS, headsetAddress } from './help.js';

test('the headset address keeps the edit key and drops everything else', () => {
  assert.equal(headsetAddress({ host: 'x.trycloudflare.com', search: '?mode=laptop&key=edit' }), 'x.trycloudflare.com/?key=edit');
  assert.equal(headsetAddress({ host: 'x.trycloudflare.com', search: '' }), 'x.trycloudflare.com/');
});

test('the help covers entering VR, the mic, and every gesture', () => {
  const text = [...STEPS, ...CONTROLS].join(' ');
  for (const word of ['Quest Browser', 'Enter VR', 'microphone', 'fork', 'pipe', 'speak', 'Meta button']) assert.ok(text.includes(word), word);
});
