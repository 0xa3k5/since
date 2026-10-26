'use strict';
// Which of a window's tabs a key picks, and which one shows after a close (AK-634).

// ⌘1–⌘8: the tab at that place, if there is one (-1 if not); ⌘9: the last tab.
const byNumber = (count, n) => (n === 9 ? count - 1 : n <= count ? n - 1 : -1);
// ⌃Tab / ⌃⇧Tab: the next or previous tab, wrapping round.
const step = (count, i, by) => (count ? (((i + by) % count) + count) % count : -1);
// Closing the tab at `i` of `count` shows the tab that takes its place, else the one before it.
const afterClose = (count, i) => Math.min(i, count - 2);
// The tab to show among the reopened `roots`: the one that was showing, else the last.
const reopenActive = (roots, active) => (roots.includes(active) ? roots.indexOf(active) : roots.length - 1);

module.exports = { byNumber, step, afterClose, reopenActive };
