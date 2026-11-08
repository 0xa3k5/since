// Lanes overview: pure helpers (no DOM) for the triage list in lanes-view.js. A lane is one
// entry of `app:lanes-list` (git.lanes, with `pr` joined on when pull requests are on).

import type { ForecastPair, Lane, LaneWho } from '../../shared/git-types.ts';
import type { PullRequest } from '../../shared/github-types.ts';

export type BucketId = 'conflicts' | 'failing' | 'review' | 'ready' | 'stalled' | 'active' | 'merged' | 'idle';
/** A predicted conflict of a lane: with another lane (`key`) or the base branch. */
export interface LaneConflict { with: string; base: boolean; key: string | null; files: string[] }
/** A lane as Review lists it: git.lanes, with its PR joined on and the forecast's conflicts attached. */
export type ViewLane = Lane & { pr?: PullRequest | null; conflicts?: LaneConflict[] | null; bucket?: BucketId; prTitle?: string | null };
/** What laneKey needs: a branch, else a worktree path, else the name. */
type Keyed = { branch?: string | null; worktree?: { path: string } | null; name: string };
export type ActionId = 'rebase' | 'review' | 'delete' | 'checks' | 'merge' | 'open' | 'discard' | 'cleanup';

const HOUR = 3600e3;
// Uncommitted changes nobody has touched for this long count as stalled work.
const STALLED_AFTER = 2 * HOUR;
// A lane with activity this recent is "active"; older ones are idle.
const ACTIVE_FOR = 3 * 24 * HOUR;

