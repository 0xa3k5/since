// Review stages: pure helpers (no DOM) that turn lanes, open PRs and the Inbox data into one row
// per piece of work, sorted into stages. A lane is one entry of `app:lanes-list` (git.lanes, with
// `pr` joined on); a PR is one of github.listPrs `prs`.
import { laneKey } from './lanes.js';

const HOUR = 3600e3;
// "Pushed recently": a PR updated, or a lane committed to or edited, within this long is still
// being worked on (In progress) when nothing waits on you.
export const RECENT_FOR = 48 * HOUR;

export const STAGES = [
  { id: 'needsYou', label: 'Needs you' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'inProgress', label: 'In progress' },
  { id: 'elsewhere', label: 'Handled elsewhere' },
];

const time = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
};

// The row's newest sign of life: the PR's last update or the lane's last commit or edit.
export const rowActivity = (row) => Math.max(time(row.pr?.updatedAt), row.lane?.activity || 0);

const ready = (pr, conflicts) => !pr.draft && pr.review === 'approved' && (pr.checks === 'success' || pr.checks == null)
  && pr.mergeable === true && !conflicts.length;

// Which stage a row is in, checked in this order (the first match wins):
//   needsYou   your review is requested, or the PR is approved, green (or has no checks), GitHub says
//              it merges cleanly and the local forecast agrees
//   blocked    checks failing, GitHub reports conflicts, or the forecast predicts some
//   inProgress a draft, or activity within RECENT_FOR
//   elsewhere  any other open PR
//   finished   a lane without an open PR whose work shipped (lane.done, AK-255)
// A lane without a PR uses the same rules on local data only (forecast, uncommitted changes, recent
// commits); one with none of those, and the base branch, has no stage (null): it's only in `all`.
export function rowStage(row, { requested = new Set(), now = Date.now() } = {}) {
  const { pr, lane } = row;
  const conflicts = row.conflicts || [];
  if (pr) {
    if (requested.has(pr.number) || ready(pr, conflicts)) return 'needsYou';
    if (pr.checks === 'failure' || pr.mergeable === false || conflicts.length) return 'blocked';
    if (pr.draft || now - rowActivity(row) < RECENT_FOR) return 'inProgress';
    return 'elsewhere';
  }
  if (!lane || lane.isBase) return null;
  if (lane.done) return 'finished';
  if (conflicts.length) return 'blocked';
  if (lane.changes > 0 || now - rowActivity(row) < RECENT_FOR) return 'inProgress';
  return null;
}

// Sort rank inside a stage, lowest first, so the top row is the most actionable:
//   needsYou   review requests before ready-to-merge PRs; in each, the one waiting longest
//              (oldest activity) first
//   blocked    a conflict with the base (the forecast names a clear fix: rebase onto it), then
//              failing checks, then other conflicts (GitHub's, or with another lane)
//   others     newest activity first
// Ties fall back to newest activity, then PR number, then title, so the order is stable.
function rank(row, stage, requested) {
  if (stage === 'needsYou') return requested.has(row.pr?.number) ? 0 : 1;
  if (stage === 'blocked') {
    if (row.conflicts?.some((c) => c.base)) return 0;
    return row.pr?.checks === 'failure' ? 1 : 2;
  }
  return 0;
}

function sortStage(rows, stage, requested) {
  const oldestFirst = stage === 'needsYou';
  return rows.sort((a, b) => rank(a, stage, requested) - rank(b, stage, requested)
    || (oldestFirst ? rowActivity(a) - rowActivity(b) : rowActivity(b) - rowActivity(a))
    || (a.pr?.number || 0) - (b.pr?.number || 0) || a.title.localeCompare(b.title));
}

// The lane of a PR: the one `app:lanes-list` joined it to (lane.pr, github.joinLanes), which
// already knows a fork's owner, so a fork's PR never lands on a same-named local branch.
const laneOf = (pr, lanes, taken) => lanes.find((l) => !taken.has(l) && !l.isBase && l.pr?.number === pr.number) || null;

const toRow = (pr, lane, forecast) => {
  const conflicts = (lane && (forecast ? forecast.get(laneKey(lane)) : lane.conflicts)) || [];
  return {
    key: pr ? `pr:${pr.number}` : laneKey(lane),
    title: pr?.title || lane?.title || lane?.name || '',
    pr: pr || null,
    lane: lane || null,
    branch: lane?.branch || pr?.branch || null,
    worktree: lane?.worktree ? { path: lane.worktree.path, changes: lane.changes || 0 } : null,
    // Local commits on the lane's branch that aren't on the base.
    ahead: lane?.ahead ?? null,
    conflicts,
  };
};

