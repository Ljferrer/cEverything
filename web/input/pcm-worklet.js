// AudioWorkletProcessor (PROTOCOL.md §1 input/pcm-worklet.js): downsample the mic input (any AudioContext rate) to
// 16 kHz mono, convert to PCM16 LE, and post 100 ms frames (1600 samples = 3200 bytes) plus their RMS through
// this.port.postMessage({ pcm: ArrayBuffer, rms, samples, sampleRate }). voice.js base64-encodes the frames into
// `audio.chunk` commands. Runs inside the AudioWorkletGlobalScope: no imports, no DOM, `sampleRate` is a global.
//
// Resampling is a box filter (average of the ~ratio input samples that map onto each output sample): cheap, and it
// doubles as a crude anti-alias filter, which is plenty for speech-to-text. Messages accepted on the port:
//   { type: 'enable', value: boolean }  gate frame emission (the graph stays connected between utterances)
//   { type: 'flush' }                    emit the partial frame now (sent by voice.js on audio.stop)
//   { type: 'reset' }                    drop buffered samples

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz

if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor === 'function') {
  class PCMWorklet extends AudioWorkletProcessor {
    constructor() {
      super();
      this.inRate = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : 48000;
      this.ratio = this.inRate / TARGET_RATE;
      this.pos = 0;                          // fractional read position into `carry + block` (input samples)
      this.carry = new Float32Array(0);      // input tail kept for the next block
      this.frame = new Int16Array(FRAME_SAMPLES);
      this.fill = 0;
      this.sumSq = 0;
      this.enabled = true;
      this.port.onmessage = (e) => {
        const m = e && e.data ? e.data : {};
        if (m.type === 'enable') { this.enabled = Boolean(m.value); if (!this.enabled) this.flush(true); }
        else if (m.type === 'flush') this.flush(true);
        else if (m.type === 'reset') { this.fill = 0; this.sumSq = 0; this.carry = new Float32Array(0); this.pos = 0; }
      };
    }

    /** Emit the current frame (full frames always; partial ones only when forced). */
    flush(force) {
      if (this.fill === 0) return;
      if (!force && this.fill < FRAME_SAMPLES) return;
      const n = this.fill;
      const out = new Int16Array(n);
      out.set(this.frame.subarray(0, n));
      const rms = Math.sqrt(this.sumSq / n);
      this.port.postMessage({ pcm: out.buffer, rms, samples: n, sampleRate: TARGET_RATE }, [out.buffer]);
      this.fill = 0; this.sumSq = 0;
    }

    push(sample) {
      const v = sample > 1 ? 1 : sample < -1 ? -1 : sample;
      this.frame[this.fill++] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
      this.sumSq += v * v;
      if (this.fill >= FRAME_SAMPLES) this.flush(false);
    }

    process(inputs) {
      const input = inputs && inputs[0];
      const ch0 = input && input[0];
      if (!ch0 || !this.enabled) return true;
      // mono mixdown when the mic delivers several channels
      let mono = ch0;
      if (input.length > 1) {
        mono = new Float32Array(ch0.length);
        for (let c = 0; c < input.length; c++) { const d = input[c]; for (let i = 0; i < d.length; i++) mono[i] += d[i] / input.length; }
      }
      const buf = new Float32Array(this.carry.length + mono.length);
      buf.set(this.carry, 0); buf.set(mono, this.carry.length);
      let pos = this.pos;
      const ratio = this.ratio;
      // each output sample = mean of the input samples in [pos, pos + ratio)
      while (pos + ratio <= buf.length) {
        const a = Math.floor(pos); const b = Math.max(a + 1, Math.floor(pos + ratio));
        let sum = 0; for (let i = a; i < b; i++) sum += buf[i];
        this.push(sum / (b - a));
        pos += ratio;
      }
      const keepFrom = Math.min(buf.length, Math.floor(pos));
      this.carry = buf.slice(keepFrom);
      this.pos = pos - keepFrom;
      return true;
    }
  }
  registerProcessor('pcm-worklet', PCMWorklet);
}
