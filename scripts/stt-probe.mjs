#!/usr/bin/env node
// 10-second laptop-only AssemblyAI probe (DESIGN.md "missing from all": decide the voice path in the morning, not at the
// desk). Opens the Streaming v3 WebSocket with ASSEMBLYAI_API_KEY through the same engine the server uses, streams one
// second of 16 kHz PCM16 (silence, or a WAV file you pass), sends Terminate and reports whether the session opened and
// what came back. Exit 0 = the headset voice path can be claimed; exit 1 = run the demo as "voice via laptop".
//
//   node scripts/stt-probe.mjs                 # silence: expects Begin + a clean Termination within ~10 s
//   node scripts/stt-probe.mjs sample.wav      # 16 kHz mono PCM16 WAV: expects a Turn with a transcript

import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv } from '../server/index.js';
import { createSTT } from '../server/stt/index.js';

loadDotEnv();
const file = process.argv[2];
const log = (...a) => console.log('[stt-probe]', ...a);
const stt = createSTT({ env: process.env, log });
if (!stt.available) { log('no engine: set ASSEMBLYAI_API_KEY in .env (or the environment) and retry'); process.exit(1); }
log(`engine ${stt.name} → ${stt.url}`);

let pcm;
if (file) {
  const buf = fs.readFileSync(path.resolve(file));
  const dataIdx = buf.indexOf('data');
  pcm = dataIdx > 0 ? buf.subarray(dataIdx + 8) : buf; // naive WAV: skip to the data chunk (16 kHz mono PCM16 expected)
  log(`streaming ${file}: ${pcm.length} bytes (${(pcm.length / 32000).toFixed(1)} s at 16 kHz)`);
} else {
  pcm = Buffer.alloc(32000); // 1 s of silence
  log('streaming 1 s of silence (pass a 16 kHz mono PCM16 WAV to test a real transcript)');
}

const t0 = Date.now();
const seen = { partials: 0, finals: 0, lastText: '', error: null, done: false };
const utt = stt.createUtterance({
  clientId: 'probe', sessionId: 'probe',
  onTranscript(text, final) { if (final) seen.finals++; else seen.partials++; seen.lastText = text; log(`${final ? 'FINAL' : 'partial'} (+${Date.now() - t0} ms): ${text}`); },
  onError(err) { seen.error = err?.message || String(err); log(`error (+${Date.now() - t0} ms): ${seen.error}`); },
  onUnavailable(reason) { seen.error = `unavailable: ${reason}`; log(seen.error); },
  onDone() { seen.done = true; log(`done (+${Date.now() - t0} ms)`); },
});
for (let off = 0; off < pcm.length; off += 3200) utt.push(pcm.subarray(off, Math.min(pcm.length, off + 3200))); // 100 ms frames
utt.stop();

const deadline = setTimeout(() => {
  log('no answer within 12 s — treat the voice path as unavailable today');
  utt.close(); report(1);
}, 12000);

function report(code) {
  clearTimeout(deadline);
  const ok = !seen.error && seen.done && (file ? seen.finals > 0 : true);
  log(`result: ${ok ? 'OK' : 'FAILED'} · partials ${seen.partials} · finals ${seen.finals} · error ${seen.error || 'none'} · ${Date.now() - t0} ms`);
  log(ok ? 'headset voice path can be claimed (AssemblyAI streaming reachable with this key)' : 'run the demo as "voice via laptop" (Chrome Web Speech) and say so in the narration');
  process.exit(code ?? (ok ? 0 : 1));
}
const poll = setInterval(() => { if (seen.done || seen.error) { clearInterval(poll); report(); } }, 100);
