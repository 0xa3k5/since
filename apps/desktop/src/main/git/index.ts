// The git layer, one module per area. Everything the app calls is exported from here.

import { baseSquash } from './lanes.ts';
import { forecastCache } from './forecast.ts';

export { saveResolved, restoreResolved, resolvedPaths, discardFiles, discardLines, resetHard, chooseSide, getConflict, resolveConflict } from './workcopy.ts';
export { setGitPath, gitInfo, GitError, run, remoteFailure } from './run.ts';
export { landed, branchReview, baseTouches, parseTrailers, agentGuess, branchKey, plainSubject, shortPath, laneBase, lanes, sharedLanes, prShipped, patchIds } from './lanes.ts';
export { pull, divergence, getRemotes, remoteWebUrl, remoteLabel, changeRemote, revertRemote } from './remotes.ts';
export { cherryPick, rewriteRange, rewrite, commitBranches } from './rewrite.ts';
export { openRepo, findRepos, initRepo, cloneRepo } from './repo.ts';
export { getRefs, getLog, parseCoAuthors, streamLog, getLogDetails, hasCommitGraph, writeCommitGraph, getCommit, commitFileDiff, commitDiffs, compareDiff } from './log.ts';
export { getStatus, getOperationState, getOperationInfo, workingDiff, buildPartialPatch, applyPatch } from './status.ts';
export { worktreeOp, samePath, getWorktrees, findWorktree, worktreeChanges, addWorktree, removeWorktree, restoreWorktree, popStash, lockWorktree, unlockWorktree, pruneWorktrees, cleanupLanes, deleteRemoteBranches } from './worktrees.ts';
export { parseLfsPointer, parseLfsPatterns, getLfs, markLfs } from './lfs.ts';
export { parseGitmodules, getSubmodules, updateSubmodules, stashSubmodule, popSubmoduleStash, discardSubmodule, submoduleChanges, submoduleHead, restoreSubmodules } from './submodules.ts';
export { combinedDiff, setStaged, changePaths } from './changes.ts';
export { getStashes, dropStashCommit, restoreStash, stashPush, stashLines, stashApply, stashDrop } from './stash.ts';
export { getReflog, getConfig, getIdentity } from './config.ts';
export { captureRefState, restoreRefState, snapshotWork, workChanges, snapshotBlobs, restoreWork, resetHardPaths, stashPaths, stashPushPaths, pinUndo, pruneUndoPins, moveUndoPins, moveOldPins } from './undo.ts';
export { freeBlocker, worktreeHold, removalFacts, mergeLanePlan, mergeLane } from './merge.ts';
export { AGENT_HINTS } from '../../renderer/lib/agents.js';
export { canForecast, mergeTreeSupported, _setForecastGate } from './support.ts';
export { mergeConflicts, mergeConflictHunks, conflictHunks, simulateSquash, simulateRebase, forecastLanes, forecastConflicts } from './forecast.ts';
export { getExternalTools, checkTool, difftoolArgs, mergetoolArgs, difftool, mergetool } from './tools.ts';
export { fileHistory, parseFileHistory, trackedFiles, blame, parseBlame } from './history.ts';

export const clearBaseSquashCache = (): void => baseSquash.clear();
export { forecastCache as _forecastCache };
