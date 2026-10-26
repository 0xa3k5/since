'use strict';
// How many git processes a lanes load spawns (AK-639): shared runs, merge-bases from fork points,
// and per-SHA memos. Counts every git call git.js makes (execFile). Throwaway repos in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const calls = [];
const realExecFile = cp.execFile;
cp.execFile = function (file, args, ...rest) { calls.push(args); return realExecFile.call(this, file, args, ...rest); };
const git = require('../git'); // after the patch: git.js keeps its own reference to execFile

let clock = 1700000000;
const g = (dir, args) => git.run(dir, args, { env: { GIT_COMMITTER_DATE: `${clock} +0000`, GIT_AUTHOR_DATE: `${clock} +0000` } });
async function commit(dir, file, content, msg = `edit ${file}`) {
  clock += 60;
  fs.writeFileSync(path.join(dir, file), content);
  await g(dir, ['add', file]);
  await g(dir, ['commit', '-q', '-m', msg]);
}
async function repo() {
  const dir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'since-fanout-'))), 'app');
  fs.mkdirSync(dir);
  await g(dir, ['init', '-q', '-b', 'main']);
  await g(dir, ['config', 'user.name', 'Test']);
  await g(dir, ['config', 'user.email', 't@example.com']);
  await g(dir, ['config', 'commit.gpgsign', 'false']);
  await commit(dir, 'a.txt', 'a\n', 'base');
  return dir;
}
const count = (sub) => calls.filter((a) => a[0] === sub).length;
const byName = (res) => Object.fromEntries(res.lanes.map((l) => [l.name, l]));

test('callers that ask while a lanes run is in flight share it; a repo change starts a fresh one', async () => {
  const dir = await repo();
  await g(dir, ['switch', '-q', '-c', 'feat']); await commit(dir, 'f.txt', 'f\n');
  await g(dir, ['switch', '-q', 'main']);
  calls.length = 0;
  const runs = Array.from({ length: 5 }, () => git.sharedLanes(dir, { gen: 1 }));
  assert.ok(runs.every((p) => p === runs[0]), 'one promise for all five');
  const fresh = git.sharedLanes(dir, { gen: 2 }); // the repo changed after the first run started
  assert.notEqual(fresh, runs[0]);
  const other = git.sharedLanes(dir, { gen: 2, base: 'feat' }); // another base is another run
  assert.notEqual(other, fresh);
  const [a, , , , , b] = await Promise.all([...runs, fresh, other]);
  assert.equal(calls.filter((x) => x[0] === 'for-each-ref' && x.includes('refs/heads')).length, 3, 'three runs, not seven');
  assert.deepEqual(a, b);
  assert.notEqual(git.sharedLanes(dir, { gen: 2 }), fresh, 'a finished run is not reused');
});

test('a lane forked once from base takes its fork point as merge-base; memos skip unchanged lanes', async () => {
  const dir = await repo();
  // Linear lane with work, a linear lane whose change is undone (tip tree = fork point tree), a lane
  // that merged base in (two boundary commits: needs git merge-base) and a baseline-only agent lane.
  await g(dir, ['switch', '-q', '-c', 'linear']); await commit(dir, 'l.txt', 'l\n');
  await g(dir, ['switch', '-q', '-c', 'undone', 'main']); await commit(dir, 'u.txt', 'u\n', 'add u');
  await g(dir, ['rm', '-q', 'u.txt']); clock += 60; await g(dir, ['commit', '-q', '-m', 'drop u']);
  await g(dir, ['switch', '-q', '-c', 'merged-in', 'main']); await commit(dir, 'm.txt', 'm\n', 'feat: m');
  await g(dir, ['switch', '-q', 'main']); await commit(dir, 'b.txt', 'b\n', 'main moves');
  await g(dir, ['switch', '-q', 'merged-in']); clock += 60; await g(dir, ['merge', '-q', '--no-edit', 'main']);
  await g(dir, ['switch', '-q', '-c', 'agent/eng/fresh', 'main']); clock += 60;
  await g(dir, ['commit', '-q', '--allow-empty', '-m', 'chore(agent): baseline — the task worktree started here']);
  await g(dir, ['switch', '-q', 'main']);

  calls.length = 0;
  const first = await git.lanes(dir);
  const l = byName(first);
  assert.equal(count('merge-base'), 1, 'only the lane that merged base in asks git');
  assert.equal(l.undone.done, null, 'net empty against its fork point: nothing to ship');
  assert.equal(l.linear.done, null);
  assert.equal(l['merged-in'].done, null);
  assert.equal(l['agent/eng/fresh'].noWork, true);
  const mergeTrees = count('merge-tree');

  calls.length = 0;
  assert.deepEqual(await git.lanes(dir), first);
  assert.equal(count('merge-base'), 0, 'remembered by SHA');
  assert.equal(count('merge-tree'), 0, `remembered by SHA (first run: ${mergeTrees})`);
});

test('prShipped marks lanes shipped by a merged PR on a copy, leaving the shared result alone', async () => {
  const dir = await repo();
  await g(dir, ['switch', '-q', '-c', 'task-x']); await commit(dir, 'p.txt', 'p\n', 'add p');
  const head = (await g(dir, ['rev-parse', 'HEAD'])).trim();
  await g(dir, ['switch', '-q', 'main']);
  const res = await git.lanes(dir);
  const out = byName({ lanes: git.prShipped(res, [{ sha: head, number: 7, title: 'Add the p file' }]) });
  assert.deepEqual(out['task-x'].done, { reason: 'pr', pr: 7 });
  assert.equal(out['task-x'].title, 'Add the p file');
  assert.equal(byName(res)['task-x'].done, null, 'the shared result is unchanged');
  assert.equal(git.prShipped(res, []), res.lanes, 'no merged PRs: the same lanes');
  assert.deepEqual(byName(await git.lanes(dir, { prHeads: [{ sha: head, number: 7, title: 'Add the p file' }] }))['task-x'], out['task-x']);
});
