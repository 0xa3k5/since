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
  const mine = refs.filter((r) => byRef.get(refKey(r))?.number === pr.number);
  return mine.find((r) => r.kind === 'branch') || mine.find((r) => r.kind === 'remote') || null;
}

export function prStatusLine(pr) {
  return [pr.draft ? 'Draft' : null, REVIEW_LABELS[pr.review], CHECK_LABELS[pr.checks]].filter(Boolean).join(' · ');
}

export function prTitle(pr, stale = false) {
  return [
    `#${pr.number} ${pr.title}`,
    `${pr.author ? `by ${pr.authorName || pr.author} · ` : ''}${pr.branch} → ${pr.base}`,
    prStatusLine(pr) || null,
    stale ? 'Not refreshed: showing the last result' : null,
  ].filter(Boolean).join('\n');
}

// PR inbox (the lanes overview's Inbox tab): the open repository's PRs you can act on, in
// buckets. A PR shows in the first bucket it matches and not at all if it matches none:
//   1. ready: not a draft, approved, checks green (or none at all) and GitHub says it merges cleanly
//      (`conflicts`, a Set of head branches a local forecast expects to conflict, can veto it)
//   2. requested: your review is requested (`requested`: PR numbers, team requests included)
//   3. failing: checks failed
//   4. mine: you opened it (`me`: your GitHub login), or its lane looks agent-made (`agents`:
//      PR numbers whose lane the lanes data flags)
// Inside a bucket PRs are grouped by author, in the order `prs` lists them (newest first), so one
// agent's PRs read as one batch.
export const INBOX_BUCKETS = [
  { id: 'ready', label: 'Ready to merge' },
  { id: 'requested', label: 'Review requested' },
  { id: 'failing', label: 'CI failing' },
  { id: 'mine', label: 'Yours and your agents’' },
];

export function inboxBucket(pr, { me = null, requested = [], agents = [], conflicts = null } = {}) {
  if (!pr.draft && pr.review === 'approved' && (pr.checks === 'success' || pr.checks == null) && pr.mergeable === true && !conflicts?.has(pr.branch)) return 'ready';
  if (new Set(requested).has(pr.number)) return 'requested';
  if (pr.checks === 'failure') return 'failing';
  if ((me && pr.author && pr.author.toLowerCase() === me.toLowerCase()) || new Set(agents).has(pr.number)) return 'mine';
  return null;
}

// → [{ id, label, count, groups: [{ author, agent, prs }] }], empty buckets left out.
export function inboxBuckets(prs = [], opts = {}) {
  const agents = new Set(opts.agents || []);
  const o = { ...opts, requested: new Set(opts.requested || []), agents };
  const out = new Map(INBOX_BUCKETS.map((b) => [b.id, new Map()]));
  for (const pr of prs) {
    const id = inboxBucket(pr, o);
    if (!id) continue;
    const groups = out.get(id);
    const author = pr.author || 'unknown';
    if (!groups.has(author)) groups.set(author, { author, agent: false, prs: [] });
    const g = groups.get(author);
    g.prs.push(pr);
    // Your own login is never an agent, even when one of your lanes looks agent-made.
    if (agents.has(pr.number) && !(o.me && author.toLowerCase() === o.me.toLowerCase())) g.agent = true;
  }
  return INBOX_BUCKETS.map((b) => {
    const groups = [...out.get(b.id).values()];
    return { ...b, count: groups.reduce((n, g) => n + g.prs.length, 0), groups };
  }).filter((b) => b.count);
}

// The remote a pull request action runs against (app:pr-approve, -merge, -close, …), resolved in
// one place: the PR's own remote (set on the review page), else the caller's (the Inbox's), else
// the PR list's, else the GitHub remote app:pr-state picked (origin if it's on GitHub, else the
// first remote that is). null when the repository has no GitHub remote.
export function prActionRemote(pr, prs, fallback = null) {
  return pr?.remote || fallback || prs?.data?.remote?.name || prs?.remote?.name || null;
}

export const NO_GITHUB_REMOTE = { code: 'no-remote', message: 'This repository has no GitHub remote. Add one (for example origin pointing at github.com), then try again.' };

// Runs a pull request action through `call` (api.app) with the resolved remote. Without one it
// doesn't call at all and returns a readable error instead of the IPC guard's.
export async function prActionCall(call, channel, pr, opts, { prs = null, remote = null } = {}) {
  const name = prActionRemote(pr, prs, remote);
  if (!name) return { error: NO_GITHUB_REMOTE };
  return call(channel, name, pr.number, opts).catch((e) => ({ error: { message: e.message } }));
}
