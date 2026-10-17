// STT engine selection: ASSEMBLYAI_API_KEY → assemblyai.js, otherwise null.js (voice.unavailable).

import { createAssemblyAIEngine } from './assemblyai.js';
import { createNullEngine } from './null.js';

/**
 * createSTT({ env, log }) → engine { name, available, createUtterance(handlers), close() }
 * Never throws: a broken key/config degrades to the null engine with a reason.
 */
export function createSTT(opts = {}) {
  const env = opts.env || process.env;
  const log = opts.log || (() => {});
  const key = (env.ASSEMBLYAI_API_KEY || '').trim();
  if (!key) {
    log('[stt] no ASSEMBLYAI_API_KEY — headset voice unavailable (laptop Web Speech / keyboard still work)');
    return createNullEngine({ reason: 'no ASSEMBLYAI_API_KEY' });
  }
  try {
    const engine = createAssemblyAIEngine({ apiKey: key, url: env.ASSEMBLYAI_STREAMING_URL || undefined, log });
    log(`[stt] AssemblyAI streaming v3 enabled (${engine.url})`);
    return engine;
  } catch (err) {
    log(`[stt] AssemblyAI engine failed to initialise: ${err.message}`);
    return createNullEngine({ reason: `assemblyai init failed: ${err.message}` });
  }
}

export default { createSTT };
