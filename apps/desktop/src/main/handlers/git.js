'use strict';
// The `git` IPC channel: every git call from the renderer, with the undo journal around ref changes.
const path = require('node:path');
const git = require('../git');
const { workOps, worktreeOps, laneOps, remoteOps } = require('../journal');
const check = require('../ipc');
const channels = require('../../shared/channels.ts');
const { menuChanged } = require('../app-events');
const github = require('../github');
const changeFacts = require('../change-facts');
const { windowFor, sessions, session } = require('../session');
const { handle, serializeError } = require('./handle');

// ---------------------------------------------------------------------------
// Git API exposed to the renderer. Mutations that move refs or destroy
// uncommitted work are recorded in the journal, giving unlimited undo/redo.

async function detachedHeads(s) {
  return (await git.getWorktrees(s.repo.root).catch(() => [])).filter((w) => !w.current && w.detached && w.head).map((w) => w.head);
}

const reads = {
  refs: (s) => git.getRefs(s.repo.root),
  // Other worktrees' detached HEADs are on no branch; include them so the graph can show them.
  log: async (s, opts) => git.getLog(s.repo.root, { ...opts, heads: await detachedHeads(s) }),
  logOpen: async (s, opts) => s.logs.open({ ...opts, heads: await detachedHeads(s) }),
  logRead: (s, id) => s.logs.read(id),
  logClose: (s, id) => s.logs.close(id),
  logDetails: (s, shas) => git.getLogDetails(s.repo.root, shas),
  commit: (s, sha) => git.getCommit(s.repo.root, sha),
  commitFileDiff: (s, sha, file, parent) => git.commitFileDiff(s.repo.root, sha, file, parent),
  commitDiffs: (s, sha) => git.commitDiffs(s.repo.root, sha),
  // Whether a commit is on HEAD, and the local branches containing it (rewriting it there, AK-581).
  commitBranches: (s, sha) => git.commitBranches(s.repo.root, sha),
  // Throws the reason a commit can't be split on `tip` (merge, not on that branch, merges above it).
  checkSplit: (s, sha, tip) => git.rewriteRange(s.repo.root, 'split', sha, tip || 'HEAD').then(() => true),
  compare: (s, from, to) => git.compareDiff(s.repo.root, from, to),
  branchReview: (s, branch, base) => git.branchReview(s.repo.root, branch, base),
  // Plain facts about a branch's diff against base (change-facts.js): git only, cached per SHA pair.
  changeFacts: (s, base, head) => changeFacts.changeFacts(s.repo.root, base, head),
  // Review (AK-305): the files and hunks that conflict when `head` merges into `base` (merge-tree, read-only).
  mergeConflicts: (s, base, head) => git.mergeConflictHunks(s.repo.root, base, head),
  // Merge and tidy: the plan, with the squash commit message drafted from the branch's commits.
  mergeLanePlan: async (s, branch, base, opts) => {
    const plan = await git.mergeLanePlan(s.repo.root, branch, base, opts || {});
    const d = github.prDraft(plan.commits);
    return { ...plan, message: [d.title, d.body].filter(Boolean).join('\n\n') };
  },
  status: async (s) => git.markLfs(s.repo.root, await git.getStatus(s.repo.root)),
  lfs: (s) => git.getLfs(s.repo.root),
  submodules: (s) => git.getSubmodules(s.repo.root),
  submoduleChanges: (s, p) => git.submoduleChanges(s.repo.root, p),
  // Read-only: the tool gets temporary copies; for the working tree it may edit the real file.
  difftool: (s, file, staged, commit, parent) => git.difftool(s.repo.root, file, { staged, commit, parent }),
  opInfo: (s) => git.getOperationInfo(s.repo.root, s.repo.gitDir),
  divergence: (s, fetch) => git.divergence(s.repo.root, { fetch }),
  conflict: (s, p) => git.getConflict(s.repo.root, p),
  fileHistory: (s, p, page) => git.fileHistory(s.repo.root, page?.path || p, page),
  trackedFiles: (s) => git.trackedFiles(s.repo.root),
  blame: (s, p, rev) => git.blame(s.repo.root, p, rev),
  workingDiff: (s, file, staged) => git.workingDiff(s.repo.root, file, { staged }),
  combinedDiff: (s, file, hunks) => git.combinedDiff(s.repo.root, file, { hunks: hunks || undefined }),
  stashes: (s) => git.getStashes(s.repo.root),
  reflog: (s) => git.getReflog(s.repo.root),
  config: (s) => git.getConfig(s.repo.root),
  remotes: (s) => git.getRemotes(s.repo.root),
  identity: (s) => git.getIdentity(s.repo.root),
  history: (s, limit) => s.journal.list(limit),
  previewRestore: (s, id) => s.journal.previewRestore(id),
  // `elsewhere`: open in another window, which has to be brought forward to work on it.
  worktrees: async (s) => (await git.getWorktrees(s.repo.root)).map((w) => ({ ...w, elsewhere: ![undefined, s.win].includes(windowFor(w.path)) })),
  worktreeChanges: async (s, dir) => {
    const wt = await git.findWorktree(s.repo.root, dir);
    return wt.missing ? null : git.worktreeChanges(wt.path);
  },
  // Whether that worktree can hand its branch and changes to this one (see moveCheckout).
  worktreeHold: async (s, dir) => {
    const wt = await git.findWorktree(s.repo.root, dir);
    return ![undefined, s.win].includes(windowFor(wt.path)) ? { blocker: 'It’s open in another window.' } : git.worktreeHold(wt);
  },
  // What removing that worktree stashes ({ changes }) and would abort ({ op }).
  removalFacts: async (s, dir) => git.removalFacts(await git.findWorktree(s.repo.root, dir)),
  // The same, named (AK-584): what it's merging, picking or rebasing, and how far it got.
  worktreeOpInfo: async (s, dir) => {
    const wt = await git.findWorktree(s.repo.root, dir);
    if (wt.missing) return null;
    const info = await git.getOperationInfo(wt.path, (await git.run(wt.path, ['rev-parse', '--absolute-git-dir'])).trim());
    // Conflicted files go with the abort, so they aren't changes to stash (cleanup).
    if (info) info.conflicts = (await git.run(wt.path, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean).length;
    return info;
  },
  baseTouches: (s, head, base, files) => git.baseTouches(s.repo.root, head, base, files),
};

const W = { GIT_OPTIONAL_LOCKS: '1' };
const r = (s, args, opts = {}) => git.run(s.repo.root, args, { ...opts, env: { ...W, ...opts.env } });

// Mutations that can move refs (snapshotted for undo).
const refMutations = {
  checkout: (s, target) => r(s, ['checkout', target]),
  checkoutTracking: (s, remoteShort) => r(s, ['checkout', '--track', remoteShort]),
  createBranch: (s, name, at, checkout) => r(s, checkout ? ['checkout', '-b', name, at] : ['branch', name, at]),
  deleteBranch: (s, name) => r(s, ['branch', '-D', name]),
  renameBranch: (s, from, to) => r(s, ['branch', '-m', from, to]),
  setBranchTip: async (s, name, sha) => {
    const { head } = await git.getRefs(s.repo.root);
    if (head.branch === name) return r(s, ['reset', '--keep', sha]);
    return r(s, ['branch', '-f', name, sha]);
  },
  createTag: (s, name, at, message) => r(s, message ? ['tag', '-a', name, '-m', message, at] : ['tag', name, at]),
  deleteTag: (s, name) => r(s, ['tag', '-d', name]),
  cherryPick: (s, sha, keepEmpty) => git.cherryPick(s.repo.root, sha, keepEmpty),
  revert: (s, sha) => r(s, ['revert', '--no-edit', sha]),
  merge: (s, ref, ffOnly) => r(s, ['merge', '--no-edit', ...(ffOnly ? ['--ff-only'] : []), ref]),
  rebaseOnto: (s, sha) => r(s, ['rebase', '--autostash', sha]),
  // A lane's branch from Lanes: checks it out here, then rebases. No autostash: this window's changes stay put.
  rebaseBranch: (s, base, branch) => r(s, ['rebase', base, branch]),
  rewrite: (s, op, sha, extra) => git.rewrite(s.repo.root, op, sha, extra),
  createCommit: (s, message, amend) => r(s, ['commit', '-F', '-', ...(amend ? ['--amend'] : [])], { input: message }),
  pull: (s, mode) => git.pull(s.repo.root, mode),
  // Push rejected because the remote moved on: pull (one undo step), then push again.
  pullAndPush: async (s, mode) => { await git.pull(s.repo.root, mode); return plainMutations.push(s); },
  continueOp: async (s) => {
    const op = await git.getOperationState(s.repo.gitDir);
    if (!op) return;
    return r(s, ['-c', 'core.editor=true', op, '--continue'], { env: { GIT_EDITOR: 'true' } });
  },
  // Files already resolved are saved first (git.saveResolved), for Restore: returns { op, saved }.
  abortOp: async (s) => {
    const op = await git.getOperationState(s.repo.gitDir);
    if (!op) return;
    const saved = await git.saveResolved(s.repo.root, s.repo.gitDir).catch(() => null);
    await r(s, [op, '--abort']);
    return { op, saved };
  },
};

// Mutations that touch only the index, config or remotes, and lose no local work.
const plainMutations = {
  stageFiles: (s, paths) => r(s, ['add', '-A', '--', ...paths]),
  unstageFiles: async (s, paths) => {
    const hasHead = await r(s, ['rev-parse', '-q', '--verify', 'HEAD'], { allowCodes: [0, 1] });
    return hasHead.trim() ? r(s, ['reset', '-q', 'HEAD', '--', ...paths]) : r(s, ['rm', '--cached', '-q', '-r', '--', ...paths]);
  },
  stageLines: async (s, file, selected) => {
    const d = await git.workingDiff(s.repo.root, file, { staged: false });
    const p = d && git.buildPartialPatch(d, selected, 'stage');
    if (p) await git.applyPatch(s.repo.root, p, { cached: true });
  },
  unstageLines: async (s, file, selected) => {
    const d = await git.workingDiff(s.repo.root, file, { staged: true });
    const p = d && git.buildPartialPatch(d, selected, 'reverse');
    if (p) await git.applyPatch(s.repo.root, p, { cached: true, reverse: true });
  },
  fetch: (s) => r(s, ['fetch', '--all', '--prune', '--tags']),
  push: async (s, { force, all } = {}) => {
    if (all) return r(s, ['push', '--all', ...(force ? ['--force-with-lease'] : [])]);
    const { head, refs } = await git.getRefs(s.repo.root);
    if (!head.branch) throw new git.GitError('HEAD is detached. Check out a branch to push.');
    const b = refs.find((x) => x.kind === 'branch' && x.short === head.branch);
    const args = ['push', ...(force ? ['--force-with-lease'] : [])];
    if (!b || !b.upstream) {
      const remotes = await git.getRemotes(s.repo.root);
      if (!remotes.length) throw new git.GitError('This repository has no remotes.');
      const remote = remotes.find((x) => x.name === 'origin') ? 'origin' : remotes[0].name;
      args.push('-u', remote, head.branch);
    }
    return r(s, args);
  },
  pushTags: (s) => r(s, ['push', '--tags']),
  deleteRemoteBranch: (s, short) => {
    const i = short.indexOf('/');
    return r(s, ['push', short.slice(0, i), '--delete', '--', short.slice(i + 1)]);
  },
  setConfig: (s, key, value) => r(s, ['config', '--local', key, value]),
  unsetConfig: (s, key) => r(s, ['config', '--local', '--unset-all', key]),
  markResolved: (s, p) => r(s, ['add', '--', p]),
  mergetool: (s, paths) => git.mergetool(s.repo.root, paths),
  lockWorktree: (s, dir, reason) => git.lockWorktree(s.repo.root, dir, reason),
  unlockWorktree: (s, dir) => git.unlockWorktree(s.repo.root, dir),
  pruneWorktrees: (s) => git.pruneWorktrees(s.repo.root),
  // Not undoable: the renderer asks for an explicit confirmation that says so.
  deleteRemoteBranches: (s, shorts) => git.deleteRemoteBranches(s.repo.root, shorts),
};

// Lanes → Clean up: one journal step for the whole batch, with progress sent to the window.
async function cleanupLanes(s, items, label) {
  const list = await git.getWorktrees(s.repo.root);
  for (const i of items) {
    if (!i.worktree) continue;
    i.worktree = check.knownWorktree(list, i.worktree, git.samePath);
    if (![undefined, s.win].includes(windowFor(i.worktree))) throw new git.GitError(`${path.basename(i.worktree)} is open in another tab. Close that tab first.`);
  }
  const onProgress = (p) => { if (!s.win.isDestroyed()) s.win.webContents.send('cleanup:progress', p); };
  return s.journal.runCleanup(label || `Clean up ${items.length} branch${items.length === 1 ? '' : 'es'}`, items, { onProgress });
}
// Close another tab (it shows a worktree about to be removed), once it's not running a git step.
function closeWindow(win, name) {
  if (sessions.get(win.webContents.id)?.busy) throw new git.GitError(`“${name}” is busy in its tab. Try again when it’s done.`);
  return new Promise((resolve) => { win.once('closed', resolve); win.destroy(); });
}

// Calls whose push, pull or fetch failures get a fix offered (git.remoteFailure).
const REMOTE_CALLS = new Set(['push', 'pull', 'pullAndPush', 'fetch', 'pushTags', 'stashAnd', 'abortAnd']);

handle(channels.GIT, async (e, method, ...args) => {
  try {
    const { args: realArgs, label, worktreeArgs } = check.checkGit(method, args);
    const s = session(e);
    // Worktree folders must be worktrees of this repository (in its `git worktree list`).
    if (worktreeArgs.length) {
      const list = await git.getWorktrees(s.repo.root);
      for (const i of worktreeArgs) realArgs[i] = check.knownWorktree(list, realArgs[i], git.samePath);
    }
    if (reads[method]) return { ok: await reads[method](s, ...realArgs) };
    s.busy++;
    try {
      // Aborting isn't a step of its own: the stopped sequence it ends is dropped (Journal.abortOp).
      if (method === 'abortOp') return { ok: await s.journal.abortOp(() => refMutations.abortOp(s)) };
      if (refMutations[method]) return { ok: await s.journal.record(label || method, method, () => refMutations[method](s, ...realArgs)) };
      if (workOps[method]) return { ok: await s.journal.runWork(method, label || method, realArgs) };
      if (remoteOps[method]) return { ok: await s.journal.runRemote(method, label || method, realArgs) };
      if (method === 'stashAnd') {
        const [inner, innerArgs] = realArgs;
        return { ok: await s.journal.stashAnd(label || inner, inner, () => refMutations[inner](s, ...innerArgs)) };
      }
      if (method === 'abortAnd') {
        const [inner, innerArgs] = realArgs;
        return { ok: await s.journal.abortAnd(label || inner, inner, () => refMutations[inner](s, ...innerArgs)) };
      }
      if (method === 'restoreResolved') return { ok: await s.journal.restoreResolved(label || method, ...realArgs) };
      if (method === 'autostashCheckout') return { ok: await s.journal.autostash(label || method, ...realArgs) };
      if (method === 'switchDelete') return { ok: await s.journal.switchDelete(label || method, ...realArgs) };
      if (method === 'switchRewrite') {
        const [to, op, sha, extra, stash] = realArgs;
        return { ok: await s.journal.switchRewrite(label || method, to, { op, sha, extra }, stash) };
      }
      if (method === 'switchMerge') {
        const [to, branch, base, message, stash] = realArgs;
        return { ok: await s.journal.switchMerge(label || method, to, { branch, base, message }, stash) };
      }
      if (method === 'freeCheckout') {
        if (![undefined, s.win].includes(windowFor(realArgs[1]))) throw new git.GitError('That worktree is open in another tab. Close the tab first.');
        return { ok: await s.journal.freeCheckout(label || method, ...realArgs) };
      }
      if (method === 'moveCheckout') {
        if (![undefined, s.win].includes(windowFor(realArgs[1]))) throw new git.GitError('That worktree is open in another tab. Close the tab first.');
        return { ok: await s.journal.moveCheckout(label || method, ...realArgs) };
      }
      if (method === 'removeWorktree') {
        // Open in another window: close that window first when asked (`close`), else refuse.
        const [dir, { close, stash, abort } = {}] = realArgs;
        const other = windowFor(dir);
        if (![undefined, s.win].includes(other)) {
          if (!close) throw new git.GitError('That worktree is open in another tab. Close the tab first.');
          await closeWindow(other, path.basename(dir));
        }
        return { ok: await s.journal.runWorktree(method, label || method, [dir, { stash: !!stash, abort: !!abort }]) };
      }
      if (worktreeOps[method]) return { ok: await s.journal.runWorktree(method, label || method, realArgs) };
      if (laneOps.has(method)) {
        // Merge and tidy (git.mergeLane); tidyLane only removes the worktree and branch, after a GitHub merge.
        const [branch, base, message] = realArgs;
        const { close = false, abort = false } = (method === 'mergeLane' ? realArgs[3] : realArgs[1]) || {};
        const wt = (await git.getWorktrees(s.repo.root)).find((w) => w.branch === branch);
        const other = wt && windowFor(wt.path);
        if (![undefined, s.win].includes(other)) {
          if (!close) throw new git.GitError('That worktree is open in another tab. Close the tab first.');
          await closeWindow(other, wt.name);
        }
        const opts = method === 'mergeLane' ? { branch, base, message, abort } : { branch, merge: false, abort };
        return { ok: await s.journal.runLane(label || method, method, (done) => git.mergeLane(s.repo.root, opts, done)) };
      }
      if (method === 'cleanupLanes') return { ok: await cleanupLanes(s, realArgs[0], label) };
      if (method === 'submoduleWork') return { ok: await s.journal.runSubmoduleWork(label || 'Discard changes in submodule', ...realArgs) };
      if (method === 'updateSubmodules') return { ok: await s.journal.runSubmodules(label || 'Update submodules', ...realArgs) };
      if (plainMutations[method]) return { ok: await plainMutations[method](s, ...realArgs) };
      if (method === 'undo' || method === 'redo') return { ok: await s.journal.step(method, realArgs[0] || {}) };
      if (method === 'restoreHistory') return { ok: await s.journal.restore(...realArgs) };
    } finally {
      s.busy--;
      s.pending.refs = s.pending.workdir = true;
      s.schedule();
      menuChanged();
    }
    throw new Error(`Unknown method ${method}`);
  } catch (err) {
    if (REMOTE_CALLS.has(method) && err instanceof git.GitError) git.remoteFailure(err);
    return { error: serializeError(err) };
  }
});

module.exports = { r, plainMutations };
