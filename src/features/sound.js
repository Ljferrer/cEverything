// Room sounds: a short synthesized cue for every action, in the spirit of a
// fantasy MMO interface (bright chimes, soft whooshes, a low gong). Every sound
// is built here from Web Audio oscillators, filtered noise and envelopes; no
// sound file is loaded.
//
// Bus surface (read only): `select`, `miss`, `session` (a new sid), `state`
// (a change to waiting), `tool` (start pitch per pylon, complete), `talk`
// (voice.js phases), relay `error`. Outgoing commands have no bus event, so
// this feature wraps `net.send` and voices `fork`, `pipe` and `say` after the
// frame is sent unchanged; `voice` stays silent because voice.js emits
// `talk sent` right after it.
//
// Browsers block audio until a user gesture, so the AudioContext is created or
// resumed on the first pointerdown, keydown or click (the VRButton click
// included). Ambient cues (new sessions, waiting, tools) pass a token bucket,
// so a replay burst plays at most a few sounds per second. The M key and a
// small speaker button under the laptop mode label toggle mute.
//
// A sound file can override any cue: install fetches /sfx/<name>.ogg, else
// /sfx/<name>.mp3, for each name in SFX_CUES (Vite serves public/sfx/ there).
// A file that loads and decodes plays for its cue; any other cue uses the synth.
import { pylonFor } from '../pylon-map.js';

const MASTER_GAIN = 0.22;
const AMBIENT_RATE = 3; // tokens per second
const AMBIENT_BURST = 3;
const MUTE_KEY = 'obelisks.muted';

/** Tool start pitch per pylon (Hz): C5, E5, G5, A4, one pentatonic chord so a run of tools stays consonant. */
export const PYLON_PITCH = Object.freeze({ shell: 523.25, filesystem: 659.25, browser: 783.99, other: 440 });

/** The tool start pitch for a tool name. */
export function pitchFor(name) {
  return PYLON_PITCH[pylonFor(name)];
}

/** Cues a burst of relay frames can produce; they pass the rate limiter. User actions always play. */
export function isAmbient(cue) {
  return cue === 'spawn' || cue === 'waiting' || cue.startsWith('tool:') || cue.startsWith('done:');
}

/**
 * The event-to-cue mapping. `map(type, detail)` returns a cue name or null.
 * It remembers seen sids (a reconnect's resent sessions stay silent) and each
 * sid's last status (only a change to waiting chimes). `type` is a bus event
 * name, or `command` for an outgoing client frame.
 */
export function createMapper() {
  const status = new Map();
  const toWaiting = (sid, next) => {
    const prev = status.get(sid);
    status.set(sid, next);
    return next === 'waiting' && prev !== 'waiting' ? 'waiting' : null;
  };
  return function map(type, d = {}) {
    switch (type) {
      case 'select':
        return d.kind === 'slab' ? 'slab' : 'select';
      case 'miss':
        return 'miss';
      case 'session':
        if (!status.has(d.sid)) {
          status.set(d.sid, d.status);
          return 'spawn';
        }
        return toWaiting(d.sid, d.status);
      case 'state':
        return toWaiting(d.sid, d.status);
      case 'tool':
        if (d.phase === 'start') return `tool:${pylonFor(d.name)}`;
        if (d.phase === 'complete') return `done:${pylonFor(d.name)}`;
        return null;
      case 'talk':
        return { start: 'talkStart', sent: 'talkSent', dropped: 'dropped', error: 'error' }[d.phase] ?? null;
      case 'error':
        return 'error';
      case 'command':
        return d.t === 'fork' || d.t === 'pipe' || d.t === 'say' ? d.t : null;
      default:
        return null;
    }
  };
}

