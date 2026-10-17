// XR gesture state machine (split out of input/xr.js to stay under ~500 lines; PROTOCOL.md §6, DESIGN.md grafts).
// One gesture per input source, keyed by the XRInputSource (or a squeeze marker). Tap vs drag: < 250 ms and < 3 cm of
// hand travel = tap (focus / detail taps are accepted up to 600 ms; the beacon approve is strict). Right hand/controller
// = select · grab · pipe · fork · move; left = push-to-talk, always: on the mic sphere or nothing it talks to the gazed /
// focused column, on any column part it talks to THAT column (left never grabs; a left squeeze is talk-only too).
//   tap tile → detail plane · tap beacon → approve · tap base/title → focus · tap floor/nothing/detail → close detail
//   grab tile → carry a copy at the hit distance → release within 0.5 m of another column's base (or with the ray on its
//   gaze cylinder) → pipe · grab title → pull > 0.5 m → fork at the release floor point · grab base → once the ray's
//   FLOOR point moved > 0.15 m, drag on the floor plane keeping the grab offset → layout.move (local prediction while
//   carried, ≤ 10 Hz) · pinch-hold base 0.6 s (floor point within 0.15 m) → summon (local) · pinch-hold stack +
//   vertical move → scroll (local, one message per 0.14 m) · floor pinch-hold 1 s → recenter.
// Base/floor holds are judged by floor-point travel, not hand travel: a hand held "still" drifts 1–3 cm on Quest and
// the Vision Pro transient-pointer origin follows the hand, which used to flip a summon into a shared layout.move.
// Times come in as parameters so the machine can be driven headlessly (test/xr-shape.mjs).

import * as THREE from 'three';
import { TILE } from '../scene/tiles.js';
import { summonDistance } from '../scene/column.js';

export const TAP_MS = 250;            // strict tap (beacon approve)
export const TAP_MAX_MS = 600;        // generous tap for focus / detail open + close (a longer base hold is a summon anyway)
export const TAP_M = 0.03;            // hand travel (tiles, title, nothing)
export const POINT_TAP_M = 0.09;      // carried-point travel (controller rotation)
export const MOVE_START_M = 0.15;     // floor-point travel before a base pinch-hold becomes a column move
export const SUMMON_HOLD_MS = 600;
export const RECENTER_HOLD_MS = 1000;
export const PIPE_DROP_RADIUS = 0.5;
export const FORK_PULL_M = 0.5;
export const SCROLL_PITCH_M = TILE.pitch;
export const MOVE_SEND_MS = 100;
export const TALK_DEBOUNCE_MS = 150;

const FLOOR = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _v = new THREE.Vector3(); const _fp = new THREE.Vector3();

function ringGeometry(r, y = 0.03) { const pts = []; for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r)); } return new THREE.BufferGeometry().setFromPoints(pts); }

/**
 * createGestures({ scene, columns, actions, hud, app, pick(ray), pickGazeColumn(ray), viewer(), haptic(key), log })
 *   ray = { o: Vector3, d: Vector3 (unit) }; pick → { kind, column?, record?, point, distance } | null (kind 'floor' allowed)
 */
