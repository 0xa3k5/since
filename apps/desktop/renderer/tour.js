// The welcome-screen playground: a tiny pretend repository that walks through what GitLanes does,
// one short lesson at a time (move a branch, rewrite with one key, find anything in ⌘K, take it
// back). Pure state only (no DOM, no git), so it can be unit-tested; the view is tour-view.js.

// Newest first. lane 0 is main's line, lane 1 a feature branch that forks off c2.
export const TOUR_COMMITS = [
  { sha: 'f2', lane: 1, parent: 'f1', message: 'Polish empty states' },
  { sha: 'c3', lane: 0, parent: 'c2', message: 'Fix rebase on a detached HEAD' },
  { sha: 'f1', lane: 1, parent: 'c2', message: 'Add file history view' },
  { sha: 'c2', lane: 0, parent: 'c1', message: 'Stream the log in pages' },
  { sha: 'c1', lane: 0, parent: null, message: 'Initial commit' },
];

export const TOUR_BRANCH = 'main';
export const TOUR_FEATURE = 'file-history';
const START = 'c3';

export const LESSONS = [
  { id: 'graph', label: 'Branches', title: 'Branches live on the graph' },
  { id: 'rewrite', label: 'Rewrite', title: 'One key per rewrite' },
  { id: 'palette', label: 'Commands', title: 'Everything is one search away' },
  { id: 'undo', label: 'Undo', title: 'Change your mind any time' },
];

// A few real commands, as they appear in the app's ⌘K. `lesson` jumps to the lesson that shows it.
export const TOUR_COMMANDS = [
  { label: 'Rebase Current onto This', icon: 'rebase', key: 'R', lesson: 'rewrite' },
  { label: 'Cherry-pick onto Current', icon: 'cherry', key: 'P', lesson: 'rewrite' },
  { label: 'Squash with Parent', icon: 'squash', key: 'S', lesson: 'rewrite' },
  { label: 'Move Branch Here', icon: 'branch', lesson: 'graph' },
  { label: 'Stash Changes', icon: 'stash' },
  { label: 'File History', icon: 'history' },
  { label: 'Switch Repository', icon: 'folder' },
  { label: 'Undo', icon: 'undo', lesson: 'undo' },
];

export const createTour = () => ({ commits: TOUR_COMMITS, tip: START, sel: null, undo: [], redo: [], lesson: 'graph' });

const find = (s, sha) => s.commits.find((c) => c.sha === sha);
const snap = (s) => ({ commits: s.commits, tip: s.tip });
// Every change to the pretend repository is one undoable step.
const commit = (s, next, last) => ({ ...s, ...next, undo: [...s.undo, snap(s)], redo: [], last });

export const setLesson = (s, lesson) => (LESSONS.some((l) => l.id === lesson) ? { ...s, lesson, last: null } : s);
export const select = (s, sha) => (find(s, sha) ? { ...s, sel: sha, last: 'select' } : s);

// Moving main to a commit; moving it where it already is changes nothing.
export function moveTip(s, sha) {
  if (sha === s.tip || !find(s, sha)) return s;
  return commit(s, { tip: sha }, 'move');
}

// S: fold the selected commit into its parent.
export function squash(s) {
  const c = find(s, s.sel);
  if (!c?.parent) return { ...s, last: 'no-squash' };
  const commits = s.commits.filter((x) => x !== c).map((x) => (x.parent === c.sha ? { ...x, parent: c.parent } : x));
  return { ...commit(s, { commits, tip: s.tip === c.sha ? c.parent : s.tip }, 'squash'), sel: c.parent };
}

