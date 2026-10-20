'use strict';
// Author profile links on GitHub (renderer/profile.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/profile.js');

test('githubLogin reads the login from GitHub noreply emails only', async () => {
  const { githubLogin } = await load();
  assert.equal(githubLogin('583231+octocat@users.noreply.github.com'), 'octocat');
  assert.equal(githubLogin('Octo-Cat@users.noreply.github.com'), 'Octo-Cat');
  assert.equal(githubLogin('noreply@github.com'), null);
  assert.equal(githubLogin('me@example.com'), null);
  assert.equal(githubLogin('-bad@users.noreply.github.com'), null);
  assert.equal(githubLogin(undefined), null);
});

test('authorProfile links noreply emails to the profile on any repo', async () => {
  const { authorProfile } = await load();
  assert.deepEqual(authorProfile('1+octo@users.noreply.github.com', null), { url: 'https://github.com/octo', label: 'Open @octo on GitHub' });
  assert.equal(authorProfile('1+octo@users.noreply.github.com', 'https://gitlab.com/a/b').url, 'https://github.com/octo');
});

test('authorProfile falls back to the author’s commits on a GitHub repo', async () => {
  const { authorProfile } = await load();
  assert.equal(authorProfile('a+b@example.com', 'https://github.com/o/r').url, 'https://github.com/o/r/commits?author=a%2Bb%40example.com');
  assert.equal(authorProfile('me@example.com', 'https://gitlab.com/o/r'), null);
  assert.equal(authorProfile('me@example.com', 'https://github.com.evil.example/o/r'), null);
  assert.equal(authorProfile('me@example.com', null), null);
  assert.equal(authorProfile('', 'https://github.com/o/r'), null);
});

test('loginProfile links a known GitHub login and refuses anything else (AK-627)', async () => {
  const { loginProfile } = await load();
  assert.deepEqual(loginProfile('octo-cat'), { url: 'https://github.com/octo-cat', label: 'Open @octo-cat on GitHub' });
  assert.equal(loginProfile(''), null);
  assert.equal(loginProfile('app/dependabot'), null);
  assert.equal(loginProfile('-bad'), null);
});
