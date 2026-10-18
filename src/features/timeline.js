// A scrubbable timeline for the laptop view: it records every server frame the
// page receives, in arrival order, and a slider along the bottom rebuilds the
// room as it stood at any recorded frame. Scrubbing to frame k resets the room
// (room.js `reset`, which keeps the slot map) and re-emits frames 0..k on the
// bus with `replayed: true`, so room.js, obelisk.js and state.js rebuild that
// moment while pylons.js and sound.js stay quiet. While scrubbed back,
// `bus.scrubbed` is true: live frames keep recording, and room.js and
// pylons.js ignore them. LIVE re-renders up to the newest frame and resumes.
// Frames replay in the order things happened (`ordered`), every chat
// interleaved by wall time, not in the order the relay sent them.
// Play moves forward from the scrubbed frame at the recorded pace (each gap
// capped at MAX_PLAY_GAP_MS, then divided by the speed slider's SPEEDS step)
// and goes live at the newest frame; Pause holds.
// The relay backfills history as slabs with no `tool` frames, so a Play step
// onto a tool slab with no logged start emits one (`toolStartFor`): the
// pylons fire and the tool sounds play for history too.
// Installs only where laptop.js installs (`shouldInstallLaptop`).
import { shouldInstallLaptop } from '../input.js';

/** The longest wait between two frames during playback, so an idle stretch never stalls it. */
export const MAX_PLAY_GAP_MS = 1000;

/** Playback speeds the speed slider steps through; SPEEDS[DEFAULT_SPEED] is real time. */
export const SPEEDS = Object.freeze([0.25, 0.5, 1, 2, 4, 8, 16]);
export const DEFAULT_SPEED = 2;

/** The server frames the timeline records and replays. */
export const FRAME_TYPES = Object.freeze(['session', 'slab', 'delta', 'state', 'tool']);

/** A log entry's time: when it happened (its `key`, see `ordered`), else its own `ts`, else its arrival time. */
export const timeOf = (entry) => entry.key ?? entry.frame?.ts ?? entry.at;

/**
 * The log in the order things happened, not the order they arrived. The relay
 * backfills history chat by chat, so arrival order plays one chat at a time;
 * this order interleaves every chat by wall time, so simultaneous work plays
 * together. Each entry gets a `key` (ms): a slab's own `ts`; a session just
 * before its first slab; any other frame (delta, state, tool) the key of the
 * frame before it from the same chat, so a tool start follows its tool slab;
 * the arrival time when a chat has no timed frame yet. Ties keep arrival order.
 */
export function ordered(log) {
  const first = new Map(); // sid -> earliest slab ts
  for (const e of log) {
    const { sid, ts } = e.frame ?? {};
    if (sid != null && typeof ts === 'number') first.set(sid, Math.min(first.get(sid) ?? Infinity, ts));
  }
  const last = new Map(); // sid -> key of its latest frame so far, in arrival order
  log.forEach((e, i) => {
    const { sid, ts } = e.frame ?? {};
    if (typeof ts === 'number') e.key = ts;
    else if (e.type === 'session') e.key = first.has(sid) ? first.get(sid) - 1e-3 : e.at;
    else e.key = last.get(sid) ?? first.get(sid) ?? e.at;
    e.seq = i;
    if (sid != null) last.set(sid, e.key);
  });
  return [...log].sort((a, b) => a.key - b.key || a.seq - b.seq);
}

/**
 * The `tool` start a tool slab stands for: both sources write a tool slab as
 * `<name> <args>` under the tool call id. Null for any other frame.
 */
export function toolStartFor(frame) {
  if (frame?.t !== 'slab' || frame.role !== 'tool' || typeof frame.text !== 'string') return null;
  const name = frame.text.split(/\s/, 1)[0];
  return name ? { t: 'tool', sid: frame.sid, id: frame.id, name, phase: 'start' } : null;
}

