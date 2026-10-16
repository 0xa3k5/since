import { h, icon, kbd, timeAgo, fullDate, contextMenu, toast, tipFor, loading } from './ui.js';
import { renderDiff } from './diff.js';
import { landedEntries, sinceOptions, sinceText, byDay, firstOf, headline, sincePhrase, whenText, FIRST, walkList, stepId, diffCounts, firstUnviewed, readerDescription } from './catchup.js';
import { sharedLoad } from './lanes.js';
import * as keymap from './keymap.js';

// Catch up (AK-365, was Review's catch-up card, AK-281): what landed on the base since your
// checkpoint. Under the full-width head (the big number, PRs merged or commits with PRs off; the
// since line, picker ⇧T, the checkpoint's time, the base's CI; Walk through ⇧↵ and Mark caught up
// ⇧C) sit two columns (AK-372): the timeline by day on the left, one row per merged PR or landed
// commit, newest first (↑/↓), and a reader on the right that follows the selection (debounced
// like Review's pane; ↵ moves focus into it). The reader shows the change's header, its
// description (the PR's when GitHub sent one, else the commit message; Show more I) and its files
// against the first parent, each under a sticky header with a viewed tick (V ticks the next one)
// that folds it. Ticks live in memory per entry. Walk through steps the reader over the merged PRs
// (←/→, Esc leaves). Below the timeline, a line to Review's stuck and ready-to-merge rows.
// The checkpoint lives in app data (main process) and only moves on Mark caught up, which Undo on
// its toast puts back. Merged PRs and CI load once when a repo opens (prefetchCatchup, AK-382), then
// only on Reload (⇧R) or after your own picks; opening the view, repo changes and window focus read
// git alone. The last load is kept per repo (`cache`), so coming back shows it with "Updated 4m ago".
// With PRs off it's git log alone.
//
// load(opts) → app:catchup; mark(to) → app:catchup-mark (returns the checkpoint it replaced);
// git(method, ...args) reads a change (commitDiffs, commit); prsOn() reads the setting; counts() →
// { stuck, ready } from Review (lanes-view.js reviewCounts); onReview() opens Review; onCount(n)
// reports what landed since the checkpoint, for the sidebar badge.
const short = (s) => (s || '').slice(0, 7);
const ago = (ms) => { const s = timeAgo(ms / 1000); return /^\d/.test(s) ? `${s} ago` : s; };
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const AGO_TICK = 30e3;
const READ_DELAY = 120; // ↑/↓ held down: the reader waits for the selection to settle

// The view's range and its last load with PRs, per repo (this window, this session), so coming back from
// the walk-through shows them at once: { repo, since, res, extra: { merged, ci } | null, loadedAt }.
let cache = null;
// The load with PRs in flight for the default range (since the checkpoint, default base), shared by Reload and
// the load when a repo opens: one `gh` call per repo. openRepo: the repo it's for; a load for another lands nowhere.
const prLoads = sharedLoad();
let openRepo = null;
const DEFAULT_SINCE = { since: 'checkpoint' };
// What the reader read, per commit, for this repo: sha → Promise<{ diffs, message }>.
const reads = new Map();
// The description shows its first lines until Show more (I); that choice sticks across entries.
let descOpen = false;

