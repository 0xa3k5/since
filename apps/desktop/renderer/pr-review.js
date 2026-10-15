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
