import { h, icon, kbd, timeAgo, fullDate, contextMenu, toast, tipFor } from './ui.js';
import { landedEntries, sinceOptions, sinceText, sinceLabel, byDay, firstOf, headline, sincePhrase, whenText, FIRST } from './catchup.js';
import * as keymap from './keymap.js';

// Catch up (AK-365, was Review's catch-up card, AK-281): what landed on the base since your
// checkpoint, as a timeline grouped by day. The big number (PRs merged, or commits with PRs off),
// the since line (picker ⇧T, the checkpoint's time, the base's CI), Walk through (⇧↵) and Mark
// caught up (⇧C); then one row per merged PR or landed commit, newest first (↑/↓, ↵ opens it in
// Review's walk-through pane), and a line to Review's stuck and ready-to-merge rows.
// The checkpoint lives in app data (main process) and only moves on Mark caught up, which Undo on
// its toast puts back. Opening the view, repo changes and window focus read git alone: merged PRs
// and CI load on Reload (⇧R) or after your own picks, and the last load is kept per repo
// (`cache`), so coming back shows it with "Updated 4m ago". With PRs off it's git log alone.
//
// load(opts) → app:catchup; mark(to) → app:catchup-mark (returns the checkpoint it replaced);
// prsOn() reads the setting; counts() → { stuck, ready } from Review (lanes-view.js reviewCounts);
// onWalk(entries, index, label) opens Review walking through `entries` from `index`; onReview()
// opens Review; onCount(n) reports what landed since the checkpoint, for the sidebar badge.
const short = (s) => (s || '').slice(0, 7);
const ago = (ms) => { const s = timeAgo(ms / 1000); return /^\d/.test(s) ? `${s} ago` : s; };
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const AGO_TICK = 30e3;

// The view's range and its last load with PRs, per repo (this window, this session), so coming back from
// the walk-through shows them at once: { repo, since, res, extra: { merged, ci } | null, loadedAt }.
let cache = null;

