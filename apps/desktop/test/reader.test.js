'use strict';
// The reader shared by Review's pane and Catch up (renderer/reader.js, AK-381): its keys and helpers.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/reader.js');
const ev = (key, mods = {}) => ({ key, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: { closest: () => null }, prevented: 0, preventDefault() { this.prevented++; }, stopPropagation() {}, ...mods });

test('scrollDelta: ↑/↓ a few lines, Page Up/Down a page minus a few lines, nothing for other keys', async () => {
  const { scrollDelta, LINE } = await load();
  assert.equal(scrollDelta('reader.down', 600), 3 * LINE);
  assert.equal(scrollDelta('reader.up', 600), -3 * LINE);
  assert.equal(scrollDelta('reader.pageDown', 600), 600 - 3 * LINE);
  assert.equal(scrollDelta('reader.pageUp', 600), -(600 - 3 * LINE));
  assert.equal(scrollDelta('reader.pageDown', 10), LINE, 'a tiny reader still moves a line');
  assert.equal(scrollDelta('reader.next', 600), null);
});

test('navPos: "3 of 21" by id or key, 0 when the item is not in the list', async () => {
  const { navPos } = await load();
  assert.deepEqual(navPos([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'b'), { at: 2, of: 3 });
  assert.deepEqual(navPos([{ key: 'x' }, { key: 'y' }], 'y'), { at: 2, of: 2 });
  assert.deepEqual(navPos([{ id: 'a' }], 'z'), { at: 0, of: 1 });
  assert.deepEqual(navPos([], null), { at: 0, of: 0 });
});

test('readerKey: arrows scroll and never step, ←/→ step, , and . jump files, Esc goes back', async () => {
  const { readerKey } = await load();
  const calls = [];
  const scroller = { clientHeight: 500, scrollBy: (o) => calls.push(['scroll', o.top]) };
  const opts = { scroller, onStep: (d) => calls.push(['step', d]), onFile: (d) => calls.push(['file', d]), onBack: () => calls.push(['back']) };
  assert.equal(readerKey(ev('ArrowDown'), opts), 'reader.down');
  assert.equal(readerKey(ev('ArrowUp'), opts), 'reader.up');
  assert.equal(readerKey(ev(' '), opts), 'reader.pageDown');
  assert.equal(readerKey(ev(' ', { shiftKey: true }), opts), 'reader.pageUp');
  assert.equal(readerKey(ev('PageDown'), opts), 'reader.pageDown');
  assert.equal(readerKey(ev('ArrowRight'), opts), 'reader.next');
  assert.equal(readerKey(ev('ArrowLeft'), opts), 'reader.prev');
  assert.equal(readerKey(ev('.'), opts), 'reader.nextFile');
  assert.equal(readerKey(ev(','), opts), 'reader.prevFile');
  assert.equal(readerKey(ev('Escape'), opts), 'reader.back');
  assert.deepEqual(calls, [['scroll', 60], ['scroll', -60], ['scroll', 440], ['scroll', -440], ['scroll', 440], ['step', 1], ['step', -1], ['file', 1], ['file', -1], ['back']]);
  // Space on a focused button presses it; keys without a handler, and other keys, pass through.
  const onButton = ev(' ', { target: { closest: () => ({}) } });
  assert.equal(readerKey(onButton, opts), null);
  assert.equal(onButton.prevented, 0);
  assert.equal(readerKey(ev('.'), { scroller }), null);
  assert.equal(readerKey(ev('Enter'), opts), null);
  assert.equal(readerKey(ev('v'), opts), null);
});

test('the description keys are gone and the walk-through mode with them (AK-381)', async () => {
  const { command } = await import('../renderer/keymap.js');
  for (const id of ['review.description', 'catchup.description', 'lanes.description', 'catchup.walkNext', 'catchup.walkPrev', 'catchup.walkDone']) assert.equal(command(id), undefined, id);
  assert.ok(command('catchup.walk'), '⇧↵ still starts from the top');
});
