// Review stages: pure helpers (no DOM) that turn lanes, open PRs and the Inbox data into one row
// per piece of work, sorted into stages. A lane is one entry of `app:lanes-list` (git.lanes, with
// `pr` joined on); a PR is one of github.listPrs `prs`.
import { laneKey } from './lanes.js';
import { AGENT_HINTS } from './agents.js';

const HOUR = 3600e3;
// "Pushed recently": a lane committed to or edited within this long is still being worked on
// (In progress) when it has no pull request.
export const RECENT_FOR = 48 * HOUR;

export const STAGES = [
  { id: 'stuck', label: 'Stuck' },
  { id: 'ready', label: 'Ready to merge' },
  { id: 'inProgress', label: 'In progress' },
];

// Review's tabs (AK-361), one list at a time instead of stacked stages; 1–5 switch. Needs you is
// Stuck and Ready to merge, each under its heading; All open is every stage.
export const TABS = [
  { id: 'needs', label: 'Needs you', keyId: 'lanes.tabNeeds', stages: ['stuck', 'ready'] },
  { id: 'stuck', label: 'Stuck', keyId: 'lanes.tabStuck', stages: ['stuck'] },
  { id: 'ready', label: 'Ready', keyId: 'lanes.tabReady', stages: ['ready'] },
  { id: 'inProgress', label: 'In progress', keyId: 'lanes.tabProgress', stages: ['inProgress'] },
  { id: 'open', label: 'All open', keyId: 'lanes.tabAll', stages: ['stuck', 'ready', 'inProgress'] },
];

const time = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
};

// The row's newest sign of life: the PR's last update or the lane's last commit or edit.
export const rowActivity = (row) => Math.max(time(row.pr?.updatedAt), row.lane?.activity || 0);

// GitHub's merge box state (pr.mergeState, github.normalizePr) once it has worked it out.
// A draft's state is just "draft", so GitHub's older mergeable check and the forecast still count.
const known = (pr) => Boolean(pr?.mergeState && pr.mergeState !== 'unknown' && pr.mergeState !== 'draft');
// Conflicts with the base only (AK-321): GitHub's word when it has one, else its older mergeable
// check or the local forecast against the base. Overlaps with other PRs never count.
const conflicted = (row) => (known(row.pr) ? row.pr.mergeState === 'dirty'
  : row.pr?.mergeable === false || (row.conflicts || []).some((c) => c.base));
// Without GitHub's merge state (an older gh): failing checks or conflicts are stuck; approved, CI
// green (or no checks at all) and not a draft is ready.
const stuck = (row) => row.pr.checks === 'failure' || conflicted(row);
const ready = (pr) => !pr.draft && pr.review === 'approved' && (pr.checks === 'success' || pr.checks == null);

// A PR's stage from GitHub's merge box, the way GitHub would let you merge it (AK-321):
//   dirty                     stuck (conflicts with the base)
//   blocked                   stuck when checks fail or changes are requested; still waiting for
//                             a review or for checks to finish is in progress
//   clean, unstable, behind   ready (unstable: non-required checks fail, GitHub still merges it;
//   has_hooks                 behind: GitHub didn't block it, so it only gets a note)
//   draft                     in progress, as before: stuck when checks fail or it conflicts
//   unknown                   null: the caller keeps the row's previous stage
function prStage(row) {
  const { pr } = row;
  const s = pr.mergeState;
  if (s === 'unknown') return null;
  if (!s) return stuck(row) ? 'stuck' : ready(pr) ? 'ready' : 'inProgress';
  if (pr.draft || s === 'draft') return stuck(row) ? 'stuck' : 'inProgress';
  if (s === 'dirty') return 'stuck';
  if (s === 'blocked') return pr.checks === 'failure' || pr.review === 'changes' ? 'stuck' : 'inProgress';
  return 'ready';
}

// Which stage a row is in:
//   stuck      conflicts with its base, failing required checks or changes requested
//   ready      GitHub would merge it now (see prStage)
//   inProgress any other open PR (drafts, waiting for review, CI running)
//   finished   a lane without an open PR whose work shipped (lane.done, AK-255)
// A PR GitHub is still checking (unknown) keeps `previous`, its stage before; with none it falls
// back to the rules for an older gh. A lane without a PR uses local data only (forecast conflicts
// with the base are stuck, uncommitted changes or recent commits are in progress; it's never
// ready, there's no review). One with none of those, and the base branch, has no stage (null):
// it's only in Everything else. Overlaps with other PRs (row.overlaps) never change the stage.
export function rowStage(row, { now = Date.now(), previous = null } = {}) {
  const { pr, lane } = row;
  const conflicts = row.conflicts || [];
  if (pr) {
    const s = prStage(row);
    if (s) return s;
    if (previous && previous !== 'finished') return previous;
    return stuck(row) ? 'stuck' : ready(pr) ? 'ready' : 'inProgress';
  }
  if (!lane || lane.isBase) return null;
  if (lane.done) return 'finished';
  if (conflicts.length) return 'stuck';
  if (lane.changes > 0 || now - rowActivity(row) < RECENT_FOR) return 'inProgress';
  return null;
}

