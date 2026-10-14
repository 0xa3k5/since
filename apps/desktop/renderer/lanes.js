// Lanes overview: pure helpers (no DOM) for the triage list in lanes-view.js. A lane is one
// entry of `app:lanes-list` (git.lanes, with `pr` joined on when pull requests are on).

const HOUR = 3600e3;
// Uncommitted changes nobody has touched for this long count as stalled work.
export const STALLED_AFTER = 2 * HOUR;
// A lane with activity this recent is "active"; older ones are idle.
export const ACTIVE_FOR = 3 * 24 * HOUR;

// Buckets, in the order the list shows them. `needs` marks the ones that need you.
export const BUCKETS = [
  { id: 'failing', label: 'CI failing', needs: true },
  { id: 'review', label: 'Review', needs: true },
  { id: 'stalled', label: 'Stalled', needs: true },
  { id: 'ready', label: 'Ready to merge', needs: true },
  { id: 'active', label: 'Active', needs: false },
  { id: 'idle', label: 'Idle', needs: false },
];
const RANK = new Map(BUCKETS.map((b, i) => [b.id, i]));

// Which bucket a lane sorts into. PR fields only exist while pull requests are on.
export function laneBucket(lane, now = Date.now()) {
  const pr = lane.pr;
  if (pr?.checks === 'failure') return 'failing';
  if (pr && (pr.review === 'changes' || pr.review === 'required')) return 'review';
  if (lane.changes > 0 && lane.activity && now - lane.activity > STALLED_AFTER) return 'stalled';
  if (pr && !pr.draft && pr.checks === 'success' && pr.review === 'approved') return 'ready';
  if (lane.isBase || lane.merged || lane.worktree?.prunable) return 'idle';
  return lane.activity && now - lane.activity < ACTIVE_FOR ? 'active' : 'idle';
}

// Sort order, "needs you" first:
//   1. CI failing on the lane's PR
//   2. review requested or changes requested on the PR
//   3. a worktree with uncommitted changes and no activity for STALLED_AFTER (stuck or abandoned work)
//   4. ready to merge: checks green and approved, not a draft
//   5. active: committed to or edited within ACTIVE_FOR
//   6. idle: older lanes, merged lanes, missing worktrees and the base branch itself
// Within a bucket the most recent activity comes first, then by name so the order is stable.
export function sortLanes(lanes, now = Date.now()) {
  return lanes
    .map((lane) => ({ lane, bucket: laneBucket(lane, now) }))
    .sort((a, b) => RANK.get(a.bucket) - RANK.get(b.bucket) || (b.lane.activity || 0) - (a.lane.activity || 0) || a.lane.name.localeCompare(b.lane.name))
    .map(({ lane, bucket }) => ({ ...lane, bucket }));
}

// A stable key per lane, for keeping the selection across refreshes.
export const laneKey = (lane) => (lane.branch ? `b:${lane.branch}` : `w:${lane.worktree?.path || lane.name}`);

// Filter as you type: every word must appear in the lane's name, branch, worktree path or PR.
// `agentsOnly` keeps lanes that look agent-made.
export function filterLanes(lanes, query = '', { agentsOnly = false } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return lanes.filter((l) => {
    if (agentsOnly && !l.agent) return false;
    if (!words.length) return true;
    const hay = [l.name, l.branch, l.worktree?.path, l.upstream, l.pr ? `#${l.pr.number} ${l.pr.title}` : ''].filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// "↑3 ↓12" against the base; empty for the base itself or when there is no base.
export function aheadBehind(lane) {
  if (lane.isBase || lane.ahead == null) return '';
  return [lane.ahead ? `↑${lane.ahead}` : '', lane.behind ? `↓${lane.behind}` : ''].filter(Boolean).join(' ') || 'even';
}

// What Enter does on a lane: switch to its worktree, or show its tip in the map.
export function laneTarget(lane) {
  const w = lane.worktree;
  if (w && !w.current && !w.prunable) return { kind: 'worktree', path: w.path };
  if (lane.head) return { kind: 'commit', sha: lane.head };
  return null;
}

// Carry PR data over to a refresh that skipped `gh` (live refreshes stay local).
export function keepPrs(lanes, previous = []) {
  const prs = new Map(previous.filter((l) => l.pr).map((l) => [laneKey(l), l.pr]));
  return lanes.map((l) => (l.pr || !prs.has(laneKey(l)) ? l : { ...l, pr: prs.get(laneKey(l)) }));
}
