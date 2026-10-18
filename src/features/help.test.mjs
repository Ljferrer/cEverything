import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, CONTROLS, CAMERA_STEPS, headsetAddress } from './help.js';
import { viewLink } from '../input.js';

test('the headset address keeps the edit key and drops everything else', () => {
  assert.equal(headsetAddress({ host: 'x.trycloudflare.com', search: '?mode=laptop&key=edit' }), 'x.trycloudflare.com/?key=edit');
  assert.equal(headsetAddress({ host: 'x.trycloudflare.com', search: '' }), 'x.trycloudflare.com/');
  const tunnel = { VITE_SHARE_URL: 'https://y.trycloudflare.com' };
  assert.equal(headsetAddress({ host: 'localhost:5173', search: '?key=edit' }, tunnel), 'y.trycloudflare.com/?key=edit', 'a localhost page shows the tunnel host');
});

test('the help covers entering VR, the mic, and every gesture', () => {
  const text = [...STEPS, ...CONTROLS].join(' ');
  for (const word of ['Quest Browser', 'Enter VR', 'microphone', 'fork', 'pipe', 'speak', 'Meta button']) assert.ok(text.includes(word), word);
});

test('the phone camera section tells you to scan, tap LOOK AROUND, and point to look', () => {
  const text = CAMERA_STEPS.join(' ');
  for (const word of ['Scan', 'phone', 'LOOK AROUND', 'Point']) assert.ok(text.includes(word), word);
});

test('the phone camera QR code carries the shared link, never the edit key', () => {
  assert.equal(viewLink({ search: '?mode=laptop&key=edit&share=https%3A%2F%2Fx.trycloudflare.com', origin: 'http://localhost:5173' }), 'https://x.trycloudflare.com');
  assert.equal(viewLink({ search: '?key=edit', origin: 'http://localhost:5173' }, {}), 'http://localhost:5173');
  const tunnel = { VITE_SHARE_URL: 'https://y.trycloudflare.com' };
  assert.equal(viewLink({ search: '', origin: 'http://localhost:5173' }, tunnel), 'https://y.trycloudflare.com', 'a localhost page shows the tunnel, not localhost');
  assert.equal(viewLink({ search: '?share=https%3A%2F%2Fz.example', origin: 'http://localhost:5173' }, tunnel), 'https://z.example', '?share= still wins');
});
