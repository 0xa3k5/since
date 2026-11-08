import { h, icon, kbd, toast, dialog, confirm, contextMenu } from '../lib/ui.ts';
import { renderDiff, hunkKeys, statusBadge, fileRef } from './diff.ts';
import * as keymap from '../palette/keymap.ts';
import { conflictEditor } from './conflict-view.ts';
import { unifiedChanges } from './unified-view.ts';
import { up } from '../lib/upcalls.ts';
import { state, tip, api, baseName, MOD, isEditable } from '../lib/app-helpers.ts';
import { git, act, quiet, gitTooOld, gitWhy } from '../lib/bridge.ts';
import { refreshStatus } from '../graph/load.js';
import { identityOk } from './identity-check.js';
import { stashSave } from './stashes.ts';
import { aiOn, writeMessageWithAi } from './ai-message.ts';
import { openDifftool } from './external-tools.js';
import { openMergetool, openFileHistory } from '../history/file-history.js';
import { loadCommit, fileRow } from '../graph/map.js';
import { copy, changesText } from '../graph/commit-actions.js';

// Commit view (stage / unstage / partial lines / commit)

function draftKey() { return 'draft:' + state.repo.root; }

function createCommitView(container) {
  const el = h('div.commit-view');
  const side = h('div.cv-side');
  const lists = h('div.cv-lists');
  const diffPane = h('div.cv-diff');
  const textarea = h('textarea.composer-input', { placeholder: 'Commit message', spellcheck: true, rows: 4 });
  textarea.value = localStorage.getItem(draftKey()) || '';
  textarea.addEventListener('input', () => { try { localStorage.setItem(draftKey(), textarea.value); } catch { /* ignore */ } updateCommitBtn(); });
  textarea.addEventListener('keydown', (e) => { if (keymap.match('message', e) === 'message.commit') { e.preventDefault(); doCommit(); } });
  const amend = h('input', { type: 'checkbox', checked: state.amend, onchange: async (e) => {
    state.amend = e.target.checked;
    if (state.amend && !textarea.value.trim() && state.head.oid) { textarea.value = (await loadCommit(state.head.oid)).message; }
    updateCommitBtn();
  } });
  const commitBtn = h('button.btn.primary.wide', { onclick: () => doCommit() }, 'Commit', kbd(...keymap.keys('message.commit')));
  // Only shown once the user has turned AI commit messages on.
  const aiBtn = h('button.icon-btn.ai-btn', { title: tip('Write message with AI', 'repo.aiMessage'), hidden: !aiOn(), onclick: () => writeMessageWithAi() }, icon('sparkle', 15));
  // Show changes as one list (Preferences → Git, or ⌘K): the unified page takes the lists' and the diff pane's place.
  const summary = h('div.ucv-summary', { role: 'status' });
  const uv = state.show.unified ? unifiedChanges({
    git, lfsBadge: up.lfsBadge,
    stage: (f, sel, on, label) => act(label, on ? 'stageChanges' : 'unstageChanges', [fileRef(f), sel], { quiet: true }),
    discard: (f) => { const u = state.status.unstaged.find((x) => x.path === f.path); if (u) discard([u]); },
    openFile: (p) => api.app('open-file', p),
    onSummary: (t) => { summary.textContent = t; },
  }) : null;
  const composer = h('div.composer', null, uv ? summary : null, textarea, h('div.composer-row', null, h('label.check.small', null, amend, h('span', null, 'Amend last commit')), h('span.spacer'), aiBtn, commitBtn));
  // Split (Unstaged and Staged lists, one file's diff) or Unified (every change on one page); same switch as Preferences → Git.
  const layoutTip = tip('Switch between split and unified changes', 'cv.layout');
  const layout = h('div.cv-layout', null, h('div.setup-seg', { role: 'group', 'aria-label': 'Changes layout' }, [['split', 'Split', false], ['unified', 'Unified', true]].map(([id, label, on]) => h('button', {
    type: 'button', 'aria-pressed': String(!!state.show.unified === on), title: layoutTip, 'data-layout': id,
    onclick: () => { if (!!state.show.unified !== on) up.toggleShow('unified'); },
  }, label))));
  side.append(layout, lists, composer);
  el.append(side, up.paneHandle('commit', () => el), diffPane);
  container.append(el);

  function updateCommitBtn() {
    const can = textarea.value.trim() && (state.status.staged.length || state.amend) && !state.status.conflicts.length;
    commitBtn.disabled = !can;
    // Greyed for a reason the message can't fix: the label says it.
    const n = state.status.staged.length;
    commitBtn.firstChild.textContent = state.status.conflicts.length ? 'Resolve conflicts' : state.amend ? 'Amend' : n ? `Commit ${n} file${n > 1 ? 's' : ''}` : 'Nothing staged';
  }

  async function doCommit() {
    updateCommitBtn();
    if (commitBtn.disabled) { if (!textarea.value.trim()) textarea.focus(); return; }
    if (!(await identityOk())) return;
    const ok = await act(state.amend ? 'Amend commit' : 'Commit', 'createCommit', [textarea.value.trim() + '\n', state.amend], { success: state.amend ? 'Amended commit' : 'Committed' });
    if (ok) {
      textarea.value = '';
      try { localStorage.removeItem(draftKey()); } catch { /* ignore */ }
      state.amend = false; amend.checked = false;
      updateCommitBtn();
    }
  }

  // Drag files between Unstaged and Staged. A row in the selection carries the whole selection.
  let dragging = null;
  function dragStart(e, list, f) {
    if (list !== state.cv.list || !state.cv.sel.has(f.path)) selectFile(list, f.path);
    dragging = { from: list, paths: paths(targets(list, f)) };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging.paths.join('\n'));
    e.dataTransfer.setData(up.CV_DRAG_TYPE, '');
    // A status refresh can detach the source row mid-drag, so its own dragend never reaches us: clear at the window too.
    const done = () => { dragging = null; document.querySelectorAll('.cv-section.drop-target').forEach((s) => s.classList.remove('drop-target')); };
    window.addEventListener('dragend', done, { once: true });
    window.addEventListener('drop', done, { once: true });
    if (dragging.paths.length > 1) {
      const pill = h('div.drag-pill', null, `${dragging.paths.length} files`);
      document.body.append(pill);
      e.dataTransfer.setDragImage(pill, -8, -8);
      setTimeout(() => pill.remove());
    }
  }
  function dropZone(sec, list) {
    if (list === 'conflicts') return sec;
    // Only our own rows: a stale `dragging` must never turn a drag from Finder into a stage.
    const over = (e) => dragging && e.dataTransfer.types.includes(up.CV_DRAG_TYPE) && dragging.from !== list && dragging.from !== 'conflicts';
    sec.addEventListener('dragover', (e) => { if (!over(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; sec.classList.add('drop-target'); });
    sec.addEventListener('dragleave', (e) => { if (!sec.contains(e.relatedTarget)) sec.classList.remove('drop-target'); });
    sec.addEventListener('drop', (e) => {
      sec.classList.remove('drop-target');
      if (!over(e)) return;
      e.preventDefault();
      quiet(list === 'staged' ? 'stageFiles' : 'unstageFiles', dragging.paths);
      dragging = null;
    });
    return sec;
  }

  const section = (title, files, list, actions) => dropZone(h('div.cv-section', null,
    h('div.cv-section-head', null, h('span', null, title), h('span.sb-count', null, files.length), h('span.spacer'), actions),
    files.length ? h('div.file-list', null, files.map((f) => {
      const row = fileRow(f, (e) => clickFile(e, list, f.path), h('span.row-actions', null,
        list === 'unstaged' ? [
          h('button.icon-btn.tiny', { title: 'Discard changes', onclick: (e) => { e.stopPropagation(); discard(targets(list, f)); } }, icon('trash', 13)),
          h('button.icon-btn.tiny', { title: 'Stage', onclick: (e) => { e.stopPropagation(); quiet('stageFiles', paths(targets(list, f))); } }, icon('plus', 13)),
        ] : list === 'staged' ? [
          h('button.icon-btn.tiny', { title: 'Unstage', onclick: (e) => { e.stopPropagation(); quiet('unstageFiles', paths(targets(list, f))); } }, icon('minus', 13)),
        ] : [
          h('button.btn.ghost.tiny', { title: 'Use our version', onclick: (e) => { e.stopPropagation(); chooseSide(f.path, 'ours'); } }, 'Ours'),
          h('button.btn.ghost.tiny', { title: 'Use their version', onclick: (e) => { e.stopPropagation(); chooseSide(f.path, 'theirs'); } }, 'Theirs'),
          h('button.icon-btn.tiny', { title: 'Mark as resolved', onclick: (e) => { e.stopPropagation(); quiet('markResolved', f.path); } }, icon('check', 13)),
        ]));
      row.dataset.list = list; row.dataset.path = f.path;
      if (list !== 'conflicts') {
        row.draggable = true;
        row.addEventListener('dragstart', (e) => dragStart(e, list, f));
        row.addEventListener('dragend', () => { dragging = null; lists.querySelectorAll('.drop-target').forEach((s) => s.classList.remove('drop-target')); });
      }
      row.addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); });
      row.addEventListener('dblclick', (e) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) return;
        if (list === 'unstaged') quiet('stageFiles', [f.path]); else if (list === 'staged') quiet('unstageFiles', [f.path]);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (list !== state.cv.list || !state.cv.sel.has(f.path)) selectFile(list, f.path);
        const t = targets(list, f);
        if (t.length > 1) {
          const n = `${t.length} Files`;
          return contextMenu(e.clientX, e.clientY, [
            list === 'unstaged' ? { label: `Stage ${n}`, icon: 'plus', kbd: keymap.keys('cv.stage'), run: () => quiet('stageFiles', paths(t)) } : null,
            list === 'staged' ? { label: `Unstage ${n}`, icon: 'minus', kbd: keymap.keys('cv.stage'), run: () => quiet('unstageFiles', paths(t)) } : null,
            list === 'conflicts' ? { label: 'Open in Mergetool', icon: 'merge', kbd: keymap.keys('repo.mergetool'), run: () => openMergetool(paths(t)) } : null,
            { label: 'Copy Paths', icon: 'copy', run: () => copy(paths(t).join('\n'), 'Copied paths') },
            list !== 'conflicts' ? { label: `Stash ${n}…`, icon: 'stash', run: () => stashSave({ paths: t.flatMap((x) => (x.oldPath ? [x.path, x.oldPath] : [x.path])), untracked: t.some((x) => x.status === '?') }) } : null,
            list === 'unstaged' ? '-' : null,
            list === 'unstaged' ? { label: `Discard Changes to ${n}…`, icon: 'trash', danger: true, kbd: keymap.keys('cv.discard'), run: () => discard(t) } : null,
          ]);
        }
        contextMenu(e.clientX, e.clientY, [
          list === 'unstaged' ? { label: 'Stage', icon: 'plus', kbd: keymap.keys('cv.stage'), run: () => quiet('stageFiles', [f.path]) } : null,
          list === 'staged' ? { label: 'Unstage', icon: 'minus', kbd: keymap.keys('cv.stage'), run: () => quiet('unstageFiles', [f.path]) } : null,
          list === 'conflicts'
            ? { label: 'Open in Mergetool', icon: 'merge', kbd: keymap.keys('repo.mergetool'), run: () => openMergetool([f.path]) }
            : f.status !== '?' ? { label: 'Open in Difftool', icon: 'diff', kbd: keymap.keys('repo.difftool'), run: () => openDifftool({ file: f, args: [list === 'staged'] }) } : null,
          f.status !== '?' ? { label: 'File History & Blame', icon: 'history', kbd: keymap.keys('repo.fileHistory'), run: () => openFileHistory(f.path) } : null,
          { label: 'Open', icon: 'file', run: () => api.app('open-file', f.path) },
          { label: 'Reveal in Finder', icon: 'folder', run: () => api.app('reveal', f.path) },
          { label: 'Copy Path', icon: 'copy', run: () => copy(f.path, 'Copied path') },
          list !== 'conflicts' ? { label: 'Stash File…', icon: 'stash', run: () => stashSave({ paths: f.oldPath ? [f.path, f.oldPath] : [f.path], untracked: f.status === '?' }) } : null,
          list === 'unstaged' ? '-' : null,
          list === 'unstaged' ? { label: f.inside ? 'Discard Changes' : 'Discard Changes…', icon: 'trash', danger: true, kbd: keymap.keys('cv.discard'), run: () => discard([f]) } : null,
        ]);
      });
      return row;
    })) : h('div.cv-empty', null, list === 'staged' ? 'No staged changes' : 'Working tree clean'),
  ), list);

  function renderLists() {
    const { staged, unstaged, conflicts } = state.status;
    lists.replaceChildren(...[
      conflicts.length ? section('Conflicts', conflicts, 'conflicts', h('button.btn.ghost.tiny', { title: tip('Open in your mergetool', 'repo.mergetool'), onclick: () => openMergetool([]) }, 'Mergetool')) : null,
      section('Unstaged', unstaged, 'unstaged', unstaged.length ? [
        h('button.btn.ghost.tiny', { onclick: () => discard(unstaged) }, 'Discard all'),
        h('button.btn.ghost.tiny', { onclick: () => quiet('stageFiles', unstaged.map((f) => f.path)) }, 'Stage all'),
      ] : null),
      section('Staged', staged, 'staged', staged.length ? [
        h('button.btn.ghost.tiny' + (gitTooOld('stashStaged') ? '.gated' : ''), { title: gitWhy('stashStaged') || tip('Stash only the staged changes', 'repo.stashStaged'), onclick: () => stashSave({ staged: true }) }, 'Stash'),
        h('button.btn.ghost.tiny', { onclick: () => quiet('unstageFiles', staged.map((f) => f.path)) }, 'Unstage all'),
      ] : null),
    ].filter(Boolean));
    // Files that were staged, unstaged or discarded drop out of the selection.
    const left = new Set(paths(listFiles(state.cv.list)));
    state.cv.sel = new Set([...state.cv.sel].filter((p) => left.has(p)));
    markSelection();
    updateCommitBtn();
  }

  // Multi-select: `sel` holds the selected paths of `state.cv.list`; the diff pane shows `state.cv.path`.
  const listFiles = (list) => state.status[list] || [];
  const paths = (files) => files.map((f) => f.path);
  const selected = () => listFiles(state.cv.list).filter((f) => state.cv.sel.has(f.path));
  // A row action applies to the whole selection when the row is part of it, otherwise to that row only.
  const targets = (list, f) => (list === state.cv.list && state.cv.sel.size > 1 && state.cv.sel.has(f.path) ? selected() : [f]);

  function markSelection() {
    const many = state.cv.sel.size > 1;
    lists.classList.toggle('multi', many);
    lists.querySelectorAll('.file-row').forEach((r) => {
      const mine = r.dataset.list === state.cv.list;
      r.classList.toggle('active', mine && r.dataset.path === state.cv.path);
      r.classList.toggle('selected', many && mine && state.cv.sel.has(r.dataset.path));
    });
  }

  function selectFile(list, path, keep = false) {
    if (state.cv.list !== list || state.cv.path !== path) { state.cv.lines = new Set(); state.cv.full = false; }
    if (!keep) { state.cv.sel = new Set([path]); state.cv.anchor = path; }
    state.cv.list = list; state.cv.path = path;
    markSelection();
    renderDiffPane();
  }

  // Shift selects a range from the anchor, Cmd toggles one file. Both stay inside one list.
  function selectRange(list, path) {
    const all = paths(listFiles(list));
    const a = all.indexOf(state.cv.anchor), b = all.indexOf(path);
    if (list !== state.cv.list || a === -1 || b === -1) return selectFile(list, path);
    state.cv.sel = new Set(all.slice(Math.min(a, b), Math.max(a, b) + 1));
    selectFile(list, path, true);
  }
  function clickFile(e, list, path) {
    if (e.shiftKey) return selectRange(list, path);
    // ⌘ only: on macOS Ctrl-click opens the context menu.
    if (!e.metaKey || list !== state.cv.list) return selectFile(list, path);
    const sel = new Set(state.cv.sel);
    if (sel.has(path) && sel.size > 1) sel.delete(path); else sel.add(path);
    state.cv.sel = sel; state.cv.anchor = path;
    selectFile(list, sel.has(path) ? path : paths(listFiles(list)).find((p) => sel.has(p)), true);
  }
  function selectAll() {
    const all = paths(listFiles(state.cv.list));
    if (!all.length) return;
    state.cv.sel = new Set(all);
    selectFile(state.cv.list, all.includes(state.cv.path) ? state.cv.path : all[0], true);
  }

  async function discard(files) {
    // Restoring a submodule's recorded commit leaves the files inside it as they are.
    for (const f of files.filter((x) => x.inside)) await discardInSubmodule(f.path);
    files = files.filter((x) => !x.inside);
    if (!files.length) return;
    const what = files.length === 1 ? baseName(files[0].path) : `${files.length} files`;
    if (!(await confirm(`Discard changes to ${what}?`, `The changes are removed from your working tree. You can undo this with ${MOD}Z.`, { submit: 'Discard' }))) return;
    act(`Discard changes to ${what}`, 'discardFiles', [files.map(fileRef)]);
  }

  async function discardInSubmodule(p) {
    const ch = await git('submoduleChanges', p).catch(() => null);
    const n = ch?.count || 0;
    const name = baseName(p);
    // You asked to discard and it's undoable (AK-598): do it, name what went.
    const files = (ch?.files || []).map((f) => baseName(f.path));
    const which = files.length > 2 ? `${files.slice(0, 2).join(', ')} and ${files.length - 2} more` : files.join(' and ');
    await act(`Discard changes in ${p}`, 'submoduleWork', [p, 'discard'], {
      success: n ? `Discarded ${changesText(n)} in ${name}` : `Discarded changes in ${name}`,
      detail: which ? `${which} in ${p}.` : undefined,
    });
  }

  function chooseSide(p, side) {
    act(`Use ${side === 'ours' ? 'our' : 'their'} version of ${baseName(p)}`, 'chooseSide', [p, side]);
  }

  async function renderConflict(file, token) {
    const info = await git('conflict', file.path).catch((e) => { toast('Couldn’t read the conflict', { kind: 'error', detail: e.message }); return null; });
    if (token !== diffToken) return;
    if (!info) { up.conflictEd = null; diffPane.replaceChildren(); return; }
    // A status refresh with the file unchanged keeps the editor (and its scroll) as it is.
    const cur = up.conflictEd?.info;
    if (cur && cur.path === info.path && cur.kind === info.kind && cur.text === info.text && diffPane.contains(up.conflictEd.el)) return;
    up.conflictEd = conflictEditor(info, {
      mod: MOD,
      badge: h('span', null, statusBadge(file.status), file.lfs ? up.lfsBadge() : null),
      onResolve: (text) => act(`Resolve conflicts in ${baseName(file.path)}`, 'resolveConflict', [file.path, text]),
      onSide: (side) => chooseSide(file.path, side),
      onMergetool: () => openMergetool([file.path]),
    });
    diffPane.replaceChildren(up.conflictEd.el);
  }

  let diffToken = 0;
  let stageSelectedLines = null; // set while the diff pane has a stageable file
  async function renderDiffPane() {
    const { list, path } = state.cv;
    const file = (state.status[list] || []).find((f) => f.path === path);
    if (!file) {
      up.conflictEd = null;
      // After resolving a file, move on to the next conflicted one.
      if (list === 'conflicts' && state.status.conflicts[0]) return selectFile('conflicts', state.status.conflicts[0].path);
      stageSelectedLines = null;
      const any = state.status.unstaged[0] ? ['unstaged', state.status.unstaged[0]] : state.status.staged[0] ? ['staged', state.status.staged[0]] : state.status.conflicts[0] ? ['conflicts', state.status.conflicts[0]] : null;
      if (any) return selectFile(any[0], any[1].path);
      diffPane.replaceChildren(h('div.empty.big', null, icon('check', 28), h('div', null, 'Nothing to commit'), h('div.muted', null, 'Your working tree matches HEAD.')));
      return;
    }
    const token = ++diffToken;
    stageSelectedLines = null;
    if (list === 'conflicts') return renderConflict(file, token);
    up.conflictEd = null;
    const d = await git('workingDiff', fileRef(file), list === 'staged').catch((e) => { toast('Diff failed', { kind: 'error', detail: e.message }); return null; });
    if (token !== diffToken) return;
    state.cv.diff = d;
    // Drop selections that no longer exist.
    if (d) {
      const valid = new Set();
      d.hunks.forEach((hk, hi) => hk.lines.forEach((l, li) => { if (l.t !== ' ') valid.add(`${hi}:${li}`); }));
      for (const k of state.cv.lines) if (!valid.has(k)) state.cv.lines.delete(k);
    }
    const sel = state.cv.lines;
    const bar = h('div.sel-bar');
    const updateBar = () => {
      bar.replaceChildren();
      if (!sel.size || list === 'conflicts') return;
      bar.append(h('span.muted', null, `${sel.size} line${sel.size > 1 ? 's' : ''} selected`),
        list === 'unstaged' ? h('button.btn.ghost.small', { onclick: () => lineOp('discardLines') }, 'Discard') : null,
        list === 'unstaged' ? h('button.btn.ghost.small', { onclick: () => lineOp('stashLines') }, 'Stash') : null,
        h('button.btn.primary.small', { onclick: () => lineOp(list === 'unstaged' ? 'stageLines' : 'unstageLines') }, list === 'unstaged' ? 'Stage lines' : 'Unstage lines'),
        h('button.icon-btn.tiny', { title: 'Clear selection', onclick: () => { sel.clear(); renderDiffPane(); } }, icon('x', 13)),
      );
    };
    async function lineOp(method, keys = [...sel], hunk = false) {
      if (method === 'discardLines') {
        const what = hunk ? 'hunk' : `${keys.length} line${keys.length > 1 ? 's' : ''}`;
        if (!(await confirm(`Discard selected ${what}?`, `The changes are removed from your working tree. You can undo this with ${MOD}Z.`, { submit: 'Discard' }))) return;
        sel.clear();
        await act(`Discard ${what} in ${baseName(file.path)}`, 'discardLines', [fileRef(file), keys]);
        return;
      }
      if (method === 'stashLines') {
        const what = hunk ? 'hunk' : `${keys.length} line${keys.length > 1 ? 's' : ''}`;
        const v = await dialog({ title: `Stash selected ${what}`, submit: 'Stash', fields: [{ name: 'msg', label: 'Message', placeholder: 'WIP' }] });
        if (!v) return;
        sel.clear();
        await act(`Stash ${what} in ${baseName(file.path)}`, 'stashLines', [fileRef(file), keys, v.msg.trim()]);
        return;
      }
      try { await git(method, fileRef(file), keys); } catch (e) { toast('Could not apply partial change', { kind: 'error', detail: e.message }); }
      sel.clear();
      await refreshStatus();
    }
    stageSelectedLines = list === 'conflicts' ? null : () => lineOp(list === 'unstaged' ? 'stageLines' : 'unstageLines');
    const hunkActions = list === 'conflicts' ? null : (hi, hunk) => [
      list === 'unstaged' ? h('button.btn.ghost.tiny', { onclick: () => lineOp('discardLines', hunkKeys(hunk, hi), true) }, 'Discard hunk') : null,
      list === 'unstaged' ? h('button.btn.ghost.tiny', { onclick: () => lineOp('stashLines', hunkKeys(hunk, hi), true) }, 'Stash hunk') : null,
      h('button.btn.ghost.tiny', { onclick: () => lineOp(list === 'unstaged' ? 'stageLines' : 'unstageLines', hunkKeys(hunk, hi)) }, list === 'unstaged' ? 'Stage hunk' : 'Unstage hunk'),
    ];
    diffPane.replaceChildren(...[
      h('div.diff-head', null, statusBadge(file.status), h('span.mono', null, file.oldPath ? `${file.oldPath} → ${file.path}` : file.path), file.lfs ? up.lfsBadge() : null, h('span.spacer'), bar,
        list === 'conflicts' ? null : h('button.btn.subtle.small', { onclick: () => quiet(list === 'unstaged' ? 'stageFiles' : 'unstageFiles', [file.path]) }, list === 'unstaged' ? 'Stage file' : 'Unstage file'),
        h('button.icon-btn', { title: 'Open file', onclick: () => api.app('open-file', file.path) }, icon('external', 14)),
      ),
      h('div.diff-scroll', null, renderDiff(d, { selectable: list !== 'conflicts', selection: sel, onSelect: updateBar, hunkActions, full: state.cv.full, onShowAll: () => { state.cv.full = true; renderDiffPane(); } })),
    ].filter(Boolean));
    updateBar();
  }

  el.addEventListener('keydown', (e) => {
    if (e.target === textarea) return;
    if (uv) {
      if (e.target.tagName === 'TEXTAREA') return;
      const id = keymap.match('commit', e);
      // A focused tick box handles its own Enter.
      if (!id || (id === 'cv.stage' && e.target.tagName === 'BUTTON') || (id === 'cv.selectAll' && isEditable(e.target))) return;
      if (id === 'cv.message') { e.preventDefault(); textarea.focus(); return; }
      if (id === 'cv.layout') { e.preventDefault(); up.toggleShow('unified'); return; }
      if (uv.key(id)) e.preventDefault();
      return;
    }
    if (state.cv.list === 'conflicts' && up.conflictEd?.key(e)) return;
    if (e.target.tagName === 'TEXTAREA') return;
    const all = [...state.status.conflicts.map((f) => ['conflicts', f]), ...state.status.unstaged.map((f) => ['unstaged', f]), ...state.status.staged.map((f) => ['staged', f])];
    const i = all.findIndex(([l, f]) => l === state.cv.list && f.path === state.cv.path);
    const id = keymap.match('commit', e);
    const step = { 'cv.next': 1, 'cv.prev': -1, 'cv.extendNext': 1, 'cv.extendPrev': -1 }[id];
    if (id === 'cv.selectAll') {
      if (isEditable(e.target)) return;
      e.preventDefault(); selectAll();
    } else if (step) {
      e.preventDefault();
      const n = all[Math.max(0, Math.min(all.length - 1, i + step))];
      // Shift+arrows extend the selection, but never across into another list.
      if (n && (id === 'cv.extendNext' || id === 'cv.extendPrev')) { if (n[0] === state.cv.list) selectRange(n[0], n[1].path); } else if (n) selectFile(n[0], n[1].path);
      lists.querySelector('.file-row.active')?.scrollIntoView({ block: 'nearest' });
    } else if (id === 'cv.single' && state.cv.sel.size > 1) {
      e.preventDefault(); selectFile(state.cv.list, state.cv.path);
    } else if (id === 'cv.stage' && i !== -1) {
      e.preventDefault();
      // Selected lines in the diff take precedence over the file selection.
      if (state.cv.lines.size && stageSelectedLines) return stageSelectedLines();
      const [l, f] = all[i];
      if (l === 'unstaged') quiet('stageFiles', paths(targets(l, f))); else if (l === 'staged') quiet('unstageFiles', paths(targets(l, f)));
      else toast(`Can’t stage ${baseName(f.path)}`, { detail: 'Conflicted' });
    } else if (id === 'cv.discard' && i !== -1) {
      e.preventDefault();
      if (all[i][0] === 'unstaged') discard(targets('unstaged', all[i][1]));
      else toast(`Can’t discard ${baseName(all[i][1].path)}`, { detail: all[i][0] === 'staged' ? 'Staged' : 'Conflicted' });
    } else if (id === 'cv.message') {
      e.preventDefault(); textarea.focus();
    } else if (id === 'cv.layout') {
      e.preventDefault(); up.toggleShow('unified');
    }
  });
  el.tabIndex = 0;

  if (uv) {
    lists.append(uv.index);
    diffPane.append(uv.page);
  }
  const refresh = uv ? () => { uv.load(state.status); updateCommitBtn(); } : () => { renderLists(); renderDiffPane(); };
  refresh();
  setTimeout(() => el.focus({ preventScroll: true }));
  return {
    refresh,
    selectAll,
  };
}

export { createCommitView };
