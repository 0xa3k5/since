// Features that need a newer git than some Macs have (AK-586): the version each needs, and whether a
// version meets it. Shared by git.js and the renderer, so the greyed items and git's errors agree.
export const GIT_NEEDS = { mergeHere: '2.38', mergePlan: '2.38', stashStaged: '2.35' };
export const GIT_FEATURES = { mergeHere: 'Merging here', mergePlan: 'Merge plan', stashStaged: 'Stash staged changes' };

// `version`: "2.39.5", or `git version` output. Unparsable counts as too old.
export function gitMeets(version, need) {
  const [a, b] = (/(\d+)\.(\d+)/.exec(String(version)) || [0, 0, 0]).slice(1).map(Number);
  const [x, y] = need.split('.').map(Number);
  return a > x || (a === x && b >= y);
}

// Merge here, once mergeLanePlan has run: null when nothing blocks it; a git too old for merge-tree
// gives the version toast (the action opens Choose git…); anything else is a plain error.
export function mergeHereBlock(plan, version) {
  if (!plan?.mergeBlocker) return null;
  if (plan.mergeBlockerCode === 'git-version') return { kind: 'git-version', message: `${GIT_FEATURES.mergeHere} needs git ${GIT_NEEDS.mergeHere} or later`, detail: version ? `In use: git ${version}` : null };
  return { kind: 'error', detail: plan.mergeBlocker };
}
