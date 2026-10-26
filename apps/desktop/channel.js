'use strict';
// Update channel per build.
// - Unpackaged (`pnpm start`): pick one with SINCE_CHANNEL=release|beta; release by default.
// - Packaged: only the channel baked in at build time counts (package.json "since.channel", written by
//   `SINCE_CHANNEL=… pnpm dist`). The environment is ignored, and a missing bake means release.

const CHANNELS = {
  // The release feed in package.json ("updates").
  release: {},
  // Betas read their update feed from the beta bucket.
  beta: {
    updates: {
      feed: 'https://pub-1b56c7c361874048ab3f67ebe6cdac1b.r2.dev/beta',
      page: 'https://gitsince.com/download',
    },
  },
};

function bakedChannel() {
  try { return require('./package.json').since?.channel; } catch { return undefined; }
}

function channelName(env = process.env, { packaged = false, baked = bakedChannel() } = {}) {
  const name = packaged ? baked : env.SINCE_CHANNEL || baked;
  return CHANNELS[name] ? name : 'release';
}

function loadChannel(env = process.env, opts) {
  const name = channelName(env, opts);
  return { channel: name, ...CHANNELS[name] };
}

// Build-time check for `pnpm dist`: refuse to package an unknown channel.
function releaseChannel(name) {
  if (!CHANNELS[name]) throw new Error(`SINCE_CHANNEL=${name} can't be packaged. Use release or beta.`);
  return name;
}

module.exports = { loadChannel, releaseChannel, CHANNELS };
