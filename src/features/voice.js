// Hold-to-talk (plan 5, PIN-8, PIN-15). Hold the select gesture on the already
// selected obelisk to record, release to send: `selectstart` arms a
// MediaRecorder on the mic stream grabbed at the VRButton click, `selectend`
// stops it and ships the blob as a data URL in plan 1's `voice` command. A
// press under 300 ms, or an empty blob, is a plain select and sends nothing
// (PIN-61). Transcription happens in the relay; this file never names the
// token, an STT key, or the transcribe route. Laptop mode has no `selectstart`
// on the bus, so the feature is inert there.
//
// Bus surface: reads `mode` (`canEdit`), `selectstart`, `selectend`, `error`;
// sets `bus.talking` to the sid once a hold passes 300 ms and clears it on
// release (plan 6's fork reads it, PIN-76); dispatches
// `talk {phase:'start'|'sent'|'dropped'|'error', sid, ms}` (PIN-69).
import { Text } from 'troika-three-text';

const HOLD_MS = 300;
const ERROR_WINDOW_MS = 10_000;
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4'];
const GLYPH_TEXT = '● REC';

/** The mic stream, requested once at the VRButton click and kept for the page lifetime (PIN-62). */
let stream = null;
let streamRequested = false;

export function install({ scene, camera, renderer, bus, net }) {
  installMic();

  // Subscribe synchronously: the relay's single `mode` frame can land right
  // after `net` connects, and this install has no await to race it.
  let canEdit = false;
  bus.addEventListener('mode', (e) => (canEdit = e.detail.canEdit === true));

  const glyph = installGlyph({ scene, camera });
  const talk = (phase, sid, ms) => bus.emit('talk', ms == null ? { phase, sid } : { phase, sid, ms });

  /** The running recording, or null. */
  let rec = null;
  /** The open error window after a send, or null. */
  let errorWindow = null;

  bus.addEventListener('selectstart', (e) => {
    const sid = e.detail?.sid ?? null;
    if (sid == null || sid !== bus.selected || !canEdit || rec) return;
    if (!stream) {
      talk('error', sid);
      console.log('voice: no mic stream');
      return;
    }
    closeErrorWindow();
    const chunks = [];
    const chosen = pickMime();
    let recorder;
    let take = null;
    try {
      recorder = new MediaRecorder(stream, chosen ? { mimeType: chosen } : undefined);
      recorder.addEventListener('dataavailable', (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      });
      recorder.addEventListener('stop', () => finish(take));
      recorder.start();
    } catch (err) {
      talk('error', sid);
      console.log('voice: recorder failed', err?.message ?? err);
      return;
    }
    take = rec = {
      sid,
      controller: e.detail?.controller,
      recorder,
      chunks,
      mime: recorder.mimeType || chosen || '',
      startedAt: performance.now(),
      heldMs: 0,
      holdTimer: setTimeout(() => (bus.talking = sid), HOLD_MS),
      recognizer: startRecognizer(glyph),
    };
    glyph.show(GLYPH_TEXT);
    talk('start', sid);
  });

  // Only the input source (controller or hand) that started the take ends it.
  // An inactive recorder still has its `stop` event queued, and that event
  // runs finish, so this listener never calls finish itself.
  bus.addEventListener('selectend', (e) => {
    if (!rec || rec.heldMs || e.detail?.controller !== rec.controller) return;
    rec.heldMs = Math.max(1, Math.round(performance.now() - rec.startedAt));
    release(rec);
    if (rec.finished) rec = null;
    else if (rec.recorder.state !== 'inactive') rec.recorder.stop();
  });

  // Leaving XR sends no `selectend`, so drop any take still held.
  renderer.xr.addEventListener('sessionend', () => {
    const take = rec;
    if (!take || take.heldMs) return;
    rec = null;
    release(take);
    if (take.finished) return;
    take.finished = true;
    if (take.recorder.state !== 'inactive') take.recorder.stop();
    glyph.hide();
    talk('dropped', take.sid, 0);
  });

  // Every end of a take passes here: cancel the pending hold flag, clear
  // `bus.talking`, stop the recognizer. Safe to run twice.
  function release(take) {
    clearTimeout(take.holdTimer);
    bus.talking = null;
    stopRecognizer(take.recognizer);
  }

  // Runs once per take from the recorder's `stop` event, whatever stopped it:
  // drop a short or empty take, else send it and open the error window
  // (PIN-61). A take dropped at `sessionend` is already finished.
  async function finish(take) {
    if (!take || take.finished) return;
    take.finished = true;
    if (!take.heldMs) {
      // A stop with no `selectend` first (recorder error, ended mic track):
      // drop the audio but keep the hold, so `rec`, the hold timer and
      // `bus.talking` stay until the owning `selectend` or `sessionend`.
      // Plan 6's fork and pipe read `bus.talking` on the release `select`.
      stopRecognizer(take.recognizer);
      glyph.hide();
      talk('dropped', take.sid, 0);
      return;
    }
    const { sid, mime, heldMs: ms } = take;
    const blob = new Blob(take.chunks, { type: mime });
    if (ms < HOLD_MS || blob.size === 0) {
      rec = null;
      glyph.hide();
      talk('dropped', sid, ms);
      return;
    }
    let data_url;
    try {
      data_url = await readAsDataUrl(blob);
    } catch (err) {
      rec = null;
      glyph.hide();
      talk('error', sid, ms);
      console.log('voice: blob read failed', err?.message ?? err);
      return;
    }
    net.send({ t: 'voice', sid, mime, data_url });
    rec = null;
    glyph.hide();
    talk('sent', sid, ms);
    openErrorWindow(sid);
  }

  // After a send, the next relay `error` within 10 s is shown in the glyph
  // label and reported as `talk {phase:'error'}`; the glyph clears when the
  // timer fires either way.
  function openErrorWindow(sid) {
    closeErrorWindow();
    const onError = (e) => {
      bus.removeEventListener('error', onError);
      glyph.show(String(e.detail?.text ?? 'error'));
      talk('error', sid);
    };
    bus.addEventListener('error', onError);
    const timer = setTimeout(() => {
      errorWindow = null;
      bus.removeEventListener('error', onError);
      glyph.hide();
    }, ERROR_WINDOW_MS);
    errorWindow = { onError, timer };
  }

  function closeErrorWindow() {
    if (!errorWindow) return;
    clearTimeout(errorWindow.timer);
    bus.removeEventListener('error', errorWindow.onError);
    errorWindow = null;
  }
}