export function catchupView({ repo = null, load, mark, prsOn, counts = async () => null, onWalk = () => {}, onReview = () => {}, onCount = () => {} }) {
  if (cache && cache.repo !== repo) cache = null;
  if (cache && !prsOn() && cache.extra) cache = { ...cache, res: null, extra: null, loadedAt: null };
  let since = cache?.since || { since: 'checkpoint' };
  let extra = cache?.extra || null; // merged PRs and CI from the last load with PRs, kept on local refreshes
  let loadedAt = cache?.loadedAt || null;
  let res = cache?.res || null;
  let entries = res ? landedEntries(res.commits, res.merged) : [];
  let failed = null;
  let more = false;
  let selId = null;
  let reloading = false;
  let review = null; // { stuck, ready }
  let seq = 0;
  let loaded = Boolean(res);

  const el = h('div.page.flush.catchup', { tabIndex: 0, role: 'region', 'aria-label': 'Catch up' });
  const updated = h('span.muted.review-updated', { 'aria-live': 'polite' });
  const reloadBtn = h('button.btn.ghost.small.review-reload', { onclick: () => reload(), 'data-tip': `${tipFor('Reload', 'catchup.reload')}\nAsk GitHub for merged pull requests and the base’s CI`, 'aria-label': 'Reload' });
  const body = h('div.catchup-body');
  const hint = h('div.review-hints');
  const k = (id, label) => h('span.review-hint', null, kbd(...keymap.keys(id)), label);
  hint.append(k('catchup.walk', 'Walk through'), k('catchup.caughtUp', 'Mark caught up'), k('catchup.since', 'Since…'), k('catchup.reload', 'Reload'),
    h('span.review-hint.all', null, kbd(...keymap.keys('view.palette')), 'All commands'));
  el.append(
    h('div.page-head.review-head', null,
      h('div.review-head-row', null, h('h1', null, 'Catch up'), h('span.muted.catchup-sub', null, 'What landed on the base'), h('span.spacer'), updated, reloadBtn)),
    body, hint);

  const btn = (label, keyId, onclick, cls = 'button.btn.subtle') => h(cls, { 'data-tip': tipFor(label, keyId), onclick: (e) => { e.stopPropagation(); onclick(e); } }, label, kbd(...keymap.keys(keyId)));
  const days = () => byDay(entries);
  const visible = () => (more ? days() : firstOf(days(), FIRST).days).flatMap((d) => d.entries);

  function renderHead() {
    reloadBtn.disabled = reloading;
    reloadBtn.replaceChildren(icon('restore', 14), reloading ? 'Reloading…' : 'Reload');
    updated.hidden = !prsOn();
    updated.textContent = reloading ? '' : loadedAt ? `Updated ${ago(loadedAt)}` : 'Not loaded yet';
    updated.title = loadedAt ? fullDate(loadedAt / 1000) : '';
    el.querySelector('.catchup-sub').textContent = `What landed on ${res?.base || 'the base'}`;
  }

  function render() {
    renderHead();
    if (failed) return body.replaceChildren(h('div.empty', null, `Couldn’t read what landed: ${failed}`));
    if (!res) return body.replaceChildren(h('div.empty', null, loaded ? 'No base branch to catch up on.' : 'Catching up…'));
    const head = sinceText(res, { short, ago: (ms) => ago(ms) });
    const cp = res.checkpoint || {};
    const when = since.since === 'checkpoint' ? whenText(cp.date) : '';
    const ci = res.ci && { passing: '✓', failing: '✗', pending: '…' }[res.ci.state];
    const sinceBtn = h('button.btn.ghost.small.catchup-since', { 'data-tip': tipFor('Catch up since…', 'catchup.since'), 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); pickSince(e.currentTarget); } }, `${sincePhrase(since)} ▾`);
    const sinceLine = h('div.catchup-sinceline', null, sinceBtn,
      when ? h('span', { title: cp.date ? fullDate(cp.date / 1000) : '' }, `· ${when}`) : null,
      ci ? h('span.catchup-ci.' + res.ci.state, { title: `${res.base} CI ${res.ci.state}${res.ci.failed?.length ? `: ${res.ci.failed.join(', ')}` : ''}` }, `· ${res.base} CI ${ci}`) : null);
    const warn = head.warn ? h('div.catchup-warn', null, icon('warning', 12), head.warn) : null;

    if (!entries.length) {
      const what = since.since === 'checkpoint' ? (when ? `since ${when}` : 'since your checkpoint') : sincePhrase(since);
      return body.replaceChildren(h('div.catchup-empty', null,
        icon('check', 20),
        h('h2', null, since.since === 'checkpoint' ? 'You’re caught up.' : 'Nothing new.'),
        h('p.muted', null, `Nothing landed on ${res.base} ${what}.`),
        warn,
        btn('Catch up since…', 'catchup.since', (e) => pickSince(e.currentTarget))),
      ...[bridge()].filter(Boolean));
    }

    const top = headline(entries);
    const all = days();
    const { days: shown, more: hidden } = more ? { days: all, more: 0 } : firstOf(all, FIRST);
    if (!visible().some((e) => e.id === selId)) selId = visible()[0]?.id || null;
    body.replaceChildren(...[
      h('section.catchup-top', null,
        h('div.catchup-total', null,
          h('div.catchup-number', null, h('strong', null, String(top.count)), ` ${top.text}`, top.extra ? h('span.muted', null, ` · ${top.extra}`) : null),
          sinceLine, warn),
        h('div.catchup-actions', null,
          btn('Walk through', 'catchup.walk', () => walk()),
          btn('Mark caught up', 'catchup.caughtUp', () => markCaughtUp(), 'button.btn.primary'))),
      h('div.catchup-timeline', { role: 'listbox', 'aria-label': 'What landed' },
        ...shown.flatMap((d) => [
          h('div.catchup-day', { role: 'presentation' }, d.label),
          ...d.entries.map(row),
        ]),
        hidden ? h('button.btn.ghost.small.catchup-more', { onclick: () => { more = true; render(); } }, `+ ${hidden} more ▸`) : null),
      res.truncated ? h('div.muted.small.catchup-note', null, `Showing the newest ${entries.length}.`) : null,
      bridge()].filter(Boolean));
    el.querySelector('.catchup-row.active')?.scrollIntoView({ block: 'nearest' });
  }

  function row(e) {
    const active = e.id === selId;
    return h('div.catchup-row' + (active ? '.active' : ''), {
      role: 'option', 'aria-selected': String(active), 'data-id': e.id,
      title: `${e.kind === 'pr' ? 'Merged' : 'Committed'} ${e.date ? fullDate(e.date / 1000) : ''}\n${short(e.sha)} · ${e.author || ''}`,
      onclick: () => { selId = e.id; render(); el.focus({ preventScroll: true }); },
      ondblclick: () => open(e),
    },
    h('span.catchup-time', null, e.date ? clock(e.date) : ''),
    h('span.catchup-num', null, e.kind === 'pr' ? `#${e.number}` : short(e.sha)),
    h('span.catchup-title', null, e.title),
    h('span.badge.catchup-chip' + (e.key ? '' : '.muted'), null, e.key || e.area));
  }

  // "2 stuck and 3 ready to merge are waiting in Review", with PRs off just the stuck; nothing waiting, no line.
  function bridge() {
    if (!review) return null;
    const parts = [h('strong', null, `${review.stuck} stuck`)];
    if (prsOn()) parts.push(' and ', h('strong', null, `${review.ready} ready to merge`));
    const n = review.stuck + (prsOn() ? review.ready : 0);
    if (!n) return null;
    return h('div.catchup-bridge', null,
      h('span', null, ...parts, n === 1 ? ' is waiting in Review' : ' are waiting in Review'),
      h('button.btn.ghost.small', { onclick: () => onReview(), 'data-tip': tipFor('Open Review', 'view.lanes') }, 'Open Review', kbd(...keymap.keys('view.lanes'))));
  }

  async function fetch({ prs = false } = {}) {
    const n = ++seq;
    const withPrs = Boolean(prs && prsOn());
    if (withPrs) { reloading = true; renderHead(); }
    try {
      const r = await load({ ...since, prs: withPrs });
      if (n !== seq) return;
      failed = null;
      loaded = true;
      if (withPrs) { extra = r ? { merged: r.merged, ci: r.ci } : null; loadedAt = Date.now(); }
      if (!prsOn()) { extra = null; loadedAt = null; }
      cache = { repo, since, extra, loadedAt };
      res = r && { ...r, ...(withPrs || !extra ? {} : extra) };
      cache.res = res;
      entries = res ? landedEntries(res.commits, res.merged) : [];
      if (since.since === 'checkpoint') onCount(entries.length);
      if (r?.prError) toast('Could not load merged pull requests', { kind: 'error', detail: r.prError.message });
    } catch (e) {
      if (n !== seq) return;
      failed = e.message;
    } finally {
      if (n === seq) reloading = false;
    }
    render();
    counts().then((c) => { if (c && n === seq) { review = c; render(); } }).catch(() => {});
  }
  const reload = () => (reloading ? Promise.resolve() : fetch({ prs: true }));

  function pickSince(anchor = el.querySelector('.catchup-since, .catchup-empty .btn')) {
    const r = anchor?.getBoundingClientRect() || { left: 0, bottom: 0 };
    const cur = since.since === 'tag' ? `tag:${since.tag}` : since.since;
    contextMenu(r.left, r.bottom, sinceOptions(res?.tags || []).map((o) => ({
      label: o.label, icon: (o.kind === 'tag' ? `tag:${o.tag}` : o.kind) === cur ? 'check' : undefined,
      run: () => { since = o.kind === 'tag' ? { since: 'tag', tag: o.tag } : { since: o.kind }; more = false; fetch({ prs: true }); },
    })));
  }

  async function markCaughtUp() {
    if (!res) return;
    if (!entries.length && res.checkpoint?.sha === res.baseSha) return toast(`Already caught up on ${res.base}`, { kind: 'success' });
    const to = { sha: res.baseSha, base: res.base, date: res.baseDate };
    try {
      const before = await mark(to);
      since = { since: 'checkpoint' };
      more = false;
      await fetch({ prs: Boolean(extra) });
      toast(`Caught up to ${short(to.sha)} on ${to.base}`, { kind: 'success', action: { label: 'Undo', run: async () => { await mark(before); fetch({ prs: Boolean(extra) }); } } });
    } catch (e) {
      toast('Couldn’t mark caught up', { kind: 'error', detail: e.message });
    }
  }

  // Walk through: the merged PRs, or the commits when none came with a PR. ↵ opens the selected
  // row in the same walk-through, over the timeline's order.
  const label = () => `${entries.some((e) => e.kind === 'pr') ? 'Merged' : 'Landed'} ${sinceLabel(res, { short })}`;
  function walk() {
    const prs = entries.filter((e) => e.kind === 'pr');
    const list = prs.length ? prs : entries;
    if (!list.length) return toast('Nothing landed to walk through');
    onWalk(list, 0, label());
  }
  function open(e = entries.find((x) => x.id === selId)) {
    if (!e) return;
    const list = days().flatMap((d) => d.entries);
    onWalk(list, list.indexOf(e), label());
  }
  function move(d) {
    const list = visible();
    if (!list.length) return;
    const i = list.findIndex((e) => e.id === selId);
    selId = list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i + d)))].id;
    render();
  }
  const showMore = () => { if (!more) { more = true; render(); } };

  el.addEventListener('keydown', (e) => {
    const id = keymap.match('catchup', e);
    if (!id) return;
    if (id === 'catchup.next') move(1);
    else if (id === 'catchup.prev') move(-1);
    else if (id === 'catchup.open') open();
    else if (id === 'catchup.walk') walk();
    else if (id === 'catchup.caughtUp') markCaughtUp();
    else if (id === 'catchup.since') pickSince();
    else if (id === 'catchup.reload') reload();
    else if (id === 'catchup.more') showMore();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  // "Updated 4m ago" keeps up while the view is open.
  const tick = setInterval(() => { if (el.isConnected) renderHead(); else clearInterval(tick); }, AGO_TICK);
  const onFocus = () => { if (el.isConnected) fetch(); else window.removeEventListener('focus', onFocus); };
  window.addEventListener('focus', onFocus);

  render();
  fetch();
  setTimeout(() => el.focus({ preventScroll: true }));
  return { el, refresh: () => fetch(), reload, walk, markCaughtUp, pickSince: () => pickSince(), showMore, canMore: () => !more && entries.length > FIRST, canReload: () => true };
}
