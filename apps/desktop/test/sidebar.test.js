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

test('the refs tree: one page per section, Pull requests open Review, History & recovery has two tabs', async () => {
  const { SECTION_PAGES, sectionOf, pageLabel } = await load();
  assert.deepEqual(SECTION_PAGES.map((p) => p.label), ['Branches', 'Remotes', 'Tags', 'Worktrees', 'Pull requests', 'Stashes', 'Submodules']);
  assert.equal(new Set(SECTION_PAGES.map((p) => p.view)).size, SECTION_PAGES.length, 'no two sections share a page');
  assert.equal(sectionOf('lanes'), 'prs');
  assert.equal(sectionOf('tagList'), 'tags');
  assert.equal(sectionOf('map'), null);
  const views = [{ id: 'lanes', label: 'Review' }];
  assert.equal(pageLabel('lanes', views), 'Review', 'an activity keeps its own name');
  assert.equal(pageLabel('remoteList', views), 'Remotes');
  assert.equal(pageLabel('snapshots', views), 'History & recovery');
  assert.equal(pageLabel('reflog', views), 'History & recovery');
});

test('section layout: defaults, saved order, unknown ids, moves and hiding (AK-464)', async () => {
  const { SECTION_PAGES, sectionLayout, orderedSections, moveSection, showSection } = await import('../renderer/sidebar.js');
  const ids = SECTION_PAGES.map((p) => p.id);
  assert.deepEqual(sectionLayout(), { order: ids, hidden: [] });
  assert.deepEqual(orderedSections({}).map((p) => p.id), ids);
  assert.ok(orderedSections({}).every((p) => !p.hidden && p.label && p.view));
  // A saved order that misses sections (e.g. one added later) keeps theirs; junk is dropped.
  const l = sectionLayout({ order: ['tags', 'nope', 'branches', 'tags'], hidden: ['submodules', 'x'] });
  assert.deepEqual(l.order, ['tags', 'worktrees', 'prs', 'stashes', 'submodules', 'branches', 'remotes']);
  assert.deepEqual([...l.order].sort(), [...ids].sort());
  assert.deepEqual(l.hidden, ['submodules']);
  assert.deepEqual(moveSection({}, 'remotes', -1).order.slice(0, 2), ['remotes', 'branches']);
  assert.deepEqual(moveSection({}, 'branches', -1).order, ids);
  assert.deepEqual(moveSection({}, ids.at(-1), 1).order, ids);
  const hid = showSection({}, 'tags', false);
  assert.deepEqual(hid.hidden, ['tags']);
  assert.equal(orderedSections(hid).find((p) => p.id === 'tags').hidden, true);
  assert.deepEqual(showSection(hid, 'tags', true).hidden, []);
});
