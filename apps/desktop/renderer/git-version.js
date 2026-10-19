// Features that need a newer git than some Macs have (AK-586): the version each needs, and whether a
// version meets it. Shared by git.js and the renderer, so the greyed items and git's errors agree.
export const GIT_NEEDS = { mergeHere: '2.38', mergePlan: '2.38', stackRebase: '2.40', stashStaged: '2.35' };
export const GIT_FEATURES = { mergeHere: 'Merging here', mergePlan: 'Merge plan', stackRebase: 'Rebasing a stack', stashStaged: 'Stash staged changes' };

// `version`: "2.39.5", or `git version` output. Unparsable counts as too old.
export function gitMeets(version, need) {
  const [a, b] = (/(\d+)\.(\d+)/.exec(String(version)) || [0, 0, 0]).slice(1).map(Number);
  const [x, y] = need.split('.').map(Number);
  return a > x || (a === x && b >= y);
}
