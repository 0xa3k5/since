'use strict';
const { GIT_NEEDS, gitMeets } = require('../../renderer/lib/git-version.js');
const { onGitPathChange, run } = require('./run');

// What the git in use supports. Checked once per git path (see onGitPathChange in run.js).


// git 2.38 added `merge-tree --write-tree`; older git gets no forecast at all.
const mergeTreeSupported = (version) => gitMeets(version, GIT_NEEDS.mergeHere);
let mergeTreeOk = null;
onGitPathChange(() => { mergeTreeOk = null; });
function canForecast(cwd) {
  mergeTreeOk ||= run(cwd, ['version']).then(mergeTreeSupported, () => false);
  return mergeTreeOk;
}
// Tests pin the merge-tree support check: true, false, or null to check again.
const _setForecastGate = (ok) => { mergeTreeOk = ok == null ? null : Promise.resolve(ok); };

module.exports = { canForecast, mergeTreeSupported, _setForecastGate };
