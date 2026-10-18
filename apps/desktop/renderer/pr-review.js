// Reviewing a pull request from the Inbox: pure helpers (no DOM) for the review page in PR mode
// (review-view.js with `pr`). The PR's head is fetched into FETCH_HEAD only (`app:pr-review-head`),
// so the diff is a local git diff against the base's remote-tracking branch, and the per-file
// ticks work as they do for a lane, keyed `pr:<number>`.

// The page's actions, with their key ids (keymap.js `review` scope). Approve, request changes,
// merge and close happen on GitHub and can't be undone; checking out is a journaled lane.
export const PR_ACTIONS = [
  { id: 'approve', key: 'review.approve', label: 'Approve…', icon: 'check' },
  { id: 'changes', key: 'review.changes', label: 'Request changes…', icon: 'edit' },
  { id: 'merge', key: 'review.merge', label: 'Merge…', icon: 'merge' },
  { id: 'close', key: 'review.closePr', label: 'Close…', icon: 'x', danger: true },
  { id: 'checkout', key: 'review.checkout', label: 'Check out in worktree', icon: 'worktree' },
];

// The action a `review` key id runs on a PR page, or null.
export const prActionFor = (keyId) => PR_ACTIONS.find((a) => a.key === keyId)?.id || null;

export const prLaneKey = (pr) => `pr:${pr.number}`;

// A checked-out stacked PR (AK-538) is reviewed against its own base branch on the remote, so the
// PRs below it stay out of its diff. null when the PR targets the repo's base (`base`, e.g.
// `origin/main` or `main`) or there's no PR or remote.
export function stackedBase(pr, base, remote) {
  if (!pr?.base || !base || !remote) return null;
  const name = base.startsWith(`${remote}/`) ? base.slice(remote.length + 1) : base;
  return pr.base === name ? null : `${remote}/${pr.base}`;
}

// Fetches the PR's head and builds the `state.review` record for it. `call(channel, ...args)` is
// api.app; it resolves to { ok } or { error }. Returns { review } or { error }.
export async function loadPrReview(pr, remote, call) {
  if (!remote) return { error: { message: 'This repository has no GitHub remote.' } };
  const res = await call('pr-review-head', remote, pr.number, pr.base || null).catch((e) => ({ error: { message: e.message } }));
  if (res?.error) return { error: res.error };
  const { sha, base } = res.ok;
  const name = `#${pr.number} ${pr.title || pr.branch}`;
  return {
    review: {
      lane: { key: prLaneKey(pr), name, rev: sha },
      base: base || null,
      // Not a local branch: "Merge and tidy" isn't offered; Merge goes through GitHub.
      source: { name, branch: null, head: sha },
      pr: { ...pr, remote },
    },
  };
}

// What to do after a remote action finishes: merged or closed PRs leave the page for the Inbox;
// approving or requesting changes stays on it.
export const leavesPage = (id) => id === 'merge' || id === 'close';

// Review's right-hand pane (review-pane.js): its actions, each with a key in the pane (`review`
// scope) and in the list (`lanes` scope). Merge, approve and close happen on GitHub; check out
// and merge-and-tidy are local and journaled. (Open in IDE has a slot here once that lands.)
export const PANE_ACTIONS = [
  { id: 'merge', key: 'review.merge', listKey: 'lanes.merge', label: 'Merge…', icon: 'merge', remote: true },
  { id: 'approve', key: 'review.approve', listKey: 'lanes.approve', label: 'Approve…', icon: 'check', remote: true },
  { id: 'close', key: 'review.closePr', listKey: 'lanes.closePr', label: 'Close…', icon: 'x', remote: true, danger: true },
  { id: 'checkout', key: 'review.checkout', listKey: 'lanes.checkout', label: 'Check out', icon: 'worktree' },
  { id: 'github', key: 'review.github', listKey: 'lanes.github', label: 'Open on GitHub', icon: 'external' },
];

