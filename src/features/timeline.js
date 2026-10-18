// A scrubbable timeline for the laptop view: it records every server frame the
// page receives, in arrival order, and a slider along the bottom rebuilds the
// room as it stood at any recorded frame. Scrubbing to frame k resets the room
// (room.js `reset`, which keeps the slot map) and re-emits frames 0..k on the
// bus with `replayed: true`, so room.js, obelisk.js and state.js rebuild that
// moment while pylons.js and sound.js stay quiet. While scrubbed back,
// `bus.scrubbed` is true: live frames keep recording, and room.js and
// pylons.js ignore them. LIVE re-renders up to the newest frame and resumes.
// Installs only where laptop.js installs (`shouldInstallLaptop`).
import { shouldInstallLaptop } from '../input.js';

/** The server frames the timeline records and replays. */
export const FRAME_TYPES = Object.freeze(['session', 'slab', 'delta', 'state', 'tool']);

/** A log entry's time: the frame's own `ts` if it has one, else its arrival time. */
export const timeOf = (entry) => entry.frame?.ts ?? entry.at;

/**
 * The timeline core, DOM free. Records each `FRAME_TYPES` bus event that is not
 * itself `replayed` as `{type, frame, at}`. `scrubTo(k)` shows frame k (the
 * newest frame means live); `goLive()` catches up; `stop()` stops recording.
 * `reset` clears the room before each rebuild; `now` stamps arrival times.
 */
export function createTimeline(bus, { reset = () => {}, now = Date.now } = {}) {
  const log = [];
  let shownAt = null; // index of the frame shown while scrubbed back, else null (live)
  const record = (e) => {
    if (!e.detail?.replayed) log.push({ type: e.type, frame: e.detail, at: now() });
  };
  for (const type of FRAME_TYPES) bus.addEventListener(type, record);

  const show = (k) => {
    reset();
    for (let i = 0; i <= k; i++) bus.emit(log[i].type, { ...log[i].frame, replayed: true });
  };

  const timeline = {
    log,
    /** The index of the frame on show: the scrubbed one, else the newest. */
    get index() {
      return shownAt ?? log.length - 1;
    },
    get live() {
      return shownAt === null;
    },
    scrubTo(k) {
      if (!log.length) return;
      k = Math.max(0, Math.min(log.length - 1, Math.round(k)));
      if (k === log.length - 1) return timeline.goLive();
      shownAt = k;
      bus.scrubbed = true;
      show(k);
    },
    goLive() {
      if (shownAt === null) return;
      shownAt = null;
      bus.scrubbed = false;
      show(log.length - 1);
    },
    stop() {
      for (const type of FRAME_TYPES) bus.removeEventListener(type, record);
    },
  };
  return timeline;
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
      #timeline.live button { color: #ff5544; border-color: #ff5544; }
    </style>
    <input type="range" min="0" max="0" value="0" step="1" aria-label="Timeline">
    <span class="time"></span>
    <button type="button">LIVE</button>`;
  document.body.appendChild(ui);
  const slider = ui.querySelector('input');
  const time = ui.querySelector('.time');

  const render = () => {
    const n = timeline.log.length;
    const k = timeline.index;
    slider.max = String(Math.max(0, n - 1));
    if (pending === null) slider.value = String(Math.max(0, k)); // never yank the thumb mid-drag
    ui.classList.toggle('live', timeline.live);
    time.textContent = n ? `${clock(timeOf(timeline.log[k]))} · ${k + 1}/${n}` : 'no frames';
  };

  // One rebuild per animation frame, however fast the slider moves.
  let pending = null;
  slider.addEventListener('input', () => {
    pending = Number(slider.value);
    requestAnimationFrame(() => {
      if (pending === null) return;
      timeline.scrubTo(pending);
      pending = null;
      render();
    });
  });
  ui.querySelector('button').addEventListener('click', () => {
    pending = null;
    timeline.goLive();
    render();
  });
  for (const type of FRAME_TYPES) bus.addEventListener(type, (e) => !e.detail?.replayed && render());
  render();
}
