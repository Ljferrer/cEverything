import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const STUB = new URL('./troika-stub.virtual.mjs', import.meta.url).href;
registerHooks({
  resolve(s, c, n) { return s === 'troika-three-text' ? { url: STUB, shortCircuit: true } : n(s, c); },
  load(u, c, n) { return u === STUB ? { format: 'module', source: "import { Object3D } from 'three'; export class Text extends Object3D { text=''; sync(){} }", shortCircuit: true } : n(u, c); },
});
const { isUnsupportedLabel } = await import('./xr.js');

test('the VR button hides for every no-VR label and stays for ENTER VR', () => {
  for (const t of ['VR NOT SUPPORTED', 'VR NOT ALLOWED', 'WEBXR NOT AVAILABLE']) assert.equal(isUnsupportedLabel(t), true, t);
  for (const t of ['ENTER VR', 'EXIT VR', '']) assert.equal(isUnsupportedLabel(t), false, t);
});
