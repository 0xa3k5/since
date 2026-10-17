import { h, icon, kbd, timeAgo, fullDate, contextMenu, toast, tipFor, loading } from './ui.js';
import { renderDiff } from './diff.js';
import { landedEntries, withLateExtra, sinceOptions, sinceText, byDay, firstOf, headline, sincePhrase, whenText, FIRST, stepId, diffCounts, changeSize, firstUnviewed, readerDescription } from './catchup.js';
import { sharedLoad, loadGuard } from './lanes.js';
import * as keymap from './keymap.js';
import { readerHead, descriptionBlock, fileCard, miniHeader, miniContent, readerKey, navPos, fastKeys } from './reader.js';
import { authorsOf, messageAgent } from './review-rows.js';

// Catch up (AK-365, was Review's catch-up card, AK-281): what landed on the base since your
// checkpoint. Under the full-width head (the big number, PRs merged or commits with PRs off; the
// since line, picker ⇧T, the checkpoint's time, the base's CI; Mark caught up ⇧C) sit two columns (AK-372): the timeline by day on the left, one row per merged PR or landed
// commit, newest first (↑/↓ or ←/→), and a reader on the right that follows the selection (debounced
// like Review's pane; ↵ moves focus into it, Esc back). The reader is the one Review's pane uses
// (reader.js, AK-381): ‹ N of M › and the header with who made it (the author, + the agent its commit
// message's trailers name, AK-390) and "Merged", the
// description (the PR's when GitHub sent one, else the commit message; … Show more where it's cut)
// and the files against the first parent, each under a sticky header with a fold chevron and a
// viewed tick (V ticks the next one; ticking folds it). Ticks and folds live in memory per entry.
// In the reader ↑/↓ scroll (⇧ four times as far), Page Up/Down and Space by a page, ←/→ still step the timeline, , and .
// jump between files. Below the timeline, a line to Review's stuck and ready-to-merge rows.
// The checkpoint lives in app data (main process) and only moves on Mark caught up, which Undo on
// its toast puts back. Merged PRs and CI load once when a repo opens (prefetchCatchup, AK-382), then
// only on Reload (⇧R) or after your own picks (since ⇧T; branch B, a menu with the default base first,
// then remote and local branches); opening the view, repo changes and window focus read
// git alone. The last load is kept per repo (`cache`), so coming back shows it with "Updated 4m ago".
// With PRs off it's git log alone.
//
// load(opts) → app:catchup; mark(to) → app:catchup-mark (returns the checkpoint it replaced);
// git(method, ...args) reads a change (commitDiffs, commit); prsOn() and markAgents() read the settings; counts() →
// { stuck, ready } from Review (lanes-view.js reviewCounts); onReview() opens Review; onCount(n)
// reports what landed since the checkpoint, for the sidebar badge.
const short = (s) => (s || '').slice(0, 7);
const ago = (ms) => { const s = timeAgo(ms / 1000); return /^\d/.test(s) ? `${s} ago` : s; };
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const AGO_TICK = 30e3;
const READ_DELAY = 120; // ↑/↓ held down: the reader waits for the selection to settle

// The view's range and its last load with PRs, per repo (this window, this session), so coming back to
// the view shows them at once: { repo, since, res, extra: { merged, ci } | null, loadedAt }.
let cache = null;
// The load with PRs in flight for the default range (since the checkpoint, default base), shared by Reload and
// the load when a repo opens: one `gh` call per repo. openRepo: the repo it's for; a load for another lands nowhere.
const prLoads = sharedLoad();
let openRepo = null;
const DEFAULT_SINCE = { since: 'checkpoint' };
// What the reader read, per commit, for this repo: sha → Promise<{ diffs, message }>.
const reads = new Map();

