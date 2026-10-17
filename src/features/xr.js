// XR entry and the select ray (PIN-3). One bundle serves Quest controllers and
// the Vision Pro transient pointer: controllers 0, 1, and 2 (created up front
// in main.js) each raycast their target ray against every obelisk and publish
// `select`, `selectstart`, `selectend`, and `miss` on the bus through input.js.
// Also owns the in-scene LIVE/REPLAY/SYNTHETIC label, so a headset wearer
// sees it too (PIN-5), and the visionOS AudioContext workaround.
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { Text } from 'troika-three-text';
import { allObelisks } from './room.js';
import { hitToEvent, applySelection, rootOf } from '../input.js';

const SESSION_INIT = { optionalFeatures: ['local-floor', 'bounded-floor'] };

export function install({ scene, camera, renderer, bus }) {
  document.body.appendChild(VRButton.createButton(renderer, SESSION_INIT));

  const raycaster = new THREE.Raycaster();
  const rotation = new THREE.Matrix4();

  // Cast from a controller's target ray. The controller's pose was written by
  // three.js in this frame's update; refresh its world matrix so a cast that
  // runs before the render uses it.
  function cast(controller) {
    controller.updateMatrixWorld(true);
    rotation.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(rotation).normalize();
    const targets = allObelisks().map(rootOf).filter(Boolean);
    return raycaster.intersectObjects(targets, true)[0];
  }

  const nextFrame = (fn) => bus.addEventListener('frame', fn, { once: true });

  for (const i of [0, 1, 2]) {
    const controller = renderer.xr.getController(i);
    // A Vision Pro transient pointer appears in the same frame as its
    // `selectstart`, before three.js has written its first pose, so the start
    // cast waits one frame. `select` and `selectend` arrive after many frames.
    controller.addEventListener('selectstart', () => {
      nextFrame(() => {
        const ev = hitToEvent(cast(controller));
        bus.emit('selectstart', { sid: ev.sid ?? null, controller: i });
      });
    });
    controller.addEventListener('select', () => applySelection(bus, hitToEvent(cast(controller))));
    controller.addEventListener('selectend', () => {
      const ev = hitToEvent(cast(controller));
      bus.emit('selectend', { sid: ev.sid ?? null, controller: i });
    });
  }

  installModeLabel({ scene, camera, bus });
  installAudioWorkaround();
}

// In-scene mode label at the room origin, above the obelisk ring, facing the
// camera (PIN-5). Empty while live; the laptop DOM label mirrors the same event.
function installModeLabel({ scene, camera, bus }) {
  const label = new Text();
  label.text = '';
  label.fontSize = 0.25;
  label.sdfGlyphSize = 64;
  label.color = 0xffcc55;
  label.anchorX = 'center';
  label.anchorY = 'middle';
  label.position.set(0, 2.4, 0);
  label.sync();
  scene.add(label);
  bus.addEventListener('mode', (e) => {
    const mode = e.detail.mode;
    label.text = mode === 'live' ? '' : mode.toUpperCase();
    label.sync();
  });
  bus.addEventListener('frame', () => label.lookAt(camera.position));
}

// visionOS Safari moves every AudioContext to `interrupted` or `suspended` when
// the immersive session starts. Wrap the constructor so each context created
// later (plan 5's audio) resumes itself on `statechange`.
function installAudioWorkaround() {
  const Base = globalThis.AudioContext;
  if (!Base || Base.__obelisksResume) return;
  const Patched = class AudioContext extends Base {
    constructor(...args) {
      super(...args);
      this.addEventListener('statechange', () => {
        if (this.state !== 'running' && this.state !== 'closed') this.resume().catch(() => {});
      });
    }
  };
  Patched.__obelisksResume = true;
  globalThis.AudioContext = Patched;
}
