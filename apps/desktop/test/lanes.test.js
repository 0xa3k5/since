'use strict';
// Lanes data layer (git.lanes): one record per branch and worktree, measured against base.
// Every test runs in throwaway repos in the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');

let clock = 1700000000;
const g = (dir, args, opts = {}) => git.run(dir, args, { ...opts, env: { GIT_COMMITTER_DATE: `${clock} +0000`, GIT_AUTHOR_DATE: `${clock} +0000`, ...opts.env } });
async function commit(dir, file, content, msg = `edit ${file}`) {
  clock += 60;
  fs.writeFileSync(path.join(dir, file), content);
  await g(dir, ['add', file]);
  await g(dir, ['commit', '-q', '-m', msg]);
}
async function repo() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-lanes-')));
  const dir = path.join(parent, 'app');
  fs.mkdirSync(dir);
  await g(dir, ['init', '-q', '-b', 'main']);
  await g(dir, ['config', 'user.name', 'Test']);
  await g(dir, ['config', 'user.email', 't@example.com']);
  await g(dir, ['config', 'commit.gpgsign', 'false']);
  await commit(dir, 'a.txt', 'a\n', 'base');
  return { parent, dir };
}
const byName = (res) => Object.fromEntries(res.lanes.map((l) => [l.name, l]));

test('agentGuess: trailers win over branch prefixes; humans are null', () => {
  const t = git.parseTrailers('Co-Authored-By: Claude Opus <noreply@anthropic.com>\nSigned-off-by: A <a@b>');
  assert.deepEqual(t.map((x) => x.key), ['Co-Authored-By', 'Signed-off-by']);
  assert.equal(git.agentGuess('feature', t).reason, 'trailer');
  assert.equal(git.agentGuess('x', [{ key: 'Generated-by', value: 'some tool' }]).reason, 'trailer');
  assert.deepEqual(git.agentGuess('codex/fix-login', []), { reason: 'branch prefix', match: 'codex/' });
  assert.equal(git.agentGuess('Claude/Upper', []).reason, 'branch prefix');
  assert.equal(git.agentGuess('feature/ai-things', [{ key: 'Co-Authored-By', value: 'Grace Hopper <grace@example.com>' }]), null);
  assert.equal(git.agentGuess('aim/x', []), null);
  for (const p of git.AGENT_HINTS.prefixes) assert.ok(git.agentGuess(`${p}x`), p);
});

