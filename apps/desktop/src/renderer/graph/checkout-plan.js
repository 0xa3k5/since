// What double-click / ⌘↵ on a Map row does (AK-456). Pure, so it can be unit-tested.
//   { kind: 'switch', branch }        a local branch tip (not the current branch): switch to it
//   { kind: 'remote', remote, local } only a remote branch is here: offer a local tracking branch
//   { kind: 'commit' }                a plain commit: offer a new branch here or a detached checkout
//   null                              already HEAD: nothing to do
export function checkoutPlan(c, refs, head) {
  if (!c) return null;
  const at = refs.filter((r) => r.target === c.sha);
  const branch = at.find((r) => r.kind === 'branch' && r.short !== head.branch);
  if (branch) return { kind: 'switch', branch: branch.short };
  if (c.sha === head.oid) return null;
  const locals = new Set(refs.filter((r) => r.kind === 'branch').map((r) => r.short));
  for (const r of at) {
    if (r.kind !== 'remote') continue;
    const local = r.short.slice(r.short.indexOf('/') + 1);
    // A local branch of that name already exists elsewhere: `checkout --track` would fail.
    if (local && local !== r.short && !locals.has(local)) return { kind: 'remote', remote: r.short, local };
  }
  return { kind: 'commit' };
}

// The sheet for checking out a branch that worktree `wt` has checked out (AK-581). Pure, so it can
// be unit-tested. `hold` is git's worktreeHold ({ blocker, changes, changedAt }); `mine` counts
// this window's uncommitted changes.
//   { kind: 'blocked', where, why, actions: ['open'] or [] }   it can't give the branch up (folder gone, open elsewhere, …)
//   { kind: 'clean', where, actions: ['free', 'open'] }       nothing to carry: free it there, check it out here
//   { kind: 'dirty', where, changes, changed, stash, actions: ['move', 'open'] }
//     its changes come along; `changed` ("Last changed 2 min ago") only under 10 minutes,
//     `stash` (this window's changes) only when there are some
export function inUsePlan(wt, hold, mine = 0, now = Date.now()) {
  const where = wt.path.replace(/^\/Users\/[^/]+/, '~').replace(/^(~?)\/.+\/([^/]+)$/, '$1/…/$2');
  if (hold.blocker) return { kind: 'blocked', where, why: hold.blocker, actions: wt.missing ? [] : ['open'] };
  if (!hold.changes) return { kind: 'clean', where, actions: ['free', 'open'] };
  const age = hold.changedAt ? now - hold.changedAt : Infinity;
  return {
    kind: 'dirty',
    where,
    changes: `${hold.changes} uncommitted change${hold.changes === 1 ? '' : 's'}`,
    changed: age < 10 * 60e3 ? `Last changed ${age < 60e3 ? 'just now' : `${Math.round(age / 60e3)} min ago`}` : null,
    stash: mine ? `Stash my ${mine} change${mine === 1 ? '' : 's'}` : null,
    actions: ['move', 'open'],
  };
}
