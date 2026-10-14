// The welcome-screen playground: a tiny pretend repository where you move a branch on the graph
// and undo it, so the two things GitLanes does differently are felt rather than read about.
// Pure state only (no DOM, no git), so it can be unit-tested; the view is tour-view.js.

// Newest first. lane 0 is main's line, lane 1 a feature branch that forks off c2.
export const TOUR_COMMITS = [
  { sha: 'f2', lane: 1, parent: 'f1', message: 'Polish empty states' },
  { sha: 'c3', lane: 0, parent: 'c2', message: 'Fix rebase on a detached HEAD' },
  { sha: 'f1', lane: 1, parent: 'c2', message: 'Add file history view' },
  { sha: 'c2', lane: 0, parent: 'c1', message: 'Stream the log in pages' },
  { sha: 'c1', lane: 0, parent: null, message: 'Initial commit' },
];

export const TOUR_BRANCH = 'main';
const START = 'c3';

export const createTour = () => ({ tip: START, undo: [], redo: [] });

// Moving main to a commit is one undoable step; moving it where it already is changes nothing.
export function moveTip(s, sha) {
  if (sha === s.tip || !TOUR_COMMITS.some((c) => c.sha === sha)) return s;
  return { tip: sha, undo: [...s.undo, s.tip], redo: [], last: 'move' };
}

export function undoTip(s) {
  if (!s.undo.length) return { ...s, last: 'empty-undo' };
  return { tip: s.undo.at(-1), undo: s.undo.slice(0, -1), redo: [...s.redo, s.tip], last: 'undo' };
}

export function redoTip(s) {
  if (!s.redo.length) return { ...s, last: 'empty-redo' };
  return { tip: s.redo.at(-1), undo: [...s.undo, s.tip], redo: s.redo.slice(0, -1), last: 'redo' };
}

const short = (sha) => TOUR_COMMITS.find((c) => c.sha === sha)?.message;

// The one-line hint under the graph: what just happened and what to try next. `keys` are the
// shortcut glyphs to show after the text.
export function tourHint(s) {
  switch (s.last) {
    case 'move': return { text: `Moved ${TOUR_BRANCH} to “${short(s.tip)}”. Changed your mind?`, keys: 'undo' };
    case 'undo': return { text: `Undone. ${s.undo.length ? 'Keep going, history has no limit.' : 'Back where you started.'}`, keys: 'redo' };
    case 'redo': return { text: 'Redone. Undo and redo cover every branch, tag and HEAD move.', keys: 'undo' };
    case 'empty-undo': return { text: 'Nothing to undo yet. Move the branch first.', keys: null };
    case 'empty-redo': return { text: 'Nothing to redo.', keys: 'undo' };
    default: return { text: `Click any commit to move ${TOUR_BRANCH} there.`, keys: null };
  }
}
