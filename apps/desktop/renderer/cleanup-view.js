import { h, icon, kbd, timeAgo, fullDate, dialog, toast } from './ui.js';
import { laneKey } from './lanes.js';
import { groupLanes, blocked, dirty, preselect, remoteOf, reason, cleanupItem, summarize, plural, daysValue } from './cleanup.js';
import * as keymap from './keymap.js';

// Clean up, the Finished tab of Branches (AK-396): finished branches and worktrees (merged, shipped,
// deleted on GitHub, folder missing; untouched ones as your call), one card per reason (cleanup.js
// GROUPS) with a tick for the whole group, a plain explanation and a count. A card opens to its
// branches, each with its own tick. Safe groups are ticked up front; untouched and dirty ones aren't.
// The sticky bar at the bottom cleans up the ticked ones as one undo step; deleting them on GitHub
// too is an opt-in tick and can't be undone. One confirmation lists the branches; cancelling it
// changes nothing.
// Keys (cleanup scope): ↑/↓ move between cards and rows, Space ticks, ↵ opens or closes a card, A ticks
// everything safe, R toggles "Also delete them on GitHub", ⌘⌫ cleans up, Esc goes back to Active.

const tildify = (p) => p.replace(/^\/Users\/[^/]+/, '~');
const SHOWN = 50; // rows a card lists before "+ N more"
const lower = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

