import { toast } from '../lib/ui.ts';
import { fileRef } from './diff.ts';
import { up } from '../lib/upcalls.ts';
import { state } from '../lib/app-helpers.ts';
import { git } from '../lib/bridge.ts';
import type { CommitFile, StatusEntry } from '../../shared/git-types.ts';

/** The file Open in Difftool works on, and the difftool call's other arguments. */
interface DifftoolTarget { file: CommitFile | StatusEntry; args: unknown[]; conflict?: boolean }

// External diff & merge tools: git difftool / mergetool with the user's diff.tool / merge.tool.

// The file on screen: the open file of the commit viewer, else the file selected in Commit view.
function difftoolTarget(): DifftoolTarget | null {
  const q = state.quick;
  if (q) return q.file ? { file: q.file, args: [false, q.sha, q.parent] } : null;
  if (state.view !== 'commit') return null;
  const { list, path } = state.cv;
  const file = (state.status[list] || []).find((f) => f.path === path);
  return file ? { file, args: [list === 'staged'], conflict: list === 'conflicts' } : null;
}

async function openDifftool(target: DifftoolTarget | null = difftoolTarget()) {
  if (!state.repo) return;
  if (!target) return toast('Select a file first', { detail: 'Open in Difftool works on the file shown in Commit view or in a commit.' });
  if (target.conflict) return up.openMergetool([target.file.path]);
  if (target.file.status === '?') return toast('Untracked files have nothing to compare', { detail: target.file.path });
  try { await git('difftool', fileRef(target.file), ...target.args); } catch (e) { toast('Couldn’t open the difftool', { kind: 'error', detail: (e as Error).message }); }
}

export { openDifftool };
