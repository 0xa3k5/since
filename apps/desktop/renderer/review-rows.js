// Review stages: pure helpers (no DOM) that turn lanes, open PRs and the Inbox data into one row
// per piece of work, sorted into stages. A lane is one entry of `app:lanes-list` (git.lanes, with
// `pr` joined on); a PR is one of github.listPrs `prs`.
import { laneKey } from './lanes.js';

const HOUR = 3600e3;
// "Pushed recently": a lane committed to or edited within this long is still being worked on
// (In progress) when it has no pull request.
export const RECENT_FOR = 48 * HOUR;

export const STAGES = [
  { id: 'stuck', label: 'Stuck' },
  { id: 'ready', label: 'Ready to merge' },
  { id: 'inProgress', label: 'In progress' },
];

const time = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
};

// The row's newest sign of life: the PR's last update or the lane's last commit or edit.
export const rowActivity = (row) => Math.max(time(row.pr?.updatedAt), row.lane?.activity || 0);

const stuck = (pr, conflicts) => pr.checks === 'failure' || pr.mergeable === false || conflicts.length > 0;
// Approved, CI green (or no checks at all) and not a draft. GitHub still working out whether it
// merges cleanly (mergeable null) doesn't hold it back; the merge itself checks again.
const ready = (pr, conflicts) => !pr.draft && pr.review === 'approved' && (pr.checks === 'success' || pr.checks == null)
  && !stuck(pr, conflicts);

// Which stage a row is in, checked in this order (the first match wins):
//   stuck      an open PR with failing checks, GitHub reporting conflicts, or the local forecast
//              predicting some
//   ready      approved, CI green, not a draft
//   inProgress any other open PR (drafts, waiting for review, changes requested, CI running)
//   finished   a lane without an open PR whose work shipped (lane.done, AK-255)
// A lane without a PR uses the same rules on local data only (forecast conflicts are stuck,
// uncommitted changes or recent commits are in progress; it's never ready, there's no review).
// One with none of those, and the base branch, has no stage (null): it's only in Everything else.
export function rowStage(row, { now = Date.now() } = {}) {
  const { pr, lane } = row;
  const conflicts = row.conflicts || [];
  if (pr) {
    if (stuck(pr, conflicts)) return 'stuck';
    if (ready(pr, conflicts)) return 'ready';
    return 'inProgress';
  }
  if (!lane || lane.isBase) return null;
  if (lane.done) return 'finished';
  if (conflicts.length) return 'stuck';
  if (lane.changes > 0 || now - rowActivity(row) < RECENT_FOR) return 'inProgress';
  return null;
}

// Sort rank inside a stage, lowest first, so the top row is the most actionable:
//   stuck      a conflict with the base (the forecast names a clear fix: rebase onto it), then
//              failing checks, then other conflicts (GitHub's, or with another lane)
//   ready      the one waiting longest (oldest activity) first
//   inProgress your review requests first, then newest activity
// Ties fall back to newest activity, then PR number, then title, so the order is stable.
function rank(row, stage, requested) {
  if (stage === 'inProgress') return requested.has(row.pr?.number) ? 0 : 1;
  if (stage === 'stuck') {
    if (row.conflicts?.some((c) => c.base)) return 0;
    return row.pr?.checks === 'failure' ? 1 : 2;
  }
  return 0;
}

