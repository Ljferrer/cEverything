// File-tree pylon ("the codebase", PROTOCOL.md §1 scene/filetree.js, §5; DESIGN.md "File-tree pylon"). Root cube at
// (0, 0.4, −3.2) × scale; one level per directory depth (0.35 m pitch), siblings 0.25 m apart (tidy layout: leaves get
// slots, parents sit over the mean of their children), max 4 levels / 40 nodes, built lazily from the paths seen in
// read_file / write_file / patch / search_files tool calls across all sessions. Dirs = 0.06 m wire cubes, files = 0.05 m
// planes + filename sprite, parent→child Lines. On tool.complete with meta.path the node flashes; with meta.diff the diff
// card (0.8 × 0.5 m plane at x +1.2 from the root, y 1.2) renders the unified diff (max 24 lines; + #22C55E, − #EF4444,
// @@ cyan, context gray) for 8 s or until the next edit; touched files turn green and carry a touched-count badge.

import * as THREE from 'three';
import { CATEGORY_OF_TOOL } from '/shared/protocol.js';
import { makeTextSprite, makeCanvas, makeTexture, sharedPlaneGeometry, font, roundRect } from '../text/canvas-text.js';

export const MAX_DEPTH = 4;
export const MAX_NODES = 40;
export const LEVEL_PITCH = 0.35;
export const SIBLING_PITCH = 0.25;
export const ROOT_Y = 0.4;
export const DIFF_CARD = Object.freeze({ w: 0.8, h: 0.5, x: 1.2, y: 1.2, lines: 24, ms: 8000 });
export const DEFAULT_ORIGIN = Object.freeze({ x: 0, z: -3.2 });

const FILE_TOOLS = new Set(['read_file', 'write_file', 'patch', 'search_files', 'edit_file', 'list_files']);
const EDIT_TOOLS = new Set(['write_file', 'patch', 'edit_file']);
const COLOR = { dir: 0x14b8a6, file: 0x94a3b8, touched: 0x22c55e, line: 0x334155, flash: '#F59E0B' };

