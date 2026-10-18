// Phone camera: on a phone or tablet (the QR-code view), a LOOK AROUND button
// turns the device into a camera into the room. Point the phone to look, and
// drag one finger to walk: up/down moves forward and back, left/right strafes.
// Orbiting is off while it is on (laptop.js reads bus.cameraOverride) and comes
// back, aimed where you were looking, when you turn it off.
import * as THREE from 'three';
import { shouldInstallLaptop } from '../input.js';

export const EYE_HEIGHT = 1.6;
export const START = Object.freeze([0, EYE_HEIGHT, 3]); // the head of the aisle
export const WALK_PER_PIXEL = 0.02; // meters walked per pixel of finger drag

const zee = new THREE.Vector3(0, 0, 1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // camera looks out the back of the device

/**
 * The camera rotation for a device orientation (degrees, from deviceorientation)
 * and screen angle (degrees), with `alphaOffset` subtracted so the pose at the
 * moment the camera turned on faces straight down the aisle.
 */
export function deviceQuaternion({ alpha = 0, beta = 0, gamma = 0 }, screenAngle = 0, alphaOffset = 0, out = new THREE.Quaternion()) {
  const d = THREE.MathUtils.degToRad;
  euler.set(d(beta), d(alpha - alphaOffset), -d(gamma), 'YXZ');
  out.setFromEuler(euler);
  out.multiply(q1);
  out.multiply(q0.setFromAxisAngle(zee, -d(screenAngle)));
  return out;
}

/** Walk step on the floor for a finger drag (dx, dy pixels) given the camera's flat forward and right vectors. */
export function dragStep(dx, dy, forward, right, out = new THREE.Vector3()) {
  return out.set(0, 0, 0).addScaledVector(forward, -dy * WALK_PER_PIXEL).addScaledVector(right, dx * WALK_PER_PIXEL);
}

export const isTouchDevice = () => typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 0 || 'ontouchstart' in globalThis);

export async function install({ camera, renderer, bus }) {
  if (!isTouchDevice() || !(await shouldInstallLaptop())) return;
  let on = false;
  let pose = null;
  let alphaOffset = null;
  let drag = null;
  const target = new THREE.Quaternion();
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const step = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const button = document.createElement('button');
  button.id = 'phone-camera';
  button.type = 'button';
  Object.assign(button.style, {
    position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: '64px', zIndex: '998', cursor: 'pointer',
    font: '700 14px/1 system-ui, sans-serif', letterSpacing: '.08em', color: '#fff', background: '#7a1a12',
    border: '1px solid #ff2a1a', borderRadius: '22px', padding: '12px 18px',
  });
  const render = () => (button.textContent = on ? 'STOP LOOKING' : 'LOOK AROUND (move your phone)');
  render();
  document.body.append(button);

  const onOrient = (e) => {
    if (e.alpha == null) return;
    if (alphaOffset == null) alphaOffset = e.alpha;
    pose = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
  };
  const screenAngle = () => screen.orientation?.angle ?? globalThis.orientation ?? 0;

  const start = async () => {
    const DOE = globalThis.DeviceOrientationEvent;
    if (DOE?.requestPermission) {
      try {
        if ((await DOE.requestPermission()) !== 'granted') return;
      } catch {
        return;
      }
    }
    on = true;
    bus.cameraOverride = true;
    if (bus.orbit) bus.orbit.enabled = false;
    alphaOffset = null;
    camera.position.set(...START);
    window.addEventListener('deviceorientation', onOrient);
    render();
  };
  const stop = () => {
    on = false;
    bus.cameraOverride = false;
    window.removeEventListener('deviceorientation', onOrient);
    if (bus.orbit) {
      camera.getWorldDirection(fwd);
      bus.orbit.target.copy(camera.position).addScaledVector(fwd, 2);
      bus.orbit.enabled = true;
    }
    render();
  };
  button.addEventListener('click', () => (on ? stop() : start()));

  // One-finger drag walks while the phone aims the camera.
  const el = renderer.domElement;
  el.addEventListener('pointerdown', (e) => on && (drag = { x: e.clientX, y: e.clientY }));
  el.addEventListener('pointermove', (e) => {
    if (!on || !drag) return;
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    right.crossVectors(fwd, up).normalize();
    camera.position.add(dragStep(e.clientX - drag.x, e.clientY - drag.y, fwd, right, step));
    camera.position.y = EYE_HEIGHT;
    drag = { x: e.clientX, y: e.clientY };
  });
  const end = () => (drag = null);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  bus.addEventListener('frame', () => {
    if (!on || !pose) return;
    camera.quaternion.slerp(deviceQuaternion(pose, screenAngle(), alphaOffset, target), 0.5);
  });
}