export function catchupView({ repo = null, git, load, mark, prsOn, markAgents = () => true, refs = () => [], counts = async () => null, onReview = () => {}, onCount = () => {} }) {
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
  const loads = loadGuard(); // a git-only refresh can overtake a PR load: its merged PRs still count (AK-338)
  let loaded = Boolean(res);
  let readId = null; // the entry in the reader
  let readTimer = 0;
  let change = null; // { id, diffs, message } once the reader's entry is read
  const viewed = new Map(); // entry id → Set of viewed paths (this view only)
  const folds = new Map(); // "id\0path" → folded, set by hand; otherwise viewed files are folded
  const full = new Set(); // "id\0path" of diffs shown past the truncation limit

  const el = h('div.page.flush.catchup', { tabIndex: 0, role: 'region', 'aria-label': 'Catch up' });
  const updated = h('span.muted.review-updated', { 'aria-live': 'polite' });
  const reloadBtn = h('button.btn.ghost.small.review-reload', { onclick: () => reload(), 'data-tip': `${tipFor('Reload', 'catchup.reload')}\nAsk GitHub for merged pull requests and the base’s CI`, 'aria-label': 'Reload' });
  // The branch picker (AK-372, AK-374; a text button like the since picker, AK-390): a menu with the
  // default base first, then remote and local branches.
  const branchBtn = h('button.btn.ghost.small.catchup-branch', { 'aria-haspopup': 'menu', 'aria-label': 'Branch to catch up on', 'data-tip': tipFor('Catch up on another branch', 'catchup.branch'), onclick: (e) => { e.stopPropagation(); branchMenu(); } });
  // The head reads as one sentence (AK-390, option A): "88 PRs merged on origin/main ▾ since your checkpoint ▾",
  // then one quiet line: date · other commits · CI · Updated. Actions on the right.
  const sinceBtn = h('button.btn.ghost.small.catchup-since', { 'data-tip': tipFor('Catch up since…', 'catchup.since'), 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); pickSince(e.currentTarget); } });
  const lead = h('span.catchup-lead');
  const sub = h('div.catchup-subline');
  const actions = h('div.catchup-actions');
  const strip = h('div.catchup-strip');
  const msg = h('div.catchup-msg');
  const list = h('div.catchup-list');
  const headBox = h('div.catchup-reader-head');
  const readerDesc = h('div.catchup-reader-desc');
  const readerFiles = h('div.catchup-files', { role: 'list', 'aria-label': 'Files' });
  // The reader is its own scroll and takes focus (↵), so ↑/↓ and Space scroll it.
  const reader = h('div.catchup-reader', { tabIndex: -1, role: 'region', 'aria-label': 'Reader' });
  const mini = miniHeader(reader);
  const cols = h('div.catchup-cols', null, list, reader);
  const hint = h('div.review-hints');
  el.append(
    h('div.page-head.review-head', null,
      h('div.review-head-row.catchup-headrow', null, h('h1.catchup-sentence', null, lead, ' on ', branchBtn, ' ', sinceBtn), h('span.spacer'), actions, reloadBtn),
      sub),
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

  // The default base's name, remembered from the last load on it, so the menu names it while
  // another branch is picked.
  let defaultName = cache?.defaultName || null;
  function renderBranches() {
    if (!base && res?.base && res.defaultBase !== false) { defaultName = res.base; if (cache) cache.defaultName = defaultName; }
    const shown = base ? (refs() || []).find((r) => r.name === base)?.short || base : defaultName || 'the default base';
    branchBtn.textContent = `${shown} ▾`;
  }
  function branchMenu() {
    const r = branchBtn.getBoundingClientRect();
    const seen = new Set();
    const items = [{ label: defaultName ? `${defaultName} (default)` : 'Default base', icon: base ? undefined : 'check', run: () => pickBranch(null) }];
    for (const kind of ['remote', 'branch']) {
      const group = (refs() || []).filter((x) => x.kind === kind && !x.name.endsWith('/HEAD') && !seen.has(x.name) && seen.add(x.name));
      if (group.length) items.push('-', { section: kind === 'remote' ? 'Remote branches' : 'Local branches' }, ...group.map((x) => ({ label: x.short, icon: x.name === base ? 'check' : undefined, run: () => pickBranch(x.name) })));
    }
    contextMenu(r.left, r.bottom, items);
  }
  // Another branch has no checkpoint: catch up from last week, and Mark caught up doesn't apply.
  function pickBranch(ref) {
    if ((ref || null) === base) return;
    base = ref || null;
    since = base ? { since: 'week' } : { since: 'checkpoint' };
    more = false; selId = null; readId = null; change = null;
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
    lead.textContent = 'Catch up'; sub.replaceChildren(); actions.replaceChildren();
    if (failed) return showMsg(h('div.empty', null, `Couldn’t read what landed: ${failed}`));
    if (!res) return showMsg(h('div.empty', null, loaded ? 'No base branch to catch up on.' : 'Catching up…'));
    const head = sinceText(res, { short, ago: (ms) => ago(ms) });
    const cp = res.checkpoint || {};
    const when = since.since === 'checkpoint' ? whenText(cp.date) : '';
    const ci = res.ci && { passing: '✓', failing: '✗', pending: '…' }[res.ci.state];
    sinceBtn.textContent = `${sincePhrase(since)} ▾`;
    const warn = head.warn ? h('div.catchup-warn', null, icon('warning', 12), head.warn) : null;
    const subline = (extraText) => sub.replaceChildren(...[
      when ? h('span', { title: cp.date ? fullDate(cp.date / 1000) : '' }, when) : null,
      extraText ? h('span', null, extraText) : null,
      ci ? h('span.catchup-ci.' + res.ci.state, { title: `${res.base} CI ${res.ci.state}${res.ci.failed?.length ? `: ${res.ci.failed.join(', ')}` : ''}` }, `CI ${ci} on ${res.base}`) : null,
      prsOn() ? updated : null,
    ].filter(Boolean).flatMap((x, i) => (i ? [h('span.catchup-dot', { 'aria-hidden': 'true' }, '·'), x] : [x])), warn || '');
    actions.replaceChildren(...(res.defaultBase === false || !entries.length ? [] : [btn('Mark caught up', 'catchup.caughtUp', () => markCaughtUp())]));

    if (!entries.length) {
      lead.textContent = 'Nothing new';
      subline(null);
      const what = since.since === 'checkpoint' ? (when ? `since ${when}` : 'since your checkpoint') : sincePhrase(since);
      return showMsg(h('div.catchup-empty', null,
        icon('check', 20),
        h('h2', null, since.since === 'checkpoint' ? 'You’re caught up.' : 'Nothing new.'),
        h('p.muted', null, `Nothing landed on ${res.base} ${what}.`),
        warn,
        btn('Catch up since…', 'catchup.since', (e) => pickSince(e.currentTarget))),
      bridge());
    }

    cols.hidden = false;
    msg.hidden = true;
    const top = headline(entries);
    lead.textContent = `${top.count} ${top.text}`;
    subline(top.extra);
    const all = days();
    const { days: shown, more: hidden } = more ? { days: all, more: 0 } : firstOf(all, FIRST);
    if (!visible().some((e) => e.id === selId)) selId = visible()[0]?.id || null;
    strip.hidden = true;
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

  // The key bar: the reader's keys while focus is in it, the timeline's otherwise.
  function renderHints() {
    const k = (keys, label, cls = '') => h('span.review-hint' + cls, null, kbd(...keys), label);
    const id = (x) => keymap.keys(x);
    const rows = reader.contains(document.activeElement)
      ? [k([...id('reader.down'), ...id('reader.up')], 'Scroll'), k(fastKeys(), 'Faster'), k(keymap.keys('reader.pageDown', { index: 1 }) || id('reader.pageDown'), 'Page'), k([...id('reader.prev'), ...id('reader.next')], 'Previous / next'), k([...id('reader.prevFile'), ...id('reader.nextFile')], 'Files'), k(id('catchup.viewed'), 'Viewed'), k(id('reader.back'), 'Back to the timeline')]
      : [k([...id('catchup.prev'), ...id('catchup.next')], 'Move'), k(id('catchup.open'), 'Read'), k(id('catchup.caughtUp'), 'Mark caught up'), k(id('catchup.since'), 'Since…'), k(id('catchup.reload'), 'Reload')];
    hint.replaceChildren(...rows, k(id('view.palette'), 'All commands', '.all'));
  }
  reader.addEventListener('focusin', () => renderHints());
  reader.addEventListener('focusout', () => setTimeout(() => { if (el.isConnected) renderHints(); }));

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
    const t = loads.start(withPrs);
    const range = JSON.stringify([since, base]);
    if (withPrs) { reloading = true; renderHead(); }
    try {
      const opts = { ...since, prs: withPrs, ...(base ? { base } : {}) };
      // The default range with PRs joins the load from opening the repo, if it's still running.
      const r = await (withPrs && since.since === 'checkpoint' && !base ? prLoads.run(repo, () => load(opts)) : load(opts));
      if (n !== seq) {
        // Overtaken by a newer git-only refresh of the same range: keep this load's merged PRs and CI.
        if (r && loads.prs(t) && prsOn() && range === JSON.stringify([since, base])) {
          extra = { merged: r.merged, ci: r.ci };
          loadedAt = Date.now();
          res = withLateExtra(res, extra);
          cache = { repo, since, base, extra, loadedAt, defaultName, res };
          entries = res ? landedEntries(res.commits, res.merged) : [];
          if (res && since.since === 'checkpoint' && !base) onCount(entries.length);
          if (res) render();
        }
        return;
      }
      failed = null;
      loaded = true;
      if (withPrs) { extra = r ? { merged: r.merged, ci: r.ci } : null; loadedAt = Date.now(); }
      if (!prsOn()) { extra = null; loadedAt = null; }
      cache = { repo, since, base, extra, loadedAt, defaultName };
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
  // selection after READ_DELAY, or at once (`now`) on a click or ↵.
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
    reader.replaceChildren(mini.el, headBox, readerDesc, readerFiles);
    renderReaderHead();
    readerDesc.replaceChildren();
    readerFiles.replaceChildren(loading(`Reading ${e.kind === 'pr' ? `#${e.number}` : short(e.sha)}…`));
    const id = e.id;
    read(e.sha).then((r) => {
      if (id !== readId || !el.isConnected) return;
      change = { id, ...r };
      renderReaderHead(); // the commit message may name an agent (AK-390)
      renderDescription();
      renderFiles();
    }, (err) => {
      if (id !== readId || !el.isConnected) return;
      readerFiles.replaceChildren(h('div.empty', null, `Couldn’t read ${short(e.sha)}: ${err.message}`));
    });
  }

  // "+42 −2 · 3 files" once the change is read, like Review's pane head.
  const sizeEl = (z) => (z && z.files ? h('span.stat.small', { title: `${z.files} file${z.files === 1 ? '' : 's'} changed` }, h('span.add', null, `+${z.additions}`), ' ', h('span.del', null, `−${z.deletions}`), ` · ${z.files} file${z.files === 1 ? '' : 's'}`) : null);
  // The shared head (reader.js): "‹ 3 of 21 ›", "#313 title", then "(M) mira  agent/web-313 →
  // origin/main  WEB-142  merged Tuesday 18:40  ✓ Merged".
  function renderReaderHead() {
    const e = entryById(readId);
    if (!e || !res) return;
    const pr = e.kind === 'pr';
    const num = pr ? `#${e.number}` : short(e.sha);
    // Who made it (AK-390): the commit's author, + the agent its message's trailers name once it's read.
    const authors = authorsOf({ person: e.author ? { name: e.author } : null, agent: change?.id === e.id ? messageAgent(change.message) : null, agents: markAgents() });
    const top = readerHead({
      num, numTip: e.sha, title: e.title, nav: { ...navPos(entries, e.id), onStep: step },
      authors,
      branch: pr && e.branch ? e.branch : null, base: res.base,
      meta: [
        h('span.badge.catchup-chip' + (e.key ? '' : '.muted'), null, e.key || e.area),
        sizeEl(change?.id === e.id ? changeSize(change.diffs || []) : null),
        e.date ? h('span', { title: fullDate(e.date / 1000) }, `${pr ? 'merged' : 'committed'} ${whenText(e.date)}`) : null,
        pr ? h('span.catchup-merged', null, icon('check-circle', 12), 'Merged') : null,
      ].filter(Boolean),
    });
    headBox.replaceChildren(top);
    mini.set(miniContent({ authors, num, title: e.title }));
    mini.watch(top);
  }

  // The PR's description (or the commit message), clamped until … Show more.
  function renderDescription() {
    const e = entryById(readId);
    if (!e || change?.id !== e.id) return;
    const { text, from } = readerDescription(e, change.message);
    readerDesc.replaceChildren(descriptionBlock({
      label: e.kind === 'pr' ? 'Description' : 'Commit message',
      note: e.kind === 'pr' && from === 'commit' ? h('span.muted', null, '· from the commit message') : null,
      text,
    }) || '');
  }

  // Each file a shared card (reader.js): fold chevron, viewed tick, path, +N −M. Viewed files fold.
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
    const folded = folds.has(fk) ? folds.get(fk) : done;
    return fileCard({
      path: d.path, add, del,
      checked: done, checkLabel: `Viewed ${d.path}`, checkTip: tipFor(done ? 'Viewed' : 'Mark viewed', 'catchup.viewed'),
      onCheck: () => setViewed(d.path, !done),
      collapsed: folded, onToggle: () => fold(d.path, !folded),
      body: h('div.review-file-body', null, renderDiff(d, { full: full.has(fk), onShowAll: () => { full.add(fk); replaceFile(d.path); } })),
    });
  }
  function replaceFile(path) {
    const old = [...readerFiles.children].find((x) => x.dataset.path === path);
    const d = change?.diffs.find((x) => x.path === path);
    if (!old || !d) return null;
    const focused = document.activeElement;
    const refocus = old.contains(focused) ? (focused.classList.contains('review-tick') ? '.review-tick' : '.review-file-fold') : null;
    const next = fileBlock(d);
    old.replaceWith(next);
    if (refocus) next.querySelector(refocus)?.focus({ preventScroll: true });
    // Folding a file you scrolled into: bring its header back into view.
    if (next.classList.contains('folded') && next.getBoundingClientRect().top < reader.getBoundingClientRect().top) next.scrollIntoView({ block: 'start' });
    return next;
  }
  function fold(path, on) {
    folds.set(`${change.id}\0${path}`, on);
    replaceFile(path);
  }
  function setViewed(path, on) {
    const set = viewedOf(change.id);
    if (on) set.add(path); else set.delete(path);
    folds.delete(`${change.id}\0${path}`); // ticking folds it, unticking shows it again
    replaceFile(path);
  }
  // V: tick the first file not yet viewed.
  function markNextViewed() {
    if (!change || change.id !== readId) return false;
    const path = firstUnviewed(change.diffs.map((d) => d.path), viewedOf(change.id));
    if (path == null) { toast('Every file is viewed'); return true; }
    setViewed(path, true);
    return true;
  }
  // , and . in the reader: the previous or next file's header to the top.
  function jumpFile(d) {
    const cards = [...readerFiles.querySelectorAll('.reader-file')];
    if (!cards.length) return;
    const line = reader.getBoundingClientRect().top + 48; // just under the slim bar
    let cur = -1; // the file being read: the last one whose top is above the line
    cards.forEach((c, i) => { if (c.getBoundingClientRect().top <= line) cur = i; });
    // Back from the middle of a file: its own header first.
    const to = d < 0 && cur >= 0 && cards[cur].getBoundingClientRect().top < line - 12 ? cur : cur + d;
    cards[Math.max(0, Math.min(cards.length - 1, to))].scrollIntoView({ block: 'start' });
  }

  // ←/→ (from the timeline or the reader) and ‹ ›: the previous or next item, the reader following.
  function step(d) {
    const id = stepId(entries, selId, d);
    if (!id || id === selId) return;
    selId = id;
    if (!visible().some((e) => e.id === id)) more = true;
    render();
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
    const vis = visible();
    if (!vis.length) return;
    const i = vis.findIndex((e) => e.id === selId);
    selId = vis[Math.max(0, Math.min(vis.length - 1, (i < 0 ? 0 : i + d)))].id;
    render();
  }
  const showMore = () => { if (!more) { more = true; render(); } };

  el.addEventListener('keydown', (e) => {
    // In the reader (AK-381): ↑/↓ and Space scroll it, ←/→ step the timeline, , and . the files, Esc back.
    if (reader.contains(e.target) && readerKey(e, { scroller: reader, onStep: step, onFile: jumpFile, onBack: () => el.focus({ preventScroll: true }) })) return;
    const r = keymap.match('reader', e);
    if (r === 'reader.next' || r === 'reader.prev') { e.preventDefault(); e.stopPropagation(); step(r === 'reader.next' ? 1 : -1); return; }
    const id = keymap.match('catchup', e);
    if (!id) return;
    if (id === 'catchup.next') move(1);
    else if (id === 'catchup.prev') move(-1);
    else if (id === 'catchup.open') { if (e.target.closest?.('button, input')) return; open(); }
    else if (id === 'catchup.caughtUp') markCaughtUp();
    else if (id === 'catchup.since') pickSince();
    else if (id === 'catchup.reload') reload();
    else if (id === 'catchup.branch') { branchBtn.focus(); branchMenu(); }
    else if (id === 'catchup.more') showMore();
    else if (id === 'catchup.viewed') { if (!markNextViewed()) return; }
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
    el, destroy: () => { clearInterval(tick); window.removeEventListener('focus', onFocus); }, refresh: () => fetch(), reload, markCaughtUp, pickSince: () => pickSince(), showMore, canMore: () => !more && entries.length > FIRST, canReload: () => true,
    // ⌘K: the reader's V.
    markNextViewed,
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