test('laneBase: origin/HEAD, then main/master, overridable, unknown throws', async () => {
  const { dir } = await repo();
  assert.equal((await git.laneBase(dir)).name, 'main');
  await g(dir, ['branch', 'develop']);
  await g(dir, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);
  await g(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop']);
  const b = await git.laneBase(dir);
  assert.deepEqual([b.ref, b.name, b.local], ['refs/remotes/origin/develop', 'origin/develop', 'develop']);
  assert.equal((await git.laneBase(dir, 'develop')).ref, 'refs/heads/develop');
  await assert.rejects(git.laneBase(dir, 'nope'), /Unknown base/);
  await assert.rejects(git.laneBase(dir, '--all'), /Unknown base/);
  const res = await git.lanes(dir);
  assert.equal(res.base, 'origin/develop');
  assert.equal(byName(res).develop.isBase, true);
  assert.equal(byName(res).main.isBase, false);
});

test('lanes: ahead/behind, merged (ancestor, squash, cherry, tree-equal), nothing ahead', async () => {
  const { dir } = await repo();
  const fork = (await g(dir, ['rev-parse', 'HEAD'])).trim();
  await g(dir, ['branch', 'fresh']);
  // Merged by fast-forward, then base moved on.
  await g(dir, ['switch', '-q', '-c', 'landed']); await commit(dir, 'l.txt', 'l\n');
  await g(dir, ['switch', '-q', 'main']); await g(dir, ['merge', '-q', '--ff-only', 'landed']);
  // Two commits squash-merged after base moved on (so neither trees nor single patches match).
  await g(dir, ['switch', '-q', '-c', 'squashed', fork]); await commit(dir, 's.txt', 's1\n'); await commit(dir, 's.txt', 's2\n');
  // One commit cherry-picked onto base (rebase merge), after base moved on.
  await g(dir, ['switch', '-q', '-c', 'picked', fork]); await commit(dir, 'p.txt', 'p\n');
  // Tree-equal: base reached the same tree with different commits.
  await g(dir, ['switch', '-q', 'main']);
  await g(dir, ['switch', '-q', '-c', 'tree']); await commit(dir, 't.txt', 'final\n');
  await g(dir, ['switch', '-q', '-c', 'open', fork]); await commit(dir, 'o.txt', 'o\n');
  await g(dir, ['switch', '-q', 'main']);
  await commit(dir, 't.txt', 'draft\n'); await commit(dir, 't.txt', 'final\n');
  await g(dir, ['merge', '-q', '--squash', 'squashed']); clock += 60; await g(dir, ['commit', '-q', '-m', 'squashed (#1)']);
  await g(dir, ['cherry-pick', 'picked']);
  // A new lane branched off base after the merges must not hide them.
  await g(dir, ['switch', '-q', '-c', 'later']); await commit(dir, 'n.txt', 'n\n');
  await g(dir, ['switch', '-q', 'main']);
  for (const aheadBehind of [undefined, false]) {
    const l = byName(await git.lanes(dir, { aheadBehind }));
    assert.equal(l.main.isBase, true);
    assert.deepEqual([l.landed.ahead, l.landed.merged, l.landed.nothingAhead], [0, 'ancestor', true]);
    assert.deepEqual([l.fresh.ahead, l.fresh.merged, l.fresh.nothingAhead], [0, 'ancestor', true]);
    assert.deepEqual([l.squashed.ahead, l.squashed.merged], [2, 'squash']);
    assert.deepEqual([l.picked.ahead, l.picked.merged], [1, 'squash']);
    assert.equal(l.tree.merged, 'squash');
    assert.deepEqual([l.later.ahead, l.later.behind, l.later.merged], [1, 0, null]);
    assert.deepEqual([l.open.ahead, l.open.behind, l.open.merged, l.open.nothingAhead], [1, 5, null, false]);
  }
  // At base tip exactly: nothing ahead, but not "merged".
  await g(dir, ['branch', 'tip']);
  const l = byName(await git.lanes(dir));
  assert.deepEqual([l.tip.ahead, l.tip.behind, l.tip.merged, l.tip.nothingAhead], [0, 0, null, true]);
  assert.equal(l.tip.activity, l.main.activity);
});

test('lanes: upstream and gone upstream, agent trailer and prefix', async () => {
  const { dir } = await repo();
  await g(dir, ['remote', 'add', 'origin', 'https://example.invalid/acme/app.git']);
  await g(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await g(dir, ['branch', '--set-upstream-to=origin/main', 'main']);
  await g(dir, ['switch', '-q', '-c', 'gone']); await commit(dir, 'g.txt', 'g\n');
  await g(dir, ['config', 'branch.gone.remote', 'origin']);
  await g(dir, ['config', 'branch.gone.merge', 'refs/heads/gone']);
  await g(dir, ['switch', '-q', '-c', 'helped', 'main']);
  await commit(dir, 'h.txt', 'h\n', 'add h\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  await g(dir, ['switch', '-q', '-c', 'claude/task', 'main']); await commit(dir, 'c.txt', 'c\n');
  await g(dir, ['switch', '-q', 'main']);
  const l = byName(await git.lanes(dir));
  assert.deepEqual([l.main.upstream, l.main.upstreamGone], ['origin/main', false]);
  assert.deepEqual([l.gone.upstream, l.gone.upstreamGone], ['origin/gone', true]);
  assert.equal(l.helped.upstream, null);
  assert.equal(l.helped.agent.reason, 'trailer');
  assert.match(l.helped.agent.match, /anthropic/);
  assert.deepEqual(l['claude/task'].agent, { reason: 'branch prefix', match: 'claude/' });
  assert.equal(l.gone.agent, null);
  assert.equal(l.main.agent, null);
});

test('lanes: worktrees joined to branches, detached and prunable ones, uncommitted count', async () => {
  const { parent, dir } = await repo();
  await g(dir, ['branch', 'feat']);
  const wt = path.join(parent, 'feat');
  await g(dir, ['worktree', 'add', '-q', wt, 'feat']);
  await commit(wt, 'f.txt', 'f\n');
  clock += 3600;
  fs.writeFileSync(path.join(wt, 'f.txt'), 'dirty\n');
  fs.writeFileSync(path.join(wt, 'new.txt'), 'new\n');
  const later = new Date((clock + 60) * 1000);
  fs.utimesSync(path.join(wt, 'new.txt'), later, later);
  fs.utimesSync(path.join(wt, 'f.txt'), new Date(clock * 1000), new Date(clock * 1000));
  const det = path.join(parent, 'det');
  await g(dir, ['worktree', 'add', '-q', '--detach', det, 'main']);
  await g(dir, ['branch', 'gonewt']);
  const gonePath = path.join(parent, 'gonewt');
  await g(dir, ['worktree', 'add', '-q', gonePath, 'gonewt']);
  fs.rmSync(gonePath, { recursive: true, force: true });

  const res = await git.lanes(dir);
  assert.equal(res.lanes.length, 4);
  const l = byName(res);
  assert.deepEqual([l.feat.worktree.path, l.feat.worktree.prunable, l.feat.changes, l.feat.ahead], [wt, false, 2, 1]);
  assert.equal(l.feat.activity, later.getTime());
  assert.equal(res.lanes[0].name, 'feat', 'newest activity first');
  assert.equal(l.main.worktree.main, true);
  assert.equal(l.main.changes, 0);
  assert.deepEqual([l.det.detached, l.det.branch, l.det.ahead, l.det.behind, l.det.worktree.path], [true, null, 0, 0, det]);
  assert.ok(l.det.activity > 0);
  assert.deepEqual([l.gonewt.worktree.prunable, l.gonewt.changes], [true, null]);
});

// Conflict forecast (git.forecastConflicts): git merge-tree per pair, cached by the two tips.
async function forecastRepo() {
  const { parent, dir } = await repo();
  await commit(dir, 'shared.txt', 'one\ntwo\nthree\n', 'shared');
  for (const [branch, file, content] of [['left', 'shared.txt', 'one\nLEFT\nthree\n'], ['right', 'shared.txt', 'one\nRIGHT\nthree\n'], ['other', 'other.txt', 'other\n']]) {
    await g(dir, ['checkout', '-q', '-b', branch, 'main']);
    await commit(dir, file, content);
  }
  await g(dir, ['checkout', '-q', 'main']);
  return { parent, dir };
}
const pairName = (p) => [p.a.name, p.b ? p.b.name : 'base'].join(' × ');

test('forecastConflicts: a conflicting pair names both lanes and the files; clean pairs are left out', async () => {
  const { parent, dir } = await forecastRepo();
  try {
    git._setForecastGate(null);
    const res = await git.lanes(dir);
    const now = clock * 1000 + 60e3;
    const out = await git.forecastConflicts(dir, res.lanes, { baseSha: res.baseSha, now });
    assert.equal(out.supported, true);
    assert.deepEqual(out.pairs.map(pairName).map((s) => s.split(' × ').sort().join(' × ')), ['left × right']);
    assert.deepEqual(out.pairs[0].files, ['shared.txt']);
    assert.equal(out.pairs[0].a.worktree, null);

    // Base moved on the same lines: every lane that touched them now conflicts with base.
    await commit(dir, 'shared.txt', 'one\nMAIN\nthree\n');
    const res2 = await git.lanes(dir);
    const out2 = await git.forecastConflicts(dir, res2.lanes, { baseSha: res2.baseSha, now: clock * 1000 + 60e3 });
    const names = out2.pairs.map(pairName).sort();
    assert.ok(names.includes('left × base') && names.includes('right × base'), names.join(', '));
    assert.ok(!names.some((n) => n.includes('other')));

    // Stale lanes are skipped; the pair cap holds.
    assert.deepEqual((await git.forecastConflicts(dir, res2.lanes, { baseSha: res2.baseSha, now: clock * 1000 + 30 * 24 * 3600e3 })).pairs, []);
    const capped = await git.forecastConflicts(dir, res.lanes, { baseSha: res.baseSha, now, maxPairs: 0 });
    assert.deepEqual(capped.pairs, []);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('forecastConflicts: unchanged pairs come from the cache, keyed by both tips', async () => {
  const { parent, dir } = await forecastRepo();
  try {
    const [left, right] = (await g(dir, ['rev-parse', 'left', 'right'])).trim().split('\n');
    git._forecastCache.clear();
    assert.deepEqual(await git.mergeConflicts(dir, left, right), ['shared.txt']);
    assert.equal(git._forecastCache.size, 1);
    // A planted entry proves the second call (either order) never runs git.
    git._forecastCache.set([left, right].sort().join(' '), ['cached.txt']);
    assert.deepEqual(await git.mergeConflicts(dir, right, left), ['cached.txt']);
    assert.equal(git._forecastCache.size, 1);
    git._forecastCache.clear();
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('forecastConflicts: hidden on git before 2.38; a cancelled forecast throws AbortError', async () => {
  assert.equal(git.mergeTreeSupported('git version 2.37.3 (Apple Git-150)'), false);
  assert.equal(git.mergeTreeSupported('git version 2.38.0'), true);
  assert.equal(git.mergeTreeSupported('git version 3.0.1'), true);
  const { parent, dir } = await forecastRepo();
  try {
    const res = await git.lanes(dir);
    git._setForecastGate(false);
    assert.deepEqual(await git.forecastConflicts(dir, res.lanes, { baseSha: res.baseSha, now: clock * 1000 }), { supported: false, pairs: [] });
    git._setForecastGate(null);
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(git.forecastConflicts(dir, res.lanes, { baseSha: res.baseSha, now: clock * 1000, signal: ctrl.signal }), { name: 'AbortError' });
  } finally { git._setForecastGate(null); fs.rmSync(parent, { recursive: true, force: true }); }
});

test('lanes: shipped (net patch, key, PR head), titles, unmerged and baseline-only lanes stay open', async () => {
  const { dir } = await repo();
  const baseline = (d) => g(d, ['commit', '-q', '--allow-empty', '-m', 'chore(agent): baseline — the task worktree started here']);
  // Squash-merged under another branch name, with a baseline commit and a merge from main on top.
  await g(dir, ['switch', '-q', '-c', 'agent/eng/wip']); await baseline(dir); await commit(dir, 'w.txt', 'w1\n', 'start w'); await commit(dir, 'w.txt', 'w\n', 'feat: add w');
  await g(dir, ['switch', '-q', 'main']); await commit(dir, 'm.txt', 'm\n', 'main moves');
  await g(dir, ['switch', '-q', 'agent/eng/wip']); clock += 60; await g(dir, ['merge', '-q', '--no-edit', 'main']);
  await g(dir, ['switch', '-q', 'main']); await commit(dir, 'm2.txt', 'm2\n', 'main moves on'); await g(dir, ['merge', '-q', '--squash', 'agent/eng/wip']); clock += 60; await g(dir, ['commit', '-q', '-m', 'Ship the w file (#3)']);
  // Key match: the base carries "(AK-12)" with different content.
  await g(dir, ['switch', '-q', '-c', 'agent/eng/ak-12']); await commit(dir, 'k.txt', 'k\n', 'try k');
  await g(dir, ['switch', '-q', 'main']); await commit(dir, 'k2.txt', 'k2\n', 'feat(desktop): k done properly (AK-12) (#4)');
  // PR head match (mocked merged PR list), nothing of it on base.
  await g(dir, ['switch', '-q', '-c', 'feat-pr']); await commit(dir, 'p.txt', 'p\n', 'p work');
  const prHead = (await g(dir, ['rev-parse', 'HEAD'])).trim();
  // Genuinely unmerged, and a fresh agent lane with only its baseline commit.
  await g(dir, ['switch', '-q', '-c', 'agent/eng/ak-99', 'main']); await baseline(dir); await commit(dir, 'o.txt', 'o\n', 'feat: open work');
  await g(dir, ['switch', '-q', '-c', 'agent/eng/fresh', 'main']); await baseline(dir);
  // Only agent bookkeeping: a baseline plus swept-up scratch files.
  await g(dir, ['switch', '-q', '-c', 'agent/eng/scratch', 'main']); await baseline(dir); await commit(dir, 'description.md', 'notes\n', 'chore(agent): uncommitted changes from task');
  // Older "AK-48: …" subjects carry the key as a prefix.
  await g(dir, ['switch', '-q', '-c', 'review-x', 'main']); await commit(dir, 'h.txt', 'h1\n', 'AK-48: harden things');
  await g(dir, ['switch', '-q', 'main']); await commit(dir, 'h.txt', 'h2\n', 'AK-48: Electron hardening (#15)');
  await commit(dir, 'z.txt', 'z\n', 'main moves again');

  const l = byName(await git.lanes(dir, { prHeads: [{ sha: prHead, number: 9, title: 'Add the p file', branch: 'other-name' }] }));
  assert.deepEqual(l['agent/eng/wip'].done, { reason: 'net-patch' });
  assert.equal(l['agent/eng/wip'].title, 'feat: add w', 'baseline and merge commits skipped');
  assert.deepEqual(l['agent/eng/ak-12'].done, { reason: 'key', key: 'AK-12' });
  assert.deepEqual(l['feat-pr'].done, { reason: 'pr', pr: 9 });
  assert.equal(l['feat-pr'].title, 'Add the p file');
  assert.equal(l['agent/eng/ak-99'].done, null);
  assert.equal(l['agent/eng/ak-99'].title, 'feat: open work');
  assert.equal(l['agent/eng/fresh'].done, null, 'nothing to ship is not shipped');
  assert.equal(l['agent/eng/fresh'].title, 'agent/eng/fresh');
  assert.equal(l.main.done, null);
  assert.deepEqual([l['agent/eng/scratch'].done, l['agent/eng/scratch'].noWork, l['agent/eng/ak-99'].noWork], [null, true, false]);
  assert.deepEqual(l['review-x'].done, { reason: 'key', key: 'AK-48' });
  // Without PR features: no PR match, and no network at all (git.lanes never calls gh).
  assert.equal(byName(await git.lanes(dir))['feat-pr'].done, null);
});

test('branchKey, plainSubject, shortPath; the forecast skips done lanes', () => {
  assert.equal(git.branchKey('agent/gitlanes-engineer/ak-228'), 'AK-228');
  assert.equal(git.branchKey('ak-255-shipped-lanes'), 'AK-255');
  assert.equal(git.branchKey('feature/login'), null);
  assert.equal(git.plainSubject('Fix the thing (AK-1) (#12)'), 'fix the thing (ak-1)');
  assert.equal(git.shortPath('/Users/me/work/repos/app/wt', '/Users/me'), '~/…/app/wt');
  assert.equal(git.shortPath('/Users/me/app', '/Users/me'), '~/app');
  const now = Date.now();
  const lane = (head, done) => ({ head, ahead: 1, isBase: false, merged: null, done, activity: now });
  assert.deepEqual(git.forecastLanes([lane('a', { reason: 'pr', pr: 1 }), lane('b', null)], now).map((l) => l.head), ['b']);
});