/**
 * The timeline core, DOM free. Records each `FRAME_TYPES` bus event that is not
 * itself `replayed` as `{type, frame, at}`. `scrubTo(k)` shows frame k (the
 * newest frame means live); `advance()` shows the next frame without a
 * rebuild; `goLive()` catches up; `stop()` stops recording.
 * `reset` clears the room before each rebuild; `now` stamps arrival times.
 */
export function createTimeline(bus, { reset = () => {}, now = Date.now } = {}) {
  const arrived = []; // every frame, in arrival order
  let view = null; // `arrived` in the order things happened, rebuilt on demand after a new frame
  const started = new Set(); // ids of the tool starts in the log
  let shownAt = null; // index of the frame shown while scrubbed back, else null (live)
  const record = (e) => {
    if (e.detail?.replayed) return;
    arrived.push({ type: e.type, frame: e.detail, at: now() });
    view = null;
    if (e.type === 'tool' && e.detail?.phase === 'start') started.add(e.detail.id);
  };
  for (const type of FRAME_TYPES) bus.addEventListener(type, record);
  const log = () => (view ??= ordered(arrived));

  const show = (k) => {
    reset();
    const l = log();
    for (let i = 0; i <= k; i++) bus.emit(l[i].type, { ...l[i].frame, replayed: true });
  };

  const timeline = {
    /** Every recorded frame, in the order things happened (see `ordered`). */
    get log() {
      return log();
    },
    /** How many frames are recorded; cheap, for the live view. */
    get size() {
      return arrived.length;
    },
    /** The latest frame to arrive, the one on show while live. */
    get newest() {
      return arrived.at(-1);
    },
    /** The index of the frame on show: the scrubbed one, else the newest. */
    get index() {
      return shownAt ?? arrived.length - 1;
    },
    get live() {
      return shownAt === null;
    },
    scrubTo(k) {
      if (!arrived.length) return;
      k = Math.max(0, Math.min(arrived.length - 1, Math.round(k)));
      if (k === arrived.length - 1) return timeline.goLive();
      shownAt = k;
      bus.scrubbed = true;
      show(k);
    },
    /** While scrubbed, show frame k + 1 by emitting only that frame; at the newest frame, go live. */
    advance() {
      if (shownAt === null) return;
      if (shownAt + 1 >= arrived.length - 1) return timeline.goLive();
      shownAt += 1;
      // Playback steps one frame at a time, so it animates and sounds like live (`playback`);
      // a rebuild (scrub, LIVE) re-emits frames in bulk and stays silent.
      const { type, frame } = log()[shownAt];
      bus.emit(type, { ...frame, replayed: true, playback: true });
      const start = toolStartFor(frame);
      if (start && !started.has(start.id)) bus.emit('tool', { ...start, replayed: true, playback: true });
    },
    goLive() {
      if (shownAt === null) return;
      shownAt = null;
      bus.scrubbed = false;
      show(arrived.length - 1);
    },
    stop() {
      for (const type of FRAME_TYPES) bus.removeEventListener(type, record);
    },
  };
  return timeline;
}

/**
 * The playback wait after frame k, between 0 and MAX_PLAY_GAP_MS: the time
 * between frame k and frame k + 1 (`timeOf`). The relay backfill lands all
 * history at once, so only the frames' own times keep its pace.
 */
export function playGap(log, k) {
  const a = log[k];
  const b = log[k + 1];
  const gap = a && b ? timeOf(b) - timeOf(a) : 0;
  return Math.max(0, Math.min(MAX_PLAY_GAP_MS, gap));
}

/**
 * Play and pause for a timeline. `play()` advances one frame per `playGap`
 * divided by `speed()`, until the timeline goes live; it does nothing while
 * live. A speed change applies from the next wait. `onTick` runs after each
 * step. The timer functions are injectable for tests.
 */
