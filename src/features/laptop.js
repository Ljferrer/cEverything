// Laptop and phone mode (PIN-7): the same bundle with an orbit camera, click
// or tap to select through input.js, a text box that sends `say` to the
// selected obelisk (hidden on a view-only link, PIN-23), a DOM mode label,
// and a corner Share panel with a QR code of the view link (PIN-24). The
// select path publishes the same `select` event and sets `bus.selected` (the
// sid string) and `bus.selectedSlab` exactly as xr.js does, through
// `applySelection`.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import QRCode from 'qrcode';
import { allObelisks, getObelisk } from './room.js';
import { hitToEvent, applySelection, rootOf, shouldInstallLaptop, latchLast } from '../input.js';

export const ERROR_MS = 4000;

/**
 * Where the laptop camera starts: up and out on a diagonal, past the obelisk
 * ring, its child rings, and the pylons, so the first view shows the whole room
 * instead of near-band text from the closest obelisk. main.js's (0, 1.6, 3) sits
 * on the ring; a headset ignores this because its pose drives the camera.
 */
export const LAPTOP_START = Object.freeze([7, 6, 7]);

/** The say box target line shows the selected obelisk's title, else its sid, and follows a later retitle. */
export function showTarget(bus, node, findObelisk) {
  let sid = null;
  const render = (title) => (node.textContent = `to ${title || sid}`);
  bus.addEventListener('select', (e) => {
    sid = e.detail.sid;
    render(findObelisk(sid)?.session?.title);
  });
  bus.addEventListener('session', (e) => e.detail?.sid === sid && render(e.detail.title));
}

/** Each relay `error` frame shows its text in `node` for ERROR_MS, so a failed say, fork or pipe is visible. */
export function showErrors(bus, node) {
  let timer;
  bus.addEventListener('error', (e) => {
    node.textContent = e.detail?.text ?? 'error';
    node.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => (node.hidden = true), ERROR_MS);
  });
}

/** The view link the QR code carries: `?share=<url>` when set, else the bare origin (never the edit key). */
export function viewLink(loc = location) {
  return new URLSearchParams(loc.search).get('share') ?? loc.origin;
}

// Installs on `?mode=laptop`, without `navigator.xr`, or when immersive-vr is
// unsupported (the phone view); see `shouldInstallLaptop` in input.js. The probe
// is async, so main.js runs on and this feature joins once it resolves. The
// relay's single per-connection `mode` frame can land during that wait (net
// connected first), so `latchLast` holds it for the label and the say box.
export async function install({ camera, renderer, bus, net }) {
  const latchedMode = latchLast(bus, 'mode');
  if (!(await shouldInstallLaptop())) return latchedMode.stop();

  camera.position.set(...LAPTOP_START);

  // Orbit camera; OrbitControls handles touch (one finger rotates, two pan and zoom).
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  bus.addEventListener('frame', () => controls.update());

  // Click or tap to select: a pointer that moved under 6 px between down and up.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    down = null;
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const targets = allObelisks().map(rootOf).filter(Boolean);
    applySelection(bus, hitToEvent(raycaster.intersectObjects(targets, true)[0]));
  });

  const ui = el('div', { id: 'laptop-ui' });
  ui.innerHTML = `
    <style>
      #laptop-ui { position: fixed; inset: 0; pointer-events: none; font: 13px/1.4 system-ui, sans-serif; color: #ddd; }
      #laptop-ui > * { pointer-events: auto; position: fixed; background: rgba(0,0,0,.7); border: 1px solid #444; border-radius: 6px; padding: 8px; }
      #mode-label { top: 12px; left: 12px; font-weight: 700; letter-spacing: .1em; color: #ffcc55; }
      #say-box { left: 12px; bottom: 12px; width: min(420px, calc(100vw - 48px)); display: flex; flex-direction: column; gap: 6px; }
      #say-box[hidden] { display: none; }
      #say-box textarea { width: 100%; box-sizing: border-box; min-height: 56px; background: #111; color: #eee; border: 1px solid #555; border-radius: 4px; padding: 6px; font: inherit; resize: vertical; }
      #say-box button { align-self: flex-end; background: #222; color: #eee; border: 1px solid #666; border-radius: 4px; padding: 4px 14px; font: inherit; cursor: pointer; }
      #say-box .target { color: #999; }
      #say-box .error { color: #ff7766; }
      #share-panel { right: 12px; bottom: 12px; text-align: center; }
      #share-panel canvas { display: block; margin: 0 auto 4px; background: #fff; }
      #share-panel .link { max-width: 180px; word-break: break-all; color: #999; font-size: 11px; }
      /* Phone width: a small QR in the top right corner, clear of the bottom-center VR button. */
      @media (width < 600px) {
        #share-panel { top: 12px; bottom: auto; padding: 4px; }
        #share-panel canvas { width: 96px !important; height: 96px !important; image-rendering: pixelated; }
        #share-panel .link { max-width: 96px; font-size: 9px; }
      }
    </style>
    <div id="mode-label"></div>
    <div id="say-box" hidden>
      <div class="target">select an obelisk</div>
      <div class="error" hidden></div>
      <textarea placeholder="say to the selected obelisk"></textarea>
      <button type="button">Send</button>
    </div>
    <div id="share-panel"><canvas></canvas><div class="link"></div></div>`;
  document.body.appendChild(ui);

  // LIVE / REPLAY / SYNTHETIC from the relay's mode event (PIN-5); the box
  // hides while canEdit is false (PIN-23). A frame latched during the install
  // probe is applied once here, then the live listener takes over.
  const modeLabel = ui.querySelector('#mode-label');
  const sayBox = ui.querySelector('#say-box');
  const applyMode = ({ mode, canEdit }) => {
    modeLabel.textContent = mode.toUpperCase();
    sayBox.hidden = !canEdit;
  };
  bus.addEventListener('mode', (e) => applyMode(e.detail));
  if (latchedMode.last) applyMode(latchedMode.last);
  latchedMode.stop();

  // The text box sends `say` for the selected obelisk.
  const target = sayBox.querySelector('.target');
  const textarea = sayBox.querySelector('textarea');
  const sendButton = sayBox.querySelector('button');
  showTarget(bus, target, getObelisk);
  showErrors(bus, sayBox.querySelector('.error'));
  function send() {
    const text = textarea.value.trim();
    if (!text || !bus.selected) return;
    net.send({ t: 'say', sid: bus.selected, text });
    textarea.value = '';
  }
  sendButton.addEventListener('click', send);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // Share panel: a QR code of the view link, DOM only (PIN-24).
  const link = viewLink();
  ui.querySelector('#share-panel .link').textContent = link;
  QRCode.toCanvas(ui.querySelector('#share-panel canvas'), link, { width: 160, margin: 1 }).catch(() => {});
}

function el(tag, attrs) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}
