// Review's catch-up card (AK-281), the pure part: what landed on the base since a checkpoint, as
// entries (a merged PR, or a commit that came without one) and as groups to read at a glance.
// Built from app:catchup (git log on the base's first-parent line, plus merged PRs from `gh` while
// PRs are on). No AI: issue keys and folders only.

// A generic issue key: "AK-12", "WEB2-345".
export const ISSUE_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;
export const issueKey = (...texts) => texts.map((t) => (t || '').match(ISSUE_KEY)?.[0]).find(Boolean) || null;

// The area a path belongs to: apps/<name> and packages/<name>, else its top-level folder.
export function areaOf(file) {
  const parts = file.split('/');
  if (parts.length === 1) return 'Top level';
  if ((parts[0] === 'apps' || parts[0] === 'packages') && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}
// A change's area: the one most of its files are in (first seen wins a tie).
export function mainArea(files = []) {
  const n = new Map();
  for (const f of files) { const a = areaOf(f); n.set(a, (n.get(a) || 0) + 1); }
  let best = null;
  for (const [a, c] of n) if (!best || c > n.get(best)) best = a;
  return best || 'No files';
}

// commits: app:catchup commits (newest first); merged: its merged PRs or null. A commit that is a
// merged PR's merge commit (squash, merge or the last of a rebase) becomes that PR.
// → [{ id, kind: 'pr' | 'commit', number?, title, branch?, sha, parent, date, author, files, key, area }]
export function landedEntries(commits = [], merged = null) {
  const byMerge = new Map((merged || []).filter((p) => p.merge).map((p) => [p.merge, p]));
  return commits.map((c) => {
    const pr = byMerge.get(c.sha);
    const title = pr ? pr.title || c.subject : c.subject;
    return {
      id: pr ? `pr:${pr.number}` : `commit:${c.sha}`,
      kind: pr ? 'pr' : 'commit',
      ...(pr ? { number: pr.number, branch: pr.branch } : {}),
      title, sha: c.sha, parent: c.parent, date: c.date, author: c.author, files: c.files || [],
      key: issueKey(pr?.title, pr?.branch, c.subject),
      area: mainArea(c.files),
    };
  });
}

// Groups to show: by issue key (labelled with its PR's title, or its newest subject), otherwise
// by area. Biggest first, then newest. → [{ id, label, key?, area?, entries, date }]
export function groupLanded(entries) {
  const groups = new Map();
  for (const e of entries) {
    const id = e.key ? `key:${e.key}` : `area:${e.area}`;
    let g = groups.get(id);
    if (!g) { g = { id, ...(e.key ? { key: e.key } : { area: e.area }), label: null, entries: [], date: 0 }; groups.set(id, g); }
    g.entries.push(e);
    g.date = Math.max(g.date, e.date || 0);
    // A key group reads as its PR's title; entries come newest first, so the first PR wins.
    if (e.key && (!g.label || (e.kind === 'pr' && !g.pr))) { g.label = e.title; if (e.kind === 'pr') g.pr = true; }
  }
  for (const g of groups.values()) { if (!g.key) g.label = g.area; delete g.pr; }
  return [...groups.values()].sort((a, b) => b.entries.length - a.entries.length || b.date - a.date);
}

// How many groups the card shows before "+N more ▾".
export const TOP = 4;

// The "Since…" picker: last checkpoint, yesterday, last week, then the newest tags.
export function sinceOptions(tags = [], max = 8) {
  return [
    { kind: 'checkpoint', label: 'Last checkpoint' },
    { kind: 'yesterday', label: 'Yesterday' },
    { kind: 'week', label: 'Last week' },
    ...tags.slice(0, max).map((t) => ({ kind: 'tag', tag: t, label: `Tag ${t}` })),
  ];
}

// The card's headline for a catch-up result: where it counts from. Relative time is a label only.
// res: app:catchup. → { text, warn? }
export function sinceText(res, { short = (s) => s.slice(0, 7), ago = () => '' } = {}) {
  const cp = res.checkpoint || {};
  if (res.kind === 'tag') return withFallback(res, `Since tag ${res.tag}`, short);
  if (res.kind === 'yesterday') return { text: 'Since yesterday' };
  if (res.kind === 'week') return { text: 'Since last week' };
  const at = cp.date ? ago(cp.date) : '';
  if (!cp.sha) return { text: cp.source === 'week' ? 'Since last week (no checkpoint yet)' : 'No checkpoint yet' };
  return withFallback(res, `Caught up to ${short(cp.sha)} on ${cp.base || res.base}${at ? ` · ${at}` : ''}`, short);
}
function withFallback(res, text, short) {
  if (!res.fallback) return { text };
  const what = res.kind === 'tag' ? `Tag ${res.tag}` : short(res.fallback.sha);
  const why = res.fallback.reason === 'missing' ? 'no longer exists' : `is no longer on ${res.base} (force-pushed?)`;
  return { text, warn: res.date != null ? `${what} ${why}. Showing what landed since its date.` : `${what} ${why}.` };
}

// The counts line: merged (PRs, or commits without PRs), stuck and ready to merge, and the base's CI.
export function countsText({ entries, stuck, ready, prsOn, ci, base }) {
  const prs = entries.filter((e) => e.kind === 'pr').length;
  const loose = entries.length - prs;
  const merged = prs ? `${prs} merged${loose ? ` · ${loose} other commit${loose === 1 ? '' : 's'}` : ''}` : `${entries.length} commit${entries.length === 1 ? '' : 's'} landed`;
  const parts = [merged, `${stuck} stuck`];
  if (prsOn) parts.push(`${ready} ready to merge`);
  const ciText = ci ? { passing: 'CI passing', failing: `CI failing${ci.failed?.length ? `: ${ci.failed.join(', ')}` : ''}`, pending: 'CI running' }[ci.state] : null;
  return { parts, ci: ciText ? { state: ci.state, text: `${base} ${ciText}` } : null };
}