// rowStage for a PR outside Review (the sidebar and graph dots, AK-388): remembers each PR's last
// stage, so while GitHub is still checking one it keeps that stage, as Review does, instead of
// falling back to the CI-only rules. Make a new one per repository.
export function stageMemory() {
  const last = new Map();
  return (pr) => {
    const key = pr.url || pr.number;
    const stage = rowStage({ pr }, { previous: last.get(key) || null });
    if (stage) last.set(key, stage);
    return stage;
  };
}

// Sort rank inside a stage, lowest first, so the top row is the most actionable:
//   stuck      a conflict with the base (a clear fix: rebase onto it), then failing checks, then
//              the rest (changes requested)
//   ready      the one waiting longest (oldest activity) first
//   inProgress your review requests first, then newest activity
// Ties fall back to newest activity, then PR number, then title, so the order is stable.
function rank(row, stage, requested) {
  if (stage === 'inProgress') return requested.has(row.pr?.number) ? 0 : 1;
  if (stage === 'stuck') {
    if (conflicted(row)) return 0;
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

// `conflicts` keeps the forecast's conflicts with the base only, and none once GitHub says the PR
// doesn't conflict; the ones with other lanes become overlaps (withOverlaps) or are dropped.
const toRow = (pr, lane, forecast) => {
  const all = (lane && (forecast ? forecast.get(laneKey(lane)) : lane.conflicts)) || [];
  const conflicts = known(pr) && pr.mergeState !== 'dirty' ? [] : all.filter((c) => c.base);
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
    others: all.filter((c) => !c.base),
    overlaps: [],
  };
};

// Overlaps (AK-321): the forecast's lane-vs-lane conflicts whose other side is an open PR, as
// [{ number, title, files, size }]. Local branches and work in progress don't count: they may
// still change. Information only.
const prSize = (pr) => (pr?.size?.additions != null && pr.size.deletions != null ? { additions: pr.size.additions, deletions: pr.size.deletions } : null);
function withOverlaps(rows) {
  const byLane = new Map(rows.filter((r) => r.pr && r.lane).map((r) => [laneKey(r.lane), r.pr]));
  for (const row of rows) {
    const seen = new Set();
    row.overlaps = row.pr ? row.others.flatMap((c) => {
      const other = byLane.get(c.key);
      if (!other || other.number === row.pr.number || seen.has(other.number)) return [];
      seen.add(other.number);
      return [{ number: other.number, title: other.title, files: c.files || [], size: prSize(other) }];
    }).sort((a, b) => a.number - b.number) : [];
    delete row.others;
  }
  return rows;
}

// Stacked PRs (AK-537): a PR whose base is another open PR's branch sits on that PR. Number →
// { on, path, at, of, root, base } for every PR in a stack (one with a PR on it or under it): on is
// the PR it sits on (null at the bottom), path the stack's numbers bottom first, at its 1-based place
// in it, root the bottom PR and base the branch the stack lands on. Where two PRs sit on one, the path
// goes up through the lower number. The PR it sits on comes from the same owner, so a fork's `main`
// never counts as a stack.
export function prStacks(prs = []) {
  const byBranch = new Map();
  for (const p of prs || []) if (p?.branch) byBranch.set(`${(p.headOwner || '').toLowerCase()}\0${p.branch}`, p);
  const parent = (p) => { const q = byBranch.get(`${(p.headOwner || '').toLowerCase()}\0${p.base}`); return q && q.number !== p.number ? q : null; };
  const children = new Map();
  for (const p of prs || []) {
    const q = p?.base && parent(p);
    if (q) children.set(q.number, [...(children.get(q.number) || []), p].sort((a, b) => a.number - b.number));
  }
  const out = new Map();
  for (const p of prs || []) {
    if (!p?.number || (!parent(p) && !children.has(p.number))) continue;
    const down = [p];
    for (let q = parent(p); q && !down.includes(q); q = parent(q)) down.unshift(q);
    const path = [...down];
    for (let q = children.get(p.number)?.[0]; q && !path.includes(q); q = children.get(q.number)?.[0]) path.push(q);
    out.set(p.number, { on: parent(p)?.number ?? null, path: path.map((q) => q.number), at: down.length, of: path.length, root: path[0].number, base: path[0].base || null });
  }
  return out;
}

// A stage's rows with each stack's rows together, bottom first, where its first row was (AK-537).
function keepStacks(rows) {
  const out = [];
  const placed = new Set();
  for (const r of rows) {
    if (placed.has(r)) continue;
    const mates = r.stack ? rows.filter((x) => x.stack?.root === r.stack.root).sort((a, b) => a.stack.at - b.stack.at || a.pr.number - b.pr.number) : [r];
    for (const m of mates) { placed.add(m); out.push(m); }
  }
  return out;
}

// The row's stack note: "on #41 · 2 of 3", or "Stack · 1 of 3" at the bottom; null outside a stack.
// Its tooltip spells the stack out: "Stacked: main ‹ #41 ‹ #42 ‹ #43. Merge from the bottom."
export function stackNote(row) {
  const s = row?.stack;
  if (!s) return null;
  return {
    text: `${s.on ? `on #${s.on}` : 'Stack'} · ${s.at} of ${s.of}`,
    title: `Stacked: ${[s.base || 'base', ...s.path.map((n) => `#${n}`)].join(' ‹ ')}. Merge from the bottom.`,
  };
}

// The order the pane's stack path folds its PRs into "··· N" when the line runs out of room (AK-540):
// indexes into `path`, the PRs farthest from this one (`at`, 1-based) first, then the bottom PR, then
// the one above this, then the one below. This PR never folds.
export function stackFoldOrder(path, at) {
  const me = at - 1;
  const kept = [me - 1, me + 1, 0];
  const rest = path.map((_, i) => i).filter((i) => i !== me && !kept.includes(i)).sort((a, b) => Math.abs(b - me) - Math.abs(a - me) || b - a);
  return [...rest, ...kept.filter((i, k) => i >= 0 && i < path.length && i !== me && kept.indexOf(i) === k).reverse()];
}

// Whether the rows next to rows[i] are in its stack (the list's rail joins their dots): { up, down }.
export function stackRail(rows, i) {
  const root = rows[i]?.stack?.root;
  if (root == null) return { up: false, down: false };
  return { up: rows[i - 1]?.stack?.root === root, down: rows[i + 1]?.stack?.root === root };
}

// One row per piece of work, sorted into stages, a stack's rows together (keepStacks):
//   { stages: { stuck, ready, inProgress }, finished: { count, items }, all }
// A PR's row carries `stack` (prStacks) when it's in one, else null.
// With PRs on, a row is keyed by its PR and carries that PR's branch, worktree and local commits;
// lanes without an open PR only show in `all` (Everything else), unless they're finished. With PRs off
// (`prsOn` false) `prs` and `reviewRequested` are ignored and rows come from lanes alone.
// `forecast` is conflictsByLane's Map (laneKey → conflicts); without it, lane.conflicts is used.
// `previous` (row key → stage, from the last call) holds a PR GitHub is still checking in place.
// `all` lists every row, staged ones first in stage order, then the rest by newest activity.
// What the Review page's title calls "needs you": stuck plus ready to merge. The sidebar badge shows the same count.
export const needsYou = (stages) => stages.stuck.length + stages.ready.length;

export function reviewRows({ lanes = [], prs = [], reviewRequested = [], forecast = null, prsOn = false, now = Date.now(), previous = null } = {}) {
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
  withOverlaps(rows);
  const stacks = prsOn ? prStacks(prs) : new Map();
  for (const row of rows) row.stack = (row.pr && stacks.get(row.pr.number)) || null;

  const stages = Object.fromEntries(STAGES.map((s) => [s.id, []]));
  const finished = [];
  const rest = [];
  for (const row of rows) {
    row.stage = rowStage(row, { now, previous: previous?.get(row.key) || null });
    // With PRs on, a lane with no open PR that isn't finished is in Everything else only.
    if (prsOn && !row.pr && row.stage !== 'finished') row.stage = null;
    if (row.stage === 'finished') finished.push(row);
    else if (row.stage) stages[row.stage].push(row);
    else rest.push(row);
  }
  for (const s of STAGES) stages[s.id] = keepStacks(sortStage(stages[s.id], s.id, requested));
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
//   stuck       rebase when it conflicts with its base and its branch is here, else send back
//   inProgress  review when your review is requested, else open
//   others      open (the lane in the map, or the PR's review when it isn't checked out here)
export function primaryAction(row, { base = null, requested = new Set() } = {}) {
  const { pr, lane } = row;
  if (row.stage === 'ready') return pr ? 'merge' : 'review';
  if (row.stage === 'stuck') return lane?.branch && !lane.isBase && base && conflicted(row) ? 'rebase' : 'sendBack';
  if (pr && requested.has(pr.number)) return 'review';
  return 'open';
}

export const STEPS = {
  review: { label: 'Review', keyId: 'lanes.review', icon: 'diff' },
  merge: { label: 'Merge', keyId: 'lanes.merge', icon: 'merge' },
  rebase: { label: 'Rebase', keyId: 'lanes.rebase', icon: 'rebase' },
  open: { label: 'Open', keyId: 'lanes.open', icon: 'worktree' },
  sendBack: { label: 'Fix prompt…', keyId: 'lanes.sendBack', icon: 'sparkle' },
};

// Small CI and review badges for a row: [{ text, kind, title, signal }], kind '' | 'ok' | 'warn' | 'busy'.
// An agent shows as an author (rowAuthors, AK-390), not as a badge. `signal` marks the ones Review
// shows as glyphs instead (rowSignals).
// chip: Review's row shows it as a chip after the title (rowChips), so its line leaves it out.
export function rowBadges(row, { requested = new Set() } = {}) {
  const { pr } = row;
  const out = [];
  if (pr?.draft) out.push({ text: 'Draft', kind: 'draft', title: 'A draft pull request' });
  if (pr?.checks === 'success') out.push({ text: 'CI passed', kind: 'ok', title: 'Checks passed', chip: true });
  else if (pr?.checks === 'failure') out.push({ text: 'CI failing', kind: 'warn', title: 'Checks are failing', signal: true, chip: true });
  else if (pr?.checks === 'pending') out.push({ text: 'CI running', kind: 'busy', title: 'Checks are still running' });
  if (pr && requested.has(pr.number)) out.push({ text: 'Your review', kind: 'busy', title: 'Your review is requested' });
  else if (pr?.review === 'approved') out.push({ text: 'Approved', kind: 'ok', title: 'Approved', icon: 'check', chip: true });
  else if (pr?.review === 'changes') out.push({ text: 'Changes requested', kind: 'warn', title: 'A reviewer requested changes', icon: 'x', chip: true });
  else if (pr?.review === 'required') out.push({ text: 'Needs review', kind: '', title: 'Waiting for a review', icon: 'pending' });
  if (pr?.mergeState === 'unknown') out.push({ text: 'Checking', kind: 'busy', spin: true, title: 'GitHub is still checking whether it merges cleanly' });
  if (conflicted(row)) out.push({ text: 'Conflicts', kind: 'warn', title: `Conflicts with ${pr?.base || 'its base'}`, signal: true });
  else if (pr?.mergeState === 'behind') out.push({ text: `Behind ${pr.base || 'base'}`, kind: '', title: `${pr.base || 'Its base'} has newer commits; GitHub still allows the merge` });
  if (row.worktree?.changes) out.push({ text: `${row.worktree.changes} changed`, kind: '', title: 'Uncommitted changes in its worktree' });
  return out;
}

// Why a row looks agent-made, or null: its lane's guess (branch name, commit trailers), else a bot
// opened its PR.
export function rowAgent({ lane, pr } = {}) {
  if (lane?.agent) return `Looks agent-made (${lane.agent.reason}: ${lane.agent.match})`;
  return pr?.bot ? `Opened by a bot (${pr.authorName || pr.author})` : null;
}

// What to call a reviewer or author: the name (github.js fills it with a bot's login without its
// "app/" and "[bot]", AK-312), else the login.
const who = (p) => p.name || p.login || '';

// The name to show for an agent guess (AK-390; git.agentGuess, or { reason: 'bot author', match }):
// a trailer's value without its <email> and any (note) ("Co-Authored-By: Claude Opus 5.5 (1M context)
// <noreply@anthropic.com>" → "Claude Opus 5.5"), a bot's name without "[bot]", else the branch
// prefix capitalised ("codex/" → "Codex", "ai/" → "AI"). null when there's nothing to go on.
export function agentName(agent) {
  if (!agent?.match) return null;
  const match = String(agent.match);
  if (agent.reason === 'trailer') {
    const value = match.replace(/^[A-Za-z0-9-]+:\s*/, '');
    const name = value.replace(/<[^>]*>?/g, '').replace(/\([^)]*\)?/g, '').replace(/\s+/g, ' ').trim();
    return name || (/<([^@>]+)@/.exec(value)?.[1] ?? null);
  }
  if (agent.reason === 'bot author') return match.replace(/^app\//, '').replace(/\[bot\]$/i, '').trim() || null;
  const prefix = match.replace(/\/+$/, '').trim();
  if (!prefix) return null;
  return prefix.length <= 2 ? prefix.toUpperCase() : prefix[0].toUpperCase() + prefix.slice(1);
}

// An agent named in a commit message's trailers (Catch up's reader, AK-390), like git.agentGuess:
// a Co-Authored-By naming a coding agent, or a trailer only agents write. → { reason, match } or null.
export function messageAgent(message = '') {
  for (const line of String(message || '').split('\n')) {
    const m = /^([A-Za-z0-9-]+):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (AGENT_HINTS.trailers.includes(key)) return { reason: 'trailer', match: `${m[1]}: ${m[2]}` };
    if (key === 'co-authored-by' && AGENT_HINTS.coauthors.some((w) => m[2].toLowerCase().split(/[^a-z0-9]+/).includes(w))) return { reason: 'trailer', match: `${m[1]}: ${m[2]}` };
  }
  return null;
}

// Who made it (AK-390): [{ name, key, agent, title }], the person first, then the agent. A PR a bot
// opened is that bot alone; a person's PR on an agent-made lane is both ("AK + Claude Opus 5.5").
// person: { name, key } when the caller knows one without a PR (Catch up's commit author).
// agents: whether agent-made marks are on; off, only the person shows.
export function authorsOf({ pr = null, agent = null, person = null, agents = true } = {}) {
  const out = [];
  if (pr?.bot) {
    const name = who({ name: pr.authorName, login: pr.author }) || 'Bot';
    return [{ name, key: pr.author || name, agent: true, title: `${name} (a bot opened it)` }];
  }
  // A commit by a bot ("dependabot[bot]") is that bot alone, like a PR a bot opened.
  if (!pr?.author && /\[bot\]$/i.test(person?.name || '')) {
    const name = person.name.replace(/\[bot\]$/i, '').trim();
    return [{ name, key: person.key || person.name, agent: true, title: `${name} (a bot)` }];
  }
  const p = pr?.author ? { name: pr.authorName || pr.author, key: pr.author } : person?.name ? { name: person.name, key: person.key || person.name } : null;
  if (p) out.push({ ...p, agent: false, title: p.key && p.key !== p.name ? `${p.name} (${p.key})` : p.name });
  const name = agents ? agentName(agent) : null;
  if (name && !(p && p.name.toLowerCase() === name.toLowerCase())) {
    out.push({ name, key: `agent:${name}`, agent: true, title: `${name}: looks agent-made (${agent.reason}: ${agent.match})` });
  }
  return out;
}
// A review row's authors: its PR's author and its lane's agent guess.
export const rowAuthors = (row, { agents = false } = {}) => authorsOf({ pr: row?.pr || null, agent: row?.lane?.agent || null, agents });

// A PR's reviewers for its header: one entry per person or team, [{ key, name, login, state }],
// state 'changes' | 'approved' | 'commented' | 'pending'. A request outranks an older review (it was
// re-requested); dismissed reviews are left out. Changes first, then approvals, comments, pending.
const REVIEWER_ORDER = { changes: 0, approved: 1, commented: 2, pending: 3 };
export function reviewers(pr) {
  const out = new Map();
  for (const r of pr?.reviewRequests || []) out.set(`${r.team ? 'team:' : ''}${r.login}`, { key: `${r.team ? 'team:' : ''}${r.login}`, name: who(r), login: r.team ? null : r.login, state: 'pending' });
  for (const r of pr?.reviews || []) {
    if (out.has(r.login) || !(r.state in REVIEWER_ORDER)) continue;
    out.set(r.login, { key: r.login, name: who(r), login: r.login, state: r.state, at: r.submittedAt || null });
  }
  return [...out.values()].sort((a, b) => REVIEWER_ORDER[a.state] - REVIEWER_ORDER[b.state]);
}

// Rows whose title, branch, PR number or author has every word of `query`.
export function filterRows(rows, query = '') {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const text = [r.title, r.branch, r.lane?.name, r.pr ? `#${r.pr.number}` : '', r.pr?.author, r.pr?.authorName].filter(Boolean).join(' ').toLowerCase();
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
  // Converted to draft or marked ready (AK-610): the row re-stages; review requests stay.
  if (id === 'draft' || id === 'ready') return { prs: prs.map((p) => (p.number === number ? { ...p, draft: id === 'draft' } : p)), requested };
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

// The row line's at-a-glance trouble (AK-411): failing checks as ✕ and a count, a conflict with the
// base as a marker; { checks: { text, title } | null, conflict: { title } | null }. The count is
// passed/total when GitHub's counts reach the renderer (pr.checkCounts), else how many are failing.
// conflictShown: the row's text already says it conflicts (a stuck row's note), so no marker too.
export function rowSignals(row, { conflictShown = false } = {}) {
  const { pr } = row;
  let checks = null;
  if (pr?.checks === 'failure') {
    const failing = pr.failing || [];
    const c = pr.checkCounts;
    const counted = c && Number.isSafeInteger(c.passed) && Number.isSafeInteger(c.total) && c.total > 0;
    const names = failing.length ? `: ${failing.slice(0, 20).join(', ')}` : '';
    checks = counted
      ? { text: `${c.passed}/${c.total}`, title: `${c.passed} of ${c.total} checks passed${names}` }
      : { text: failing.length ? String(failing.length) : '', title: `${failing.length || 'Some'} ${failing.length === 1 ? 'check is' : 'checks are'} failing${names}` };
  }
  return { checks, conflict: !conflictShown && conflicted(row) ? { title: `Conflicts with ${pr?.base || 'its base'}` } : null };
}

// Why a row is stuck, in plain words built from facts, or null when it isn't:
//   "conflicts with main in changelog.astro · CI ✗ test, lint"
// Forecast conflicts name the other side and the files (file names, the first `max`, then "+N
// more"); without a forecast, GitHub's own conflict check stands in. Failing checks are named when
// GitHub reported them (pr.failing, github.normalizePr). Send back (AK-279) builds on this too.
// noBase leaves out the conflict with the base, which Review shows as its own note (conflictNote);
// bareChecks names the failing checks without "CI ✗", which Review's row shows as a glyph (rowSignals).
export function stuckReason(row, { base = null, max = 2, noBase = false, bareChecks = false } = {}) {
  const { pr } = row;
  const conflicts = (row.conflicts || []).filter((c) => !noBase || !c.base);
  const out = [];
  const files = (list) => {
    const names = list.slice(0, max).map((f) => f.split('/').pop());
    return `${names.join(', ')}${list.length > max ? ` +${list.length - max} more` : ''}`;
  };
  for (const c of conflicts) out.push(c.files?.length ? `conflicts with ${c.with} in ${files(c.files)}` : `conflicts with ${c.with}`);
  if (!noBase && !conflicts.length && conflicted(row)) out.push(`conflicts with ${pr?.base || base || 'its base'}`);
  if (pr?.checks === 'failure') {
    const failing = pr.failing || [];
    const names = `${failing.slice(0, max).join(', ')}${failing.length > max ? ` +${failing.length - max} more` : ''}`;
    if (bareChecks) { if (failing.length) out.push(names); } else out.push(failing.length ? `CI ✗ ${names}` : 'CI ✗ checks failing');
  }
  if (pr?.mergeState === 'blocked' && pr.review === 'changes') out.push('changes requested');
  return out.length ? out.join(' · ') : null;
}

// Why M (or Merge…) on a PR with no lane here can't merge it yet (AK-275): null when the row's main
// action is Merge, else "Not ready: CI failing · changes requested".
export function mergeBlock(row, { base = null } = {}) {
  if (primaryAction(row, { base }) === 'merge') return null;
  const { pr } = row;
  const why = [pr?.draft && 'it’s a draft', stuckReason(row, { base }), pr?.checks === 'pending' && 'CI still running',
    pr?.review === 'changes' && pr.mergeState !== 'blocked' && 'changes requested'].filter(Boolean);
  return `Not ready: ${why.length ? why.join(' · ') : `#${pr?.number} isn’t ready to merge`}`;
}

// The sub line's quiet overlap note: "Overlaps #87", or "Overlaps 2 PRs" with the list as its
// tooltip ("#87 Title: a.js, b.js" per line). null without overlaps.
export function overlapNote(row) {
  const list = row.overlaps || [];
  if (!list.length) return null;
  const text = list.length === 1 ? `Overlaps #${list[0].number}` : `Overlaps ${list.length} PRs`;
  return { text, title: list.map((o) => `#${o.number} ${o.title}${o.files.length ? `: ${o.files.join(', ')}` : ''}`).join('\n') };
}

// The pane's merge order line per overlap: { number, files, smaller } where files is
// "lanes-view.js" (file names, the first `max`, then "+N more") and smaller is null when a size is
// unknown, else { self, size: { additions, deletions } } for the smaller PR (ties: the older one).
export function mergeOrder(row, { max = 2 } = {}) {
  const self = prSize(row.pr);
  return (row.overlaps || []).map((o) => {
    const names = o.files.slice(0, max).map((f) => f.split('/').pop());
    const files = names.length ? `${names.join(', ')}${o.files.length > max ? ` +${o.files.length - max} more` : ''}` : null;
    let smaller = null;
    if (self && o.size) {
      const a = self.additions + self.deletions;
      const b = o.size.additions + o.size.deletions;
      const mine = a < b || (a === b && row.pr.number < o.number);
      smaller = { self: mine, size: mine ? self : o.size };
    }
    return { number: o.number, files, smaller };
  });
}

// A row's conflict with its base (AK-305): the forecast's { with, files }, else GitHub's own check
// ({ with, files: null }), else null.
export function baseConflict(row, base = null) {
  const c = (row.conflicts || []).find((x) => x.base);
  if (c) return { with: c.with, files: c.files || null };
  if (conflicted(row)) return { with: row.pr?.base || base || 'its base', files: null };
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

// ── Change facts and evidence (AK-520) ──
// Pure helpers for Review's row chips and the reader's facts line and evidence strip. facts is a
// change-facts.js result, evidence a github.evidence one. Absence is never stated: a missing field
// gives nothing, and the one absence shown is "CI didn't run" (evidence.ciMissing).

// A flag-level fact's chip on a row; info-level facts ("tests changed") never get one.
export const FACT_CHIPS = { dependencies: 'deps', ci: 'ci config', 'tests-deleted': 'test deleted', 'tests-skipped': 'tests skipped', modes: 'mode changed', binaries: 'binaries', fragile: 'fragile' };
// A fact's label in the reader's facts line.
const FACT_LABELS = {
  dependencies: (n) => (n === 1 ? 'dependency changed' : 'dependencies changed'), ci: () => 'ci config', 'tests-deleted': (n) => (n === 1 ? 'test deleted' : 'tests deleted'),
  'tests-skipped': () => 'tests skipped', modes: () => 'mode changed', binaries: (n) => (n === 1 ? 'binary' : 'binaries'), fragile: () => 'fragile',
  'tests-changed': () => 'tests changed', deleted: () => 'deleted', 'lockfile-drift': () => 'locked versions',
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// "and 3 more" (change-facts.js listed) isn't a detail of its own.
const realDetails = (f) => (f.details || []).filter((d) => !/^and \d+ more$/.test(d));
const detailCount = (f) => { const d = f.details || []; const more = /^and (\d+) more$/.exec(d[d.length - 1] || ''); return realDetails(f).length + (more ? +more[1] : 0); };

// Checks a PR's result counts as failed, as GitHub's rollup does.
const FAILED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'error', 'cancelled']);
export const checkFailed = (c) => FAILED.has(c?.result);
// evidence.checks → { failed, passed, running, total }
export function checkTally(checks = []) {
  const failed = checks.filter(checkFailed).length;
  const running = checks.filter((c) => c.result === 'pending').length;
  return { failed, running, passed: checks.length - failed - running, total: checks.length };
}

// The row's compact signals, in order: check result, review state, open threads, media, then change
// facts. → [{ id, kind ('pass' | 'fail' | 'fact' | ''), icon, text, title }]. The row folds what
// doesn't fit into "+N" (lanes-view.js), so this returns them all.
export function rowChips(row, { facts = null, evidence = null, requested = new Set() } = {}) {
  const { pr } = row;
  const out = [];
  if (pr?.checks === 'failure') {
    const failing = pr.failing || [];
    const c = pr.checkCounts;
    const n = failing.length || (c && Number.isSafeInteger(c.total) && Number.isSafeInteger(c.passed) ? c.total - c.passed : 0);
    const s = rowSignals(row);
    out.push({ id: 'checks', kind: 'fail', icon: 'x', text: failing.length === 1 ? failing[0] : n ? `${n} failed` : 'failed', title: s.checks?.title || 'Checks are failing' });
  } else if (pr?.checks === 'success') {
    const c = pr.checkCounts;
    const counted = c && Number.isSafeInteger(c.passed) && Number.isSafeInteger(c.total) && c.total > 0;
    out.push({ id: 'checks', kind: 'pass', icon: 'check', text: counted ? `${c.passed}/${c.total}` : 'passed', title: counted ? `${c.passed} of ${c.total} checks passed` : 'Checks passed' });
  } else if (evidence?.ciMissing) {
    out.push({ id: 'checks', kind: '', icon: 'warning', text: 'CI didn’t run', title: 'No checks ran on the head of this pull request, and this repository has CI set up' });
  }
  if (pr && !requested.has(pr.number)) {
    if (pr.review === 'approved') out.push({ id: 'review', kind: '', icon: 'check', text: 'approved', title: 'Approved' });
    else if (pr.review === 'changes') out.push({ id: 'review', kind: '', icon: 'undo', text: 'changes requested', title: 'A reviewer requested changes' });
  }
  const open = evidence?.threads?.open || 0;
  if (open) out.push({ id: 'threads', kind: '', icon: 'comment', text: plural(open, 'open thread'), title: `${plural(open, 'open review thread')}${evidence.threads.outdated ? `, ${evidence.threads.outdated} on lines that changed since` : ''}` });
  const media = evidence?.media || [];
  const images = media.filter((m) => m.kind === 'image').length;
  const videos = media.filter((m) => m.kind === 'video').length;
  if (images) out.push({ id: 'images', kind: '', icon: 'image', text: plural(images, 'image'), title: `${plural(images, 'image')} in the description, comments or reviews` });
  if (videos) out.push({ id: 'videos', kind: '', icon: 'play', text: plural(videos, 'video'), title: `${plural(videos, 'video')} in the description, comments or reviews` });
  for (const f of facts?.facts || []) {
    if (f.level !== 'flag' || !FACT_CHIPS[f.id]) continue;
    const d = realDetails(f).slice(0, 5);
    const more = detailCount(f) - d.length;
    out.push({ id: `fact:${f.id}`, kind: 'fact', icon: null, text: FACT_CHIPS[f.id], title: [f.title, ...d, more ? `and ${more} more` : null].filter(Boolean).join('\n') });
  }
  return out;
}

// The reader's facts line: the size and spread, then one line per fact.
// → { size: [{ n, label }] (after the +added −deleted), added, deleted, lines: [{ id, label, detail, title, flag }] }
// or null without facts. No test files changed says nothing: absence is never stated (AK-516).
export function factLines(facts) {
  if (!facts?.size) return null;
  const z = facts.size;
  const size = [
    { n: z.files, label: z.files === 1 ? 'file' : 'files' },
    folders(z.areas),
    z.assets ? { n: z.assets, label: z.assets === 1 ? 'asset' : 'assets' } : null,
    z.generated ? { n: z.generated, label: 'generated' } : null,
    z.lockfiles?.length ? { n: z.lockfiles.length, label: z.lockfiles.length === 1 ? 'lockfile' : 'lockfiles', title: z.lockfiles.map((l) => `${l.path} +${l.added} −${l.deleted}`).join('\n') } : null,
  ].filter(Boolean);
  const lines = (facts.facts || []).filter((f) => !(f.id === 'tests-changed' && !f.count)).map((f) => {
    const d = realDetails(f);
    const more = detailCount(f) - d.length;
    const label = (FACT_LABELS[f.id] || (() => f.title))(detailCount(f));
    return { id: f.id, label, detail: d.join(', ') + (more ? ` and ${more} more` : ''), title: [f.title, ...(f.details || [])].join('\n'), flag: f.level === 'flag' };
  });
  return { added: z.added, deleted: z.deleted, size, lines };
}
// The top-level folders the diff touches, when it spans more than one: named up to two ("in
// apps/desktop, packages/tokens"), else "4 folders" with the list in its tooltip (AK-516).
function folders(areas = []) {
  if (!areas || areas.length < 2) return null;
  const title = areas.map((a) => `${a.area === '.' ? 'the repository root' : a.area}: ${plural(a.files, 'file')}, ${a.lines} lines`).join('\n');
  if (areas.length > 2) return { n: areas.length, label: 'folders', title };
  return { n: null, label: `in ${areas.map((a) => (a.area === '.' ? 'the root' : a.area)).join(', ')}`, title };
}

// The evidence strip's tabs, left to right; a tab with nothing in it isn't there.
// → [{ id, label, count?, tally?, kind ('fail' | 'pass' | 'absent' | ''), icon, group ('ci' | 'people') }]
export function evidenceTabs(evidence) {
  if (!evidence) return [];
  const out = [];
  if (evidence.checks?.length) {
    const t = checkTally(evidence.checks);
    out.push({ id: 'checks', label: 'Checks', tally: t, kind: t.failed ? 'fail' : t.running ? '' : 'pass', icon: t.failed ? 'x' : t.running ? 'pending' : 'check', group: 'ci' });
  } else if (evidence.ciMissing) out.push({ id: 'ci', label: 'CI didn’t run', kind: 'absent', icon: 'warning', group: 'ci' });
  if (evidence.annotations?.length) out.push({ id: 'annotations', label: 'Annotations', count: evidence.annotations.length, kind: '', icon: null, group: 'ci' });
  if (evidence.media?.length) out.push({ id: 'media', label: 'Media', count: evidence.media.length, kind: '', icon: 'image', group: 'ci' });
  if (evidence.threads?.open) out.push({ id: 'threads', label: 'Open threads', count: evidence.threads.open, kind: '', icon: 'comment', group: 'people' });
  return out;
}
// Which tab the strip opens on: Checks when one fails, else none (closed).
export const evidenceDefault = (evidence) => (evidence?.checks?.some(checkFailed) ? 'checks' : null);
// "3m 05s", "48s"
export function duration(s) {
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
// A failed check's log lines (evidence.logs: [{ run, log }]), matched by the run in its link.
export function checkLog(check, logs = []) {
  const run = /\/actions\/runs\/(\d+)/.exec(check?.url || '')?.[1];
  return run ? logs.find((l) => String(l.run) === run)?.log || '' : '';
}
