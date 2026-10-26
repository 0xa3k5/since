# Since

[![CI](https://github.com/0xa3k5/gitlanes/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/0xa3k5/gitlanes/actions/workflows/ci.yml)

A fast, keyboard-first Git client for macOS, plus its website.

| Path | What |
|---|---|
| `apps/desktop` | The Electron app ([README](apps/desktop/README.md)) |
| `apps/web` | The website (Astro, static) |
| `packages/tokens` | Brand colour tokens for both themes, shared by the site (and mirrored in the desktop app) |

pnpm is required; npm, yarn and bun installs are blocked. Enable it with `corepack enable`.

    corepack enable      # once: provides the pnpm version pinned in package.json
    pnpm install
    pnpm desktop [-- path/to/repo]
    pnpm test
    pnpm dist         # build the macOS DMGs into apps/desktop/dist
    pnpm web          # website dev server
    pnpm web:build    # static build into apps/web/dist, plus an internal link check

## Building the DMG

`pnpm dist` builds `Since.app` and one DMG each for Apple silicon (`arm64`) and Intel (`x64`)
into `apps/desktop/dist/`. It needs macOS.

- **Update channel:** the build bakes in the `release` channel, which reads the GitHub Releases feed.
  `SINCE_CHANNEL=beta pnpm dist` bakes the beta channel, which reads the beta bucket instead.

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

### Releases

Push a tag matching the desktop version (e.g. `v0.1.0`). `.github/workflows/release.yml` then builds, signs,
notarizes and uploads both DMGs to a **draft** GitHub Release. Publishing the draft is a manual step.
The draft also carries `Since-<version>-<arch>-mac.zip` and `update-mac-<arch>.json` (written by
`apps/desktop/scripts/update-feed.js`). Installed apps update from those once the release is published as the
latest release. They read the feed from `updates.feed` in `apps/desktop/package.json`, so that URL has to be
publicly downloadable. Only signed releases can install themselves; an unsigned app sees the update and
links to the download page instead.
It reads these repository secrets: `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Without them, the draft holds unsigned DMGs and is marked as unsigned.
Pull requests that touch packaging, and manual runs, do an unsigned dry run and attach the DMGs as a workflow artifact.

### Releasing a beta from your Mac

Betas are built on the beta update channel (`SINCE_CHANNEL=beta`) and are published to the `gitlanes-beta` Cloudflare R2 bucket.
They are built locally, not by GitHub Actions: pushing a `v*-beta.*` tag does **not** start `release.yml`.

One-time setup, in the login keychain (nothing goes into env files or the repo):

```sh
# 1. The "Developer ID Application" certificate: import the .p12 in Keychain Access, then check it shows up
security find-identity -v -p codesigning
# 2. Notarization: a notarytool profile (asks for an app-specific password from appleid.apple.com)
xcrun notarytool store-credentials gitlanes-notary --apple-id <apple-id> --team-id YCL3UNGMGC
# 3. The R2 token (Object Read & Write on gitlanes-beta only); each command asks for the value
security add-generic-password -a "$USER" -s gitlanes-r2-account-id -w
security add-generic-password -a "$USER" -s gitlanes-r2-access-key-id -w
security add-generic-password -a "$USER" -s gitlanes-r2-secret-access-key -w
```

Then, on an up-to-date, clean `main`:

```sh
pnpm release:beta                 # next 0.1.0-beta.N after the existing tags
pnpm release:beta 0.1.0-beta.7    # a specific version
pnpm release:beta --skip-e2e      # skip the end-to-end suite (prints a warning)
```

`apps/desktop/scripts/release-beta.js` checks the setup above and that the `pnpm` on PATH is the one `packageManager`
pins (each missing piece fails with the command that fixes it), runs `pnpm test` and `pnpm test:e2e`, builds the version
through `SINCE_VERSION`, notarizes through the `gitlanes-notary` profile, and checks
every app and the app inside each DMG with `codesign`, `spctl` and `stapler`. Then
`apps/desktop/scripts/beta-publish.js` writes the update feeds and uploads to R2 with `curl --aws-sigv4`: `beta/<version>/`
first, then `beta/latest/Since-<arch>.dmg` (the website's download links), then the `beta/update-mac-<arch>.json`
feeds, and keeps the newest 5 versions. The `v<version>` tag is pushed only after the upload succeeds.
The R2 keys are read from the keychain at run time and handed to curl on stdin, never on the command line.
`release.yml` uses the same `beta-publish.js` when it's run manually on a beta tag
(`gh workflow run release.yml --ref v0.1.0-beta.N`, with the `R2_*` repository secrets).
