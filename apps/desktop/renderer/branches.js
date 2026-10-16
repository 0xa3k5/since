// Branches (AK-396): pure helpers (no DOM) for branches-view.js. Every local branch and worktree
// (`app:lanes-list`, lanes.js), one list at a time behind tabs (1–5): Active, Agent-made, Would
// conflict, Idle and Finished. The tabs come from the lane buckets (lanes.js laneBucket) and the
// Clean up groups (cleanup.js): a finished lane is only ever in Finished.

import { laneBucket, aheadBehind } from './lanes.js';
import { cleanupGroup } from './cleanup.js';

export const BRANCH_TABS = [
  { id: 'active', label: 'Active', keyId: 'branches.tabActive' },
  { id: 'agents', label: 'Agent-made', keyId: 'branches.tabAgents' },
  { id: 'conflict', label: 'Would conflict', keyId: 'branches.tabConflict' },
  { id: 'idle', label: 'Idle', keyId: 'branches.tabIdle' },
  { id: 'finished', label: 'Finished', keyId: 'branches.tabFinished' },
];

// Finished: merged, shipped, its remote branch deleted, or its folder missing (Clean up's groups,
// without the opt-in "untouched" one). The base branch never is.
export const isFinished = (lane) => Boolean(cleanupGroup(lane));
// Looks agent-made: the lane's own guess (branch prefix, trailers), or a bot opened its PR.
export const isAgent = (lane) => Boolean(lane.agent || lane.pr?.bot);

// Which tabs a lane is on. Active and Idle split the rest by the lane buckets; Agent-made and Would
// conflict are views across them (a conflicting lane is still active). `agents`: marks are on.
export function laneTabs(lane, { agents = true, now = Date.now() } = {}) {
  if (isFinished(lane)) return ['finished'];
  const bucket = lane.bucket || laneBucket(lane, now);
  const out = [bucket === 'idle' || bucket === 'merged' ? 'idle' : 'active'];
  if (agents && isAgent(lane)) out.push('agents');
  if (lane.conflicts?.length) out.push('conflict');
  return out;
}

// Lanes per tab: { active: [...], agents: [...], conflict: [...], idle: [...], finished: [...] },
// each in the order given (sortLanes: the ones that need you first, then the newest).
export function branchTabs(lanes, opts = {}) {
  const out = Object.fromEntries(BRANCH_TABS.map((t) => [t.id, []]));
  for (const l of lanes) for (const t of laneTabs(l, opts)) out[t].push(l);
  return out;
}

const DAY = 24 * 3600e3;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The row's quiet line after who made it: "↑3 ↓0 · worktree · PR #162 open · 2 uncommitted", or for
// an idle lane with nothing else to say, "no commits for 41 days".
export function branchLine(lane, { now = Date.now() } = {}) {
  const ab = aheadBehind(lane);
  const parts = [
    lane.isBase ? 'base branch' : null,
    ab && ab !== 'even' ? ab : null,
    lane.worktree?.prunable ? 'worktree folder missing' : lane.worktree?.current ? 'this window' : lane.worktree ? 'worktree' : null,
    lane.pr ? `PR #${lane.pr.number} ${lane.pr.draft ? 'draft' : 'open'}` : null,
    lane.changes ? `${lane.changes} uncommitted` : null,
  ].filter(Boolean);
  if (!lane.worktree && !lane.upstream && !lane.pr && !lane.isBase && !lane.detached) parts.push('local only');
  const idle = lane.activity && now - lane.activity > 7 * DAY ? `no commits for ${plural(Math.floor((now - lane.activity) / DAY), 'day')}` : null;
  return (parts.length > 1 || !idle ? parts : [...parts, idle]).join(' · ');
}

// The row's dot: warn for a predicted conflict, red for failing CI, green for work in progress
// here (this window, or uncommitted changes), else muted.
export function branchDot(lane) {
  if (lane.conflicts?.length) return 'warn';
  if (lane.pr?.checks === 'failure') return 'red';
  if (lane.worktree?.current || lane.changes > 0) return 'green';
  return '';
}

// Filter as you type: every word in the branch name, title, worktree path or PR.
export function filterBranches(lanes, query = '') {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return lanes;
  return lanes.filter((l) => {
    const hay = [l.name, l.branch, l.title, l.worktree?.path, l.upstream, l.pr ? `#${l.pr.number} ${l.pr.title || ''}` : ''].filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
