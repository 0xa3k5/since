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
