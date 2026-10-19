// How removing worktree `w` (from the worktrees read) goes (AK-581). Pure, so it can be unit-tested.
// Every plan ends with the worktree removed, or with one reason it can't be: never with "bring that
// window forward", which leaves the user where they started.
// `main`: the main worktree; `facts`: { changes, op } (git removalFacts), `draft`: an unsent commit
// message in the window showing it.
//   { kind: 'prune' }                         its folder is gone: prune missing worktrees
//   { kind: 'blocked', why }                  it can't be removed (main worktree, locked)
//   { kind: 'ask', why, then }                that window holds work undo can't bring back; `then` after "Close and remove"
//   { kind: 'remove', close, stash, abort }   remove it from this window; `close` its window first, `stash`
//                                             its changes, `abort` the stopped operation there
//   { kind: 'switch', dir, then }             this window shows it: switch to the main worktree, then `then`
//   { kind: 'handoff', dir, then }            this window shows it and the main worktree is open in another
//                                             window: that window runs `then` and closes this one
export function removalPlan(w, { main = null, facts = {}, draft = false } = {}) {
  if (w.missing) return { kind: 'prune' };
  if (w.main) return { kind: 'blocked', why: 'The main worktree can’t be removed' };
  if (w.locked) return { kind: 'blocked', why: `“${w.name}” is locked` };
  const remove = { kind: 'remove', close: !!(w.elsewhere || w.current), stash: !!facts.changes, abort: !!facts.op };
  let plan = remove;
  if (w.current) {
    if (!main || main.missing) return { kind: 'blocked', why: 'The main worktree is missing' };
    plan = { kind: main.elsewhere ? 'handoff' : 'switch', dir: main.path, then: { ...remove, close: main.elsewhere } };
  }
  const why = facts.op ? `“${w.name}” has a ${facts.op} in progress.` : draft && w.elsewhere ? `“${w.name}” has a commit message in progress.` : null;
  return why ? { kind: 'ask', why, then: plan } : plan;
}
