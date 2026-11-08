import { $, toast, contextMenu, palette } from '../lib/ui.ts';
import * as keymap from '../palette/keymap.ts';
import { up } from '../lib/upcalls.ts';
import { state } from '../lib/app-helpers.ts';
import { commitView } from '../shell/shell.ts';
import { git } from '../lib/bridge.ts';
import { refreshStatus } from '../graph/load.js';

// File history & blame

// The file on screen (commit viewer, Commit view or the open file history), if any.
function fileHistoryTarget(): string | null {
  if (state.fileHistory) return state.fileHistory.path;
  if (state.quick) return state.quick.file?.path || null;
  if (state.view === 'commit' && state.cv.list !== 'conflicts') return (state.status[state.cv.list] || []).find((f) => f.path === state.cv.path && f.status !== '?')?.path || null;
  return null;
}

// Opens the history of `path`, of the file on screen, or of a file picked from the tracked files.
function openFileHistory(...args: Parameters<typeof openFileHistoryNow>) { return up.go(() => openFileHistoryNow(...args)); }
async function openFileHistoryNow(path: string | null = fileHistoryTarget()): Promise<unknown> {
  if (!state.repo) return;
  if (!path) {
    const files = await git('trackedFiles').catch((e) => { toast('Couldn’t list files', { kind: 'error', detail: e.message }); return null; });
    if (!files?.length) return files && toast('No tracked files yet');
    while ($('.palette-overlay')) await new Promise((r) => setTimeout(r, 30)); // ⌘K is still closing
    return palette(() => files.map((p) => ({ label: p, icon: 'file', run: () => openFileHistory(p) })), { placeholder: 'File history & blame: pick a file…' });
  }
  state.quick = null;
  state.split = null;
  state.review = null;
  state.fileHistory = { path };
  up.renderTopbar();
  up.renderView();
}
function closeFileHistory() { return up.go(() => closeFileHistoryNow()); }
function closeFileHistoryNow() {
  state.fileHistory = null;
  state.review = null;
  up.renderTopbar();
  up.renderView();
}
// Shows a commit in the Map, or in the commit viewer when the graph doesn't have it (yet).
function showCommit(sha: string) {
  up.go(() => {
    up.setView('map');
    if (state.index.has(sha)) up.selectCommit(sha, 'center'); else up.openQuick(sha);
  });
}
function withHistoryMenu<E extends HTMLElement>(row: E, f: { path: string; status: string }): E {
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      f.status !== 'D' ? { label: 'File History & Blame', icon: 'history', kbd: keymap.keys('repo.fileHistory'), run: () => openFileHistory(f.path) } : null,
      { label: 'Copy Path', icon: 'copy', run: () => up.copy(f.path, 'Copied path') },
    ]);
  });
  return row;
}

// Opens the first conflicted file (or the selected one) in the built-in conflict editor.
function openConflicts() {
  if (!state.repo) return;
  const files = state.status.conflicts;
  if (!files.length) return toast('No conflicted files');
  const path = state.cv.list === 'conflicts' && files.some((f) => f.path === state.cv.path) ? state.cv.path : files[0]!.path;
  state.cv = { ...state.cv, list: 'conflicts', path, lines: new Set<string>(), full: false };
  if (state.view === 'commit') (commitView as { refresh(): void } | null)?.refresh(); else // commitView gets its type with commit-view (SNC-696)
   up.setView('commit');
}

// Waits for the tool to exit, then refreshes the conflict list.
let mergetoolOpen = false;
async function openMergetool(paths?: string[] | null) {
  if (!state.repo) return;
  if (!state.status.conflicts.length) return toast('No conflicted files');
  if (mergetoolOpen) return toast('Your mergetool is already open');
  // No paths given: the selected conflict, or every conflict.
  paths ??= state.view === 'commit' && state.cv.list === 'conflicts' && state.cv.path ? [state.cv.path] : [];
  mergetoolOpen = true;
  try {
    const { remaining } = await git('mergetool', paths);
    toast(remaining.length ? `${remaining.length} conflicted file${remaining.length === 1 ? '' : 's'} left` : 'Conflicts resolved', { detail: remaining.slice(0, 3).join('\n') || null });
  } catch (e) {
    toast('Mergetool failed', { kind: 'error', detail: (e as Error).message });
  } finally {
    mergetoolOpen = false;
    await refreshStatus();
  }
}
let gPending: string | null = null;

// Other modules assign these through setters: an imported binding can't be assigned.
function setGPending(value: string | null) { return (gPending = value); }

// Lower modules call these through `up` (lib/upcalls.js).
Object.assign(up, { openConflicts, openMergetool });

export { showCommit, closeFileHistory, withHistoryMenu, openFileHistory, openMergetool, fileHistoryTarget, openConflicts, gPending, setGPending };
