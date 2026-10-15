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
  { id: 'checkout', key: 'review.checkout', label: 'Check out as lane', icon: 'worktree' },
];

// The action a `review` key id runs on a PR page, or null.
export const prActionFor = (keyId) => PR_ACTIONS.find((a) => a.key === keyId)?.id || null;

export const prLaneKey = (pr) => `pr:${pr.number}`;

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
