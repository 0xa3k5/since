// Lanes → Clean up: pure helpers (no DOM) for cleanup-view.js. A lane is one entry of
// `app:lanes-list` (git.lanes). Each stale lane lands in the first group it matches.

import { laneKey } from './lanes.js';

const DAY = 24 * 3600e3;
// "Untouched for N days": the default N, and the pref key that overrides it.
export const STALE_DAYS = 30;

export const GROUPS = [
  { id: 'missing', label: 'Worktree folder missing', detail: 'The folder is gone; the worktree record is pruned.' },
  { id: 'mergedWorktree', label: 'Worktrees of merged branches', detail: 'Removes the worktree and its branch.' },
  { id: 'merged', label: 'Merged into base', detail: 'Merged, squash-merged or rebased onto the base branch.' },
  { id: 'gone', label: 'Upstream gone', detail: 'The branch it tracked was deleted on the remote.' },
  { id: 'empty', label: 'Nothing ahead of base', detail: 'No commits that aren’t on the base branch.' },
  { id: 'old', label: 'Untouched', detail: 'No commits or edits for a while.' },
];

// Which cleanup group a lane belongs to, or null when it isn't stale. The base branch never is.
export function cleanupGroup(lane, { days = STALE_DAYS, now = Date.now() } = {}) {
  if (lane.isBase) return null;
  const w = lane.worktree;
  if (w?.prunable) return 'missing';
  if (!lane.head) return null; // an unborn branch: nothing to judge yet
  if (lane.merged || lane.done) return w ? 'mergedWorktree' : 'merged'; // done: shipped (a squash or PR merge)
  if (lane.upstreamGone) return 'gone';
  if (lane.nothingAhead) return 'empty';
  if (lane.activity && now - lane.activity > days * DAY) return 'old';
  return null;
}

// Why a lane can't be cleaned up at all, or null.
export function blocked(lane) {
  const w = lane.worktree;
  if (w?.current) return 'Open in this window';
  if (w?.main) return 'Checked out in the main worktree';
  if (w?.locked) return 'Locked';
  return null;
}

// Uncommitted files that removing the lane's worktree would delete for good.
export const dirty = (lane) => (lane.worktree && !lane.worktree.prunable && lane.changes > 0 ? lane.changes : 0);

// Ticked when the list opens: anything not blocked and not dirty. Dirty worktrees need an
// explicit tick (and a warning); the current worktree and the base branch are never offered.
export const preselect = (lane) => !blocked(lane) && !dirty(lane);

// Its remote branch, when it still has one (deleting it there is a separate, opt-in tick).
export const remoteOf = (lane) => (lane.upstream && !lane.upstreamGone ? lane.upstream : null);

// Stale lanes as [{ group, lanes }] in GROUPS order, each lane with `group` set.
export function groupLanes(lanes, opts) {
  const by = new Map(GROUPS.map((g) => [g.id, []]));
  for (const l of lanes) {
    const id = cleanupGroup(l, opts);
    if (id) by.get(id).push({ ...l, group: id });
  }
  for (const list of by.values()) list.sort((a, b) => (a.activity || 0) - (b.activity || 0) || a.name.localeCompare(b.name));
  return GROUPS.map((g) => ({ group: g, lanes: by.get(g.id) })).filter((g) => g.lanes.length);
}

// What git.cleanupLanes gets for a lane: its branch (with the tip the user saw) and worktree.
export function cleanupItem(lane) {
  const item = {};
  if (lane.branch) Object.assign(item, { branch: lane.branch, head: lane.head });
  if (lane.worktree) item.worktree = lane.worktree.path;
  if (dirty(lane)) item.force = true;
  return item;
}

// Counts for the confirmation: { worktrees, branches, dirty: [lanes], remotes: [names] }.
// `remote` holds the laneKeys ticked for deletion on the remote too.
export function summarize(lanes, remote = new Set()) {
  return {
    worktrees: lanes.filter((l) => l.worktree).length,
    branches: lanes.filter((l) => l.branch).length,
    dirty: lanes.filter(dirty),
    remotes: lanes.map((l) => remote.has(laneKey(l)) && remoteOf(l)).filter(Boolean),
  };
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
