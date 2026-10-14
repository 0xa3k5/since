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
  { id: 'conflicts', label: 'Predicted conflicts', needs: true },
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
  if (lane.conflicts?.length) return 'conflicts';
  if (lane.changes > 0 && lane.activity && now - lane.activity > STALLED_AFTER) return 'stalled';
  if (pr && !pr.draft && pr.checks === 'success' && pr.review === 'approved') return 'ready';
  if (lane.isBase || lane.merged || lane.worktree?.prunable) return 'idle';
  return lane.activity && now - lane.activity < ACTIVE_FOR ? 'active' : 'idle';
}

// Sort order, "needs you" first:
//   1. CI failing on the lane's PR
//   2. review requested or changes requested on the PR
//   3. predicted conflicts with the base or another lane (lane.conflicts, from the forecast)
//   4. a worktree with uncommitted changes and no activity for STALLED_AFTER (stuck or abandoned work)
//   5. ready to merge: checks green and approved, not a draft, no predicted conflicts
//   6. active: committed to or edited within ACTIVE_FOR
//   7. idle: older lanes, merged lanes, missing worktrees and the base branch itself
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
// `agentsOnly` keeps lanes that look agent-made; `conflictsOnly` lanes with predicted conflicts.
export function filterLanes(lanes, query = '', { agentsOnly = false, conflictsOnly = false } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return lanes.filter((l) => {
    if (agentsOnly && !l.agent) return false;
    if (conflictsOnly && !l.conflicts?.length) return false;
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

// The forecast (app:lanes-forecast pairs) per lane: Map(laneKey → [{ with, base, files }]), where
// `with` names the other lane, or the base branch when `base` is true. Both lanes of a pair get it.
export function conflictsByLane(pairs = [], baseName = null) {
  const out = new Map();
  const add = (lane, other, files) => {
    const k = laneKey(lane);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ with: other ? other.name : baseName || 'base', base: !other, files });
  };
  for (const p of pairs) {
    add(p.a, p.b, p.files);
    if (p.b) add(p.b, p.a, p.files);
  }
  for (const list of out.values()) list.sort((x, y) => Number(y.base) - Number(x.base) || x.with.localeCompare(y.with));
  return out;
}

// Attach the forecast to lanes (`conflicts`, null when none), before sortLanes.
export const withConflicts = (lanes, byLane) => lanes.map((l) => ({ ...l, conflicts: byLane.get(laneKey(l)) || null }));

// "Conflicts with main on a.js, b.js and 3 more", one line per other lane.
export function conflictText(c, max = 3) {
  const names = c.files.slice(0, max).join(', ');
  const more = c.files.length > max ? ` and ${c.files.length - max} more` : '';
  return `Conflicts with ${c.with} on ${names}${more}`;
}
