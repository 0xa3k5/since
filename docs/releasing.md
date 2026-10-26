# Building and releasing

Maintainer notes for packaging Since and publishing releases. Contributors only need `pnpm dist`
(unsigned) to try a packaged build; see the [README](../README.md) for development setup.

## Building the DMG

`pnpm dist` builds `Since.app` and one DMG each for Apple silicon (`arm64`) and Intel (`x64`)
into `apps/desktop/dist/`. It needs macOS.

- **Updates:** the app reads its update feed from GitHub Releases (`updates` in `apps/desktop/package.json`).

- **Without a Developer ID certificate** (the default today) you get `Since-<version>-<arch>-unsigned.dmg`.
  The app is ad-hoc signed so it launches on Apple silicon. Gatekeeper still blocks it on other Macs
  until the user right-clicks → Open, or allows it in System Settings → Privacy & Security.
- **With a certificate**, signing switches on by itself. electron-builder looks for it in `CSC_LINK`
  (a base64 `.p12` or its path) plus `CSC_KEY_PASSWORD`, or for a "Developer ID Application" identity in the login keychain.
  The app is then built with hardened runtime and notarized with `notarytool`. Notarization needs either
  `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or an App Store Connect API key
  (`APPLE_API_KEY` = path to the `.p8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`).

Packaging config lives in `apps/desktop/electron-builder.config.js`, and icon/DMG art in `apps/desktop/build/`.
After editing `icon.svg` or `background.svg`, run `pnpm --filter @gitsince/desktop brand-assets` to regenerate
`icon.icns` and `background.tiff`.

## Releases

Push a tag matching the desktop version (e.g. `v1.0.0`). `.github/workflows/release.yml` then builds, signs,
notarizes and uploads both DMGs to a **draft** GitHub Release. Publishing the draft is a manual step.
The draft also carries `Since-<version>-<arch>-mac.zip` and `update-mac-<arch>.json` (written by
`apps/desktop/scripts/update-feed.js`), `Since-<arch>.dmg` copies of the DMGs (so
`releases/latest/download/Since-<arch>.dmg`, the website's download link, always serves the latest release), and
`since.rb`, the Homebrew cask for the tap (see below). Installed apps update from those once the release is published as the
latest release. They read the feed from `updates.feed` in `apps/desktop/package.json`, so that URL has to be
publicly downloadable. Only signed releases can install themselves; an unsigned app sees the update and
links to the download page instead.
It reads these repository secrets: `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Without them, the draft holds unsigned DMGs and is marked as unsigned.
Pull requests that touch packaging, and manual runs, do an unsigned dry run and attach the DMGs as a workflow artifact.

### Publishing checklist

1. Check the draft: both DMGs are the signed, notarized `Since-<version>-<arch>.dmg` (an unsigned run names them
   `…-unsigned.dmg` and says so in the notes); the zips, feeds, aliases and `since.rb` are attached.
2. Release notes: the website changelog entry (`apps/web/src/content/releases/<version>.md`) is the source; paste
   or summarize it into the draft.
3. Publish the draft as the **latest release**. From then on auto-update, `releases/latest/download/…` and the
   website's download buttons serve it.
4. Homebrew: copy `since.rb` into the tap repository as `Casks/since.rb`, commit and push (below).

## Homebrew

Since is installed with Homebrew from our own tap, `0xa3k5/homebrew-tap`:

```sh
brew install --cask 0xa3k5/tap/since
```

The cask (`since.rb`, built by `apps/desktop/scripts/homebrew-cask.js` in the release workflow) points at the
versioned DMGs on the GitHub Release with their sha256, one per architecture, and `livecheck` follows the latest
release. Updating the tap after a release is one commit: replace `Casks/since.rb` with the new file. `brew audit --cask
since` and `brew install --cask 0xa3k5/tap/since` in a clean shell are the checks.

The main `homebrew/cask` repository (plain `brew install --cask since`) has a notability bar for new casks: the
repository must be at least 30 days old and, for a submission by its owner, have 225 stars, 90 forks or 90
watchers (75 stars, 30 forks or 30 watchers when someone else submits it). Submit `since.rb` there once the repo
qualifies; until then the tap is the install path, and the main-repo cask would replace it, not add to it.

## Moving beta installs to 1.0.0

Beta builds read their update feed from the `gitlanes-beta` Cloudflare R2 bucket and can't follow a feed on
GitHub, so 1.0.0 goes to the bucket once too. After the v1.0.0 release is published, download
`Since-1.0.0-arm64.dmg`, `Since-1.0.0-x64.dmg`, `Since-1.0.0-arm64-mac.zip` and `Since-1.0.0-x64-mac.zip` from it
into an empty folder (not its `update-mac-*.json` feeds, which point at GitHub), then run:

```sh
R2_ACCOUNT_ID=$(security find-generic-password -a "$USER" -s gitlanes-r2-account-id -w) \
R2_ACCESS_KEY_ID=$(security find-generic-password -a "$USER" -s gitlanes-r2-access-key-id -w) \
R2_SECRET_ACCESS_KEY=$(security find-generic-password -a "$USER" -s gitlanes-r2-secret-access-key -w) \
  node apps/desktop/scripts/bucket-publish.js --version 1.0.0 --dir <folder>
```

It writes feeds that point at the bucket and uploads `beta/1.0.0/`, then `beta/latest/Since-<arch>.dmg`, then the
`beta/update-mac-<arch>.json` feeds. The release must be signed and notarized: Squirrel only installs an update
signed by the same Developer ID as the running beta. A beta install that has updated to 1.0.0 reads GitHub
Releases from then on. The bucket and the script go once the beta installs have moved.