export function createGestures({ scene, columns, actions, hud, app, pick, pickGazeColumn, viewer, haptic, log = () => {} } = {}) {
  const active = new Map();
  const stats = { taps: 0, carries: 0, pipes: 0, forks: 0, moves: 0, summons: 0, scrolls: 0, talks: 0, recenters: 0, approves: 0 };

  // visuals
  const carryGhost = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(TILE.w, TILE.h, TILE.d)), new THREE.LineBasicMaterial({ color: 0x22d3ee }));
  const forkGhost = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.6, 0.1), new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true, transparent: true, opacity: 0.3 }));
  const dropRing = new THREE.Line(ringGeometry(PIPE_DROP_RADIUS), new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.85 }));
  const dwellRing = new THREE.Line(ringGeometry(0.12, 0), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
  for (const o of [carryGhost, forkGhost, dropRing, dwellRing]) { o.visible = false; o.frustumCulled = false; scene?.add(o); }

  function floorAt(ray, out = _fp) {
    if (!ray || ray.d.y >= -1e-4) return null;
    const t = -ray.o.y / ray.d.y;
    if (t < 0 || t > 30) return null;
    return out.copy(ray.o).addScaledVector(ray.d, t);
  }
  const hand = (inputSource) => (inputSource?.handedness === 'left' ? 'left' : 'right');

  function hideVisuals(g) {
    if (g?.mode === 'carry' || !active.size) { carryGhost.visible = false; dropRing.visible = false; }
    if (g?.mode === 'fork' || !active.size) forkGhost.visible = false;
    if (!g || g.mode === 'pending' || g.mode === 'done') dwellRing.visible = false;
  }

  // ------------------------------------------------------------- begin
  function begin(key, ray, now, { inputSource = null, index = -1, talkOnly = false } = {}) {
    if (active.has(key)) end(key, ray, now);
    const hit = pick ? pick(ray) : null;
    const h = talkOnly ? 'left' : hand(inputSource);
    const dist = hit ? hit.distance : 1.0;
    const g = {
      key, inputSource, index, hand: h, t0: now, hit, kind: hit?.kind || 'none', column: hit?.column || null, record: hit?.record || null,
      o0: ray.o.clone(), d0: ray.d.clone(), dist, p0: ray.o.clone().addScaledVector(ray.d, dist), p: new THREE.Vector3(), o: ray.o.clone(),
      travel: 0, pointTravel: 0, floorTravel: 0, floor0: null, grab: null,
      mode: 'pending', lastSend: 0, target: null, forkPoint: null, scrollApplied: 0, talkTarget: null, dwellUntil: 0,
    };
    g.p.copy(g.p0);
    if (g.kind === 'base' || g.kind === 'floor') {
      // judged by where the ray meets the floor; the grab offset keeps the column from jumping to the ray's floor hit
      g.floor0 = floorAt(ray, new THREE.Vector3()) || new THREE.Vector3(hit.point.x, 0, hit.point.z);
      if (g.kind === 'base') g.grab = { x: g.column.group.position.x - g.floor0.x, z: g.column.group.position.z - g.floor0.z };
    }
    if (talkOnly) startTalk(g, g.column?.id || null); // left squeeze = push-to-talk wherever the left ray points (PROTOCOL §6)
    else if (h === 'left') {
      if (g.kind === 'detail') g.mode = 'tap-only';   // closing the plane is the only left-hand tap
      else startTalk(g, g.column?.id || null);        // left never grabs: talk to the column under the ray, else gazed / focused
    } else if (g.kind === 'mic') startTalk(g, g.column?.id);
    else if (g.kind === 'base' || g.kind === 'floor') { g.dwellUntil = now + (g.kind === 'base' ? SUMMON_HOLD_MS : RECENTER_HOLD_MS); dwellRing.visible = true; dwellRing.position.copy(g.kind === 'floor' ? hit.point : g.column.group.position); dwellRing.position.y = g.kind === 'floor' ? 0.01 : 0.06; dwellRing.scale.setScalar(0.01); }
    active.set(key, g);
    log(`begin ${g.hand} ${g.kind}${g.column ? ' ' + g.column.id : ''} mode=${g.mode}`);
    return g;
  }

  function startTalk(g, explicitTarget) {
    const target = explicitTarget || app?.xr?.gazed?.id || actions?.focusedId?.() || null;
    g.mode = 'talk'; g.talkTarget = target;
    if (!target) { hud?.toast?.('look at a column to talk to it', 'warn'); g.mode = 'done'; return; }
    stats.talks++;
    actions?.pushToTalk?.(true, target);
  }
  function stopTalk(g) {
    if (!g.talkTarget) return;
    actions?.pushToTalk?.(false, g.talkTarget);
    g.talkTarget = null;
  }

  // ------------------------------------------------------------- move (per frame while held)
  function move(key, ray, now) {
    const g = active.get(key);
    if (!g || !ray) return null;
    g.o.copy(ray.o); g.p.copy(ray.o).addScaledVector(ray.d, g.dist);
    g.travel = Math.max(g.travel, g.o.distanceTo(g.o0));
    g.pointTravel = Math.max(g.pointTravel, g.p.distanceTo(g.p0));
    let moved;
    if (g.floor0) {
      const fp = floorAt(ray);
      if (fp) g.floorTravel = Math.max(g.floorTravel, Math.hypot(fp.x - g.floor0.x, fp.z - g.floor0.z));
      moved = g.floorTravel > MOVE_START_M;
    } else moved = g.travel > TAP_M || g.pointTravel > POINT_TAP_M;
    if (g.mode === 'pending') {
      if (!moved) {
        if (g.dwellUntil) {
          const total = g.kind === 'base' ? SUMMON_HOLD_MS : RECENTER_HOLD_MS;
          dwellRing.scale.setScalar(Math.max(0.01, 1 - (g.dwellUntil - now) / total));
          if (now >= g.dwellUntil) { if (g.kind === 'base') summon(g); else recenter(g); }
        }
        return g;
      }
      dwellRing.visible = false; g.dwellUntil = 0;
      switch (g.kind) {
        case 'tile': { const dy = Math.abs(g.p.y - g.p0.y); const d = g.p.distanceTo(g.p0); g.mode = dy > 0.7 * d ? 'scroll' : 'carry'; if (g.mode === 'carry') { stats.carries++; carryGhost.visible = true; } break; }
        case 'base': g.mode = 'move'; g.column.dragging = true; break;
        case 'title': g.mode = 'fork'; break;
        default: g.mode = 'drag-none'; break;
      }
      log(`drag → ${g.mode}`);
    }
    switch (g.mode) {
      case 'carry': updateCarry(g, ray); break;
      case 'scroll': updateScroll(g); break;
      case 'move': updateMove(g, ray, now); break;
      case 'fork': updateFork(g, ray); break;
      default: break;
    }
    return g;
  }

  function updateCarry(g, ray) {
    carryGhost.position.copy(g.p); carryGhost.quaternion.copy(g.column.group.quaternion);
    let target = pickGazeColumn ? pickGazeColumn(ray) : null;
    if (target === g.column) target = null;
    if (!target) {
      let best = Infinity;
      for (const c of columns.values()) {
        if (c === g.column || c.removed) continue;
        const d = Math.hypot(c.group.position.x - g.p.x, c.group.position.z - g.p.z);
        if (d < PIPE_DROP_RADIUS && d < best) { best = d; target = c; }
      }
    }
    g.target = target;
    dropRing.visible = Boolean(target);
    if (target) dropRing.position.set(target.group.position.x, 0, target.group.position.z);
  }

  function updateScroll(g) {
    const steps = Math.round(-(g.p.y - g.p0.y) / SCROLL_PITCH_M) - g.scrollApplied; // pull down → older messages come down
    if (!steps) return;
    g.scrollApplied += steps; stats.scrolls += Math.abs(steps);
    g.column.scrollBy(steps);
  }

  function updateMove(g, ray, now) {
    const fp = floorAt(ray);
    if (!fp) return;
    g.column.setDragPosition(fp.x + (g.grab?.x || 0), fp.z + (g.grab?.z || 0), true);
    if (now - g.lastSend >= MOVE_SEND_MS) { g.lastSend = now; actions?.move?.(g.column.id, g.column.poseAsPlacement(), { final: false }); }
  }

  function updateFork(g, ray) {
    const fp = floorAt(ray) || _fp.set(g.p.x, 0, g.p.z);
    const pull = Math.hypot(fp.x - g.column.group.position.x, fp.z - g.column.group.position.z);
    const far = pull > FORK_PULL_M;
    forkGhost.visible = far; forkGhost.position.set(fp.x, 0.8, fp.z); forkGhost.quaternion.copy(g.column.group.quaternion);
    g.forkPoint = far ? fp.clone() : null;
  }

  function summon(g) {
    g.mode = 'done'; dwellRing.visible = false; g.dwellUntil = 0;
    const v = viewer ? viewer() : { position: new THREE.Vector3(0, 1.6, 0), yaw: 0 };
    // land inside the active full-LOD band (0.9 m Quest/desktop, 0.65 m Vision Pro, less with ?scale<1)
    g.column.toggleSummon(_v.set(v.position.x, 0, v.position.z), v.yaw, summonDistance(app?.pool?.thresholds?.[0], g.column.scale));
    stats.summons++;
    hud?.toast?.(g.column.summoned ? `summoned ${g.column.session?.title || g.column.id}` : 'sent back', 'ok');
    haptic?.(g, 0.7, 60);
  }
  function recenter(g) {
    g.mode = 'done'; dwellRing.visible = false; g.dwellUntil = 0;
    const v = viewer ? viewer() : { position: new THREE.Vector3(0, 1.6, 0) };
    stats.recenters++;
    actions?.recenter?.(v.position.y);
    haptic?.(g, 0.7, 60);
  }

  // ------------------------------------------------------------- end
  function tap(g) {
    stats.taps++;
    switch (g.kind) {
      case 'tile': actions?.focusSession?.(g.column.id); actions?.selectTile?.(g.record); break;
      case 'base': case 'title': actions?.focusSession?.(g.column.id); break;
      case 'beacon': { const s = g.column.session; actions?.focusSession?.(g.column.id); actions?.approve?.(g.column.id, s?.attention?.requestId, true); stats.approves++; break; }
      case 'detail': actions?.closeDetail?.(); actions?.selectTile?.(null); break;
      case 'mic': break;
      default: actions?.selectTile?.(null); actions?.closeDetail?.(); break;
    }
    haptic?.(g, 0.4, 25);
  }

  function end(key, ray, now) {
    const g = active.get(key);
    if (!g) return null;
    if (ray) move(key, ray, now);
    active.delete(key);
    const held = now - g.t0;
    let tapped = false;
    switch (g.mode) {
      case 'pending': case 'tap-only': {
        // a long hold is never a tap: the beacon approve needs a quick pinch, everything else gets up to 600 ms
        tapped = held <= TAP_MAX_MS && (g.kind !== 'beacon' || held <= TAP_MS);
        if (tapped) tap(g); else log(`held ${Math.round(held)} ms on ${g.kind} — not a tap`);
        break;
      }
      case 'talk': if (held < TALK_DEBOUNCE_MS) log('talk released within the debounce window'); stopTalk(g); break;
      case 'carry': if (g.target && g.record) { stats.pipes++; actions?.pipe?.(g.column.id, g.record.msg.id, g.target.id); haptic?.(g, 0.8, 80); } else log('carry released with no target'); break;
      case 'move': g.column.endDrag(); stats.moves++; actions?.move?.(g.column.id, g.column.poseAsPlacement(), { final: true }); break;
      case 'fork': if (g.forkPoint) { stats.forks++; actions?.fork?.(g.column.id, { x: g.forkPoint.x / g.column.scale, z: g.forkPoint.z / g.column.scale }); haptic?.(g, 0.8, 80); } else actions?.focusSession?.(g.column.id); break;
      default: break;
    }
    g.mode = g.mode === 'pending' || g.mode === 'tap-only' ? (tapped ? 'tapped' : 'held') : g.mode;
    log(`end ${g.hand} ${g.kind} → ${g.mode} (${Math.round(held)} ms, ${(g.travel * 100).toFixed(1)} cm hand, ${(g.floorTravel * 100).toFixed(1)} cm floor)`);
    hideVisuals(g);
    if (!active.size) hideVisuals(null);
    return g;
  }

  /** Input source vanished mid-gesture (transient pointer disconnected, session ended): finish safely without actions. */
  function cancel(key) {
    const g = active.get(key);
    if (!g) return;
    active.delete(key);
    if (g.mode === 'talk') stopTalk(g);
    if (g.mode === 'move') { g.column.endDrag(); actions?.move?.(g.column.id, g.column.poseAsPlacement(), { final: true }); }
    hideVisuals(g);
    if (!active.size) hideVisuals(null);
  }
  function cancelAll() { for (const key of [...active.keys()]) cancel(key); hideVisuals(null); }

  function update(now) { void now; }

  return {
    active, begin, move, end, cancel, cancelAll, update, floorAt,
    hoverInfo() { for (const g of active.values()) if (g.record && g.column) return { sessionId: g.column.id, messageId: g.record.msg.id }; return null; },
    carrying() { for (const g of active.values()) if (g.mode === 'carry') return g; return null; },
    talking() { for (const g of active.values()) if (g.mode === 'talk') return g; return null; },
    stats() { return { ...stats, active: active.size }; },
    visuals: { carryGhost, forkGhost, dropRing, dwellRing },
    dispose() { cancelAll(); for (const o of [carryGhost, forkGhost, dropRing, dwellRing]) { scene?.remove(o); o.geometry.dispose(); o.material.dispose(); } },
  };
}

export default { createGestures, TAP_MS, TAP_MAX_MS, TAP_M, MOVE_START_M, SUMMON_HOLD_MS, RECENTER_HOLD_MS, PIPE_DROP_RADIUS, FORK_PULL_M };
