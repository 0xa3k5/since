// Why a map action can't run on a commit (AK-580). The commit menu greys an item when this returns a reason;
// its shortcut and ⌘K entry show the reason in a toast instead of running into git's raw error.
// Ids are keymap command ids, plus 'swapParent' (menu only). `c` is a graph commit ({ sha, parents }); `headOid`
// is HEAD's sha. null: the action can run.

const MERGE = { 'commit.squash': 'squashed', 'commit.fixup': 'squashed', 'swapParent': 'swapped', 'commit.split': 'split', 'commit.drop': 'deleted' };
const ON_HEAD = { 'commit.diffHead': 'compared with itself', 'commit.merge': 'merged into itself', 'commit.rebase': 'rebased onto itself', 'commit.cherryPick': 'cherry-picked onto itself' };
const NEEDS_PARENT = new Set(['commit.squash', 'commit.fixup', 'swapParent']);

export function commitBlock(id, c, headOid) {
  const parents = c?.parents?.length ?? 0;
  if (ON_HEAD[id] && c?.sha === headOid) return `HEAD can't be ${ON_HEAD[id]}`;
  if (MERGE[id] && parents > 1) return `Merge commits can't be ${MERGE[id]}`;
  if (NEEDS_PARENT.has(id) && parents === 0) return `The first commit can't be ${MERGE[id]}`;
  return null;
}
