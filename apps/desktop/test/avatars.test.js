'use strict';
// PR authors' avatars: main-process fetch and disk cache (avatars.js), gh call (github.avatarImage),
// renderer cache (renderer/pr-avatars.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAvatars, avatarUrl, imageType, dataUrl, MAX_BYTES } = require('../avatars');
const github = require('../github');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gitlanes-avatars-'));

test('avatarUrl: github.com user logins only', () => {
  assert.equal(avatarUrl('github.com', 'octo-cat'), 'https://avatars.githubusercontent.com/octo-cat?s=64');
  assert.equal(avatarUrl('ghe.example.com', 'octocat'), null);
  for (const bad of ['app/dependabot', 'dependabot[bot]', '-x', 'a--b', '../etc', 'a'.repeat(40), '', null]) assert.equal(avatarUrl('github.com', bad), null, String(bad));
});

test('imageType and dataUrl: known images only, size capped', () => {
  assert.equal(imageType(PNG), 'image/png');
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(imageType(Buffer.from('<html><body>nope</body></html>')), null);
  assert.equal(imageType('not a buffer'), null);
  assert.match(dataUrl(PNG), /^data:image\/png;base64,/);
  assert.equal(dataUrl(Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)])), null);
});

test('createAvatars: fetches once, caches on disk, falls back to stale', async () => {
  const dir = tmp();
  const calls = [];
  let fail = false;
  let t = Date.now();
  const fetchImage = async (url) => { calls.push(url); if (fail) throw new Error('offline'); return PNG; };
  const get = createAvatars({ dir, fetchImage, now: () => t });
  const out = await get('github.com', ['octocat', 'octocat', 'app/bot']);
  assert.match(out.octocat, /^data:image\/png;base64,/);
  assert.equal(out['app/bot'], null);
  assert.equal(calls.length, 1);
  await get('github.com', ['octocat']);
  assert.equal(calls.length, 1, 'asked once per session');
  assert.ok(fs.existsSync(path.join(dir, 'octocat.img')));

  // A new session within a week reads the disk; after it, refetches and keeps the stale file on failure.
  const fresh = createAvatars({ dir, fetchImage, now: () => t });
  assert.match((await fresh('github.com', ['octocat'])).octocat, /^data:image\/png/);
  assert.equal(calls.length, 1);
  t += 8 * 24 * 3600 * 1000;
  fail = true;
  const later = createAvatars({ dir, fetchImage, now: () => t });
  assert.match((await later('github.com', ['octocat'])).octocat, /^data:image\/png/);
  assert.equal(calls.length, 2);
});

test('createAvatars: a non-image answer is not cached', async () => {
  const dir = tmp();
  const get = createAvatars({ dir, fetchImage: async () => Buffer.from('<!doctype html> not found') });
  assert.equal((await get('github.com', ['ghost'])).ghost, null);
  assert.ok(!fs.existsSync(path.join(dir, 'ghost.img')));
});

test('github.avatarImage: gh api GET for the avatar host only, binary output', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\n', { mode: 0o755 });
  let seen;
  const exec = async (bin, args, input, opts) => { seen = { args, opts }; return PNG; };
  assert.equal(await github.avatarImage('https://avatars.githubusercontent.com/octocat?s=64', { dirs: [dir], exec }), PNG);
  assert.deepEqual(seen.args, ['api', 'https://avatars.githubusercontent.com/octocat?s=64']);
  assert.equal(seen.opts.binary, true);
  await assert.rejects(github.avatarImage('https://api.github.com/user', { dirs: [dir], exec }), /Invalid avatar URL/);
});

test('renderer loadAvatars: asks once per login, retries after a failed call', async () => {
  const { loadAvatars, prAvatar, clearAvatars } = await import('../renderer/pr-avatars.js');
  clearAvatars();
  const asked = [];
  let fail = true;
  const fetch = async (logins) => { asked.push(logins); if (fail) throw new Error('gh'); return { octocat: 'data:image/png;base64,AA', other: 'https://evil.example/x.png' }; };
  const prs = [{ author: 'octocat' }, { author: 'octocat' }, { author: 'other' }, null, {}];
  assert.equal(await loadAvatars(prs, fetch), false);
  fail = false;
  assert.equal(await loadAvatars(prs, fetch), true);
  assert.equal(prAvatar('octocat'), 'data:image/png;base64,AA');
  assert.equal(prAvatar('other'), null, 'only data: images');
  assert.equal(await loadAvatars(prs, fetch), false);
  assert.deepEqual(asked, [['octocat', 'other'], ['octocat', 'other']]);
});
