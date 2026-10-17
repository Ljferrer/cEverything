// orchestrator (s_orch) + subagent (s_orch_child, parentId = s_orch): delegate_task twice; the child does
// read_file/patch work while the parent's delegate_task call is in flight; the parent summarizes.
import { SessionWriter, T0, diff, hunkStrings, hermes, patchedSummary } from './lib.mjs';

const FILETREE_V1 = `// web/scene/filetree.js — the "codebase" pylon: a tree of boxes built lazily from file paths seen in tool args.
import * as THREE from 'three';
import { makeTextSprite } from '../text/canvas-text.js';

export const LIMITS = { depth: 4, nodes: 40 };

export function createFileTree(scene, { root = new THREE.Vector3(0, 0.4, -3.2) } = {}) {
  const group = new THREE.Group();
  group.position.copy(root);
  scene.add(group);
  const nodes = new Map(); // path → { mesh, depth, children }

  function addPath(path) {
    // TODO: split path, create a node per level up to LIMITS.depth, stop at LIMITS.nodes
  }

  function flash(path) {
    const n = nodes.get(path);
    if (n) n.mesh.material.color.set(0xf59e0b);
  }

  return { group, addPath, flash, nodes };
}
`;

const GOAL_1 = 'Implement lazy file-tree building in web/scene/filetree.js: addPath(path) splits a repo-relative path, creates one node per directory level (max 4 levels, max 40 nodes total, dedupe by path), lays siblings out 0.25 m apart and levels 0.35 m apart below the root cube, draws parent→child THREE.Line segments, and labels files with a filename sprite. Dirs are 0.06 m wire cubes, files 0.05 m planes. Plain ES modules, three@0.170.0, MeshBasicMaterial only, no shadows. Verify with node --check.';
const CTX_1 = 'Spec: docs/PROTOCOL.md §5 "files (0, 0, −3.2) tree of boxes built lazily from paths seen in file tools (max 4 levels / 40 nodes)". Current stub: web/scene/filetree.js (addPath is a TODO). Paths arrive from tool.start events with category "files" (args.path). Do not touch other files.';
const GOAL_2 = 'Add showDiff(unifiedDiff, path) to web/scene/filetree.js: a 0.8×0.5 m plane at x = +1.2 m from the root at y = 1.2 that renders at most 24 lines of the diff on a canvas texture — lines starting with "+" in #22C55E, "−" in #EF4444, headers and context in gray — visible for 8 s or until the next call, and mark the touched node green with a touched-count badge. Reuse the canvas-text helper. Verify with node --check.';
const CTX_2 = 'The tree builder from the previous task is in place: nodes Map keyed by path with { mesh, depth, children, touched }. tool.complete events carry meta.diff (unified) and meta.path. Keep it under 120 lines; no new dependencies.';

