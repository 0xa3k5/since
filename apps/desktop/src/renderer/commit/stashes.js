import { h, icon, kbd, loading, toast, dialog, confirm, contextMenu, timeAgo } from '../lib/ui.ts';
import { renderDiff } from './diff.js';
import * as keymap from '../palette/keymap.ts';
import { up } from '../lib/upcalls.js';
import { state, keyText, isEditable, MOD, baseName } from '../lib/app-helpers.js';
import { stashFocus, stashShown, setStashFocus, setStashShown } from '../shell/shell.js';
import { git, act, gitTooOld, updateGit } from '../lib/bridge.js';

// Stashes

function stashesView() {
  const el = h('div.split-view');
  const list = h('div.list-pane');
  const detail = h('div.detail-pane');
  el.append(list, up.paneHandle('stash', () => el), detail);
  let current = state.stashes.some((x) => x.ref === stashFocus) ? stashFocus : state.stashes[0]?.ref;
  setStashFocus(null);
  function renderList() {
    setStashShown(current);
    list.replaceChildren(
      h('div.pane-head', null, h('span', null, 'Stashes'), h('span.sb-count', null, state.stashes.length), h('span.spacer'), h('button.btn.subtle.small', { onclick: () => stashSave() }, icon('plus', 13), 'Stash changes')),
      state.stashes.length ? h('div', null, state.stashes.map((s) => h('div.list-row' + (s.ref === current ? '.active' : ''), {
        onclick: () => { current = s.ref; renderList(); renderDetail(); },
        oncontextmenu: (e) => { e.preventDefault(); stashMenu(e.clientX, e.clientY, s); },
      }, icon('stash', 14), h('div.list-main', null, h('div.list-title', null, s.message), h('div.list-sub', null, s.ref)), h('span.when', null, timeAgo(s.time))))) :
        h('div.empty.big', null, icon('stash', 28), h('div', null, 'No stashes'), h('div.muted', null, `Stash uncommitted changes with ${keyText('repo.stash')}`)),
    );
  }
  async function renderDetail() {
    const s = state.stashes.find((x) => x.ref === current);
    if (!s) return detail.replaceChildren();
    detail.replaceChildren(loading('Loading diff…'));
    const diffs = await git('compare', `${s.sha}^1`, s.sha).catch(() => []);
    if (s.ref !== current) return;
    detail.replaceChildren(
      h('div.diff-head', null, h('span.title', null, s.message), h('span.spacer'),
        h('button.btn.ghost.small', { onclick: () => dropStash(s) }, 'Drop'),
        h('button.btn.subtle.small', { onclick: () => applyStash(s) }, 'Apply', kbd(...keymap.keys('stashes.apply'))),
        h('button.btn.primary.small', { onclick: () => act(`Pop ${s.ref}`, 'stashApply', [s.ref, true]) }, 'Pop')),
      h('div.diff-scroll', null, diffs.length ? diffs.map((d) => h('div.diff-file', null, h('div.diff-file-head', null, h('span.mono', null, d.newPath === '/dev/null' ? d.oldPath : d.newPath)), renderDiff(d))) : h('div.empty', null, 'Untracked files only')),
    );
  }
  // ↑/↓ move the selection through the list; ↵ applies the selected stash (keeps it).
  el.tabIndex = 0;
  el.addEventListener('keydown', (e) => {
    const id = keymap.match('stashes', e);
    if (!id || isEditable(e.target) || !state.stashes.length) return;
    if (id === 'stashes.apply') {
      const s = state.stashes.find((x) => x.ref === current);
      if (!s || document.activeElement?.tagName === 'BUTTON') return;
      e.preventDefault();
      return applyStash(s);
    }
    const step = { 'stashes.next': 1, 'stashes.prev': -1 }[id];
    if (!step) return;
    e.preventDefault();
    const i = state.stashes.findIndex((x) => x.ref === current);
    const n = state.stashes[Math.max(0, Math.min(state.stashes.length - 1, i < 0 ? 0 : i + step))];
    if (n.ref === current) return;
    current = n.ref;
    renderList();
    renderDetail();
    list.querySelector('.list-row.active')?.scrollIntoView({ block: 'nearest' });
  });
  renderList();
  renderDetail();
  setTimeout(() => el.focus({ preventScroll: true }));
  return el;
}

const applyStash = (s) => act(`Apply ${s.ref}`, 'stashApply', [s.ref, false]);

function stashMenu(x, y, s) {
  contextMenu(x, y, [
    { label: 'Apply', icon: 'check', kbd: keymap.keys('stashes.apply'), run: () => applyStash(s) },
    { label: 'Pop', icon: 'pull', run: () => act(`Pop ${s.ref}`, 'stashApply', [s.ref, true]) },
    '-',
    { label: 'Drop…', icon: 'trash', danger: true, run: () => dropStash(s) },
  ]);
}

async function dropStash(s) {
  if (await confirm(`Drop ${s.ref}?`, `${s.message}\n\nYou can undo this with ${MOD}Z.`, { submit: 'Drop' })) act(`Drop ${s.ref} (${s.message})`, 'stashDrop', [s.ref]);
}

// Stash everything, only the staged changes, or only `paths`. Lines and hunks stash from the diff pane.
// `untracked` forces -u (an untracked path is unknown to git without it), so the checkbox is hidden.
async function stashSave({ staged = false, paths = null, untracked = false } = {}) {
  const what = staged ? 'staged changes' : paths ? (paths.length === 1 ? baseName(paths[0]) : `${paths.length} files`) : 'changes';
  if (staged && !state.status?.staged?.length) return toast('Nothing staged to stash');
  if (staged && gitTooOld('stashStaged')) return updateGit('stashStaged', () => stashSave({ staged }));
  const fields = [{ name: 'msg', label: 'Message', placeholder: 'WIP' }];
  if (!staged && !untracked) fields.push({ name: 'u', type: 'checkbox', label: 'Include untracked files', value: true });
  const v = await dialog({ title: `Stash ${what}`, submit: 'Stash', fields });
  if (v) act(`Stash ${what}`, 'stashSave', [v.msg.trim(), untracked || !!v.u, { staged, paths }]);
}

export { stashSave, stashesView, applyStash };
