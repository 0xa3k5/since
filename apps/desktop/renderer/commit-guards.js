// Why a map action can't run on a commit (AK-580). The commit menu greys an item when this returns a reason;
// its shortcut and ⌘K entry show the reason in a toast instead of running into git's raw error.
// Ids are keymap command ids, plus 'swapParent' (menu only). `c` is a graph commit ({ sha, parents }); `headOid`
// is HEAD's sha; `get` (optional) looks up a loaded graph commit by sha. null: the action can run.

const MERGE = { 'commit.squash': 'squashed', 'commit.fixup': 'fixed up', 'swapParent': 'swapped', 'commit.split': 'split', 'commit.drop': 'deleted' };
const ON_HEAD = { 'commit.diffHead': 'compared with itself', 'commit.merge': 'merged into itself', 'commit.rebase': 'rebased onto itself', 'commit.cherryPick': 'cherry-picked onto itself' };
const NEEDS_PARENT = new Set(['commit.squash', 'commit.fixup', 'swapParent']);
const REWRITE = new Set(['commit.edit', 'commit.split', 'commit.drop', ...NEEDS_PARENT]);

export function commitBlock(id, c, headOid, get = null) {
  const parents = c?.parents?.length ?? 0;
  if (ON_HEAD[id] && c?.sha === headOid) return `HEAD can’t be ${ON_HEAD[id]}`;
  if (MERGE[id] && parents > 1) return `Merge commits can’t be ${MERGE[id]}`;
  if (id === 'commit.edit' && parents > 1 && c?.sha !== headOid) return 'Merge commits can’t be reworded';
  if (NEEDS_PARENT.has(id) && parents === 0) return `The first commit can’t be ${MERGE[id]}`;
  if (REWRITE.has(id) && get && mergeInWay(c, headOid, NEEDS_PARENT.has(id), get)) return 'A merge commit is in the way';
  return null;
}

// Whether rewriting `c` on HEAD would replay a merge commit (git.rewriteRange refuses): a merge
// reachable from HEAD but not from where the rebase starts (`c`'s parent, or its grandparent when
// `grand`). false when `c` isn't on HEAD (that rewrite runs on another branch) or isn't loaded.
export function mergeInWay(c, headOid, grand, get) {
  const reach = (from, stop = null) => {
    const seen = new Set();
    const todo = from ? [from] : [];
    while (todo.length) {
      const sha = todo.pop();
      if (seen.has(sha) || stop?.has(sha)) continue;
      seen.add(sha);
      for (const p of get(sha)?.parents || []) todo.push(p);
    }
    return seen;
  };
  if (!c) return false;
  const onHead = reach(headOid);
  if (!onHead.has(c.sha)) return false;
  const base = grand ? get(c.parents?.[0])?.parents?.[0] : c.parents?.[0];
  const below = base ? reach(base) : new Set();
  for (const sha of reach(headOid, below)) if ((get(sha)?.parents?.length ?? 0) > 1) return true;
  return false;
}
