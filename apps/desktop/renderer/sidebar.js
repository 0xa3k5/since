// Sidebar layout modes. Pure logic, no DOM, so it can be unit-tested.
//   expanded: full sidebar in the layout
//   rail:     icons only, in the layout
//   overlay:  full sidebar floating over the content, next to the rail (narrow windows only)

// Below this window width the sidebar collapses to the rail on its own.
export const SIDEBAR_BREAKPOINT = 1100;

export const isNarrow = (width) => width < SIDEBAR_BREAKPOINT;

// expanded: the saved choice for wide windows. pinned/hover: the overlay on narrow windows.
export function sidebarMode({ width, expanded, pinned = false, hover = false }) {
  if (!isNarrow(width)) return expanded ? 'expanded' : 'rail';
  return pinned || hover ? 'overlay' : 'rail';
}

// What the toggle (button, ⌘\, ⌘K, menu) does. Wide windows flip the saved choice;
// narrow ones pin or unpin the overlay and never touch the saved choice. Clicking the toggle
// while hover has the overlay open pins it, so it doesn't vanish under the pointer.
export function toggleSidebarState(s, width) {
  if (!isNarrow(width)) return { ...s, expanded: !s.expanded, pinned: false, hover: false };
  return { ...s, pinned: !s.pinned, hover: false };
}

// Label for the toggle (tooltip, ⌘K) in the current state.
// While hover has the overlay open, the toggle pins it rather than showing it.
export function sidebarToggleLabel({ width, expanded, pinned = false, hover = false }) {
  if (isNarrow(width)) return pinned ? 'Hide sidebar' : hover ? 'Pin sidebar' : 'Show sidebar';
  return expanded ? 'Minimize sidebar' : 'Expand sidebar';
}

// The sidebar, top to bottom (AK-491): one row per page (keys ⌘1–⌘8), a divider, then the smaller fold-out lists.
// `view` is the page a row opens; `fixed` rows can move but not hide. Each row keeps its key wherever it sits.
export const NAV_ITEMS = [
  { id: 'catchup', label: 'Catch up', icon: 'catchup', view: 'catchup', fixed: true },
  { id: 'lanes', label: 'Review', icon: 'lanes', view: 'lanes', fixed: true },
  { id: 'map', label: 'Map', icon: 'map', view: 'map', fixed: true },
  { id: 'commit', label: 'Commit', icon: 'commit', view: 'commit', fixed: true },
  { id: 'branches', label: 'Branches', icon: 'branch', view: 'branches' },
  { id: 'stashes', label: 'Stashes', icon: 'stash', view: 'stashes' },
  { id: 'history', label: 'History', icon: 'history', view: 'snapshots' },
  { id: 'submodules', label: 'Submodules', icon: 'submodule', view: 'submoduleList' },
];
// Below the divider: a click on the header folds the list, a double-click (or its key, or ⌘K) opens its full page.
export const SECTION_PAGES = [
  { id: 'remotes', label: 'Remotes', icon: 'cloud', view: 'remoteList' },
  { id: 'tags', label: 'Tags', icon: 'tag', view: 'tagList' },
  { id: 'worktrees', label: 'Worktrees', icon: 'worktree', view: 'worktrees' },
];
const ITEMS = [...NAV_ITEMS.map((p) => ({ ...p, group: 'nav' })), ...SECTION_PAGES.map((p) => ({ ...p, group: 'list' }))];

// Snapshots and the reflog are one page, History, with a tab each.
export const HISTORY_VIEWS = ['snapshots', 'reflog'];

// The sidebar row that stays highlighted while `view` is on screen, or null.
export const sectionOf = (view) => (HISTORY_VIEWS.includes(view) ? 'history' : ITEMS.find((p) => p.view === view)?.id || null);
// The row (either group) whose page is `view`.
export const pageOf = (view) => ITEMS.find((p) => p.view === view) || null;

// The page title for the top bar.
export const pageLabel = (view) => (HISTORY_VIEWS.includes(view) ? 'History' : pageOf(view)?.label || '');

// Which rows show, and in what order (AK-464, Preferences → Sidebar; long-press drag, AK-491). Saved as
// { order: [ids], hidden: [ids] }; anything unknown is dropped and rows it doesn't mention keep their default
// place, so the default (nothing saved) is NAV_ITEMS then SECTION_PAGES, all shown. Rows never leave their group.
export function sectionLayout(saved = {}) {
  const known = ITEMS.map((p) => p.id);
  const order = (Array.isArray(saved.order) ? saved.order : []).filter((id, i, a) => known.includes(id) && a.indexOf(id) === i);
  // A row the saved order doesn't know goes right after the one before it by default (or first).
  known.forEach((id, k) => { if (!order.includes(id)) order.splice(k ? order.indexOf(known[k - 1]) + 1 : 0, 0, id); });
  const hidden = (Array.isArray(saved.hidden) ? saved.hidden : []).filter((id) => known.includes(id) && !ITEMS.find((p) => p.id === id).fixed);
  return { order, hidden: [...new Set(hidden)] };
}

// Every row in the saved order, each with `group` ('nav' or 'list') and `hidden`; pass a group for just that one.
export const orderedSections = (saved, group = null) => {
  const l = sectionLayout(saved);
  return l.order.map((id) => ({ ...ITEMS.find((p) => p.id === id), hidden: l.hidden.includes(id) })).filter((p) => !group || p.group === group);
};

const groupOf = (id) => ITEMS.find((p) => p.id === id)?.group;

// Move a row one place up (dir -1) or down (dir 1) within its group; stays put at either end.
export function moveSection(saved, id, dir) {
  const { order, hidden } = sectionLayout(saved);
  const i = order.indexOf(id);
  let j = i + dir;
  while (j >= 0 && j < order.length && groupOf(order[j]) !== groupOf(id)) j += dir;
  if (i < 0 || j < 0 || j >= order.length) return { order, hidden };
  [order[i], order[j]] = [order[j], order[i]];
  return { order, hidden };
}

// Drop a dragged row just before `before` (null: after the last row of its group). Other groups don't take it.
export function placeSection(saved, id, before = null) {
  const { order, hidden } = sectionLayout(saved);
  if (!order.includes(id) || id === before || (before && groupOf(before) !== groupOf(id))) return { order, hidden };
  const rest = order.filter((x) => x !== id);
  const at = before ? rest.indexOf(before) : rest.findLastIndex((x) => groupOf(x) === groupOf(id)) + 1;
  rest.splice(at, 0, id);
  return { order: rest, hidden };
}

export function showSection(saved, id, show) {
  const { order, hidden } = sectionLayout(saved);
  if (!show && ITEMS.find((p) => p.id === id)?.fixed) return { order, hidden };
  return { order, hidden: show ? hidden.filter((x) => x !== id) : [...new Set([...hidden, id])] };
}
