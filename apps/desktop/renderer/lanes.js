// Lanes overview: pure helpers (no DOM) for the triage list in lanes-view.js. A lane is one
// entry of `app:lanes-list` (git.lanes, with `pr` joined on when pull requests are on).

const HOUR = 3600e3;
// Uncommitted changes nobody has touched for this long count as stalled work.
export const STALLED_AFTER = 2 * HOUR;
// A lane with activity this recent is "active"; older ones are idle.
export const ACTIVE_FOR = 3 * 24 * HOUR;

// Buckets, in the order the list shows them. `needs` marks the ones that need you. The most
// actionable first: a conflict usually has a clear fix (rebase onto base), failing CI one link.
export const BUCKETS = [
  { id: 'conflicts', label: 'Predicted conflicts', needs: true },
  { id: 'failing', label: 'CI failing', needs: true },
  { id: 'review', label: 'Review', needs: true },
  { id: 'ready', label: 'Ready to merge', needs: true },
  { id: 'stalled', label: 'Stalled', needs: true },
  { id: 'active', label: 'Active', needs: false },
  { id: 'merged', label: 'Merged', needs: false },
  { id: 'idle', label: 'Idle', needs: false },
];
const RANK = new Map(BUCKETS.map((b, i) => [b.id, i]));

// Which bucket a lane sorts into. PR fields only exist while pull requests are on.
export function laneBucket(lane, now = Date.now()) {
  const pr = lane.pr;
  // An open PR that fails or waits on review still needs you, even when the lane looks shipped
  // (a second PR for an issue whose first one already merged matches on the key).
  if (lane.conflicts?.length && !lane.done) return 'conflicts';
  if (pr?.checks === 'failure') return 'failing';
  if (pr && (pr.review === 'changes' || pr.review === 'required')) return 'review';
  if (lane.done) return 'merged'; // shipped: otherwise never "needs you"
  if (pr && !pr.draft && pr.checks === 'success' && pr.review === 'approved') return 'ready';
  if (lane.changes > 0 && lane.activity && now - lane.activity > STALLED_AFTER) return 'stalled';
  if (lane.isBase || lane.merged || lane.worktree?.prunable) return 'idle';
  return lane.activity && now - lane.activity < ACTIVE_FOR ? 'active' : 'idle';
}

// A conflict with the base branch has one clear next step (rebase onto it); one with another lane
// needs a look first. Those sort first within the conflicts bucket.
const baseConflict = (lane) => Boolean(lane.conflicts?.some((c) => c.base));

// Sort order, "needs you" first:
//   1. predicted conflicts with the base or another lane (lane.conflicts, from the forecast), the ones
//      with the base first
//   2. CI failing on the lane's PR
//   3. review requested or changes requested on the PR
//   4. ready to merge: checks green and approved, not a draft, no predicted conflicts
//   5. a worktree with uncommitted changes and no activity for STALLED_AFTER (stuck or abandoned work)
//   6. active: committed to or edited within ACTIVE_FOR
//   7. merged: shipped on the base branch, waiting for Clean up
//   8. idle: older lanes, missing worktrees and the base branch itself
// Within a bucket the most recent activity comes first, then by name so the order is stable.
export function sortLanes(lanes, now = Date.now()) {
  return lanes
    .map((lane) => ({ lane, bucket: laneBucket(lane, now) }))
    .sort((a, b) => RANK.get(a.bucket) - RANK.get(b.bucket) || baseConflict(b.lane) - baseConflict(a.lane)
      || (b.lane.activity || 0) - (a.lane.activity || 0) || a.lane.name.localeCompare(b.lane.name))
    .map(({ lane, bucket }) => ({ ...lane, bucket }));
}

// Row actions: id → label and its key (keymap id). The first one a lane gets is its next step, shown
// as a button on the row; the rest are in its menu.
export const ACTIONS = {
  rebase: { label: 'Rebase onto base', keyId: 'lanes.rebase', icon: 'rebase' },
  review: { label: 'Review', keyId: 'lanes.review', icon: 'check' },
  delete: { label: 'Delete', keyId: 'lanes.delete', icon: 'trash' },
  checks: { label: 'Open checks', keyId: 'lanes.checks', icon: 'external' },
  merge: { label: 'Merge and tidy', keyId: 'lanes.merge', icon: 'merge' },
  open: { label: 'Open worktree', keyId: 'lanes.open', icon: 'worktree' },
  discard: { label: 'Discard', keyId: 'lanes.delete', icon: 'trash' },
  cleanup: { label: 'Clean up', keyId: 'lanes.cleanup', icon: 'trash' },
};

// Can the lane's worktree and branch go? Not the base, nor a worktree this window or the main one shows.
export const canRemove = (l) => !l.isBase && !l.worktree?.current && !l.worktree?.main && !l.worktree?.locked && Boolean(l.branch || l.worktree);

