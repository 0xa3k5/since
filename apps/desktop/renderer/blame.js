// Pure helpers for the file history & blame view (no DOM), shared with the unit tests.

// Blame lines ready to draw: `first` marks the first line of a run from the same commit (only
// that line shows the commit), `age` buckets the commit date from 0 (oldest) to 4 (newest, or
// not committed yet) for the age bar.
export function blameRows({ commits, lines }) {
  let min = Infinity, max = -Infinity;
  for (const c of commits) if (!c.uncommitted) { min = Math.min(min, c.time); max = Math.max(max, c.time); }
  const age = commits.map((c) => (c.uncommitted || !(max > min) ? 4 : Math.round((4 * (c.time - min)) / (max - min))));
  return lines.map((l, i) => ({ ...l, first: i === 0 || lines[i - 1].commit !== l.commit, age: age[l.commit] }));
}

// The history list: the working-tree file first (its blame shows uncommitted lines), then
// every commit that touched the file.
export const WORKING_TREE = Object.freeze({ sha: null, subject: 'Working tree', status: null });
export function historyRows(path, entries) {
  return [{ ...WORKING_TREE, path }, ...entries];
}

// Name and folder of a repository path, for the header.
export function splitPath(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? [p, ''] : [p.slice(i + 1), p.slice(0, i)];
}
