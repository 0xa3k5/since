'use strict';
// Sidebar modes: window width × saved choice × overlay state (renderer/sidebar.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/sidebar.js');

test('wide windows follow the saved choice and ignore overlay state', async () => {
  const { sidebarMode, SIDEBAR_BREAKPOINT: bp } = await load();
  assert.equal(sidebarMode({ width: bp, expanded: true }), 'expanded');
  assert.equal(sidebarMode({ width: 1600, expanded: false }), 'rail');
  assert.equal(sidebarMode({ width: 1600, expanded: false, pinned: true, hover: true }), 'rail');
  assert.equal(sidebarMode({ width: 1600, expanded: true, hover: true }), 'expanded');
});

test('narrow windows show the rail, or the overlay when pinned or hovered', async () => {
  const { sidebarMode, SIDEBAR_BREAKPOINT: bp } = await load();
  for (const expanded of [true, false]) {
    assert.equal(sidebarMode({ width: bp - 1, expanded }), 'rail');
    assert.equal(sidebarMode({ width: 800, expanded, hover: true }), 'overlay');
    assert.equal(sidebarMode({ width: 800, expanded, pinned: true }), 'overlay');
  }
});

test('breakpoint is 1100 px', async () => {
  const { SIDEBAR_BREAKPOINT, isNarrow } = await load();
  assert.equal(SIDEBAR_BREAKPOINT, 1100);
  assert.equal(isNarrow(1099), true);
  assert.equal(isNarrow(1100), false);
});

test('toggle flips the saved choice on wide windows', async () => {
  const { toggleSidebarState } = await load();
  assert.deepEqual(toggleSidebarState({ expanded: true, pinned: false, hover: false }, 1400), { expanded: false, pinned: false, hover: false });
  assert.deepEqual(toggleSidebarState({ expanded: false, pinned: true, hover: false }, 1400), { expanded: true, pinned: false, hover: false });
});

test('toggle pins and unpins the overlay on narrow windows without touching the saved choice', async () => {
  const { toggleSidebarState } = await load();
  assert.deepEqual(toggleSidebarState({ expanded: true, pinned: false, hover: false }, 900), { expanded: true, pinned: true, hover: false });
  assert.deepEqual(toggleSidebarState({ expanded: false, pinned: true, hover: false }, 900), { expanded: false, pinned: false, hover: false });
  // Opened by hover: the toggle pins it.
  assert.deepEqual(toggleSidebarState({ expanded: true, pinned: false, hover: true }, 900), { expanded: true, pinned: true, hover: false });
});

test('shrinking and growing the window restores the saved choice', async () => {
  const { sidebarMode } = await load();
  const s = { expanded: true, pinned: false, hover: false };
  assert.equal(sidebarMode({ ...s, width: 1400 }), 'expanded');
  assert.equal(sidebarMode({ ...s, width: 900 }), 'rail');
  assert.equal(sidebarMode({ ...s, width: 1400 }), 'expanded');
});

test('toggle label matches the state', async () => {
  const { sidebarToggleLabel } = await load();
  assert.equal(sidebarToggleLabel({ width: 1400, expanded: true }), 'Minimize sidebar');
  assert.equal(sidebarToggleLabel({ width: 1400, expanded: false, pinned: true }), 'Expand sidebar');
  assert.equal(sidebarToggleLabel({ width: 900, expanded: true }), 'Show sidebar');
  assert.equal(sidebarToggleLabel({ width: 900, expanded: false, pinned: false }), 'Show sidebar');
  assert.equal(sidebarToggleLabel({ width: 900, expanded: true, pinned: true }), 'Hide sidebar');
  assert.equal(sidebarToggleLabel({ width: 900, expanded: false, hover: true }), 'Pin sidebar');
  assert.equal(sidebarToggleLabel({ width: 900, expanded: false, pinned: true, hover: true }), 'Hide sidebar');
  assert.equal(sidebarToggleLabel({ width: 1400, expanded: false, hover: true }), 'Expand sidebar');
});

