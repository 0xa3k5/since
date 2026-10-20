import { prDescription } from './pr-review.js';

// Review's catch-up card (AK-281), the pure part: what landed on the base since a checkpoint, as
// entries (a merged PR, or a commit that came without one) and as groups to read at a glance.
// Built from app:catchup (git log on the base's first-parent line, plus merged PRs from `gh` while
// PRs are on). No AI: issue keys and folders only.

// A generic issue key: "AK-12", "WEB2-345".
export const ISSUE_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;
// Standards and encodings that look like keys ("read UTF-8 paths", "SHA-256") are never one (AK-287).
const NOT_KEYS = new Set(['UTF', 'UCS', 'SHA', 'MD', 'ISO', 'IEC', 'HTTP', 'TLS', 'SSL', 'RFC', 'CVE', 'ES', 'ECMA', 'X']);
const keyIn = (t) => [...(t || '').matchAll(ISSUE_KEY)].map((m) => m[0]).find((k) => !NOT_KEYS.has(k.slice(0, k.lastIndexOf('-'))));
export const issueKey = (...texts) => texts.map(keyIn).find(Boolean) || null;

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
// A git-only result with the merged PRs and CI of a slower PR load that it overtook (AK-338).
export function withLateExtra(res, extra) {
  return res && extra ? { ...res, merged: extra.merged, ci: extra.ci } : res;
}

