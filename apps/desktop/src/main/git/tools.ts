import { run, GitError, EMPTY_TREE } from './run.ts';
import { getStatus } from './status.ts';
import type { DiffTarget } from './status.ts';

// External diff & merge tools (git difftool / mergetool), using the user's diff.tool and
// merge.tool. Since has no terminal, so terminal-only tools (vimdiff, emerge) are refused.

const TERMINAL_TOOLS = /^(n?vimdiff\d?|emerge)$/;

// git difftool falls back to merge.tool when diff.tool is unset; mergetool uses merge.tool only.
export async function getExternalTools(cwd: string): Promise<{ diff: string | null; merge: string | null }> {
  const get = async (key: string) => (await run(cwd, ['config', '--get', key], { allowCodes: [0, 1] })).trim() || null;
  const [diff, merge] = await Promise.all([get('diff.tool'), get('merge.tool')]);
  return { diff: diff || merge, merge };
}

export function checkTool(name: string | null | undefined, kind: 'diff' | 'merge'): string {
  const key = kind === 'diff' ? 'diff.tool' : 'merge.tool';
  if (!name) throw new GitError(`No ${kind} tool set. Set ${key} in your git config (e.g. git config --global ${key} opendiff), then try again.`);
  if (TERMINAL_TOOLS.test(name)) throw new GitError(`${name} runs in a terminal, so Since can't open it. Set ${key} to a graphical tool.`);
  return name;
}

export interface DifftoolOptions { staged?: boolean; commit?: string | null; parent?: string | null }

// Arguments for one file: working tree vs index (default), index vs HEAD (staged), or a commit vs its parent.
export function difftoolArgs(file: DiffTarget, { staged, commit, parent }: DifftoolOptions = {}): string[] {
  const paths = file.oldPath && file.oldPath !== file.path ? [file.oldPath, file.path] : [file.path];
  const revs = commit ? [parent || EMPTY_TREE, commit] : staged ? ['--cached'] : [];
  return ['difftool', '--no-prompt', ...revs, '--', ...paths];
}

export const mergetoolArgs = (paths: readonly string[] = []): string[] => ['mergetool', '--no-prompt', ...(paths.length ? ['--', ...paths] : [])];

export async function difftool(cwd: string, file: DiffTarget, opts?: DifftoolOptions): Promise<void> {
  checkTool((await getExternalTools(cwd)).diff, 'diff');
  await run(cwd, difftoolArgs(file, opts), { maxBuffer: 16 * 1024 * 1024 });
}

// Resolves when the tool exits. Returns the paths that are still conflicted afterwards.
export async function mergetool(cwd: string, paths: readonly string[] = []): Promise<{ remaining: string[] }> {
  checkTool((await getExternalTools(cwd)).merge, 'merge');
  const before = (await getStatus(cwd)).conflicts.map((f) => f.path);
  if (!before.length) throw new GitError('There are no conflicted files to merge.');
  // Exit code 1 = the tool exited without resolving; the status below says what's left.
  await run(cwd, mergetoolArgs(paths), { allowCodes: [0, 1], maxBuffer: 16 * 1024 * 1024 });
  const after = (await getStatus(cwd)).conflicts.map((f) => f.path);
  return { remaining: paths.length ? after.filter((p) => paths.includes(p)) : after };
}
