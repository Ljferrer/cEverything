// PURE tool-call / tool-result description: ToolMeta extraction, previews, summaries, activity lines. No Node imports.

import { CATEGORY_OF_TOOL } from '../protocol.js';
import { SUMMARY_MAX, clip, parseJSONish, hostOf, firstLine } from './text.js';
import { composeUnifiedDiff, diffStats } from './diff.js';

function argPath(args) {
  return args.path || args.file_path || args.filename || args.file || args.target_file || args.dir || args.directory || '';
}

/** Extract ToolMeta + preview + summary for a tool call (args only; result adds exitCode). */
export function describeToolCall(name, args = {}) {
  const n = String(name || 'tool');
  const a = args && typeof args === 'object' ? args : {};
  const meta = {};
  let preview = '';
  let summary = '';
  switch (true) {
    case n === 'patch' || n === 'edit_file': {
      const path = argPath(a);
      if (path) meta.path = path;
      if (typeof a.diff === 'string' && a.diff.trim()) {
        meta.diff = a.diff;
      } else if (a.old_string !== undefined || a.new_string !== undefined) {
        meta.diff = composeUnifiedDiff(path, a.old_string ?? '', a.new_string ?? '').diff;
      }
      const st = meta.diff ? diffStats(meta.diff) : { added: 0, removed: 0 };
      summary = `patch ${path || '?'} (+${st.added} −${st.removed})`;
      preview = path;
      break;
    }
    case n === 'write_file': {
      const path = argPath(a);
      if (path) meta.path = path;
      const content = typeof a.content === 'string' ? a.content : (typeof a.text === 'string' ? a.text : '');
      const { diff, added } = composeUnifiedDiff(path, '', content);
      if (content) meta.diff = diff;
      summary = `write_file ${path || '?'} (+${added})`;
      preview = path;
      break;
    }
    case n === 'read_file': {
      const path = argPath(a);
      if (path) meta.path = path;
      summary = `read_file ${path || '?'}`;
      preview = path;
      break;
    }
    case n === 'search_files' || n === 'list_files': {
      const q = a.pattern || a.query || a.regex || argPath(a) || '';
      if (q) meta.query = String(q);
      const path = argPath(a);
      if (path && q !== path) meta.path = path;
      summary = `${n} "${clip(q, 50)}"`;
      preview = String(q);
      break;
    }
    case n === 'web_search': {
      const q = a.query || a.q || a.search || '';
      meta.query = String(q);
      summary = `web_search "${clip(q, 60)}"`;
      preview = String(q);
      break;
    }
    case n === 'web_extract' || n === 'web_fetch' || n.startsWith('browser_'): {
      const url = a.url || (Array.isArray(a.urls) ? a.urls[0] : '') || a.href || '';
      if (url) meta.url = String(url);
      const shown = url ? hostOf(url) : clip(a.text || a.selector || a.action || '', 40);
      summary = `${n} ${clip(shown, 60)}`.trim();
      preview = shown;
      break;
    }
    case n === 'terminal' || n === 'bash' || n === 'shell': {
      const cmd = a.command || a.cmd || a.input || '';
      meta.command = String(cmd);
      summary = `$ ${clip(cmd, 80)}`;
      preview = clip(cmd, 60);
      break;
    }
    case n === 'execute_code': {
      const code = a.code || a.source || '';
      meta.command = firstLine(code);
      summary = `execute_code ${clip(firstLine(code), 70)}`.trim();
      preview = clip(firstLine(code), 60);
      break;
    }
    case n === 'process_manage': {
      summary = `process ${clip(a.action || a.command || '', 40)} ${clip(a.pid || a.name || '', 30)}`.trim();
      preview = summary;
      break;
    }
    case n === 'delegate_task': {
      // §3g: delegate_task {goal} | {tasks:[{goal,…}]}
      const tasks = Array.isArray(a.tasks) ? a.tasks : [];
      const first = tasks[0];
      const t = a.task || a.goal || a.prompt || a.description || (first && typeof first === 'object' ? first.goal || first.task || first.prompt || '' : typeof first === 'string' ? first : '');
      summary = tasks.length > 1 ? `delegate ×${tasks.length} "${clip(t, 60)}"` : `delegate "${clip(t, 70)}"`;
      preview = clip(t, 60);
      break;
    }
    case n === 'todo_list' || n === 'todo': {
      // §3g: todo_list {todos}
      const todos = Array.isArray(a.todos) ? a.todos : [];
      const first = todos[0];
      const label = typeof first === 'string' ? first : first && typeof first === 'object' ? first.content || first.title || first.task || first.text || '' : (a.action || a.content || '');
      summary = `${n}${todos.length ? ` (${todos.length})` : ''} ${clip(label, 50)}`.trim();
      preview = clip(label, 60);
      break;
    }
    case n === 'clarify' || n === 'ask_user': {
      const q = a.question || a.prompt || a.text || '';
      summary = `clarify "${clip(q, 70)}"`;
      preview = clip(q, 60);
      break;
    }
    case n === 'memory': {
      summary = `memory ${clip(a.action || a.op || '', 20)} ${clip(a.key || a.content || a.query || '', 50)}`.trim();
      preview = clip(a.content || a.query || a.key || '', 60);
      break;
    }
    case n === 'send_message': {
      summary = `send_message → ${clip(a.to || a.channel || a.recipient || '', 30)} ${clip(a.text || a.message || '', 40)}`.trim();
      preview = clip(a.text || a.message || '', 60);
      break;
    }
    case n.startsWith('image_') || n.startsWith('vision_') || n.startsWith('video_'): {
      summary = `${n} "${clip(a.prompt || a.description || argPath(a), 60)}"`;
      preview = clip(a.prompt || argPath(a), 60);
      break;
    }
    default: {
      const keys = Object.keys(a);
      const firstVal = keys.length ? a[keys[0]] : '';
      const shown = typeof firstVal === 'string' ? firstVal : JSON.stringify(firstVal ?? '');
      summary = keys.length ? `${n} ${clip(shown, 60)}` : n;
      preview = clip(shown, 60);
    }
  }
  return { meta, preview: clip(preview, 60), summary: clip(summary, SUMMARY_MAX) };
}

