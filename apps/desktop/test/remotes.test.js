'use strict';
const test = require('node:test');
const assert = require('node:assert');
// Remote name checks and the remove confirmation (renderer/remotes.js).
const load = () => import('../renderer/remotes.js');

test('remote names follow the IPC rule and must be unused', async () => {
  const { remoteNameError } = await load();
  const remotes = [{ name: 'origin' }];
  assert.equal(remoteNameError('', remotes), 'Enter a name');
  for (const bad of ['-x', 'a/b', 'a..b', 'x.lock', 'x.', 'a b']) assert.match(remoteNameError(bad, remotes), /letters/);
  assert.match(remoteNameError('origin', remotes), /already exists/);
  assert.equal(remoteNameError('origin', remotes, 'origin'), null);
  assert.equal(remoteNameError('my.fork_2', remotes), null);
});

test('removing a remote warns only when branches go with it', async () => {
  const { remoteUsage, removeRemoteWarning } = await load();
  const refs = [
    { kind: 'remote', short: 'origin/HEAD' }, { kind: 'remote', short: 'origin/main' }, { kind: 'remote', short: 'origin/dev' },
    { kind: 'remote', short: 'fork/main' }, { kind: 'branch', short: 'main', upstream: 'origin/main' }, { kind: 'branch', short: 'x' },
  ];
  const u = remoteUsage(refs, 'origin');
  assert.deepEqual(u, { branches: 2, tracking: ['main'] });
  assert.equal(removeRemoteWarning(u, '⌘Z'), 'This also removes 2 remote branches and the upstream of main. Nothing changes on the server. You can undo this with ⌘Z.');
  assert.equal(removeRemoteWarning(remoteUsage(refs, 'none'), '⌘Z'), null);
});
