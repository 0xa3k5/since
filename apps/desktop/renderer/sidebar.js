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

// The refs tree below the activities (AK-463), top to bottom. ⤢ on a section's header, a double-click on it,
// its key (view.<view>) and ⌘K open its full page: `view` is that page. Pull requests open Review, not a copy.
export const SECTION_PAGES = [
  { id: 'branches', label: 'Branches', icon: 'branch', view: 'branches' },
  { id: 'remotes', label: 'Remotes', icon: 'cloud', view: 'remoteList' },
  { id: 'tags', label: 'Tags', icon: 'tag', view: 'tagList' },
  { id: 'worktrees', label: 'Worktrees', icon: 'worktree', view: 'worktrees' },
  { id: 'prs', label: 'Pull requests', icon: 'merge', view: 'lanes' },
  { id: 'stashes', label: 'Stashes', icon: 'stash', view: 'stashes' },
  { id: 'submodules', label: 'Submodules', icon: 'submodule', view: 'submoduleList' },
];

// Snapshots and the reflog are one page, "History & recovery", with a tab each.
export const HISTORY_VIEWS = ['snapshots', 'reflog'];

// The section whose header stays highlighted while `view` is on screen, or null.
export const sectionOf = (view) => SECTION_PAGES.find((p) => p.view === view)?.id || null;

// The page title for the top bar: activities first, then section pages, then History & recovery.
export function pageLabel(view, activities = []) {
  return activities.find((v) => v.id === view)?.label
    || SECTION_PAGES.find((p) => p.view === view)?.label
    || (HISTORY_VIEWS.includes(view) ? 'History & recovery' : '');
}

// Which refs-tree sections show, and in what order (AK-464, Preferences → Sidebar). Saved as
// { order: [ids], hidden: [ids] }; anything unknown is dropped and sections it doesn't mention keep their default
// place, so the default (nothing saved) is SECTION_PAGES as is, all shown.
export function sectionLayout(saved = {}) {
  const known = SECTION_PAGES.map((p) => p.id);
  const order = (Array.isArray(saved.order) ? saved.order : []).filter((id, i, a) => known.includes(id) && a.indexOf(id) === i);
  // A section the saved order doesn't know goes right after the one before it by default (or first).
  known.forEach((id, k) => { if (!order.includes(id)) order.splice(k ? order.indexOf(known[k - 1]) + 1 : 0, 0, id); });
  const hidden = (Array.isArray(saved.hidden) ? saved.hidden : []).filter((id) => known.includes(id));
  return { order, hidden: [...new Set(hidden)] };
}

// The section pages in the saved order, each with `hidden`.
export const orderedSections = (saved) => {
  const l = sectionLayout(saved);
  return l.order.map((id) => ({ ...SECTION_PAGES.find((p) => p.id === id), hidden: l.hidden.includes(id) }));
};

// Move a section one place up (dir -1) or down (dir 1); stays put at either end.
export function moveSection(saved, id, dir) {
  const { order, hidden } = sectionLayout(saved);
  const i = order.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return { order, hidden };
  [order[i], order[j]] = [order[j], order[i]];
  return { order, hidden };
}

export function showSection(saved, id, show) {
  const { order, hidden } = sectionLayout(saved);
  return { order, hidden: show ? hidden.filter((x) => x !== id) : [...new Set([...hidden, id])] };
}