/** A unified diff carried by a tool result (Hermes patch/write_file results: `diff` / `inline_diff`), or undefined. */
export function diffFromResult(json) {
  if (!json || typeof json !== 'object') return undefined;
  for (const d of [json.inline_diff, json.diff, json.unified_diff, json.data?.diff]) {
    if (typeof d === 'string' && /(^|\n)(@@ |\+\+\+ |--- )/.test(d)) return d;
  }
  return undefined;
}

/** Parse a tool result row's content for success + exit code (+ a unified diff when the result carries one). */
export function describeToolResult(name, content) {
  const text = typeof content === 'string' ? content : (content == null ? '' : JSON.stringify(content));
  let ok = true;
  let exitCode;
  let diff;
  const json = parseJSONish(text, null);
  if (json && typeof json === 'object') {
    if (json.success === false || json.ok === false || (json.error && json.error !== false)) ok = false;
    const ec = json.exit_code ?? json.exitCode ?? json.returncode ?? json.status;
    if (typeof ec === 'number') { exitCode = ec; if (ec !== 0) ok = false; }
    diff = diffFromResult(json);
  } else {
    const m = text.match(/\b(?:exit code|exit status|exited with|exit_code)[:= ]+(-?\d+)/i);
    if (m) { exitCode = Number(m[1]); if (exitCode !== 0) ok = false; }
    if (/^\s*(error|traceback|exception|failed|fatal)\b/i.test(text) || /\berror\s*:/i.test(text.slice(0, 200))) ok = false;
  }
  const cat = CATEGORY_OF_TOOL(name);
  let summary;
  if (cat === 'coding' && exitCode !== undefined) summary = `${name} → exit ${exitCode}`;
  else if (!ok) summary = `${name} ✗ ${clip(firstLine(text), 60)}`;
  else if (diff) { const st = diffStats(diff); summary = `${name} ✓ (+${st.added} −${st.removed})`; }
  else summary = `${name} ✓ ${clip(firstLine(text), 70)}`;
  const out = { ok, exitCode, summary: clip(summary, SUMMARY_MAX) };
  if (diff) out.diff = diff;
  return out;
}

/** Human activity line for the glance panel. */
export function activityForTool(name, meta = {}, args = {}) {
  const cat = CATEGORY_OF_TOOL(name);
  if (cat === 'web') return meta.url ? `browsing: ${clip(hostOf(meta.url), 60)}` : `searching: ${clip(meta.query || args.query || '', 60)}`;
  if (cat === 'files') {
    if (name === 'read_file') return `reading ${clip(meta.path || '', 60)}`;
    if (name === 'search_files') return `searching files: ${clip(meta.query || '', 50)}`;
    return `editing ${clip(meta.path || '', 60)}`;
  }
  if (cat === 'coding') return `running: ${clip(meta.command || '', 60)}`;
  if (cat === 'delegating') return 'delegating a subtask';
  if (cat === 'waiting') return 'waiting for your answer';
  if (cat === 'memory') return 'recalling memory';
  if (cat === 'images') return 'working with images';
  if (cat === 'messaging') return 'sending a message';
  return `using ${name}`;
}