export function catchupView({ repo = null, git, load, mark, prsOn, refs = () => [], counts = async () => null, onReview = () => {}, onCount = () => {} }) {
  if (cache && cache.repo !== repo) { cache = null; reads.clear(); }
  openRepo = repo;
  if (cache && !prsOn() && cache.extra) cache = { ...cache, res: null, extra: null, loadedAt: null };
  let since = cache?.since || { since: 'checkpoint' };
  let base = cache?.base || null; // null: the default base (origin/main); else a branch ref from the select (AK-372)
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
  let walking = false; // Walk through: the reader steps over walkList(entries)
  let readId = null; // the entry in the reader
  let readTimer = 0;
  let change = null; // { id, diffs, message } once the reader's entry is read
  const viewed = new Map(); // entry id → Set of viewed paths (this view only)
  const full = new Set(); // "id\0path" of diffs shown past the truncation limit

  const el = h('div.page.flush.catchup', { tabIndex: 0, role: 'region', 'aria-label': 'Catch up' });
  const updated = h('span.muted.review-updated', { 'aria-live': 'polite' });
  const reloadBtn = h('button.btn.ghost.small.review-reload', { onclick: () => reload(), 'data-tip': `${tipFor('Reload', 'catchup.reload')}\nAsk GitHub for merged pull requests and the base’s CI`, 'aria-label': 'Reload' });
  // The branch select: the default base first, then local and remote branches (AK-372, AK-374).
  const branchSel = h('select.catchup-branch', { 'aria-label': 'Branch to catch up on', 'data-tip': tipFor('Catch up on another branch', 'catchup.branch'), onchange: () => pickBranch(branchSel.value || null) });
  const strip = h('div.catchup-strip');
  const msg = h('div.catchup-msg');
  const list = h('div.catchup-list');
  const readerHead = h('div.catchup-reader-head');
  const readerDesc = h('div.catchup-reader-desc');
  const readerFiles = h('div.catchup-files');
  const reader = h('div.catchup-reader', { tabIndex: -1, role: 'region', 'aria-label': 'Reader' });
  const cols = h('div.catchup-cols', null, list, reader);
  const hint = h('div.review-hints');
  el.append(
    h('div.page-head.review-head', null,
      h('div.review-head-row', null, h('h1', null, 'Catch up'), h('span.muted.catchup-sub', null, 'What landed on ', branchSel), h('span.spacer'), updated, reloadBtn)),
    strip, cols, msg, hint);

  const btn = (label, keyId, onclick, cls = 'button.btn.subtle') => h(cls, { 'data-tip': tipFor(label, keyId), onclick: (e) => { e.stopPropagation(); onclick(e); } }, label, kbd(...keymap.keys(keyId)));
  const days = () => byDay(entries);
  const visible = () => (more ? days() : firstOf(days(), FIRST).days).flatMap((d) => d.entries);

  function renderHead() {
    reloadBtn.disabled = reloading;
    reloadBtn.replaceChildren(icon('restore', 14), reloading ? 'Reloading…' : 'Reload');
    updated.hidden = !prsOn();
    updated.textContent = reloading ? '' : loadedAt ? `Updated ${ago(loadedAt)}` : 'Not loaded yet';
    updated.title = loadedAt ? fullDate(loadedAt / 1000) : '';
    renderBranches();
  }

  function renderBranches() {
    const dflt = res?.defaultBase === false ? null : res?.base;
    const label = dflt ? `${dflt} (default)` : 'Default base';
    const seen = new Set();
    const opts = [h('option', { value: '' }, label)];
    for (const kind of ['remote', 'branch']) {
      const group = (refs() || []).filter((r) => r.kind === kind && !r.name.endsWith('/HEAD') && !seen.has(r.name) && seen.add(r.name));
      if (group.length) opts.push(h('optgroup', { label: kind === 'remote' ? 'Remote branches' : 'Local branches' }, ...group.map((r) => h('option', { value: r.name }, r.short))));
    }
    branchSel.replaceChildren(...opts);
    branchSel.value = base || '';
  }
  // Another branch has no checkpoint: catch up from last week, and Mark caught up doesn't apply.
  function pickBranch(ref) {
    if ((ref || null) === base) return;
    base = ref || null;
    since = base ? { since: 'week' } : { since: 'checkpoint' };
    more = false; walking = false; selId = null; readId = null; change = null;
    fetch({ prs: Boolean(loadedAt) });
  }

  // Messages (failed, loading, caught up) take the whole width; no columns.
  function showMsg(...children) {
    strip.hidden = true;
    cols.hidden = true;
    msg.hidden = false;
    msg.replaceChildren(...children.filter(Boolean));
    renderHints();
  }

  function render() {
    renderHead();
    if (failed) return showMsg(h('div.empty', null, `Couldn’t read what landed: ${failed}`));
    if (!res) return showMsg(h('div.empty', null, loaded ? 'No base branch to catch up on.' : 'Catching up…'));
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
      walking = false;
      const what = since.since === 'checkpoint' ? (when ? `since ${when}` : 'since your checkpoint') : sincePhrase(since);
      return showMsg(h('div.catchup-empty', null,
        icon('check', 20),
        h('h2', null, since.since === 'checkpoint' ? 'You’re caught up.' : 'Nothing new.'),
        h('p.muted', null, `Nothing landed on ${res.base} ${what}.`),
        warn,
        btn('Catch up since…', 'catchup.since', (e) => pickSince(e.currentTarget))),
      bridge());
    }

    strip.hidden = false;
    cols.hidden = false;
    msg.hidden = true;
    const top = headline(entries);
    const all = days();
    const { days: shown, more: hidden } = more ? { days: all, more: 0 } : firstOf(all, FIRST);
    if (!visible().some((e) => e.id === selId)) selId = visible()[0]?.id || null;
    strip.replaceChildren(
      h('section.catchup-top', null,
        h('div.catchup-total', null,
          h('div.catchup-number', null, h('strong', null, String(top.count)), ` ${top.text}`, top.extra ? h('span.muted', null, ` · ${top.extra}`) : null),
          sinceLine, warn),
        h('div.catchup-actions', null,
          btn('Walk through', 'catchup.walk', () => walk()),
          res.defaultBase === false ? null : btn('Mark caught up', 'catchup.caughtUp', () => markCaughtUp(), 'button.btn.primary'))));
    list.replaceChildren(...[
      h('div.catchup-timeline', { role: 'listbox', 'aria-label': 'What landed' },
        ...shown.flatMap((d) => [
          h('div.catchup-day', { role: 'presentation' }, d.label),
          ...d.entries.map(row),
        ]),
        hidden ? h('button.btn.ghost.small.catchup-more', { onclick: () => { more = true; render(); } }, `+ ${hidden} more ▸`) : null),
      res.truncated ? h('div.muted.small.catchup-note', null, `Showing the newest ${entries.length}.`) : null,
      bridge()].filter(Boolean));
    list.querySelector('.catchup-row.active')?.scrollIntoView({ block: 'nearest' });
    renderHints();
    syncReader();
  }

  // The key bar: the walk-through's keys while walking, the timeline's otherwise.
  function renderHints() {
    const k = (keys, label, cls = '') => h('span.review-hint' + cls, null, kbd(...keys), label);
    const id = (x) => keymap.keys(x);
    const rows = walking
      ? [k([...id('catchup.walkPrev'), ...id('catchup.walkNext')], 'Previous / next'), k(id('catchup.viewed'), 'Viewed'), k(id('catchup.description'), 'Description'), k(id('catchup.walkDone'), 'Done')]
      : [k([...id('catchup.prev'), ...id('catchup.next')], 'Move'), k(id('catchup.open'), 'Read'), k(id('catchup.walk'), 'Walk through'), k(id('catchup.caughtUp'), 'Mark caught up'), k(id('catchup.since'), 'Since…'), k(id('catchup.reload'), 'Reload')];
    hint.replaceChildren(...rows, k(id('view.palette'), 'All commands', '.all'));
  }

  function row(e) {
    const active = e.id === selId;
    return h('div.catchup-row' + (active ? '.active' : ''), {
      role: 'option', 'aria-selected': String(active), 'data-id': e.id,
      title: `${e.kind === 'pr' ? 'Merged' : 'Committed'} ${e.date ? fullDate(e.date / 1000) : ''}\n${short(e.sha)} · ${e.author || ''}`,
      onclick: () => { selId = e.id; render(); syncReader(true); el.focus({ preventScroll: true }); },
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
      const opts = { ...since, prs: withPrs, ...(base ? { base } : {}) };
      // The default range with PRs joins the load from opening the repo, if it's still running.
      const r = await (withPrs && since.since === 'checkpoint' && !base ? prLoads.run(repo, () => load(opts)) : load(opts));
      if (n !== seq) return;
      failed = null;
      loaded = true;
      if (withPrs) { extra = r ? { merged: r.merged, ci: r.ci } : null; loadedAt = Date.now(); }
      if (!prsOn()) { extra = null; loadedAt = null; }
      cache = { repo, since, base, extra, loadedAt };
      res = r && { ...r, ...(withPrs || !extra ? {} : extra) };
      cache.res = res;
      entries = res ? landedEntries(res.commits, res.merged) : [];
      if (since.since === 'checkpoint' && !base) onCount(entries.length);
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
    if (!res || res.defaultBase === false) return toast('Mark caught up works on the default base only');
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

  // The reader (AK-372): the selected entry's header, description and files. It follows the
  // selection after READ_DELAY, or at once (`now`) on a click, ↵ and the walk-through's buttons.
  const entryById = (id) => entries.find((e) => e.id === id) || null;
  function syncReader(now = false) {
    clearTimeout(readTimer);
    if (selId === readId) return renderReaderHead();
    if (now || readId == null) { readId = selId; showReader(); return; }
    readTimer = setTimeout(() => { if (el.isConnected && selId !== readId) { readId = selId; showReader(); } }, READ_DELAY);
  }
  // A commit's files against its first parent (a merged PR's merge or squash commit: what the PR
  // brought in) and its message, read once per sha.
  function read(sha) {
    if (!reads.has(sha)) {
      const p = Promise.all([git('commitDiffs', sha), git('commit', sha).then((c) => c?.message || '', () => '')]).then(([diffs, message]) => ({ diffs: diffs || [], message }));
      p.catch(() => reads.delete(sha));
      reads.set(sha, p);
    }
    return reads.get(sha);
  }
  function showReader() {
    const e = entryById(readId);
    change = null;
    reader.scrollTop = 0;
    if (!e) return reader.replaceChildren(h('div.empty', null, 'Select a pull request or commit to read it.'));
    reader.replaceChildren(readerHead, readerDesc, readerFiles);
    renderReaderHead();
    readerDesc.replaceChildren();
    readerFiles.replaceChildren(loading(`Reading ${e.kind === 'pr' ? `#${e.number}` : short(e.sha)}…`));
    const id = e.id;
    read(e.sha).then((r) => {
      if (id !== readId || !el.isConnected) return;
      change = { id, ...r };
      renderDescription();
      renderFiles();
    }, (err) => {
      if (id !== readId || !el.isConnected) return;
      readerFiles.replaceChildren(h('div.empty', null, `Couldn’t read ${short(e.sha)}: ${err.message}`));
    });
  }

  // "‹ Previous · Walking through · 3 of 21 · Next ›  Done Esc" while walking; the title; then
  // "#313  WEB-142  mira  agent/web-313 → origin/main  merged Tuesday 18:40  ✓ Merged".
  function renderReaderHead() {
    const e = entryById(readId);
    if (!e || !res) return;
    let bar = null;
    if (walking) {
      const wl = walkList(entries);
      const i = wl.findIndex((x) => x.id === e.id);
      bar = h('div.catchup-walkbar', { role: 'toolbar', 'aria-label': 'Walk through' },
        h('button.btn.ghost.small', { onclick: () => walkStep(-1), disabled: i <= 0, 'data-tip': tipFor('Previous', 'catchup.walkPrev') }, icon('chevronLeft', 12), 'Previous'),
        h('span.catchup-walkpos', { 'aria-live': 'polite' }, i < 0 ? 'Walking through' : `Walking through · ${i + 1} of ${wl.length}`),
        h('button.btn.ghost.small', { onclick: () => walkStep(1), disabled: i < 0 || i >= wl.length - 1, 'data-tip': tipFor('Next', 'catchup.walkNext') }, 'Next', icon('chevron', 12)),
        h('span.spacer'),
        h('button.btn.ghost.small', { onclick: () => stopWalk(), 'data-tip': tipFor('Done', 'catchup.walkDone') }, 'Done', kbd(...keymap.keys('catchup.walkDone'))));
    }
    const pr = e.kind === 'pr';
    readerHead.replaceChildren(...[bar,
      h('h2.catchup-reader-title', null, e.title),
      h('div.catchup-reader-meta', null,
        h('span.catchup-num', { title: e.sha }, pr ? `#${e.number}` : short(e.sha)),
        h('span.badge.catchup-chip' + (e.key ? '' : '.muted'), null, e.key || e.area),
        e.author ? h('span', null, e.author) : null,
        pr && e.branch ? h('span.mono', null, e.branch, h('span.muted', null, ' → '), res.base) : h('span', null, 'on ', h('span.mono', null, res.base)),
        e.date ? h('span', { title: fullDate(e.date / 1000) }, `${pr ? 'merged' : 'committed'} ${whenText(e.date)}`) : null,
        pr ? h('span.catchup-merged', null, icon('check-circle', 12), 'Merged') : null)].filter(Boolean));
  }

  // The PR's description (or the commit message), a few lines until Show more (I).
  function renderDescription() {
    const e = entryById(readId);
    if (!e || change?.id !== e.id) return;
    const { text, from } = readerDescription(e, change.message);
    const label = e.kind === 'pr' ? 'Description' : 'Commit message';
    const note = e.kind === 'pr' && from === 'commit' ? h('span.muted', null, '· from the commit message') : null;
    const box = h('section.catchup-desc' + (descOpen ? '.open' : ''), { 'aria-label': label },
      h('div.catchup-desc-head', null, h('span', null, label), note,
        text ? h('button.btn.ghost.small.catchup-desc-more', { 'aria-expanded': String(descOpen), 'data-tip': tipFor(descOpen ? 'Show less' : 'Show more', 'catchup.description'), onclick: () => toggleDescription() }, descOpen ? 'Show less' : 'Show more', kbd(...keymap.keys('catchup.description'))) : null),
      text ? h('div.catchup-desc-text', null, text) : h('div.catchup-desc-none', null, 'No description'));
    readerDesc.replaceChildren(box);
    // Show more only when the clamped text has more to show.
    requestAnimationFrame(() => {
      const t = box.querySelector('.catchup-desc-text');
      if (t && !descOpen) box.classList.toggle('fits', t.scrollHeight <= t.clientHeight + 1);
    });
  }
  function toggleDescription() {
    const e = entryById(readId);
    if (!e || change?.id !== e.id || !readerDescription(e, change.message).text) return false;
    descOpen = !descOpen;
    renderDescription();
    return true;
  }

  // Each file under a sticky header: viewed tick, path, +N −M. Ticked files fold.
  const viewedOf = (id) => { if (!viewed.has(id)) viewed.set(id, new Set()); return viewed.get(id); };
  function renderFiles() {
    if (!change) return;
    readerFiles.replaceChildren(...(change.diffs.length ? change.diffs.map(fileBlock) : [h('div.empty', null, 'No file changes.')]));
  }
  function fileBlock(d) {
    const id = change.id;
    const done = viewedOf(id).has(d.path);
    const { add, del } = diffCounts(d);
    const fk = `${id}\0${d.path}`;
    return h('section.catchup-file' + (done ? '.viewed' : ''), { 'data-path': d.path },
      h('div.catchup-file-head', null,
        h('input.catchup-viewed', { type: 'checkbox', checked: done, 'aria-label': `Viewed ${d.path}`, 'data-tip': tipFor('Viewed', 'catchup.viewed'), onchange: (ev) => setViewed(d.path, ev.target.checked) }),
        h('span.catchup-file-path', { title: d.path }, d.path),
        h('span.stat', { 'aria-label': `${add} added, ${del} removed` }, h('span.add', null, `+${add}`), h('span.del', null, `−${del}`))),
      done ? null : h('div.catchup-file-diff', null, renderDiff(d, { full: full.has(fk), onShowAll: () => { full.add(fk); replaceFile(d.path); } })));
  }
  function replaceFile(path) {
    const old = [...readerFiles.children].find((x) => x.dataset.path === path);
    const d = change?.diffs.find((x) => x.path === path);
    if (!old || !d) return null;
    const refocus = old.contains(document.activeElement);
    const next = fileBlock(d);
    old.replaceWith(next);
    if (refocus) next.querySelector('.catchup-viewed').focus({ preventScroll: true });
    return next;
  }
  function setViewed(path, on) {
    const set = viewedOf(change.id);
    if (on) set.add(path); else set.delete(path);
    const block = replaceFile(path);
    // Folding a file you scrolled into: bring its header back into view.
    if (on && block && block.getBoundingClientRect().top < reader.getBoundingClientRect().top) block.scrollIntoView({ block: 'start' });
  }
  // V: tick the first file not yet viewed.
  function markNextViewed() {
    if (!change || change.id !== readId) return false;
    const path = firstUnviewed(change.diffs.map((d) => d.path), viewedOf(change.id));
    if (path == null) { toast('Every file is viewed'); return true; }
    setViewed(path, true);
    return true;
  }

  // Walk through: the merged PRs (or the commits when none came with a PR), one at a time in the
  // reader, ←/→ to step, Esc to leave. The timeline shows everything while walking.
  function walk() {
    const wl = walkList(entries);
    if (!wl.length) return toast('Nothing landed to walk through');
    walking = true;
    more = true;
    selId = wl[0].id;
    render();
    syncReader(true);
  }
  function walkStep(d) {
    selId = stepId(walkList(entries), selId, d);
    render();
  }
  function stopWalk() {
    walking = false;
    render();
    el.focus({ preventScroll: true });
  }
  // ↵: show it now and move focus into the reader, so Space and Page Down scroll it.
  function open(e = entryById(selId)) {
    if (!e) return;
    selId = e.id;
    render();
    syncReader(true);
    reader.focus({ preventScroll: true });
  }
  function move(d) {
    if (walking) return walkStep(d);
    const vis = visible();
    if (!vis.length) return;
    const i = vis.findIndex((e) => e.id === selId);
    selId = vis[Math.max(0, Math.min(vis.length - 1, (i < 0 ? 0 : i + d)))].id;
    render();
  }
  const showMore = () => { if (!more) { more = true; render(); } };

  el.addEventListener('keydown', (e) => {
    const id = keymap.match('catchup', e);
    if (!id) return;
    if (id === 'catchup.next') move(1);
    else if (id === 'catchup.prev') move(-1);
    else if (id === 'catchup.open') { if (e.target.closest?.('button, input')) return; open(); }
    else if (id === 'catchup.walk') walk();
    else if (id === 'catchup.caughtUp') markCaughtUp();
    else if (id === 'catchup.since') pickSince();
    else if (id === 'catchup.reload') reload();
    else if (id === 'catchup.branch') { branchSel.focus(); branchSel.showPicker?.(); }
    else if (id === 'catchup.more') showMore();
    else if (id === 'catchup.walkNext' && walking) walkStep(1);
    else if (id === 'catchup.walkPrev' && walking) walkStep(-1);
    else if (id === 'catchup.walkDone' && walking) stopWalk();
    else if (id === 'catchup.walkDone' && reader.contains(document.activeElement)) el.focus({ preventScroll: true });
    else if (id === 'catchup.viewed') { if (!markNextViewed()) return; }
    else if (id === 'catchup.description') { if (!toggleDescription()) return; }
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  // "Updated 4m ago" keeps up while the view is open.
  const tick = setInterval(() => { if (el.isConnected) renderHead(); else clearInterval(tick); }, AGO_TICK);
  const onFocus = () => { if (el.isConnected) fetch(); else window.removeEventListener('focus', onFocus); };
  window.addEventListener('focus', onFocus);

  render();
  // The load from opening the repo is still running: wait for it ("Reloading…") instead of asking again.
  if (prsOn() && since.since === 'checkpoint' && !base && prLoads.pending(repo)) reload(); else fetch();
  setTimeout(() => el.focus({ preventScroll: true }));
  return {
    el, refresh: () => fetch(), reload, walk, markCaughtUp, pickSince: () => pickSince(), showMore, canMore: () => !more && entries.length > FIRST, canReload: () => true,
    // ⌘K: the reader's V and I, and leaving the walk-through.
    markNextViewed, toggleDescription, walking: () => walking, stopWalk,
  };
}

// The load when a repo opens (AK-382): merged PRs and CI since the checkpoint, the same as Reload, into `cache`,
// so Catch up shows them without a Reload; onCount(n) updates the sidebar badge. Catch up open on this repo
// calls its own reload() instead (app.js). Quiet on failure; a repo switch before it lands drops it.
export async function prefetchCatchup({ repo, load, prsOn, onCount = () => {} }) {
  openRepo = repo;
  if (!prsOn()) return;
  const r = await prLoads.run(repo, () => load({ ...DEFAULT_SINCE, prs: true })).catch(() => null);
  if (!r || openRepo !== repo || !prsOn()) return;
  // Your own pick of range or branch for this repo stays; its PRs come on Reload.
  if (cache?.repo === repo && (cache.since?.since !== 'checkpoint' || cache.base)) return;
  if (cache?.repo !== repo) reads.clear();
  cache = { repo, since: { ...DEFAULT_SINCE }, base: null, extra: { merged: r.merged, ci: r.ci }, loadedAt: Date.now(), res: r };
  onCount(landedEntries(r.commits, r.merged).length);
}
