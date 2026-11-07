'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { GitError, run, tooOld } = require('./run');
const { canForecast } = require('./support');
const { getOperationState } = require('./status');
const { saveResolved } = require('./workcopy');
const { dirtyPaths } = require('./undo');
const { getWorktrees, checkRemovable, worktreeChanges, worktreeOp, opInProgress, removeWorktree } = require('./worktrees');
const { laneBase } = require('./lanes');

// Merge and tidy: land a lane's branch on its base as one squashed commit, then remove the
// lane's worktree and delete the branch. The squash is built with `merge-tree --write-tree` and
// `commit-tree`, so no worktree but the base's own (when this window has it checked out) is
// touched. The journal records all of it as one step (journal.runLane).

// What merging `branch` into `base` would do, without changing anything. `blocker` stops the
// whole action; `mergeBlocker` only stops merging here (a GitHub merge can still go ahead).
// commits: newest first, [{ subject, body }]; empty when the branch has nothing left to merge.
async function mergeLanePlan(cwd, branch, base, { abort = false } = {}) {
  if (String(branch).startsWith('-')) throw new GitError(`Unknown branch ${branch}`);
  const head = (await run(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`], { allowCodes: [0, 1] })).trim();
  if (!head) throw new GitError(`There is no branch ${branch}.`);
  const b = await laneBase(cwd, base);
  const into = b?.local || null;
  const baseSha = into ? (await run(cwd, ['rev-parse', '--verify', '-q', `refs/heads/${into}^{commit}`], { allowCodes: [0, 1] })).trim() : '';
  const worktrees = await getWorktrees(cwd);
  const wt = worktrees.find((w) => w.branch === branch) || (await rebasingIn(worktrees, branch));
  const baseWt = into ? worktrees.find((w) => w.branch === into) : null;
  // `keep`: the branch is checked out in this window ('current') or the main worktree ('main'), so
  // it is merged but kept, with its worktree. `baseWorktree`: the other worktree that has the base.
  const keep = wt?.current ? 'current' : wt?.main ? 'main' : null;
  const plan = { branch, head, base: into, baseSha: baseSha || null, commits: [], conflicts: [], worktree: wt && !keep ? { path: wt.path, name: wt.name } : null, keep, baseWorktree: null, blocker: null, blockerOp: null, mergeBlocker: null };
  if (wt && !keep) {
    // `abort`: an operation stopped in it is aborted when it is removed, after the merge.
    try { await checkRemovable(wt, { ignoreOp: abort }); } catch (err) { plan.blocker = err.message; plan.blockerOp = err.op || null; }
  }
  if (!into || !baseSha) plan.mergeBlocker = into ? `There is no local ${into} branch to merge into.` : 'There is no base branch (main or master) to merge into.';
  else if (into === branch) plan.blocker = `${branch} is the base branch.`;
  else if (baseWt && !baseWt.current) {
    plan.mergeBlocker = `${into} is checked out in ${baseWt.name}.`;
    plan.baseWorktree = { path: baseWt.path, name: baseWt.name };
  }
  if (plan.blocker || !baseSha) return plan;
  plan.commits = (await run(cwd, ['log', '--format=%s%x00%b%x1e', `${baseSha}..${head}`, '--'])).split('\x1e').map((r) => r.replace(/^\n+/, '')).filter(Boolean)
    .map((r) => { const i = r.indexOf('\0'); return { subject: r.slice(0, i).trim(), body: r.slice(i + 1).trim() }; });
  if (plan.commits.length) {
    // Gated on the git version before trying: a merge-tree failure on a new enough git is a real error.
    const old = !(await canForecast(cwd));
    if (old && !plan.mergeBlocker) { plan.mergeBlocker = tooOld('mergeHere').message; plan.mergeBlockerCode = 'git-version'; }
    const tree = old ? null : await squashTree(cwd, baseSha, head).catch((err) => { plan.mergeBlocker ||= err.message; return null; });
    if (tree?.conflicts.length) {
      plan.conflicts = tree.conflicts;
      plan.mergeBlocker ||= `It conflicts with ${into} in ${tree.conflicts.length} file${tree.conflicts.length > 1 ? 's' : ''}. Rebase it or merge ${into} into it first.`;
    }
  }
  return plan;
}

// The tree of `head` merged onto `baseSha`, or the conflicted paths. Needs git 2.38 (callers check).
async function squashTree(cwd, baseSha, head) {
  const out = await run(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', baseSha, head], { allowCodes: [0, 1] });
  // A clean merge prints only the tree; a conflicted one lists the conflicted paths after it.
  const [tree, ...rest] = out.split('\0');
  return { tree: tree.trim(), conflicts: [...new Set(rest.filter(Boolean))] };
}

// Why worktree `wt` (from getWorktrees) can't give up its branch (HEAD detached there, so the
// branch can be checked out elsewhere), or null: it must be on disk, clean, nothing in progress.
async function freeBlocker(wt) {
  if (wt.missing) return 'Its folder no longer exists.';
  const n = await worktreeChanges(wt.path);
  if (n) return `It has ${n} uncommitted change${n > 1 ? 's' : ''}.`;
  const op = await getOperationState((await run(wt.path, ['rev-parse', '--absolute-git-dir'])).trim());
  if (op) return `It has a ${op} in progress.`;
  return null;
}

// What removing worktree `wt` (from getWorktrees) has to deal with: its uncommitted changes
// (stashed by the removal) and a stopped operation there (aborted, after asking).
async function removalFacts(wt) {
  if (wt.missing) return { changes: 0, op: null };
  const op = await getOperationState((await run(wt.path, ['rev-parse', '--absolute-git-dir'])).trim());
  return { changes: await worktreeChanges(wt.path), op };
}

// What decides whether worktree `wt` can hand its branch and its uncommitted changes to another
// worktree (Journal.moveCheckout): `blocker` (folder gone, operation in progress), else how many
// changes it has and when the newest of them was written (ms, null when none is on disk).
async function worktreeHold(wt) {
  if (wt.missing) return { blocker: 'Its folder no longer exists.' };
  const op = await getOperationState((await run(wt.path, ['rev-parse', '--absolute-git-dir'])).trim());
  if (op) return { blocker: `It has a ${op} in progress.` };
  const paths = [...new Set(await dirtyPaths(wt.path))];
  let changedAt = null;
  for (const p of paths) {
    try { changedAt = Math.max(changedAt || 0, fs.lstatSync(path.join(wt.path, p)).mtimeMs); } catch {}
  }
  return { blocker: null, changes: paths.length, changedAt };
}

// The worktree stopped part-way through rebasing `branch` (git lists it as detached), or null.
async function rebasingIn(worktrees, branch) {
  for (const w of worktrees) {
    if (!w.detached || w.missing) continue;
    const dir = (await run(w.path, ['rev-parse', '--absolute-git-dir'])).trim();
    for (const d of ['rebase-merge', 'rebase-apply']) {
      try { if (fs.readFileSync(path.join(dir, d, 'head-name'), 'utf8').trim() === `refs/heads/${branch}`) return w; } catch {}
    }
  }
  return null;
}

// Squash `branch` onto `base` with `message` (skipped when `merge` is false, or when the branch
// has nothing left to merge), then remove its worktree and delete it, unless it is checked out
// here or in the main worktree (plan.keep): then it is kept. Everything is checked
// before anything changes. `done` reports what happened, for the journal, even on a failure
// part-way: { commit, worktree } (the removed worktree, as removeWorktree returns it). `abort`
// aborts an operation stopped here (base checked out) or in the lane's worktree.
async function mergeLane(cwd, { branch, base, message = '', merge = true, abort = false } = {}, done = {}) {
  const plan = await mergeLanePlan(cwd, branch, base, { abort });
  if (plan.blocker) throw new GitError(plan.blocker);
  let tree = null;
  if (merge && plan.commits.length) {
    if (plan.mergeBlocker) throw new GitError(plan.mergeBlocker);
    if (!String(message).trim()) throw new GitError('The commit message is empty.');
    tree = (await squashTree(cwd, plan.baseSha, plan.head)).tree;
    if (tree === (await run(cwd, ['rev-parse', `${plan.baseSha}^{tree}`])).trim()) tree = null; // already on base
  }
  if (tree) {
    const commit = (await run(cwd, ['commit-tree', tree, '-p', plan.baseSha, '-F', '-'], { input: message.trim() + '\n' })).trim();
    const here = (await run(cwd, ['symbolic-ref', '-q', 'HEAD'], { allowCodes: [0, 1] })).trim();
    // The base checked out here: move it with the working copy (local changes are kept, as undo does).
    if (here === `refs/heads/${plan.base}`) {
      const op = await worktreeOp(cwd);
      if (op && abort) {
        // Files already resolved are saved first (saveResolved), for Restore (journal.runLane).
        done.saved = await saveResolved(cwd, (await run(cwd, ['rev-parse', '--absolute-git-dir'])).trim()).catch(() => null);
        done.op = op;
        await run(cwd, [op, '--abort'], { env: { GIT_OPTIONAL_LOCKS: '1' } });
      }
      else if (op) throw opInProgress(`A ${op} is in progress.`, op);
      await run(cwd, ['reset', '--keep', commit], { env: { GIT_OPTIONAL_LOCKS: '1' } });
    } else {
      await run(cwd, ['update-ref', '-m', `since: merge ${branch}`, `refs/heads/${plan.base}`, commit, plan.baseSha]);
    }
    done.commit = commit;
  }
  if (plan.keep) return { commit: done.commit || null, base: plan.base, worktree: null, kept: plan.keep };
  if (plan.worktree) done.worktree = await removeWorktree(cwd, plan.worktree.path, abort ? { abort, changes: 'stash' } : {});
  await run(cwd, ['branch', '-D', '--', branch]);
  return { commit: done.commit || null, base: plan.base, worktree: plan.worktree, kept: null };
}

module.exports = { freeBlocker, worktreeHold, removalFacts, mergeLanePlan, mergeLane };
