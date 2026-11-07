import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { run, gitPath, BASE_ENV, GitError } from './run.ts';
import { samePath, realpath, getWorktrees } from './worktrees.ts';
import type { FoundRepo, RepoInfo } from '../../shared/git-types.ts';

// Repository discovery

// gitDir is this worktree's own admin dir; commonDir holds the refs and objects
// every worktree of the repository shares (the same dir for the main worktree).
export async function openRepo(dir: string): Promise<RepoInfo> {
  const out = await run(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']).catch((err: GitError) => {
    if (/not a git repository/i.test(err.stderr || '')) err.code = 'not-repo';
    throw err;
  });
  const [root = '', gitDir = '', commonDir = ''] = out.trim().split('\n');
  return { root, gitDir, commonDir: path.resolve(commonDir), name: path.basename(root) };
}

// Repositories directly inside `dir` (one level down, main or linked worktrees), plus the other
// worktrees of each, for a folder that isn't a repository itself. Main worktrees come first.
export async function findRepos(dir: string): Promise<FoundRepo[]> {
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const found: RepoInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const child = path.join(dir, e.name);
    if (!fs.existsSync(path.join(child, '.git'))) continue;
    try {
      const repo = await openRepo(child);
      if (samePath(repo.root, child)) found.push(repo);
    } catch { /* not a repository after all */ }
  }
  const seen = new Set(found.map((r) => realpath(r.root)));
  const out: FoundRepo[] = [];
  for (const repo of found) {
    out.push({ root: repo.root, name: repo.name, commonDir: repo.commonDir, main: samePath(repo.gitDir, repo.commonDir) });
    for (const w of await getWorktrees(repo.root).catch(() => [])) {
      const key = realpath(w.path);
      if (seen.has(key) || w.missing) continue;
      seen.add(key);
      out.push({ root: w.path, name: w.name, commonDir: repo.commonDir, main: w.main });
    }
  }
  return [...out.filter((r) => r.main), ...out.filter((r) => !r.main)];
}

export async function initRepo(dir: string): Promise<RepoInfo> {
  await run(dir, ['init']);
  return openRepo(dir);
}

export function cloneRepo(url: string, dest: string, onProgress?: (line: string) => void): Promise<RepoInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath(), ['clone', '--progress', '--', url, dest], { env: { ...BASE_ENV, GIT_ALLOW_PROTOCOL: 'file:git:http:https:ssh' } });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      err += d;
      const line = d.split(/[\r\n]/).filter(Boolean).pop();
      if (line && onProgress) onProgress(line);
    });
    child.on('close', (code) => {
      if (code === 0) resolve(openRepo(dest));
      else reject(new GitError(err.trim().split('\n').slice(-4).join('\n') || 'Clone failed'));
    });
  });
}

