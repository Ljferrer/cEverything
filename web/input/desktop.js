// Laptop input (PROTOCOL.md §6, laptop column): OrbitControls, hover outline (broadcast), click focus / select,
// drag tile → other column = pipe, drag base = move (layout.move), drag title > 0.5 m = fork, double-click = summon,
// wheel over a column = scroll history, keys: F fork · S summon · T top-down · C recenter · 1–5 cues · R reset ·
// D debug · V spectator · P pipe mode · Home · Esc · Space push-to-talk (via input/voice.js when present).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HIT_LAYER } from '../scene/column-parts.js';
import { TILE } from '../scene/tiles.js';
import { summonDistance } from '../scene/column.js';

const DRAG_PX = 6;
const FORK_PULL_M = 0.5;
const PIPE_DROP_RADIUS = 0.5;
const CUES = { 1: 'needs_you', 2: 'web_burst', 3: 'patch', 4: 'delegate', 5: 'done' };

export function createDesktopInput({ renderer, camera, scene, store, net, columns, pool, fx, room, actions, flags = {} }) {
  const dom = renderer.domElement;
  const controls = new OrbitControls(camera, dom);
  controls.enableDamping = true; controls.dampingFactor = 0.12;
  controls.minDistance = 0.3; controls.maxDistance = 25;
  controls.maxPolarAngle = Math.PI * 0.49 + Math.PI * 0.5; // allow looking from below the horizon a little
  controls.target.set(0, 1.3, -1.6);
  camera.position.set(0, 1.6, 0.6);
  controls.update();

  const raycaster = new THREE.Raycaster();
  raycaster.layers.set(HIT_LAYER);
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = new THREE.Vector2();
  const _p = new THREE.Vector3();

  const state = {
    hover: null,          // { kind, column, record? , point }
    pointer: { x: 0, y: 0, down: false, downX: 0, downY: 0, button: 0 },
    drag: null,           // { kind: 'tile'|'base'|'title', column, record?, startPoint, lastSent }
    pipeMode: false,      // select tile + P → next click on a column pipes
    topDown: false, savedPose: null,
    spectator: false,
    talking: false,
    lastClickAt: 0, lastClickColumn: null,
  };

  // drag ghost (cyan wire tile following the pointer during a pipe drag)
  const ghost = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(TILE.w, TILE.h, TILE.d)), new THREE.LineBasicMaterial({ color: 0x22d3ee }));
  ghost.visible = false; ghost.frustumCulled = false; scene.add(ghost);
  const dropRing = new THREE.Line(ringGeometry(PIPE_DROP_RADIUS), new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.8 }));
  dropRing.visible = false; dropRing.frustumCulled = false; scene.add(dropRing);

  function ringGeometry(r) { const pts = []; for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, 0.03, Math.sin(a) * r)); } return new THREE.BufferGeometry().setFromPoints(pts); }

  function hitTargets() { const out = []; for (const c of columns.values()) if (!c.removed) out.push(...c.hit.all); return out; }

  function setNDC(e) {
    const r = dom.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }

  function pick(e) {
    setNDC(e);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(hitTargets(), false);
    for (const h of hits) {
      const ud = h.object.userData;
      if (!ud || !ud.column || ud.kind === 'gaze') continue;
      const column = ud.column;
      if (ud.kind === 'stack') { const record = column.tileAt(h.point); if (!record) continue; return { kind: 'tile', column, record, point: h.point, distance: h.distance }; }
      return { kind: ud.kind, column, point: h.point, distance: h.distance };
    }
    return null;
  }

  function floorPoint(e, out = _p) {
    setNDC(e);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(floor, out) ? out : null;
  }

  /** Column whose base is within 0.5 m (horizontally) of a floor point, excluding `except`. */
  function columnNear(point, except) {
    let best = null; let bestD = Infinity;
    for (const c of columns.values()) {
      if (c === except || c.removed) continue;
      const d = Math.hypot(c.group.position.x - point.x, c.group.position.z - point.z);
      if (d < PIPE_DROP_RADIUS && d < bestD) { best = c; bestD = d; }
    }
    return best;
  }

  function setHover(h) {
    const prev = state.hover;
    state.hover = h;
    pool.setOutline('hover', h && h.kind === 'tile' ? h.record : null);
    if (prev?.column !== h?.column) { prev?.column?.setGazed(false); h?.column?.setGazed(true); }
    dom.style.cursor = h ? (h.kind === 'base' || h.kind === 'title' ? 'grab' : 'pointer') : (state.pipeMode ? 'crosshair' : 'default');
  }

  // ------------------------------------------------------------------ pointer events
  dom.addEventListener('pointermove', (e) => {
    state.pointer.x = e.clientX; state.pointer.y = e.clientY;
    if (state.drag) { onDragMove(e); return; }
    if (state.pointer.down) {
      const dx = e.clientX - state.pointer.downX; const dy = e.clientY - state.pointer.downY;
      if (Math.hypot(dx, dy) > DRAG_PX && state.pendingDrag) beginDrag(state.pendingDrag, e);
      return;
    }
    setHover(pick(e));
  });

  dom.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const h = pick(e);
    state.pointer.down = true; state.pointer.downX = e.clientX; state.pointer.downY = e.clientY;
    state.pendingDrag = h && (h.kind === 'tile' || h.kind === 'base' || h.kind === 'title') ? h : null;
    if (state.pendingDrag) controls.enabled = false; // we decide on move whether it is a drag or a click
  });

  dom.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    const wasDown = state.pointer.down;
    state.pointer.down = false;
    if (state.drag) { endDrag(e); controls.enabled = !state.spectator; state.pendingDrag = null; return; }
    controls.enabled = !state.spectator;
    state.pendingDrag = null;
    if (!wasDown) return;
    const h = pick(e);
    onClick(h, e);
  });
  dom.addEventListener('pointerleave', () => { if (!state.drag) setHover(null); });
  dom.addEventListener('contextmenu', (e) => { if (state.hover) e.preventDefault(); });

  function onClick(h, e) {
    const now = performance.now();
    if (state.pipeMode && h && h.column && actions.selectedTile?.()) {
      const sel = actions.selectedTile();
      if (sel && sel.column !== h.column) { actions.pipe(sel.column.id, sel.msg.id, h.column.id); }
      setPipeMode(false);
      return;
    }
    if (!h) { actions.selectTile?.(null); return; }
    const dbl = h.column === state.lastClickColumn && now - state.lastClickAt < 350;
    state.lastClickAt = now; state.lastClickColumn = h.column;
    actions.focusSession?.(h.column.id);
    if (h.kind === 'tile') actions.selectTile?.(h.record);
    if (dbl && h.kind !== 'tile') summonFocused();
    void e;
  }

  // ------------------------------------------------------------------ drags
  function beginDrag(h, e) {
    state.drag = { kind: h.kind, column: h.column, record: h.record || null, startPoint: h.point.clone(), lastSent: 0, hitDistance: h.distance, moved: false };
    controls.enabled = false;
    state.pendingDrag = null;
    if (h.kind === 'tile') { ghost.visible = true; ghost.position.copy(h.point); ghost.quaternion.copy(h.column.group.quaternion); dom.style.cursor = 'grabbing'; }
    if (h.kind === 'base') { h.column.dragging = true; dom.style.cursor = 'grabbing'; }
    if (h.kind === 'title') { dom.style.cursor = 'grabbing'; }
    onDragMove(e);
  }

  function onDragMove(e) {
    const d = state.drag;
    if (!d) return;
    if (d.kind === 'tile') {
      setNDC(e); raycaster.setFromCamera(ndc, camera);
      raycaster.ray.at(d.hitDistance, ghost.position);
      const fp = floorPoint(e);
      const target = fp ? columnNear(fp, d.column) : null;
      dropRing.visible = Boolean(target);
      if (target) dropRing.position.set(target.group.position.x, 0, target.group.position.z);
      d.target = target;
      return;
    }
    const fp = floorPoint(e);
    if (!fp) return;
    d.moved = true;
    if (d.kind === 'base') {
      d.column.setDragPosition(fp.x, fp.z, true);
      const now = performance.now();
      if (now - d.lastSent > 100) { d.lastSent = now; actions.move?.(d.column.id, d.column.poseAsPlacement(), { final: false }); }
    } else if (d.kind === 'title') {
      const pull = Math.hypot(fp.x - d.column.group.position.x, fp.z - d.column.group.position.z);
      fx.forkPreview?.(d.column, fp, pull > FORK_PULL_M);
      ghost.visible = pull > FORK_PULL_M; ghost.position.set(fp.x, 1.3, fp.z); ghost.quaternion.copy(d.column.group.quaternion); ghost.scale.set(1, 6, 1);
      d.forkPoint = pull > FORK_PULL_M ? fp.clone() : null;
    }
  }

  function endDrag(e) {
    const d = state.drag; state.drag = null;
    ghost.visible = false; ghost.scale.set(1, 1, 1); dropRing.visible = false; dom.style.cursor = 'default';
    if (!d) return;
    if (d.kind === 'tile') {
      if (d.target && d.record) actions.pipe?.(d.column.id, d.record.msg.id, d.target.id);
      else if (!d.moved) { actions.focusSession?.(d.column.id); actions.selectTile?.(d.record); }
      return;
    }
    if (d.kind === 'base') {
      d.column.endDrag();
      if (d.moved) actions.move?.(d.column.id, d.column.poseAsPlacement(), { final: true });
      else actions.focusSession?.(d.column.id);
      return;
    }
    if (d.kind === 'title') {
      if (d.forkPoint) actions.fork?.(d.column.id, { x: d.forkPoint.x / d.column.scale, z: d.forkPoint.z / d.column.scale });
      else actions.focusSession?.(d.column.id);
    }
    void e;
  }

  // ------------------------------------------------------------------ wheel: scroll history over a column
  window.addEventListener('wheel', (e) => {
    if (e.target !== dom) return;
    const h = state.hover || pick(e);
    if (!h || !h.column) return;
    e.preventDefault(); e.stopPropagation();
    const n = Math.sign(e.deltaY);
    if (n) h.column.scrollBy(n);
  }, { capture: true, passive: false });

  // ------------------------------------------------------------------ keys
  function typing() { const el = document.activeElement; return el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable); }

  function focusedColumn() { const id = actions.focusedId?.(); return id ? columns.get(id) || null : null; }

  function summonFocused() {
    const col = focusedColumn();
    if (!col) return;
    const yaw = Math.atan2(-(controls.target.x - camera.position.x), -(controls.target.z - camera.position.z));
    const viewer = new THREE.Vector3(camera.position.x, 0, camera.position.z);
    col.toggleSummon(viewer, yaw, summonDistance(pool?.thresholds?.[0], col.scale));
  }

  function setPipeMode(on) { state.pipeMode = Boolean(on); actions.pipeMode?.(state.pipeMode); dom.style.cursor = on ? 'crosshair' : 'default'; }

  function toggleTopDown() {
    state.topDown = !state.topDown;
    if (state.topDown) {
      state.savedPose = { pos: camera.position.clone(), target: controls.target.clone() };
      controls.target.set(0, 0, -1.4);
      camera.position.set(0, 14, -1.39);
    } else if (state.savedPose) {
      camera.position.copy(state.savedPose.pos); controls.target.copy(state.savedPose.target);
    }
    controls.update();
    actions.topDown?.(state.topDown);
  }

  function setSpectator(on) {
    state.spectator = Boolean(on);
    controls.enabled = !state.spectator;
    actions.spectator?.(state.spectator);
  }

  window.addEventListener('keydown', (e) => {
    if (typing()) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    if (e.repeat && e.code !== 'Space') return;
    const col = focusedColumn();
    switch (e.code) {
      case 'KeyF': if (col) actions.fork?.(col.id, {}); break;
      case 'KeyS': summonFocused(); break;
      case 'KeyT': toggleTopDown(); break;
      case 'KeyC': actions.recenter?.(camera.position.y); break;
      case 'KeyR': actions.reset?.(); break;
      case 'KeyD': actions.toggleDebug?.(); break;
      case 'KeyV': setSpectator(!state.spectator); break;
      case 'KeyP': if (actions.selectedTile?.()) setPipeMode(!state.pipeMode); break;
      case 'Home': if (col) col.scrollHome(); break;
      case 'PageUp': if (col) col.scrollBy(5); break;
      case 'PageDown': if (col) col.scrollBy(-5); break;
      case 'Escape': setPipeMode(false); actions.closeDetail?.(); actions.selectTile?.(null); break;
      case 'Space':
        if (!state.talking) { state.talking = true; actions.pushToTalk?.(true, col?.id || null); }
        e.preventDefault();
        break;
      case 'Slash': if (e.shiftKey) actions.toggleHelp?.(); break;
      case 'KeyH': actions.togglePanels?.(); break;
      default:
        if (/^Digit[1-5]$/.test(e.code) && CUES[e.code.slice(5)]) actions.cue?.(CUES[e.code.slice(5)], col?.id);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && state.talking) { state.talking = false; actions.pushToTalk?.(false, focusedColumn()?.id || null); }
  });

  // ------------------------------------------------------------------ per frame
  const _pose = { p: [0, 0, 0], q: [0, 0, 0, 1] };
  function update(dt) {
    if (state.spectator) {
      const pose = actions.headsetPose?.();
      if (pose) { camera.position.lerp(pose.position, Math.min(1, dt * 8)); camera.quaternion.slerp(pose.quaternion, Math.min(1, dt * 8)); }
    } else controls.update();
  }

  function head() { camera.position.toArray(_pose.p); camera.quaternion.toArray(_pose.q); return _pose; }
  function hoverInfo() { const h = state.hover; return h ? { sessionId: h.column.id, messageId: h.record ? h.record.msg.id : undefined } : null; }
  function viewerYaw() { return Math.atan2(-(controls.target.x - camera.position.x), -(controls.target.z - camera.position.z)); }

  return {
    controls, raycaster, state,
    update, head, hoverInfo, pick, viewerYaw, toggleTopDown, setSpectator, setPipeMode, summonFocused,
    get topDown() { return state.topDown; }, get spectator() { return state.spectator; },
    dispose() { controls.dispose(); scene.remove(ghost); scene.remove(dropRing); },
  };
}

export default { createDesktopInput };
