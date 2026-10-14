import { h, icon, kbd, timeAgo, fullDate, dialog, toast } from './ui.js';
import { laneKey } from './lanes.js';
import { groupLanes, blocked, dirty, preselect, remoteOf, cleanupItem, summarize, plural } from './cleanup.js';
import * as keymap from './keymap.js';

// Lanes → Clean up: stale branches and worktrees, grouped by why they're stale (cleanup.js),
// removed in bulk. The local part (worktrees and branches) is one undo step; deleting branches on
// the remote is a separate opt-in tick per lane and can't be undone. Keyboard-first: J/K move,
// Space ticks, R ticks "delete on remote", ⌘↵ cleans up, Escape goes back to Lanes.

const tildify = (p) => p.replace(/^\/Users\/[^/]+/, '~');

// load() → app:lanes-list result; run(items, label) and runRemote(names) call git; days() and
// setDays(n) read and store the "untouched for" setting; onProgress(fn) subscribes to progress
// and returns an unsubscribe; onDone() refreshes the app; onUndo() undoes the last step;
// onBack() returns to Lanes.
export function cleanupView({ load, run, runRemote, days, setDays, onProgress, onDone, onUndo, onBack, mod = '⌘' }) {
  let lanes = [];
  let groups = [];
  let shown = [];
  let base = null;
  let loaded = false;
  let busy = false;
  let selKey = null;
  let timer = 0;
  let seq = 0;
  const ticked = new Set();
  const remote = new Set();
  const seen = new Set(); // lanes already offered, so a refresh doesn't re-tick what the user unticked

  const daysInput = h('input.input.cleanup-days', { type: 'number', min: 1, max: 3650, value: days(), 'aria-label': 'Days untouched' });
  const count = h('span.muted.lanes-count');
  const goBtn = h('button.btn.danger', { onclick: () => go() }, 'Clean up', kbd(mod, '↵'));
  const progress = h('div.cleanup-progress', { role: 'status', 'aria-live': 'polite', hidden: true }, h('span.spinner'), h('span'));
  const list = h('div.lanes-list', { role: 'listbox', 'aria-label': 'Stale lanes', 'aria-multiselectable': 'true' });
  const empty = h('div.empty');
  const el = h('div.page.flush.lanes.cleanup', { tabIndex: 0 },
    h('div.page-head', null,
      h('div', null, h('h1', null, 'Clean up'), h('p.muted', null, `Stale branches and worktrees. ${mod}Z puts back everything removed here, in one step.`)),
      h('div.page-actions', null, count, h('button.btn.ghost', { onclick: () => onBack() }, 'Back', kbd('esc')), goBtn)),
    h('div.cleanup-bar', null,
      h('label.check', null, h('span', null, 'Untouched for'), daysInput, h('span', null, 'days counts as stale')),
      progress),
    list,
    empty,
    h('div.diff-hint.wt-hint', null, `Space Tick · R Also delete on remote · J/K Move · ${mod}↵ Clean up · Esc Back`),
  );

  daysInput.addEventListener('change', () => {
    const n = Math.round(Number(daysInput.value));
    if (!(n >= 1 && n <= 3650)) { daysInput.value = days(); return; }
    setDays(n);
    render();
  });
  // Typing digits stays in the box; Escape (and Enter, which also commits the change) hands keys back to the list.
  daysInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (keymap.match('cleanup', e) === 'cleanup.back' || keymap.match('lanes', e) === 'lanes.open') el.focus({ preventScroll: true });
  });

  function badges(l) {
    const n = dirty(l);
    return [
      n ? h('span.badge.warn', { title: 'Removing this worktree deletes these files for good' }, `${n} uncommitted`) : null,
      l.merged ? h('span.badge', null, l.merged === 'squash' ? 'Squash-merged' : 'Merged') : null,
      l.upstreamGone ? h('span.badge.warn', null, 'Upstream gone') : null,
      l.worktree?.locked ? h('span.badge', null, 'Locked') : null,
    ];
  }

  function row(l) {
    const key = laneKey(l);
    const why = blocked(l);
    const on = ticked.has(key);
    const r = remoteOf(l);
    const box = h('input', { type: 'checkbox', checked: on, disabled: Boolean(why) || busy, tabIndex: -1, 'aria-label': `Clean up ${l.name}`, onchange: () => toggle(key) });
    return h('div.list-row.lanes-row' + (key === selKey ? '.active' : '') + (why ? '.blocked' : ''), {
      role: 'option', 'aria-selected': String(on), 'aria-disabled': why ? 'true' : null, 'data-key': key,
      title: why || '',
      onclick: (e) => { select(key); if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') toggle(key); },
    },
      box,
      icon(l.worktree ? 'worktree' : 'branch', 14),
      h('div.list-main', null,
        h('div.list-title', null, h('span.lanes-name', null, l.name), ...badges(l)),
        h('div.list-sub', null, why || (l.worktree ? tildify(l.worktree.path) + (l.branch ? ` · ${l.branch}` : '') : l.upstream || 'Local branch'))),
      r && !why ? h('button.chip.cleanup-remote' + (remote.has(key) ? '.on' : ''), {
        title: `Also delete ${r} on the remote. This can’t be undone. (R)`,
        disabled: busy,
        onclick: (e) => { e.stopPropagation(); select(key); toggleRemote(key); },
      }, remote.has(key) ? `Delete ${r}` : 'Keep on remote') : null,
      h('span.lanes-time', { title: l.activity ? fullDate(l.activity / 1000) : '' }, l.activity ? timeAgo(l.activity / 1000) : ''),
    );
  }

  function render() {
    groups = groupLanes(lanes, { days: days() });
    shown = groups.flatMap((g) => g.lanes);
    const keys = new Set(shown.map(laneKey));
    for (const l of shown) {
      const k = laneKey(l);
      if (!seen.has(k)) { seen.add(k); if (preselect(l)) ticked.add(k); }
      if (blocked(l)) ticked.delete(k);
    }
    for (const k of ticked) if (!keys.has(k)) ticked.delete(k);
    for (const k of remote) if (!ticked.has(k)) remote.delete(k);
    if (!keys.has(selKey)) selKey = shown[0] ? laneKey(shown[0]) : null;
    const rows = [];
    for (const { group, lanes: ls } of groups) {
      const open = ls.filter((l) => !blocked(l));
      const all = open.length > 0 && open.every((l) => ticked.has(laneKey(l)));
      const some = open.some((l) => ticked.has(laneKey(l)));
      const box = h('input', { type: 'checkbox', checked: all, disabled: !open.length || busy, tabIndex: -1, 'aria-label': `Tick all in ${group.label}`, onchange: () => tickGroup(open, !all) });
      box.indeterminate = some && !all;
      rows.push(h('label.lanes-group.cleanup-group', { role: 'presentation', title: group.detail },
        box, group.id === 'old' ? `${group.label} for ${days()}+ days` : group.label, h('span.muted', null, ` · ${ls.length}`)));
      rows.push(...ls.map(row));
    }
    list.replaceChildren(...rows);
    const n = ticked.size;
    count.textContent = !loaded ? 'Loading…' : shown.length ? `${n} of ${plural(shown.length, 'stale lane')} ticked` : '';
    goBtn.disabled = busy || !n;
    goBtn.firstChild.textContent = n ? `Clean up ${n}` : 'Clean up';
    empty.textContent = !loaded || shown.length ? '' : `Nothing stale. Every branch and worktree is ahead of ${base || 'the base branch'} and touched in the last ${days()} days.`;
    empty.hidden = !empty.textContent;
  }

  const selected = () => shown.filter((l) => ticked.has(laneKey(l)));
  function toggle(key) {
    const l = shown.find((x) => laneKey(x) === key);
    if (!l || blocked(l) || busy) return;
    if (ticked.has(key)) ticked.delete(key);
    else {
      ticked.add(key);
      if (dirty(l)) toast(`${l.name} has ${plural(dirty(l), 'uncommitted change')}`, { kind: 'error', detail: 'Cleaning it up deletes those files for good. Undo brings the worktree back without them.' });
    }
    render();
  }
  function tickGroup(ls, on) {
    if (busy) return;
    for (const l of ls) (on ? ticked.add(laneKey(l)) : ticked.delete(laneKey(l)));
    render();
  }
  function toggleRemote(key) {
    const l = shown.find((x) => laneKey(x) === key);
    if (!l || !remoteOf(l) || blocked(l) || busy) return;
    if (remote.has(key)) remote.delete(key);
    else { remote.add(key); ticked.add(key); }
    render();
  }

  function select(key) {
    selKey = key;
    list.querySelectorAll('.lanes-row').forEach((r) => r.classList.toggle('active', r.dataset.key === key));
    list.querySelector('.lanes-row.active')?.scrollIntoView({ block: 'nearest' });
  }
  function move(d) {
    if (!shown.length) return;
    const i = shown.findIndex((l) => laneKey(l) === selKey);
    select(laneKey(shown[Math.max(0, Math.min(shown.length - 1, i + d))]));
  }

  async function go() {
    const lanesToGo = selected();
    if (busy || !lanesToGo.length) return;
    const s = summarize(lanesToGo, remote);
    const parts = [s.worktrees ? `removes ${plural(s.worktrees, 'worktree')}` : null, s.branches ? `deletes ${plural(s.branches, 'local branch', 'local branches')}` : null].filter(Boolean).join(' and ');
    const fields = [];
    let description = `This ${parts}. ${mod}Z puts the branches and worktrees back in one step. Ignored files in removed worktrees (build output, dependencies) are deleted for good.`;
    if (s.dirty.length) {
      description += ` ${plural(s.dirty.length, 'worktree has', 'worktrees have')} uncommitted changes (${s.dirty.map((l) => l.name).slice(0, 5).join(', ')}${s.dirty.length > 5 ? '…' : ''}). Those files can’t come back: undo restores the worktree without them.`;
      fields.push({ name: 'lose', type: 'checkbox', label: `Delete the uncommitted changes in ${plural(s.dirty.length, 'worktree')}` });
    }
    const v = await dialog({ title: `Clean up ${plural(lanesToGo.length, 'lane')}?`, description, fields, submit: 'Clean up', destructive: true, wide: true, gate: s.dirty.length ? 'lose' : undefined });
    if (!v) return;
    let remoteNames = s.remotes;
    if (remoteNames.length) {
      const ok = await dialog({
        title: `Also delete ${plural(remoteNames.length, 'branch', 'branches')} on the remote?`,
        description: `${remoteNames.slice(0, 8).join(', ')}${remoteNames.length > 8 ? ` and ${remoteNames.length - 8} more` : ''}. This can’t be undone: ${mod}Z only brings back the local part. Anyone else using these branches loses them too.`,
        fields: [{ name: 'sure', type: 'checkbox', label: 'Delete them on the remote, for good' }],
        submit: 'Delete on remote', destructive: true, gate: 'sure',
      });
      if (!ok) remoteNames = [];
    }
    busy = true;
    progress.hidden = false;
    progress.lastChild.textContent = 'Cleaning up…';
    const off = onProgress(({ done, total }) => { progress.lastChild.textContent = `Cleaning up… ${done} of ${total}`; });
    render();
    let res = null;
    let error = null;
    try {
      res = await run(lanesToGo.map(cleanupItem), `Clean up ${plural(lanesToGo.length, 'lane')}`);
      if (remoteNames.length) {
        progress.lastChild.textContent = `Deleting ${plural(remoteNames.length, 'branch', 'branches')} on the remote…`;
        const r = await runRemote(remoteNames).catch((err) => ({ deleted: [], failed: [{ name: 'remote', message: err.message }] }));
        res.remoteDeleted = r.deleted;
        res.failed.push(...r.failed);
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
    remote.clear();
    await onDone();
    await fetchLanes().catch(fail);
  }

  function report(res) {
    const done = [res.removed.length ? plural(res.removed.length, 'worktree') + ' removed' : null, res.deleted.length ? plural(res.deleted.length, 'branch', 'branches') + ' deleted' : null, res.remoteDeleted?.length ? `${res.remoteDeleted.length} on the remote` : null].filter(Boolean).join(', ');
    if (done) toast(`Cleaned up: ${done}`, { kind: 'success', action: res.removed.length || res.deleted.length ? { label: 'Undo', run: onUndo } : null });
    if (res.failed.length) {
      toast(`${plural(res.failed.length, 'lane was', 'lanes were')} kept`, { kind: 'error', timeout: 0, detail: res.failed.slice(0, 6).map((f) => `${f.name}: ${f.message}`).join('\n') + (res.failed.length > 6 ? `\n…and ${res.failed.length - 6} more` : '') });
    }
  }

  el.addEventListener('keydown', (e) => {
    if (e.target === daysInput) return;
    const id = keymap.match('cleanup', e);
    if (!id) return;
    if (id === 'cleanup.next') move(1);
    else if (id === 'cleanup.prev') move(-1);
    else if (id === 'cleanup.toggle') { if (selKey) toggle(selKey); }
    else if (id === 'cleanup.remote') { if (selKey) toggleRemote(selKey); }
    else if (id === 'cleanup.run') go();
    else if (id === 'cleanup.back') { if (busy) return; onBack(); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  async function fetchLanes() {
    const n = ++seq;
    const res = await load();
    if (n !== seq || (loaded && !el.isConnected)) return;
    base = res.base;
    lanes = res.lanes;
    loaded = true;
    render();
  }
  const fail = (e) => { loaded = true; render(); toast('Could not load lanes', { kind: 'error', detail: e.message }); };

  // Repo changes: debounced, local only; never while a cleanup runs (it reloads when done).
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (el.isConnected && !busy) fetchLanes().catch(fail); }, 400);
  }

  render();
  fetchLanes().catch(fail);
  setTimeout(() => el.focus({ preventScroll: true }));
  return { el, refresh, rerender: render };
}
