import { GIT_NEEDS, gitMeets } from '../../renderer/lib/git-version.ts';
import { onGitPathChange, run } from './run.ts';

// What the git in use supports. Checked once per git path (see onGitPathChange in run.ts).

// git 2.38 added `merge-tree --write-tree`; older git gets no forecast at all.
export const mergeTreeSupported = (version: string): boolean => gitMeets(version, GIT_NEEDS.mergeHere);
let mergeTreeOk: Promise<boolean> | null = null;
onGitPathChange(() => { mergeTreeOk = null; });
export function canForecast(cwd: string): Promise<boolean> {
  mergeTreeOk ||= run(cwd, ['version']).then(mergeTreeSupported, () => false);
  return mergeTreeOk;
}
// Tests pin the merge-tree support check: true, false, or null to check again.
export const _setForecastGate = (ok: boolean | null | undefined): void => { mergeTreeOk = ok == null ? null : Promise.resolve(ok); };