/** A token bucket: `take(nowMs)` is true while tokens remain; they refill at `rate` per second up to `burst`. */
export function createLimiter({ rate = AMBIENT_RATE, burst = AMBIENT_BURST } = {}) {
  let tokens = burst;
  let last = null;
  return {
    take(now) {
      if (last !== null) tokens = Math.min(burst, tokens + ((now - last) * rate) / 1000);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

/** Every override file name under /sfx/, without its extension. */
export const SFX_CUES = Object.freeze([
  'select', 'slab', 'miss', 'spawn', 'waiting',
  'tool-browser', 'tool-filesystem', 'tool-shell', 'tool-other', 'tool-complete',
  'fork', 'pipe', 'say', 'voice-start', 'voice-sent', 'voice-dropped', 'error',
]);
export const SFX_EXTS = Object.freeze(['ogg', 'mp3']);
const FILE_NAMES = { talkStart: 'voice-start', talkSent: 'voice-sent', dropped: 'voice-dropped' };

/** The override file name for a cue: `tool:shell` -> `tool-shell`, every `done:*` -> `tool-complete`. */
export function fileFor(cue) {
  const [name, pylon] = cue.split(':');
  if (name === 'tool') return `tool-${pylon}`;
  if (name === 'done') return 'tool-complete';
  return FILE_NAMES[name] ?? name;
}

/**
 * Try /sfx/<name>.ogg, then .mp3: the first that fetches as non-HTML and
 * decodes wins. Resolves the decoded buffer, or null for the synth. Vite's dev
 * server answers a missing file with index.html and status 200, so HTML is a miss.
 */
export async function loadSfx(name, { fetchImpl = globalThis.fetch, decode }) {
  for (const ext of SFX_EXTS) {
    try {
      const res = await fetchImpl(`/sfx/${name}.${ext}`);
      if (!res.ok || /text\/html/.test(res.headers.get('content-type') ?? '')) continue;
      return await decode(await res.arrayBuffer());
    } catch {}
  }
  return null;
}

/** Replace `net.send` with one that sends first, then reports the command; a throw in `onCommand` never reaches the caller. */
export function wrapSend(net, onCommand) {
  const send = net.send;
  net.send = function (cmd) {
    const result = send.call(this, cmd);
    try {
      onCommand(cmd);
    } catch (err) {
      console.error('[sound]', err);
    }
    return result;
  };
}

export function install({ bus, net }) {
  const map = createMapper();
  const limiter = createLimiter();
  let ac = null;
  let out = null;
  let noise = null;
  let muted = readMuted();

  // Override files: fetch now, decode once the first gesture creates the AudioContext.
  let audioReady;
  const acReady = new Promise((resolve) => (audioReady = resolve));
  const decode = (buf) => acReady.then((ctx) => ctx.decodeAudioData(buf));
  /** @type {Map<string, AudioBuffer>} file name -> decoded override */
  const sfx = new Map();
  for (const name of SFX_CUES) loadSfx(name, { decode }).then((buf) => buf && sfx.set(name, buf));

  const play = (cue) => {
    if (!cue || muted || ac?.state !== 'running') return;
    if (isAmbient(cue) && !limiter.take(performance.now())) return;
    const t = ac.currentTime + 0.01;
    const file = sfx.get(fileFor(cue));
    if (file) {
      const src = ac.createBufferSource();
      src.buffer = file;
      src.connect(out);
      src.start(t);
      return;
    }
    const [name, pylon] = cue.split(':');
    RECIPES[name]?.(synth, t, pylon);
  };
  // A frame timeline.js re-emits to rebuild the room plays nothing.
  const on = (type) => bus.addEventListener(type, (e) => !e.detail?.replayed && play(map(type, e.detail)));
  for (const type of ['select', 'miss', 'session', 'state', 'tool', 'talk', 'error']) on(type);
  if (net?.send) wrapSend(net, (cmd) => play(map('command', cmd)));

  const synth = {
    tone(t, freq, { type = 'sine', dur = 0.25, attack = 0.005, gain = 0.3, glide = null, detune = 0 } = {}) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.detune.value = detune;
      o.frequency.setValueAtTime(freq, t);
      if (glide) o.frequency.exponentialRampToValueAtTime(glide, t + dur);
      envelope(g.gain, t, attack, dur, gain);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + dur + 0.05);
    },
    whoosh(t, from, to, { dur = 0.35, gain = 0.35 } = {}) {
      const src = ac.createBufferSource();
      src.buffer = noise;
      const f = ac.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 1.2;
      f.frequency.setValueAtTime(from, t);
      f.frequency.exponentialRampToValueAtTime(to, t + dur);
      const g = ac.createGain();
      envelope(g.gain, t, dur * 0.4, dur, gain);
      src.connect(f).connect(g).connect(out);
      src.start(t);
      src.stop(t + dur + 0.05);
    },
  };

  const unlock = () => {
    if (!ac) {
      const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AC) return;
      ac = new AC();
      const master = ac.createGain();
      master.gain.value = MASTER_GAIN;
      out = master;
      master.connect(ac.createDynamicsCompressor()).connect(ac.destination);
      noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      audioReady(ac);
    }
    if (ac.state === 'suspended') ac.resume();
  };
  for (const type of ['pointerdown', 'keydown', 'click']) document.addEventListener(type, unlock, true);

  const button = document.createElement('button');
  button.id = 'sound-button';
  button.type = 'button';
  button.title = 'Sound (M)';
  Object.assign(button.style, {
    position: 'fixed',
    top: '52px',
    left: '12px',
    padding: '4px 8px',
    background: 'rgba(0,0,0,.7)',
    border: '1px solid #444',
    borderRadius: '6px',
    color: '#ddd',
    font: '15px/1.2 system-ui, sans-serif',
    cursor: 'pointer',
    zIndex: '10',
  });
  const setMuted = (next) => {
    muted = next;
    button.textContent = muted ? '🔇' : '🔊';
    button.setAttribute('aria-pressed', String(muted));
    try {
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {}
    if (!muted) play('select');
  };
  setMuted(muted);
  button.addEventListener('click', () => setMuted(!muted));
  document.body.appendChild(button);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'm' && e.key !== 'M') return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '')) return;
    setMuted(!muted);
  });
}

function readMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Exponential attack to `peak`, then decay to silence at `t + dur`. */
function envelope(param, t, attack, dur, peak) {
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(0.0001, t + dur);
}

/** An inharmonic struck bell or gong: partial ratios over a fundamental, each decaying on its own. */
function strike(s, t, freq, { dur, gain, ratios }) {
  ratios.forEach((r, i) => s.tone(t, freq * r, { dur: dur / (1 + i * 0.6), gain: gain / (1 + i), attack: 0.003 }));
}

/** Cue name -> recipe(synth, startTime, pylon). */
const RECIPES = {
  // A bright two-note "ting" for picking an obelisk.
  select(s, t) {
    s.tone(t, 1318.5, { type: 'triangle', dur: 0.18, gain: 0.25 });
    s.tone(t + 0.06, 1975.5, { dur: 0.22, gain: 0.18 });
  },
  // A single soft pluck for picking a slab.
  slab(s, t) {
    s.tone(t, 1046.5, { type: 'triangle', dur: 0.14, gain: 0.22 });
  },
  // A low muted thump for a click on nothing.
  miss(s, t) {
    s.tone(t, 220, { dur: 0.09, gain: 0.2, glide: 130 });
  },
  // A rising arpeggio with shimmer when a new obelisk appears.
  spawn(s, t) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      s.tone(t + i * 0.07, f, { dur: 0.5, gain: 0.18 });
      s.tone(t + i * 0.07, f * 2, { dur: 0.3, gain: 0.05, detune: 6 });
    });
  },
  // A two-strike bell when a session waits for its user.
  waiting(s, t) {
    strike(s, t, 783.99, { dur: 0.9, gain: 0.2, ratios: [1, 2.76, 5.4] });
    strike(s, t + 0.22, 1046.5, { dur: 1.1, gain: 0.18, ratios: [1, 2.76, 5.4] });
  },
  // A short plucked note at the pylon's pitch.
  tool(s, t, pylon) {
    const f = PYLON_PITCH[pylon] ?? PYLON_PITCH.other;
    s.tone(t, f, { type: 'triangle', dur: 0.2, gain: 0.2 });
    s.tone(t, f * 2, { dur: 0.1, gain: 0.06 });
  },
  // A quiet high tick a fifth above the pylon's pitch.
  done(s, t, pylon) {
    const f = (PYLON_PITCH[pylon] ?? PYLON_PITCH.other) * 1.5;
    s.tone(t, f * 2, { dur: 0.08, gain: 0.1 });
  },
  // A rising whoosh that blooms into a chime: the session splits.
  fork(s, t) {
    s.whoosh(t, 400, 3200, { dur: 0.35 });
    s.tone(t + 0.28, 1568, { dur: 0.4, gain: 0.16 });
    s.tone(t + 0.34, 2093, { dur: 0.4, gain: 0.12 });
  },
  // A falling whoosh that lands with a soft pluck: the slab travels.
  pipe(s, t) {
    s.whoosh(t, 2800, 500, { dur: 0.4 });
    s.tone(t + 0.36, 659.25, { type: 'triangle', dur: 0.2, gain: 0.18 });
  },
  // Two quick notes up for a sent message.
  say(s, t) {
    s.tone(t, 783.99, { dur: 0.12, gain: 0.18 });
    s.tone(t + 0.08, 1046.5, { dur: 0.2, gain: 0.18 });
  },
  // A soft rising glide when recording starts.
  talkStart(s, t) {
    s.tone(t, 440, { dur: 0.16, gain: 0.16, glide: 660 });
  },
  // A short whoosh and the message chime when a recording ships.
  talkSent(s, t) {
    s.whoosh(t, 800, 2400, { dur: 0.2, gain: 0.2 });
    RECIPES.say(s, t + 0.1);
  },
  // Two soft notes down when a recording is dropped.
  dropped(s, t) {
    s.tone(t, 659.25, { dur: 0.12, gain: 0.14 });
    s.tone(t + 0.09, 440, { dur: 0.2, gain: 0.14 });
  },
  // A low gong for a relay or voice error.
  error(s, t) {
    strike(s, t, 98, { dur: 1.8, gain: 0.45, ratios: [1, 2.02, 2.76, 4.1] });
    s.tone(t, 98, { dur: 1.6, gain: 0.2, detune: 9 });
  },
};
