'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { run, gitPath, BASE_ENV, GitError } = require('./run');
const { samePath, realpath, getWorktrees } = require('./worktrees');

// Repository discovery

// gitDir is this worktree's own admin dir; commonDir holds the refs and objects
// every worktree of the repository shares (the same dir for the main worktree).
async function openRepo(dir) {
  const out = await run(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']).catch((err) => {
    if (/not a git repository/i.test(err.stderr || '')) err.code = 'not-repo';
    throw err;
  });
  const [root, gitDir, commonDir] = out.trim().split('\n');
  return { root, gitDir, commonDir: path.resolve(commonDir), name: path.basename(root) };
}

// Repositories directly inside `dir` (one level down, main or linked worktrees), plus the other
// worktrees of each, for a folder that isn't a repository itself. Main worktrees come first.
async function findRepos(dir) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const found = [];
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
  const out = [];
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

async function initRepo(dir) {
  await run(dir, ['init']);
  return openRepo(dir);
}

function cloneRepo(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath(), ['clone', '--progress', '--', url, dest], { env: { ...BASE_ENV, GIT_ALLOW_PROTOCOL: 'file:git:http:https:ssh' } });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
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

module.exports = { openRepo, findRepos, initRepo, cloneRepo };