export function createPlayer(timeline, { onTick = () => {}, speed = () => 1, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  const wait = () => playGap(timeline.log, timeline.index) / speed();
  const tick = () => {
    timeline.advance();
    timer = timeline.live ? null : setTimer(tick, wait());
    onTick();
  };
  return {
    get playing() {
      return timer !== null;
    },
    play() {
      if (timer !== null || timeline.live) return;
      timer = setTimer(tick, wait());
    },
    pause() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false });

// Record before the async install probe, so no frame that lands during it is lost.
export async function install({ bus }) {
  let reset = () => {};
  const timeline = createTimeline(bus, { reset: () => reset() });
  if (!(await shouldInstallLaptop())) return timeline.stop();
  ({ reset } = await import('./room.js'));

  const ui = document.createElement('div');
  ui.id = 'timeline';
  ui.innerHTML = `
    <style>
      #timeline { position: fixed; left: 12px; bottom: 168px; width: min(620px, calc(100vw - 48px)); display: flex; align-items: center; gap: 8px;
        background: rgba(0,0,0,.7); border: 1px solid #444; border-radius: 6px; padding: 6px 8px; font: 12px/1.4 system-ui, sans-serif; color: #ddd; z-index: 5; }
      #timeline input { flex: 1; min-width: 0; accent-color: #ffcc55; }
      #timeline .time { min-width: 116px; text-align: right; font-variant-numeric: tabular-nums; color: #999; }
      #timeline button { background: #222; color: #999; border: 1px solid #666; border-radius: 4px; padding: 2px 10px; font: inherit; font-weight: 700; letter-spacing: .1em; cursor: pointer; }
      #timeline.live .live { color: #ff5544; border-color: #ff5544; }
      #timeline .play { padding: 2px 8px; letter-spacing: 0; }
      #timeline .play:disabled { opacity: .4; cursor: default; }
      #timeline input.speed { flex: 0 0 64px; }
      #timeline .rate { min-width: 34px; color: #999; font-variant-numeric: tabular-nums; }
    </style>
    <button type="button" class="play" aria-label="Play">▶</button>
    <input type="range" class="scrub" min="0" max="0" value="0" step="1" aria-label="Timeline">
    <span class="time"></span>
    <input type="range" class="speed" min="0" max="${SPEEDS.length - 1}" value="${DEFAULT_SPEED}" step="1" aria-label="Playback speed">
    <span class="rate"></span>
    <button type="button" class="live">LIVE</button>`;
  document.body.appendChild(ui);
  const slider = ui.querySelector('.scrub');
  const time = ui.querySelector('.time');
  const playButton = ui.querySelector('.play');
  const speedSlider = ui.querySelector('.speed');
  const rate = ui.querySelector('.rate');
  const speed = () => SPEEDS[Number(speedSlider.value)] ?? 1;
  const showRate = () => (rate.textContent = `${speed()}×`);
  speedSlider.addEventListener('input', showRate);
  showRate();
  const player = createPlayer(timeline, { onTick: () => render(), speed });

  const render = () => {
    const n = timeline.size; // live, the bar never sorts the log; only a scrub or Play does
    const k = timeline.index;
    slider.max = String(Math.max(0, n - 1));
    if (pending === null) slider.value = String(Math.max(0, k)); // never yank the thumb mid-drag
    ui.classList.toggle('live', timeline.live);
    playButton.disabled = timeline.live;
    playButton.textContent = player.playing ? '⏸' : '▶';
    playButton.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
    const entry = timeline.live ? timeline.newest : timeline.log[k];
    time.textContent = n ? `${clock(timeOf(entry))} · ${k + 1}/${n}` : 'no frames';
  };

  // One rebuild per animation frame, however fast the slider moves.
  let pending = null;
  slider.addEventListener('input', () => {
    player.pause();
    pending = Number(slider.value);
    requestAnimationFrame(() => {
      if (pending === null) return;
      timeline.scrubTo(pending);
      pending = null;
      render();
    });
  });
  playButton.addEventListener('click', () => {
    if (player.playing) {
      player.pause();
    } else {
      if (pending !== null) timeline.scrubTo(pending); // a drag still waiting for its frame lands first
      pending = null;
      player.play();
    }
    render();
  });
  ui.querySelector('.live').addEventListener('click', () => {
    player.pause();
    pending = null;
    timeline.goLive();
    render();
  });
  for (const type of FRAME_TYPES) bus.addEventListener(type, (e) => !e.detail?.replayed && render());
  render();
}
