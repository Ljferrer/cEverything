// Voice input (PROTOCOL.md §1 input/voice.js, §6 push-to-talk; DESIGN.md "Voice plan"). Engine selection: browser Web
// Speech when the page has SpeechRecognition and hello.voice.engine is "none"; the server engine (getUserMedia →
// AudioWorklet pcm16 16 kHz → audio.start/chunk/stop) when hello says "assemblyai"; otherwise "none" → "voice via laptop".
// The mic is requested on the 2D page BEFORE entering XR (probe() from the ENTER handler) and the stream is kept alive.
// Transcript frames paint a pending dashed tile on the target column with the partial text; the final one starts a 2 s
// countdown and then `send {via:'voice'}` — any select/click cancels; a 2 s timeout clears a stuck mic. Desktop Web
// Speech results are relayed as `voice.text` so every client sees the live transcript. `?voice=webspeech|server|none`
// forces an engine (optional, for rehearsals).

import * as THREE from 'three';
import { makeCanvas, makeTexture, sharedPlaneGeometry, font, wrapText, roundRect } from '../text/canvas-text.js';
import { TILE } from '../scene/tiles.js';

export const COUNTDOWN_MS = 2000;
export const STUCK_MS = 2000;
export const PENDING_POOL = 4;
export const REMOTE_LINGER_MS = 2500;
export const RELAY_INTERVAL_MS = 200;

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition || null) : null;

