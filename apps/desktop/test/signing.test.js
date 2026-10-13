'use strict';
// Commit signing: every commit-creating path keeps signing when commit.gpgsign is on, and a
// locked key fails fast with a readable error instead of hanging. Every test runs in a throwaway repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-sign-')));
// No agent: keys load from disk, so a passphrase-protected key cannot be unlocked.
delete process.env.SSH_AUTH_SOCK;
process.env.GNUPGHOME = path.join(tmp, 'gnupg');
fs.mkdirSync(process.env.GNUPGHOME, { mode: 0o700 });
const git = require('../git');

const has = (bin) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const sshKey = (name, pass) => {
  const key = path.join(tmp, name);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', pass, '-C', name, '-f', key]);
  return key;
};

async function repo(sign) {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  await git.run(dir, ['init', '-q', '-b', 'main']);
  for (const [k, v] of Object.entries({ 'user.name': 'Test', 'user.email': 't@example.com', 'commit.gpgsign': 'true', ...sign })) await git.run(dir, ['config', k, v]);
  return dir;
}
async function commit(dir, file, content, msg) {
  fs.writeFileSync(path.join(dir, file), content);
  await git.run(dir, ['add', '-A']);
  // The same call main.js makes for the commit composer.
  await git.run(dir, ['commit', '-F', '-'], { input: msg });
  return (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
}
const sigs = async (dir, range = 'HEAD') => (await git.run(dir, ['log', '--format=%G? %s', range])).trim().split('\n');
const allGood = async (dir, range) => { for (const l of await sigs(dir, range)) assert.match(l, /^G /, `unsigned or unverified: ${l}`); };

// Runs every commit-creating path GitLanes has, then checks each resulting commit verifies.
async function exerciseAll(dir) {
  const a = await commit(dir, 'a.txt', 'a\n', 'A');
  const b = await commit(dir, 'b.txt', 'b\n', 'B');
  await commit(dir, 'c.txt', 'c\n', 'C');
  await git.run(dir, ['commit', '-F', '-', '--amend'], { input: 'C amended' });
  await git.rewrite(dir, 'reword', b, { message: 'B reworded' });
  await commit(dir, 'd.txt', 'd\n', 'D');
  const d = (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
  await git.rewrite(dir, 'squash', d);
  const split = await commit(dir, 'e.txt', 'one\n', 'E');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'f\n');
  await git.run(dir, ['add', '-A']);
  await git.run(dir, ['commit', '-F', '-', '--amend'], { input: 'E+F' });
  const ef = (await git.run(dir, ['rev-parse', 'HEAD'])).trim();
  assert.notEqual(ef, split);
  await git.rewrite(dir, 'split', ef, { files: { 'e.txt': 'all' }, messages: ['E', 'F'] });
  await git.rewrite(dir, 'swapParent', (await git.run(dir, ['rev-parse', 'HEAD'])).trim());

  await git.run(dir, ['switch', '-q', '-c', 'side', a]);
  const s = await commit(dir, 's.txt', 's\n', 'S');
  await git.run(dir, ['switch', '-q', 'main']);
  await git.run(dir, ['cherry-pick', s]);
  await git.run(dir, ['revert', '--no-edit', 'HEAD']);
  await git.run(dir, ['merge', '--no-edit', 'side']);
  await git.run(dir, ['switch', '-q', 'side']);
  await commit(dir, 't.txt', 't\n', 'T');
  await git.run(dir, ['rebase', '--autostash', 'main']);
  await allGood(dir, 'side');
  assert.deepEqual((await sigs(dir, 'side')).map((l) => l.slice(2)).sort(),
    ['A', 'B reworded', 'C amended', 'E', 'F', "Merge branch 'side'", 'Revert "S"', 'S', 'S', 'T']);
}

test('SSH signing: every commit path signs, and the inspector reports it', { skip: !has('ssh-keygen') && 'ssh-keygen missing' }, async () => {
  const key = sshKey('ok', '');
  const allowed = path.join(tmp, 'allowed_signers');
  fs.writeFileSync(allowed, `t@example.com ${fs.readFileSync(`${key}.pub`, 'utf8')}`);
  const dir = await repo({ 'gpg.format': 'ssh', 'user.signingkey': key, 'gpg.ssh.allowedSignersFile': allowed });
  await exerciseAll(dir);
  const c = await git.getCommit(dir, 'HEAD');
  assert.equal(c.signature.state, 'good');
  assert.equal(c.signature.signer, 't@example.com');
  assert.equal(c.message, 'T');
});

test('GPG signing: every commit path signs', { skip: !has('gpg') && 'gpg missing' }, async () => {
  execFileSync('gpg', ['--batch', '--passphrase', '', '--quick-gen-key', 'Test <t@example.com>', 'ed25519', 'sign', 'never'], { stdio: 'ignore' });
  try {
    await exerciseAll(await repo({ 'user.signingkey': 't@example.com' }));
  } finally {
    try { execFileSync('gpgconf', ['--kill', 'gpg-agent'], { stdio: 'ignore' }); } catch {}
  }
});

test('unsigned and unverifiable commits', async () => {
  const dir = await repo({ 'commit.gpgsign': 'false' });
  await commit(dir, 'a.txt', 'a\n', 'A');
  assert.equal((await git.getCommit(dir, 'HEAD')).signature, null);
  if (!has('ssh-keygen')) return;
  // Signed, but no allowed signers file to check it against.
  await git.run(dir, ['config', 'gpg.format', 'ssh']);
  await git.run(dir, ['config', 'user.signingkey', sshKey('unknown', '')]);
  await git.run(dir, ['commit', '-q', '-S', '--allow-empty', '-m', 'B']);
  assert.equal((await git.getCommit(dir, 'HEAD')).signature.state, 'unverified');
});

test('locked SSH key: commit and rewrite fail fast with a clear error and leave the branch as it was', { skip: !has('ssh-keygen') && 'ssh-keygen missing', timeout: 20000 }, async () => {
  const dir = await repo({ 'commit.gpgsign': 'false' });
  const a = await commit(dir, 'a.txt', 'a\n', 'A');
  const head = await commit(dir, 'b.txt', 'b\n', 'B');
  await git.run(dir, ['config', 'commit.gpgsign', 'true']);
  await git.run(dir, ['config', 'gpg.format', 'ssh']);
  await git.run(dir, ['config', 'user.signingkey', sshKey('locked', 'secret passphrase')]);

  fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
  await git.run(dir, ['add', '-A']);
  await assert.rejects(git.run(dir, ['commit', '-F', '-'], { input: 'C' }), /^Error: Couldn't sign the commit\. Unlock your GPG key, or add your SSH signing key to ssh-agent/);
  await assert.rejects(git.rewrite(dir, 'reword', a, { message: 'A2' }), /Couldn't sign the commit/);
  assert.equal(await git.getOperationState(path.join(dir, '.git')), null);
  assert.equal((await git.run(dir, ['rev-parse', 'HEAD'])).trim(), head);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
