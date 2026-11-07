// IPC channel names shared by the main process, the preload script and the renderer. The
// preload runs sandboxed and can't load local files, so it keeps a copy of PUSH;
// test/channels.test.js checks that the copy, every channel the main process uses and every
// call the renderer makes match these lists.

/** The invoke channel for git calls: method name, then its arguments. */
export const GIT = 'git';
/** Prefix of every app-level invoke channel (`app:open-file`, …). */
export const APP_PREFIX = 'app:';
/** Channels the main process pushes to the renderer. The preload lets only these through. */
export const PUSH = Object.freeze(['repo:changed', 'command', 'clone:progress', 'theme', 'update', 'keymap', 'cleanup:progress', 'tabs', 'git'] as const);
export type PushChannel = (typeof PUSH)[number];

/** Git methods the renderer may call on the GIT channel: the keys of `gitSchemas` in src/main/ipc.js. */
export const GIT_METHODS = Object.freeze([
  'abortAnd', 'abortOp', 'addRemote', 'addWorktree', 'autostashCheckout', 'baseTouches', 'blame',
  'branchReview', 'changeFacts', 'checkSplit', 'checkout', 'checkoutTracking', 'cherryPick',
  'chooseSide', 'cleanupLanes', 'combinedDiff', 'commit', 'commitBranches', 'commitDiffs',
  'commitFileDiff', 'compare', 'config', 'conflict', 'continueOp', 'createBranch', 'createCommit',
  'createTag', 'deleteBranch', 'deleteRemoteBranch', 'deleteRemoteBranches', 'deleteTag',
  'difftool', 'discardFiles', 'discardLines', 'divergence', 'fetch', 'fileHistory', 'freeCheckout',
  'history', 'identity', 'lfs', 'lockWorktree', 'log', 'logClose', 'logDetails', 'logOpen',
  'logRead', 'markResolved', 'merge', 'mergeConflicts', 'mergeLane', 'mergeLanePlan', 'mergetool',
  'moveCheckout', 'opInfo', 'previewRestore', 'pruneWorktrees', 'pull', 'pullAndPush', 'push',
  'pushTags', 'rebaseBranch', 'rebaseOnto', 'redo', 'reflog', 'refs', 'remotes', 'removalFacts',
  'removeRemote', 'removeWorktree', 'renameBranch', 'renameRemote', 'resetHard', 'resolveConflict',
  'restoreHistory', 'restoreResolved', 'revert', 'rewrite', 'setBranchTip', 'setConfig',
  'setRemoteUrl', 'stageChanges', 'stageFiles', 'stageLines', 'stashAnd', 'stashApply', 'stashDrop',
  'stashLines', 'stashSave', 'stashes', 'status', 'submoduleChanges', 'submoduleWork', 'submodules',
  'switchDelete', 'switchMerge', 'switchRewrite', 'tidyLane', 'trackedFiles', 'undo',
  'unlockWorktree', 'unsetConfig', 'unstageChanges', 'unstageFiles', 'unstageLines',
  'updateSubmodules', 'workingDiff', 'worktreeChanges', 'worktreeHold', 'worktreeOpInfo',
  'worktrees',
] as const);
export type GitMethod = (typeof GIT_METHODS)[number];

/** App-level invoke channels, without APP_PREFIX. The main process registers a handler for each and no other. */
export const APP_CHANNELS = Object.freeze([
  'ai-configure', 'ai-generate', 'ai-preview', 'ai-settings', 'catchup', 'catchup-mark',
  'check-updates', 'clone', 'close-repo', 'confirm', 'copy', 'cycle-theme', 'external', 'gh-login',
  'git-choose', 'git-info', 'git-use', 'handoff', 'init', 'init-here', 'install-update', 'keymap',
  'keymap-export', 'keymap-import', 'keymap-recording', 'lanes-forecast', 'lanes-list',
  'merge-method-save', 'merge-plan', 'merge-plan-merge', 'new-window', 'open', 'open-file',
  'open-submodule', 'open-window', 'pr-ai-draft', 'pr-approve', 'pr-chains', 'pr-checkout',
  'pr-close', 'pr-comment', 'pr-create', 'pr-create-info', 'pr-detect', 'pr-draft', 'pr-enable',
  'pr-evidence', 'pr-failed-log', 'pr-hide', 'pr-list', 'pr-media-image', 'pr-merge',
  'pr-merge-info', 'pr-merge-states', 'pr-ready', 'pr-remote', 'pr-request-changes',
  'pr-rerun-failed', 'pr-review-head', 'pr-stack-install', 'pr-stack-link', 'pr-state',
  'pr-update-branch', 'recent', 'remove-recent', 'repo', 'reveal', 'sendback-template-save',
  'sendback-templates', 'set-auto-update', 'set-keymap', 'set-theme', 'tab', 'tabs', 'take-handoff',
  'terminal', 'theme', 'update-state',
] as const);
export type AppChannel = (typeof APP_CHANNELS)[number];
