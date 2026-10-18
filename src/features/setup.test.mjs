// setup.js's pure helpers: the pick key, the include command, and the picked set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickKey, includeCommand, pickedOf } from './setup.js';

const chats = ['a', 'b', 'c'].map((sid) => ({ sid, harness: 'claude', title: sid, status: 'idle', agents: 0 }));

test('every chat checked sends null, so chats that appear later still show', () => {
  assert.deepEqual(includeCommand(new Set(['a', 'b', 'c']), chats), { t: 'include', sids: null });
  assert.deepEqual(includeCommand(new Set(['c', 'a']), chats), { t: 'include', sids: ['a', 'c'] }, 'listed in the chat order');
});

test('the pick key ignores order and tells all from a list', () => {
  assert.equal(pickKey(['b', 'a']), pickKey(['a', 'b']));
  assert.notEqual(pickKey(null), pickKey(['a', 'b', 'c']));
});

test('a null pick shows every listed chat; a list shows only the listed chats it names', () => {
  assert.deepEqual([...pickedOf(null, chats)], ['a', 'b', 'c']);
  assert.deepEqual([...pickedOf(['b', 'gone'], chats)], ['b']);
});
