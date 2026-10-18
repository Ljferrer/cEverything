// Pure pylon-map tests (PIN-56): no three, no DOM. Each case is named for the
// End state it proves in docs/plans/2026-10-17-obelisks-4-pylons.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pylonFor, isSpawning, shouldFire, diffCounts } from './pylon-map.js';

test('ES1 pylonFor maps every listed name, the browser_ prefix, mcp__ browser words, and everything else to other', () => {
  const expected = {
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
    // prefix and mcp rules
    browser_x: 'browser',
    mcp__Claude_Browser__navigate: 'browser',
    'mcp__claude-in-chrome__navigate': 'browser',
    mcp__x__browser_click: 'browser',
    mcp__x__list_files: 'other',
    // plain names match case-sensitively
    bash: 'other',
    // unknown and spawning
    no_such_tool: 'other',
    Agent: 'other',
    Workflow: 'other',
    Task: 'other',
    delegate_task: 'other',
  };
  for (const [name, pylon] of Object.entries(expected)) {
    assert.equal(pylonFor(name), pylon, `pylonFor(${JSON.stringify(name)})`);
  }
});

test('ES2 isSpawning is true for exactly Agent, Workflow, Task', () => {
  for (const name of ['Agent', 'Workflow', 'Task']) assert.equal(isSpawning(name), true, name);
  for (const name of ['Bash', 'web_search', 'Read', 'delegate_task']) assert.equal(isSpawning(name), false, name);
});

test('ES4 diffCounts counts a --- line after @@ as removed and returns zeros for any non-string', () => {
  const diff = ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '---x', ' ctx'].join('\n');
  assert.deepEqual(diffCounts(diff), { added: 0, removed: 1 });
  for (const bad of ['', undefined, null, 42, {}]) {
    assert.deepEqual(diffCounts(bad), { added: 0, removed: 0 }, `diffCounts(${String(bad)})`);
  }
});

test('ES7b diffCounts returns {added:2, removed:1} for the pinned fixture', () => {
  const diff = ['--- a/x', '+++ b/x', '@@ -1,2 +1,3 @@', '-old', '+new one', '+new two', ' ctx'].join('\n');
  assert.deepEqual(diffCounts(diff), { added: 2, removed: 1 });
});

test('ES8b shouldFire drops frames without an obelisk and spawning tools', () => {
  const start = (name) => ({ t: 'tool', sid: 's', id: 'i', name, phase: 'start', args: {} });
  assert.equal(shouldFire(start('web_search'), false), false);
  assert.equal(shouldFire(start('Agent'), true), false);
  assert.equal(shouldFire(start('web_search'), true), true);
});
