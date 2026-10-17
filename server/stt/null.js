// Null STT engine: no key configured. Every utterance immediately reports voice.unavailable.

export function createNullEngine(opts = {}) {
  const reason = opts.reason || 'no ASSEMBLYAI_API_KEY';
  return {
    name: 'none',
    reason,
    available: false,
    /** createUtterance({ clientId, sessionId, onTranscript, onError, onUnavailable }) → { push, stop, close } */
    createUtterance(handlers = {}) {
      queueMicrotask(() => { if (typeof handlers.onUnavailable === 'function') handlers.onUnavailable(reason); });
      return {
        push() { /* dropped */ },
        stop() { if (typeof handlers.onDone === 'function') handlers.onDone(); },
        close() { /* nothing to close */ },
      };
    },
    close() { /* nothing */ },
  };
}

export default { createNullEngine };
