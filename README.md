# GitLanes

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

`pnpm dist` builds `GitLanes.app` and one DMG each for Apple silicon (`arm64`) and Intel (`x64`)
into `apps/desktop/dist/`. It needs macOS.

- **Licence store:** the build bakes in the `production` Polar store and fails until its values in
  `apps/desktop/licence/config.js` are filled in. For a test build use `GITLANES_STORE=sandbox pnpm dist`;
  the app then says "sandbox store" in its licence window. CI does this for everything except final release tags.

- **Without a Developer ID certificate** (the default today) you get `GitLanes-<version>-<arch>-unsigned.dmg`.
  The app is ad-hoc signed so it launches on Apple silicon. Gatekeeper still blocks it on other Macs
  until the user right-clicks → Open, or allows it in System Settings → Privacy & Security.
- **With a certificate**, signing switches on by itself. electron-builder looks for it in `CSC_LINK`
  (a base64 `.p12` or its path) plus `CSC_KEY_PASSWORD`, or for a "Developer ID Application" identity in the login keychain.
  The app is then built with hardened runtime and notarized with `notarytool`. Notarization needs either
  `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or an App Store Connect API key
  (`APPLE_API_KEY` = path to the `.p8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`).

Packaging config lives in `apps/desktop/electron-builder.config.js`, and icon/DMG art in `apps/desktop/build/`.
After editing `icon.svg` or `background.svg`, run `pnpm --filter @gitlanes/desktop brand-assets` to regenerate
`icon.icns` and `background.tiff`.

### Releases

Push a tag matching the desktop version (e.g. `v0.1.0`). `.github/workflows/release.yml` then builds, signs,
notarizes and uploads both DMGs to a **draft** GitHub Release. Publishing the draft is a manual step.
The draft also carries `GitLanes-<version>-<arch>-mac.zip` and `update-mac-<arch>.json` (written by
`apps/desktop/scripts/update-feed.js`). Installed apps update from those once the release is published as the
latest release. They read the feed from `updates.feed` in `apps/desktop/package.json`, so that URL has to be
publicly downloadable. Only signed releases can install themselves; an unsigned app sees the update and
links to the download page instead.
It reads these repository secrets: `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Without them, the draft holds unsigned DMGs and is marked as unsigned.
Pull requests that touch packaging, and manual runs, do an unsigned dry run and attach the DMGs as a workflow artifact.
