'use strict';
// The resolve sheet's footer order (renderer/ui.js sheetActions, AK-579).
const test = require('node:test');
const assert = require('node:assert/strict');

test('sheetActions: the first action is the primary and sits rightmost', async () => {
  const { sheetActions } = await import('../renderer/ui.js');
  const out = sheetActions([{ id: 'go', label: 'Switch and merge' }, null, { id: 'keep', label: 'Merge, keep branch' }]);
  assert.deepEqual(out.map((a) => [a.id, a.primary]), [['keep', false], ['go', true]]);
  assert.deepEqual(sheetActions([{ id: 'one' }]).map((a) => [a.id, a.primary]), [['one', true]]);
  assert.deepEqual(sheetActions(), []);
});
