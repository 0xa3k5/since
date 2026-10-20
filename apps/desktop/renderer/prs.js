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

// The remote a pull request action runs against (app:pr-approve, -merge, -close, …), resolved in
// one place: the PR's own remote (set on the review page), else the caller's (the Inbox's), else
// the PR list's, else the GitHub remote app:pr-state picked (origin if it's on GitHub, else the
// first remote that is). null when the repository has no GitHub remote.
export function prActionRemote(pr, prs, fallback = null) {
  return pr?.remote || fallback || prs?.data?.remote?.name || prs?.remote?.name || null;
}

export const NO_GITHUB_REMOTE = { code: 'no-remote', message: 'This repository has no GitHub remote.' };

// Runs a pull request action through `call` (api.app) with the resolved remote. Without one it
// doesn't call at all and returns a readable error instead of the IPC guard's.
export async function prActionCall(call, channel, pr, opts, { prs = null, remote = null } = {}) {
  const name = prActionRemote(pr, prs, remote);
  if (!name) return { error: NO_GITHUB_REMOTE };
  return call(channel, name, pr.number, opts).catch((e) => ({ error: { message: e.message } }));
}

// Why you can't approve a pull request (AK-577), or null. `viewer` is the PR list's { login, write }
// (github.js viewerFacts); without it nothing is greyed and GitHub has the last word.
export function approveWhy(pr, viewer) {
  if (!pr || !viewer?.login) return null;
  if (pr.author && pr.author.toLowerCase() === viewer.login.toLowerCase()) return 'Your own pull request';
  if (viewer.write === false) return 'Needs write access';
  return null;
}

// Draft ↔ ready for review (AK-610): the one switch that applies to an open PR, or null once it's
// closed or merged. Its author or anyone with write access can flip it, so it's greyed (why) only
// on someone else's PR when you're known to lack write access. label: pane and page; menu: the
// context menus' title case; command: ⌘K. It happens on GitHub, so there's no Undo: the toast
// offers the opposite switch instead.
export function draftSwitch(pr, viewer) {
  if (!pr || (pr.state && pr.state !== 'open')) return null;
  const own = Boolean(pr.author && viewer?.login && pr.author.toLowerCase() === viewer.login.toLowerCase());
  const why = !own && viewer?.write === false ? 'Needs write access' : null;
  const n = `#${pr.number}`;
  return pr.draft
    ? { channel: 'pr-ready', draft: false, icon: 'eye', why, label: 'Mark ready for review', menu: 'Mark Ready for Review', command: `Mark ${n} ready for review`, busy: `Marking ${n} ready for review…`, done: `Marked ${n} ready for review`, cant: `Can’t mark ${n} ready for review`, failed: `Couldn’t mark ${n} ready for review`, back: 'Convert back to draft' }
    : { channel: 'pr-draft', draft: true, icon: 'edit', why, label: 'Convert to draft', menu: 'Convert to Draft', command: `Convert ${n} to draft`, busy: `Converting ${n} to draft…`, done: `Converted ${n} to draft`, cant: `Can’t convert ${n} to draft`, failed: `Couldn’t convert ${n} to draft`, back: 'Mark ready for review' };
}

// The PR list after a switch: that PR's draft flag set, so its badge and row update before the
// next reload. Other PRs, and a list without it, stay as they are.
export const withDraft = (prs, number, draft) => (prs || []).map((p) => (p.number === number ? { ...p, draft } : p));