/** Pure engine choice (exported for tests). */
export function pickEngine({ serverEngine = 'none', hasWebSpeech = false, unavailable = false, force = null } = {}) {
  if (force === 'none' || force === 'webspeech' || force === 'server') {
    if (force === 'webspeech' && !hasWebSpeech) return 'none';
    return force;
  }
  if (serverEngine === 'assemblyai' && !unavailable) return 'server';
  if (hasWebSpeech) return 'webspeech';
  return 'none';
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const noop = () => {};

export function createVoice({ net, store, actions, flags = {}, hud, app, device, scene, columns } = {}) {
  const forced = (() => { try { return new URLSearchParams(location.search).get('voice'); } catch { return null; } })();
  const isHeadset = device === 'quest' || device === 'visionpro';
  const st = {
    unavailable: false, reason: '', micState: isHeadset ? 'mic: tap ALLOW MIC first' : 'mic: ready', stream: null, ctx: null, node: null, src: null, sink: null, workletReady: null,
    micPromise: null, micResolved: false, activeEngine: null,
    talking: false, target: null, startedAt: 0, rms: 0, stuckTimer: 0, rec: null, lastRelay: 0, own: null, chunks: 0,
  };
  const pending = new Map(); // clientId → entry { clientId, sessionId, text, final, deadline, plane, until, listening }
  const planes = [];         // pooled pending planes (one canvas each)

  function engine() { return pickEngine({ serverEngine: store?.voice?.engine, hasWebSpeech: Boolean(SR), unavailable: st.unavailable, force: forced }); }
  function toast(t, k) { hud?.toast?.(t, k); }
  function log(...a) { console.log('[voice]', ...a); }

  // ---------------------------------------------------------------- pending tiles (dashed gray, partial text, countdown bar)
  function makePlane() {
    const { canvas, ctx } = makeCanvas(512, 128);
    const texture = makeTexture(canvas);
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(sharedPlaneGeometry(), material);
    mesh.scale.set(TILE.w, TILE.h, 1); mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 3; mesh.name = 'voice-pending';
    if (scene) scene.add(mesh);
    const p = { canvas, ctx, texture, material, mesh, busy: false, key: '' };
    planes.push(p);
    return p;
  }
  function takePlane() { return planes.find((p) => !p.busy) || (planes.length < PENDING_POOL ? makePlane() : null); }

  function paintPending(p, e, now) {
    const w = 512; const h = 128; const ctx = p.ctx;
    const progress = e.deadline ? Math.max(0, Math.min(1, (e.deadline - now) / COUNTDOWN_MS)) : null;
    const key = `${e.text}|${e.final}|${e.listening}|${progress === null ? '' : Math.round(progress * 20)}`;
    if (p.key === key) return;
    p.key = key;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(15,23,42,0.85)'; roundRect(ctx, 1, 1, w - 2, h - 2, 14); ctx.fill();
    ctx.save(); ctx.setLineDash(e.final ? [] : [14, 10]); ctx.strokeStyle = e.final ? 'rgba(229,231,235,0.95)' : 'rgba(156,163,175,0.9)'; ctx.lineWidth = 4; roundRect(ctx, 3, 3, w - 6, h - 6, 14); ctx.stroke(); ctx.restore();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillStyle = e.listening && !e.text ? '#ef4444' : '#e5e7eb'; ctx.font = font(48, { weight: 700 });
    ctx.fillText('🎤', 60, h / 2);
    const f = font(34, { weight: 500, italic: !e.final });
    const text = e.text || (e.listening ? 'listening…' : '…');
    const { lines } = wrapText(text, f, w - 118 - 20, 2);
    ctx.font = f; ctx.textAlign = 'left'; ctx.fillStyle = e.text ? '#f3f4f6' : '#9ca3af';
    const lineH = 42; const total = lineH * lines.length; const top = (progress === null ? h / 2 : h / 2 - 8) - total / 2;
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], 118, top + lineH * (i + 0.5));
    if (progress !== null) { ctx.fillStyle = 'rgba(56,189,248,0.25)'; roundRect(ctx, 16, h - 18, w - 32, 10, 5); ctx.fill(); ctx.fillStyle = '#38bdf8'; roundRect(ctx, 16, h - 18, Math.max(10, (w - 32) * progress), 10, 5); ctx.fill(); }
    if (e.who) { ctx.font = font(22, { weight: 600 }); ctx.fillStyle = '#93c5fd'; ctx.textAlign = 'right'; ctx.fillText(e.who, w - 18, 22); }
    p.texture.needsUpdate = true;
  }

  function ensureEntry(clientId, sessionId, who) {
    let e = pending.get(clientId);
    if (e && e.sessionId !== sessionId) { releaseEntry(e); e = null; }
    if (!e) {
      const plane = takePlane();
      if (plane) plane.busy = true;
      e = { clientId, sessionId, text: '', final: false, deadline: 0, plane, until: 0, listening: false, who: who || '', updatedAt: performance.now() };
      pending.set(clientId, e);
    }
    return e;
  }
  function releaseEntry(e) {
    if (!e) return;
    if (e.plane) { e.plane.busy = false; e.plane.mesh.visible = false; e.plane.key = ''; }
    pending.delete(e.clientId);
  }
  function columnFor(sessionId) { return columns?.get?.(sessionId) || null; }

  function placePending(now) {
    for (const e of pending.values()) {
      const col = columnFor(e.sessionId); const p = e.plane;
      if (!p) continue;
      if (!col || col.removed) { p.mesh.visible = false; continue; }
      p.mesh.visible = true;
      p.mesh.position.set(0, col.readingHeight - TILE.pitch, 0.012).applyMatrix4(col.group.matrixWorld);
      p.mesh.quaternion.copy(col.group.quaternion);
      p.material.opacity = e.listening && !e.text ? 0.75 + 0.25 * Math.sin(now * 0.008) : 0.95;
      paintPending(p, e, now);
    }
  }

  // ---------------------------------------------------------------- transcript handling (own + remote)
  /** Apply a transcript (own = this client's utterance). Exported on the voice object so tests/desktop paths can drive it. */
  function onTranscript(text, final, sessionId, own = true, who = '') {
    const sid = sessionId || st.target || actions?.focusedId?.();
    if (!sid) return;
    const clientId = own ? (store?.clientId || 'me') : who || 'remote';
    const e = ensureEntry(clientId, sid, own ? '' : who);
    e.text = String(text || '').trim(); e.final = Boolean(final); e.updatedAt = performance.now();
    if (own) {
      st.own = e;
      e.listening = st.talking;
      if (final) { clearTimeout(st.stuckTimer); st.stuckTimer = 0; beginCountdown(e); }
    } else if (final) e.until = performance.now() + REMOTE_LINGER_MS;
    placePending(performance.now()); // visible this frame, not the next
  }
  function beginCountdown(e) {
    if (!e.text) { releaseEntry(e); if (e === st.own) st.own = null; toast('no speech recognized', 'warn'); return; }
    e.deadline = performance.now() + COUNTDOWN_MS; e.listening = false;
    hud?.setTranscriptLive?.(e.text, true, '');
  }
  function fireSend(e) {
    const sid = e.sessionId; const text = e.text;
    releaseEntry(e); if (e === st.own) st.own = null;
    log(`send via voice → ${sid}: ${text.slice(0, 60)}`);
    return actions?.send?.(sid, text, 'voice');
  }
  /** Cancel the pending own utterance / countdown (any select or click). Returns true when something was cancelled. */
  function cancel(silent = false) {
    const e = st.own; if (!e) return false;
    const hadCountdown = Boolean(e.deadline);
    releaseEntry(e); st.own = null; clearTimeout(st.stuckTimer); st.stuckTimer = 0;
    if (hadCountdown && !silent) toast('voice send cancelled', 'warn');
    hud?.setTranscriptLive?.('', false, '');
    return hadCountdown;
  }

  // ---------------------------------------------------------------- mic + worklet (server engine)
  function micLive() { return Boolean(st.stream && st.stream.getAudioTracks().some((t) => t.readyState === 'live')); }
  /** Whether the next tap on the 2D page must be spent on the mic (headset or server engine, not yet asked). */
  function needsMicGesture() { return (engine() === 'server' || isHeadset) && !st.micResolved && !micLive(); }
  async function requestMic() {
    if (!navigator.mediaDevices?.getUserMedia) { st.micState = 'mic: n/a'; throw new Error('getUserMedia unavailable'); }
    try {
      st.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      st.micState = 'mic: ok';
      for (const t of st.stream.getAudioTracks()) t.addEventListener('ended', () => { st.micState = 'mic: track ended'; log('mic track ended'); if (st.talking) stop(); });
      return st.stream;
    } catch (err) { st.micState = err?.name === 'NotAllowedError' ? 'mic: denied' : `mic: ${err?.name || 'error'}`; throw err; }
  }
  /** One getUserMedia in flight at a time; prime() starts it inside the gesture and probe()/start() join the same promise. */
  function ensureMic() {
    if (micLive()) return Promise.resolve(st.stream);
    if (!st.micPromise) st.micPromise = requestMic().finally(() => { st.micPromise = null; });
    return st.micPromise;
  }
  function makeContext() {
    if (st.ctx) return st.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('AudioContext unavailable');
    st.ctx = new AC({ latencyHint: 'interactive' });
    return st.ctx;
  }
  /**
   * Synchronous half of the mic gesture: Safari only honours AudioContext.resume() and getUserMedia inside the click
   * itself (user activation survives ~1 s across awaits), so main.js calls this at the top of the ENTER handler
   * before any await. Never throws.
   */
  function prime() {
    try { const ctx = makeContext(); if (ctx.state === 'suspended') ctx.resume().catch(noop); } catch (err) { log('prime:', err?.message || err); }
    if (engine() === 'server' || isHeadset) ensureMic().catch(noop);
  }
  async function ensureGraph() {
    makeContext();
    if (st.ctx.state === 'suspended') { try { await st.ctx.resume(); } catch { /* resumed on the next gesture */ } }
    if (!st.workletReady) st.workletReady = st.ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url).href);
    await st.workletReady;
    if (!st.node) {
      st.node = new AudioWorkletNode(st.ctx, 'pcm-worklet', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      st.sink = st.ctx.createGain(); st.sink.gain.value = 0; st.sink.connect(st.ctx.destination);
      st.node.connect(st.sink);
      st.node.port.onmessage = (e) => onPcm(e.data);
      st.node.port.postMessage({ type: 'enable', value: false });
    }
    if (!st.src && st.stream) { st.src = st.ctx.createMediaStreamSource(st.stream); st.src.connect(st.node); }
  }
  function onPcm(m) {
    if (!m || !m.pcm) return;
    st.rms = Number(m.rms) || 0;
    if (!st.talking && !st.flushing) return;
    st.chunks++;
    net?.cmd?.('audio.chunk', { data: b64(new Uint8Array(m.pcm)) }, { timeout: 5000 }).catch(noop);
  }

  /** Request the mic + create the AudioContext inside a user gesture on the 2D page (before XR). Never throws. */
  async function probe() {
    const eng = engine();
    if (eng === 'server' || isHeadset) {
      try { await ensureMic(); await ensureGraph(); } catch (err) { log('probe:', err?.message || err); }
      if (eng === 'none' && st.micState === 'mic: ok') st.micState = isHeadset ? 'mic: ok · voice via laptop' : 'mic: ok';
    } else if (eng === 'webspeech') st.micState = 'mic: web speech';
    else st.micState = 'mic: voice via laptop';
    st.micResolved = true; // granted or denied, the question has been asked: the next tap enters XR
    return st.micState;
  }

  // ---------------------------------------------------------------- start / stop
  function start(sessionId) {
    const sid = sessionId || actions?.focusedId?.() || null;
    if (st.talking) return false;
    const eng = engine();
    cancel(true);
    if (!sid) { toast('look at (or click) a column to talk to it', 'warn'); return false; }
    if (!store?.sessions?.has?.(sid)) { toast('unknown session for voice', 'warn'); return false; }
    st.target = sid;
    if (eng === 'none') { toast(isHeadset ? 'voice via laptop: your teammate holds Space and speaks' : 'no voice engine — type instead', 'warn'); hud?.setVoice?.('none', st.reason || 'voice via laptop'); return false; }
    st.talking = true; st.startedAt = performance.now(); st.chunks = 0; st.rms = 0; st.activeEngine = eng;
    const e = ensureEntry(store?.clientId || 'me', sid, ''); e.text = ''; e.final = false; e.deadline = 0; e.listening = true; st.own = e;
    if (eng === 'server') startServer(sid).catch((err) => { log('server engine failed', err?.message || err); st.talking = false; releaseEntry(e); st.own = null; toast(`mic failed: ${err?.message || err}`, 'bad'); });
    else startWebSpeech(sid);
    return true;
  }

  async function startServer(sid) {
    await ensureMic(); await ensureGraph();
    if (!st.talking) return;
    const r = await net.cmd('audio.start', { sessionId: sid, sampleRate: 16000 });
    if (!st.talking) return;
    if (r && r.engine === 'none') { st.unavailable = true; st.reason = 'server has no STT engine'; stop(); hud?.setVoice?.(engine(), st.reason); toast('server voice unavailable — voice via laptop', 'warn'); return; }
    st.node.port.postMessage({ type: 'reset' }); st.node.port.postMessage({ type: 'enable', value: true });
  }

  function startWebSpeech(sid) {
    let rec;
    try { rec = new SR(); } catch (err) { st.talking = false; toast(`web speech failed: ${err?.message || err}`, 'bad'); return; }
    rec.interimResults = true; rec.continuous = false; rec.lang = 'en-US'; rec.maxAlternatives = 1;
    st.rec = rec;
    rec.onresult = (ev) => {
      let text = ''; let final = false;
      for (let i = 0; i < ev.results.length; i++) { text += (i ? ' ' : '') + ev.results[i][0].transcript; if (ev.results[i].isFinal) final = true; }
      text = text.trim();
      onTranscript(text, final, sid, true);
      const now = performance.now();
      if (final || now - st.lastRelay > RELAY_INTERVAL_MS) { st.lastRelay = now; net?.cmd?.('voice.text', { sessionId: sid, text, final }, { timeout: 5000 }).catch(noop); }
    };
    rec.onerror = (ev) => {
      const code = ev?.error || 'error';
      console.warn('[voice] web speech error:', code);
      if (code === 'not-allowed' || code === 'service-not-allowed') st.micState = 'mic: denied';
      if (code === 'no-speech' || code === 'aborted') return; // onend follows; the stuck timer handles it
      toast(`voice: ${code}`, 'warn');
    };
    rec.onend = () => { st.rec = null; if (st.talking) stop(); };
    try { rec.start(); } catch (err) { console.warn('[voice] web speech start failed', err); st.talking = false; st.rec = null; toast('web speech could not start', 'warn'); }
  }

  function stop() {
    if (!st.talking) return false;
    st.talking = false;
    // branch on the engine this utterance STARTED with: a voice.unavailable frame mid-utterance changes engine() and
    // must not leave the worklet streaming or the server without its audio.stop
    const eng = st.activeEngine || engine();
    st.activeEngine = null;
    const e = st.own;
    if (e) e.listening = false;
    if (eng === 'server') {
      if (st.node) { st.flushing = true; st.node.port.postMessage({ type: 'flush' }); setTimeout(() => { st.flushing = false; }, 50); }
      net?.cmd?.('audio.stop', {}, { timeout: 5000 }).catch(noop);
    } else if (st.rec) { try { st.rec.stop(); } catch { /* already stopped */ } }
    if (st.node) { try { st.node.port.postMessage({ type: 'enable', value: false }); } catch { /* worklet gone */ } } // always
    st.rms = 0;
    clearTimeout(st.stuckTimer);
    st.stuckTimer = setTimeout(() => {
      st.stuckTimer = 0;
      const own = st.own; if (!own || own.deadline) return;
      if (own.text) { log('no final transcript within 2 s — using the partial text'); own.final = true; beginCountdown(own); }
      else { releaseEntry(own); st.own = null; toast('mic timed out (no transcript)', 'warn'); hud?.setTranscriptLive?.('', false, ''); }
    }, STUCK_MS);
    return true;
  }

  // ---------------------------------------------------------------- store wiring
  const offs = [];
  if (store?.on) {
    offs.push(store.on('transcript', (f) => {
      const own = f.clientId === store.clientId;
      if (own && engine() !== 'server') return;                    // our own Web Speech results were applied locally
      if (!own) { const who = store.presence.get(f.clientId)?.name || store.presence.get(f.clientId)?.device || 'teammate'; onTranscript(f.text, f.final, f.sessionId, false, who); return; }
      onTranscript(f.text, f.final, f.sessionId, true);
    }));
    offs.push(store.on('voice.unavailable', (f) => {
      st.unavailable = true; st.reason = f?.reason || 'voice unavailable';
      if (st.talking && engine() !== 'server') { stop(); }
      hud?.setVoice?.(engine(), st.reason);
      if (isHeadset) st.micState = 'mic: voice via laptop';
      log('server voice unavailable:', st.reason);
    }));
    offs.push(store.on('hello', () => { st.unavailable = false; st.reason = ''; hud?.setVoice?.(engine(), engine() === 'none' ? 'voice via laptop' : ''); }));
    offs.push(store.on('message.add', (ev) => {
      // a voice message landing on a session ends any remote ghost tile for it
      if (ev.message?.via !== 'voice') return;
      for (const e of [...pending.values()]) if (e.sessionId === ev.sessionId && e !== st.own) releaseEntry(e);
    }));
  }
  // any click on the 3D canvas cancels a pending send (desktop); XR selects call voice.cancel() from input/xr.js
  const gl = typeof document !== 'undefined' ? document.getElementById('gl') : null;
  const onPointerDown = () => { if (st.own && st.own.deadline) cancel(false); };
  gl?.addEventListener('pointerdown', onPointerDown);

  function update(now) {
    for (const e of [...pending.values()]) {
      if (e.deadline && now >= e.deadline) { fireSend(e); continue; }
      if (e.until && now >= e.until) { releaseEntry(e); continue; }
      if (!e.deadline && !e.until && e !== st.own && now - e.updatedAt > 15000) releaseEntry(e); // stale remote partial
    }
    placePending(now);
  }

  const voice = {
    get engine() { return engine(); },
    get available() { return engine() !== 'none'; },
    get micState() { return st.micState; },
    get rms() { return st.rms; },
    get talking() { return st.talking; },
    get target() { return st.target; },
    get pending() { return st.own ? { sessionId: st.own.sessionId, text: st.own.text, final: st.own.final, countdownMs: st.own.deadline ? Math.max(0, st.own.deadline - performance.now()) : null } : null; },
    get reason() { return st.reason; },
    get micResolved() { return st.micResolved; },
    probe, prime, micLive, needsMicGesture, start, stop, cancel, onTranscript, update,
    stats() { return { engine: engine(), micState: st.micState, micLive: micLive(), talking: st.talking, chunks: st.chunks, pending: pending.size, planes: planes.length, rms: st.rms }; },
    dispose() {
      for (const off of offs) off();
      gl?.removeEventListener('pointerdown', onPointerDown);
      clearTimeout(st.stuckTimer);
      for (const e of [...pending.values()]) releaseEntry(e);
      for (const p of planes) { scene?.remove(p.mesh); p.texture.dispose(); p.material.dispose(); }
      try { st.rec?.abort?.(); } catch { /* ignore */ }
      try { st.src?.disconnect(); st.node?.disconnect(); st.sink?.disconnect(); } catch { /* ignore */ }
      for (const t of st.stream?.getTracks?.() || []) t.stop();
      st.stream = null;
    },
  };
  hud?.setVoice?.(engine(), engine() === 'none' ? 'voice via laptop' : '');
  return voice;
}

export default { createVoice, pickEngine, COUNTDOWN_MS, STUCK_MS };
