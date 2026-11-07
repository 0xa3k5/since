'use strict';
const { AGENT_HINTS } = require('../../renderer/lib/agents.js');
const { setGitPath, gitInfo, GitError, run, remoteFailure } = require('./run');
const { canForecast, mergeTreeSupported, _setForecastGate } = require('./support');
const { getStatus, getOperationState, getOperationInfo, workingDiff, buildPartialPatch, applyPatch } = require('./status');
const { parseLfsPointer, parseLfsPatterns, getLfs, markLfs } = require('./lfs');
const { combinedDiff, setStaged, changePaths } = require('./changes');
const { getRefs, getLog, parseCoAuthors, streamLog, getLogDetails, hasCommitGraph, writeCommitGraph, getCommit, commitFileDiff, commitDiffs, compareDiff } = require('./log');
const { openRepo, findRepos, initRepo, cloneRepo } = require('./repo');
const { getReflog, getConfig, getIdentity } = require('./config');
const { pull, divergence, getRemotes, remoteWebUrl, remoteLabel, changeRemote, revertRemote } = require('./remotes');
const { getStashes, dropStashCommit, restoreStash, stashPush, stashLines, stashApply, stashDrop } = require('./stash');
const { parseGitmodules, getSubmodules, updateSubmodules, stashSubmodule, popSubmoduleStash, discardSubmodule, submoduleChanges, submoduleHead, restoreSubmodules } = require('./submodules');
const { saveResolved, restoreResolved, resolvedPaths, discardFiles, discardLines, resetHard, chooseSide, getConflict, resolveConflict } = require('./workcopy');
const { captureRefState, restoreRefState, snapshotWork, workChanges, snapshotBlobs, restoreWork, resetHardPaths, stashPaths, stashPushPaths, pinUndo, pruneUndoPins, moveUndoPins, moveOldPins } = require('./undo');
const { cherryPick, rewriteRange, rewrite, commitBranches } = require('./rewrite');
const { worktreeOp, samePath, getWorktrees, findWorktree, worktreeChanges, addWorktree, removeWorktree, restoreWorktree, popStash, lockWorktree, unlockWorktree, pruneWorktrees, cleanupLanes, deleteRemoteBranches } = require('./worktrees');
const { freeBlocker, worktreeHold, removalFacts, mergeLanePlan, mergeLane } = require('./merge');
const { baseSquash, landed, branchReview, baseTouches, parseTrailers, agentGuess, branchKey, plainSubject, shortPath, laneBase, lanes, sharedLanes, prShipped, patchIds } = require('./lanes');
const { mergeConflicts, mergeConflictHunks, conflictHunks, simulateSquash, simulateRebase, forecastLanes, forecastConflicts, forecastCache } = require('./forecast');
const { getExternalTools, checkTool, difftoolArgs, mergetoolArgs, difftool, mergetool } = require('./tools');
const { fileHistory, parseFileHistory, trackedFiles, blame, parseBlame } = require('./history');

// The git layer, one module per area. Everything the app calls is exported from here.

module.exports = {
  saveResolved, restoreResolved, resolvedPaths,
  setGitPath, gitInfo,
  clearBaseSquashCache: () => baseSquash.clear(),
  landed,
  GitError, run, remoteFailure, pull, divergence, cherryPick, openRepo, findRepos, initRepo, cloneRepo, getRefs, getLog, parseCoAuthors, streamLog, getLogDetails, hasCommitGraph, writeCommitGraph, getCommit, commitFileDiff, commitDiffs, compareDiff, branchReview,
  getStatus, getOperationState, getOperationInfo, worktreeOp, workingDiff, parseLfsPointer, parseLfsPatterns, getLfs, markLfs, parseGitmodules, getSubmodules, updateSubmodules, stashSubmodule, popSubmoduleStash, discardSubmodule, submoduleChanges, submoduleHead, restoreSubmodules, buildPartialPatch, applyPatch,
  combinedDiff, setStaged, changePaths,
  getStashes, getReflog, getConfig, getIdentity, getRemotes, remoteWebUrl, remoteLabel, changeRemote, revertRemote, rewriteRange, rewrite, captureRefState, restoreRefState,
  snapshotWork, workChanges, snapshotBlobs, restoreWork, resetHardPaths, stashPaths, stashPushPaths,
  pinUndo, pruneUndoPins, moveUndoPins, moveOldPins, dropStashCommit, restoreStash,
  discardFiles, discardLines, stashPush, stashLines, resetHard, chooseSide, getConflict, resolveConflict, stashApply, stashDrop,
  rewriteRange, commitBranches, samePath, getWorktrees, findWorktree, worktreeChanges, freeBlocker, worktreeHold, removalFacts, baseTouches, addWorktree, removeWorktree, mergeLanePlan, mergeLane,
  restoreWorktree, popStash, lockWorktree, unlockWorktree, pruneWorktrees, cleanupLanes, deleteRemoteBranches,
  AGENT_HINTS, parseTrailers, agentGuess, branchKey, plainSubject, shortPath, laneBase, lanes, sharedLanes, prShipped, patchIds, canForecast, mergeConflicts, mergeConflictHunks, conflictHunks, simulateSquash, simulateRebase, forecastLanes, forecastConflicts,
  _forecastCache: forecastCache, mergeTreeSupported, _setForecastGate,
  getExternalTools, checkTool, difftoolArgs, mergetoolArgs, difftool, mergetool,
  fileHistory, parseFileHistory, trackedFiles, blame, parseBlame };
