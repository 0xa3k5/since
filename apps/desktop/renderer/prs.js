// Pull request badges and list. The data comes from github.js through `app:pr-list`:
// { remote: { name, owner }, owners: { remoteName: owner }, prs: [...], at }.

export const REVIEW_LABELS = { approved: 'Approved', changes: 'Changes requested', required: 'Review required' };
export const CHECK_LABELS = { pending: 'Checks running', success: 'Checks passed', failure: 'Checks failed' };

export const refKey = (r) => `${r.kind}:${r.short}`;

// PRs by the refs they belong to (refKey). A PR from this repository matches the local branch
// and the remote-tracking branch with its head name; a fork's PR only matches a local branch
// that tracks that fork (a remote whose owner is the PR's head owner).
export function prsByRef(data, refs = []) {
  const map = new Map();
  if (!data?.remote || !data.prs?.length) return map;
  const lower = (s) => (s || '').toLowerCase();
  const owners = data.owners || {};
  const set = (k, pr) => { if (!map.has(k)) map.set(k, pr); };
  for (const pr of data.prs) {
    if (!pr.branch) continue;
    if (!pr.headOwner || lower(pr.headOwner) === lower(data.remote.owner)) {
      set(`branch:${pr.branch}`, pr);
      set(`remote:${data.remote.name}/${pr.branch}`, pr);
      continue;
    }
    for (const r of refs) {
      if (r.kind !== 'branch' || !r.upstream) continue;
      const i = r.upstream.indexOf('/');
      if (r.upstream.slice(i + 1) === pr.branch && lower(owners[r.upstream.slice(0, i)]) === lower(pr.headOwner)) {
        set(refKey(r), pr);
        set(`remote:${r.upstream}`, pr);
      }
    }
  }
  return map;
}

// Where "go to PR" lands: its local branch if there is one, else its remote-tracking branch.
export function prRef(pr, refs, byRef) {
  const mine = refs.filter((r) => byRef.get(refKey(r)) === pr);
  return mine.find((r) => r.kind === 'branch') || mine.find((r) => r.kind === 'remote') || null;
}

export function prStatusLine(pr) {
  return [pr.draft ? 'Draft' : null, REVIEW_LABELS[pr.review], CHECK_LABELS[pr.checks]].filter(Boolean).join(' · ');
}

export function prTitle(pr, stale = false) {
  return [
    `#${pr.number} ${pr.title}`,
    `${pr.author ? `by ${pr.author} · ` : ''}${pr.branch} → ${pr.base}`,
    prStatusLine(pr) || null,
    stale ? 'Not refreshed: showing the last result' : null,
  ].filter(Boolean).join('\n');
}
