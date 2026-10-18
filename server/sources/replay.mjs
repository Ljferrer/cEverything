// The replay source (PIN-5, PIN-32): plays a `--record` JSONL once under
// `mode:'replay'`. The leading `{t:'mode', mode:'replay'}` is the relay's
// mode-update signal (the relay composes the outbound frame with `canEdit`,
// A8); recorded `mode` frames are dropped. Lines are bare frames or
// `{ts, frame}`. Pacing: 10 ms per frame with `--fast`; otherwise a `{ts,
// frame}` line sleeps the delta from the previous such line's `ts`, a bare line
// sleeps the delta between successive `slab` `ts` values, both clamped to 5 s,
// or 300 ms when the frame carries no `ts`. `--speed <x>` (or
// `OBELISKS_REPLAY_SPEED`) divides every non-fast gap by x; `--fast` wins.
// `--loop` plays the file again from the top without re-sending a `session`
// frame for a sid already sent. Read-only: no `sendCommand`.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAST_GAP_MS = 10;
export const DEFAULT_GAP_MS = 300;
export const MAX_GAP_MS = 5000;
export const DEFAULT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'recording.jsonl');

let timer = null;
let running = false;
/** sid → title from the last `session` frame played. */
const titles = new Map();
/** sid → Map<slab id, text>, deltas appended. */
const slabs = new Map();

/** `--replay <file>` from argv, else `env.OBELISKS_REPLAY`, else the default recording. */
export function fileFrom(argv, env) {
  const i = argv.indexOf('--replay');
  const flag = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--replay='))?.slice(9);
  if (flag) return path.resolve(flag);
  if (env.OBELISKS_REPLAY) return path.resolve(env.OBELISKS_REPLAY);
  return DEFAULT_FILE;
}

/** `--speed <x>` / `--speed=<x>`, else `env.OBELISKS_REPLAY_SPEED`; a value that is not a positive number logs and yields 1. */
export function speedFrom(argv, env, log = () => {}) {
  const i = argv.indexOf('--speed');
  const raw = i >= 0 ? argv[i + 1] ?? '' : argv.find((a) => a.startsWith('--speed='))?.slice(8) ?? env.OBELISKS_REPLAY_SPEED;
  if (raw === undefined) return 1;
  const speed = Number(raw);
  if (Number.isFinite(speed) && speed > 0) return speed;
  log(`ignored replay speed ${JSON.stringify(raw)}, using 1`);
  return 1;
}

const tsOf = (v) => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN);
const clamp = (ms) => Math.min(MAX_GAP_MS, Math.max(0, ms));

/** Parse the recording into `{frame, lineTs}` entries (lineTs only for `{ts, frame}` lines), recorded `mode` frames dropped. */
export function parseRecording(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    const wrapped = obj && typeof obj === 'object' && obj.frame && typeof obj.frame === 'object' && obj.ts !== undefined;
    const frame = wrapped ? obj.frame : obj;
    if (!frame || typeof frame !== 'object' || frame.t === 'mode') continue;
    out.push({ frame, lineTs: wrapped ? tsOf(obj.ts) : NaN });
  }
  return out;
}

/** The sleep before each entry, per PIN-32, divided by `speed` unless `fast`. */
export function gaps(entries, fast, speed = 1) {
  let prevLine = NaN;
  let prevSlab = NaN;
  const paced = entries.map(({ frame, lineTs }) => {
    if (!Number.isNaN(lineTs)) {
      const gap = Number.isNaN(prevLine) ? 0 : clamp(lineTs - prevLine);
      prevLine = lineTs;
      return gap;
    }
    const ts = frame.t === 'slab' ? tsOf(frame.ts) : NaN;
    if (!Number.isNaN(ts)) {
      const gap = Number.isNaN(prevSlab) ? 0 : clamp(ts - prevSlab);
      prevSlab = ts;
      return gap;
    }
    return DEFAULT_GAP_MS;
  });
  return fast ? paced.map(() => FAST_GAP_MS) : paced.map((ms) => ms / speed);
}

function remember(frame) {
  if (frame.t === 'session') titles.set(frame.sid, frame.title);
  else if (frame.t === 'slab') {
    let m = slabs.get(frame.sid);
    if (!m) slabs.set(frame.sid, (m = new Map()));
    m.set(frame.id, frame.text);
  } else if (frame.t === 'delta') {
    const m = slabs.get(frame.sid);
    if (m?.has(frame.id)) m.set(frame.id, m.get(frame.id) + frame.text);
  }
}

export function titleOf(sid) {
  return titles.get(sid) ?? '';
}

export function slabText(sid, id) {
  return slabs.get(sid)?.get(id) ?? '';
}

export function stop() {
  running = false;
  clearTimeout(timer);
  timer = null;
}

/** Read the recording, emit the replay mode signal, and play the frames in the background, once or with `--loop` forever. */
export async function start({ emit, argv = process.argv, env = process.env, log = (...a) => console.error('[replay]', ...a) } = {}) {
  stop();
  const file = fileFrom(argv, env);
  const entries = parseRecording(await readFile(file, 'utf8'));
  const fast = argv.includes('--fast');
  const loop = argv.includes('--loop');
  const speed = speedFrom(argv, env, log);
  log(fast ? `speed: --fast (${FAST_GAP_MS} ms per frame)` : `speed: ${speed}x`, loop ? 'looping' : 'once');
  const delays = gaps(entries, fast, speed);
  const sent = new Set();
  let looped = false;
  titles.clear();
  slabs.clear();
  running = true;
  emit({ t: 'mode', mode: 'replay' });
  let i = 0;
  const tick = () => {
    if (!running) return;
    const { frame } = entries[i];
    i += 1;
    if (!(looped && frame.t === 'session' && sent.has(frame.sid))) {
      if (frame.t === 'session') sent.add(frame.sid);
      remember(frame);
      emit(frame);
    }
    if (i >= entries.length && loop) {
      i = 0;
      looped = true;
    }
    if (i < entries.length) timer = setTimeout(tick, delays[i]);
    else stop();
  };
  if (entries.length) timer = setTimeout(tick, delays[0]);
  else running = false;
}