// Buckets, in the order the list shows them. `needs` marks the ones that need you. The most
// actionable first: a conflict usually has a clear fix (rebase onto base), failing CI one link.
const BUCKETS: { id: BucketId; label: string; needs: boolean }[] = [
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
export function laneBucket(lane: ViewLane, now = Date.now()): BucketId {
  const pr = lane.pr;
  // An open PR that fails or waits on review still needs you, even when the lane looks shipped
  // (a second PR for an issue whose first one already merged matches on the key).
  if (lane.conflicts?.length && !lane.done) return 'conflicts';
  if (pr?.checks === 'failure') return 'failing';
  if (pr && (pr.review === 'changes' || pr.review === 'required')) return 'review';
  if (lane.done) return 'merged'; // shipped: otherwise never "needs you"
  if (pr && !pr.draft && pr.checks === 'success' && pr.review === 'approved') return 'ready';
  if ((lane.changes ?? 0) > 0 && lane.activity && now - lane.activity > STALLED_AFTER) return 'stalled';
  if (lane.isBase || lane.merged || lane.worktree?.prunable) return 'idle';
  return lane.activity && now - lane.activity < ACTIVE_FOR ? 'active' : 'idle';
}

// A conflict with the base branch has one clear next step (rebase onto it); one with another lane
// needs a look first. Those sort first within the conflicts bucket.
const baseConflict = (lane: Pick<ViewLane, 'conflicts'>): boolean => Boolean(lane.conflicts?.some((c) => c.base));

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
export function sortLanes<L extends ViewLane>(lanes: readonly L[], now = Date.now()): (L & { bucket: BucketId })[] {
  return lanes
    .map((lane) => ({ lane, bucket: laneBucket(lane, now) }))
    .sort((a, b) => RANK.get(a.bucket)! - RANK.get(b.bucket)! || Number(baseConflict(b.lane)) - Number(baseConflict(a.lane))
      || (b.lane.activity || 0) - (a.lane.activity || 0) || a.lane.name.localeCompare(b.lane.name))
    .map(({ lane, bucket }) => ({ ...lane, bucket }));
}

// Row actions: id → label and its key (keymap id). The first one a lane gets is its next step, shown
// as a button on the row; the rest are in its menu.
export const ACTIONS: Record<ActionId, { label: string; keyId: string; icon: string }> = {
  rebase: { label: 'Rebase onto base', keyId: 'lanes.rebase', icon: 'rebase' },
  review: { label: 'Review', keyId: 'lanes.review', icon: 'check' },
  delete: { label: 'Delete', keyId: 'lanes.delete', icon: 'trash' },
  checks: { label: 'Open checks', keyId: 'lanes.checks', icon: 'external' },
  merge: { label: 'Merge and tidy', keyId: 'lanes.merge', icon: 'merge' },
  open: { label: 'Open worktree', keyId: 'lanes.open', icon: 'worktree' },
  discard: { label: 'Discard', keyId: 'lanes.delete', icon: 'trash' },
  cleanup: { label: 'Clean up', keyId: 'lanes.cleanup', icon: 'trash' },
};

// The lane this window shows: its branch goes by switching this window to another branch first.
export const switchAway = (l: Pick<ViewLane, 'worktree' | 'branch' | 'isBase'>): boolean => Boolean(l.worktree?.current && l.branch && !l.isBase);
// Menu items say what will happen (AK-598): the branch this window shows switches away first.
// Its changes are stashed, not discarded, so it says Delete. `switchTo(branch, base)` → the branch
// it would switch to, or null.
/** The branch to switch to before `branch` goes, or null when there's none. */
type SwitchTo = (branch: string, base?: string | null) => string | null | undefined;
export function removeLabel(l: ViewLane, switchTo: SwitchTo | null = null): string {
  const to = switchAway(l) && l.branch && switchTo?.(l.branch);
  return to ? `Switch to ${to} & Delete` : l.changes ? 'Discard Branch…' : 'Delete Branch…';
}
export function mergeLabel(l: ViewLane, switchTo: SwitchTo | null = null, base: string | null = null): string {
  const to = switchAway(l) && l.branch && switchTo?.(l.branch, base);
  return to ? `Switch to ${to} & Merge and Tidy…` : 'Merge and Tidy…';
}
// Can the lane's worktree and branch go? Not the base, nor a worktree this window or the main one shows.
// With `canSwitch(branch)` (is there a branch to switch to?), the lane this window shows can go too.
type CanSwitch = (branch: string) => boolean;
export const canRemove = (l: ViewLane, canSwitch: CanSwitch | null = null): boolean => (!l.isBase && !l.worktree?.current && !l.worktree?.main && !l.worktree?.locked && Boolean(l.branch || l.worktree))
  || Boolean(canSwitch && switchAway(l) && l.branch && canSwitch(l.branch));
// Why a lane can't go (canRemove false), in a few words; null when it can.
export const removeWhy = (l: ViewLane, canSwitch: CanSwitch | null = null): string | null => canRemove(l, canSwitch) || !(l.branch || l.worktree) ? null
  : l.isBase ? 'Base branch' : canSwitch && switchAway(l) ? 'Only branch' : l.worktree?.current ? 'Open in this window'
    : l.worktree?.main ? 'In the main worktree' : l.worktree?.locked ? 'Worktree is locked' : null;
// Why a row action doesn't apply to the lane, in a few words (the toast's second line and the
// greyed menu item's sub-label); null when it does. `finished`: the lane is merged or gone; `canSwitch` as for canRemove.
export function actionWhy(id: string, l: ViewLane, { base = null, finished = false, canSwitch = null }: { base?: string | null; finished?: boolean; canSwitch?: CanSwitch | null } = {}): string | null {
  const noBranch = l.isBase ? 'Base branch' : 'No branch';
  if (id === 'review') return !l.isBase && (l.branch || l.head) ? null : noBranch;
  if (id === 'merge') return l.branch && !l.isBase ? null : noBranch;
  if (id === 'rebase') return l.branch && !l.isBase ? (base ? null : 'No base branch') : noBranch;
  if (id === 'checks') return l.pr?.url ? null : 'No pull request';
  if (id === 'delete' || id === 'discard') return canRemove(l, canSwitch) ? null : removeWhy(l, canSwitch) || 'No branch';
  if (id === 'cleanup') return finished ? null : 'Not finished';
  return null;
}

// The actions a lane offers, next step first (ids of ACTIONS); [] when nothing needs doing.
// `bucket` is the lane's sortLanes bucket.
export function laneActions(l: ViewLane, bucket: BucketId | undefined = l.bucket): ActionId[] {
  const ids = ({
    conflicts: baseConflict(l) ? ['rebase', 'review', 'delete'] : ['review', 'rebase', 'delete'],
    failing: ['checks', 'review'],
    review: ['review', 'checks'],
    ready: ['merge', 'review'],
    stalled: ['open', 'discard'],
    merged: ['cleanup'],
  } as Partial<Record<BucketId, ActionId[]>>)[bucket ?? 'idle'] || [];
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
export const laneTitle = (l: { title?: string | null; pr?: { title?: string } | null; name: string }): string => l.title || l.pr?.title || l.name;

// A stable key per lane, for keeping the selection across refreshes.
export const laneKey = (lane: Keyed): string => (lane.branch ? `b:${lane.branch}` : `w:${lane.worktree?.path || lane.name}`);

// "↑3 ↓12" against the base; empty for the base itself or when there is no base.
export function aheadBehind(lane: Pick<ViewLane, 'isBase' | 'ahead' | 'behind'>): string {
  if (lane.isBase || lane.ahead == null) return '';
  return [lane.ahead ? `↑${lane.ahead}` : '', lane.behind ? `↓${lane.behind}` : ''].filter(Boolean).join(' ') || 'even';
}

// What Enter does on a lane: switch to its worktree, or show its tip in the map.
export type LaneTarget = { kind: 'worktree'; path: string } | { kind: 'commit'; sha: string };
export function laneTarget(lane: Pick<ViewLane, 'worktree' | 'head'>): LaneTarget | null {
  const w = lane.worktree;
  if (w && !w.current && !w.prunable) return { kind: 'worktree', path: w.path };
  if (lane.head) return { kind: 'commit', sha: lane.head };
  return null;
}

// What ⇧W does for a review row, and so whether its menu offers Check Out (AK-530 follow-up).
// A pull request checks out here even when its branch is already on this Mac; one already
// open in another worktree switches to it, since a branch lives in one worktree at a time.
export interface ReviewRowRef { pr?: unknown; lane?: ViewLane | null }
export function checkoutHereMode({ pr = null, lane = null }: ReviewRowRef = {}): 'switch' | 'pr' | 'open' | null {
  if (lane && laneTarget(lane)?.kind === 'worktree') return 'switch';
  if (pr) return 'pr';
  return lane ? 'open' : null;
}

// The checkout items a review row's menu lists: every pull request gets Check Out (what ⇧W does).
// A branch open in another worktree can't get a second one, so it has no New Worktree item.
export function checkoutChoices(row: ReviewRowRef = {}): ('here' | 'worktree')[] {
  if (!row.pr) return [];
  return checkoutHereMode(row) === 'pr' ? ['here', 'worktree'] : ['here'];
}

// Carry PR data over to a refresh that skipped `gh` (live refreshes stay local): the open PR, and
// "Merged in #N" while the lane's head is still the one that PR merged (AK-338).
export function keepPrs(lanes: ViewLane[], previous: readonly ViewLane[] = []): ViewLane[] {
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
export const sendBackWaits = ({ loaded, prsOn, inbox, inboxFailed }: { loaded: boolean; prsOn: boolean; inbox: unknown; inboxFailed: boolean }): boolean => !loaded || (prsOn && !inbox && !inboxFailed);

// A PR load that a newer local refresh overtook: keep the newer local lanes, take the PR data from the load.
export function takePrs(lanes: ViewLane[], from: readonly ViewLane[] = []): ViewLane[] {
  const prs = new Map(from.map((l) => [laneKey(l), l.pr || null]));
  return lanes.map((l) => (prs.has(laneKey(l)) ? { ...l, pr: prs.get(laneKey(l)) } : l));
}

// Which load results still count. Local refreshes and PR loads are tracked apart, so a local refresh
// (every repo change) never throws away the slower `gh` result still in flight.
// start(prs) → token; lanes(token): no newer load of any kind started; prs(token): no newer PR load started.
export interface LoadToken { local: number; pr: number | null }
export function loadGuard(): { start(prs: boolean): LoadToken; lanes(t: LoadToken): boolean; prs(t: LoadToken): boolean } {
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
export function sharedLoad<T>(): { run(key: string, start: () => T | Promise<T>): Promise<T>; pending(key: string): Promise<T> | null } {
  let cur: { key: string; p: Promise<T> } | null = null;
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

// Review's last local list per repo (AK-639), in `storage` (localStorage): the next visit, or the next
// launch, paints it at once while the fresh one loads. Local data only; PRs have their own load.
// savedLanes → { base, lanes } or null; a list from another format version reads as none.
const SAVED_V = 1;
const savedKey = (repo: string) => `lanes:${repo}`;
export function savedLanes(storage: Pick<Storage, 'getItem'>, repo: string): { base: string | null; lanes: ViewLane[] } | null {
  try {
    const x = JSON.parse(storage.getItem(savedKey(repo)) ?? 'null');
    return x?.v === SAVED_V && Array.isArray(x.lanes) ? { base: x.base ?? null, lanes: x.lanes } : null;
  } catch { return null; }
}
export function saveLanes(storage: Pick<Storage, 'setItem'>, repo: string, { base, lanes }: { base: string | null; lanes: readonly ViewLane[] }): void {
  try { storage.setItem(savedKey(repo), JSON.stringify({ v: SAVED_V, base, lanes })); } catch { /* full or unavailable */ }
}

// `promise`, or a rejection with `message` after `ms`.
export function withTimeout<T>(promise: Promise<T>, ms: number, message = 'Timed out'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

// The forecast (app:lanes-forecast pairs) per lane: Map(laneKey → [{ with, base, files }]), where
// `with` names the other lane (by `titleOf`, its title), or the base branch when `base` is true. Both
// lanes of a pair get it.
export function conflictsByLane(pairs: readonly ForecastPair[] = [], baseName: string | null = null, titleOf: (l: LaneWho) => string = laneTitle): Map<string, LaneConflict[]> {
  const out = new Map<string, LaneConflict[]>();
  const add = (lane: LaneWho, other: LaneWho | null, files: string[]) => {
    const k = laneKey(lane);
    let list = out.get(k);
    if (!list) { list = []; out.set(k, list); }
    list.push({ with: other ? titleOf(other) : baseName || 'base', base: !other, key: other ? laneKey(other) : null, files });
  };
  for (const p of pairs) {
    add(p.a, p.b, p.files);
    if (p.b) add(p.b, p.a, p.files);
  }
  for (const list of out.values()) list.sort((x, y) => Number(y.base) - Number(x.base) || x.with.localeCompare(y.with));
  return out;
}

// Attach the forecast to lanes (`conflicts`, null when none), before sortLanes.
export const withConflicts = <L extends ViewLane>(lanes: readonly L[], byLane: Map<string, LaneConflict[]>): L[] => lanes.map((l) => ({ ...l, conflicts: byLane.get(laneKey(l)) || null }));

// "Conflicts with main on a.js, b.js and 3 more", one line per other lane.
export function conflictText(c: LaneConflict, max = 3): string {
  const names = c.files.slice(0, max).join(', ');
  const more = c.files.length > max ? ` and ${c.files.length - max} more` : '';
  return `Conflicts with ${c.with} on ${names}${more}`;
}