export function build() {
  const p = new SessionWriter({
    id: 's_orch', title: 'orchestrator', status: 'idle', model: 'anthropic/claude-sonnet-4-5', gitBranch: 'feat/filetree-pylon',
    activity: 'idle', summary: 'Split the remaining pylon work: lazy file tree + diff card; delegate, review, summarize',
    startedAt: T0 - 30_000,
  }, { seed: 53, pace: 2.6 });
  const k = new SessionWriter({
    id: 's_orch_child', title: 'subagent · filetree.js', status: 'idle', model: 'anthropic/claude-sonnet-4-5',
    gitBranch: 'feat/filetree-pylon', parentId: 's_orch', activity: 'waiting for a task',
    summary: 'Implement lazy file-tree building in web/scene/filetree.js (delegated by orchestrator)',
    startedAt: T0 - 30_000,
  }, { seed: 59, pace: 2.0 });

  p.user(5000, 'Split the remaining pylon work: web/scene/filetree.js needs lazy node building from file paths seen in tool args (max 4 levels / 40 nodes), and the diff card needs to render unified diffs with colored +/− lines. Delegate what you can, check the results, and give me a summary I can paste into the standup.');
  p.status(500, 'thinking', 'thinking');
  let row = p.nextId();
  p.thinking(4800, 'Two pieces of the same file. The tree builder is self-contained and can be delegated with the exact constraints from PROTOCOL.md §5. The diff card depends on the node positions the builder creates, so it goes second with the first result as context. Read the spec lines and the current stub first so the goals are precise; a subagent knows nothing about this conversation.', { forId: row });
  p.status(300, 'tool', 'reading docs/PROTOCOL.md');
  let c = p.toolCall(600, 'read_file', { path: 'docs/PROTOCOL.md', offset: 242, limit: 4 }, { rowId: row });
  p.toolResult(700, c, { text: '242: - Pylons (defaults): browser (−2.5, 0, −1.0) octagonal prism 2.2 m with a wire sphere on top; terminal (+2.5, 0, −1.0) wire box\n243:   1.6 m with a "screen" plane showing the last command; files (0, 0, −3.2) tree of boxes built lazily from paths seen in file tools\n244:   (max 4 levels / 40 nodes) with a diff card (0.8×0.5 plane; `+` green, `−` red, max 24 lines, 8 s). Packet: 0.05 m cube along a\n245:   quadratic Bezier (control = midpoint + 1 m up), 600 ms out on `tool.start`, 600 ms back on `tool.complete`.', summary: '→ §5 pylons: files tree max 4 levels / 40 nodes; diff card 0.8×0.5, 24 lines, 8 s', meta: { path: 'docs/PROTOCOL.md' } });
  p.status(500, 'tool', 'searching web/scene');
  c = p.toolCall(900, 'search_files', { pattern: 'filetree|showDiff|addPath', path: 'web/scene', output_mode: 'content' });
  p.toolResult(800, c, { text: 'web/scene/filetree.js\n  13:   function addPath(path) {\n  14:     // TODO: split path, create a node per level up to LIMITS.depth, stop at LIMITS.nodes\nweb/scene/pylons.js\n  7: import { createFileTree } from \'./filetree.js\';\n  61:     if (ev.category === \'files\' && ev.args?.path) tree.addPath(ev.args.path);\nweb/main.js\n  28: import { createFileTree } from \'./scene/filetree.js\';\n\n5 matches in 3 files', summary: '→ 5 matches · addPath is a TODO, pylons.js already calls it' });
  c = p.toolCall(1100, 'read_file', { path: 'web/scene/filetree.js' });
  p.toolResult(600, c, { text: hermes.readFile(FILETREE_V1).text, summary: '→ 24 lines · stub with TODO in addPath', meta: { path: 'web/scene/filetree.js' } });
  p.status(600, 'tool', 'planning');
  c = p.toolCall(900, 'todo_list', { todos: [
    { id: '1', content: 'Delegate: lazy tree builder (addPath)', status: 'in_progress' },
    { id: '2', content: 'Delegate: diff card renderer (showDiff)', status: 'pending' },
    { id: '3', content: 'Review both results, write standup summary', status: 'pending' },
  ] });
  p.toolResult(300, c, { text: '[ ] 1. Delegate: lazy tree builder (addPath)  (in progress)\n[ ] 2. Delegate: diff card renderer (showDiff)\n[ ] 3. Review both results, write standup summary', summary: '→ 3 todos tracked' });

  // ---- delegation 1 --------------------------------------------------------
  p.status(700, 'tool', 'delegating: lazy tree builder');
  const d1 = p.toolCall(1200, 'delegate_task', { tasks: [{ goal: GOAL_1, context: CTX_1 }] });
  const T_D1 = p.t;

  k.user(k.until(T_D1 + 900), `${GOAL_1}\n\nContext: ${CTX_1}`, { via: 'agent' });
  k.status(400, 'thinking', 'thinking');
  let krow = k.nextId();
  k.thinking(3600, 'Read the stub first; the Map keyed by path and the LIMITS constant are already there, so the work is addPath plus a layout pass. Keep positions deterministic: siblings sorted by name so the tree does not reshuffle when a new path arrives.', { forId: krow });
  k.status(300, 'tool', 'reading web/scene/filetree.js');
  let kc = k.toolCall(500, 'read_file', { path: 'web/scene/filetree.js' }, { rowId: krow });
  k.toolResult(600, kc, { text: hermes.readFile(FILETREE_V1).text, summary: '→ 24 lines', meta: { path: 'web/scene/filetree.js' } });
  krow = k.nextId();
  k.status(900, 'thinking', 'thinking');
  k.thinking(5200, 'Plan: addPath splits on "/", walks the segments creating a node per level up to LIMITS.depth (deeper segments collapse into the last allowed level), stops when nodes.size reaches LIMITS.nodes, then calls layout(). layout() positions each depth level at −0.35 m per level below the root and spreads siblings 0.25 m apart centred on the parent, and rebuilds the parent→child Line segments into one LineSegments geometry so it stays one draw call.', { forId: krow });
  k.status(400, 'tool', 'editing web/scene/filetree.js');
  const KH1 = { old: 13, new: 13, ctx: 'export function createFileTree(scene, { root = new THREE.Vector3(0, 0.4, -3.2) } = {}) {', lines: [
    '   function addPath(path) {',
    '-    // TODO: split path, create a node per level up to LIMITS.depth, stop at LIMITS.nodes',
    '+    const parts = String(path).replace(/^\\.?\\//, \'\').split(\'/\').filter(Boolean);',
    '+    if (!parts.length) return null;',
    '+    let parent = rootNode, key = \'\', node = null;',
    '+    for (let i = 0; i < parts.length; i++) {',
    '+      const depth = Math.min(i + 1, LIMITS.depth);',
    '+      key = i < LIMITS.depth ? (key ? `${key}/${parts[i]}` : parts[i]) : `${key}/${parts.slice(i).join(\'/\')}`;',
    '+      node = nodes.get(key);',
    '+      if (!node) {',
    '+        if (nodes.size >= LIMITS.nodes) return parent;',
    '+        const isFile = i === parts.length - 1;',
    '+        node = { key, name: parts[i], depth, isFile, parent, children: [], touched: 0, mesh: makeMesh(isFile, parts[i]) };',
    '+        parent.children.push(node);',
    '+        nodes.set(key, node);',
    '+        group.add(node.mesh);',
    '+      }',
    '+      parent = node;',
    '+      if (i >= LIMITS.depth - 1) break;',
    '+    }',
    '+    layout();',
    '+    return node;',
    '   }',
  ] };
  const KD1 = diff('web/scene/filetree.js', [KH1]);
  kc = k.toolCall(900, 'patch', { path: 'web/scene/filetree.js', ...hunkStrings(KH1) }, { rowId: krow, meta: { path: 'web/scene/filetree.js', diff: KD1 } });
  k.toolResult(700, kc, { text: hermes.patch(KD1).text, summary: patchedSummary(KD1) });
  const KH2 = { old: 37, new: 37, lines: [
    '   function flash(path) {',
    '-    const n = nodes.get(path);',
    '+    const n = nodes.get(String(path).replace(/^\\.?\\//, \'\'));',
    '     if (n) n.mesh.material.color.set(0xf59e0b);',
    '   }',
    ' ',
    '+  const rootNode = { key: \'\', depth: 0, children: [], mesh: makeMesh(false, \'\') };',
    '+  group.add(rootNode.mesh);',
    '+  const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x6b7280 }));',
    '+  group.add(lines);',
    '+',
    '+  function makeMesh(isFile, name) {',
    '+    const mat = new THREE.MeshBasicMaterial({ color: 0x9ca3af, wireframe: !isFile });',
    '+    const mesh = isFile ? new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.05), mat)',
    '+                        : new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), mat);',
    '+    if (isFile && name) { const s = makeTextSprite(name, { px: 24 }); s.position.y = 0.045; mesh.add(s); }',
    '+    return mesh;',
    '+  }',
    '+',
    '+  function layout() {',
    '+    const pts = [];',
    '+    const place = (n, x) => {',
    '+      n.mesh.position.set(x, -0.35 * n.depth, 0);',
    '+      const kids = [...n.children].sort((a, b) => a.name.localeCompare(b.name));',
    '+      const w = (kids.length - 1) * 0.25;',
    '+      kids.forEach((kid, i) => { place(kid, x - w / 2 + i * 0.25); pts.push(n.mesh.position, kid.mesh.position); });',
    '+    };',
    '+    place(rootNode, 0);',
    '+    lines.geometry.setFromPoints(pts);',
    '+  }',
    '+',
    '-  return { group, addPath, flash, nodes };',
    '+  return { group, addPath, flash, nodes, layout };',
    ' }',
  ] };
  const KD2 = diff('web/scene/filetree.js', [KH2]);
  kc = k.toolCall(1300, 'patch', { path: 'web/scene/filetree.js', ...hunkStrings(KH2) }, { meta: { path: 'web/scene/filetree.js', diff: KD2 } });
  k.toolResult(800, kc, { text: hermes.patch(KD2).text, summary: patchedSummary(KD2) });
  k.status(500, 'tool', 'running: node --check');
  kc = k.toolCall(800, 'terminal', { command: 'node --check web/scene/filetree.js && wc -l web/scene/filetree.js' });
  k.toolResult(1100, kc, { text: hermes.terminal('67 web/scene/filetree.js\n').text, summary: '→ exit 0 · 67 lines, syntax ok', meta: { command: kc.args.command, exitCode: 0 } });
  k.status(700, 'responding', 'responding');
  k.assistant(1400, 'Implemented `addPath()` and `layout()` in web/scene/filetree.js. Paths split on "/", one node per level up to 4 (deeper segments collapse into level 4), hard stop at 40 nodes, dedupe by path key. Directories are 0.06 m wire cubes, files 0.05 m planes with a filename sprite; levels sit 0.35 m apart below the root, siblings 0.25 m apart sorted by name so the tree never reshuffles; parent→child edges are one LineSegments. `node --check` passes; 67 lines. Nothing else touched.');
  k.status(600, 'idle', 'idle');

  // parent receives the delegation result
  p.toolResult(p.until(k.t + 700), d1, {
    text: `[task 1/1] completed in 38 s · 4 tool calls\n\nImplemented addPath() and layout() in web/scene/filetree.js. Paths split on "/", one node per level up to 4 (deeper segments collapse into level 4), hard stop at 40 nodes, dedupe by path key. Directories are 0.06 m wire cubes, files 0.05 m planes with a filename sprite; levels 0.35 m apart below the root, siblings 0.25 m apart sorted by name; parent→child edges are one LineSegments. node --check passes; 67 lines.`,
    summary: '→ subagent completed · addPath + layout landed (67 lines)',
  });
  p.status(900, 'responding', 'responding');
  p.assistant(1100, 'Tree builder landed: `addPath()` with the 4-level / 40-node caps and a deterministic layout. Checking the file before I hand off the diff card.');
  p.status(400, 'tool', 'reading web/scene/filetree.js');
  c = p.toolCall(1500, 'read_file', { path: 'web/scene/filetree.js', offset: 13, limit: 12 });
  p.toolResult(600, c, { text: '13:   function addPath(path) {\n14:     const parts = String(path).replace(/^\\.?\\//, \'\').split(\'/\').filter(Boolean);\n15:     if (!parts.length) return null;\n16:     let parent = rootNode, key = \'\', node = null;\n17:     for (let i = 0; i < parts.length; i++) {\n18:       const depth = Math.min(i + 1, LIMITS.depth);\n19:       key = i < LIMITS.depth ? (key ? `${key}/${parts[i]}` : parts[i]) : `${key}/${parts.slice(i).join(\'/\')}`;\n20:       node = nodes.get(key);\n21:       if (!node) {\n22:         if (nodes.size >= LIMITS.nodes) return parent;\n23:         const isFile = i === parts.length - 1;\n24:         node = { key, name: parts[i], depth, isFile, parent, children: [], touched: 0, mesh: makeMesh(isFile, parts[i]) };', summary: '→ addPath as described; nodes carry touched counter', meta: { path: 'web/scene/filetree.js' } });
  row = p.nextId();
  p.status(800, 'thinking', 'thinking');
  p.thinking(3900, 'The node objects already carry a touched counter, so the diff card task can reuse them. Hand off the second task with the exact geometry from the spec and the shape of the nodes Map as context.', { forId: row });

  // ---- delegation 2 --------------------------------------------------------
  p.status(400, 'tool', 'delegating: diff card renderer');
  const d2 = p.toolCall(900, 'delegate_task', { tasks: [{ goal: GOAL_2, context: CTX_2 }] }, { rowId: row });
  const T_D2 = p.t;

  k.user(k.until(T_D2 + 900), `${GOAL_2}\n\nContext: ${CTX_2}`, { via: 'agent' });
  k.status(400, 'thinking', 'thinking');
  krow = k.nextId();
  k.thinking(4100, 'The card is a CanvasTexture on a 0.8×0.5 plane; 24 lines at 20 px on a 512×320 canvas fits. Colour per line prefix, cap at 24 lines with a "+N more" footer, clear after 8 s with a timer that the next call resets. Mark the touched node green and bump its badge.', { forId: krow });
  k.status(300, 'tool', 'reading web/text/canvas-text.js');
  kc = k.toolCall(600, 'read_file', { path: 'web/text/canvas-text.js', offset: 1, limit: 12 }, { rowId: krow });
  k.toolResult(500, kc, { text: '1: // web/text/canvas-text.js — word-wrap + measure, CanvasTexture factory, LRU cache (96).\n2: import * as THREE from \'three\';\n3: \n4: export function makeCanvas(w, h) { const c = document.createElement(\'canvas\'); c.width = w; c.height = h; return c; }\n5: export function makeTexture(canvas) { const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; return t; }\n6: export function makeTextSprite(text, { px = 32, color = \'#e5e7eb\' } = {}) {\n7:   const c = makeCanvas(512, 128); const ctx = c.getContext(\'2d\');\n8:   ctx.font = `${px}px system-ui, sans-serif`; ctx.fillStyle = color; ctx.textBaseline = \'middle\';\n9:   ctx.fillText(text, 8, 64);\n10:   const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeTexture(c), transparent: true }));\n11:   s.scale.set(0.36, 0.09, 1); return s;\n12: }', summary: '→ makeCanvas / makeTexture / makeTextSprite available', meta: { path: 'web/text/canvas-text.js' } });
  k.status(800, 'tool', 'editing web/scene/filetree.js');
  const KH3 = { old: 63, new: 63, lines: [
    '     lines.geometry.setFromPoints(pts);',
    '   }',
    ' ',
    '+  // Diff card: 0.8×0.5 plane right of the root, max 24 lines, 8 s.',
    '+  const card = makeCanvas(512, 320);',
    '+  const cardTex = makeTexture(card);',
    '+  const cardMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), new THREE.MeshBasicMaterial({ map: cardTex, transparent: true }));',
    '+  cardMesh.position.set(1.2, 0.8, 0); cardMesh.visible = false; group.add(cardMesh);',
    '+  let hideTimer = 0;',
    '+  function showDiff(unified, path) {',
    '+    const all = String(unified || \'\').split(\'\\n\');',
    '+    const shown = all.slice(0, 24);',
    '+    const ctx = card.getContext(\'2d\');',
    '+    ctx.fillStyle = \'rgba(11,15,20,0.92)\'; ctx.fillRect(0, 0, 512, 320);',
    '+    ctx.font = \'12px ui-monospace, monospace\'; ctx.textBaseline = \'top\';',
    '+    shown.forEach((l, i) => {',
    '+      ctx.fillStyle = l.startsWith(\'+\') && !l.startsWith(\'+++\') ? \'#22C55E\' : l.startsWith(\'-\') && !l.startsWith(\'---\') ? \'#EF4444\' : \'#9CA3AF\';',
    '+      ctx.fillText(l.slice(0, 70), 6, 4 + i * 13);',
    '+    });',
    '+    if (all.length > 24) { ctx.fillStyle = \'#6B7280\'; ctx.fillText(`… +${all.length - 24} more lines`, 6, 4 + 24 * 13); }',
    '+    cardTex.needsUpdate = true; cardMesh.visible = true;',
    '+    clearTimeout(hideTimer); hideTimer = setTimeout(() => { cardMesh.visible = false; }, 8000);',
    '+    const n = path ? (nodes.get(String(path).replace(/^\\.?\\//, \'\')) || addPath(path)) : null;',
    '+    if (n) { n.touched++; n.mesh.material.color.set(0x22c55e); setBadge(n); }',
    '+  }',
    '+  function setBadge(n) {',
    '+    if (n.badge) n.mesh.remove(n.badge);',
    '+    n.badge = makeTextSprite(String(n.touched), { px: 28, color: \'#22C55E\' });',
    '+    n.badge.position.set(0.05, 0.05, 0); n.badge.scale.set(0.08, 0.04, 1); n.mesh.add(n.badge);',
    '+  }',
    '+',
    '-  return { group, addPath, flash, nodes, layout };',
    '+  return { group, addPath, flash, nodes, layout, showDiff };',
    ' }',
  ] };
  const KD3 = diff('web/scene/filetree.js', [KH3]);
  kc = k.toolCall(1200, 'patch', { path: 'web/scene/filetree.js', ...hunkStrings(KH3) }, { meta: { path: 'web/scene/filetree.js', diff: KD3 } });
  k.toolResult(800, kc, { text: hermes.patch(KD3).text, summary: patchedSummary(KD3) });
  const KD4 = diff('web/scene/filetree.js', [{ old: 2, new: 2, lines: [
    " import * as THREE from 'three';",
    "-import { makeTextSprite } from '../text/canvas-text.js';",
    "+import { makeCanvas, makeTexture, makeTextSprite } from '../text/canvas-text.js';",
  ] }]);
  kc = k.toolCall(700, 'patch', { path: 'web/scene/filetree.js', old_string: "import { makeTextSprite } from '../text/canvas-text.js';", new_string: "import { makeCanvas, makeTexture, makeTextSprite } from '../text/canvas-text.js';" }, { meta: { path: 'web/scene/filetree.js', diff: KD4 } });
  k.toolResult(500, kc, { text: hermes.patch(KD4).text, summary: patchedSummary(KD4) });
  k.status(500, 'tool', 'running: node --check');
  kc = k.toolCall(700, 'terminal', { command: 'node --check web/scene/filetree.js && wc -l web/scene/filetree.js' });
  k.toolResult(1000, kc, { text: hermes.terminal('95 web/scene/filetree.js\n').text, summary: '→ exit 0 · 95 lines, syntax ok', meta: { command: kc.args.command, exitCode: 0 } });
  k.status(600, 'responding', 'responding');
  k.assistant(1300, 'Added `showDiff(unified, path)`: a 0.8×0.5 m canvas plane at (+1.2, 0.8) relative to the root, 24 lines max with a "+N more" footer, `+` lines #22C55E, `−` lines #EF4444, headers/context #9CA3AF; hidden after 8 s or replaced by the next call. The touched node turns green and gets a touched-count badge sprite; unknown paths are added to the tree first. Import of makeCanvas/makeTexture added. `node --check` passes; 95 lines, under the 120-line budget.');
  k.status(500, 'done', 'done');
  k.upsert(0, { status: 'done', endReason: 'completed', activity: 'done' });

  p.toolResult(p.until(k.t + 700), d2, {
    text: '[task 1/1] completed in 24 s · 4 tool calls\n\nAdded showDiff(unified, path): a 0.8×0.5 m canvas plane at (+1.2, 0.8) relative to the root, 24 lines max with a "+N more" footer, + lines #22C55E, − lines #EF4444, headers/context #9CA3AF; hidden after 8 s or replaced by the next call. The touched node turns green and gets a touched-count badge; unknown paths are added to the tree first. node --check passes; 95 lines.',
    summary: '→ subagent completed · showDiff + badge landed (95 lines)',
  });
  p.status(800, 'tool', 'planning');
  c = p.toolCall(900, 'todo_list', { todos: [
    { id: '1', content: 'Delegate: lazy tree builder (addPath)', status: 'completed' },
    { id: '2', content: 'Delegate: diff card renderer (showDiff)', status: 'completed' },
    { id: '3', content: 'Review both results, write standup summary', status: 'in_progress' },
  ] });
  p.toolResult(300, c, { text: '[x] 1. Delegate: lazy tree builder (addPath)\n[x] 2. Delegate: diff card renderer (showDiff)\n[ ] 3. Review both results, write standup summary  (in progress)', summary: '→ 2 of 3 todos completed' });
  p.status(700, 'responding', 'responding');
  p.assistant(1200, `Standup summary — files pylon

- **Done**: \`web/scene/filetree.js\` now builds the codebase tree lazily from paths seen in file tools: \`addPath()\` with the §5 caps (4 levels, 40 nodes), deterministic layout (0.35 m per level, 0.25 m between siblings, sorted), one LineSegments for edges. 
- **Done**: \`showDiff(unified, path)\` renders the diff card (0.8×0.5 m, 24 lines, + green / − red, 8 s) and marks the touched node green with a count badge.
- **Wiring left**: \`pylons.js\` already calls \`addPath\` on \`tool.start\`; it still needs \`tree.showDiff(ev.meta.diff, ev.meta.path)\` on \`tool.complete\` (one line). 
- **Risk**: 40 nodes fill up fast on the readme session; consider pruning files never touched twice.
- Two subagent runs, 8 tool calls, 95 lines total, \`node --check\` green on both.`, { stream: { lo: 30, hi: 60, dtLo: 30, dtHi: 70 } });
  p.status(800, 'idle', 'idle');
  return [p, k];
}