// One row per piece of work, sorted into stages:
//   { stages: { needsYou, blocked, inProgress, elsewhere }, finished: { count, items }, all }
// With PRs on, a row is keyed by its PR and carries that PR's branch, worktree and local commits;
// lanes without an open PR only show in `all` (Show all), unless they're finished. With PRs off
// (`prsOn` false) `prs` and `reviewRequested` are ignored and rows come from lanes alone.
// `forecast` is conflictsByLane's Map (laneKey → conflicts); without it, lane.conflicts is used.
// `all` lists every row, staged ones first in stage order, then the rest by newest activity.
export function reviewRows({ lanes = [], prs = [], reviewRequested = [], forecast = null, prsOn = false, now = Date.now() } = {}) {
  const requested = new Set(prsOn ? reviewRequested : []);
  const taken = new Set();
  const rows = [];
  if (prsOn) {
    for (const pr of prs || []) {
      const lane = laneOf(pr, lanes, taken);
      if (lane) taken.add(lane);
      rows.push(toRow(pr, lane, forecast));
    }
  }
  for (const lane of lanes) if (!taken.has(lane)) rows.push(toRow(null, lane, forecast));

  const stages = Object.fromEntries(STAGES.map((s) => [s.id, []]));
  const finished = [];
  const rest = [];
  for (const row of rows) {
    row.stage = rowStage(row, { requested, now });
    // With PRs on, a lane with no open PR that isn't finished is Show all only.
    if (prsOn && !row.pr && row.stage !== 'finished') row.stage = null;
    if (row.stage === 'finished') finished.push(row);
    else if (row.stage) stages[row.stage].push(row);
    else rest.push(row);
  }
  for (const s of STAGES) sortStage(stages[s.id], s.id, requested);
  sortStage(finished, 'finished', requested);
  sortStage(rest, null, requested);
  return {
    stages,
    finished: { count: finished.length, items: finished },
    all: [...STAGES.flatMap((s) => stages[s.id]), ...finished, ...rest],
  };
}

// The row's one primary button, by stage (ids; STEPS has their labels):
//   needsYou  merge when it's approved, green and mergeable and your review isn't requested, else review
//   blocked   rebase when it conflicts and its branch is here, else the failing checks, else open
//   others    open (the lane in the map, or the PR's review when it isn't checked out here)
export function primaryAction(row, { base = null, requested = new Set() } = {}) {
  const { pr, lane } = row;
  const conflicts = row.conflicts || [];
  if (row.stage === 'needsYou') return pr && !requested.has(pr.number) && ready(pr, conflicts) ? 'merge' : 'review';
  if (row.stage === 'blocked') {
    if (lane?.branch && !lane.isBase && base && (conflicts.length || pr?.mergeable === false)) return 'rebase';
    if (pr?.url && pr.checks === 'failure') return 'checks';
  }
  return 'open';
}

export const STEPS = {
  review: { label: 'Review', keyId: 'lanes.review', icon: 'diff' },
  merge: { label: 'Merge', keyId: 'lanes.merge', icon: 'merge' },
  rebase: { label: 'Rebase', keyId: 'lanes.rebase', icon: 'rebase' },
  checks: { label: 'Open checks', keyId: 'lanes.checks', icon: 'external' },
  open: { label: 'Open', keyId: 'lanes.open', icon: 'worktree' },
};

// Small CI and review badges for a row: [{ text, kind, title }], kind '' | 'ok' | 'warn' | 'busy'.
export function rowBadges(row, { requested = new Set() } = {}) {
  const { pr } = row;
  const out = [];
  if (pr?.draft) out.push({ text: 'Draft', kind: '', title: 'A draft pull request' });
  if (pr?.checks === 'success') out.push({ text: 'CI passed', kind: 'ok', title: 'Checks passed' });
  else if (pr?.checks === 'failure') out.push({ text: 'CI failing', kind: 'warn', title: 'Checks are failing' });
  else if (pr?.checks === 'pending') out.push({ text: 'CI running', kind: 'busy', title: 'Checks are still running' });
  if (pr && requested.has(pr.number)) out.push({ text: 'Your review', kind: 'busy', title: 'Your review is requested' });
  else if (pr?.review === 'approved') out.push({ text: 'Approved', kind: 'ok', title: 'Approved' });
  else if (pr?.review === 'changes') out.push({ text: 'Changes requested', kind: 'warn', title: 'A reviewer requested changes' });
  else if (pr?.review === 'required') out.push({ text: 'Needs review', kind: '', title: 'Waiting for a review' });
  if ((row.conflicts || []).length || pr?.mergeable === false) out.push({ text: 'Conflicts', kind: 'warn', title: 'Conflicts with its base or another branch' });
  if (row.worktree?.changes) out.push({ text: `${row.worktree.changes} changed`, kind: '', title: 'Uncommitted changes in its worktree' });
  return out;
}

// Rows whose title, branch, PR number or author has every word of `query`.
export function filterRows(rows, query = '') {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const text = [r.title, r.branch, r.lane?.name, r.pr ? `#${r.pr.number}` : '', r.pr?.author].filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
