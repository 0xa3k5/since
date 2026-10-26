'use strict';
// Wrong-identity warning before committing (renderer/identity.js, git.getIdentity).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('../git');

const load = () => import('../renderer/identity.js');
const used = (email, count, name = 'Me') => ({ email, name, count });

test('history: warns only for an email that never committed in this clone', async () => {
  const { checkIdentity } = await load();
  const hist = [used('me@work.com', 12), used('me@home.org', 2)];
  const w = checkIdentity({ name: 'Me', email: 'other@x.com', used: hist });
  assert.deepEqual(w, { expected: { email: 'me@work.com', name: 'Me' }, reason: 'usual', count: 12 });
  assert.equal(checkIdentity({ email: 'ME@work.com', used: hist }), null, 'case-insensitive match');
  assert.equal(checkIdentity({ email: 'me@home.org', used: hist }), null, 'a second identity used here before is fine');
  assert.equal(checkIdentity({ email: 'new@x.com', used: [used('me@work.com', 2)] }), null, 'too little history to judge');
  assert.equal(checkIdentity({ email: 'new@x.com', used: [] }), null);
  assert.equal(checkIdentity({ email: '', used: hist }).reason, 'usual', 'no email set at all');
});

test('rules: the longest matching remote pattern wins over history', async () => {
  const { checkIdentity, matchRule } = await load();
  const rules = [{ pattern: 'github.com', email: 'me@home.org' }, { pattern: 'github.com/acme', email: 'me@acme.com', name: 'Me Acme' }];
  const remotes = ['git@github.com:acme/app.git'];
  assert.equal(matchRule(rules, remotes).email, 'me@acme.com');
  assert.equal(matchRule(rules, ['https://gitlab.com/acme/app']), null);
  const w = checkIdentity({ name: 'Me', email: 'me@home.org', used: [used('me@home.org', 50)], remotes }, rules);
  assert.deepEqual(w, { expected: { email: 'me@acme.com', name: 'Me Acme' }, reason: 'rule', pattern: 'github.com/acme' });
  assert.equal(checkIdentity({ email: 'Me@Acme.com', used: [], remotes }, rules), null);
  assert.equal(checkIdentity({ email: 'x@y.z', used: [], remotes }, rules, ['x@y.z']), null, 'dismissed for this repo');
});

test('suggestPattern and upsertRule', async () => {
  const { suggestPattern, upsertRule } = await load();
  assert.equal(suggestPattern('git@github.com:Acme/app.git'), 'github.com/acme');
  assert.equal(suggestPattern('https://user@gitlab.example.com/team/sub/app'), 'gitlab.example.com/team');
  assert.equal(suggestPattern('ssh://git@host.io:2222/org/app.git'), 'host.io/org');
  assert.equal(suggestPattern(undefined), '');
  const rules = upsertRule([{ pattern: 'github.com/acme', email: 'old@acme.com' }], { pattern: ' GitHub.com/acme ', email: 'new@acme.com ', name: '' });
  assert.deepEqual(rules, [{ pattern: 'GitHub.com/acme', email: 'new@acme.com' }]);
});

test('getIdentity counts the identities that committed in this clone', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'since-test-')));
  try {
    await git.run(dir, ['init', '-q', '-b', 'main']);
    await git.run(dir, ['config', 'commit.gpgsign', 'false']);
    const as = (n, e) => git.run(dir, ['-c', `user.name=${n}`, '-c', `user.email=${e}`, 'commit', '-q', '--allow-empty', '-m', 'x']);
    await as('Work', 'me@work.com'); await as('Work', 'me@work.com'); await as('Home', 'me@home.org');
    await git.run(dir, ['checkout', '-q', '-b', 'side']); // not a commit: not counted
    await git.run(dir, ['remote', 'add', 'origin', 'git@github.com:acme/app.git']);
    await git.run(dir, ['config', 'user.name', 'Now']);
    await git.run(dir, ['config', 'user.email', 'now@x.com']);
    const id = await git.getIdentity(dir);
    assert.equal(id.email, 'now@x.com');
    assert.equal(id.name, 'Now');
    assert.deepEqual(id.remotes, ['git@github.com:acme/app.git']);
    assert.deepEqual(id.used.sort((a, b) => b.count - a.count), [{ email: 'me@work.com', name: 'Work', count: 2 }, { email: 'me@home.org', name: 'Home', count: 1 }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
