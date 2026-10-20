'use strict';
// Removing a worktree (renderer/worktree-removal.js, AK-581): every plan ends with it removed or one reason.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../renderer/worktree-removal.js');
const wt = (o = {}) => ({ name: 'wt-dirty', path: '/r/wt-dirty', ...o });
const main = (o = {}) => ({ name: 'r', path: '/r', main: true, ...o });

// Follow a plan to where it ends: through "Close and remove", a switch or a handoff.
const end = (p) => (p.then ? end(p.then) : p);

test('removal plan: never ends where it started', async () => {
  const { removalPlan } = await load();
  for (const elsewhere of [false, true]) for (const current of [false, true]) for (const mainElsewhere of [false, true])
    for (const changes of [0, 3]) for (const op of [null, 'rebase']) for (const draft of [false, true]) {
      if (elsewhere && current) continue;
      const p = removalPlan(wt({ elsewhere, current }), { main: main({ elsewhere: mainElsewhere }), facts: { changes, op }, draft });
      const last = end(p);
      assert.equal(last.kind, 'remove', JSON.stringify({ elsewhere, current, mainElsewhere, changes, op, draft, p }));
      assert.equal(last.stash, changes > 0);
      assert.equal(last.abort, !!op);
      // The window showing it is closed by the removal itself, not left for the user to find.
      if (elsewhere) assert.equal(last.close, true);
      if (current) assert.equal(p.kind === 'ask' ? p.then.kind : p.kind, mainElsewhere ? 'handoff' : 'switch');
    }
});

test('removal plan: asks only for work undo can’t bring back', async () => {
  const { removalPlan } = await load();
  assert.equal(removalPlan(wt({ elsewhere: true }), { facts: { changes: 4 } }).kind, 'remove');
  assert.deepEqual(removalPlan(wt({ elsewhere: true }), { draft: true }), { kind: 'ask', why: '“wt-dirty” has a commit message in progress.', then: { kind: 'remove', close: true, stash: false, abort: false } });
  assert.equal(removalPlan(wt({ elsewhere: true }), { facts: { op: 'merge' } }).why, '“wt-dirty” has a merge in progress.');
  // A draft in a worktree no window shows is kept for when it's back (undo).
  assert.equal(removalPlan(wt(), { draft: true }).kind, 'remove');
  // This window shows it: closing it on a typed message asks too, whichever window removes it.
  const m = { ...main(), elsewhere: true };
  const handoff = removalPlan(wt({ current: true }), { main: m, draft: true });
  assert.equal(handoff.kind, 'ask');
  assert.equal(handoff.then.kind, 'handoff');
  assert.equal(removalPlan(wt({ current: true }), { main: m }).kind, 'handoff');
});

test('removing a worktree no window shows needs no confirm, and the current one can be removed', () => {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function removeWorktree('), src.indexOf('function askAt('));
  assert.doesNotMatch(fn, /await confirm\(/);
  assert.match(src, /label: 'Remove Worktree…'[^\n]*disabled: w\.main,/);
  assert.match(src, /Remove worktree \$\{here\.name\}…/);
});

test('removal plan: the reasons it can’t be removed', async () => {
  const { removalPlan } = await load();
  assert.deepEqual(removalPlan(wt({ missing: true })), { kind: 'prune' });
  assert.equal(removalPlan(main()).kind, 'blocked');
  assert.equal(removalPlan(wt({ locked: true })).why, '“wt-dirty” is locked');
  assert.equal(removalPlan(wt({ current: true }), { main: null }).kind, 'blocked');
});

test('removing a dirty worktree stashes its changes; undo puts them back, redo stashes again', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const git = require('../git');
  const { Journal } = require('../journal');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-test-')));
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 't@example.com'], ['config', 'commit.gpgsign', 'false']]) await git.run(dir, a);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  await git.run(dir, ['add', '.']);
  await git.run(dir, ['commit', '-q', '-m', 'a']);
  const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt-dirty`);
  await git.run(dir, ['worktree', 'add', '-q', '-b', 'wt-dirty', wt]);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(wt, 'new.txt'), 'new\n');
  const journal = new Journal(await git.openRepo(dir));

  await assert.rejects(journal.runWorktree('removeWorktree', 'Remove', [wt]), /uncommitted/);
  const res = await journal.runWorktree('removeWorktree', 'Remove wt-dirty', [wt, { stash: true }]);
  assert.ok(res.stash);
  assert.equal(fs.existsSync(wt), false);
  assert.equal((await git.getStashes(dir)).length, 1);

  await journal.step('undo');
  assert.equal(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(wt, 'new.txt'), 'utf8'), 'new\n');
  assert.equal((await git.getStashes(dir)).length, 0);

  await journal.step('redo');
  assert.equal(fs.existsSync(wt), false);
  assert.equal((await git.getStashes(dir)).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