// The actions a lane offers, next step first (ids of ACTIONS); [] when nothing needs doing.
// `bucket` is the lane's sortLanes bucket.
export function laneActions(l, bucket = l.bucket) {
  const ids = {
    conflicts: baseConflict(l) ? ['rebase', 'review', 'delete'] : ['review', 'rebase', 'delete'],
    failing: ['checks', 'review'],
    review: ['review', 'checks'],
    ready: ['merge', 'review'],
    stalled: ['open', 'discard'],
    merged: ['cleanup'],
  }[bucket] || [];
  return ids.filter((id) => {
    if (id === 'rebase' || id === 'merge') return Boolean(l.branch) && !l.isBase;
    if (id === 'checks') return Boolean(l.pr?.url);
    if (id === 'open') return Boolean(l.worktree && !l.worktree.current && !l.worktree.prunable);
    if (id === 'delete' || id === 'discard') return canRemove(l);
    if (id === 'review') return !l.isBase && Boolean(l.branch || l.head);
    return true;
  });
}

// What the row leads with: its title (PR title, else the newest commit subject), then the branch.
export const laneTitle = (l) => l.title || l.pr?.title || l.name;

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
    const hay = [l.title, l.name, l.branch, l.worktree?.path, l.upstream, l.pr ? `#${l.pr.number} ${l.pr.title}` : ''].filter(Boolean).join(' ').toLowerCase();
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

// What ⇧W does for a review row, and so whether its menu offers Check Out (AK-530 follow-up).
// A pull request checks out here even when its branch is already on this Mac; one already
// open in another worktree switches to it, since a branch lives in one worktree at a time.
export function checkoutHereMode({ pr = null, lane = null } = {}) {
  if (lane && laneTarget(lane)?.kind === 'worktree') return 'switch';
  if (pr) return 'pr';
  return lane ? 'open' : null;
}

// The checkout items a review row's menu lists: every pull request gets Check Out (what ⇧W does).
// A branch open in another worktree can't get a second one, so it has no New Worktree item.
export function checkoutChoices(row = {}) {
  if (!row.pr) return [];
  return checkoutHereMode(row) === 'pr' ? ['here', 'worktree'] : ['here'];
}

// Carry PR data over to a refresh that skipped `gh` (live refreshes stay local): the open PR, and
// "Merged in #N" while the lane's head is still the one that PR merged (AK-338).
export function keepPrs(lanes, previous = []) {
  const prs = new Map(previous.filter((l) => l.pr).map((l) => [laneKey(l), l.pr]));
  const merged = new Map(previous.filter((l) => l.done?.reason === 'pr').map((l) => [laneKey(l), l]));
  return lanes.map((l) => {
    const m = merged.get(laneKey(l));
    const done = l.done?.reason !== 'pr' && m && m.head === l.head ? { done: m.done, prTitle: m.prTitle ?? null } : null;
    if (!done && (l.pr || !prs.has(laneKey(l)))) return l;
    return { ...l, ...(l.pr || !prs.has(laneKey(l)) ? {} : { pr: prs.get(laneKey(l)) }), ...done };
  });
}

// sendBack(number) waits for the lanes, and with PRs on for the inbox too (AK-289): Merge plan's
// "Send back #12" link can land before the `gh` inbox has loaded.
export const sendBackWaits = ({ loaded, prsOn, inbox, inboxFailed }) => !loaded || (prsOn && !inbox && !inboxFailed);

// A PR load that a newer local refresh overtook: keep the newer local lanes, take the PR data from the load.
export function takePrs(lanes, from = []) {
  const prs = new Map(from.map((l) => [laneKey(l), l.pr || null]));
  return lanes.map((l) => (prs.has(laneKey(l)) ? { ...l, pr: prs.get(laneKey(l)) } : l));
}

// Which load results still count. Local refreshes and PR loads are tracked apart, so a local refresh
// (every repo change) never throws away the slower `gh` result still in flight.
// start(prs) → token; lanes(token): no newer load of any kind started; prs(token): no newer PR load started.
export function loadGuard() {
  let local = 0;
  let pr = 0;
  return {
    start: (prs) => ({ local: ++local, pr: prs ? ++pr : null }),
    lanes: (t) => t.local === local,
    prs: (t) => t.pr != null && t.pr === pr,
  };
}

// One load in flight at a time (AK-382): run(key, start) joins the load already running for `key`, or
// calls start() for a new one; a run for another key replaces it. pending(key) → that load, or null.
// The load when a repo opens and Reload share it, so a repo costs one `gh` call, not two.
export function sharedLoad() {
  let cur = null;
  return {
    run(key, start) {
      if (cur?.key === key) return cur.p;
      const entry = { key, p: (async () => start())() }; // start() runs now; a throw becomes a rejection
      cur = entry;
      const done = () => { if (cur === entry) cur = null; };
      entry.p.then(done, done);
      return entry.p;
    },
    pending: (key) => (cur?.key === key ? cur.p : null),
  };
}

// `promise`, or a rejection with `message` after `ms`.
export function withTimeout(promise, ms, message = 'Timed out') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

// The forecast (app:lanes-forecast pairs) per lane: Map(laneKey → [{ with, base, files }]), where
// `with` names the other lane (by `titleOf`, its title), or the base branch when `base` is true. Both
// lanes of a pair get it.
export function conflictsByLane(pairs = [], baseName = null, titleOf = laneTitle) {
  const out = new Map();
  const add = (lane, other, files) => {
    const k = laneKey(lane);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ with: other ? titleOf(other) : baseName || 'base', base: !other, key: other ? laneKey(other) : null, files });
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