// R: replay the feature branch on top of the selected main commit.
export function rebase(s) {
  const onto = find(s, s.sel);
  const feature = s.commits.filter((x) => x.lane === 1);
  if (!onto || onto.lane !== 0 || !feature.length) return { ...s, last: 'no-rebase' };
  const base = feature.at(-1);
  if (base.parent === onto.sha) return { ...s, last: 'no-rebase' };
  const moved = feature.map((x) => (x === base ? { ...x, parent: onto.sha } : x));
  // Feature commits go just above `onto`, so the edge never crosses newer main rows.
  const main = s.commits.filter((x) => x.lane === 0);
  const at = main.indexOf(onto);
  return commit(s, { commits: [...main.slice(0, at), ...moved, ...main.slice(at)] }, 'rebase');
}

// P: copy the selected feature commit onto main and move main to the copy.
export function cherryPick(s) {
  const c = find(s, s.sel);
  if (!c || c.lane !== 1) return { ...s, last: 'no-pick' };
  const sha = `${c.sha}'`;
  if (find(s, sha)) return { ...s, last: 'no-pick' };
  const copy = { sha, lane: 0, parent: s.tip, message: c.message };
  return { ...commit(s, { commits: [copy, ...s.commits], tip: sha }, 'pick'), sel: sha };
}

export function undoTip(s) {
  if (!s.undo.length) return { ...s, last: 'empty-undo' };
  const sel = find({ commits: s.undo.at(-1).commits }, s.sel) ? s.sel : null;
  return { ...s, ...s.undo.at(-1), sel, undo: s.undo.slice(0, -1), redo: [...s.redo, snap(s)], last: 'undo' };
}

export function redoTip(s) {
  if (!s.redo.length) return { ...s, last: 'empty-redo' };
  const sel = find({ commits: s.redo.at(-1).commits }, s.sel) ? s.sel : null;
  return { ...s, ...s.redo.at(-1), sel, undo: [...s.undo, snap(s)], redo: s.redo.slice(0, -1), last: 'redo' };
}

export const filterCommands = (q) => {
  const t = q.trim().toLowerCase();
  return t ? TOUR_COMMANDS.filter((c) => c.label.toLowerCase().includes(t)) : TOUR_COMMANDS;
};

const msg = (s, sha) => find(s, sha)?.message;

// The one-line hint under the graph: what just happened and what to try next. `keys` names the
// shortcut glyphs to show after the text.
export function tourHint(s) {
  switch (s.last) {
    case 'move': return { text: `Moved ${TOUR_BRANCH} to “${msg(s, s.tip)}”.`, keys: null };
    case 'squash': return { text: `Squashed into “${msg(s, s.sel)}”.`, keys: null };
    case 'rebase': return { text: `${TOUR_FEATURE} now starts from “${msg(s, s.sel)}”.`, keys: null };
    case 'pick': return { text: `Copied onto ${TOUR_BRANCH}.`, keys: null };
    case 'no-squash': return { text: 'The first commit has nothing to squash into.', keys: null };
    case 'no-rebase': return { text: `Select a ${TOUR_BRANCH} commit, then R moves ${TOUR_FEATURE} onto it.`, keys: null };
    case 'no-pick': return { text: `Select a ${TOUR_FEATURE} commit to copy it onto ${TOUR_BRANCH}.`, keys: null };
    case 'undo': return { text: s.undo.length ? 'Undone. Keep going, history has no limit.' : 'Back where you started.', keys: 'redo' };
    case 'redo': return { text: 'Redone.', keys: 'undo' };
    case 'empty-undo': return { text: 'Nothing to undo yet. Try another lesson first.', keys: null };
    case 'empty-redo': return { text: 'Nothing to redo.', keys: 'undo' };
  }
  switch (s.lesson) {
    case 'rewrite': return { text: 'Select a commit, then press S to squash, R to rebase or P to cherry-pick.', keys: null };
    case 'palette': return { text: 'Type to search. Every command shows its shortcut.', keys: 'palette' };
    case 'undo': return { text: s.undo.length ? 'Step back through everything you just did.' : 'Make a change in another lesson, then take it back.', keys: s.undo.length ? 'undo' : null };
    default: return { text: `Click any commit to move ${TOUR_BRANCH} there.`, keys: null };
  }
}
