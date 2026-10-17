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
