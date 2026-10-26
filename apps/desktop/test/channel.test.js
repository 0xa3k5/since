'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadChannel, releaseChannel, CHANNELS } = require('../channel');

test('unpackaged runs pick the channel from SINCE_CHANNEL, release by default', () => {
  assert.strictEqual(loadChannel({}, { baked: undefined }).channel, 'release');
  assert.strictEqual(loadChannel({ SINCE_CHANNEL: 'beta' }, { baked: undefined }).channel, 'beta');
  assert.strictEqual(loadChannel({ SINCE_CHANNEL: 'nope' }, { baked: undefined }).channel, 'release');
});

test('packaged builds use only the baked channel and ignore the environment', () => {
  assert.strictEqual(loadChannel({ SINCE_CHANNEL: 'beta' }, { packaged: true, baked: 'release' }).channel, 'release');
  assert.strictEqual(loadChannel({}, { packaged: true, baked: 'beta' }).channel, 'beta');
  assert.strictEqual(loadChannel({ SINCE_CHANNEL: 'beta' }, { packaged: true, baked: undefined }).channel, 'release', 'a missing bake means release');
});

test('only the beta channel carries its own update feed', () => {
  assert.strictEqual(loadChannel({}, { packaged: true, baked: 'release' }).updates, undefined);
  assert.match(loadChannel({}, { packaged: true, baked: 'beta' }).updates.feed, /^https:\/\/pub-[0-9a-f]+\.r2\.dev\/beta$/);
  // scripts/beta-publish.js uploads to the same bucket.
  assert.ok(require('node:fs').readFileSync(require.resolve('../scripts/beta-publish.js'), 'utf8').includes(new URL(CHANNELS.beta.updates.feed).origin));
});

test('packaging refuses an unknown channel', () => {
  assert.strictEqual(releaseChannel('release'), 'release');
  assert.strictEqual(releaseChannel('beta'), 'beta');
  for (const name of ['sandbox', 'production', 'mock', '']) assert.throws(() => releaseChannel(name), /can't be packaged/);
});