export function landedEntries(commits = [], merged = null) {
  const byMerge = new Map((merged || []).filter((p) => p.merge).map((p) => [p.merge, p]));
  return commits.map((c) => {
    const pr = byMerge.get(c.sha);
    const title = pr ? pr.title || c.subject : c.subject;
    return {
      id: pr ? `pr:${pr.number}` : `commit:${c.sha}`,
      kind: pr ? 'pr' : 'commit',
      ...(pr ? { number: pr.number, branch: pr.branch } : {}),
      // The PR's description when GitHub sent one with the merged list (the reader falls back to the commit message).
      ...(typeof pr?.body === 'string' ? { body: pr.body } : {}),
      // Its GitHub stack and size (AK-616) when the merged-stacks lookup found them.
      ...(pr?.stack ? { stack: pr.stack } : {}), ...(pr?.stat ? { stat: pr.stat } : {}),
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
// The walk-through header's short "since …" (AK-304): "since a1b2c3d", "since tag v0.1.0", "since yesterday".
export function sinceLabel(res, { short = (s) => s.slice(0, 7) } = {}) {
  if (!res) return 'since checkpoint';
  if (res.kind === 'tag') return `since tag ${res.tag}`;
  if (res.kind === 'yesterday') return 'since yesterday';
  if (res.kind === 'week') return 'since last week';
  const sha = res.checkpoint?.sha;
  return sha ? `since ${short(sha)}` : 'since checkpoint';
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

// The Catch up view's timeline (AK-365): entries by local day, newest first. "Today", "Yesterday",
// then dateLabel(start of that day). Entries without a date go last. → [{ id, label, entries }]
const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const longDate = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
export function byDay(entries = [], { now = Date.now(), dateLabel = longDate } = {}) {
  const today = dayStart(now);
  const yesterday = dayStart(today - 1);
  const days = new Map();
  for (const e of [...entries].sort((a, b) => (b.date || 0) - (a.date || 0))) {
    const d = e.date ? dayStart(e.date) : null;
    const id = d == null ? 'undated' : String(d);
    let g = days.get(id);
    if (!g) { g = { id, label: d == null ? 'Undated' : d === today ? 'Today' : d === yesterday ? 'Yesterday' : dateLabel(d), entries: [] }; days.set(id, g); }
    g.entries.push(e);
  }
  return [...days.values()];
}

// Merged stacks (AK-616): within a day, the parts of one GitHub stack become one timeline item, in
// place of its newest part: { id: 'stack:<stack>:<day>', kind: 'stack', stack, parts (bottom first),
// lo, hi (their numbers), title: "Stack · 14 PRs" | "Stack · 7 of 14 merged", date, author }. A
// stack merged across days gets an item per day; a day with one part keeps it a PR row. → days
const partAt = (e) => { const i = e.stack?.parts?.indexOf(e.number) ?? -1; return i < 0 ? Infinity : i; };
export function groupStacks(days = []) {
  return days.map((d) => {
    const by = new Map();
    for (const e of d.entries) if (e.kind === 'pr' && e.stack) { if (!by.has(e.stack.number)) by.set(e.stack.number, []); by.get(e.stack.number).push(e); }
    const done = new Set();
    const entries = [];
    for (const e of d.entries) {
      const parts = e.kind === 'pr' && e.stack ? by.get(e.stack.number) : null;
      if (!parts || parts.length < 2) { entries.push(e); continue; }
      if (done.has(e.stack.number)) continue;
      done.add(e.stack.number);
      const sorted = [...parts].sort((a, b) => partAt(a) - partAt(b) || (a.date || 0) - (b.date || 0) || a.number - b.number);
      const size = Math.max(e.stack.size || 0, parts.length);
      entries.push({
        id: `stack:${e.stack.number}:${d.id}`, kind: 'stack', stack: e.stack, parts: sorted,
        lo: sorted[0].number, hi: sorted[sorted.length - 1].number,
        title: parts.length < size ? `Stack · ${parts.length} of ${size} merged` : `Stack · ${size} PRs`,
        date: Math.max(...parts.map((p) => p.date || 0)) || null, author: e.author,
      });
    }
    return { ...d, entries };
  });
}
// The timeline's items, a stack as one. → [entry | stack item]
export const landedItems = (entries = [], opts) => groupStacks(byDay(entries, opts)).flatMap((d) => d.entries);
// The timeline's rows in order (AK-616): the items, an expanded stack's parts under it, newest first
// like the rest. A collapsed stack is one row for ↑/↓. opened: the expanded stack ids.
export const timelineRows = (items = [], opened = new Set()) => items.flatMap((x) => (x.kind === 'stack' && opened.has(x.id) ? [x, ...[...x.parts].reverse()] : [x]));
// ← and → on a stack (AK-616): → expands a collapsed one, ← collapses an expanded one, ← on one of
// its parts (`up`: the stack it sits under) goes up to it. → { open } | { close } | { select } (ids),
// or null when ←/→ step the timeline as before.
export function stackArrow(sel, d, { opened = new Set(), up = null } = {}) {
  if (sel?.kind === 'stack' && (d > 0) !== opened.has(sel.id)) return d > 0 ? { open: sel.id } : { close: sel.id };
  if (d < 0 && up && opened.has(up.id)) return { select: up.id };
  return null;
}
// A part's place in its stack for the reader (AK-616): "Stack #257 → #271 · 5 of 14", from GitHub's
// list of its parts, else from the parts that merged with it (`item`). null outside a stack.
export function stackPlace(e, item = null) {
  if (!e?.stack) return null;
  const all = e.stack.parts?.length ? e.stack.parts : item?.parts.map((p) => p.number) || [];
  const at = all.indexOf(e.number);
  if (at < 0 || !all.length) return null;
  return `Stack #${all[0]} → #${all[all.length - 1]} · ${at + 1} of ${Math.max(e.stack.size || 0, all.length)}`;
}
// A stack item's size: its parts' added and removed lines and files (those GitHub sent sizes for).
export function stackSize(item) {
  const sized = (item?.parts || []).filter((p) => p.stat);
  return sized.length ? sized.reduce((z, p) => ({ additions: z.additions + p.stat.additions, deletions: z.deletions + p.stat.deletions, files: z.files + p.stat.files }), { additions: 0, deletions: 0, files: 0 }) : null;
}

// How many rows the timeline shows before "+ N more ▸".
export const FIRST = 10;
// The first n entries across the days (days left empty drop out). → { days, more: how many are hidden }
export function firstOf(days, n = FIRST) {
  const out = [];
  let left = n;
  for (const d of days) {
    if (left <= 0) break;
    const entries = d.entries.slice(0, left);
    left -= entries.length;
    out.push({ ...d, entries });
  }
  const total = days.reduce((s, d) => s + d.entries.length, 0);
  return { days: out, more: Math.max(0, total - n) };
}

// The big number: merged PRs, or the commits that landed when none came with a PR. `items`: the
// timeline's (landedItems), where a stack counts once however many days it merged on (AK-616).
// → { count, text: "PRs merged" | "commits landed" | "stack and 1 PR merged", extra: "· 3 other commits" | null, total }
export function headline(items = []) {
  const stacks = new Set(items.filter((e) => e.kind === 'stack').map((e) => e.stack.number));
  const prs = items.filter((e) => e.kind === 'pr' && !(e.stack && stacks.has(e.stack.number))).length;
  const loose = items.filter((e) => e.kind !== 'pr' && e.kind !== 'stack').length;
  const s = (n, one, many) => (n === 1 ? one : many);
  const total = stacks.size + prs + loose;
  if (!prs && !stacks.size) return { count: loose, text: s(loose, 'commit landed', 'commits landed'), extra: null, total };
  const extra = loose ? `${loose} other ${s(loose, 'commit', 'commits')}` : null;
  if (!stacks.size) return { count: prs, text: s(prs, 'PR merged', 'PRs merged'), extra, total };
  return { count: stacks.size, text: `${s(stacks.size, 'stack', 'stacks')}${prs ? ` and ${prs} ${s(prs, 'PR', 'PRs')}` : ''} merged`, extra, total };
}

// The since picker's label in the view: "since your checkpoint", "since yesterday", "since tag v0.1.0".
export function sincePhrase(since = { since: 'checkpoint' }) {
  if (since.since === 'tag') return `since tag ${since.tag}`;
  if (since.since === 'yesterday') return 'since yesterday';
  if (since.since === 'week') return 'since last week';
  return 'since your checkpoint';
}
// When a checkpoint was: "Tuesday 18:40" within the week, "Oct 3 18:40" before that.
export function whenText(ms, { now = Date.now() } = {}) {
  if (!ms) return '';
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = now - ms < 6 * 24 * 3600e3 ? d.toLocaleDateString(undefined, { weekday: 'long' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day} ${time}`;
}

// The reader (AK-372, AK-381): ←/→ step the timeline. The id `d` steps from `id` in `list` (entries), clamped to its ends; the first when `id` isn't in it.
export function stepId(list = [], id = null, d = 1) {
  if (!list.length) return null;
  const i = list.findIndex((e) => e.id === id);
  return list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + d))].id;
}
// A parsed file diff's added and removed lines. → { add, del }
export function diffCounts(diff) {
  let add = 0, del = 0;
  for (const hunk of diff?.hunks || []) for (const l of hunk.lines) { if (l.t === '+') add++; else if (l.t === '-') del++; }
  return { add, del };
}
// The whole change's size for the reader head: { additions, deletions, files } over its file diffs.
export function changeSize(diffs = []) {
  let additions = 0, deletions = 0;
  for (const d of diffs) { const c = diffCounts(d); additions += c.add; deletions += c.del; }
  return { additions, deletions, files: diffs.length };
}
// The first path in `paths` not in `viewed` (a Set), or null.
export const firstUnviewed = (paths = [], viewed = new Set()) => paths.find((p) => !viewed.has(p)) ?? null;
// What the reader shows above the files: the PR's description when GitHub sent it, else the commit
// message without its subject line and its Co-authored-by / Signed-off-by trailers.
// → { text, from: 'pr' | 'commit' } ('' when there's nothing to say)
export function readerDescription(entry, message = '') {
  if (typeof entry?.body === 'string') return { text: prDescription(entry) ?? '', from: 'pr' };
  const rest = String(message || '').split('\n').slice(1).filter((l) => !/^(co-authored-by|signed-off-by):/i.test(l.trim())).join('\n');
  return { text: prDescription({ body: rest }) ?? '', from: 'commit' };
}
