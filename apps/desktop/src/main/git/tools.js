'use strict';
const { run, GitError, EMPTY_TREE } = require('./run');
const { getStatus } = require('./status');

// External diff & merge tools (git difftool / mergetool), using the user's diff.tool and
// merge.tool. Since has no terminal, so terminal-only tools (vimdiff, emerge) are refused.

const TERMINAL_TOOLS = /^(n?vimdiff\d?|emerge)$/;

// git difftool falls back to merge.tool when diff.tool is unset; mergetool uses merge.tool only.
async function getExternalTools(cwd) {
  const get = async (key) => (await run(cwd, ['config', '--get', key], { allowCodes: [0, 1] })).trim() || null;
  const [diff, merge] = await Promise.all([get('diff.tool'), get('merge.tool')]);
  return { diff: diff || merge, merge };
}

function checkTool(name, kind) {
  const key = kind === 'diff' ? 'diff.tool' : 'merge.tool';
  if (!name) throw new GitError(`No ${kind} tool set. Set ${key} in your git config (e.g. git config --global ${key} opendiff), then try again.`);
  if (TERMINAL_TOOLS.test(name)) throw new GitError(`${name} runs in a terminal, so Since can't open it. Set ${key} to a graphical tool.`);
  return name;
}

// Arguments for one file: working tree vs index (default), index vs HEAD (staged), or a commit vs its parent.
function difftoolArgs(file, { staged, commit, parent } = {}) {
  const paths = file.oldPath && file.oldPath !== file.path ? [file.oldPath, file.path] : [file.path];
  const revs = commit ? [parent || EMPTY_TREE, commit] : staged ? ['--cached'] : [];
  return ['difftool', '--no-prompt', ...revs, '--', ...paths];
}

const mergetoolArgs = (paths = []) => ['mergetool', '--no-prompt', ...(paths.length ? ['--', ...paths] : [])];

async function difftool(cwd, file, opts) {
  checkTool((await getExternalTools(cwd)).diff, 'diff');
  await run(cwd, difftoolArgs(file, opts), { maxBuffer: 16 * 1024 * 1024 });
}

// Resolves when the tool exits. Returns the paths that are still conflicted afterwards.
async function mergetool(cwd, paths = []) {
  checkTool((await getExternalTools(cwd)).merge, 'merge');
  const before = (await getStatus(cwd)).conflicts.map((f) => f.path);
  if (!before.length) throw new GitError('There are no conflicted files to merge.');
  // Exit code 1 = the tool exited without resolving; the status below says what's left.
  await run(cwd, mergetoolArgs(paths), { allowCodes: [0, 1], maxBuffer: 16 * 1024 * 1024 });
  const after = (await getStatus(cwd)).conflicts.map((f) => f.path);
  return { remaining: paths.length ? after.filter((p) => paths.includes(p)) : after };
}

module.exports = { getExternalTools, checkTool, difftoolArgs, mergetoolArgs, difftool, mergetool };
