// Lanes → Clean up: pure helpers (no DOM) for cleanup-view.js. A lane is one entry of
// `app:lanes-list` (git.lanes). Each finished lane lands in the first group it matches.

import { laneKey } from './lanes.js';

const DAY = 24 * 3600e3;
// "Untouched for N days": an optional filter, off by default. The default N when it's turned on.
export const STALE_DAYS = 30;

export const GROUPS = [
  { id: 'missing', label: 'Worktree folder missing', detail: 'The folder is gone; the worktree record is pruned.' },
  { id: 'mergedWorktree', label: 'Worktrees of merged branches', detail: 'Removes the worktree and its branch.' },
  { id: 'merged', label: 'Merged or shipped', detail: 'Merged, squash-merged, rebased or shipped through a pull request.' },
  { id: 'gone', label: 'Upstream gone', detail: 'The branch it tracked was deleted on the remote.' },
  { id: 'old', label: 'Untouched', detail: 'No commits or edits for a while.' },
  { id: 'dirty', label: 'Finished, with uncommitted changes', detail: 'Removing these worktrees deletes their uncommitted files for good.', warn: true },
];

// Uncommitted files that removing the lane's worktree would delete for good.
export const dirty = (lane) => (lane.worktree && !lane.worktree.prunable && lane.changes > 0 ? lane.changes : 0);

// Why a lane is finished (or stale), or null. `days` turns on the "untouched for N days" filter.
function staleKind(lane, days, now) {
  if (lane.isBase) return null;
  const w = lane.worktree;
  if (w?.prunable) return 'missing';
  if (!lane.head) return null; // an unborn branch: nothing to judge yet
  if (lane.merged || lane.done) return w ? 'mergedWorktree' : 'merged'; // done: shipped (a squash or PR merge)
  if (lane.upstreamGone) return 'gone';
  if (days && lane.activity && now - lane.activity > days * DAY) return 'old';
  return null;
}

// Which cleanup group a lane belongs to, or null when it isn't finished. The base branch never is.
// Finished lanes with uncommitted changes go to their own 'dirty' group, never ticked up front.
export function cleanupGroup(lane, { days = null, now = Date.now() } = {}) {
  const kind = staleKind(lane, days, now);
  return kind && kind !== 'missing' && dirty(lane) ? 'dirty' : kind;
}

// The one-line reason shown under a lane's title.
export function reason(lane, { days = null } = {}) {
  const short = (sha) => sha.slice(0, 7);
  const d = lane.done;
  if (lane.worktree?.prunable) return 'Folder missing';
  if (d?.pr) return `Merged in #${d.pr}`;
  if (d?.sha) return d.reason === 'subject' ? `Same title as ${short(d.sha)}` : `Same change as ${short(d.sha)}`;
  if (lane.mergedAs) return `Same change as ${short(lane.mergedAs)}`;
  if (d?.reason === 'key') return `${d.key} is on the base branch`;
  if (lane.merged === 'squash') return 'Squash-merged';
  if (lane.merged || d) return 'Merged';
  if (lane.upstreamGone) return 'Remote gone';
  if (days) return `Untouched for ${days}+ days`;
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

// Ticked when the list opens: anything not blocked and not dirty. Dirty worktrees need an
// explicit tick (and a warning); the current worktree and the base branch are never offered.
export const preselect = (lane) => !blocked(lane) && !dirty(lane);

// Its remote branch, when it still has one (deleting it there is a separate, opt-in tick).
export const remoteOf = (lane) => (lane.upstream && !lane.upstreamGone ? lane.upstream : null);

// Finished lanes as [{ group, lanes }] in GROUPS order, each lane with `group` set.
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
