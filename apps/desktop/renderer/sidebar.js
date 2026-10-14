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
