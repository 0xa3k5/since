import { toast } from '../lib/ui.ts';
import { fileRef } from './diff.js';
import { up } from '../lib/upcalls.ts';
import { state } from '../lib/app-helpers.js';
import { git } from '../lib/bridge.js';

// External diff & merge tools: git difftool / mergetool with the user's diff.tool / merge.tool.

// The file on screen: the open file of the commit viewer, else the file selected in Commit view.
function difftoolTarget() {
  if (state.quick) return state.quick.file ? { file: state.quick.file, args: [false, state.quick.sha, state.quick.parent] } : null;
  if (state.view !== 'commit') return null;
  const { list, path } = state.cv;
  const file = (state.status[list] || []).find((f) => f.path === path);
  return file && { file, args: [list === 'staged'], conflict: list === 'conflicts' };
}

async function openDifftool(target = difftoolTarget()) {
  if (!state.repo) return;
  if (!target) return toast('Select a file first', { detail: 'Open in Difftool works on the file shown in Commit view or in a commit.' });
  if (target.conflict) return up.openMergetool([target.file.path]);
  if (target.file.status === '?') return toast('Untracked files have nothing to compare', { detail: target.file.path });
  try { await git('difftool', fileRef(target.file), ...target.args); } catch (e) { toast('Couldn’t open the difftool', { kind: 'error', detail: e.message }); }
}

export { openDifftool };