// The pane's actions for a row (reviewRows) and its one primary button, chosen by the row's
// primary step (review-rows.js primaryAction): merge when it's ready, approve when your review is
// asked for. A PR gets them all; a local branch (PR features off, or no PR) gets merge and tidy
// plus open; the base branch only open. Returns { actions: [{ ...PANE_ACTIONS entry, label }], primary }.
export function paneActions(row, step) {
  const { pr, lane } = row;
  const branch = Boolean(lane?.branch && !lane.isBase);
  const label = (a) => {
    if (a.id === 'merge' && !pr) return 'Merge and tidy…';
    if (a.id === 'checkout' && lane) return lane.worktree && !lane.worktree.current ? 'Open worktree' : 'Show in Map';
    if (a.id === 'checkout') return 'Check out as worktree…';
    return a.label;
  };
  const ids = pr ? ['merge', 'approve', 'close', 'checkout', ...(pr.url ? ['github'] : [])]
    : [...(branch ? ['merge'] : []), ...(lane ? ['checkout'] : [])];
  const actions = PANE_ACTIONS.filter((a) => ids.includes(a.id)).map((a) => ({ ...a, label: label(a), remote: Boolean(a.remote && pr) }));
  let primary = null;
  if (step === 'merge' && ids.includes('merge')) primary = 'merge';
  else if (step === 'review' && pr) primary = 'approve';
  else if (step === 'sendBack') primary = 'sendBack';
  else if (pr && !lane) primary = 'checkout';
  return { actions, primary };
}

// A stuck row's fixes (AK-359), for the pane's Stuck line and ⌘K, in the order you'd try them:
// rebase onto the base when it conflicts and its branch is here, else check the PR out to fix it
// here; update its branch on GitHub when it conflicts or is behind and isn't here (AK-364); jump
// to the conflicting files (Conflicts); open the failing checks (Checks); send it back to whoever made it. Short labels on the buttons (AK-373); the note says what they do.
// ctx: the pane's { base, conflicts } (conflicts: it conflicts with its base). [] unless stuck.
export function fixActions(row, { base = null, conflicts = false } = {}) {
  if (row?.stage !== 'stuck') return [];
  const { pr, lane } = row;
  const local = Boolean(lane?.branch && !lane.isBase);
  const out = [];
  if (conflicts && local && base) out.push({ id: 'rebase', key: 'review.rebase', listKey: 'lanes.rebase', label: `Rebase onto ${base}`, icon: 'rebase', note: 'Fix the conflicts here (undoable)' });
  else if (conflicts && pr && !lane) out.push({ id: 'checkout', key: 'review.checkout', listKey: 'lanes.checkout', label: 'Check out to fix…', icon: 'worktree', note: 'Opens it in its own worktree, where you can rebase it' });
  if (pr && !lane && (conflicts || pr.mergeState === 'behind')) out.push({ id: 'updateBranch', key: 'review.updateBranch', listKey: 'lanes.updateBranch', label: 'Update branch…', icon: 'pull', note: `Merges or rebases ${base || 'the base'} into it on GitHub: ⌘Z can’t undo it`, remote: true });
  if (conflicts) out.push({ id: 'showConflicts', key: 'review.showConflicts', listKey: 'lanes.showConflicts', label: 'Conflicts', icon: 'diff', note: 'Show the conflicting files' });
  if (pr?.checks === 'failure' && pr.url) out.push({ id: 'checks', key: 'review.checks', listKey: 'lanes.checks', label: 'Checks', icon: 'checks', note: 'Open the failing checks in your browser' });
  out.push({ id: 'sendBack', key: 'review.sendBack', listKey: 'lanes.sendBack', label: 'Fix prompt…', icon: 'sparkle', note: 'A ready-made prompt to fix it, for you or an agent' });
  return out;
}

// Why Update branch (U) doesn't apply to this row, or null when it does: the list key follows
// the pane, which offers it only on stuck PRs that aren't here and conflict or are behind.
export function updateBranchBlock(row, ctx) {
  if (fixActions(row, ctx).some((a) => a.id === 'updateBranch')) return null;
  if (!row?.pr) return `${row?.title} has no pull request to update`;
  if (row.lane) return `${row.title} is checked out here: pull or rebase it instead`;
  return `${row.title} doesn’t need updating`;
}

// The PR's description for the pane, as plain text: template comments (<!-- … -->) dropped, runs
// of blank lines squeezed to one, trimmed. null when GitHub didn't send one (older list data);
// '' when the author left it empty.
export function prDescription(pr) {
  if (typeof pr?.body !== 'string') return null;
  return pr.body.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
