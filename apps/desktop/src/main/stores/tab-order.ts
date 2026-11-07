// Which of a window's tabs a key picks, and which one shows after a close (AK-634).

// ⌘1–⌘8: the tab at that place, if there is one (-1 if not); ⌘9: the last tab.
/** A closed tab or window, for ⇧⌘T: its repositories, the one showing, and what else it kept. */
export interface ClosedEntry { roots: string[]; active?: string | null; [key: string]: unknown }

export const byNumber = (count: number, n: number): number => (n === 9 ? count - 1 : n <= count ? n - 1 : -1);
// ⌃Tab / ⌃⇧Tab: the next or previous tab, wrapping round.
export const step = (count: number, i: number, by: number): number => (count ? (((i + by) % count) + count) % count : -1);
// Closing the tab at `i` of `count` shows the tab that takes its place, else the one before it.
export const afterClose = (count: number, i: number): number => Math.min(i, count - 2);
// The tab to show among the reopened `roots`: the one that was showing, else the last.
export const reopenActive = (roots: readonly string[], active: string | null | undefined): number => (active != null && roots.includes(active) ? roots.indexOf(active) : roots.length - 1);
// Closed tabs and windows, newest last ({ roots, active, window }); the oldest drop off past `max`.
export const remember = (closed: ClosedEntry[], entry: ClosedEntry, max = 20): ClosedEntry[] => (entry.roots.length ? [...closed, entry].slice(-max) : closed);
// What ⇧⌘T reopens: the newest entry, cut to the folders `ok` still accepts, and the entries left under it.
// Entries with none left are dropped.
export function takeClosed(closed: readonly ClosedEntry[], ok: (root: string) => boolean): { entry: ClosedEntry | null; rest: ClosedEntry[] } {
  const rest = [...closed];
  while (rest.length) {
    const e = rest.pop();
    if (!e) break;
    const roots = e.roots.filter(ok);
    if (roots.length) return { entry: { ...e, roots }, rest };
  }
  return { entry: null, rest };
}