function sortStage(rows, stage, requested) {
  const oldestFirst = stage === 'ready';
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
//   { stages: { stuck, ready, inProgress }, finished: { count, items }, all }
// With PRs on, a row is keyed by its PR and carries that PR's branch, worktree and local commits;
// lanes without an open PR only show in `all` (Everything else), unless they're finished. With PRs off
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
    row.stage = rowStage(row, { now });
    // With PRs on, a lane with no open PR that isn't finished is in Everything else only.
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
//   ready       merge
//   stuck       rebase when it conflicts and its branch is here, else the failing checks, else open
//   inProgress  review when your review is requested, else open
//   others      open (the lane in the map, or the PR's review when it isn't checked out here)
export function primaryAction(row, { base = null, requested = new Set() } = {}) {
  const { pr, lane } = row;
  const conflicts = row.conflicts || [];
  if (row.stage === 'ready') return pr && ready(pr, conflicts) ? 'merge' : 'review';
  if (row.stage === 'stuck') {
    if (lane?.branch && !lane.isBase && base && (conflicts.length || pr?.mergeable === false)) return 'rebase';
    if (pr?.url && pr.checks === 'failure') return 'checks';
  }
  if (pr && requested.has(pr.number)) return 'review';
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

// What an action does to the PR list until it reloads (GitHub takes a moment to show it):
// approving marks the PR approved and drops your review request, so it re-stages (Ready to merge,
// or In progress while CI is still running); merging or closing it takes the row away (its lane, if any, goes on to
// the finished line once its work is on the base). Other actions change nothing here.
export function applyAction({ prs = [], requested = [] } = {}, number, id) {
  if (number == null || !prs.some((p) => p.number === number)) return { prs, requested };
  const rest = requested.filter((n) => n !== number);
  if (id === 'approve') return { prs: prs.map((p) => (p.number === number ? { ...p, review: 'approved' } : p)), requested: rest };
  if (id === 'merge' || id === 'close') return { prs: prs.filter((p) => p.number !== number), requested: rest };
  return { prs, requested };
}

// The PR number of a row key from reviewRows (`pr:<n>`), or null for a lane's row.
export const rowPrNumber = (key) => (/^pr:\d+$/.test(key || '') ? Number(key.slice(3)) : null);

const NEEDS = ['stuck', 'ready'];
// Where the selection goes after an action on row `acted`: the next row that still needs you
// (Stuck or Ready to merge) below where `acted` was in `before` (the keys in the order shown), else the
// first one that does, else `acted` itself while it's still listed; null lets the list pick its
// first row. `staged` is the reviewRows result after the action.
export function nextSelection(before, staged, acted) {
  const needs = NEEDS.flatMap((s) => staged.stages[s] || []).filter((r) => r.key !== acted);
  const keys = new Set(needs.map((r) => r.key));
  const i = before.indexOf(acted);
  const below = i >= 0 ? before.slice(i + 1).find((k) => keys.has(k)) : null;
  if (below) return below;
  if (needs.length) return needs[0].key;
  return staged.all.some((r) => r.key === acted) ? acted : null;
}

// Why a row is stuck, in plain words built from facts, or null when it isn't:
//   "conflicts with main in changelog.astro · CI ✗ test, lint"
// Forecast conflicts name the other side and the files (file names, the first `max`, then "+N
// more"); without a forecast, GitHub's own conflict check stands in. Failing checks are named when
// GitHub reported them (pr.failing, github.normalizePr). Send back (AK-279) builds on this too.
// noBase leaves out the conflict with the base, which Review shows as its own note (conflictNote).
export function stuckReason(row, { base = null, max = 2, noBase = false } = {}) {
  const { pr } = row;
  const conflicts = (row.conflicts || []).filter((c) => !noBase || !c.base);
  const out = [];
  const files = (list) => {
    const names = list.slice(0, max).map((f) => f.split('/').pop());
    return `${names.join(', ')}${list.length > max ? ` +${list.length - max} more` : ''}`;
  };
  for (const c of conflicts) out.push(c.files?.length ? `conflicts with ${c.with} in ${files(c.files)}` : `conflicts with ${c.with}`);
  if (!noBase && !conflicts.length && pr?.mergeable === false) out.push(`conflicts with ${pr.base || base || 'its base'}`);
  if (pr?.checks === 'failure') {
    const failing = pr.failing || [];
    out.push(failing.length ? `CI ✗ ${failing.slice(0, max).join(', ')}${failing.length > max ? ` +${failing.length - max} more` : ''}` : 'CI ✗ checks failing');
  }
  return out.length ? out.join(' · ') : null;
}

// A row's conflict with its base (AK-305): the forecast's { with, files }, else GitHub's own check
// ({ with, files: null }), else null.
export function baseConflict(row, base = null) {
  const c = (row.conflicts || []).find((x) => x.base);
  if (c) return { with: c.with, files: c.files || null };
  if (row.pr?.mergeable === false) return { with: row.pr.base || base || 'its base', files: null };
  return null;
}

// Review's note for it, which jumps to the Conflicting files: "Conflicts in 3 files", or
// "Conflicts with main" until the files are known. `files` (what the pane read) wins over the forecast.
export function conflictNote(row, { base = null, files = null } = {}) {
  const c = baseConflict(row, base);
  if (!c) return null;
  const n = (files?.length ? files : c.files)?.length;
  return n ? `Conflicts in ${n} file${n === 1 ? '' : 's'}` : `Conflicts with ${c.with}`;
}
