'use strict';
// Writes the auto-update feeds (update-mac-<arch>.json) for a release, one per zip found in --dir.
//
//   node scripts/update-feed.js --version 0.2.0 --base-url https://github.com/<owner>/<repo>/releases/download/v0.2.0 [--dir dist] [--notes "…"]
//
// The app reads the feed from the `updates.feed` URL in package.json, so these files have to be uploaded
// to the release that "latest" points at, next to the zips they reference.
const fs = require('node:fs');
const path = require('node:path');
const { buildFeed, feedName, zipName } = require('../updater');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const { version, notes = '' } = args;
const base = (args['base-url'] || '').replace(/\/+$/, '');
const dir = path.resolve(args.dir || path.join(__dirname, '..', 'dist'));
if (!version || !base) {
  console.error('usage: update-feed.js --version <x.y.z> --base-url <url> [--dir <dist>] [--notes <text>]');
  process.exit(2);
}

let written = 0;
for (const arch of ['arm64', 'x64']) {
  const zip = zipName(version, arch);
  if (!fs.existsSync(path.join(dir, zip))) continue;
  const feed = buildFeed({ version, notes, url: `${base}/${encodeURIComponent(zip)}` });
  fs.writeFileSync(path.join(dir, feedName(arch)), JSON.stringify(feed, null, 2) + '\n');
  console.log(`  • ${feedName(arch)} → ${zip}`);
  written++;
}
if (!written) {
  console.error(`No ${zipName(version, '<arch>')} in ${dir}`);
  process.exit(1);
}
