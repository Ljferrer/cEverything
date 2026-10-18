// Pure tool-name helpers for the pylons feature (plan 4). Imports nothing from
// three (PIN-56) so `node --test` runs it bare. One table keys on tool names
// from every harness; the client never branches on harness name (PIN-19).

/** Pylon per plain tool name (PIN-12). Plain names match case-sensitively. */
const TABLE = Object.freeze({
  // Hermes
  web_search: 'browser',
  web_extract: 'browser',
  write_file: 'filesystem',
  patch: 'filesystem',
  read_file: 'filesystem',
  search_files: 'filesystem',
  terminal: 'shell',
  execute_code: 'shell',
  // Claude Code
  WebSearch: 'browser',
  WebFetch: 'browser',
  Read: 'filesystem',
  Edit: 'filesystem',
  Write: 'filesystem',
  Grep: 'filesystem',
  Glob: 'filesystem',
  NotebookEdit: 'filesystem',
  Bash: 'shell',
  // Codex
  shell: 'shell',
  local_shell: 'shell',
  exec_command: 'shell',
  exec: 'shell',
  apply_patch: 'filesystem',
});

/** The only case-insensitive rule: an `mcp__` name that names a browser tool. */
const MCP_BROWSER = /browser|chrome|playwright|puppeteer/i;

/** Tools that create an agent; they show as child obelisks, never projectiles (PIN-50). */
const SPAWNING = new Set(['Agent', 'Workflow', 'Task']);

export const PYLONS = Object.freeze(['browser', 'filesystem', 'shell', 'other']);

/** @returns {'browser'|'filesystem'|'shell'|'other'} */
export function pylonFor(name) {
  if (typeof name !== 'string') return 'other';
  if (Object.hasOwn(TABLE, name)) return TABLE[name];
  if (name.startsWith('browser_')) return 'browser';
  if (name.startsWith('mcp__') && MCP_BROWSER.test(name)) return 'browser';
  return 'other';
}

/** True for exactly `Agent`, `Workflow`, `Task`; `delegate_task` is not spawning (A5). */
export function isSpawning(name) {
  return SPAWNING.has(name);
}

/** The pure drop rule (PIN-50): no obelisk or a spawning tool means no projectile. */
export function shouldFire(frame, hasObelisk) {
  if (!hasObelisk) return false;
  return !isSpawning(frame?.name);
}

/**
 * Count `+`/`-` lines inside the hunks of a unified diff (PIN-54). `+++`/`---`
 * are headers only before the first `@@`; after it they count like any other
 * `+`/`-` line. Any non-string gives `{added:0, removed:0}`.
 */
export function diffCounts(diff) {
  let added = 0;
  let removed = 0;
  if (typeof diff !== 'string') return { added, removed };
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}
