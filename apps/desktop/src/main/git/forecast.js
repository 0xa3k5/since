'use strict';
const { gitMeets } = require('../../renderer/lib/git-version.js');
const { run, mapLimit, onGitPathChange } = require('./run');
const { canForecast } = require('./support');

// Conflict forecast: which lanes would conflict, and on which files, before anyone merges. One
// `git merge-tree --write-tree` per pair (each active lane against base, then pairs of active
// lanes, newest first). merge-tree writes only objects, never refs, the index or a worktree.
// Results are cached by the two tips, so a refresh only re-runs pairs where a tip moved.

// Lanes untouched for longer than this are left out: nobody is about to merge them.
const FORECAST_STALE = 14 * 24 * 3600e3;
// At most this many lane-vs-lane merges per forecast (10 active lanes = 45 pairs).
const FORECAST_PAIRS = 45;
const FORECAST_CACHE = 2000;
const forecastCache = new Map(); // "tipA tipB" (sorted) -> conflicting files

// Files `git merge-tree` reports as conflicted when merging a and b, [] when it merges clean.
async function mergeConflicts(cwd, a, b) {
  const key = a < b ? `${a} ${b}` : `${b} ${a}`;
  if (forecastCache.has(key)) return forecastCache.get(key);
  // Exit 1 = conflicts. Unrelated histories and other refusals mean no forecast: [], not cached.
  let out;
  try { out = await run(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', a, b], { allowCodes: [0, 1] }); } catch { return []; }
  const files = [...new Set(out.split('\0').slice(1).filter(Boolean))].sort();
  if (forecastCache.size >= FORECAST_CACHE) forecastCache.delete(forecastCache.keys().next().value);
  forecastCache.set(key, files);
  return files;
}

// Lanes worth forecasting: real commits ahead of base, not merged or shipped, not the base, worktree not
// missing, and touched within FORECAST_STALE. Newest first, so the pair cap keeps live work.
function forecastLanes(lanes, now = Date.now()) {
  return lanes
    .filter((l) => l.head && l.ahead > 0 && !l.isBase && !l.merged && !l.done && !l.noWork && !l.worktree?.prunable && l.activity && now - l.activity < FORECAST_STALE)
    .sort((x, y) => (y.activity || 0) - (x.activity || 0));
}

// `lanes` is the git.lanes result's list, `baseSha` its baseSha. `signal` (an AbortSignal) stops
// it between merges; whatever is running finishes, the rest never starts. Returns
// { supported, pairs: [{ a, b, files }] } with only conflicting pairs; `b` is null for the base.
// Lanes come back as { name, branch, worktree: { path } | null }, enough for the renderer's laneKey.
async function forecastConflicts(cwd, lanes, { baseSha, signal, now = Date.now(), maxPairs = FORECAST_PAIRS } = {}) {
  if (!(await canForecast(cwd))) return { supported: false, pairs: [] };
  const live = forecastLanes(lanes, now);
  const jobs = [];
  if (baseSha) for (const l of live) if (l.behind > 0) jobs.push([l, null]);
  let left = maxPairs;
  for (let i = 0; i < live.length && left > 0; i++) {
    for (let j = i + 1; j < live.length && left > 0; j++) {
      if (live[i].head === live[j].head) continue;
      jobs.push([live[i], live[j]]);
      left--;
    }
  }
  const who = (l) => ({ name: l.name, branch: l.branch, worktree: l.worktree ? { path: l.worktree.path } : null });
  const res = await mapLimit(jobs, 4, async ([a, b]) => {
    if (signal?.aborted) return null;
    const files = await mergeConflicts(cwd, a.head, b ? b.head : baseSha);
    return files.length ? { a: who(a), b: b ? who(b) : null, files } : null;
  });
  if (signal?.aborted) throw Object.assign(new Error('Forecast cancelled'), { name: 'AbortError' });
  return { supported: true, pairs: res.filter(Boolean) };
}

// Merge plan (renderer/merge-plan.js): squash-merging `head` onto `tip`, simulated. merge-tree
// writes the merged tree and commit-tree a commit on top of `tip` (objects only, never refs, the
// index or a worktree), so the next PR can be simulated on top of it. The commit's identity and
// date are fixed, so the same merge always gives the same commit. → { files, commit }: commit when
// it merges clean, else null with the conflicting files ([] when git refuses, e.g. unrelated histories).
const SIM_ENV = {
  GIT_AUTHOR_NAME: 'Since', GIT_AUTHOR_EMAIL: 'merge-plan@since.invalid', GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Since', GIT_COMMITTER_EMAIL: 'merge-plan@since.invalid', GIT_COMMITTER_DATE: '1700000000 +0000',
};
async function simulateSquash(cwd, tip, head) {
  let out;
  try { out = await run(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', tip, head], { allowCodes: [0, 1] }); } catch { return { files: [], commit: null }; }
  const [tree, ...rest] = out.split('\0');
  const files = [...new Set(rest.filter(Boolean))].sort();
  if (files.length || !/^[0-9a-f]{40,64}$/.test(tree)) return { files, commit: null };
  const commit = (await run(cwd, ['commit-tree', tree, '-p', tip, '-m', 'Since merge plan'], { env: SIM_ENV })).trim();
  return { files: [], commit };
}

// Merge plan, rebase (AK-545): `head`'s commits replayed one by one onto `tip`, simulated, the way
// GitHub's rebase merge does it, since one commit can conflict even when the whole PR merges
// clean. Each is a merge-tree against its own parent (git 2.40+ for --merge-base; older git
// simulates the PR as one squash) and a commit-tree on top of the last. Merge commits are skipped,
// like `git rebase`. Objects only, same fixed identity as simulateSquash. → { files, commit }.
const REPLAY_MAX = 250;
let replayOk = null;
onGitPathChange(() => { replayOk = null; });
async function canReplay(cwd) {
  replayOk ||= run(cwd, ['version']).then((v) => gitMeets(v, '2.40'), () => false);
  return replayOk;
}
async function simulateRebase(cwd, tip, head) {
  if (!(await canReplay(cwd))) return simulateSquash(cwd, tip, head);
  let list;
  try { list = (await run(cwd, ['rev-list', '--reverse', '--no-merges', `--max-count=${REPLAY_MAX + 1}`, head, '--not', tip, '--'])).split('\n').filter(Boolean); } catch { return { files: [], commit: null }; }
  if (list.length > REPLAY_MAX) return simulateSquash(cwd, tip, head);
  let cur = tip;
  for (const c of list) {
    let out;
    try { out = await run(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', `--merge-base=${c}^`, cur, c], { allowCodes: [0, 1] }); } catch { return { files: [], commit: null }; }
    const [tree, ...rest] = out.split('\0');
    const files = [...new Set(rest.filter(Boolean))].sort();
    if (files.length || !/^[0-9a-f]{40,64}$/.test(tree)) return { files, commit: null };
    cur = (await run(cwd, ['commit-tree', tree, '-p', cur, '-m', 'Since merge plan'], { env: SIM_ENV })).trim();
  }
  return { files: [], commit: cur };
}

// Review (AK-305): what conflicts when `head` merges into `base`, file by file. merge-tree writes
// the merged tree with conflict markers in it (objects only, never refs, the index or a worktree);
// each conflicting blob is read back and cut into hunks: the base side, the head side, and up to
// CONFLICT_CONTEXT lines around them. A file with no markers (deleted on one side, binary, a
// rename clash) comes back with no hunks and which sides still have it.
// → { supported, files: [{ path, hunks: [{ line, before, base, head, after }], inBase, inHead }] }.
const CONFLICT_CONTEXT = 3;
const CONFLICT_FILES = 100;
const CONFLICT_BYTES = 2 * 1024 * 1024;
async function mergeConflictHunks(cwd, base, head) {
  if (!(await canForecast(cwd))) return { supported: false, files: [] };
  let out;
  try {
    out = await run(cwd, ['-c', 'merge.conflictStyle=merge', 'merge-tree', '--write-tree', '--no-messages', '-z', base, head], { allowCodes: [0, 1] });
  } catch { return { supported: true, files: [] }; }
  const [tree, ...rest] = out.split('\0');
  const stages = new Map(); // path -> Set of stages (1 ancestor, 2 base, 3 head)
  for (const entry of rest) {
    const m = /^\d+ [0-9a-f]+ (\d)\t(.+)$/s.exec(entry);
    if (!m) continue;
    if (!stages.has(m[2])) stages.set(m[2], new Set());
    stages.get(m[2]).add(Number(m[1]));
  }
  const paths = [...stages.keys()].sort().slice(0, CONFLICT_FILES);
  const files = await mapLimit(paths, 4, async (path) => {
    const s = stages.get(path);
    let text = '';
    try {
      const size = Number((await run(cwd, ['cat-file', '-s', `${tree}:${path}`])).trim());
      if (size <= CONFLICT_BYTES) text = await run(cwd, ['cat-file', 'blob', `${tree}:${path}`]);
    } catch { /* not in the merged tree: deleted on a side */ }
    return { path, hunks: conflictHunks(text), inBase: s.has(2), inHead: s.has(3) };
  });
  return { supported: true, files };
}

// Conflict hunks in a file with merge markers (// ||||||| ancestor section is skipped). `line` is the 1-based line of <<<<<<< in the merged file.
function conflictHunks(text) {
  if (!text || text.includes('\0')) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const hunks = [];
  let cur = null;
  let side = null;
  let last = 0; // first line after the previous hunk, so context never repeats one
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!cur && l.startsWith('<<<<<<<')) {
      cur = { line: i + 1, before: lines.slice(Math.max(last, i - CONFLICT_CONTEXT), i), base: [], head: [], after: [] };
      side = 'base';
    } else if (cur && l.startsWith('|||||||')) side = null;
    else if (cur && /^=======\r?$/.test(l) && side !== 'head') side = 'head'; // exactly: a markdown underline isn't one (AK-308)
    else if (cur && l.startsWith('>>>>>>>')) {
      last = i + 1;
      let j = last;
      while (j < lines.length && j < last + CONFLICT_CONTEXT && !lines[j].startsWith('<<<<<<<')) j++;
      cur.after = lines.slice(last, j);
      last = j; // the next hunk's context starts after this one's (AK-308)
      hunks.push(cur);
      cur = null;
    } else if (cur && side) cur[side].push(l);
  }
  return hunks;
}

module.exports = { mergeConflicts, mergeConflictHunks, conflictHunks, simulateSquash, simulateRebase, forecastLanes, forecastConflicts, forecastCache };
