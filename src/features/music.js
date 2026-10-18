// The opening Halo menu chant loops on its own audio bus. Music volume and
// mute persist separately from the room's sound effects and M-key shortcut.
const VOLUME_KEY = 'obelisks.music.volume';
const MUTE_KEY = 'obelisks.music.muted';
const DEFAULT_VOLUME = 0.15;

export function install() {
  let volume = DEFAULT_VOLUME;
  let muted = false;
  try {
    const saved = localStorage.getItem(VOLUME_KEY);
    const value = Number(saved);
    if (saved !== null && saved.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= 1) volume = value;
    muted = localStorage.getItem(MUTE_KEY) === '1';
  } catch {}

  const controls = document.createElement('div');
  controls.id = 'music-controls';
  controls.innerHTML = `
    <style>
      #music-controls { position: fixed; top: 90px; left: 12px; z-index: 10;
        width: 164px; padding: 8px; border: 1px solid #444; border-radius: 6px;
        background: rgba(0,0,0,.7); color: #ddd; font: 12px/1.4 system-ui, sans-serif; }
      #music-controls .music-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      #music-controls button { padding: 3px 7px; border: 1px solid #666; border-radius: 4px;
        background: #222; color: #eee; font: inherit; cursor: pointer; }
      #music-controls input { display: block; width: 100%; margin: 8px 0 0; accent-color: #ffcc55; }
      #music-controls output { color: #aaa; font-variant-numeric: tabular-nums; }
    </style>
    <div class="music-heading">
      <label for="music-volume">Music <output for="music-volume"></output></label>
      <button id="music-mute" type="button"></button>
    </div>
    <input id="music-volume" type="range" min="0" max="100" step="1" aria-label="Background music volume">
  `;
  const button = controls.querySelector('button');
  const slider = controls.querySelector('input');
  const output = controls.querySelector('output');
  let ac;
  let gain;
  let source;
  let loading = false;
  let failed = false;

  const render = () => {
    slider.value = String(Math.round(volume * 100));
    output.textContent = `${slider.value}%`;
    button.textContent = failed ? 'Retry' : muted ? 'Unmute' : 'Mute';
    button.setAttribute('aria-label', failed ? 'Retry background music' : muted ? 'Unmute background music' : 'Mute background music');
    button.setAttribute('aria-pressed', String(muted));
    button.title = failed ? 'Music could not play. Click to retry.' : 'Mute background music independently of sound effects';
    if (gain) gain.gain.setTargetAtTime(muted ? 0 : volume, ac.currentTime, 0.03);
  };
  const save = () => {
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {}
  };

  // Only called from a user gesture. A pending fetch and an existing loop are
  // reused, so pointerdown + click cannot start overlapping copies.
  const start = async () => {
    if (muted || volume === 0 || failed || loading) return;
    loading = true;
    try {
      if (!ac) {
        const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        if (!AC) throw new Error('Web Audio is unavailable');
        ac = new AC();
        gain = ac.createGain();
        gain.gain.value = muted ? 0 : volume;
        gain.connect(ac.destination);
      }
      if (ac.state !== 'running') await ac.resume();
      if (!source) {
        const res = await fetch('/music/halo-menu-chant.mp3');
        if (!res.ok || /text\/html/.test(res.headers.get('content-type') ?? '')) throw new Error('Music file unavailable');
        const buffer = await ac.decodeAudioData(await res.arrayBuffer());
        source = ac.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(gain);
        source.start();
      }
    } catch {
      failed = true;
      render();
    } finally {
      loading = false;
    }
  };

  slider.addEventListener('input', () => {
    volume = Number(slider.value) / 100;
    save();
    render();
    start();
  });
  button.addEventListener('click', () => {
    if (failed) failed = false;
    else muted = !muted;
    save();
    render();
    start();
  });
  for (const type of ['pointerdown', 'keydown', 'click']) {
    document.addEventListener(type, (e) => {
      // Clicking Mute as the first action must not start the music first.
      if (!controls.contains(e.target)) start();
    }, true);
  }
  render();
  document.body.appendChild(controls);
}