/** Split a path into ≤ MAX_DEPTH segments (deeper tails are joined into the last segment). Exported for tests. */
export function segmentsOf(path) {
  const s = String(path || '').replace(/\\/g, '/').replace(/^\.?\//, '').split('/').filter((x) => x && x !== '.');
  if (s.length <= MAX_DEPTH) return s;
  return [...s.slice(0, MAX_DEPTH - 1), s.slice(MAX_DEPTH - 1).join('/')];
}

export function createFileTree({ scene, store, fx, flags = {}, room, app } = {}) {
  const scale = Number(flags.scale) > 0 ? Number(flags.scale) : 1;
  const group = new THREE.Group(); group.name = 'filetree'; scene.add(group);
  const nodes = new Map();   // key (joined segments) → node
  const stats = { nodes: 0, overflow: 0, touchedFiles: 0, edits: 0 };
  const geo = { dir: new THREE.EdgesGeometry(new THREE.BoxGeometry(0.06, 0.06, 0.06)), root: new THREE.EdgesGeometry(new THREE.BoxGeometry(0.1, 0.1, 0.1)) };
  const lineMat = new THREE.LineBasicMaterial({ color: COLOR.line, transparent: true, opacity: 0.9 });

  // root
  const root = { key: '', name: '/', depth: 0, isDir: true, parent: null, children: [], x: 0, touched: 0 };
  root.obj = new THREE.Group();
  root.mesh = new THREE.LineSegments(geo.root, new THREE.LineBasicMaterial({ color: COLOR.dir }));
  root.obj.add(root.mesh);
  root.obj.position.set(0, ROOT_Y, 0);
  group.add(root.obj);
  const badge = makeTextSprite('', { widthM: 0.5, heightM: 0.06, width: 640, height: 77, fontPx: 32, color: '#99f6e4', bg: 'rgba(15,23,42,0.85)', maxLines: 1 });
  badge.position.set(0, ROOT_Y - 0.14, 0);
  group.add(badge);
  nodes.set('', root);

  // diff card (one canvas, redrawn in place)
  const card = (() => {
    const { canvas, ctx } = makeCanvas(1024, 640);
    const texture = makeTexture(canvas);
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(sharedPlaneGeometry(), material);
    mesh.scale.set(DIFF_CARD.w, DIFF_CARD.h, 1); mesh.position.set(DIFF_CARD.x, DIFF_CARD.y, 0); mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 3; mesh.name = 'diff-card';
    group.add(mesh);
    return { canvas, ctx, texture, material, mesh, until: 0, path: '' };
  })();

  // ---------------------------------------------------------------- placement (follows the files pylon)
  function setOrigin() {
    const p = store?.pylons?.find?.((x) => x.kind === 'files') || DEFAULT_ORIGIN;
    group.position.set((Number(p.x) || 0) * scale, 0, (Number(p.z) || 0) * scale);
    // face the origin so local +x is the user's right (plain yaw; the default spot is straight ahead → rotation 0)
    group.rotation.y = Math.atan2(-group.position.x, -group.position.z);
  }

  // ---------------------------------------------------------------- tree building
  function makeNode(parent, name, isDir) {
    const node = { key: parent.key ? `${parent.key}/${name}` : name, name, depth: parent.depth + 1, isDir, parent, children: [], x: 0, touched: 0, bornAt: performance.now() };
    node.obj = new THREE.Group(); node.obj.name = `node:${node.key}`;
    if (isDir) node.mesh = new THREE.LineSegments(geo.dir, new THREE.LineBasicMaterial({ color: COLOR.dir }));
    else { node.mesh = new THREE.Mesh(sharedPlaneGeometry(), new THREE.MeshBasicMaterial({ color: COLOR.file, side: THREE.DoubleSide })); node.mesh.scale.set(0.05, 0.05, 1); }
    node.label = makeTextSprite(name.length > 22 ? '…' + name.slice(-21) : name, { widthM: 0.24, heightM: 0.045, width: 384, height: 72, fontPx: 30, color: isDir ? '#99f6e4' : '#e5e7eb', bg: 'rgba(15,23,42,0.85)', maxLines: 1 });
    node.label.position.y = -0.065;
    node.obj.add(node.mesh, node.label);
    node.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), lineMat);
    node.line.frustumCulled = false;
    group.add(node.obj, node.line);
    parent.children.push(node);
    nodes.set(node.key, node);
    stats.nodes = nodes.size - 1;
    fx?.grow?.(node.obj, 250);
    return node;
  }

  /** Ensure the node for a path (creating ancestors); null when the 40-node budget is exhausted. */
  function ensure(path) {
    const segs = segmentsOf(path);
    if (!segs.length) return root;
    const key = segs.join('/');
    const hit = nodes.get(key);
    if (hit) return hit;
    let parent = root; let changed = false;
    for (let i = 0; i < segs.length; i++) {
      const k = segs.slice(0, i + 1).join('/');
      let node = nodes.get(k);
      if (!node) {
        if (nodes.size - 1 >= MAX_NODES) { stats.overflow++; refreshBadge(); return null; }
        const isDir = i < segs.length - 1 || /\/$/.test(String(path)) || !/\.[A-Za-z0-9]{1,8}$/.test(segs[i]);
        node = makeNode(parent, segs[i], isDir); changed = true;
      }
      parent = node;
    }
    if (changed) { layout(); refreshBadge(); }
    return parent;
  }

  function layout() {
    let cursor = 0;
    const place = (n) => {
      if (!n.children.length) { n.x = cursor; cursor += SIBLING_PITCH; return; }
      for (const c of n.children) place(c);
      n.x = n.children.reduce((a, c) => a + c.x, 0) / n.children.length;
    };
    place(root);
    const shift = root.x;
    for (const n of nodes.values()) {
      n.x -= shift;
      const y = ROOT_Y + n.depth * LEVEL_PITCH;
      n.obj.position.set(n.x, y, 0);
      if (n.line && n.parent) {
        const pos = n.line.geometry.attributes.position;
        pos.setXYZ(0, n.parent.x, ROOT_Y + n.parent.depth * LEVEL_PITCH, 0);
        pos.setXYZ(1, n.x, y, 0);
        pos.needsUpdate = true;
      }
    }
  }

  function refreshBadge() {
    const extra = stats.overflow ? ` · +${stats.overflow} unplaced` : '';
    badge.setText(`${stats.touchedFiles} touched · ${stats.nodes}/${MAX_NODES} nodes${extra}`);
  }

  function pathOf(ev, msg) {
    return ev?.meta?.path || ev?.args?.path || msg?.tool?.meta?.path || msg?.tool?.args?.path || msg?.tool?.args?.file || null;
  }
  function isFileTool(name, category) { return FILE_TOOLS.has(String(name || '')) || category === 'files' || CATEGORY_OF_TOOL(name) === 'files'; }

  // ---------------------------------------------------------------- diff card
  function showDiff(path, diff) {
    const ctx = card.ctx; const w = 1024; const h = 640;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(3,7,18,0.94)'; roundRect(ctx, 1, 1, w - 2, h - 2, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(34,197,94,0.6)'; ctx.lineWidth = 4; roundRect(ctx, 2, 2, w - 4, h - 4, 18); ctx.stroke();
    const lines = String(diff || '').replace(/\r/g, '').split('\n');
    let add = 0; let del = 0;
    for (const l of lines) { if (l.startsWith('+') && !l.startsWith('+++')) add++; else if (l.startsWith('-') && !l.startsWith('---')) del++; }
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = font(30, { weight: 700, mono: true }); ctx.fillStyle = '#e5e7eb';
    ctx.fillText(`✎ ${path.length > 48 ? '…' + path.slice(-47) : path}`, 28, 34);
    ctx.textAlign = 'right'; ctx.fillStyle = '#86efac'; ctx.fillText(`+${add}`, w - 110, 34); ctx.fillStyle = '#fca5a5'; ctx.fillText(`−${del}`, w - 28, 34);
    ctx.textAlign = 'left'; ctx.font = font(22, { mono: true });
    const shown = lines.slice(0, DIFF_CARD.lines);
    const lineH = (h - 80) / DIFF_CARD.lines;
    for (let i = 0; i < shown.length; i++) {
      const l = shown[i];
      ctx.fillStyle = l.startsWith('+') && !l.startsWith('+++') ? '#22C55E' : l.startsWith('-') && !l.startsWith('---') ? '#EF4444' : l.startsWith('@@') ? '#38bdf8' : '#9ca3af';
      let t = l; while (t.length > 1 && ctx.measureText(t).width > w - 56) t = t.slice(0, -1);
      ctx.fillText(t, 28, 70 + lineH * (i + 0.5));
    }
    if (lines.length > shown.length) { ctx.fillStyle = '#64748b'; ctx.fillText(`… +${lines.length - shown.length} more lines`, 28, h - 18); }
    card.texture.needsUpdate = true;
    card.mesh.visible = true; card.until = performance.now() + DIFF_CARD.ms; card.path = path;
    stats.edits++;
  }

  // ---------------------------------------------------------------- events
  /** Packet landed (pylons.js) / tool.start with a path: make sure the node exists and flash it amber. */
  function onToolStart(ev, msg) {
    const path = pathOf(ev, msg); if (!path) return null;
    const node = ensure(path); if (!node) return null;
    if (node.mesh?.material) fx?.flash?.(node.mesh.material, COLOR.flash, 300);
    return node;
  }

  /** tool.complete (main.js calls this when meta.diff or meta.path is present; pylons route the rest here too). */
  function onToolComplete(ev, msg) {
    const name = ev?.name || msg?.tool?.name;
    const path = pathOf(ev, msg); if (!path) return null;
    const node = ensure(path); if (!node) return null;
    const edited = EDIT_TOOLS.has(String(name || '')) || Boolean(ev?.meta?.diff);
    if (edited) {
      if (node.touched === 0 && !node.isDir) stats.touchedFiles++;
      node.touched++;
      node.mesh.material.color.setHex(COLOR.touched);
      if (!node.badge) { node.badge = makeTextSprite('', { widthM: 0.09, heightM: 0.04, width: 144, height: 64, fontPx: 34, weight: 700, color: '#052e16', bg: '#22C55E', maxLines: 1 }); node.badge.position.set(0.05, 0.05, 0); node.obj.add(node.badge); }
      node.badge.setText(String(node.touched));
      if (ev?.meta?.diff) showDiff(path, ev.meta.diff);
      refreshBadge();
      fx?.flash?.(node.mesh.material, ev?.ok === false ? '#EF4444' : '#86EFAC', 300);
    } else fx?.flash?.(node.mesh.material, ev?.ok === false ? '#EF4444' : '#22D3EE', 300);
    return node;
  }

  /** World position a packet should fly to for this tool call (the node, or the root). */
  function targetFor(ev, msg) {
    const path = pathOf(ev, msg);
    const node = (path && ensure(path)) || root;
    group.updateMatrixWorld(true);
    return node.obj.localToWorld(new THREE.Vector3(0, 0, 0));
  }

  function seedFromMessage(m) {
    if (!m || m.role !== 'tool_call' || !m.tool) return;
    if (!isFileTool(m.tool.name, m.tool.category)) return;
    const path = m.tool.args?.path || m.tool.meta?.path; if (path) ensure(path);
  }
  function seedAll() { for (const list of store?.messages?.values?.() || []) for (const m of list) seedFromMessage(m); }

  const offs = [];
  if (store?.on) {
    offs.push(store.on('snapshot', () => { setOrigin(); seedAll(); }));
    offs.push(store.on('pylons', setOrigin));
    offs.push(store.on('message.add', (ev) => { if (!ev.duplicate) seedFromMessage(ev.message); }));
    offs.push(store.on('tool.start', (ev) => { if (isFileTool(ev.name, ev.category) && ev.args?.path) ensure(ev.args.path); }));
  }
  setOrigin(); seedAll(); refreshBadge();

  function update(now) {
    if (card.mesh.visible && now > card.until) card.mesh.visible = false;
    if (app?.pylons?.parts?.files?.cube) app.pylons.parts.files.cube.visible = false;
  }

  return {
    root: group, group, nodes, card: card.mesh,
    update, onToolStart, onToolComplete, targetFor, ensure, segmentsOf,
    nodePosition(path) { const n = nodes.get(segmentsOf(path).join('/')); return n ? n.obj.localToWorld(new THREE.Vector3()) : null; },
    stats() { return { ...stats, diffVisible: card.mesh.visible, diffPath: card.path }; },
    dispose() {
      for (const off of offs) off();
      scene.remove(group);
      for (const n of nodes.values()) { n.label?.disposeText?.(); n.badge?.disposeText?.(); n.mesh?.material?.dispose?.(); n.line?.geometry?.dispose?.(); }
      badge.disposeText(); card.texture.dispose(); card.material.dispose(); geo.dir.dispose(); geo.root.dispose(); lineMat.dispose();
      nodes.clear();
    },
  };
}

export default { createFileTree, segmentsOf, MAX_DEPTH, MAX_NODES };
