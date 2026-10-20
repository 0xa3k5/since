// Clean up, the Finished tab of Branches: pure helpers (no DOM) for cleanup-view.js. A lane is one entry of
// `app:lanes-list` (git.lanes). Each finished lane lands in the first group it matches.

import { laneKey } from './lanes.js';

const DAY = 24 * 3600e3;
// "Untouched for N days": its own card, never ticked up front. The default N.
export const STALE_DAYS = 30;
// The "untouched for N days" field (AK-402): a whole number of days from 1 to 365, else null.
export function daysValue(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : null;
}

// In the order the Finished tab of Branches shows them (AK-396). Each card ticks its whole group.
export const GROUPS = [
  { id: 'merged', label: 'Merged or shipped' },
  { id: 'mergedWorktree', label: 'Worktrees of merged branches' },
  { id: 'missing', label: 'Worktree folder missing' },
  { id: 'gone', label: 'Deleted on GitHub' },
  { id: 'old', label: 'Untouched' },
  { id: 'dirty', label: 'With uncommitted changes', warn: true },
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
  if (d?.sha && d.reason === 'key') return `${d.key} landed in ${short(d.sha)}`;
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

// Ticked when the list opens: anything not blocked, not dirty and not merely untouched. Dirty
// worktrees need an explicit tick (and a warning); untouched branches are your call; the current
// worktree and the base branch are never offered.
export const preselect = (lane) => !blocked(lane) && !dirty(lane) && lane.group !== 'old';

// Its own remote branch (`<remote>/<same name>`), when it still has one; deleting it there is a
// separate, opt-in tick. A branch tracking something else (usually the base it was made from,
// `origin/main`) has none: its upstream is never deleted.
// Where "Also delete them on …" deletes: the one remote's name, else "the remote".
export function remoteWhere(refs) {
  const names = new Set(refs.map((r) => r.split('/')[0]));
  return names.size === 1 ? [...names][0] : 'the remote';
}

export function remoteOf(lane, base = null) {
  const up = lane.upstream;
  if (!up || lane.upstreamGone || !lane.branch || lane.branch === base) return null;
  const remote = up.slice(0, -lane.branch.length - 1);
  return up.endsWith(`/${lane.branch}`) && remote ? up : null;
}

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
// `remote` holds the laneKeys ticked for deletion on the remote too. `all` is every lane: a remote
// branch that a lane not being cleaned up still tracks stays. `base` is never deleted.
export function summarize(lanes, remote = new Set(), { all = lanes, base = null } = {}) {
  const going = new Set(lanes.map(laneKey));
  const kept = new Set(all.filter((l) => !going.has(laneKey(l))).map((l) => l.upstream).filter(Boolean));
  return {
    worktrees: lanes.filter((l) => l.worktree).length,
    branches: lanes.filter((l) => l.branch).length,
    dirty: lanes.filter(dirty),
    remotes: [...new Set(lanes.map((l) => remote.has(laneKey(l)) && remoteOf(l, base)).filter((r) => r && !kept.has(r)))],
  };
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// "2 branches", "1 worktree", "1 branch and 1 worktree": a lane without a branch is only a worktree.
export function cleanupWhat(lanes) {
  const b = lanes.filter((l) => l.branch).length;
  return [b && plural(b, 'branch', 'branches'), lanes.length - b && plural(lanes.length - b, 'worktree')].filter(Boolean).join(' and ');
}
