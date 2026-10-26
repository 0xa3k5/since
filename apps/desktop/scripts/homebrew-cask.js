'use strict';
// Renders the Homebrew cask for a release from the signed DMGs in --dir, for the tap (0xa3k5/homebrew-tap).
//
//   node scripts/homebrew-cask.js --version 1.0.0 [--dir dist] > dist/since.rb
//
// release.yml attaches the output to the draft release; publishing a release includes copying it into the tap
// as Casks/since.rb (docs/releasing.md). The URL is the versioned DMG on the GitHub Release, one per
// architecture, so a cask never changes under an installed version; livecheck follows the latest release.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = '0xa3k5/since';
/** Homebrew's arch symbols → the arch in our artifact names. */
const ARCHES = { arm: 'arm64', intel: 'x64' };
const dmgName = (version, arch) => `Since-${version}-${arch}.dmg`;
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The cask text for `version`, given the DMGs' sha256 hex digests as { arm, intel }. */
function renderCask({ version, sha }) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(version || ''))) throw new Error(`${version} is not a version (expected e.g. 1.0.0).`);
  for (const k of Object.keys(ARCHES)) {
    if (!/^[0-9a-f]{64}$/.test(sha?.[k] || '')) throw new Error(`Missing or malformed sha256 for ${k} (${ARCHES[k]}).`);
  }
  return `cask "since" do
  arch arm: "${ARCHES.arm}", intel: "${ARCHES.intel}"

  version "${version}"
  sha256 arm:   "${sha.arm}",
         intel: "${sha.intel}"

  url "https://github.com/${REPO}/releases/download/v#{version}/Since-#{version}-#{arch}.dmg",
      verified: "github.com/${REPO}/"
  name "Since"
  desc "Keyboard-first Git client"
  homepage "https://gitsince.com/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :monterey"

  app "Since.app"

  zap trash: [
    "~/Library/Application Support/Since",
    "~/Library/Caches/com.gitsince.app",
    "~/Library/Caches/com.gitsince.app.ShipIt",
    "~/Library/HTTPStorages/com.gitsince.app",
    "~/Library/Preferences/com.gitsince.app.plist",
    "~/Library/Saved Application State/com.gitsince.app.savedState",
  ]
end
`;
}

/** Reads both signed DMGs of `version` from `dir` and renders the cask. Throws when one is missing. */
function caskFromDist({ version, dir }) {
  const sha = {};
  for (const [k, arch] of Object.entries(ARCHES)) {
    const file = path.join(dir, dmgName(version, arch));
    if (!fs.existsSync(file)) throw new Error(`${file} is missing (an unsigned build is named …-unsigned.dmg; the cask is for signed releases only).`);
    sha[k] = sha256(file);
  }
  return renderCask({ version, sha });
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!args.version) {
    console.error('usage: homebrew-cask.js --version <x.y.z> [--dir <dist>]');
    process.exit(2);
  }
  const dir = path.resolve(args.dir || path.join(__dirname, '..', 'dist'));
  process.stdout.write(caskFromDist({ version: args.version, dir }));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { renderCask, caskFromDist, dmgName, ARCHES, REPO };
