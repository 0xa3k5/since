'use strict';
// The avatar group's popover order (renderer/ui.js peopleOrder, AK-535).
const test = require('node:test');
const assert = require('node:assert/strict');

test('peopleOrder: agents first, then people; a header only above 8', async () => {
  const { peopleOrder, POP_ROWS } = await import('../renderer/ui.js');
  const people = [{ name: 'Ada' }, { name: 'Claude', agent: true }, { name: 'Linus' }];
  const { agents, humans, head } = peopleOrder(people);
  assert.deepEqual(agents.map((p) => p.name), ['Claude']);
  assert.deepEqual(humans.map((p) => p.name), ['Ada', 'Linus']);
  assert.equal(head, false);
  const many = Array.from({ length: POP_ROWS + 1 }, (_, i) => ({ name: `P${i}` }));
  assert.equal(peopleOrder(many).head, true);
  assert.equal(peopleOrder(many.slice(0, POP_ROWS)).head, false);
  assert.deepEqual(peopleOrder(), { agents: [], humans: [], head: false });
});