// run(items, label) and runRemote(names) call git; days: the "untouched for N days" card, set in
// the action bar (onDays(n) saves it);
// onProgress(fn) subscribes to progress and returns an unsubscribe; onDone() refreshes the app (and
// with it the lanes); onUndo() undoes the last step; onBack() leaves the tab.
// The panel doesn't load: Branches hands it the lanes (update(lanes, base)).
export function cleanupPanel({ run, runRemote, days = 30, onDays = () => {}, onProgress, onDone, onUndo, onBack }) {
  let lanes = [];
  let groups = [];
  let items = []; // the keyboard's stops: { kind: 'group', id } or { kind: 'lane', key }
  let base = null;
  let loaded = false;
  let busy = false;
  let sel = null; // the selected stop's id ('g:<group>' or the laneKey)
  let only = null; // a laneKey: tick just that one when the lanes next arrive
  let alsoRemote = false;
  const ticked = new Set();
  const seen = new Set(); // lanes already offered, so a refresh doesn't re-tick what the user unticked
  const open = new Set(['merged']); // cards that are open
  const more = new Set(); // cards showing every row

  const verdict = h('div.cleanup-verdict');
  const cards = h('div.cleanup-cards', { role: 'tree', 'aria-label': 'Finished branches', 'aria-multiselectable': 'true' });
  const goBtn = h('button.btn.primary.cleanup-go', { onclick: () => go() });
  const counts = h('span.cleanup-counts');
  const remoteBox = h('input', { type: 'checkbox', tabIndex: -1, onchange: () => { alsoRemote = remoteBox.checked; render(); } });
  const remoteLabel = h('label.check.cleanup-remote-all', { 'data-tip': `Also delete them on GitHub (${keymap.keys('cleanup.remote').join('')})` }, remoteBox, h('span', null, 'Also delete them on GitHub (can’t be undone)'));
  const progress = h('span.cleanup-progress', { role: 'status', 'aria-live': 'polite', hidden: true }, h('span.spinner'), h('span'));
  const daysBox = h('input', { type: 'number', min: 1, max: 365, step: 1, value: String(days), 'aria-label': 'Days before a branch counts as untouched',
    onkeydown: (e) => { if (e.key !== 'Escape') e.stopPropagation(); },
    onchange: () => {
      const n = daysValue(daysBox.value);
      if (n == null) { daysBox.value = String(days); return; }
      if (n !== days) { days = n; onDays(n); render(); }
    } });
  const daysLabel = h('label.cleanup-days', { 'data-tip': 'Branches with no commits for this many days show under Untouched' }, h('span', null, 'Untouched after'), daysBox, h('span', null, 'days'));
  const bar = h('div.cleanup-actionbar', null, goBtn, counts, remoteLabel, progress, daysLabel);
  const el = h('div.cleanup-panel', null, verdict, cards, bar);

  const isOn = (l) => ticked.has(laneKey(l));
  // Clicks re-render the cards: keys go back to the view, not the removed element.
  const home = () => (el.closest('[tabindex="0"]') || el).focus({ preventScroll: true });
  const label = (g) => (g.id === 'old' ? `${g.label} for ${days}+ days` : g.label);
  // The branch's note: where it merged, or why it's here.
  const note = (l) => blocked(l) || (l.upstreamGone && !l.done && !l.merged ? 'deleted on GitHub' : lower(reason(l, { days })) || '');

  function card({ group: g, lanes: ls }) {
    const can = ls.filter((l) => !blocked(l));
    const all = can.length > 0 && can.every(isOn);
    const some = can.some(isOn);
    const isOpen = open.has(g.id);
    const box = h('input', { type: 'checkbox', checked: all, disabled: !can.length || busy, tabIndex: -1, 'aria-label': `Tick all in ${label(g)}` });
    box.indeterminate = some && !all;
    const gsel = sel === `g:${g.id}`;
    const summary = h('summary.cleanup-card-head' + (gsel ? '.active' : ''), {
      'data-key': `g:${g.id}`, role: 'treeitem', 'aria-expanded': String(isOpen), 'aria-selected': String(gsel),
      onclick: (e) => {
        e.preventDefault(); // the card opens through `open` (render), the tick through tickGroup
        sel = `g:${g.id}`;
        if (e.target === box) tickGroup(g.id);
        else toggleOpen(g.id);
        home();
      },
    },
      box,
      h('span.cleanup-card-text', null, h('b', null, g.warn ? icon('warning', 12) : null, label(g))),
      h('span.cleanup-card-n', null, String(ls.length)),
      h('span.cleanup-card-chev', { 'aria-hidden': 'true' }, isOpen ? '▴' : '▾'));
    const rows = isOpen ? (more.has(g.id) ? ls : ls.slice(0, SHOWN)).map(row) : [];
    const rest = isOpen && !more.has(g.id) && ls.length > SHOWN
      ? h('button.cleanup-more', { onclick: () => { more.add(g.id); render(); home(); } }, `+ ${ls.length - SHOWN} more`) : null;
    return h('details.cleanup-card' + (g.warn ? '.warn' : ''), { open: isOpen }, summary, ...rows, rest);
  }

  function row(l) {
    const key = laneKey(l);
    const why = blocked(l);
    const n = dirty(l);
    const box = h('input', { type: 'checkbox', checked: isOn(l), disabled: Boolean(why) || busy, tabIndex: -1, 'aria-label': `Clean up ${l.name}` });
    return h('div.cleanup-item' + (sel === key ? '.active' : '') + (why ? '.blocked' : ''), {
      'data-key': key, role: 'treeitem', 'aria-selected': String(sel === key), 'aria-disabled': why ? 'true' : null,
      title: [l.title !== l.name ? l.title : null, l.worktree ? tildify(l.worktree.path) : null, why].filter(Boolean).join('\n'),
      onclick: (e) => { sel = key; if (e.target === box) e.preventDefault(); toggle(key); home(); },
    },
      box,
      h('span.cleanup-item-name', null, l.name),
      h('span.cleanup-item-note' + (n ? '.warn' : ''), null, [note(l), n ? `${plural(n, 'uncommitted file')}` : null].filter(Boolean).join(' · ')),
      h('span.cleanup-item-age', { title: l.activity ? fullDate(l.activity / 1000) : '' }, l.activity ? timeAgo(l.activity / 1000) : ''));
  }

  function render() {
    groups = groupLanes(lanes, { days });
    const shown = groups.flatMap((g) => g.lanes);
    const keys = new Set(shown.map(laneKey));
    for (const l of shown) {
      const k = laneKey(l);
      if (!seen.has(k)) { seen.add(k); if (!only && preselect(l)) ticked.add(k); }
      if (blocked(l)) ticked.delete(k);
    }
    if (only && loaded) { ticked.clear(); if (keys.has(only)) { ticked.add(only); const g = shown.find((l) => laneKey(l) === only)?.group; if (g) open.add(g); sel = only; } only = null; }
    for (const k of ticked) if (!keys.has(k)) ticked.delete(k);
    items = groups.flatMap((g) => [`g:${g.group.id}`, ...(open.has(g.group.id) ? (more.has(g.group.id) ? g.lanes : g.lanes.slice(0, SHOWN)).map(laneKey) : [])]);
    if (!items.includes(sel)) sel = items[0] ?? null;

    const finished = shown.filter((l) => l.group !== 'old').length;
    verdict.replaceChildren(...(!loaded ? [h('div.cleanup-big', null, 'Loading…')]
      : finished || shown.length ? [h('div.cleanup-big', null, finished ? `${plural(finished, 'finished branch', 'finished branches')} can go` : 'Nothing finished yet')]
        : [h('div.cleanup-big', null, 'Nothing to clean up')]));
    cards.replaceChildren(...groups.map(card));

    const chosen = selected();
    const s = summarize(chosen);
    const remotes = chosen.filter((l) => remoteOf(l, base)).length;
    goBtn.disabled = busy || !chosen.length;
    goBtn.replaceChildren(chosen.length ? `Clean up ${chosen.length}` : 'Clean up', kbd(...keymap.keys('cleanup.run')));
    counts.textContent = chosen.length ? [chosen.length === 1 ? 'branch' : 'branches', s.worktrees ? plural(s.worktrees, 'worktree') : null].filter(Boolean).join(' · ') : 'Tick what can go';
    remoteBox.checked = alsoRemote && remotes > 0;
    remoteBox.disabled = busy || !remotes;
    remoteLabel.classList.toggle('disabled', !remotes);
    bar.hidden = !shown.length;
  }

  const selected = () => groups.flatMap((g) => g.lanes).filter(isOn);
  function toggle(key) {
    const l = groups.flatMap((g) => g.lanes).find((x) => laneKey(x) === key);
    if (!l || blocked(l) || busy) return render();
    if (ticked.has(key)) ticked.delete(key);
    else {
      ticked.add(key);
      if (dirty(l)) toast(`${l.name} has ${plural(dirty(l), 'uncommitted change')}`, { kind: 'error', detail: 'Cleaning it up deletes those files for good. Undo brings the worktree back without them.' });
    }
    render();
  }
  function tickGroup(id) {
    const g = groups.find((x) => x.group.id === id);
    if (!g || busy) return render();
    const can = g.lanes.filter((l) => !blocked(l));
    const all = can.length > 0 && can.every(isOn);
    for (const l of can) (all ? ticked.delete(laneKey(l)) : ticked.add(laneKey(l)));
    if (!all && g.group.warn) toast(`${plural(can.length, 'worktree has', 'worktrees have')} uncommitted changes`, { kind: 'error', detail: 'Cleaning them up deletes those files for good.' });
    render();
  }
  function toggleOpen(id) {
    if (open.has(id)) open.delete(id); else open.add(id);
    render();
  }
  // Tick everything safe (not dirty, not untouched), or untick all when it already is.
  function tickAll() {
    if (busy) return;
    const ok = groups.flatMap((g) => g.lanes).filter(preselect);
    const all = ok.length > 0 && ok.every(isOn);
    if (all) ticked.clear();
    else for (const l of ok) ticked.add(laneKey(l));
    render();
  }

  function move(d) {
    if (!items.length) return;
    const i = items.indexOf(sel);
    sel = items[Math.max(0, Math.min(items.length - 1, i + d))];
    render();
    el.querySelector('.cleanup-card-head.active, .cleanup-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  async function go() {
    const lanesToGo = selected();
    if (busy || !lanesToGo.length) return;
    const remoteSet = new Set(alsoRemote ? lanesToGo.filter((l) => remoteOf(l, base)).map(laneKey) : []);
    const s = summarize(lanesToGo, remoteSet, { all: lanes, base });
    const remoteNames = s.remotes;
    const gone = new Set(remoteNames);
    // One row per branch with only what changes for it; the warning and its tick only when
    // something can't come back (GitHub branches, uncommitted files).
    const rows = lanesToGo.map((l) => {
      const n = dirty(l);
      return h('div.cleanup-confirm-row', null,
        h('span.cleanup-confirm-name', { title: l.name }, l.name),
        n ? h('span.cleanup-confirm-tag.warn', null, `${n} uncommitted`) : null,
        l.worktree ? h('span.cleanup-confirm-tag', null, 'worktree') : null,
        remoteSet.has(laneKey(l)) && gone.has(remoteOf(l, base)) ? h('span.cleanup-confirm-tag', null, 'GitHub') : null);
    });
    const content = [h('div.cleanup-confirm-list', null, ...rows)];
    const fields = [];
    const lose = [remoteNames.length ? `${remoteNames.length} on GitHub` : null, s.dirty.length ? `the uncommitted changes in ${plural(s.dirty.length, 'worktree')}` : null].filter(Boolean);
    if (lose.length) {
      content.push(h('p.cleanup-confirm-warn', null, 'This can’t be undone.'));
      fields.push({ name: 'sure', type: 'checkbox', label: `Delete ${lose.join(' and ')}, for good` });
    }
    const v = await dialog({ title: `Clean up ${plural(lanesToGo.length, 'branch', 'branches')}?`, content, fields, submit: 'Clean up', destructive: true, gate: lose.length ? 'sure' : undefined });
    if (!v) return;
    busy = true;
    progress.hidden = false;
    progress.lastChild.textContent = 'Cleaning up…';
    const off = onProgress(({ done, total }) => { progress.lastChild.textContent = `Cleaning up… ${done} of ${total}`; });
    render();
    let res = null;
    let error = null;
    try {
      res = await run(lanesToGo.map(cleanupItem), `Clean up ${plural(lanesToGo.length, 'branch', 'branches')}`);
      if (remoteNames.length) {
        progress.lastChild.textContent = `Deleting ${plural(remoteNames.length, 'branch', 'branches')} on GitHub…`;
        const r = await runRemote(remoteNames).catch((err) => ({ deleted: [], failed: remoteNames.map((name) => ({ name, message: err.message })) }));
        res.remoteDeleted = r.deleted;
        res.remoteFailed = r.failed;
      }
    } catch (err) {
      error = err;
    } finally {
      off();
      busy = false;
      progress.hidden = true;
    }
    if (error) toast('Clean up failed', { kind: 'error', detail: error.message });
    else report(res);
    ticked.clear();
    alsoRemote = false;
    render();
    await onDone();
  }

  function report(res) {
    const done = [res.removed.length ? plural(res.removed.length, 'worktree') + ' removed' : null, res.deleted.length ? plural(res.deleted.length, 'branch', 'branches') + ' deleted' : null, res.remoteDeleted?.length ? `${res.remoteDeleted.length} on GitHub` : null].filter(Boolean).join(', ');
    if (done) toast(`Cleaned up: ${done}`, { kind: 'success', action: res.removed.length || res.deleted.length ? { label: 'Undo', run: onUndo } : null });
    const detail = (list) => list.slice(0, 6).map((f) => `${f.name}: ${f.message}`).join('\n') + (list.length > 6 ? `\n…and ${list.length - 6} more` : '');
    if (res.failed.length) toast(`${plural(res.failed.length, 'branch was', 'branches were')} kept`, { kind: 'error', timeout: 0, detail: detail(res.failed) });
    if (res.remoteFailed?.length) toast(`${plural(res.remoteFailed.length, 'branch was', 'branches were')} not deleted on GitHub`, { kind: 'error', timeout: 0, detail: detail(res.remoteFailed) });
  }

  // The panel's keys (cleanup scope); true when one ran.
  function keydown(e) {
    const id = keymap.match('cleanup', e);
    if (!id) return false;
    if (id === 'cleanup.next') move(1);
    else if (id === 'cleanup.prev') move(-1);
    else if (id === 'cleanup.toggle') { if (sel?.startsWith('g:')) tickGroup(sel.slice(2)); else if (sel) toggle(sel); }
    else if (id === 'cleanup.expand') { if (sel?.startsWith('g:')) toggleOpen(sel.slice(2)); else return false; }
    else if (id === 'cleanup.all') tickAll();
    else if (id === 'cleanup.remote') { if (!remoteBox.disabled) { alsoRemote = !alsoRemote; render(); } }
    else if (id === 'cleanup.run') go();
    else if (id === 'cleanup.back') { if (busy) return true; onBack(); }
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  render();
  return {
    el,
    keydown,
    // New lanes (Branches loaded or refreshed); never while a cleanup runs (it refreshes when done).
    update(next, b) { if (busy) return; lanes = next; base = b; loaded = true; render(); },
    // Tick just this lane (a branch's Clean up), once the lanes are there.
    only(key) { only = key; if (loaded) render(); },
    busy: () => busy,
    go,
    tickAll,
    toggleRemote: () => { if (!remoteBox.disabled) { alsoRemote = !alsoRemote; render(); } },
    count: () => selected().length,
  };
}