// Mic acquisition (PIN-62). By default a capture-phase `click` listener on
// `document` requests the stream when the click lands on the VRButton that
// plan 1's xr.js appends to `document.body`, so the permission prompt runs
// inside the same user gesture, before `requestSession`. The button is never
// looked up at install time, so installing before xr.js is fine. With
// `?mic=button` the listener is skipped and a fixed `Enable mic` DOM button
// beside the VRButton requests the stream instead (backstop row 2).
function installMic() {
  if (new URLSearchParams(location.search).get('mic') === 'button') {
    const button = document.createElement('button');
    button.id = 'mic-button';
    button.type = 'button';
    button.textContent = 'Enable mic';
    Object.assign(button.style, {
      position: 'fixed',
      bottom: '20px',
      left: 'calc(50% + 100px)',
      padding: '12px 6px',
      border: '1px solid #fff',
      borderRadius: '4px',
      background: 'rgba(0,0,0,0.1)',
      color: '#fff',
      font: 'normal 13px sans-serif',
      textAlign: 'center',
      opacity: '0.5',
      cursor: 'pointer',
      zIndex: '999',
    });
    button.addEventListener('click', () => {
      requestStream().then((ok) => (button.textContent = ok ? 'Mic on' : 'Mic failed'));
    });
    document.body.appendChild(button);
    return;
  }
  document.addEventListener(
    'click',
    (event) => {
      if (event.target?.closest?.('#VRButton')) requestStream();
    },
    true,
  );
}

/** Request the mic once; resolves true when a stream is held. */
async function requestStream() {
  if (stream) return true;
  if (streamRequested) return false;
  streamRequested = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return true;
  } catch (err) {
    streamRequested = false;
    console.log('voice: mic denied', err?.message ?? err);
    return false;
  }
}

/** The recorder mime: the first supported candidate, else `''` for the recorder default (PIN-63). */
function pickMime() {
  if (typeof MediaRecorder?.isTypeSupported !== 'function') return '';
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

// The in-scene `● REC` glyph (PIN-67): a troika label parented to the camera,
// 0.4 m ahead and 0.15 m down, so it rides the headset pose (three updates a
// camera's children from the XR pose). The camera joins the scene when it has
// no parent yet, because three renders only the scene graph. A second label
// under it carries the interim text of the bonus recognizer.
function installGlyph({ scene, camera }) {
  if (!camera.parent) scene.add(camera);

  const label = new Text();
  label.text = '';
  label.fontSize = 0.03;
  label.sdfGlyphSize = 64;
  label.color = 0xff4444;
  label.anchorX = 'center';
  label.anchorY = 'middle';
  label.position.set(0, -0.15, -0.4);
  label.visible = false;
  camera.add(label);

  const interim = new Text();
  interim.text = '';
  interim.fontSize = 0.018;
  interim.sdfGlyphSize = 64;
  interim.color = 0xdddddd;
  interim.anchorX = 'center';
  interim.anchorY = 'top';
  interim.textAlign = 'center';
  interim.maxWidth = 0.5;
  interim.position.set(0, -0.175, -0.4);
  interim.visible = false;
  camera.add(interim);

  return {
    label,
    show(text) {
      label.text = text;
      label.visible = true;
      label.sync();
    },
    hide() {
      label.visible = false;
      interim.visible = false;
      interim.text = '';
    },
    setInterim(text) {
      interim.text = text;
      interim.visible = text.length > 0;
      interim.sync();
    },
  };
}

// Bonus, visionOS only: `webkitSpeechRecognition` interim text under the
// glyph while recording. Quest Browser has no SpeechRecognition, so this is
// never an End state; every failure here is swallowed.
function startRecognizer(glyph) {
  const Recognition = globalThis.webkitSpeechRecognition;
  if (typeof Recognition !== 'function') return null;
  try {
    const recognizer = new Recognition();
    recognizer.interimResults = true;
    recognizer.continuous = true;
    recognizer.onresult = (ev) => {
      let text = '';
      for (const result of ev.results) text += result[0]?.transcript ?? '';
      glyph.setInterim(text.trim());
    };
    recognizer.onerror = () => {};
    recognizer.start();
    return recognizer;
  } catch {
    return null;
  }
}

function stopRecognizer(recognizer) {
  try {
    recognizer?.stop();
  } catch {
    // swallowed: the recognizer is a bonus
  }
}
