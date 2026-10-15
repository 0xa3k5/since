'use strict';
// Back and forward navigation history (renderer/nav.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const at = (key, extra = {}) => ({ key, ...extra });

test('starts with nowhere to go', async () => {
  const { createNav } = await import('../renderer/nav.js');
  const nav = createNav();
  assert.equal(nav.canBack, false);
  assert.equal(nav.canForward, false);
  assert.equal(nav.back(at('map')), null);
  assert.equal(nav.forward(at('map')), null);
  assert.equal(nav.canForward, false, 'a failed step records nothing');
});

test('Lanes → open a lane → Map: back returns to Lanes with its row and filter, forward goes to Map again', async () => {
  const { createNav } = await import('../renderer/nav.js');
  const nav = createNav();
  const lanes = at('lanes', { lanes: { key: 'b:feature', filter: 'feat' } });
  assert.equal(nav.record(lanes, 'map'), true);
  assert.equal(nav.canBack, true);
  const map = at('map', { selected: 'abc' });
  const back = nav.back(map);
  assert.deepEqual(back, lanes);
  assert.equal(nav.canBack, false);
  assert.equal(nav.canForward, true);
  assert.deepEqual(nav.forward(back), map);
  assert.equal(nav.canForward, false);
  assert.equal(nav.canBack, true);
});

test('a jump to the same place records nothing', async () => {
  const { createNav } = await import('../renderer/nav.js');
  const nav = createNav();
  assert.equal(nav.record(at('map'), 'map'), false);
  assert.equal(nav.record(null, 'map'), false);
  assert.equal(nav.canBack, false);
});

test('a new jump after going back drops the forward steps, like a browser', async () => {
  const { createNav } = await import('../renderer/nav.js');
  const nav = createNav();
  nav.record(at('map'), 'commit');
  nav.record(at('commit'), 'lanes');
  nav.back(at('lanes'));
  assert.equal(nav.canForward, true);
  nav.record(at('commit'), 'stashes');
  assert.equal(nav.canForward, false);
  assert.deepEqual(nav.back(at('stashes')), at('commit'));
  assert.deepEqual(nav.back(at('commit')), at('map'));
  assert.equal(nav.canBack, false);
});

test('keeps at most `limit` steps back, dropping the oldest', async () => {
  const { createNav, NAV_LIMIT } = await import('../renderer/nav.js');
  assert.equal(NAV_LIMIT, 100);
  const nav = createNav(3);
  for (let i = 0; i < 5; i++) nav.record(at(`v${i}`), `v${i + 1}`);
  const seen = [];
  let here = at('v5');
  for (let to; (to = nav.back(here)); here = to) seen.push(to.key);
  assert.deepEqual(seen, ['v4', 'v3', 'v2']);
});

test('clear forgets both directions (switching repositories)', async () => {
  const { createNav } = await import('../renderer/nav.js');
  const nav = createNav();
  nav.record(at('map'), 'commit');
  nav.record(at('commit'), 'lanes');
  nav.back(at('lanes'));
  nav.clear();
  assert.equal(nav.canBack, false);
  assert.equal(nav.canForward, false);
});