test('the sidebar: eight pages, a divider, then three fold-out lists; History has two tabs (AK-491)', async () => {
  const { NAV_ITEMS, SECTION_PAGES, sectionOf, pageOf, pageLabel } = await load();
  assert.deepEqual(NAV_ITEMS.map((p) => p.label), ['Catch up', 'Review', 'Map', 'Commit', 'Branches', 'Stashes', 'History', 'Submodules']);
  assert.deepEqual(SECTION_PAGES.map((p) => p.label), ['Remotes', 'Tags', 'Worktrees']);
  const all = [...NAV_ITEMS, ...SECTION_PAGES];
  assert.equal(new Set(all.map((p) => p.view)).size, all.length, 'no two rows share a page');
  assert.equal(sectionOf('lanes'), 'lanes');
  assert.equal(sectionOf('tagList'), 'tags');
  assert.equal(sectionOf('reflog'), 'history');
  assert.equal(sectionOf('config'), null);
  assert.equal(pageOf('submoduleList').label, 'Submodules');
  assert.equal(pageLabel('lanes'), 'Review');
  assert.equal(pageLabel('remoteList'), 'Remotes');
  assert.equal(pageLabel('snapshots'), 'History');
  assert.equal(pageLabel('reflog'), 'History');
});

test('sidebar layout: defaults, saved order, unknown ids, moves, drags and hiding (AK-464, AK-491)', async () => {
  const { NAV_ITEMS, SECTION_PAGES, sectionLayout, orderedSections, moveSection, placeSection, showSection } = await import('../renderer/sidebar.js');
  const nav = NAV_ITEMS.map((p) => p.id), list = SECTION_PAGES.map((p) => p.id), ids = [...nav, ...list];
  assert.deepEqual(sectionLayout(), { order: ids, hidden: [] });
  assert.deepEqual(orderedSections({}, 'nav').map((p) => p.id), nav);
  assert.deepEqual(orderedSections({}, 'list').map((p) => p.id), list);
  assert.ok(orderedSections({}).every((p) => !p.hidden && p.label && p.view));
  // A saved order from before (AK-464) keeps what it can; junk and Pull requests are dropped.
  const l = sectionLayout({ order: ['tags', 'nope', 'prs', 'branches', 'tags'], hidden: ['submodules', 'x', 'map'] });
  assert.deepEqual([...l.order].sort(), [...ids].sort());
  assert.deepEqual(l.hidden, ['submodules'], 'Map can never hide');
  // Moves stay inside a group.
  assert.deepEqual(moveSection({}, 'branches', -1).order.slice(3, 5), ['branches', 'commit']);
  assert.deepEqual(moveSection({}, 'submodules', 1).order, ids, 'the last page does not drop into the lists');
  assert.deepEqual(moveSection({}, 'remotes', -1).order, ids, 'the first list does not climb into the pages');
  // Drags: before a row, or to the end of its own group.
  assert.deepEqual(orderedSections(placeSection({}, 'history', 'catchup'), 'nav')[0].id, 'history');
  assert.deepEqual(orderedSections(placeSection({}, 'catchup', null), 'nav').at(-1).id, 'catchup');
  assert.deepEqual(orderedSections(placeSection({}, 'remotes', null), 'list').map((p) => p.id), ['tags', 'worktrees', 'remotes']);
  assert.deepEqual(placeSection({}, 'tags', 'map').order, ids, 'no drops across the divider');
  const hid = showSection({}, 'tags', false);
  assert.deepEqual(hid.hidden, ['tags']);
  assert.equal(orderedSections(hid).find((p) => p.id === 'tags').hidden, true);
  assert.deepEqual(showSection(hid, 'tags', true).hidden, []);
  assert.deepEqual(showSection({}, 'lanes', false).hidden, [], 'Review can never hide');
});
