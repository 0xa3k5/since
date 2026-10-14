// Submodule helpers. Pure logic, no DOM, so they can be unit-tested.

// Sidebar label and tooltip for each state from git.getSubmodules.
export const SUBMODULE_STATES = {
  clean: ['clean', 'Checked out at the commit this repository records.'],
  modified: ['modified', 'Has uncommitted changes or untracked files.'],
  outdated: ['out of date', 'Checked out at a different commit than the one this repository records. Update to check out the recorded one.'],
  uninitialized: ['not checked out', 'Not cloned or checked out yet. Update to initialise it.'],
  conflict: ['conflict', 'The recorded commit is in a merge conflict.'],
};

// The pointer change in a parsed submodule diff ("Subproject commit <sha>" lines), or null.
// { from, to } are commits (null when the submodule was added or removed); dirty: the
// submodule's work tree has changes too (only in working-tree diffs).
export function submoduleChange(diff) {
  if (!diff?.header?.some((l) => / 160000$/.test(l))) return null;
  let from = null, to = null, dirty = false;
  for (const hunk of diff.hunks || []) {
    for (const l of hunk.lines) {
      const m = /^Subproject commit ([0-9a-f]+)(-dirty)?$/.exec(l.s);
      if (!m) continue;
      if (l.t === '-') from = m[1];
      else if (l.t === '+') { to = m[1]; dirty = !!m[2]; }
      else { from = to = m[1]; dirty = dirty || !!m[2]; }
    }
  }
  return from || to ? { from, to, dirty } : null;
}

// One-line summary of a pointer change, e.g. "abc1234 → def5678".
export function describeSubmoduleChange({ from, to, dirty }) {
  const s = (x) => x.slice(0, 7);
  const move = !from ? `Added at ${s(to)}` : !to ? `Removed (was ${s(from)})` : from === to ? `Still at ${s(to)}` : `${s(from)} → ${s(to)}`;
  return dirty ? `${move} · has uncommitted changes` : move;
}
