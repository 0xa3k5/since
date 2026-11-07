// Copy for the resolve sheets that state the facts before the choice: the stopped operation
// (AK-584) and a diverged pull or rejected push (AK-585). Pure, so it's unit-tested.
import type { DivergedCommit, Divergence, Head, OperationInfo } from '../../shared/git-types.ts';
import type { SheetAction, SheetOptions } from '../lib/ui.ts';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const noDot = (s: string | null | undefined) => (s || '').replace(/\.+$/, '');

// "Merging feature/conflict into feature/merging is stopped on 1 conflict." `info`: git opInfo.
export function opSentence(info: OperationInfo | null | undefined, conflicts = 0): string {
  if (!info) return '';
  const tail = conflicts ? `is stopped on ${plural(conflicts, 'conflict')}.` : 'is stopped.';
  const pick = (verb: string, i: { sha: string; subject: string }) => `${verb} ${(i.sha || '').slice(0, 7)} ${noDot(i.subject)}`.replace(/\s+$/, '');
  if (info.op === 'merge') return `Merging ${info.from} into ${info.branch || 'HEAD'} ${tail}`;
  if (info.op !== 'rebase') return `${pick(info.op === 'revert' ? 'Reverting' : 'Cherry-picking', info)} ${tail}`;
  const what = `Rebasing ${info.branch || 'HEAD'}${info.onto ? ` onto ${info.onto}` : ''}`;
  if (!info.step || !info.total) return `${what} ${tail}`;
  return `${what} is stopped at ${info.step} of ${info.total}${info.subject ? `: ${noDot(info.subject)}` : ''}.`;
}

const LIST_ROWS = 5;
const SHOWN_FILES = 3;

// The resolve sheet for a diverged pull (`push` false) or a rejected push: what moved where, whether a
// merge would conflict, and buttons that say what you end up with. `d`: git divergence; `age`: a time
// formatter. Rebase is primary unless some local commits are on a remote already.
export type DivergeSheet = Required<Pick<SheetOptions, 'reason' | 'lists' | 'forecast'>> & { actions: SheetAction[] };
export function divergeSheet(d: Divergence, { push = false, age = String }: { push?: boolean; age?: (t: number) => string } = {}): DivergeSheet {
  const remote = d.upstream.split('/')[0];
  const list = (title: string, commits: DivergedCommit[], count: number) => ({
    title: `${title} · ${count}`,
    rows: commits.slice(0, LIST_ROWS).map((c) => [c.sha.slice(0, 7), c.subject, c.author, age(c.date)] as const),
    more: Math.max(0, count - Math.min(commits.length, LIST_ROWS)),
  });
  const files = d.conflicts || [];
  const forecast = d.conflicts == null ? null
    : !files.length ? { ok: true, text: 'No conflicts expected' }
    : { ok: false, text: `Conflicts likely in ${files.slice(0, SHOWN_FILES).join(', ')}${files.length > SHOWN_FILES ? ` and ${files.length - SHOWN_FILES} more` : ''}` };
  const n = d.oursCount;
  const rebase: SheetAction = { id: 'rebase', label: push ? 'Rebase and push' : 'Rebase' };
  const merge: SheetAction = { id: 'merge', label: push ? 'Merge and push' : 'Merge' };
  const force: SheetAction | null = push ? { id: 'force', label: 'Force push', danger: true, primary: false } : null;
  return {
    reason: `${d.branch} and ${d.upstream} have both moved.`,
    lists: [list(`On ${remote}`, d.theirs, d.theirsCount), list('Only here', d.ours, n)].filter((l) => !l.title.endsWith(' · 0')),
    forecast,
    actions: [...(d.shared ? [merge, rebase] : [rebase, merge]), force].filter((a): a is SheetAction => Boolean(a)),
  };
}

// "Rebase and push" / "Merge and push" that stopped on conflicts: what to remember so continuing the
// operation to the end can offer the push. `method`/`args`: the act() call (pullAndPush, or it wrapped
// in stashAnd/abortAnd); `upstream`: "origin/feature/api". null when the call isn't a pull and push.
export interface PushIntent { branch: string; remote: string | null; mode: 'merge' | 'rebase' }
export function pushIntent(method: string, args: readonly unknown[], branch: string | null, upstream: string | null | undefined): PushIntent | null {
  const wrapped = method === 'stashAnd' || method === 'abortAnd';
  const m = wrapped ? args[0] : method;
  const a: readonly unknown[] = wrapped ? (Array.isArray(args[1]) ? args[1] : []) : args;
  if (m !== 'pullAndPush' || !branch) return null;
  return { branch, remote: upstream ? upstream.split('/')[0] ?? null : null, mode: a[0] === 'merge' ? 'merge' : 'rebase' };
}

// The toast once the stopped operation is continued to the end: "Rebased feature/api" with
// [Push now] [Undo]. null while it's still stopped or when another branch is checked out.
export function pushAfterContinue(intent: PushIntent | null, { opState, branch }: { opState?: string | null; branch?: string | null } = {}): { message: string; push: string } | null {
  if (!intent || opState || branch !== intent.branch) return null;
  return { message: `${intent.mode === 'merge' ? 'Merged' : 'Rebased'} ${intent.branch}`, push: 'Push now' };
}

// ⌘Z / ⇧⌘Z while an operation is stopped: git can't move refs under it, so a toast names the stopped
// operation and offers its conflicts (or continuing it, when none are left), or aborting it (can't be undone, so that one confirms) and then
// taking the step. `dir`: 'undo' | 'redo'; `op`: state.opState; `info`/`conflicts`: as for opSentence.
export interface StoppedStepToast { message: string; detail: string | null; actions: { id: 'open' | 'continue' | 'abort'; label: string }[] }
export function stoppedStepToast(dir: 'undo' | 'redo', op: string, info: OperationInfo | null | undefined, conflicts = 0): StoppedStepToast {
  const name = ({ 'cherry-pick': 'cherry-pick', merge: 'merge', revert: 'revert' } as Record<string, string>)[op] || 'rebase';
  return {
    message: `Can't ${dir} while this ${name} is stopped`,
    detail: opSentence(info, conflicts) || null,
    actions: [conflicts ? { id: 'open', label: 'Open conflicts' } : { id: 'continue', label: `Continue ${name}` }, { id: 'abort', label: `Abort and ${dir}…` }],
  };
}

// The branch a stopped operation is on: HEAD's, else (detached mid-rebase) the one being rebased.
export const stoppedBranch = (head: Head | null | undefined, info: OperationInfo | null | undefined): string | null => head?.branch || info?.branch || null;

// Methods that switch this worktree's branch (AK-577). With an operation stopped here they get its
// toast (continue, or abort and then switch), never git's "resolve your current index first".
export const SWITCHES = new Set<string>(['checkout', 'checkoutTracking', 'autostashCheckout', 'freeCheckout', 'moveCheckout', 'switchDelete', 'switchRewrite', 'switchMerge']);
