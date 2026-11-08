import { h, icon, kbd, toast, dialog, timeAgo, fullDate } from '../lib/ui.ts';
import * as keymap from '../palette/keymap.ts';
import { up } from '../lib/upcalls.ts';
import { tip, state, MOD } from '../lib/app-helpers.ts';
import { undo, redo, git, act } from '../lib/bridge.ts';
import type { JournalItem, RefChange } from '../../shared/git-types.ts';
import { refreshHistory } from '../graph/load.js';

// Snapshots (undo history)

// History & recovery: Snapshots (the undo timeline) and the reflog on one page, a tab each (AK-463).
function historyTabs(on: string) {
  const tab = (id: string, label: string) => h('button.review-tab', { role: 'tab', onclick: () => on !== id && up.setView(id), title: tip(label, `view.${id}`), 'aria-selected': String(on === id) }, label);
  return h('div.history-tabs', { role: 'tablist', 'aria-label': 'History & recovery' }, tab('snapshots', 'Snapshots'), tab('reflog', 'Reflog'));
}
function snapshotsView() {
  const { undo: u, redo: r, undoCount, redoCount } = state.history;
  const entries: (JournalItem & { redo?: boolean })[] = [...[...r].map((e) => ({ ...e, redo: true })), ...[...u].reverse()];
  const hidden = undoCount - u.length + redoCount - r.length;
  const more = () => { state.historyLimit += 500; refreshHistory(); };
  return h('div.page.flush.history-page', null,
    h('div.page-head', null,
      h('div', null, h('h1', null, 'History & recovery'), historyTabs('snapshots')),
      h('div.page-actions', null,
        h('button.btn.subtle', { disabled: !u.length, onclick: undo }, icon('undo', 14), 'Undo', kbd(...(keymap.keys('edit.undo') ?? []))),
        h('button.btn.subtle', { disabled: !r.length, onclick: redo }, icon('redo', 14), 'Redo', kbd(...(keymap.keys('edit.redo') ?? [])))),
    ),
    entries.length ? h('div.timeline', null, entries.map((e, i) => h('div.tl-row' + (e.redo ? '.undone' : '') + (!e.redo && i === r.length ? '.current' : '') + (e.id === state.snapSel ? '.selected' : ''), { 'data-id': e.id, onclick: (ev) => { if (!ev.target.closest('button')) selectSnapshot(e.id); } },
      h('span.tl-dot'),
      h('div.list-main', null, h('div.list-title', null, e.label), h('div.list-sub', null, e.redo ? 'Undone — can be redone' : i === r.length ? 'Latest' : fullDate(e.time / 1000))),
      h('span.when', null, timeAgo(e.time / 1000)),
      !e.movesRefs ? null : h('button.btn.ghost.small', { title: 'Preview and restore refs to the state before this operation (↵)', onclick: () => restoreSnapshot(e) }, icon('restore', 13), 'Restore before'),
    )), hidden > 0 ? h('div.tl-more', null, h('button.btn.subtle.small', { onclick: more }, `Show ${hidden.toLocaleString()} more`)) : null) : h('div.empty.big', null, icon('history', 28), h('div', null, 'No snapshots yet'), h('div.muted', null, 'Operations like commit, checkout, merge, rebase or discard will appear here.')),
  );
}

const snapshotEntries = () => [...state.history.redo, ...[...state.history.undo].reverse()];

function selectSnapshot(id: number) {
  state.snapSel = id;
  for (const row of document.querySelectorAll<HTMLElement>('.timeline .tl-row')) row.classList.toggle('selected', Number(row.dataset.id) === id);
  document.querySelector('.timeline .tl-row.selected')?.scrollIntoView({ block: 'nearest' });
}

// ↑/↓ select a snapshot, ↵ previews restoring the state before it.
function snapshotKey(e: KeyboardEvent) {
  const list = snapshotEntries();
  if (!list.length) return false;
  const at = list.findIndex((x) => x.id === state.snapSel);
  const id = keymap.match('snapshots', e);
  const step = id === 'snapshots.next' ? 1 : id === 'snapshots.prev' ? -1 : 0;
  if (step) { selectSnapshot(list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + step))]!.id); return true; }
  const cur = list[at];
  if (id === 'snapshots.restore' && cur && document.activeElement?.tagName !== 'BUTTON') { if (cur.movesRefs) restoreSnapshot(cur); return true; }
  return false;
}

const refName = (r: string) => r.replace(/^refs\/(heads|tags)\//, '');
const shortOid = (o: string | null) => (o ?? '').slice(0, 7);
const changeRow = (c: RefChange) => {
  const to = c.to ?? '';
  const [kind, text] = c.kind === 'head'
    ? ['HEAD', `${c.from ? (c.from.startsWith('refs/') ? refName(c.from) : shortOid(c.from)) : 'none'} → ${to.startsWith('refs/') ? refName(to) : `${shortOid(to)} (detached)`}`]
    : c.kind === 'create' ? ['Create', `${refName(c.ref)} at ${shortOid(c.to)}`]
      : c.kind === 'delete' ? ['Delete', `${refName(c.ref)} (was ${shortOid(c.from)})`]
        : ['Move', `${refName(c.ref)} ${shortOid(c.from)} → ${shortOid(c.to)}`];
  return h('li.restore-change.' + c.kind, null, h('span.restore-kind', null, kind), h('span.mono', null, text), c.ref.startsWith('refs/tags/') ? h('span.muted', null, ' tag') : null);
};

// Preview what "Restore before" would change, then apply it as one undoable step.
// One preview at a time: a second ↵ (or key repeat) during the preview's git call would stack a second dialog.
let restorePending = false;
async function restoreSnapshot(e: JournalItem) {
  if (restorePending) return;
  restorePending = true;
  let p;
  try { p = await git('previewRestore', e.id); } catch (err) { return toast('Can’t preview this snapshot', { kind: 'error', detail: (err as Error).message }); } finally { restorePending = false; }
  if (!p.changes.length && !p.movesHead) return toast(`Already at the state before “${e.label}”`);
  const desc = h('div.restore-preview', null,
    h('div', null, `${p.changes.length} change${p.changes.length === 1 ? '' : 's'}. You can undo this with ${MOD}Z.`),
    h('ul.restore-changes', null, p.changes.map(changeRow)),
    p.movesHead ? h('div.muted', null, 'The working copy moves with HEAD. Uncommitted changes are kept when possible; if they’d be overwritten, nothing changes.') : null);
  if (await dialog({ title: `Restore the state before “${e.label}”?`, description: desc, submit: 'Restore', wide: true })) act(`Restore before “${e.label}”`, 'restoreHistory', [e.id]);
}

export { snapshotsView, historyTabs, snapshotEntries, restoreSnapshot, snapshotKey };
