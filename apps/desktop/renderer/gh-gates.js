// GitHub setup and merge gates (AK-588): what to offer when a PR action is refused, so the sheet
// fixes the cause and carries on instead of only saying no. Pure: app.js draws the sheets and runs
// the chosen fix. GitHub actions can't be undone, so nothing here goes through the journal.

// A merge refused by GitHub's hard gate → { reason, actions } for a resolve sheet, or null when
// there's nothing to fix from here (a closed PR, say). `local`: the PR's branch is a local branch.
export function mergeGateFix(info, { local = false } = {}) {
  if (!info?.gate?.hard || (info.state && info.state !== 'open')) return null;
  if (info.draft) return { reason: 'It’s a draft.', actions: [{ id: 'ready', label: 'Mark ready and merge' }] };
  if (info.conflicts) {
    return {
      reason: 'It has conflicts with its base branch.',
      actions: [{ id: 'rebase', label: local ? 'Rebase' : 'Check out and rebase' }],
    };
  }
  return null;
}

const METHOD_NAMES = { squash: 'squash merging', merge: 'merge commits', rebase: 'rebase merging' };
const METHOD_ACTIONS = { squash: 'Squash and merge', merge: 'Merge with a merge commit', rebase: 'Rebase and merge' };

// The method asked for is off in the repo's settings → say which ones are on and offer them.
// null when `wanted` is allowed.
export function methodFix(methods, wanted) {
  if (!methods?.length || methods.includes(wanted)) return null;
  const on = methods.map((m) => METHOD_NAMES[m]);
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  return {
    reason: `${cap(METHOD_NAMES[wanted])} is off in this repo’s settings; ${on.join(' and ')} ${on.length === 1 ? 'is' : 'are'} on.`,
    actions: methods.map((m) => ({ id: m, label: METHOD_ACTIONS[m] })),
  };
}

// A gh error with a fix one click away → { id, label } for the error toast's action, or null.
// gh-auth: logged out of this host; gh-no-remote: no GitHub remote; gh-no-stack: no gh-stack.
export function ghErrorFix(err) {
  if (err?.code === 'gh-auth') return { id: 'login', label: 'Open Terminal' };
  if (err?.code === 'gh-no-remote' || err?.code === 'no-remote') return { id: 'addRemote', label: 'Add remote…' };
  if (err?.code === 'gh-no-stack') return { id: 'installStack', label: 'Install' };
  return null;
}

// Merge and tidy on a branch with an open PR: the line under the "Merge" select for each choice.
export function mergeViaNote(via, number) {
  return via === 'github' ? { text: 'Can’t be undone on GitHub.', warn: true } : { text: `#${number} stays open on GitHub.` };
}
